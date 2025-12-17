
import { Client } from "discord.js-selfbot-v13";
import config from "../src/config.js";

const client = new Client();
const INVITE_CODE = "ccxhvbwZ";

client.on("ready", async () => {
    console.log(`${client.user?.tag} is ready!`);
    try {
        console.log(`Fetching invite: ${INVITE_CODE}...`);
        const invite = await client.fetchInvite(INVITE_CODE);
        console.log(`Invite found for guild: ${invite.guild?.name} (${invite.guild?.id})`);

        if (client.guilds.cache.has(invite.guild?.id || "")) {
            console.log("Already in this server!");
        } else {
            console.log("Accepting invite...");
            const joined = await client.acceptInvite(INVITE_CODE);
            console.log(`Successfully joined server: ${joined.guild?.name}`);
        }
    } catch (error: any) {
        console.error("Failed to join server:");
        console.error("Message:", error.message);
        console.error("Code:", error.code);
        if (error.response) {
            console.error("Response:", JSON.stringify(error.response.data, null, 2));
        }
    } finally {
        client.destroy();
        process.exit(0);
    }
});

client.login(config.token);
