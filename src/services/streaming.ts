import { Client, Message } from "discord.js-selfbot-v13";
import { Streamer, Utils, prepareStream, playStream } from "@dank074/discord-video-stream";
import fs from 'fs';
import config from "../config.js";
import { MediaService } from './media.js';
import { QueueService } from './queue.js';
import { getVideoParams } from "../utils/ffmpeg.js";
import logger from '../utils/logger.js';
import ytdl, { downloadToTempFile, createStream } from '../utils/yt-dlp.js';
import { ChildProcess } from 'node:child_process';
import { DiscordUtils, ErrorUtils } from '../utils/shared.js';
import { QueueItem, StreamStatus } from '../types/index.js';

export class StreamingService {
	private streamer: Streamer;
	private mediaService: MediaService;
	private queueService: QueueService;
	private controller: AbortController | null = null;
	private streamStatus: StreamStatus;
	private failedVideos: Set<string> = new Set();

	private isSkipping: boolean = false;
	private leaveTimeout: NodeJS.Timeout | null = null;
	private ytDlpProcess: ChildProcess | null = null;

	private startTime: number = 0;
	private stateSaveInterval: NodeJS.Timeout | null = null;
	private readonly STATE_FILE = './playback_state.json';

	constructor(client: Client, streamStatus: StreamStatus) {
		this.streamer = new Streamer(client);
		this.mediaService = new MediaService();
		this.queueService = new QueueService();
		this.streamStatus = streamStatus;

		// Move auto-resume to a separate init method or just call it here if async isn't an issue
		// But constructors can't be async. We'll add a public init method.
		this.startStateSaver();
	}

	private startStateSaver() {
		this.stateSaveInterval = setInterval(() => {
			if (this.streamStatus.playing) {
				this.saveState();
			}
		}, 10000); // Save every 10 seconds
	}

	public saveState() {
		const currentItem = this.queueService.getCurrent();
		if (!currentItem) return;

		const state = {
			currentQueueIndex: this.queueService.getQueueStatus().currentIndex,
			queue: this.queueService.getQueueStatus().items, // Use items directly or the queue object? PlaybackState expects queue: QueueItem[]
			lastActive: Date.now(),
			voiceChannelId: config.videoChannelId,
			textChannelId: config.cmdChannelId, // Assuming commands come from here
			isPlaying: this.streamStatus.playing,
			videoSource: currentItem.originalInput || currentItem.url,
			timestamp: Math.floor((Date.now() - this.startTime) / 1000)
		};

		try {
			fs.writeFileSync(this.STATE_FILE, JSON.stringify(state, null, 2));
		} catch (error) {
			logger.error("Failed to save playback state:", error);
		}
	}


	public async resumeState(client: Client): Promise<void> {
		if (!fs.existsSync(this.STATE_FILE)) return;

		try {
			const stateRaw = fs.readFileSync(this.STATE_FILE, 'utf-8');
			const state = JSON.parse(stateRaw);

			// Check if state is stale (e.g., > 1 hour old)
			if (Date.now() - state.lastActive > 3600000) {
				logger.info("Playback state is too old, discarding.");
				fs.unlinkSync(this.STATE_FILE);
				return;
			}

			const channel = await client.channels.fetch(state.textChannelId) as any;
			if (!channel || !channel.send) {
				logger.error("Could not fetch text channel for resume.");
				return;
			}

			// Create a mock message for compatibility or refactor PlayVideo to take channel
			// Creating a mock message is easier for now to maintain compatibility with existing methods that expect Message
			const mockMessage = {
				author: client.user,
				channel: channel,
				member: {
					voice: {
						channel: { id: state.voiceChannelId }
					}
				},
				reply: (content: any) => channel.send(content)
			} as any;

			logger.info("Resuming playback from saved state...");
			const current = state.queue[state.currentQueueIndex];

			if (current) {
				// Restore queue first
				// Ideally we'd set the whole queue, but for now let's just push the current item
				await this.addToQueue(mockMessage, current.originalInput || current.url);

				// Play with seek
				await this.playVideo(mockMessage, current.originalInput || current.url, current.title, undefined, undefined, undefined, state.timestamp);
			}

		} catch (error) {
			logger.error("Failed to resume playback state:", error);
		}
	}

	public getStreamer(): Streamer {
		return this.streamer;
	}

	public getQueueService(): QueueService {
		return this.queueService;
	}

	private markVideoAsFailed(videoSource: string): void {
		this.failedVideos.add(videoSource);
		logger.info(`Marked video as failed: ${videoSource}`);
	}

	public async addToQueue(
		message: Message,
		videoSource: string,
		title?: string
	): Promise<boolean> {
		try {
			const username = message.author.username;
			const mediaSource = await this.mediaService.resolveMediaSource(videoSource);

			if (mediaSource) {
				const queueItem = await this.queueService.addToQueue(mediaSource, username, videoSource);
				await DiscordUtils.sendSuccess(message, `Added to queue: \`${queueItem.title}\``);

				// Start background download for YouTube videos
				if (queueItem.type === 'youtube' && !queueItem.isLive) {
					this.startBackgroundDownload(queueItem);
				}

				return true;
			} else {
				// Fallback for unresolved sources
				const queueItem = await this.queueService.add(
					videoSource,
					title || videoSource,
					username,
					'url',
					false,
					videoSource
				);
				await DiscordUtils.sendSuccess(message, `Added to queue: \`${queueItem.title}\``);
				return true;
			}
		} catch (error) {
			await ErrorUtils.handleError(error, `adding to queue: ${videoSource}`, message);
			return false;
		}
	}

	private startBackgroundDownload(queueItem: QueueItem): void {
		logger.info(`Starting background download for: ${queueItem.title}`);
		queueItem.downloadPromise = this.mediaService.downloadYouTubeVideo(queueItem.url)
			.then(path => {
				logger.info(`Background download completed for: ${queueItem.title}`);
				queueItem.downloadPath = path;
				return path;
			})
			.catch(err => {
				logger.error(`Background download failed for: ${queueItem.title}`, err);
				throw err;
			});
	}


	public async playFromQueue(message: Message): Promise<void> {
		if (this.streamStatus.playing) {
			await DiscordUtils.sendError(message, 'Already playing a video. Use skip command to skip current video.');
			return;
		}

		const nextItem = this.queueService.getNext();
		if (!nextItem) {
			await DiscordUtils.sendError(message, 'Queue is empty.');
			return;
		}

		this.queueService.setPlaying(true);
		await this.playVideoFromQueueItem(message, nextItem);
	}

	public async skipCurrent(message: Message): Promise<void> {
		if (!this.streamStatus.playing) {
			await DiscordUtils.sendError(message, 'No video is currently playing.');
			return;
		}

		// Check if this is the last item in the queue
		const queueLength = this.queueService.getLength();
		const isLastItem = queueLength <= 1;

		// Prevent concurrent skip operations only if there are more items in queue
		if (this.isSkipping && !isLastItem) {
			await DiscordUtils.sendError(message, 'Skip already in progress.');
			return;
		}

		this.isSkipping = true;

		try {
			// Stop the current stream immediately
			this.streamStatus.manualStop = true;
			this.controller?.abort();
			this.streamer.stopStream();

			const currentItem = this.queueService.getCurrent(); // Get item being skipped
			const nextItem = this.queueService.skip(); // Advance the queue

			if (!nextItem) {
				// No more items in queue - stop playback and leave voice channel
				await DiscordUtils.sendInfo(message, 'Queue', 'No more videos in queue.');
				this.queueService.setPlaying(false);
				await this.cleanupStreamStatus();
				return;
			}

			const currentTitle = currentItem ? currentItem.title : 'current video';
			await DiscordUtils.sendInfo(message, 'Skipping', `Skipping \`${currentTitle}\`. Playing next: \`${nextItem.title}\``);

			// Reset manual stop flag since we're starting a new video
			this.streamStatus.manualStop = false;

			// Skip cleanup since we're playing the next item immediately
			await this.playVideoFromQueueItem(message, nextItem);
		} finally {
			this.isSkipping = false;
		}
	}

	private async playVideoFromQueueItem(message: Message, queueItem: QueueItem): Promise<void> {
		// Ensure queue is marked as playing
		this.queueService.setPlaying(true);

		// Collect video parameters if respect_video_params is enabled
		let videoParams = undefined;
		if (config.respect_video_params) {
			videoParams = await this.getVideoParameters(queueItem.url);
		}

		// Log playing video
		logger.info(`Playing from queue: ${queueItem.title} (${queueItem.url})`);

		// Use streaming service to play the video with video parameters
		// Use originalInput if available to ensure we get a fresh URL (important for Twitch/Live streams)
		// BUT for expensive embeds (Puppeteer), use the cached resolved URL to avoid re-launching browser
		let sourceToPlay = queueItem.originalInput || queueItem.url;
		if (queueItem.originalInput && (queueItem.originalInput.includes('vidsrc.cc') || queueItem.originalInput.includes('vidlink.pro'))) {
			logger.info("Using cached resolved URL for embed source to avoid re-extraction.");
			sourceToPlay = queueItem.url;
		}

		await this.playVideo(message, sourceToPlay, queueItem.title, videoParams, queueItem.headers, queueItem);
	}

	private async getVideoParameters(videoUrl: string): Promise<{ width: number, height: number, fps?: number, bitrate?: string } | undefined> {
		try {
			const resolution = await getVideoParams(videoUrl);
			logger.info(`Video parameters: ${resolution.width}x${resolution.height}, FPS: ${resolution.fps || 'unknown'}`);
			return {
				width: resolution.width,
				height: resolution.height,
				fps: resolution.fps
			};
		} catch (error) {
			await ErrorUtils.handleError(error, 'determining video parameters');
			return undefined;
		}
	}

	private async ensureVoiceConnection(message: Message, guildId: string, channelId: string): Promise<void> {
		// Cancel any pending leave timeout since we are starting a new video
		if (this.leaveTimeout) {
			clearTimeout(this.leaveTimeout);
			this.leaveTimeout = null;
			logger.info("New video requested, cancelled auto-disconnect timer.");
		}

		// Only join voice if not already connected
		if (!this.streamStatus.joined || !this.streamer.voiceConnection) {
			await this.streamer.joinVoice(guildId, channelId);
			this.streamStatus.joined = true;
		}
		this.streamStatus.playing = true;
		this.streamStatus.channelInfo = { guildId, channelId, cmdChannelId: config.cmdChannelId! };

		// Title status update handled in playVideo to avoid redundancy

		// Wait for voice connection to be fully ready
		await new Promise(resolve => setTimeout(resolve, 2000));

		// Verify voice connection exists
		if (!this.streamer.voiceConnection) {
			throw new Error('Voice connection is not established');
		}
	}

	private setupStreamConfiguration(videoParams?: { width: number, height: number, fps?: number, bitrate?: string }): any {
		return {
			width: videoParams?.width || config.width,
			height: videoParams?.height || config.height,
			frameRate: videoParams?.fps || config.fps,
			bitrateVideo: Math.min(config.bitrateKbps, 1000), // Force 1000k max
			bitrateVideoMax: Math.min(config.maxBitrateKbps, 1000), // Force 1000k max
			bitrateAudio: 64, // Reduce audio bitrate for stability
			videoCodec: Utils.normalizeVideoCodec(config.videoCodec),
			hardwareAcceleratedDecoding: true,
			minimizeLatency: true,
			h26xPreset: 'superfast'
		};
	}

	private async executeStream(inputForFfmpeg: any, streamOpts: any, message: Message, title: string, videoSource: string, headers?: Record<string, string>): Promise<void> {
		// Merge headers into stream options so prepareStream handles them correctly
		streamOpts.customHeaders = streamOpts.customHeaders || {};

		if (headers) {
			logger.info(`Merging custom headers: ${JSON.stringify(headers)}`);
			streamOpts.customHeaders = { ...streamOpts.customHeaders, ...headers };
		}

		// Force correct User-Agent if not present or if it's the default one (we want to override the library default)
		// Only override if we didn't receive specific headers with a User-Agent
		const hasCustomUserAgent = headers && headers['User-Agent'];
		if (!hasCustomUserAgent && (!streamOpts.customHeaders['User-Agent'] || streamOpts.customHeaders['User-Agent'].includes('Chrome/107'))) {
			logger.info("Forcing Chrome 120 User-Agent");
			streamOpts.customHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
		}

		// Enable debug logging for ffmpeg
		streamOpts.customFfmpegFlags = ['-loglevel', 'debug'];

		const { command, output: ffmpegOutput } = prepareStream(inputForFfmpeg, streamOpts, this.controller!.signal);

		// Add input options for stability and to mimic a browser
		try {
			const inputOptions = [
				'-analyzeduration', '0',
				'-probesize', '32',
				'-fflags +igndts',
				'-threads', '4',
			];

			if (streamOpts.seekTime) {
				inputOptions.unshift('-ss', streamOpts.seekTime.toString());
			}

			if (typeof inputForFfmpeg === 'string') {
				// Only add reconnect options for non-HLS network streams to avoid conflicts
				if (inputForFfmpeg.startsWith('http') && !inputForFfmpeg.includes('.m3u8')) {
					inputOptions.push(
						'-reconnect', '1',
						'-reconnect_streamed', '1',
						'-reconnect_delay_max', '5'
					);
				}

				// Always parse protocol whitelist
				inputOptions.push('-protocol_whitelist', 'file,http,https,tcp,tls,crypto');

				if (inputForFfmpeg.includes('.m3u8')) {
					inputOptions.push('-f', 'hls');
				}
			}

			command.inputOptions(inputOptions);

			// Headers are now handled by prepareStream via customHeaders
		} catch (e) {
			logger.warn("Could not add input options to ffmpeg command:", e);
		}

		command.on('start', (commandLine) => {
			logger.info('Spawned Ffmpeg with command: ' + commandLine);
		});



		let ffmpegError: Error | null = null;

		command.on("error", (err, stdout, stderr) => {
			// Don't log error if it's due to manual stop
			if (!this.streamStatus.manualStop && this.controller && !this.controller.signal.aborted) {
				logger.error("An error happened with ffmpeg:");
				logger.error(`Error Message: ${err.message}`);
				if (err.stack) logger.error(`Stack: ${err.stack}`);
				if (stdout) logger.error(`ffmpeg stdout:\n${stdout}`);
				if (stderr) logger.error(`ffmpeg stderr:\n${stderr}`);

				logger.info("Stream Options:", JSON.stringify(streamOpts, null, 2));
				logger.info("Input:", inputForFfmpeg);

				ffmpegError = err;
				this.controller.abort();
			}
		});

		await playStream(ffmpegOutput, this.streamer, undefined, this.controller!.signal)
			.catch((err) => {
				if (this.controller && !this.controller.signal.aborted) {
					logger.error('playStream error:', err);
					// Re-throw so playVideo can handle it
					throw err;
				}
				if (this.controller && !this.controller.signal.aborted) this.controller.abort();
			});

		// If we had an ffmpeg error, throw it now so playVideo handles it
		if (ffmpegError) {
			throw ffmpegError;
		}

		// Only log as finished if we didn't have an error and weren't manually stopped
		if (this.controller && !this.controller.signal.aborted && !this.streamStatus.manualStop) {
			logger.info(`Finished playing: ${title || videoSource}`);
		} else if (this.streamStatus.manualStop) {
			logger.info(`Stopped playing: ${title || videoSource}`);
		} else {
			logger.info(`Failed playing: ${title || videoSource}`);
		}
	}

	private async handleQueueAdvancement(message: Message): Promise<void> {
		await DiscordUtils.sendFinishMessage(message);

		// The video finished playing, so remove it from the queue
		const finishedItem = this.queueService.getCurrent();
		if (finishedItem) {
			this.queueService.removeFromQueue(finishedItem.id);
		}

		// Get the next item in the queue.
		const nextItem = this.queueService.getNext();

		if (nextItem) {
			logger.info(`Auto-playing next item from queue: ${nextItem.title}`);
			setTimeout(() => {
				this.playVideoFromQueueItem(message, nextItem).catch(err =>
					ErrorUtils.handleError(err, 'auto-playing next item')
				);
			}, 1000);
		} else {
			// No more items in the queue, so stop playback and clean up
			this.queueService.setPlaying(false);
			logger.info('No more items in queue, playback stopped');
			await this.cleanupStreamStatus();
		}
	}

	private async handleDownload(message: Message, videoSource: string, title?: string): Promise<string | null> {
		const downloadMessage = await message.reply(`📥 Downloading \`${title || 'YouTube video'}\`...`).catch(e => {
			logger.warn("Failed to send 'Downloading...' message:", e);
			return null;
		});

		try {
			logger.info(`Downloading ${title || videoSource}...`);
			const tempFilePath = await this.mediaService.downloadYouTubeVideo(videoSource);

			if (tempFilePath) {
				logger.info(`Finished downloading ${title || videoSource}`);
				if (downloadMessage) {
					await downloadMessage.delete().catch(e => logger.warn("Failed to delete 'Downloading...' message:", e));
				}
				return tempFilePath;
			}
			throw new Error('Download failed, no temp file path returned.');
		} catch (error) {
			logger.error(`Failed to download YouTube video: ${videoSource}`, error);
			const errorMessage = `❌ Failed to download \`${title || 'YouTube video'}\`.`;
			if (downloadMessage) {
				await downloadMessage.edit(errorMessage).catch(e => logger.warn("Failed to edit 'Downloading...' message:", e));
			} else {
				await DiscordUtils.sendError(message, `Failed to download video: ${error instanceof Error ? error.message : String(error)}`);
			}
			return null;
		}
	}

	private async prepareVideoSource(message: Message, videoSource: string, title?: string, headers?: Record<string, string>, queueItem?: QueueItem): Promise<{ inputForFfmpeg: any, tempFilePath: string | null, headers?: Record<string, string> }> {
		// Check for pre-downloaded content first!
		if (queueItem) {
			if (queueItem.downloadPath && fs.existsSync(queueItem.downloadPath)) {
				logger.info(`Using pre-downloaded file for: ${title}`);
				return { inputForFfmpeg: queueItem.downloadPath, tempFilePath: queueItem.downloadPath, headers: undefined };
			}

			if (queueItem.downloadPromise) {
				logger.info(`Waiting for background download to complete for: ${title}`);
				try {
					const path = await queueItem.downloadPromise;
					if (path && fs.existsSync(path)) {
						logger.info(`Background download finished just in time for: ${title}`);
						return { inputForFfmpeg: path, tempFilePath: path, headers: undefined };
					}
				} catch (e) {
					logger.warn(`Background download failed, falling back to synchronous download: ${e}`);
				}
			}
		}

		const mediaSource = await this.mediaService.resolveMediaSource(videoSource);

		if (mediaSource && mediaSource.type === 'youtube' && !mediaSource.isLive) {
			const tempFilePath = await this.handleDownload(message, videoSource, title);
			if (tempFilePath) {
				return { inputForFfmpeg: tempFilePath, tempFilePath };
			}
			// Download failed, throw to stop playback
			throw new Error('Failed to prepare video source due to download failure.');
		}

		// Use yt-dlp piping for Twitch streams
		if (mediaSource && mediaSource.type === 'twitch') {
			logger.info(`Using yt-dlp piping for Twitch stream: ${mediaSource.url}`);
			this.ytDlpProcess = createStream(mediaSource.url);

			if (this.ytDlpProcess.stdout) {
				if (this.ytDlpProcess.stderr) {
					this.ytDlpProcess.stderr.on('data', (data) => {
						logger.warn(`yt-dlp stderr: ${data.toString()}`);
					});
				}
				return { inputForFfmpeg: this.ytDlpProcess.stdout, tempFilePath: null, headers: undefined };
			} else {
				logger.error("Failed to get stdout from yt-dlp process");
				throw new Error("Failed to create stream from yt-dlp");
			}
		}

		// If mediaSource has headers, use them. Otherwise use the passed headers.
		const finalHeaders = mediaSource?.headers || headers;

		return { inputForFfmpeg: mediaSource ? mediaSource.url : videoSource, tempFilePath: null, headers: finalHeaders };
	}

	private async executeStreamWorkflow(input: any, options: any, message: Message, title: string, source: string, headers?: Record<string, string>): Promise<void> {
		this.controller = new AbortController();
		await this.executeStream(input, options, message, title, source, headers);
	}

	private async finalizeStream(message: Message, tempFile: string | null): Promise<void> {
		if (!this.streamStatus.manualStop && this.controller && !this.controller.signal.aborted) {
			await this.handleQueueAdvancement(message);
		} else {
			this.queueService.setPlaying(false);
			this.queueService.resetCurrentIndex();
			await this.cleanupStreamStatus();
		}

		if (tempFile) {
			try {
				fs.unlinkSync(tempFile);
			} catch (cleanupError) {
				logger.error(`Failed to delete temp file ${tempFile}:`, cleanupError);
			}
		}
	}

	public async playVideo(message: Message, videoSource: string, title?: string, videoParams?: { width: number, height: number, fps?: number, bitrate?: string }, headers?: Record<string, string>, queueItem?: QueueItem, seekTime?: number): Promise<void> {
		const [guildId, channelId] = [config.guildId, config.videoChannelId];
		this.streamStatus.manualStop = false;

		if (title) {
			const currentQueueItem = this.queueService.getCurrent();
			if (currentQueueItem?.title === title) {
				this.queueService.setPlaying(true);
			}
		}

		try {
			// Clear any existing leave timeout
			if (this.leaveTimeout) {
				clearTimeout(this.leaveTimeout);
				this.leaveTimeout = null;
				logger.info('Cancelled auto-disconnect timer.');
			}

			// Join voice channel
			await this.ensureVoiceConnection(message, guildId, channelId);

			// Prepare video source
			const { inputForFfmpeg, tempFilePath, headers: resolvedHeaders } = await this.prepareVideoSource(message, videoSource, title, headers, queueItem);

			// Setup stream options
			const streamOpts = this.setupStreamConfiguration(videoParams);
			streamOpts.customHeaders = resolvedHeaders;

			const statusTitle = title || 'Video';
			this.streamStatus.playing = true;
			this.startTime = Date.now();

			// Adjust start time if seeking
			if (seekTime) {
				logger.info(`Resuming playback from ${seekTime} seconds`);
				this.startTime = Date.now() - (seekTime * 1000);
				// Add seek option to inputs
				// Note: For streaming, -ss before -i is faster.
				// We need to modify executeStream to handle this or just pass it in inputForFfmpeg if it's an array?
				// But prepareStream expects a string or readable stream.
				// We can try adding it to inputOptions via a hack in executeStream
				streamOpts.seekTime = seekTime;
			}

			// Update activity
			if (this.streamer.client.user) {
				logger.info(`Setting activity to: Watching ${statusTitle}`);
				this.streamer.client.user.setActivity(DiscordUtils.status_watch(statusTitle));
			}

			// Start stream
			logger.info(`Starting stream for: ${title || videoSource}`);
			await this.executeStreamWorkflow(inputForFfmpeg, streamOpts, message, statusTitle, videoSource, resolvedHeaders);

			await this.finalizeStream(message, tempFilePath);

		} catch (error) {
			await ErrorUtils.handleError(error, `playing video: ${videoSource}`, message);
			this.markVideoAsFailed(videoSource);

			// Handle next item if present
			if (!this.streamStatus.manualStop) { // Only advance if not manually stopped
				await this.handleQueueAdvancement(message);
			}
		}
	}

	public async cleanupStreamStatus(): Promise<void> {
		try {
			this.controller?.abort();
			this.streamer.stopStream();

			// Kill yt-dlp process if it exists
			if (this.ytDlpProcess) {
				this.ytDlpProcess.kill();
				this.ytDlpProcess = null;
			}

			this.streamer.client.user?.setActivity(DiscordUtils.status_idle());

			// Reset all status flags
			this.streamStatus.playing = false;
			this.streamStatus.manualStop = false;

			// Only leave voice if we're not playing another video (and checks if we should wait)
			const hasQueueItems = !this.queueService.isEmpty();
			if (!hasQueueItems) {
				if (this.leaveTimeout) clearTimeout(this.leaveTimeout);
				logger.info("Queue empty, waiting 10 minutes before leaving voice channel...");

				this.leaveTimeout = setTimeout(() => {
					logger.info("10 minutes passed, leaving voice channel.");
					this.streamer.leaveVoice();
					this.streamStatus.joined = false;
					this.streamStatus.joinsucc = false;
					this.streamStatus.channelInfo = {
						guildId: "",
						channelId: "",
						cmdChannelId: "",
					};
					this.leaveTimeout = null;
				}, 10 * 60 * 1000); // 10 minutes
			}
		} catch (error) {
			await ErrorUtils.handleError(error, "cleanup stream status");
		}
	}

	public async stopAndClearQueue(): Promise<void> {
		// Clear the queue
		this.queueService.clearQueue();
		logger.info("Queue cleared by stop command");

		// Then cleanup the stream
		await this.cleanupStreamStatus();
	}

}