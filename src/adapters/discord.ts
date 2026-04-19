import {
  Client, GatewayIntentBits, Events, REST, Routes,
  SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder,
  type Message, type TextChannel,
} from "discord.js";
import type { BotAdapter, IncomingMessage, OutputHandler } from "../types.js";
import type { SDKMessage } from "../claude.js";
import {
  MAX_LEN, EDIT_INTERVAL_MS, DIVIDER, TOOL_ICONS,
  getDetail, storeDetail, truncate, cleanText, formatToolInput, toolSummary,
} from "../output-utils.js";

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

class DiscordOutput implements OutputHandler {
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

export class DiscordAdapter implements BotAdapter {
  readonly platform = "discord";
  private client: Client;
  private token: string;
  private onCommand?: (conversationId: string, userId: string, command: string, args?: Record<string, any>) => Promise<string>;

  constructor(token: string) {
    this.token = token;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });
  }

  async sendText(conversationId: string, text: string): Promise<void> {
    const channelId = conversationId.replace("discord:", "");
    const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;
    if (channel) await channel.send(text);
  }

  createOutput(conversationId: string): OutputHandler {
    const channelId = conversationId.replace("discord:", "");
    const channel = this.client.channels.cache.get(channelId) as TextChannel;
    return new DiscordOutput(channel);
  }

  async start(
    onMessage: (msg: IncomingMessage) => Promise<void>,
    onCommand?: (conversationId: string, userId: string, command: string, args?: Record<string, any>) => Promise<string>,
  ): Promise<void> {
    this.onCommand = onCommand;

    this.client.on(Events.MessageCreate, async (message: Message) => {
      if (message.author.bot) return;
      const text = message.content.trim();
      if (!text) return;

      await onMessage({
        platform: "discord",
        conversationId: "discord:" + message.channel.id,
        userId: message.author.id,
        text,
      });
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      // Handle button clicks
      if (interaction.isButton()) {
        if (!interaction.customId.startsWith("detail:")) return;

        const detailId = interaction.customId.slice("detail:".length);
        const content = getDetail(detailId);

        if (!content) {
          await interaction.reply({ content: "Detail expired or not found.", flags: ["Ephemeral"] });
          return;
        }

        if (content.length <= 2000) {
          await interaction.reply({ content, flags: ["Ephemeral"] });
        } else {
          await interaction.reply({ content: content.slice(0, 2000), flags: ["Ephemeral"] });
          for (let i = 2000; i < content.length; i += 2000) {
            await interaction.followUp({ content: content.slice(i, i + 2000), flags: ["Ephemeral"] });
          }
        }
        return;
      }

      // Handle slash commands
      if (!interaction.isChatInputCommand() || !this.onCommand) return;

      const conversationId = "discord:" + interaction.channel!.id;
      const userId = interaction.user.id;

      try {
        if (interaction.commandName === "resume") {
          await interaction.deferReply();
          const num = interaction.options.getInteger("number");
          const reply = await this.onCommand(conversationId, userId, "resume", { number: num });
          await interaction.editReply(reply);
        } else if (interaction.commandName === "mode") {
          const mode = interaction.options.getString("mode", true);
          const reply = await this.onCommand(conversationId, userId, "mode", { mode });
          await interaction.reply(reply);
        } else {
          const reply = await this.onCommand(conversationId, userId, interaction.commandName);
          await interaction.reply(reply);
        }
      } catch (err: any) {
        console.error("Slash command error:", err.message);
        try {
          if (interaction.deferred) {
            await interaction.editReply(`Error: ${err.message}`);
          } else if (!interaction.replied) {
            await interaction.reply({ content: `Error: ${err.message}`, flags: ["Ephemeral"] });
          }
        } catch { /* interaction already expired */ }
      }
    });

    this.client.once(Events.ClientReady, async (c) => {
      console.log(`Bot ready as ${c.user.tag}`);

      const commands = [
        new SlashCommandBuilder().setName("clear").setDescription("Reset the current session"),
        new SlashCommandBuilder().setName("status").setDescription("Show current session info"),
        new SlashCommandBuilder().setName("abort").setDescription("Interrupt the running Claude process"),
        new SlashCommandBuilder()
          .setName("resume")
          .setDescription("List or restore a historical session")
          .addIntegerOption(opt =>
            opt.setName("number").setDescription("Session number to restore").setRequired(false)
          ),
        new SlashCommandBuilder()
          .setName("mode")
          .setDescription("Switch Claude permission mode")
          .addStringOption(opt =>
            opt.setName("mode").setDescription("Permission mode").setRequired(true)
              .addChoices(
                { name: "plan", value: "plan" },
                { name: "acceptEdits", value: "acceptEdits" },
                { name: "auto", value: "auto" },
                { name: "default", value: "default" },
                { name: "bypassPermissions", value: "bypassPermissions" },
              )
          ),
      ].map(c => c.toJSON());

      const rest = new REST({ version: "10" }).setToken(this.token);
      try {
        await rest.put(Routes.applicationCommands(c.user.id), { body: commands });
        console.log("Slash commands registered.");
      } catch (err) {
        console.error("Failed to register slash commands:", err);
      }
    });

    await this.client.login(this.token);
  }

  async stop(): Promise<void> {
    this.client.destroy();
  }
}
