import { BaseCommand } from "./base.js";
import { CommandContext } from "../types/index.js";

export default class PingCommand extends BaseCommand {
	name = "ping";
	description = "Check bot latency";
	usage = "ping";
	category = "System";

	async execute(context: CommandContext): Promise<void> {
		const sent = await context.message.reply('ᴘɪɴɢɪɴɢ sᴇʀᴠᴇʀ...');
		const timeDiff = sent.createdTimestamp - context.message.createdTimestamp;
		await sent.edit(`🏓 ${timeDiff}ᴍs`);
	}
}