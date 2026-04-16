import { config } from "./config.js";
import { createBot, shutdownAllRuns } from "./bot.js";

const client = createBot();
client.login(config.discordToken);

function shutdown() {
  console.log("Shutting down...");
  shutdownAllRuns();
  client.destroy();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
