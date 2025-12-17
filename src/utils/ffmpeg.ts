import config from "../config.js";
import ffmpeg from "fluent-ffmpeg";
import logger from "./logger.js";
import path from "path";
import ffmpegStatic from "ffmpeg-static";
import fs from 'fs';

// Configure FFmpeg path
export let resolvedFfmpegPath = "";
if (config.ffmpegPath) {
	ffmpeg.setFfmpegPath(config.ffmpegPath);
	resolvedFfmpegPath = config.ffmpegPath;
	logger.info(`Using configured FFmpeg path: ${config.ffmpegPath}`);
} else if (ffmpegStatic) {
	const staticPath = ffmpegStatic as unknown as string;

	// Verify if the binary actually exists
	if (fs.existsSync(staticPath)) {
		ffmpeg.setFfmpegPath(staticPath);
		resolvedFfmpegPath = staticPath;
		logger.info(`Using ffmpeg-static: ${staticPath}`);
	} else {
		logger.error(`CRITICAL: ffmpeg-static binary not found at ${staticPath}`);
		logger.warn("Falling back to system PATH for ffmpeg.");
	}
} else {
	logger.warn("No FFmpeg path configured and ffmpeg-static not found. Relying on system PATH.");
}

// Verify FFmpeg binary
ffmpeg.getAvailableFormats((err, formats) => {
	if (err) {
		logger.error(`Failed to verify FFmpeg binary:`, err);
	} else {
		logger.info(`FFmpeg binary verified successfully.`);
	}
});

/**
 * A simple locking mechanism to prevent concurrent ffmpeg screenshot operations on the same video file.
 */
const ffmpegRunning: Record<string, boolean> = {};

/**
 * Generates multiple screenshots from a video file at specified percentage-based timestamps.
 * This function is concurrency-safe for the same video path.
 *
 * @param videoPath The full path to the video file.
 * @returns A promise that resolves to an array of file paths for the generated screenshots.
 */
export async function ffmpegScreenshot(videoPath: string): Promise<string[]> {
	// If another screenshot process is already running for this exact video, wait for it to complete.
	// This is a simple polling mechanism to prevent multiple ffmpeg instances from reading the same file for screenshots.
	while (ffmpegRunning[videoPath]) {
		await new Promise(resolve => setTimeout(resolve, 200));
	}

	ffmpegRunning[videoPath] = true;

	try {
		const videoName = path.parse(videoPath).name;
		const timestamps = ['10%', '30%', '50%', '70%', '90%'];
		const images: string[] = [];

		// Sequentially take a screenshot for each timestamp.
		for (const [index, timestamp] of timestamps.entries()) {
			const filename = `${videoName}-${index + 1}.jpg`;
			logger.info(`Taking screenshot ${index + 1}/${timestamps.length} of ${videoName} at ${timestamp}`);

			await new Promise<void>((resolve, reject) => {
				ffmpeg(videoPath)
					.on("end", () => {
						images.push(path.join(config.previewCacheDir, filename));
						resolve();
					})
					.on("error", (err: Error) => {
						logger.error(`Error taking screenshot for ${videoName}:`, err);
						reject(err);
					})
					.screenshots({
						count: 1,
						filename: filename,
						timestamps: [timestamp],
						folder: config.previewCacheDir,
						size: "640x480"
					});
			});
		}
		return images;
	} finally {
		// Ensure the lock is always released, even if errors occur.
		ffmpegRunning[videoPath] = false;
	}
}

/**
 * Interface for storing parsed video metadata.
 */
interface VideoParams {
	width: number;
	height: number;
	bitrate: string;
	maxbitrate: string;
	fps: number;
}

/**
 * Probes a video file to extract its technical parameters like resolution, bitrate, and FPS.
 *
 * @param videoPath The full path to the video file.
 * @returns A promise that resolves to an object containing the video's parameters.
 */
export async function getVideoParams(videoPath: string): Promise<VideoParams> {
	return new Promise<VideoParams>((resolve, reject) => {
		ffmpeg.ffprobe(videoPath, (err, metadata) => {
			if (err) {
				logger.error(`ffprobe error for ${videoPath}:`, err);
				return reject(err);
			}

			const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');

			if (videoStream && videoStream.width && videoStream.height) {
				const rFrameRate = videoStream.r_frame_rate || videoStream.avg_frame_rate;
				let fps = 0;

				if (rFrameRate) {
					const [numerator, denominator] = rFrameRate.split('/').map(Number);
					fps = (denominator && denominator !== 0) ? numerator / denominator : 0;
				}

				resolve({
					width: videoStream.width,
					height: videoStream.height,
					bitrate: videoStream.bit_rate || "N/A",
					// FIX: The correct property name is 'max_bit_rate', not 'maxBitrate'.
					maxbitrate: videoStream.max_bit_rate || "N/A",
					fps
				});
			} else {
				reject(new Error(`Unable to get video parameters for ${videoPath}`));
			}
		});
	});
}
