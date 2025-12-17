import { getStream, getVod } from 'twitch-m3u8';
import { TwitchStream, MediaSource } from '../types/index.js';
import got from 'got';
import config from "../config.js";
import logger from '../utils/logger.js';
import { Youtube } from '../utils/youtube.js';
import ytdl, { downloadToTempFile } from '../utils/yt-dlp.js';
import { GeneralUtils } from '../utils/shared.js';
import { YTResponse } from '../types/index.js';
import path from 'path';
import { resolvedFfmpegPath } from '../utils/ffmpeg.js';
import puppeteer from 'puppeteer';

export class MediaService {
	private youtube: Youtube;

	constructor() {
		this.youtube = new Youtube();
	}

	public async resolveMediaSource(url: string): Promise<MediaSource | null> {
		try {
			// Check for direct source types
			if (url.includes('youtube.com/') || url.includes('youtu.be/')) {
				return await this._resolveYouTubeSource(url);
			} else if (url.includes('twitch.tv/')) {
				return await this._resolveTwitchSource(url);
			} else if (url.includes('vidsrc.cc') || url.includes('vidlink.pro')) {
				// Attempt to resolve stream from embed
				return await this._resolveEmbedSource(url);
			} else if (GeneralUtils.isLocalFile(url)) {
				return this._resolveLocalSource(url);
			} else if (GeneralUtils.isValidUrl(url)) {
				return this._resolveDirectUrlSource(url);
			} else {
				return this.searchAndPlayYouTube(url);
			}

			return null;
		} catch (error) {
			logger.error("Failed to resolve media source:", error);
			return null;
		}
	}

	private async _resolveEmbedSource(url: string): Promise<MediaSource | null> {
		let browser = null;
		try {
			logger.info(`Launching Puppeteer to resolve stream from: ${url}`);

			browser = await puppeteer.launch({
				headless: true, // Use true or "shell"
				args: [
					'--no-sandbox',
					'--disable-setuid-sandbox',
					'--disable-dev-shm-usage',
					'--disable-accelerated-2d-canvas',
					'--no-first-run',
					'--no-zygote',
					'--disable-gpu'
				]
			});

			const page = await browser.newPage();
			// Set a realistic User-Agent
			await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

			// Promisify the stream finding logic
			const findStream = new Promise<string>((resolve, reject) => {
				// Listen for responses
				page.on('response', async response => {
					const responseUrl = response.url();
					const resourceType = response.request().resourceType();

					// Ignore obvious non-media and tracking pixels
					if (resourceType === 'image' || resourceType === 'stylesheet' || resourceType === 'font' || responseUrl.includes('ping.gif')) return;

					// Look for m3u8 playlists or mp4 files
					// We verify it's not a query param match by checking the pathname or ensuring it's not a benign file
					if (responseUrl.includes('.m3u8') || responseUrl.includes('.mp4')) {
						logger.info(`Puppeteer intercepted stream URL: ${responseUrl}`);
						resolve(responseUrl);
					}
				});

				// Safety timeout
				setTimeout(() => {
					reject(new Error("Timeout waiting for stream URL"));
				}, 15000); // 15s timeout
			});

			// Navigate to the page
			await page.goto(url, { waitUntil: 'domcontentloaded' });

			try {
				const streamUrl = await findStream;
				return {
					url: streamUrl,
					title: 'Extracted Stream',
					type: 'url',
					headers: {
						'Referer': url,
						'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
					}
				};
			} catch (err) {
				logger.warn(`Puppeteer failed to find stream: ${err}`);
			}

			return null;

		} catch (error) {
			logger.error(`Failed to resolve embed source for ${url}:`, error);
			return null;
		} finally {
			if (browser) {
				await browser.close().catch(e => logger.error("Failed to close browser:", e));
			}
		}
	}

	private async _resolveYouTubeSource(url: string): Promise<MediaSource | null> {
		const videoDetails = await this.youtube.getVideoInfo(url);
		if (!videoDetails) return null;

		const isLive = videoDetails.videoDetails?.isLiveContent || false;
		const streamUrl = isLive ? await this.youtube.getLiveStreamUrl(url) : url;

		if (streamUrl) {
			return {
				url: streamUrl,
				title: videoDetails.title,
				type: 'youtube',
				isLive: isLive,
			};
		}
		return null;
	}

	public async getTwitchStreamUrl(url: string): Promise<string | null> {
		try {
			// Handle VODs
			if (url.includes('/videos/')) {
				const vodId = url.split('/videos/').pop() as string;
				const vodInfo = await getVod(vodId);
				const vod = vodInfo.find((stream: TwitchStream) => stream.resolution === `${config.width}x${config.height}`) || vodInfo[0];
				if (vod?.url) {
					return vod.url;
				}
				logger.error("No VOD URL found");
				return null;
			} else {
				const urlObj = new URL(url);
				const pathname = urlObj.pathname;
				// Remove leading slash if present and split
				const parts = pathname.split('/').filter(p => p.length > 0);
				const twitchId = parts[0]; // The username is usually the first part after domain
				const streams = await getStream(twitchId);
				const stream = streams.find((stream: TwitchStream) => stream.resolution === `${config.width}x${config.height}`) || streams[0];
				if (stream?.url) {
					return stream.url;
				}
				logger.error("No Stream URL found");
				return null;
			}
		} catch (error) {
			logger.error("Failed to get Twitch stream URL:", error);
			return null;
		}
	}

	public async downloadYouTubeVideo(url: string): Promise<string | null> {
		try {
			const ytDlpDownloadOptions = {
				format: `bestvideo[height<=${config.height || 720}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${config.height || 720}]+bestaudio/best[height<=${config.height || 720}]/best`,
				noPlaylist: true,
				ffmpegLocation: resolvedFfmpegPath,
			};

			const tempFilePath = await downloadToTempFile(url, ytDlpDownloadOptions);
			return tempFilePath;
		} catch (error) {
			logger.error("Failed to download YouTube video:", error);
			return null;
		}

	}

	private async _resolveTwitchSource(url: string): Promise<MediaSource | null> {
		try {
			// Try twitch-m3u8 first (better for ads/commercials)
			/*
			const streamUrl = await this.getTwitchStreamUrl(url);
			if (streamUrl) {
				return {
					url: streamUrl,
					title: `twitch.tv/${url.split('/').pop()}`,
					type: 'twitch',
					isLive: true,
					headers: {
						'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
						'Referer': 'https://www.twitch.tv/'
					}
				};
			}
			*/

			// Fallback to yt-dlp
			logger.info("Resolving Twitch stream via yt-dlp...");
			const metadata = await ytdl(url, {
				dumpJson: true,
				skipDownload: true,
				noWarnings: true,
				quiet: true
			}) as YTResponse;

			if (metadata && metadata.url) {
				return {
					url: metadata.url,
					title: metadata.title || `twitch.tv/${url.split('/').pop()}`,
					type: 'twitch',
					isLive: true,
					headers: {
						...(metadata.http_headers as Record<string, string>),
						'Referer': 'https://www.twitch.tv/'
					}
				};
			}
			return null;
		} catch (error) {
			logger.error("Failed to resolve Twitch stream:", error);
			return null;
		}
	}

	private _resolveLocalSource(url: string): MediaSource {
		return {
			url,
			title: path.basename(url, path.extname(url)),
			type: 'local'
		};
	}

	private async _resolveDirectUrlSource(url: string): Promise<MediaSource> {
		// First try to get metadata using yt-dlp
		try {
			const metadata = await ytdl(url, {
				dumpJson: true,
				skipDownload: true,
				noWarnings: true,
				quiet: true
			}) as YTResponse;

			// If yt-dlp succeeds, use the extracted metadata
			if (metadata && metadata.title) {
				// Get the best available format URL
				let streamUrl = url;
				if (metadata.formats && Array.isArray(metadata.formats) && metadata.formats.length > 0) {
					// Find the format with both audio and video, preferring higher quality
					const bestFormat = metadata.formats
						.filter((format) => format.url && format.ext !== 'm3u8') // Avoid HLS streams
						.sort((a, b) => {
							// Prefer formats with both audio and video
							const aScore = (a.vcodec && a.vcodec !== 'none' ? 1 : 0) + (a.acodec && a.acodec !== 'none' ? 1 : 0) + (a.height || 0) / 1000;
							const bScore = (b.vcodec && b.vcodec !== 'none' ? 1 : 0) + (b.acodec && b.acodec !== 'none' ? 1 : 0) + (b.height || 0) / 1000;
							return bScore - aScore;
						})[0];

					if (bestFormat && bestFormat.url) {
						streamUrl = bestFormat.url;
					}
				}

				return {
					url: streamUrl,
					title: metadata.title,
					type: 'url'
				};
			}
		} catch (error) {
			// yt-dlp failed, log debug info and continue to fallback
			logger.debug("yt-dlp failed to extract metadata for URL:", url, error);
		}

		// Fallback to original URL parsing logic
		let title = "Direct URL";
		try {
			const urlObj = new URL(url);
			const pathname = urlObj.pathname;
			const filename = pathname.split('/').pop();

			if (filename && filename.includes('.')) {
				title = decodeURIComponent(filename.replace(/\.[^/.]+$/, ""));
			} else if (pathname !== '/' && pathname.length > 1) {
				const pathSegment = pathname.split('/').pop();
				if (pathSegment) {
					title = decodeURIComponent(pathSegment);
				}
			}
		} catch (e) {
			logger.debug("Could not parse URL for title extraction:", url);
		}

		return {
			url,
			title,
			type: 'url'
		};
	}

	public async searchYouTube(query: string, limit: number = 5): Promise<string[]> {
		try {
			return await this.youtube.search(query, limit);
		} catch (error) {
			logger.error("Failed to search YouTube:", error);
			return [];
		}
	}

	public async searchAndPlayYouTube(query: string): Promise<MediaSource | null> {
		try {
			const searchResult = await this.youtube.searchAndGetPageUrl(query);
			if (searchResult.pageUrl && searchResult.title) {
				return {
					url: searchResult.pageUrl,
					title: searchResult.title,
					type: 'youtube'
				};
			}
			return null;
		} catch (error) {
			logger.error("Failed to search and play YouTube:", error);
			return null;
		}
	}

	public async searchTMDB(query: string): Promise<{ id: number, title: string, release_date: string, overview: string } | null> {
		if (!config.tmdbApiKey) {
			logger.error("TMDB API key is not configured.");
			return null;
		}

		try {
			const searchUrl = `https://api.themoviedb.org/3/search/movie?api_key=${config.tmdbApiKey}&query=${encodeURIComponent(query)}`;
			const response = await got.get(searchUrl).json() as any;

			if (response.results && response.results.length > 0) {
				const movie = response.results[0];
				return {
					id: movie.id,
					title: movie.title,
					release_date: movie.release_date,
					overview: movie.overview
				};
			}
			return null;
		} catch (error) {
			logger.error("Failed to search TMDB:", error);
			return null;
		}
	}

	public getVidKingEmbedUrl(tmdbId: number): string {
		return `https://www.vidking.net/embed/movie/${tmdbId}`;
	}

	public getCinemaOSEmbedUrl(tmdbId: number): string {
		return `https://cinemaos.tech/player/${tmdbId}`;
	}

	public getVidSrcMovieEmbedUrl(tmdbId: number): string {
		return `https://vidsrc.cc/v2/embed/movie/${tmdbId}`;
	}

	public getVidSrcTvEmbedUrl(tmdbId: number, season: number, episode: number): string {
		return `https://vidsrc.cc/v2/embed/tv/${tmdbId}/${season}/${episode}`;
	}

	public async searchTMDBTV(query: string): Promise<{ id: number, name: string, first_air_date: string, overview: string } | null> {
		if (!config.tmdbApiKey) {
			logger.error("TMDB API key is not configured.");
			return null;
		}

		try {
			const searchUrl = `https://api.themoviedb.org/3/search/tv?api_key=${config.tmdbApiKey}&query=${encodeURIComponent(query)}`;
			const response = await got.get(searchUrl).json() as any;

			if (response.results && response.results.length > 0) {
				const show = response.results[0];
				return {
					id: show.id,
					name: show.name,
					first_air_date: show.first_air_date,
					overview: show.overview
				};
			}
			return null;
		} catch (error) {
			logger.error("Failed to search TMDB for TV:", error);
			return null;
		}
	}

	public getCinemaOSTVEmbedUrl(tmdbId: number, season: number, episode: number): string {
		return `https://cinemaos.tech/player/${tmdbId}/${season}/${episode}`;
	}

	public getVidLinkMovieEmbedUrl(tmdbId: number, options?: { autoplay?: boolean, primaryColor?: string }): string {
		let url = `https://vidlink.pro/movie/${tmdbId}`;
		const params: string[] = [];
		if (options?.autoplay) params.push('autoplay=true');
		if (options?.primaryColor) params.push(`primaryColor=${options.primaryColor}`);

		if (params.length > 0) {
			url += `?${params.join('&')}`;
		}
		return url;
	}

	public getVidLinkTvEmbedUrl(tmdbId: number, season: number, episode: number, options?: { autoplay?: boolean, primaryColor?: string }): string {
		let url = `https://vidlink.pro/tv/${tmdbId}/${season}/${episode}`;
		const params: string[] = [];
		if (options?.autoplay) params.push('autoplay=true');
		if (options?.primaryColor) params.push(`primaryColor=${options.primaryColor}`);

		if (params.length > 0) {
			url += `?${params.join('&')}`;
		}
		return url;
	}
}