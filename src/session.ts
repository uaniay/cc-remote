import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const SESSIONS_FILE = join(process.cwd(), "sessions.json");

export interface ChannelSession {
  sessionId: string;
  workingDir: string;
  ready: boolean; // false = still in onboarding
  used: boolean;  // true after first CC call (--session-id → --resume)
}

interface SessionData {
  sessions: Record<string, ChannelSession>;
}

class SessionStore {
  private sessions: Map<string, ChannelSession> = new Map();

  constructor() {
    this.load();
  }

  get(channelId: string): ChannelSession | undefined {
    return this.sessions.get(channelId);
  }

  create(channelId: string, workingDir: string): ChannelSession {
    const session: ChannelSession = {
      sessionId: randomUUID(),
      workingDir,
      ready: true,
      used: false,
    };
    this.sessions.set(channelId, session);
    this.save();
    return session;
  }

  /** Start onboarding — create a session that isn't ready yet */
  startSetup(channelId: string): void {
    this.sessions.set(channelId, { sessionId: "", workingDir: "", ready: false, used: false });
  }

  /** Finish onboarding — assign dir and generate session ID */
  finishSetup(channelId: string, workingDir: string): ChannelSession {
    const session: ChannelSession = {
      sessionId: randomUUID(),
      workingDir,
      ready: true,
      used: false,
    };
    this.sessions.set(channelId, session);
    this.save();
    return session;
  }

  setWorkingDir(channelId: string, dir: string): void {
    const existing = this.sessions.get(channelId);
    if (existing) {
      existing.workingDir = dir;
      existing.sessionId = randomUUID();
      existing.used = false;
      this.save();
    }
  }

  markUsed(channelId: string): void {
    const existing = this.sessions.get(channelId);
    if (existing && !existing.used) {
      existing.used = true;
      this.save();
    }
  }

  reset(channelId: string): boolean {
    const deleted = this.sessions.delete(channelId);
    if (deleted) this.save();
    return deleted;
  }

  list(): Map<string, ChannelSession> {
    return new Map(this.sessions);
  }

  isNew(channelId: string): boolean {
    const s = this.sessions.get(channelId);
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
    writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
  }
}

export const sessionStore = new SessionStore();
