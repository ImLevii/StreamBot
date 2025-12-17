import ytdl_dlp from './yt-dlp.js';
import logger from './logger.js';
import yts from 'play-dl';
import { YouTubeVideo, YTResponse } from '../types/index.js';
import { existsSync } from 'fs';
import { join } from 'path';

export class Youtube {
	private getCookiesPath(): string | null {
		// Look for cookies.txt in the project root (one level up from src/)
		const cookiesPath = join(process.cwd(), 'cookies.txt');
		return existsSync(cookiesPath) ? cookiesPath : null;
	}

	private getYtdlpOptions(baseOptions: Record<string, any> = {}): Record<string, any> {
		const cookiesPath = this.getCookiesPath();
		if (cookiesPath) {
			return { ...baseOptions, cookies: cookiesPath };
		}
		return baseOptions;
	}

	async getVideoInfo(url: string): Promise<YouTubeVideo | null> {
		try {
			const options = this.getYtdlpOptions({ dumpSingleJson: true, noPlaylist: true });
			const videoData = await ytdl_dlp(url, options) as YTResponse;

			if (this.isValidVideoData(videoData)) {
				return {
					id: videoData.id,
					title: videoData.title,
					formats: [],
					videoDetails: {
						isLiveContent: videoData.is_live === true || (videoData as any).live_status === 'is_live'
					}
				};
			}
			logger.warn(`Failed to parse video info from yt-dlp for URL: ${url}. Data: ${JSON.stringify(videoData)}`);
			return null;
		} catch (error) {
			logger.error(`Failed to get video info using yt-dlp for URL ${url}:`, error);
			return null;
		}
	}

	private isValidVideoData(data: any): data is { id: string; title: string; is_live?: boolean; live_status?: string } {
		return typeof data === 'object' &&
			data !== null &&
			typeof data.id === 'string' &&
			typeof data.title === 'string';
	}

	async searchAndGetPageUrl(title: string): Promise<{ pageUrl: string | null, title: string | null }> {
		try {
			const results = await yts.search(title, { limit: 1 });
			if (results.length === 0 || !results[0]?.url) {
				logger.warn(`No video found on YouTube for title: "${title}" using play-dl.`);
				return { pageUrl: null, title: null };
			}

			return { pageUrl: results[0].url, title: results[0].title || null };
		} catch (error) {
			logger.error(`Video search for page URL failed for title "${title}":`, error);
			return { pageUrl: null, title: null };
		}
	}

	async search(query: string, limit: number = 5): Promise<string[]> {
		try {
			const searchResults = await yts.search(query, { limit });
			return searchResults.map((video, index) =>
				`${index + 1}. \`${video.title}\``
			);
		} catch (error) {
			logger.warn(`No videos found with the given title: "${query}"`);
			return [];
		}
	}

	async getLiveStreamUrl(youtubePageUrl: string): Promise<string | null> {
		try {
			const options = this.getYtdlpOptions({
				getUrl: true,
				format: 'best[protocol=m3u8_native]/best[protocol=http_dash_segments]/best',
				noPlaylist: true,
				quiet: true,
				noWarnings: true,
			});
			const streamUrl = await ytdl_dlp(youtubePageUrl, options);

			if (typeof streamUrl === 'string' && streamUrl.trim()) {
				logger.info(`Got live stream URL for ${youtubePageUrl}: ${streamUrl.trim()}`);
				return streamUrl.trim();
			}
			logger.warn(`yt-dlp did not return a valid live stream URL for: ${youtubePageUrl}. Received: ${streamUrl}`);
			return null;
		} catch (error) {
			logger.error(`Failed to get live stream URL using yt-dlp for ${youtubePageUrl}:`, error);
			return null;
		}
	}
}
