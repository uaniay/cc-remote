# cc-remote

一个 Discord 机器人，让你通过 Discord 频道远程使用 [Claude Code](https://code.claude.com)，基于官方 [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) 构建。

每个 Discord 频道维护独立的 Claude Code 会话，支持双向流式通信、实时 token 输出和可折叠的工具调用详情。

## 功能

- **Agent SDK 集成** — 使用 `@anthropic-ai/claude-agent-sdk` 实现完整的编程控制
- **双向流式通信** — Claude 工作时可发送后续消息（btw）
- **实时 token 流式输出** — 每 1.5 秒编辑消息实现打字机效果
- **可折叠详情** — thinking、工具调用和结果以紧凑摘要展示，支持展开按钮
- **斜杠命令** — `/clear`、`/status`、`/abort`、`/resume`、`/mode`
- **权限模式切换** — plan、acceptEdits、auto、default、bypassPermissions
- **会话恢复** — 列出并恢复历史 Claude Code 会话
- **Shell 命令** — `!` 前缀执行任意 shell 命令
- **CLI 子命令** — `cc` 前缀管理 Claude CLI（mcp、plugin、agents 等）
- **并发控制** — 可配置的全局 Claude 进程并发上限
- **优雅关闭** — SIGINT/SIGTERM 清理子进程

## 前置要求

- Node.js 18+
- [Claude Code CLI](https://code.claude.com/docs/en/setup) 已安装并完成认证
- Discord 机器人 Token（[Discord 开发者门户](https://discord.com/developers/applications)）

## 安装

1. 克隆仓库并安装依赖：

```bash
git clone https://github.com/uaniay/cc-remote.git
cd cc-remote
npm install
```

2. 创建 `.env` 文件：

```env
DISCORD_TOKEN=你的_discord_bot_token
ALLOWED_USER_IDS=123456789,987654321
CC_WORKING_DIR=/default/working/dir    # 可选，默认为当前目录
CC_MODEL=sonnet                         # 可选，指定 Claude 模型
MAX_CONCURRENT_CLAUDE=3                 # 可选，默认 3
SHELL_TIMEOUT=30000                     # 可选，默认 30 秒
```

3. 运行：

```bash
npm run dev          # 开发模式（tsx）
npm run build && npm start  # 生产模式
```

4. 部署为后台服务（pm2）：

```bash
npm install -g pm2
npm run build
pm2 start dist/index.js --name cc-remote --cwd /home/uania/repos/cc-remote
pm2 startup && pm2 save   # 开机自启
```

pm2 常用命令：

```bash
pm2 logs cc-remote       # 查看日志
pm2 restart cc-remote    # 重启
pm2 stop cc-remote       # 停止
pm2 status               # 查看状态
```

代码更新后重启：

```bash
git pull && npm install && npm run build && pm2 restart cc-remote
```

## 命令

### 斜杠命令

| 命令 | 说明 |
|------|------|
| `/clear` | 清除会话和对话上下文 |
| `/status` | 查看当前会话信息（ID、目录、模型） |
| `/abort` | 中断正在运行的 Claude 进程 |
| `/resume [number]` | 列出或恢复历史会话 |
| `/mode <mode>` | 切换权限模式（plan、acceptEdits、auto、default、bypassPermissions） |

### 文本命令

| 前缀 | 说明 | 示例 |
|------|------|------|
| `!` | 执行 shell 命令 | `!ls -la`、`!git status` |
| `!cd <路径>` | 切换工作目录 | `!cd /home/user/project` |
| `cc` | 运行 Claude CLI 子命令 | `cc mcp list`、`cc plugin list` |
| *（纯文本）* | 发送 prompt 给 Claude | 直接输入消息即可 |

Claude 忙碌时，新消息会作为后续输入转发给正在运行的会话。

## 项目结构

```
src/
├── index.ts           # 入口，登录与优雅关闭
├── config.ts          # 环境变量加载
├── bot.ts             # Discord 消息/交互处理与斜杠命令
├── claude.ts          # Agent SDK query()、流式输入、中断/终止
├── discord-output.ts  # 缓冲流式输出，支持可折叠按钮
├── history.ts         # 通过 SDK listSessions() 列出会话
└── session.ts         # 按频道的会话持久化（sessions.json）
```

## 工作原理

1. 频道内首条消息触发引导流程 — 选择工作目录。
2. 机器人调用 Agent SDK `query()` 进行流式输入/输出。
3. `DiscordOutput` 缓冲输出流，每 1.5 秒编辑 Discord 消息以展示实时进度。
4. Thinking、工具调用和结果以紧凑摘要展示，支持展开详情按钮。
5. 执行期间的后续消息通过 `streamInput()` 转发。
6. 会话持久化到 `sessions.json`，可通过 `/resume` 恢复。

## 许可证

MIT
