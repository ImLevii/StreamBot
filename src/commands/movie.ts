import { BaseCommand } from "./base.js";
import { CommandContext } from "../types/index.js";
import { MediaService } from "../services/media.js";
import { DiscordUtils, ErrorUtils } from '../utils/shared.js';
import config from "../config.js";

export default class MovieCommand extends BaseCommand {
    name = "movie";
    description = "Search for a movie and get watch links (VidKing & CinemaOS)";
    usage = "movie <name>";
    aliases = ["m", "film"];
    category = "Media";

    private mediaService: MediaService;

    constructor() {
        super();
        this.mediaService = new MediaService();
    }

    async execute(context: CommandContext): Promise<void> {
        const query = context.args.join(' ');

        if (!query) {
            await this.sendError(context.message, 'Please provide a movie name to search for.');
            return;
        }

        if (!config.tmdbApiKey) {
            await this.sendError(context.message, 'TMDB API Key is not configured in the bot settings.');
            return;
        }

        try {
            await DiscordUtils.sendInfo(context.message, 'Searching', `Searching TMDB for: \`${query}\`...`);

            const movie = await this.mediaService.searchTMDB(query);

            if (!movie) {
                await this.sendError(context.message, `No movie found for query: \`${query}\``);
                return;
            }

            const vidKingUrl = this.mediaService.getVidKingEmbedUrl(movie.id);
            const cinemaOSUrl = this.mediaService.getCinemaOSEmbedUrl(movie.id);
            const vidLinkUrl = this.mediaService.getVidLinkMovieEmbedUrl(movie.id);

            await context.message.reply({
                content: `🎥 **${movie.title}** found!`,
                embeds: [{
                    title: `🎬 ${movie.title}`,
                    description: movie.overview || "No description available.",
                    fields: [
                        { name: "Release Date", value: movie.release_date || "Unknown", inline: true },
                        { name: "TMDB ID", value: movie.id.toString(), inline: true },
                        { name: "Watch Links", value: `[VidKing](${vidKingUrl})\n[CinemaOS](${cinemaOSUrl})\n[VidLink](${vidLinkUrl})` }
                    ],
                    color: 0x00FF00,
                    footer: { text: "Attempting to stream... (Note: Embed links may require browser to watch)" }
                }]
            });

            // Attempt to stream (Prioritizing CinemaOS as requested)
            try {
                if (context.message.member?.voice.channel) {
                    // Add to queue and play
                    const success = await context.streamingService.addToQueue(context.message, cinemaOSUrl, movie.title);
                    if (success && !context.streamStatus.playing) {
                        await context.streamingService.playFromQueue(context.message);
                    }
                } else {
                    await DiscordUtils.sendInfo(context.message, 'Streaming', 'Join a voice channel to enable auto-streaming.');
                }
            } catch (err) {
                // Log error but don't crash command as we already sent the links
                ErrorUtils.handleError(err, 'auto-streaming movie', context.message);
            }

        } catch (error) {
            await ErrorUtils.handleError(error, `searching for movie: ${query}`, context.message);
        }
    }
}
