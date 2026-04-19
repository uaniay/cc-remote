import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.js";
import { sessionStore } from "./session.js";
import { runClaude, type ClaudeProcess } from "./claude.js";
import { listSessions, formatSessionList } from "./history.js";
import type { BotAdapter, IncomingMessage } from "./types.js";

const execFileAsync = promisify(execFile);

interface ActiveRun {
  process: ClaudeProcess;
  conversationId: string;
}

const DANGEROUS_PATTERNS = [
  /rm\s+(-\w+\s+)*\//,
  /mkfs/,
  /dd\s+.*of=\/dev/,
  />\s*\/dev\/sd/,
  /:\(\)\{\s*:\|:&\s*\};:/,
];

export class CoreHandler {
  private adapter: BotAdapter;
  private activeRuns = new Map<string, ActiveRun>();
  private channelModes = new Map<string, string>();
  private onboarding = new Map<string, { state: "awaiting_dir"; startedAt: number }>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(adapter: BotAdapter) {
    this.adapter = adapter;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, ob] of this.onboarding) {
        if (now - ob.startedAt > 10 * 60 * 1000) {
          this.onboarding.delete(id);
        }
      }
    }, 60 * 1000);
  }

  private getWorkingDir(conversationId: string): string {
    const session = sessionStore.get(conversationId);
    return session?.ready ? session.workingDir : config.ccWorkingDir;
  }

  async handleMessage(msg: IncomingMessage): Promise<void> {
    if (!config.allowedUserIds.includes(msg.userId)) return;

    const { conversationId, text } = msg;
    if (!text) return;

    // --- onboarding flow ---
    const ob = this.onboarding.get(conversationId);
    if (ob?.state === "awaiting_dir") {
      if (Date.now() - ob.startedAt > 10 * 60 * 1000) {
        this.onboarding.delete(conversationId);
        await this.adapter.sendText(conversationId, "Onboarding timed out. Send a message to start again.");
        return;
      }
      const dir = resolve(text);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        await this.adapter.sendText(conversationId, `\`${dir}\` is not a valid directory. Try again:`);
        return;
      }
      sessionStore.finishSetup(conversationId, dir);
      this.onboarding.delete(conversationId);
      await this.adapter.sendText(conversationId, `Working directory set to \`${dir}\`. Ready to go — send me a prompt.`);
      return;
    }

    // --- ! shell commands ---
    if (text.startsWith("!")) {
      const cmd = text.slice(1).trim();
      if (!cmd) return;

      if (cmd.startsWith("cd ")) {
        const dir = resolve(this.getWorkingDir(conversationId), cmd.slice(3).trim());
        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
          await this.adapter.sendText(conversationId, `\`${dir}\` is not a valid directory.`);
          return;
        }
        const session = sessionStore.get(conversationId);
        if (session?.ready) {
          sessionStore.setWorkingDir(conversationId, dir);
          await this.adapter.sendText(conversationId, `Working directory changed to \`${dir}\`. Session reset.`);
        } else {
          sessionStore.finishSetup(conversationId, dir);
          this.onboarding.delete(conversationId);
          await this.adapter.sendText(conversationId, `Working directory set to \`${dir}\`. Ready to go.`);
        }
        return;
      }

      const cwd = this.getWorkingDir(conversationId);
      console.log(`[shell] user=${msg.userId} conv=${conversationId} cmd=${cmd}`);

      if (DANGEROUS_PATTERNS.some(p => p.test(cmd))) {
        await this.adapter.sendText(conversationId, "Command blocked -- matches a dangerous pattern.");
        return;
      }

      try {
        const { stdout, stderr } = await execFileAsync("sh", ["-c", cmd], {
          cwd,
          timeout: config.shellTimeout,
          maxBuffer: 1024 * 1024,
          encoding: "utf-8",
        });
        const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
        await this.adapter.sendText(conversationId, combined ? `\`\`\`\n${combined.slice(0, 1900)}\n\`\`\`` : "*(no output)*");
      } catch (err: any) {
        const errText = err.stderr?.trim() || err.message;
        await this.adapter.sendText(conversationId, `\`\`\`\n${errText.slice(0, 1900)}\n\`\`\``);
      }
      return;
    }

    // --- cc CLI subcommands ---
    if (text.startsWith("cc ")) {
      const args = text.slice(3).trim();
      if (!args) return;

      const cwd = this.getWorkingDir(conversationId);
      console.log(`[cc] user=${msg.userId} conv=${conversationId} args=${args}`);

      try {
        const { stdout, stderr } = await execFileAsync("sh", ["-c", "claude " + args], {
          cwd,
          timeout: config.shellTimeout,
          maxBuffer: 1024 * 1024,
          encoding: "utf-8",
        });
        const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
        await this.adapter.sendText(conversationId, combined ? `\`\`\`\n${combined.slice(0, 1900)}\n\`\`\`` : "*(no output)*");
      } catch (err: any) {
        const errText = [err.stdout?.trim(), err.stderr?.trim() || err.message].filter(Boolean).join("\n");
        await this.adapter.sendText(conversationId, `\`\`\`\n${errText.slice(0, 1900)}\n\`\`\``);
      }
      return;
    }

    // --- / commands — forward to CC as prompt ---
    if (text.startsWith("/")) {
      await this.sendToClaude(conversationId, text);
      return;
    }

    // --- first message: onboarding ---
    if (sessionStore.isNew(conversationId)) {
      sessionStore.startSetup(conversationId);
      this.onboarding.set(conversationId, { state: "awaiting_dir", startedAt: Date.now() });
      await this.adapter.sendText(
        conversationId,
        `Welcome! Before we start, please enter the working directory path.\n` +
        `Use \`!ls\` to browse, or type the full path directly:`
      );
      return;
    }

    // --- plain text: CC prompt or follow-up ---
    if (this.activeRuns.has(conversationId)) {
      const run = this.activeRuns.get(conversationId)!;
      run.process.sendFollowUp(text);
      await this.adapter.sendText(conversationId, "*(message forwarded to running session)*");
      return;
    }

    await this.sendToClaude(conversationId, text);
  }

  private async sendToClaude(conversationId: string, prompt: string) {
    const session = sessionStore.get(conversationId);
    if (!session?.ready) {
      await this.adapter.sendText(conversationId, "No session. Send a message first to set up.");
      return;
    }

    if (this.activeRuns.has(conversationId)) {
      const run = this.activeRuns.get(conversationId)!;
      run.process.sendFollowUp(prompt);
      await this.adapter.sendText(conversationId, "*(message forwarded to running session)*");
      return;
    }

    if (this.activeRuns.size >= config.maxConcurrentClaude) {
      await this.adapter.sendText(conversationId, `Global limit reached (${config.maxConcurrentClaude} concurrent). Please wait or abort another session.`);
      return;
    }

    const output = this.adapter.createOutput(conversationId);

    try {
      const proc = runClaude(prompt, {
        sessionId: session.sessionId,
        isNew: !session.used,
        workingDir: session.workingDir,
        permissionMode: this.channelModes.get(conversationId),
      });

      this.activeRuns.set(conversationId, { process: proc, conversationId });
      sessionStore.markUsed(conversationId);

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
      await this.adapter.sendText(conversationId, `**Error:** ${err.message}`);
    } finally {
      await output.finish();
      this.activeRuns.delete(conversationId);
    }
  }

  async handleCommand(conversationId: string, userId: string, command: string, args?: Record<string, any>): Promise<string> {
    if (!config.allowedUserIds.includes(userId)) {
      return "You are not authorized.";
    }

    if (command === "clear") {
      const had = sessionStore.reset(conversationId);
      this.onboarding.delete(conversationId);
      return had ? "Session cleared." : "No active session.";
    }

    if (command === "status") {
      const session = sessionStore.get(conversationId);
      if (session?.ready) {
        return (
          `Session: \`${session.sessionId.slice(0, 8)}...\`\n` +
          `Directory: \`${session.workingDir}\`\n` +
          `Model: \`${config.ccModel || "default"}\`\n` +
          `Used: ${session.used ? "yes" : "no"}`
        );
      }
      return "No active session. Send a message to start.";
    }

    if (command === "abort") {
      const run = this.activeRuns.get(conversationId);
      if (run) {
        await run.process.interrupt();
        return "Interrupting current request...";
      }
      return "Nothing running in this channel.";
    }

    if (command === "resume") {
      const num = args?.number as number | null | undefined;
      const cwd = this.getWorkingDir(conversationId);
      const sessions = await listSessions(cwd);

      if (num == null) {
        if (!sessions.length) return `No sessions found for \`${cwd}\`.`;
        return (
          `**Sessions in** \`${cwd}\`:\n\n` +
          formatSessionList(sessions) +
          `\n\nUse \`/resume number:<n>\` to restore.`
        );
      }

      if (num < 1 || num > sessions.length) {
        return `Invalid choice. Pick a number between 1 and ${sessions.length}.`;
      }

      const picked = sessions[num - 1];
      const session = sessionStore.get(conversationId);
      if (session?.ready) {
        sessionStore.resumeSession(conversationId, picked.sessionId);
      } else {
        sessionStore.finishSetup(conversationId, cwd);
        sessionStore.resumeSession(conversationId, picked.sessionId);
        this.onboarding.delete(conversationId);
      }

      const sid = picked.sessionId.slice(0, 8);
      const display = (picked.summary || picked.firstPrompt || "untitled").slice(0, 50);
      return `Session restored: \`${sid}...\`\n> ${display}`;
    }

    if (command === "mode") {
      const mode = args?.mode as string;
      if (!mode) return "Mode is required.";

      const run = this.activeRuns.get(conversationId);
      if (run) {
        await run.process.setPermissionMode(mode);
        this.channelModes.set(conversationId, mode);
        return `Permission mode switched to **${mode}** (active session).`;
      }
      this.channelModes.set(conversationId, mode);
      return `Permission mode set to **${mode}** (applies to next request).`;
    }

    return "Unknown command.";
  }

  shutdownAllRuns() {
    for (const [, run] of this.activeRuns) {
      run.process.abort();
    }
    this.activeRuns.clear();
    clearInterval(this.cleanupTimer);
  }
}
