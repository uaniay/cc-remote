import { config } from "./config.js";
import { createBot } from "./bot.js";

const client = createBot();
client.login(config.discordToken);
