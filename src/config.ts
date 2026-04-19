import "dotenv/config";

export interface PlatformConfig {
  discord?: { token: string };
  telegram?: { token: string };
}

export interface Config {
  platforms: PlatformConfig;
  allowedUserIds: string[];
  ccWorkingDir: string;
  ccModel?: string;
  maxConcurrentClaude: number;
  shellTimeout: number;
}

function loadConfig(): Config {
  const platforms: PlatformConfig = {};

  const discordToken = process.env.DISCORD_TOKEN;
  if (discordToken) platforms.discord = { token: discordToken };

  const telegramToken = process.env.TELEGRAM_TOKEN;
  if (telegramToken) platforms.telegram = { token: telegramToken };

  if (!Object.keys(platforms).length) {
    throw new Error("At least one platform token is required (DISCORD_TOKEN, TELEGRAM_TOKEN)");
  }

  const allowedUserIds = process.env.ALLOWED_USER_IDS?.split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowedUserIds?.length) throw new Error("ALLOWED_USER_IDS is required");

  const ccWorkingDir = process.env.CC_WORKING_DIR || process.cwd();

  return {
    platforms,
    allowedUserIds,
    ccWorkingDir,
    ccModel: process.env.CC_MODEL || undefined,
    maxConcurrentClaude: parseInt(process.env.MAX_CONCURRENT_CLAUDE || "3", 10),
    shellTimeout: parseInt(process.env.SHELL_TIMEOUT || "30000", 10),
  };
}

export const config = loadConfig();
