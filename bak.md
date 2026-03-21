今天看到一个新闻，claude code 支持channels了。 我就打算搞了钉钉的，这样就可以直接用钉钉远程操作claude code，实现带娃编码了。

## 第一阶段：MCP Channel 方案探索（失败）

最初的设计是将程序作为 MCP Server 插件运行在 Claude Code 内部，通过 MCP 协议将钉钉消息推送给 Claude Code 处理。

### 2.1 方案架构

```
钉钉消息 → MCP Server（本程序）→ MCP 协议推送 → Claude Code 处理 → reply tool → 钉钉回复
```

启动方式：
```bash
claude --dangerously-load-development-channels server:dingtalk
```

配置文件 `.mcp.json`：
```json
{
  "mcpServers": {
    "dingtalk": {
      "command": "bun",
      "args": ["src/index.ts"],
      "env": {
        "DINGTALK_CLIENT_ID": "xxx",
        "DINGTALK_CLIENT_SECRET": "xxx"
      }
    }
  }
}
```

### 2.2 尝试的 MCP 推送方式

| 尝试 | 方法 | 结果 |
|------|------|------|
| ① | `mcp.notification({ method: 'notifications/message' })` | 这是 MCP logging 通知，不是 channel 消息，Claude Code 不处理 |
| ② | `mcp.createMessage()`（sampling 协议） | Claude Code 返回 `MCP error -32601: Method not found` |
| ③ | `mcp.notification({ method: 'notifications/claude/channel' })` | **正确的 method**，notification 发送成功，但 Claude Code 没有调用 reply tool |

### 2.3 Channel 方案失败的根本原因

Claude Code 启动时直接提示：

```
--dangerously-load-development-channels ignored (server:dingtalk)
Channels are not currently available
```

**原因**：Claude Code 的 channels 功能**需要 claude.ai 登录**（官方文档："They require claude.ai login. Console and API key authentication is not supported."）。

当前环境使用的是智谱 GLM 模型（`ANTHROPIC_BASE_URL` 指向 `open.bigmodel.cn`），不是 claude.ai 认证，因此 channels 功能被禁用。

### 2.4 Channel 方案的关键知识点

供后续参考，如果未来使用 claude.ai 登录，Channel 方案的正确实现方式：

- **MCP capabilities** 需声明：`experimental: { 'claude/channel': {} }`
- **推送消息**：`notifications/claude/channel`，params 包含 `content`（消息文本）和 `meta`（元数据，每个 key 成为 `<channel>` 标签属性）
- **接收回复**：注册名为 `reply` 的 tool，Claude Code 处理完后会调用此 tool
- **启动命令**：`claude --dangerously-load-development-channels server:<name>`

---

## 第三阶段：CLI 调用方案（成功）

### 3.1 方案思路

放弃 MCP Channel 协议，改为**独立运行的钉钉机器人**。收到钉钉消息后，通过 `claude -p` CLI 命令调用 Claude Code 处理，再将回复发回钉钉。

### 3.2 架构

```
钉钉用户发消息
    ↓
钉钉 Stream WebSocket（长连接，无需公网 IP）
    ↓
ClaudeTalk 进程接收消息
    ↓
child_process.spawn('claude', ['-p', '--output-format', 'json', '--dangerously-skip-permissions'])
    ↓
stdin 写入消息，stdout 读取 JSON 回复（包含 result 和 session_id）
    ↓
通过 sessionWebhook 将回复发回钉钉
```

### 3.3 关键技术点

**claude -p CLI 调用**：
```bash
# 新会话
echo "你好" | claude -p --output-format json --dangerously-skip-permissions

# 继续已有会话（多轮对话）
echo "继续上面的话题" | claude -p --output-format json --dangerously-skip-permissions --resume <session_id>
```

返回 JSON 格式：
```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "result": "回复内容",
  "session_id": "b68f88f0-8d18-4039-9b75-755d1b79b40c",
  "duration_ms": 7437
}
```

**多轮对话**：每个钉钉 `conversationId` 维护独立的 `session_id`，通过 `--resume` 参数恢复会话上下文。

**消息回复**：优先使用钉钉消息自带的 `sessionWebhook`（直接 POST 即可回复，最简单可靠），降级使用钉钉 API。

**权限问题**：必须加 `--dangerously-skip-permissions`，否则 `claude -p` 在非交互模式下遇到权限提示会返回"请在权限提示中点击允许"而不是实际执行。`--permission-mode auto` 在某些版本下不生效。

### 3.4 遇到的问题

| 问题 | 原因 | 解决 |
|------|------|------|
| Claude 回复"请在权限提示中点击允许" | `claude -p` 非交互模式无法处理权限弹窗 | 加 `--dangerously-skip-permissions` |
| `--permission-mode auto` 不生效 | 可能是 GLM 模型或版本兼容问题 | 改用 `--dangerously-skip-permissions` |

---

## 第四阶段：CLI 工具化

### 4.1 改造目标

将项目从"需要手动 export 环境变量 + bun run"的方式，改为可全局安装的 `claudetalk` 命令。

### 4.2 改造内容

1. **新建 `src/cli.ts`**：CLI 入口，实现配置文件管理（`~/.claudetalk/claudetalk.json`）和交互式引导设置
2. **改造 `src/index.ts`**：从直接运行改为导出 `startBot()` 函数，接受 `clientId`、`clientSecret`、`workDir` 参数
3. **更新 `package.json`**：包名改为 `claudetalk`，`bin` 指向 `dist/cli.js`，构建改为 `tsc`，移除 `@modelcontextprotocol/sdk` 依赖

### 4.3 配置优先级

**环境变量** > **配置文件**（`~/.claudetalk/claudetalk.json`）

首次运行时如果两者都没有，会引导用户交互式输入并保存到配置文件。

### 4.4 安装和使用

```bash
# 安装
git clone https://github.com/suyin58/claude-code-dingtalk-channel.git
cd claude-code-dingtalk-channel
npm install
npm run build
npm link

# 使用（在目标项目目录下运行）
cd /path/to/your/project
claudetalk

# 重新配置
claudetalk --setup
```

---

## 最终文件结构

| 文件 | 说明 |
|------|------|
| `src/cli.ts` | CLI 入口，配置文件管理和引导设置 |
| `src/index.ts` | 核心逻辑，导出 `startBot()`，调用 claude CLI 并回复钉钉 |
| `src/dingtalk.ts` | 钉钉 API 客户端，Stream 连接、消息发送 |
| `src/types.ts` | TypeScript 类型定义 |
| `src/utils.ts` | 工具函数 |
| `package.json` | 包配置，`bin: { claudetalk: dist/cli.js }` |

## 方案对比总结

| 维度 | Channel 方案（失败） | CLI 方案（成功） |
|------|---------------------|-----------------|
| 运行方式 | 作为 MCP Server 插件运行在 Claude Code 内 | 独立进程，通过 CLI 调用 Claude Code |
| 认证要求 | 需要 claude.ai 登录 | 任意认证方式均可 |
| 多轮对话 | Channel 协议自带上下文 | 通过 `--resume session_id` 实现 |
| 复杂度 | 需要理解 MCP 协议和 Channel 规范 | 简单的 stdin/stdout 交互 |
| 稳定性 | 实验性功能，限制多 | 稳定，直接调用 CLI |
