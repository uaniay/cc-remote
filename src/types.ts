import type { SDKMessage } from "./claude.js";

export interface IncomingMessage {
  platform: string;
  conversationId: string;
  userId: string;
  text: string;
}

export interface OutputHandler {
  handleMessage(msg: SDKMessage): void;
  finish(): Promise<void>;
}

export interface BotAdapter {
  readonly platform: string;
  sendText(conversationId: string, text: string): Promise<void>;
  createOutput(conversationId: string): OutputHandler;
  start(
    onMessage: (msg: IncomingMessage) => Promise<void>,
    onCommand?: (conversationId: string, userId: string, command: string, args?: Record<string, any>) => Promise<string>,
  ): Promise<void>;
  stop(): Promise<void>;
}
