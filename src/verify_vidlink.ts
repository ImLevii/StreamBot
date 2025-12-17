
import { MediaService } from './services/media.js';
import logger from './utils/logger.js';

// Mock config for now since we just want to test MediaService
// Ensure process.env is set or config can run standalone

async function verify() {
    try {
        console.log("Starting VidLink Verification...");
        const mediaService = new MediaService();

        // A known movie ID (Inception = 27205)
        const vidLinkUrl = mediaService.getVidLinkMovieEmbedUrl(27205, { autoplay: true });
        console.log(`Testing extraction from: ${vidLinkUrl}`);

        const result = await mediaService.resolveMediaSource(vidLinkUrl);

        if (result && result.url.includes('.m3u8')) {
            console.log("✅ SUCCESS: Extracted stream URL:");
            console.log(result.url);
        } else {
            console.error("❌ FAILED: Could not extract .m3u8 stream.");
            console.log(result);
        }

    } catch (error) {
        console.error("❌ ERROR:", error);
    }
}

verify();
