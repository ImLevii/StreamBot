import ytdl from './src/utils/yt-dlp.js';

async function test() {
    console.log("Testing VidKing URL with headers...");
    const url = "https://www.vidking.net/embed/movie/550";

    try {
        const result = await ytdl(url, {
            dumpJson: true,
            skipDownload: true,
            referer: "https://www.vidking.net/"
        });
        console.log("Success!");
    } catch (e: any) {
        console.log("Failed with headers.");
        // console.error(e.message);
    }
}

test();
