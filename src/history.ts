import { listSessions as sdkListSessions, type SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";

export type HistoryEntry = SDKSessionInfo;

export async function listSessions(workingDir: string, limit = 10): Promise<HistoryEntry[]> {
  const sessions = await sdkListSessions({ dir: workingDir, limit });
  return sessions;
}

export function formatSessionList(sessions: HistoryEntry[]): string {
  if (!sessions.length) return "No sessions found.";

  return sessions.map((s, i) => {
    const date = new Date(s.lastModified);
    const ts = `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    const display = (s.summary || s.firstPrompt || "untitled").slice(0, 60);
    const sid = s.sessionId.slice(0, 8);
    return `\`${i + 1}.\` \`[${ts}]\` ${display}  *(\`${sid}...\`)*`;
  }).join("\n");
}
