# cc-remote

A Discord bot that lets you interact with [Claude Code](https://code.claude.com) remotely through Discord channels, powered by the official [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview).

Each Discord channel maintains its own Claude Code session with bidirectional streaming, real-time token output, and collapsible tool details.

## Features

- **Agent SDK integration** — uses `@anthropic-ai/claude-agent-sdk` for full programmatic control
- **Bidirectional streaming** — send follow-up messages while Claude is working (btw)
- **Real-time token streaming** — typewriter effect via message editing every 1.5s
- **Collapsible details** — thinking, tool calls, and results show as compact summaries with expandable buttons
- **Slash commands** — `/clear`, `/status`, `/abort`, `/resume`, `/mode`
- **Permission mode switching** — plan, acceptEdits, auto, default, bypassPermissions
- **Session resume** — list and restore historical Claude Code sessions
- **Shell commands** — `!` prefix for arbitrary shell execution
- **CLI subcommands** — `cc` prefix for Claude CLI management (mcp, plugin, agents, etc.)
- **Concurrency control** — configurable global limit on simultaneous Claude processes
- **Graceful shutdown** — SIGINT/SIGTERM cleanup of child processes

## Prerequisites

- Node.js 18+
- [Claude Code CLI](https://code.claude.com/docs/en/setup) installed and authenticated
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))

## Setup

1. Clone and install:

```bash
git clone https://github.com/uaniay/cc-remote.git
cd cc-remote
npm install
```

2. Create `.env`:

```env
DISCORD_TOKEN=your_discord_bot_token
ALLOWED_USER_IDS=123456789,987654321
CC_WORKING_DIR=/default/working/dir    # optional, defaults to cwd
CC_MODEL=sonnet                         # optional, model override
MAX_CONCURRENT_CLAUDE=3                 # optional, default 3
SHELL_TIMEOUT=30000                     # optional, default 30s
```

3. Run:

```bash
npm run dev          # development (tsx)
npm run build && npm start  # production
```

4. Deploy as background service (pm2):

```bash
npm install -g pm2
npm run build
pm2 start dist/index.js --name cc-remote --cwd /home/uania/repos/cc-remote
pm2 startup && pm2 save   # auto-start on boot
```

pm2 commands:

```bash
pm2 logs cc-remote       # view logs
pm2 restart cc-remote    # restart
pm2 stop cc-remote       # stop
pm2 status               # check status
```

Update and restart after code changes:

```bash
git pull && npm install && npm run build && pm2 restart cc-remote
```

## Commands

### Slash Commands

| Command | Description |
|---------|-------------|
| `/clear` | Reset session and conversation context |
| `/status` | Show current session info (ID, directory, model) |
| `/abort` | Interrupt the running Claude process |
| `/resume [number]` | List or restore historical sessions |
| `/mode <mode>` | Switch permission mode (plan, acceptEdits, auto, default, bypassPermissions) |

### Text Commands

| Prefix | Description | Example |
|--------|-------------|---------|
| `!` | Execute shell command | `!ls -la`, `!git status` |
| `!cd <path>` | Change working directory | `!cd /home/user/project` |
| `cc` | Run Claude CLI subcommand | `cc mcp list`, `cc plugin list` |
| *(plain text)* | Send prompt to Claude | Just type your message |

When Claude is busy, new messages are forwarded to the running session as follow-ups.

## Architecture

```
src/
├── index.ts           # Entry point, login & graceful shutdown
├── config.ts          # Environment variable loading
├── bot.ts             # Discord message/interaction handling & slash commands
├── claude.ts          # Agent SDK query(), streaming input, interrupt/abort
├── discord-output.ts  # Buffered streaming output with collapsible buttons
├── history.ts         # Session listing via SDK listSessions()
└── session.ts         # Per-channel session persistence (sessions.json)
```

## How It Works

1. First message in a channel triggers onboarding — pick a working directory.
2. The bot calls the Agent SDK `query()` with streaming input/output.
3. `DiscordOutput` buffers the stream and edits Discord messages every 1.5s for real-time progress.
4. Thinking, tool calls, and results are shown as compact summaries with expandable detail buttons.
5. Follow-up messages during execution are forwarded via `streamInput()`.
6. Sessions persist to `sessions.json` and can be resumed with `/resume`.

## License

MIT
