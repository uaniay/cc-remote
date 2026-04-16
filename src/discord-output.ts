import type { TextChannel, Message } from "discord.js";
import type { SDKMessage } from "./claude.js";

const MAX_LEN = 1900;
const EDIT_INTERVAL_MS = 1500;
const DIVIDER = "\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n";

const TOOL_ICONS: Record<string, string> = {
  Bash: "\uD83D\uDCBB",    // laptop
  Read: "\uD83D\uDCC4",    // page
  Edit: "\u270F\uFE0F",     // pencil
  Write: "\uD83D\uDCDD",   // memo
  Grep: "\uD83D\uDD0D",    // magnifier
  Glob: "\uD83D\uDCC2",    // folder
  Agent: "\uD83E\uDD16",   // robot
};

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n...(truncated)";
}

function cleanText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "");
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
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;
  private finished = false;
  private lastBlockType = "";
  private thinkingActive = false;

  constructor(channel: TextChannel) {
    this.channel = channel;
    this.flushTimer = setInterval(() => this.flush(), EDIT_INTERVAL_MS);
    this.safetyTimer = setTimeout(() => {
      if (!this.finished) {
        console.warn("DiscordOutput safety timeout -- auto-finishing");
        this.finish();
      }
    }, 10 * 60 * 1000);
  }

  handleMessage(msg: SDKMessage) {
    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init") {
          const sid = msg.session_id?.slice(0, 8) ?? "?";
          this.append(`\uD83D\uDD17 **Session** \`${sid}...\`  |  **Model** \`${msg.model}\`\n`);
        }
        break;
      }
      case "assistant": {
        const content = msg.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block.type === "tool_use" && "name" in block) {
            this.closeThinking();
            const icon = TOOL_ICONS[block.name] ?? "\uD83D\uDD27";
            const input = cleanText(formatToolInput(block.name, block.input));
            this.appendSection("tool");
            this.append(`${icon} **${block.name}**\n\`\`\`\n${truncate(input, 800)}\n\`\`\`\n`);
          }
        }
        break;
      }
      case "user": {
        const content = msg.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block.type === "tool_result") {
            const raw = typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((c: any) => c.text ?? JSON.stringify(c)).join("\n")
                : JSON.stringify(block.content);
            const text = cleanText(raw);
            if (block.is_error) {
              this.append(`\u274C *Error:*\n\`\`\`\n${truncate(text, 800)}\n\`\`\`\n`);
            } else {
              this.append(`\u2705 *Result:*\n\`\`\`\n${truncate(text, 800)}\n\`\`\`\n`);
            }
          }
        }
        break;
      }
      case "result": {
        this.closeThinking();
        const cost = msg.total_cost_usd != null ? `$${msg.total_cost_usd.toFixed(4)}` : "?";
        const dur = msg.duration_ms != null ? `${(msg.duration_ms / 1000).toFixed(1)}s` : "?";
        const turns = msg.num_turns ?? "?";
        if (msg.is_error && "errors" in msg && msg.errors?.length) {
          this.append(`\n\u274C **Error:** ${msg.errors.join(", ")}\n`);
        }
        this.append(`${DIVIDER}\uD83D\uDCCA  ${cost}  \u2502  ${dur}  \u2502  ${turns} turn(s)\n`);
        break;
      }
      default:
        if ((msg as any).type === "stream_event") {
          const event = (msg as any).event;
          if (event?.type === "content_block_delta") {
            if (event.delta?.type === "text_delta" && event.delta.text) {
              this.closeThinking();
              if (this.lastBlockType !== "text") {
                this.appendSection("text");
              }
              this.lastBlockType = "text";
              this.append(event.delta.text);
            } else if (event.delta?.type === "thinking_delta" && event.delta.thinking) {
              if (!this.thinkingActive) {
                this.appendSection("thinking");
                this.append("\uD83D\uDCA1 *Thinking...*\n> ");
                this.thinkingActive = true;
              }
              const lines = event.delta.thinking.split("\n");
              this.append(lines.join("\n> "));
            }
          }
        }
        break;
    }
  }

  /** Insert a visual break when switching between block types */
  private appendSection(type: string) {
    if (this.lastBlockType && this.lastBlockType !== type) {
      this.append("\n");
    }
    this.lastBlockType = type;
  }

  /** Close an active thinking block with a trailing newline */
  private closeThinking() {
    if (this.thinkingActive) {
      this.append("\n\n");
      this.thinkingActive = false;
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
        const content = this.buffer.slice(0, MAX_LEN);
        this.currentMsg = await this.channel.send(content);
        if (this.buffer.length > MAX_LEN) {
          this.buffer = this.buffer.slice(MAX_LEN);
          this.dirty = true;
        } else {
          this.buffer = this.currentMsg.content;
        }
      } else if (this.buffer.length > MAX_LEN) {
        const cutPoint = this.buffer.lastIndexOf("\n", MAX_LEN);
        const splitAt = cutPoint > 0 ? cutPoint : MAX_LEN;
        const forCurrent = this.buffer.slice(0, splitAt);
        const remainder = this.buffer.slice(splitAt);

        await this.currentMsg.edit(forCurrent);

        this.buffer = remainder;
        this.currentMsg = null;
        this.dirty = true;
      } else {
        await this.currentMsg.edit(this.buffer);
      }
    } catch (err: any) {
      if (err?.code === 50035) {
        this.buffer = truncate(this.buffer, MAX_LEN - 100);
        this.dirty = true;
      } else if (err?.status === 429) {
        const retryAfter = err.retryAfter ?? 2000;
        this.dirty = true;
        await new Promise(r => setTimeout(r, retryAfter));
      } else {
        console.error("Discord flush error:", err?.message ?? err);
        this.dirty = true;
      }
    }
  }

  async finish() {
    if (this.finished) return;
    this.finished = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.safetyTimer) clearTimeout(this.safetyTimer);
    await this.flush();
  }
}
