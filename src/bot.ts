import { Client, GatewayIntentBits, Events, type Message, type TextChannel } from "discord.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.js";
import { sessionStore } from "./session.js";
import { runClaude, type ClaudeProcess } from "./claude.js";
import { DiscordOutput, getDetail } from "./discord-output.js";
import { listSessions, formatSessionList } from "./history.js";

const execFileAsync = promisify(execFile);

interface ActiveRun {
  process: ClaudeProcess;
  channelId: string;
}

const activeRuns = new Map<string, ActiveRun>();
const onboarding = new Map<string, { state: "awaiting_dir"; startedAt: number }>();

const DANGEROUS_PATTERNS = [
  /rm\s+(-\w+\s+)*\//,
  /mkfs/,
  /dd\s+.*of=\/dev/,
  />\s*\/dev\/sd/,
  /:\(\)\{\s*:\|:&\s*\};:/,
];

export function shutdownAllRuns() {
  for (const [, run] of activeRuns) {
    run.process.abort();
  }
  activeRuns.clear();
}

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
    const ob = onboarding.get(channel.id);
    if (ob?.state === "awaiting_dir") {
      if (Date.now() - ob.startedAt > 10 * 60 * 1000) {
        onboarding.delete(channel.id);
        await channel.send("Onboarding timed out. Send a message to start again.");
        return;
      }
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
      console.log(`[shell] user=${message.author.id} channel=${channel.id} cmd=${cmd}`);

      if (DANGEROUS_PATTERNS.some(p => p.test(cmd))) {
        await channel.send("Command blocked -- matches a dangerous pattern.");
        return;
      }

      try {
        const { stdout, stderr } = await execFileAsync("sh", ["-c", cmd], {
          cwd,
          timeout: config.shellTimeout,
          maxBuffer: 1024 * 1024,
          encoding: "utf-8",
        });
        const text = stdout.trim();
        const errOut = stderr.trim();
        const combined = [text, errOut].filter(Boolean).join("\n");
        if (combined) {
          await channel.send(`\`\`\`\n${combined.slice(0, 1900)}\n\`\`\``);
        } else {
          await channel.send("*(no output)*");
        }
      } catch (err: any) {
        const errText = err.stderr?.trim() || err.message;
        await channel.send(`\`\`\`\n${errText.slice(0, 1900)}\n\`\`\``);
      }
      return;
    }

    // --- cc CLI subcommands ---
    if (content.startsWith("cc ")) {
      const args = content.slice(3).trim();
      if (!args) return;

      const cwd = getWorkingDir(channel.id);
      console.log(`[cc] user=${message.author.id} channel=${channel.id} args=${args}`);

      try {
        const { stdout, stderr } = await execFileAsync("sh", ["-c", "claude " + args], {
          cwd,
          timeout: config.shellTimeout,
          maxBuffer: 1024 * 1024,
          encoding: "utf-8",
        });
        const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
        if (combined) {
          await channel.send(`\`\`\`\n${combined.slice(0, 1900)}\n\`\`\``);
        } else {
          await channel.send("*(no output)*");
        }
      } catch (err: any) {
        const errText = [err.stdout?.trim(), err.stderr?.trim() || err.message].filter(Boolean).join("\n");
        await channel.send(`\`\`\`\n${errText.slice(0, 1900)}\n\`\`\``);
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

      // /abort — interrupt running Claude process
      if (cmd === "abort") {
        const run = activeRuns.get(channel.id);
        if (run) {
          await run.process.interrupt();
          await channel.send("Interrupting current request...");
        } else {
          await channel.send("Nothing running in this channel.");
        }
        return;
      }

      // /resume [n] — list or restore a historical session
      if (cmd === "resume") {
        const arg = content.slice("/resume".length).trim();
        const cwd = getWorkingDir(channel.id);
        const sessions = await listSessions(cwd);

        if (!arg) {
          // list available sessions
          if (!sessions.length) {
            await channel.send(`No sessions found for \`${cwd}\`.`);
            return;
          }
          await channel.send(
            `**Sessions in** \`${cwd}\`:\n\n` +
            formatSessionList(sessions) +
            `\n\nUse \`/resume <number>\` to restore.`
          );
          return;
        }

        // pick by number
        const idx = parseInt(arg, 10);
        if (isNaN(idx) || idx < 1 || idx > sessions.length) {
          await channel.send(`Invalid choice. Pick a number between 1 and ${sessions.length}.`);
          return;
        }

        const picked = sessions[idx - 1];
        const session = sessionStore.get(channel.id);
        if (session?.ready) {
          sessionStore.resumeSession(channel.id, picked.sessionId);
        } else {
          sessionStore.finishSetup(channel.id, cwd);
          sessionStore.resumeSession(channel.id, picked.sessionId);
          onboarding.delete(channel.id);
        }

        const sid = picked.sessionId.slice(0, 8);
        const display = (picked.summary || picked.firstPrompt || "untitled").slice(0, 50);
        await channel.send(`Session restored: \`${sid}...\`\n> ${display}`);
        return;
      }

      // all other / commands — forward to CC as prompt
      await sendToClaude(channel, content);
      return;
    }

    // --- first message: onboarding ---
    if (sessionStore.isNew(channel.id)) {
      sessionStore.startSetup(channel.id);
      onboarding.set(channel.id, { state: "awaiting_dir", startedAt: Date.now() });
      await channel.send(
        `Welcome! Before we start, please enter the working directory path.\n` +
        `Use \`!ls\` to browse, or type the full path directly:`
      );
      return;
    }

    // --- plain text: CC prompt or follow-up ---
    if (activeRuns.has(channel.id)) {
      const run = activeRuns.get(channel.id)!;
      run.process.sendFollowUp(content);
      await channel.send("*(message forwarded to running session)*");
      return;
    }

    await sendToClaude(channel, content);
  });

  async function sendToClaude(channel: TextChannel, prompt: string) {
    const session = sessionStore.get(channel.id);
    if (!session?.ready) {
      await channel.send("No session. Send a message first to set up.");
      return;
    }

    if (activeRuns.has(channel.id)) {
      const run = activeRuns.get(channel.id)!;
      run.process.sendFollowUp(prompt);
      await channel.send("*(message forwarded to running session)*");
      return;
    }

    if (activeRuns.size >= config.maxConcurrentClaude) {
      await channel.send(`Global limit reached (${config.maxConcurrentClaude} concurrent). Please wait or \`/abort\` another channel.`);
      return;
    }

    const output = new DiscordOutput(channel);

    try {
      const proc = runClaude(prompt, {
        sessionId: session.sessionId,
        isNew: !session.used,
        workingDir: session.workingDir,
      });

      activeRuns.set(channel.id, { process: proc, channelId: channel.id });
      sessionStore.markUsed(channel.id);

      proc.on("message", (msg) => {
        try {
          output.handleMessage(msg);
        } catch (err) {
          console.error("Error handling Claude message:", err);
        }
      });

      await new Promise<void>((resolve) => {
        proc.on("done", resolve);
      });
    } catch (err: any) {
      await channel.send(`**Error:** ${err.message}`);
    } finally {
      await output.finish();
      activeRuns.delete(channel.id);
    }
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith("detail:")) return;

    const detailId = interaction.customId.slice("detail:".length);
    const content = getDetail(detailId);

    if (!content) {
      await interaction.reply({ content: "Detail expired or not found.", ephemeral: true });
      return;
    }

    // Discord ephemeral messages have 2000 char limit
    if (content.length <= 2000) {
      await interaction.reply({ content, ephemeral: true });
    } else {
      // Send first chunk as reply, follow up with rest
      await interaction.reply({ content: content.slice(0, 2000), ephemeral: true });
      for (let i = 2000; i < content.length; i += 2000) {
        await interaction.followUp({ content: content.slice(i, i + 2000), ephemeral: true });
      }
    }
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`Bot ready as ${c.user.tag}`);
  });

  // Periodic cleanup of expired onboarding entries
  setInterval(() => {
    const now = Date.now();
    for (const [id, ob] of onboarding) {
      if (now - ob.startedAt > 10 * 60 * 1000) {
        onboarding.delete(id);
      }
    }
  }, 60 * 1000);

  return client;
}
