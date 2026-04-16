# cc-remote

一个 Discord 机器人，让你通过 Discord 频道远程使用 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)。

每个 Discord 频道维护独立的 Claude Code 会话，支持完整对话上下文、流式输出和工具调用展示。

## 功能

- 按频道隔离的 Claude Code 会话，支持上下文持久化（`--resume`）
- 流式输出，实时编辑 Discord 消息
- 工具调用展示（Bash、Read、Edit、Write、Grep、Glob 等）
- Thinking 块渲染
- 每次响应后显示费用 / 耗时 / 轮次统计
- 用户白名单访问控制
- SIGINT/SIGTERM 优雅关闭

## 前置要求

- Node.js 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 已安装并完成认证
- Discord 机器人 Token（[Discord 开发者门户](https://discord.com/developers/applications)）

## 安装

1. 克隆仓库并安装依赖：

```bash
git clone <repo-url>
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
# 开发模式
npm run dev

# 生产模式
npm run build && npm start
```

## 机器人命令

| 命令 | 说明 |
|------|------|
| `!reset` | 清除会话和对话上下文 |
| `!cd <路径>` | 切换工作目录（同时重置会话） |
| `!pwd` | 查看当前工作目录 |
| `!status` | 列出所有活跃会话 |
| `!ls [参数]` | 列出目录内容 |

其他任何消息都会作为 prompt 直接发送给 Claude Code。

## 项目结构

```
src/
├── index.ts           # 入口，登录与关闭处理
├── config.ts          # 环境变量加载
├── bot.ts             # Discord 消息处理与命令路由
├── claude.ts          # Claude Code CLI 进程管理与流解析
├── discord-output.ts  # 缓冲流式输出到 Discord
└── session.ts         # 按频道的会话持久化（sessions.json）
```

## 工作原理

1. 频道内首条消息触发引导流程 — 选择工作目录。
2. 机器人通过 `--session-id`（新会话）或 `--resume`（已有会话）启动 `claude` CLI，以 JSON 流式输出。
3. `DiscordOutput` 缓冲输出流，每 1.5 秒编辑 Discord 消息以展示实时进度。
4. 会话信息持久化到 `sessions.json`，重启后自动恢复。

## 许可证

MIT
