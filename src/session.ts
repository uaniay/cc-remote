import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_FILE = join(__dirname, "..", "sessions.json");

export interface ConversationSession {
  sessionId: string;
  workingDir: string;
  ready: boolean;
  used: boolean;
}

interface SessionData {
  sessions: Record<string, ConversationSession>;
}

class SessionStore {
  private sessions: Map<string, ConversationSession> = new Map();

  constructor() {
    this.load();
  }

  get(conversationId: string): ConversationSession | undefined {
    return this.sessions.get(conversationId);
  }

  create(conversationId: string, workingDir: string): ConversationSession {
    const session: ConversationSession = {
      sessionId: randomUUID(),
      workingDir,
      ready: true,
      used: false,
    };
    this.sessions.set(conversationId, session);
    this.save();
    return session;
  }

  startSetup(conversationId: string): void {
    this.sessions.set(conversationId, { sessionId: "", workingDir: "", ready: false, used: false });
  }

  finishSetup(conversationId: string, workingDir: string): ConversationSession {
    const session: ConversationSession = {
      sessionId: randomUUID(),
      workingDir,
      ready: true,
      used: false,
    };
    this.sessions.set(conversationId, session);
    this.save();
    return session;
  }

  setWorkingDir(conversationId: string, dir: string): void {
    const existing = this.sessions.get(conversationId);
    if (existing) {
      existing.workingDir = dir;
      existing.sessionId = randomUUID();
      existing.used = false;
      this.save();
    }
  }

  markUsed(conversationId: string): void {
    const existing = this.sessions.get(conversationId);
    if (existing && !existing.used) {
      existing.used = true;
      this.save();
    }
  }

  resumeSession(conversationId: string, sessionId: string): void {
    const existing = this.sessions.get(conversationId);
    if (existing) {
      existing.sessionId = sessionId;
      existing.used = true;
      this.save();
    }
  }

  reset(conversationId: string): boolean {
    const deleted = this.sessions.delete(conversationId);
    if (deleted) this.save();
    return deleted;
  }

  list(): Map<string, ConversationSession> {
    return new Map(this.sessions);
  }

  isNew(conversationId: string): boolean {
    const s = this.sessions.get(conversationId);
    return !s || !s.ready;
  }

  private load() {
    if (!existsSync(SESSIONS_FILE)) return;
    try {
      const data: SessionData = JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
      for (const [k, v] of Object.entries(data.sessions)) {
        this.sessions.set(k, v);
      }
    } catch {
      // corrupted file, start fresh
    }
  }

  private save() {
    const data: SessionData = { sessions: Object.fromEntries(this.sessions) };
    const tmp = SESSIONS_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, SESSIONS_FILE);
  }
}

export const sessionStore = new SessionStore();
