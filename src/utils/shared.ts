import { Message, ActivityOptions } from "discord.js-selfbot-v13";
import config from "../config.js";
import logger from "./logger.js";
import fs from 'fs';

/**
 * Shared utility functions for Discord bot operations
 */
export const DiscordUtils = {
	/**
	 * Create idle status for Discord bot
	 */
	status_idle(): ActivityOptions {
		return {
			name: config.prefix + "",
			type: 'STREAMING'
		};
	},

	/**
	 * Create watching status for Discord bot
	 */
	status_watch(name: string): ActivityOptions {
		return {
			name: `${name}`,
			type: 'WATCHING'
		};
	},

	/**
	 * Send error message with reaction
	 */
	async sendError(message: Message, error: string): Promise<void> {
		await message.reply(`**ᴇʀʀᴏʀ**\n\`\`\`diff\n- ${error}\n\`\`\``);
	},

	/**
	 * Send success message with reaction
	 */
	async sendSuccess(message: Message, description: string): Promise<void> {
		await message.channel.send(`**ᴄᴏɴɴᴇᴄᴛɪɴɢ ᴛᴏ sᴛʀᴇᴀᴍ...**\n\`\`\`diff\n+ ${description}\n\`\`\``);
	},

	async sendStopSuccess(message: Message, description: string): Promise<void> {
		await message.channel.send(`**sᴛʀᴇᴀᴍ ᴇɴᴅɪɴɢ...**\n\`\`\`diff\n+ ${description}\n\`\`\``);
	},

	/**
	 * Send info message with reaction
	 */
	async sendInfo(message: Message, title: string, description: string): Promise<void> {
		await message.channel.send(`**${title}**\n\`\`\`yaml\n${description}\n\`\`\``);
	},

	/**
	 * Send playing message with reaction
	 */
	async sendPlaying(message: Message, title: string): Promise<void> {
		await message.react('▶️');
		await message.reply(`📽 **ɴᴏᴡ sᴛʀᴇᴀᴍɪɴɢ**\n\`\`\`diff\n+ ${title}\n\`\`\``);
	},

	/**
	 * Send finish message
	 */
	async sendFinishMessage(message: Message): Promise<void> {
		await message.channel.send(`**sᴛʀᴇᴀᴍ ɴᴏᴡ ᴇɴᴅɪɴɢ...**\n\`\`\`fix\nsᴛʀᴇᴀᴍ ʜᴀs ᴇɴᴅᴇᴅ.\n\`\`\``);
	},

	/**
	 * Send list message with reaction
	 */
	async sendList(message: Message, items: string[], type?: string): Promise<void> {
		await message.react('📋');
		let title = '📋 Local Videos List';
		if (type == "ytsearch") {
			title = '📋 Search Results';
		} else if (type == "refresh") {
			title = '📋 Video list refreshed';
		}

		await message.channel.send(`**${title}**\n\`\`\`\n${items.join('\n')}\n\`\`\``);
	}
};

/**
 * Error handling utilities
 */
export const ErrorUtils = {
	/**
	 * Handle and log errors consistently
	 */
	async handleError(error: any, context: string, message?: Message): Promise<void> {
		logger.error(`Error in ${context}:`, error);

		// Only send to discord if message is provided AND it's not a generic "handled" error that we want to suppress
		if (message) {
			await DiscordUtils.sendError(message, `An error occurred: ${error.message || 'Unknown error'}`);
		}
	},

	/**
	 * Handle async operation errors
	 */
	async withErrorHandling<T>(
		operation: () => Promise<T>,
		context: string,
		message?: Message
	): Promise<T | null> {
		try {
			return await operation();
		} catch (error) {
			await this.handleError(error, context, message);
			return null;
		}
	}
};

/**
 * General utility functions
 */
export const GeneralUtils = {
	/**
	 * Check if input is a valid streaming URL
	 */
	isValidUrl(input: string): boolean {
		if (!input || typeof input !== 'string') {
			return false;
		}

		// Check for common streaming platforms
		return input.includes('youtube.com/') ||
			input.includes('youtu.be/') ||
			input.includes('twitch.tv/') ||
			input.includes('cinemaos.tech/') ||
			input.includes('vidking.net/') ||
			input.startsWith('http://') ||
			input.startsWith('https://');
	},

	/**
	 * Check if a path is a local file
	 */
	isLocalFile(filePath: string): boolean {
		try {
			return fs.existsSync(filePath) && fs.lstatSync(filePath).isFile();
		} catch (error) {
			return false;
		}
	}
};