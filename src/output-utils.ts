import { randomUUID } from "node:crypto";

export const MAX_LEN = 1900;
export const EDIT_INTERVAL_MS = 1500;
export const DIVIDER = "\n────────────────────\n";
const DETAIL_TTL_MS = 30 * 60 * 1000;

export const TOOL_ICONS: Record<string, string> = {
  Bash: "💻",
  Read: "📄",
  Edit: "✏️",
  Write: "📝",
  Grep: "🔍",
  Glob: "📂",
  Agent: "🤖",
};

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

export function storeDetail(content: string): string {
  const id = randomUUID().slice(0, 8);
  detailStore.set(id, { content, createdAt: Date.now() });
  return id;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n...(truncated)";
}

export function cleanText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "");
}

export function formatToolInput(name: string, input: any): string {
  if (name === "Bash" && input?.command) return input.command;
  if (name === "Read" && input?.file_path) return input.file_path;
  if (name === "Edit" && input?.file_path) return `${input.file_path}\n- ${truncate(input.old_string ?? "", 100)}\n+ ${truncate(input.new_string ?? "", 100)}`;
  if (name === "Write" && input?.file_path) return input.file_path;
  if (name === "Grep" && input?.pattern) return `grep "${input.pattern}" ${input.path || "."}`;
  if (name === "Glob" && input?.pattern) return input.pattern;
  return JSON.stringify(input, null, 2);
}

export function toolSummary(name: string, input: any): string {
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
