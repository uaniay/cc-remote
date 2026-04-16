# cc-remote

A Discord bot that lets you interact with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) remotely through Discord channels.

Each Discord channel maintains its own Claude Code session with full conversation context, streaming output, and tool-use visibility.

## Features

- Per-channel Claude Code sessions with persistent context (`--resume`)
- Streaming output with real-time message editing
- Tool call display (Bash, Read, Edit, Write, Grep, Glob, etc.)
- Thinking block rendering
- Cost / duration / turn stats after each response
- User allowlist for access control
- Graceful shutdown with SIGINT/SIGTERM handling

## Prerequisites

- Node.js 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))

## Setup

1. Clone the repo and install dependencies:

```bash
git clone <repo-url>
cd cc-remote
npm install
```

2. Create a `.env` file:

```env
DISCORD_TOKEN=your_discord_bot_token
ALLOWED_USER_IDS=123456789,987654321
CC_WORKING_DIR=/default/working/dir    # optional, defaults to cwd
CC_MODEL=sonnet                         # optional, Claude model override
MAX_CONCURRENT_CLAUDE=3                 # optional, default 3
SHELL_TIMEOUT=30000                     # optional, default 30s
```

3. Run:

```bash
# Development
npm run dev

# Production
npm run build && npm start
```

## Bot Commands

| Command | Description |
|---------|-------------|
| `!reset` | Clear session and conversation context |
| `!cd <path>` | Change working directory (resets session) |
| `!pwd` | Show current working directory |
| `!status` | List all active sessions |
| `!ls [args]` | List directory contents |

Any other message is sent directly to Claude Code as a prompt.

## Architecture

```
src/
├── index.ts           # Entry point, login & shutdown
├── config.ts          # Environment variable loading
├── bot.ts             # Discord message handling & commands
├── claude.ts          # Claude Code CLI spawning & stream parsing
├── discord-output.ts  # Buffered streaming output to Discord
└── session.ts         # Per-channel session persistence (sessions.json)
```

## How It Works

1. First message in a channel triggers onboarding — you pick a working directory.
2. The bot spawns `claude` CLI with `--session-id` (new) or `--resume` (existing) and streams JSON output.
3. `DiscordOutput` buffers the stream and edits Discord messages every 1.5s to show real-time progress.
4. Sessions are persisted to `sessions.json` so they survive restarts.

## License

MIT
