import { Client, GatewayIntentBits, Events, type Message, type TextChannel } from "discord.js";
import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.js";
import { sessionStore } from "./session.js";
import { runClaude } from "./claude.js";
import { DiscordOutput } from "./discord-output.js";

const activeChannels = new Set<string>();
const onboarding = new Map<string, "awaiting_dir">();

function getWorkingDir(channelId: string): string {
  const session = sessionStore.get(channelId);
  return session?.ready ? session.workingDir : config.ccWorkingDir;
}

export function createBot(): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (!config.allowedUserIds.includes(message.author.id)) return;

    const content = message.content.trim();
    if (!content) return;

    const channel = message.channel as TextChannel;

    // --- onboarding flow ---
    if (onboarding.get(channel.id) === "awaiting_dir") {
      const dir = resolve(content);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        await channel.send(`\`${dir}\` is not a valid directory. Try again:`);
        return;
      }
      sessionStore.finishSetup(channel.id, dir);
      onboarding.delete(channel.id);
      await channel.send(`Working directory set to \`${dir}\`. Ready to go — send me a prompt.`);
      return;
    }

    // --- ! shell commands ---
    if (content.startsWith("!")) {
      const cmd = content.slice(1).trim();
      if (!cmd) return;

      // !cd is special — update session workingDir
      if (cmd.startsWith("cd ")) {
        const dir = resolve(getWorkingDir(channel.id), cmd.slice(3).trim());
        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
          await channel.send(`\`${dir}\` is not a valid directory.`);
          return;
        }
        const session = sessionStore.get(channel.id);
        if (session?.ready) {
          sessionStore.setWorkingDir(channel.id, dir);
          await channel.send(`Working directory changed to \`${dir}\`. Session reset.`);
        } else {
          sessionStore.finishSetup(channel.id, dir);
          onboarding.delete(channel.id);
          await channel.send(`Working directory set to \`${dir}\`. Ready to go.`);
        }
        return;
      }

      // all other shell commands — execute directly
      const cwd = getWorkingDir(channel.id);
      try {
        const out = execSync(cmd, { cwd, timeout: 30000, encoding: "utf-8", maxBuffer: 1024 * 1024 });
        const text = out.trim();
        if (text) {
          await channel.send(`\`\`\`\n${text.slice(0, 1900)}\n\`\`\``);
        } else {
          await channel.send("*(no output)*");
        }
      } catch (err: any) {
        const stderr = err.stderr?.trim() || err.message;
        await channel.send(`\`\`\`\n${stderr.slice(0, 1900)}\n\`\`\``);
      }
      return;
    }

    // --- / CC slash commands ---
    if (content.startsWith("/")) {
      const cmd = content.slice(1).split(/\s/)[0];

      // /clear — bot intercepts, resets session
      if (cmd === "clear") {
        const had = sessionStore.reset(channel.id);
        onboarding.delete(channel.id);
        await channel.send(had ? "Session cleared." : "No active session.");
        return;
      }

      // /status — bot intercepts, shows session info
      if (cmd === "status") {
        const session = sessionStore.get(channel.id);
        if (session?.ready) {
          await channel.send(
            `Session: \`${session.sessionId.slice(0, 8)}...\`\n` +
            `Directory: \`${session.workingDir}\`\n` +
            `Model: \`${config.ccModel || "default"}\`\n` +
            `Used: ${session.used ? "yes" : "no"}`
          );
        } else {
          await channel.send("No active session. Send a message to start.");
        }
        return;
      }

      // all other / commands — forward to CC as prompt
      await sendToClaude(channel, content);
      return;
    }

    // --- first message: onboarding ---
    if (sessionStore.isNew(channel.id)) {
      sessionStore.startSetup(channel.id);
      onboarding.set(channel.id, "awaiting_dir");
      await channel.send(
        `Welcome! Before we start, please enter the working directory path.\n` +
        `Use \`!ls\` to browse, or type the full path directly:`
      );
      return;
    }

    // --- plain text: CC prompt ---
    await sendToClaude(channel, content);
  });

  async function sendToClaude(channel: TextChannel, prompt: string) {
    const session = sessionStore.get(channel.id);
    if (!session?.ready) {
      await channel.send("No session. Send a message first to set up.");
      return;
    }

    if (activeChannels.has(channel.id)) {
      await channel.send("Still working on the previous request...");
      return;
    }

    activeChannels.add(channel.id);
    const output = new DiscordOutput(channel);

    try {
      const emitter = runClaude(prompt, {
        sessionId: session.sessionId,
        isNew: !session.used,
        workingDir: session.workingDir,
      });

      sessionStore.markUsed(channel.id);

      emitter.on("event", (event) => {
        output.handleEvent(event);
      });

      await new Promise<void>((resolve) => {
        emitter.on("done", resolve);
      });
    } catch (err: any) {
      await channel.send(`**Error:** ${err.message}`);
    } finally {
      await output.finish();
      activeChannels.delete(channel.id);
    }
  }

  client.once(Events.ClientReady, (c) => {
    console.log(`Bot ready as ${c.user.tag}`);
  });

  return client;
}
