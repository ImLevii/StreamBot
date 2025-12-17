import got from 'got';
import fs from 'fs';

async function fetchDebug() {
    try {
        const url = "https://vidsrc.cc/v2/embed/movie/8457";
        console.log(`Fetching ${url}...`);
        const response = await got(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://vidsrc.cc'
            }
        });
        fs.writeFileSync('tmp/vidsrc_debug.html', response.body);
        console.log("Saved to tmp/vidsrc_debug.html");
    } catch (d) {
        console.error("Error:", d);
    }
}

fetchDebug();
