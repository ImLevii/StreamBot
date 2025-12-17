import { BaseCommand } from "./base.js";
import { CommandContext } from "../types/index.js";
import { CommandManager } from "./manager.js";

export default class HelpCommand extends BaseCommand {
	name = "help";
	description = "Show available commands";
	usage = "help";
	category = "System";

	constructor(private commandManager: CommandManager) {
		super(commandManager);
	}

	async execute(context: CommandContext): Promise<void> {
		const commands = this.commandManager.getAllCommands();

		// Group commands by category
		const categories = new Map<string, any[]>();

		commands.forEach(cmd => {
			const category = cmd.category || 'General';
			if (!categories.has(category)) {
				categories.set(category, []);
			}
			categories.get(category)?.push(cmd);
		});

		// Sort categories
		const sortedCategories = Array.from(categories.keys()).sort();

		let helpText = '📽 **Available Commands**\n';

		for (const category of sortedCategories) {
			const categoryCommands = categories.get(category);
			if (!categoryCommands) continue;

			helpText += `\n**${category}**\n\`\`\`apache\n`;

			categoryCommands.forEach(cmd => {
				helpText += `${cmd.name.padEnd(12)} : ${cmd.description}\n`;
			});

			helpText += '```';
		}

		await context.message.react('📋');
		await context.message.reply(helpText);
	}
}