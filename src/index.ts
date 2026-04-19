import { config } from "./config.js";
import { CoreHandler } from "./core-handler.js";
import { DiscordAdapter } from "./adapters/discord.js";
import type { BotAdapter } from "./types.js";

const adapters: BotAdapter[] = [];
const handlers: CoreHandler[] = [];

if (config.platforms.discord) {
  const adapter = new DiscordAdapter(config.platforms.discord.token);
  const handler = new CoreHandler(adapter);
  adapters.push(adapter);
  handlers.push(handler);
}

if (!adapters.length) {
  console.error("No platform adapters configured. Set at least one platform token.");
  process.exit(1);
}

await Promise.all(
  adapters.map((adapter, i) => {
    const handler = handlers[i];
    return adapter.start(
      (msg) => handler.handleMessage(msg),
      (convId, userId, cmd, args) => handler.handleCommand(convId, userId, cmd, args),
    );
  })
);

function shutdown() {
  console.log("Shutting down...");
  handlers.forEach(h => h.shutdownAllRuns());
  Promise.all(adapters.map(a => a.stop())).then(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
