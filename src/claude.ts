import { query, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { EventEmitter } from "node:events";
import { config } from "./config.js";

export type { SDKMessage, SDKUserMessage, Query };

export interface ClaudeRunOptions {
  sessionId?: string;
  isNew: boolean;
  workingDir: string;
  permissionMode?: string;
}

export interface ClaudeProcess extends EventEmitter {
  interrupt(): Promise<void>;
  abort(): void;
  sendFollowUp(text: string): void;
  setPermissionMode(mode: string): Promise<void>;
}

const TIMEOUT_MS = 5 * 60 * 1000;

class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private done = false;

  push(msg: SDKUserMessage) {
    if (this.done) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: msg, done: false });
    } else {
      this.queue.push(msg);
    }
  }

  end() {
    this.done = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as any, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false as const });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as any, done: true as const });
        }
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

export function runClaude(prompt: string, opts: ClaudeRunOptions): ClaudeProcess {
  const emitter = new EventEmitter() as ClaudeProcess;
  const followUpQueue = new MessageQueue();

  const options: Parameters<typeof query>[0]["options"] = {
    cwd: opts.workingDir,
    permissionMode: (opts.permissionMode ?? "bypassPermissions") as any,
    tools: { type: "preset", preset: "claude_code" },
    includePartialMessages: true,
  };

  if (config.ccModel) {
    options.model = config.ccModel;
  }

  if (!opts.isNew && opts.sessionId) {
    options.resume = opts.sessionId;
  } else if (opts.sessionId) {
    options.sessionId = opts.sessionId;
  }

  let q: Query;

  // Start the query loop asynchronously
  (async () => {
    try {
      q = query({ prompt, options });

      // Wire up follow-up messages via streamInput
      q.streamInput(followUpQueue).catch(() => {
        // streamInput ends when the query ends or queue is closed
      });

      const timeout = setTimeout(() => {
        emitter.emit("message", {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["Timeout: process killed after 5 minutes"],
          duration_ms: TIMEOUT_MS,
          duration_api_ms: 0,
          num_turns: 0,
          stop_reason: null,
          total_cost_usd: 0,
        } as SDKMessage);
        q.close();
      }, TIMEOUT_MS);

      for await (const message of q) {
        emitter.emit("message", message);
      }

      clearTimeout(timeout);
    } catch (err: any) {
      emitter.emit("message", {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: [err.message || String(err)],
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: 0,
        stop_reason: null,
        total_cost_usd: 0,
      } as SDKMessage);
    } finally {
      followUpQueue.end();
      emitter.emit("done");
    }
  })();

  emitter.interrupt = async () => {
    if (q) await q.interrupt();
  };

  emitter.abort = () => {
    if (q) q.close();
    followUpQueue.end();
  };

  emitter.sendFollowUp = (text: string) => {
    followUpQueue.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
  };

  emitter.setPermissionMode = async (mode: string) => {
    if (q) await q.setPermissionMode(mode as any);
  };

  return emitter;
}
