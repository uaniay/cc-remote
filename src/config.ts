import "dotenv/config";

interface Config {
  discordToken: string;
  allowedUserIds: string[];
  ccWorkingDir: string;
  ccModel?: string;
  maxConcurrentClaude: number;
  shellTimeout: number;
}

function loadConfig(): Config {
  const discordToken = process.env.DISCORD_TOKEN;
  if (!discordToken) throw new Error("DISCORD_TOKEN is required");

  const allowedUserIds = process.env.ALLOWED_USER_IDS?.split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowedUserIds?.length) throw new Error("ALLOWED_USER_IDS is required");

  const ccWorkingDir = process.env.CC_WORKING_DIR || process.cwd();

  return {
    discordToken,
    allowedUserIds,
    ccWorkingDir,
    ccModel: process.env.CC_MODEL || undefined,
    maxConcurrentClaude: parseInt(process.env.MAX_CONCURRENT_CLAUDE || "3", 10),
    shellTimeout: parseInt(process.env.SHELL_TIMEOUT || "30000", 10),
  };
}

export const config = loadConfig();
