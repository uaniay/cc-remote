import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HISTORY_FILE = join(homedir(), ".claude", "history.jsonl");

export interface HistoryEntry {
  display: string;
  timestamp: number;
  project: string;
  sessionId: string;
}

export function listSessions(workingDir?: string, limit = 10): HistoryEntry[] {
  if (!existsSync(HISTORY_FILE)) return [];

  const lines = readFileSync(HISTORY_FILE, "utf-8").split("\n").filter(Boolean);
  const seen = new Map<string, HistoryEntry>();

  for (const line of lines) {
    try {
      const entry: HistoryEntry = JSON.parse(line);
      if (!entry.sessionId || !entry.display) continue;
      if (workingDir && entry.project !== workingDir) continue;
      // keep the latest entry per session
      const existing = seen.get(entry.sessionId);
      if (!existing || entry.timestamp > existing.timestamp) {
        seen.set(entry.sessionId, entry);
      }
    } catch { /* skip */ }
  }

  return [...seen.values()]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}

export function formatSessionList(sessions: HistoryEntry[]): string {
  if (!sessions.length) return "No sessions found.";

  return sessions.map((s, i) => {
    const date = new Date(s.timestamp);
    const ts = `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    const display = s.display.length > 60 ? s.display.slice(0, 57) + "..." : s.display;
    const sid = s.sessionId.slice(0, 8);
    return `\`${i + 1}.\` \`[${ts}]\` ${display}  *(\`${sid}...\`)*`;
  }).join("\n");
}
