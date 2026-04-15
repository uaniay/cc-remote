import type { TextChannel, Message } from "discord.js";
import type { ClaudeEvent } from "./claude.js";

const MAX_LEN = 1900;
const EDIT_INTERVAL_MS = 1500;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n...(truncated)";
}

function formatToolInput(name: string, input: any): string {
  if (name === "Bash" && input?.command) return input.command;
  if (name === "Read" && input?.file_path) return input.file_path;
  if (name === "Edit" && input?.file_path) return `${input.file_path}\n- ${truncate(input.old_string ?? "", 100)}\n+ ${truncate(input.new_string ?? "", 100)}`;
  if (name === "Write" && input?.file_path) return input.file_path;
  if (name === "Grep" && input?.pattern) return `grep "${input.pattern}" ${input.path || "."}`;
  if (name === "Glob" && input?.pattern) return input.pattern;
  return JSON.stringify(input, null, 2);
}

export class DiscordOutput {
  private channel: TextChannel;
  private currentMsg: Message | null = null;
  private buffer = "";
  private dirty = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private finished = false;

  constructor(channel: TextChannel) {
    this.channel = channel;
    this.flushTimer = setInterval(() => this.flush(), EDIT_INTERVAL_MS);
  }

  async handleEvent(event: ClaudeEvent) {
    switch (event.type) {
      case "init":
        this.append(`*Session: \`${event.data.sessionId}\` | Model: \`${event.data.model}\`*\n`);
        break;
      case "thinking":
        if (event.data.text?.trim()) {
          this.append(`> *${truncate(event.data.text.trim(), 500)}*\n`);
        }
        break;
      case "tool_use": {
        const input = formatToolInput(event.data.name, event.data.input);
        this.append(`\`Tool: ${event.data.name}\`\n\`\`\`\n${truncate(input, 800)}\n\`\`\`\n`);
        break;
      }
      case "tool_result": {
        const content = typeof event.data.content === "string"
          ? event.data.content
          : JSON.stringify(event.data.content);
        const prefix = event.data.isError ? "Error" : "Result";
        this.append(`*${prefix}:*\n\`\`\`\n${truncate(content, 800)}\n\`\`\`\n`);
        break;
      }
      case "text":
        this.append(event.data.text + "\n");
        break;
      case "result": {
        const cost = event.data.cost != null ? `$${event.data.cost.toFixed(4)}` : "?";
        const dur = event.data.duration != null ? `${(event.data.duration / 1000).toFixed(1)}s` : "?";
        const turns = event.data.turns ?? "?";
        this.append(`\n*${cost} | ${dur} | ${turns} turn(s)*\n`);
        break;
      }
      case "error":
        this.append(`**Error:** ${event.data.message}\n`);
        break;
    }
  }

  private append(text: string) {
    this.buffer += text;
    this.dirty = true;
  }

  private async flush() {
    if (!this.dirty || !this.buffer) return;
    this.dirty = false;

    try {
      if (!this.currentMsg) {
        // send first message
        const content = this.buffer.slice(0, MAX_LEN);
        this.currentMsg = await this.channel.send(content);
        if (this.buffer.length > MAX_LEN) {
          this.buffer = this.buffer.slice(MAX_LEN);
          this.dirty = true;
        } else {
          this.buffer = this.currentMsg.content; // sync with what Discord has
        }
      } else if (this.buffer.length > MAX_LEN) {
        // current buffer too long, finalize current message and start new one
        const cutPoint = this.buffer.lastIndexOf("\n", MAX_LEN);
        const splitAt = cutPoint > 0 ? cutPoint : MAX_LEN;
        const forCurrent = this.buffer.slice(0, splitAt);
        this.buffer = this.buffer.slice(splitAt);
        this.dirty = true;

        await this.currentMsg.edit(forCurrent);
        this.currentMsg = await this.channel.send(this.buffer.slice(0, MAX_LEN));
        if (this.buffer.length > MAX_LEN) {
          this.buffer = this.buffer.slice(MAX_LEN);
        } else {
          this.buffer = this.currentMsg.content;
        }
      } else {
        await this.currentMsg.edit(this.buffer);
      }
    } catch (err) {
      // Discord API error (rate limit, etc) — retry next tick
      this.dirty = true;
    }
  }

  async finish() {
    if (this.finished) return;
    this.finished = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
  }
}
