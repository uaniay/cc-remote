import type { TextChannel, Message } from "discord.js";
import { ButtonBuilder, ButtonStyle, ActionRowBuilder } from "discord.js";
import { randomUUID } from "node:crypto";
import type { SDKMessage } from "./claude.js";

const MAX_LEN = 1900;
const EDIT_INTERVAL_MS = 1500;
const DIVIDER = "\n────────────────────\n";
const DETAIL_TTL_MS = 30 * 60 * 1000;

const TOOL_ICONS: Record<string, string> = {
  Bash: "💻",
  Read: "📄",
  Edit: "✏️",
  Write: "📝",
  Grep: "🔍",
  Glob: "📂",
  Agent: "🤖",
};

// Global detail store with TTL cleanup
const detailStore = new Map<string, { content: string; createdAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of detailStore) {
    if (now - entry.createdAt > DETAIL_TTL_MS) {
      detailStore.delete(id);
    }
  }
}, 60 * 1000);

export function getDetail(id: string): string | undefined {
  return detailStore.get(id)?.content;
}

function storeDetail(content: string): string {
  const id = randomUUID().slice(0, 8);
  detailStore.set(id, { content, createdAt: Date.now() });
  return id;
}

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

function toolSummary(name: string, input: any): string {
  if (name === "Bash" && input?.command) {
    const cmd = input.command.split("\n")[0];
    return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
  }
  if (name === "Read" && input?.file_path) return input.file_path;
  if (name === "Edit" && input?.file_path) return input.file_path;
  if (name === "Write" && input?.file_path) return input.file_path;
  if (name === "Grep" && input?.pattern) return `"${input.pattern}"`;
  if (name === "Glob" && input?.pattern) return input.pattern;
  return name;
}

function buildButtonRows(buttons: { id: string; label: string }[]): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length && rows.length < 5; i += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    const batch = buttons.slice(i, i + 5);
    for (const btn of batch) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`detail:${btn.id}`)
          .setLabel(btn.label)
          .setStyle(ButtonStyle.Secondary)
          .setEmoji("📖")
      );
    }
    rows.push(row);
  }
  return rows;
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
  private thinkingBuffer = "";
  private thinkingActive = false;
  private pendingButtons: { id: string; label: string }[] = [];

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
          this.append(`🔗 **Session** \`${sid}...\`  |  **Model** \`${msg.model}\`\n`);
        }
        break;
      }
      case "assistant": {
        const content = msg.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block.type === "tool_use" && "name" in block) {
            this.closeThinking();
            const icon = TOOL_ICONS[block.name] ?? "🔧";
            const summary = toolSummary(block.name, block.input);
            const fullInput = cleanText(formatToolInput(block.name, block.input));
            const detailId = storeDetail(`**${block.name}**\n\`\`\`\n${truncate(fullInput, 1800)}\n\`\`\``);
            this.appendSection("tool");
            this.append(`${icon} **${block.name}** \`${summary}\`\n`);
            this.pendingButtons.push({ id: detailId, label: block.name });
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
            const bytes = Buffer.byteLength(text, "utf-8");
            const prefix = block.is_error ? "❌" : "✅";
            const label = block.is_error ? "Error" : "Result";
            const detailId = storeDetail(`**${label}:**\n\`\`\`\n${truncate(text, 1800)}\n\`\`\``);
            this.append(`${prefix} *${label}* (${bytes} bytes)\n`);
            this.pendingButtons.push({ id: detailId, label });
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
          this.append(`\n❌ **Error:** ${msg.errors.join(", ")}\n`);
        }
        this.append(`${DIVIDER}📊  ${cost}  │  ${dur}  │  ${turns} turn(s)\n`);
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
                this.thinkingActive = true;
              }
              this.thinkingBuffer += event.delta.thinking;
            }
          }
        }
        break;
    }
  }

  private appendSection(type: string) {
    if (this.lastBlockType && this.lastBlockType !== type) {
      this.append("\n");
    }
    this.lastBlockType = type;
  }

  private closeThinking() {
    if (this.thinkingActive) {
      const lines = this.thinkingBuffer.split("\n").length;
      const detailId = storeDetail(`**Thinking:**\n> ${truncate(this.thinkingBuffer, 1800).split("\n").join("\n> ")}`);
      this.append(`💡 *Thinking...* (${lines} lines)\n`);
      this.pendingButtons.push({ id: detailId, label: "Thinking" });
      this.thinkingBuffer = "";
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

        // Finalize current message with buttons
        const rows = buildButtonRows(this.pendingButtons);
        this.pendingButtons = [];
        if (rows.length > 0) {
          await this.currentMsg.edit({ content: forCurrent, components: rows });
        } else {
          await this.currentMsg.edit(forCurrent);
        }

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

    this.closeThinking();

    // Final flush with buttons
    if (this.dirty || this.buffer) {
      this.dirty = false;
      try {
        const rows = buildButtonRows(this.pendingButtons);
        this.pendingButtons = [];
        if (!this.currentMsg) {
          const content = this.buffer.slice(0, MAX_LEN);
          this.currentMsg = await this.channel.send({
            content,
            components: rows,
          });
        } else {
          await this.currentMsg.edit({
            content: this.buffer.slice(0, MAX_LEN),
            components: rows,
          });
        }
      } catch (err: any) {
        console.error("Discord finish error:", err?.message ?? err);
      }
    } else if (this.pendingButtons.length > 0 && this.currentMsg) {
      // No new content but have buttons to attach
      try {
        const rows = buildButtonRows(this.pendingButtons);
        this.pendingButtons = [];
        await this.currentMsg.edit({
          content: this.currentMsg.content,
          components: rows,
        });
      } catch (err: any) {
        console.error("Discord button attach error:", err?.message ?? err);
      }
    }
  }
}
