import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { config } from "./config.js";

export interface ClaudeEvent {
  type: "init" | "thinking" | "text" | "tool_use" | "tool_result" | "result" | "error";
  data: any;
}

export interface ClaudeRunOptions {
  sessionId: string;
  isNew: boolean;
  workingDir: string;
}

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export function runClaude(prompt: string, opts: ClaudeRunOptions): EventEmitter {
  const emitter = new EventEmitter();

  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
  ];

  if (config.ccModel) args.push("--model", config.ccModel);

  if (opts.isNew) {
    args.push("--session-id", opts.sessionId);
  } else {
    args.push("--resume", opts.sessionId);
  }

  const proc = spawn("claude", args, {
    cwd: opts.workingDir,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const timeout = setTimeout(() => {
    proc.kill("SIGTERM");
    emitter.emit("event", { type: "error", data: { message: "Timeout: CC process killed after 5 minutes" } });
  }, TIMEOUT_MS);

  let buffer = "";

  proc.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop()!; // keep incomplete last line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const event = parseStreamLine(parsed);
        if (event) emitter.emit("event", event);
      } catch {
        // skip unparseable lines
      }
    }
  });

  let stderr = "";
  proc.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  proc.on("close", (code) => {
    clearTimeout(timeout);
    // flush remaining buffer
    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer);
        const event = parseStreamLine(parsed);
        if (event) emitter.emit("event", event);
      } catch { /* ignore */ }
    }
    if (code !== 0 && code !== null) {
      emitter.emit("event", { type: "error", data: { message: `CC exited with code ${code}`, stderr } });
    }
    emitter.emit("done");
  });

  proc.on("error", (err) => {
    clearTimeout(timeout);
    emitter.emit("event", { type: "error", data: { message: err.message } });
    emitter.emit("done");
  });

  // expose kill for external abort
  (emitter as any).kill = () => {
    proc.kill("SIGTERM");
  };

  return emitter;
}

function parseStreamLine(obj: any): ClaudeEvent | null {
  if (obj.type === "system" && obj.subtype === "init") {
    return { type: "init", data: { model: obj.model, sessionId: obj.session_id } };
  }

  if (obj.type === "assistant" && obj.message?.content) {
    for (const block of obj.message.content) {
      if (block.type === "thinking") {
        return { type: "thinking", data: { text: block.thinking } };
      }
      if (block.type === "text") {
        return { type: "text", data: { text: block.text } };
      }
      if (block.type === "tool_use") {
        return { type: "tool_use", data: { name: block.name, input: block.input } };
      }
    }
  }

  if (obj.type === "user" && obj.message?.content) {
    for (const block of obj.message.content) {
      if (block.type === "tool_result") {
        return { type: "tool_result", data: { content: block.content, isError: block.is_error } };
      }
    }
  }

  if (obj.type === "result") {
    return {
      type: "result",
      data: {
        result: obj.result,
        cost: obj.total_cost_usd,
        duration: obj.duration_ms,
        turns: obj.num_turns,
        isError: obj.is_error,
      },
    };
  }

  return null;
}
