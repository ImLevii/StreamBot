import { BaseCommand } from "./base.js";
import { CommandContext } from "../types/index.js";
import { MediaService } from "../services/media.js";
import { DiscordUtils, ErrorUtils } from '../utils/shared.js';
import config from "../config.js";

export default class TVCommand extends BaseCommand {
    name = "tv";
    description = "Search for a TV show and get watch links (CinemaOS)";
    usage = "tv <name> [season] [episode]";
    aliases = ["show", "series"];
    category = "Media";

    private mediaService: MediaService;

    constructor() {
        super();
        this.mediaService = new MediaService();
    }

    async execute(context: CommandContext): Promise<void> {
        let args = context.args;
        let season = 1;
        let episode = 1;

        // Try to parse season and episode from the end of args
        // Logic: if last two args are numbers, they are S and E.
        // If only last one is number... maybe just S? But usually people say "Show Name 1 1".

        if (args.length >= 3) {
            const lastArg = parseInt(args[args.length - 1]);
            const secondLastArg = parseInt(args[args.length - 2]);

            if (!isNaN(lastArg) && !isNaN(secondLastArg)) {
                episode = lastArg;
                season = secondLastArg;
                args = args.slice(0, args.length - 2);
            }
        }

        const query = args.join(' ');

        if (!query) {
            await this.sendError(context.message, 'Please provide a TV show name (and optionally season/episode numbers). e.g. `!tv Breaking Bad 1 1`');
            return;
        }

        if (!config.tmdbApiKey) {
            await this.sendError(context.message, 'TMDB API Key is not configured in the bot settings.');
            return;
        }

        try {
            await DiscordUtils.sendInfo(context.message, 'Searching', `Searching TMDB for TV Show: \`${query}\` (S${season} E${episode})...`);

            const show = await this.mediaService.searchTMDBTV(query);

            if (!show) {
                await this.sendError(context.message, `No TV show found for query: \`${query}\``);
                return;
            }

            const cinemaOSUrl = this.mediaService.getCinemaOSTVEmbedUrl(show.id, season, episode);
            const vidLinkUrl = this.mediaService.getVidLinkTvEmbedUrl(show.id, season, episode);

            await context.message.reply({
                content: `📺 **${show.name}** S${season}E${episode} found!`,
                embeds: [{
                    title: `📺 ${show.name} - S${season} E${episode}`,
                    description: show.overview || "No description available.",
                    fields: [
                        { name: "First Air Date", value: show.first_air_date || "Unknown", inline: true },
                        { name: "TMDB ID", value: show.id.toString(), inline: true },
                        { name: "Watch Links", value: `[CinemaOS](${cinemaOSUrl})\n[VidLink](${vidLinkUrl})` }
                    ],
                    color: 0x00FFFF, // Cyan for TV
                    footer: { text: "Attempting to stream... (Note: Embed links may require browser to watch)" }
                }]
            });

            // Attempt to stream
            try {
                if (context.message.member?.voice.channel) {
                    // Add to queue and play
                    const success = await context.streamingService.addToQueue(context.message, cinemaOSUrl, `${show.name} S${season}E${episode}`);
                    if (success && !context.streamStatus.playing) {
                        await context.streamingService.playFromQueue(context.message);
                    }
                } else {
                    await DiscordUtils.sendInfo(context.message, 'Streaming', 'Join a voice channel to enable auto-streaming.');
                }
            } catch (err) {
                ErrorUtils.handleError(err, 'auto-streaming tv show', context.message);
            }

        } catch (error) {
            await ErrorUtils.handleError(error, `searching for TV show: ${query}`, context.message);
        }
    }
}
