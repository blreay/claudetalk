# ClaudeTalk 使用指南

> 通过钉钉或飞书机器人与 Claude Code/CodeFuse CLI 对话，支持多轮会话和 Multi-Agent 协作。

---

## 目录

1. [背景和目标](#背景和目标)
2. [环境依赖](#环境依赖)
3. [安装步骤](#安装步骤)
4. [工作原理](#工作原理)
5. [详细使用说明](#详细使用说明)
6. [注意事项](#注意事项)

---

## 背景和目标

### 为什么要做 ClaudeTalk

Claude Code 是一个强大的 AI 编程助手，但它原生只支持终端交互。在实际团队协作中，我们希望：

1. **随时随地使用** - 不在电脑前也能通过手机与 Claude Code 对话
2. **团队协作** - 团队成员可以共享 AI 助手，讨论问题和解决方案
3. **多角色协作** - 不同场景需要不同的 AI 角色（产品经理、前端开发、架构师等）
4. **人机协作** - AI 之间可以互相协作，人类可以随时介入和干预

### 核心功能

- **多 IM 平台支持** - 支持飞书、钉钉（推荐飞书）
- **多轮会话** - 支持上下文连续对话，重启后自动恢复
- **多 Agent 协作** - 多个机器人可以在同一个群里协作完成任务
- **多模态交互** - 支持图片、文件分析（飞书）
- **精细化权限控制** - 通过 SubAgent 机制控制不同角色的工具权限
- **无需公网 IP** - 使用 WebSocket 长连接接收消息

---

## 环境依赖

### 必需环境

| 依赖 | 版本要求 | 说明 |
|------|---------|------|
| Node.js | >= 18（推荐 v20+） | JavaScript 运行时 |
| Claude Code CLI | 最新版 | 或 CodeFuse CLI |

### 可选环境

| 依赖 | 说明 |
|------|------|
| Bun | 更快的 JavaScript 运行时，用于开发模式 |

### IM 平台账号要求

| 平台 | 要求 |
|------|------|
| 飞书 | 企业管理员权限（用于审批应用权限） |
| 钉钉 | 企业管理员权限（用于创建企业内部应用） |

---

## 安装步骤

### 1. 安装 Claude Code CLI

```bash
# 安装 Claude Code CLI
npm install -g @anthropic-ai/claude-code

# 或使用 CodeFuse CLI（国内用户推荐）
# 参考 CodeFuse 官方文档安装
```

安装完成后，确保 `claude` 或 `cfuse` 命令可用：

```bash
claude --version
# 或
cfuse --version
```

### 2. 克隆并构建 ClaudeTalk

```bash
# 1. 克隆仓库
git clone https://github.com/suyin58/claudetalk.git

# 2. 进入目录
cd claudetalk

# 3. 安装依赖
npm install

# 4. 构建项目
npm run build

# 5. 全局安装（注册 claudetalk 命令）
npm link
```

安装完成后，终端中即可使用 `claudetalk` 命令。

**卸载命令**（如需要）：

```bash
npm uninstall -g claudetalk
```

### 3. 配置 IM 平台机器人

选择你需要的平台配置机器人：

- **飞书机器人配置** - 参见 [README_feishu.md](../README_feishu.md)（**推荐**）
- **钉钉机器人配置** - 参见 [README_dingtalk.md](../README_dingtalk.md)

#### 飞书机器人配置要点

1. 访问 [飞书开放平台](https://open.feishu.cn) 创建企业自建应用
2. 启用「机器人」能力
3. 开启「使用长连接接收事件」
4. 订阅 `im.message.receive_v1` 事件
5. 申请以下权限：
   - `im:message` - 发送和接收消息
   - `im:message.group_at_msg:readonly` - 群聊 @ 机器人必需
   - `im:message.group_msg` - 获取群聊历史消息
   - `im:chat.members:read` - 查看群成员列表
   - `contact:contact.base:readonly` - 获取群成员真实姓名

#### 钉钉机器人配置要点

1. 访问 [钉钉开放平台](https://open-dev.dingtalk.com) 创建企业内部应用
2. 启用「机器人」能力
3. 配置消息接收模式为「Stream 模式」
4. 获取 AppKey 和 AppSecret

### 4. 配置 ClaudeTalk

在你的项目目录下运行配置向导：

```bash
cd /path/to/your/project
claudetalk --setup
```

配置向导会引导你：
1. 选择消息通道（飞书/钉钉）
2. 输入 App ID/Secret 或 AppKey/AppSecret
3. 设置角色描述（systemPrompt）
4. 选择是否启用 SubAgent

#### 选择 Claude 引擎

ClaudeTalk 支持三种引擎：

```bash
# 使用原生 Claude Code（默认）
claudetalk --setcc claude

# 使用 CodeFuse CLI（不带 --cc 参数）
claudetalk --setcc codefuse

# 使用 CodeFuse CLI（带 --cc 参数）
claudetalk --setcc codefuse-cc
```

### 5. 启动机器人

```bash
# 启动所有配置的角色
claudetalk

# 或只启动指定角色
claudetalk --profile <角色名>
```

---

## 工作原理

### 架构概述

```
┌─────────────────────────────────────────────────────────────────┐
│                         ClaudeTalk                              │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐        │
│  │   飞书      │    │    钉钉     │    │   Discord   │  ...   │
│  │  Channel    │    │   Channel   │    │   Channel   │        │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘        │
│         │                  │                  │               │
│         └──────────────────┼──────────────────┘                │
│                            ▼                                  │
│                   ┌─────────────────┐                         │
│                   │   消息路由器    │                         │
│                   └────────┬────────┘                         │
│                            ▼                                  │
│                   ┌─────────────────┐                         │
│                   │  Session 管理器  │                         │
│                   └────────┬────────┘                         │
│                            ▼                                  │
│                   ┌─────────────────┐                         │
│                   │   Claude CLI    │                         │
│                   │  (claude/cfuse) │                         │
│                   └─────────────────┘                         │
└─────────────────────────────────────────────────────────────────┘
```

### 数据流

```
用户在 IM 发消息
    ↓
Channel WebSocket 长连接接收（无需公网 IP）
    ↓
ClaudeTalk 接收消息 → 解析消息类型（文字/图片/文件）
    ↓
Session 管理器查找/创建会话
    ↓
调用 claude/cfuse -p CLI 处理（支持多轮会话）
    ↓
通过对应 Channel 回复消息
```

### 核心组件

| 组件 | 职责 |
|------|------|
| Channel | 处理 IM 平台特定的消息接收和发送 |
| Session 管理器 | 维护 Claude Code 会话，支持多轮对话和重启恢复 |
| SubAgent 管理器 | 处理多角色配置和权限控制 |
| Peer Message | 实现机器人间的协作通信 |

### Session 管理机制

每个会话通过 `conversationId|workDir|profile|channel` 唯一标识：

```typescript
interface SessionEntry {
  sessionId: string      // Claude Code 的 session_id
  lastActiveAt: number     // 最后活跃时间
  isGroup: boolean         // 是否群聊
  conversationId: string   // 会话 ID
  userId: string          // 用户 ID
  subagentEnabled: boolean // 是否启用 SubAgent
  channel: ChannelType    // 消息通道类型
}
```

Session 持久化存储在 `.claudetalk-sessions.json`，重启后自动恢复。

### 多 Agent 协作机制

当多个机器人运行在同一台机器上时，通过共享文件实现协作：

```
用户 @ PM 机器人
    ↓
PM 机器人处理 → 回复中 @ 前端开发机器人
    ↓
消息写入 .claudetalk/feishu/bot_front.json
    ↓（10秒后）
前端开发机器人轮询到消息
    ↓
处理并回复到飞书群
```

---

## 详细使用说明

### 命令参考

```bash
# 启动机器人（自动启动配置中的所有角色）
claudetalk

# 只启动指定角色的机器人
claudetalk --profile <角色名>

# 配置当前目录默认角色（交互式）
claudetalk --setup

# 配置当前目录指定角色（交互式）
claudetalk --setup --profile <角色名>

# 批量自动配置多个角色
claudetalk --setup auto

# 编辑已有角色配置
claudetalk --setup edit

# 设置 Claude 引擎
claudetalk --setcc <claude|codefuse|codefuse-cc>

# 查看帮助
claudetalk --help
```

### 聊天指令

在对话中发送以下指令管理会话：

| 指令 | 说明 |
|------|------|
| `新会话` 或 `/new` | 清空当前会话记忆，开启全新对话 |
| `清空记忆` 或 `/reset` | 同上 |
| `帮助` 或 `/help` | 显示指令帮助信息 |

### 多角色配置

在同一工作目录下配置多个角色：

```bash
# 配置 PM 角色
claudetalk --setup --profile pm

# 配置开发角色
claudetalk --setup --profile dev
```

配置示例（`.claudetalk.json`）：

```json
{
  "profiles": {
    "pm": {
      "channel": "feishu",
      "feishu": {
        "FEISHU_APP_ID": "cli_xxx",
        "FEISHU_APP_SECRET": "xxx"
      },
      "systemPrompt": "你是产品经理，负责需求分析",
      "subagentEnabled": true,
      "subagentModel": "claude-haiku-4-5"
    },
    "dev": {
      "channel": "feishu",
      "feishu": {
        "FEISHU_APP_ID": "cli_yyy",
        "FEISHU_APP_SECRET": "yyy"
      },
      "systemPrompt": "你是全栈工程师，擅长代码实现",
      "ccEngine": "codefuse-cc",
      "subagentEnabled": true,
      "subagentModel": "claude-sonnet-4-5"
    }
  }
}
```

启动所有角色：

```bash
claudetalk
```

### SubAgent 精细化控制

SubAgent 相比 systemPrompt 的优势：

1. **独立上下文窗口** - 不占用主会话 token
2. **指定模型** - 不同角色可用不同模型（如 PM 用 Haiku，Dev 用 Sonnet）
3. **精细权限控制** - 在工具调用层面拦截，不是靠 prompt 约束

启用方式：

```bash
claudetalk --setup --profile <角色名>
# 在 SubAgent 配置引导中选择 Y
```

生成的 SubAgent 文件（`.claude/agents/{profile}.md`）：

```markdown
---
name: "dev"
description: "开发工程师角色"
model: "claude-sonnet-4-5"
permissions:
  allow:
    - "Read(./**)"
    - "Edit(./src/**)"
  deny:
    - "Bash(npm publish)"
---

你是全栈工程师，专注技术实现，确保代码质量。
```

### 多模态交互（飞书）

支持的消息类型：

| 消息类型 | 支持情况 | 说明 |
|---------|---------|------|
| 文字消息 | ✅ | 基础功能 |
| 图片消息 | ✅（飞书） | 下载到本地，Claude 自动读取分析 |
| 文件消息 | ✅（飞书） | txt/pdf/代码等，保留原始文件名 |
| 富文本 | ✅（飞书） | 文字+图片混排 |
| 语音/视频 | ❌ | 回复"暂不支持" |

**纯图片/文件消息处理**：

用户只发图片（不带文字）时：

```
用户：[发了一张图片]
机器人：📎 已收到（共 1 个文件/图片），请继续发送指令。

用户：帮我分析这张图
机器人：[Claude 分析图片并回复]
```

### 机器人间协作

在飞书群中，机器人可以 @ 其他机器人：

```
用户：@PM机器人 帮我整理这个需求

PM机器人：需求整理如下：...
       <at user_id="cli_xxx">前端开发</at> 请评估前端工作量

[前端开发机器人收到协作消息，自动回复]

前端开发机器人：👌 收到，前端工作量评估如下：...
```

---

## 注意事项

### 平台选择建议

> ⚠️ **强烈推荐使用飞书**，钉钉存在以下问题：

| 问题 | 说明 |
|------|------|
| 消息推送不稳定 | 多个机器人实例同时运行时经常出现消息丢失 |
| 无法接收多媒体 | 不支持图片、文件消息 |
| 无历史消息 API | 无法拉取群聊上下文 |
| 协作能力受限 | 多 Agent 协作场景下可靠性差 |

### 安全注意事项

1. **配置文件保护** - `.claudetalk.json` 包含敏感凭据，不要提交到 Git
2. **权限控制** - 使用 SubAgent 的 `deny` 规则限制危险操作（如 `rm -rf`、`npm publish`）
3. **白名单机制** - 生产环境建议配置 `allowFrom` 白名单限制可访问用户

### 性能注意事项

1. **Session 缓存** - 每个会话占用内存，长期运行的机器人建议定期清理旧 session
2. **图片缓存** - 飞书图片下载后缓存在 `.claudetalk/feishu/images/`，可按需清理
3. **启动间隔** - 多角色启动时默认间隔 1 秒，避免触发平台限流

### 常见问题

**Q: 机器人收不到消息？**

- 检查是否正确订阅了 `im.message.receive_v1` 事件（飞书）
- 检查是否开启了 Stream 模式（钉钉）
- 检查权限是否已审批通过

**Q: 如何切换工作目录？**

```bash
cd /path/to/new/project
claudetalk
```

Claude Code 的 session 与工作目录绑定，切换目录后会开启新会话。

**Q: 如何清除会话记忆？**

在对话中发送：`新会话` 或 `/new`

**Q: 多机器人群聊中如何隔离？**

每个机器人需要在同一个群里，通过共享工作目录的 `.claudetalk/` 文件夹实现协作。

### 配置文件目录结构

```
workDir/
├── .claudetalk.json                 # 主配置文件
├── .claudetalk-sessions.json        # Session 持久化
└── .claudetalk/
    ├── feishu/
    │   ├── chat-members.json        # 群成员信息
    │   ├── images/                  # 图片缓存
    │   ├── files/                   # 文件缓存
    │   └── bot_{profile}.json       # 协作消息队列
    └── dingtalk/
        ├── chat-members.json
        └── bot_{profile}.json
└── .claude/
    └── agents/
        └── {profile}.md             # SubAgent 定义
```

---

## 相关文档

- [ClaudeTalk GitHub](https://github.com/suyin58/claudetalk)
- [飞书开放平台](https://open.feishu.cn)
- [钉钉开放平台](https://open-dev.dingtalk.com)
- [Claude Code 文档](https://docs.anthropic.com/en/docs/claude-code)

---

## License

MIT
