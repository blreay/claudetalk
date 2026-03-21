# Claude Code DingTalk Channel

钉钉企业内部机器人 Channel插件，使用 Stream 模式(无需公网 IP)。

## 功能特性
- Stream 模式 - WebSocket 长连接,无需公网 IP
- 私聊支持 - 直接与机器人对话
- 群聊支持 - 在群里 @机器人
- Markdown 回复 - 支持富文本格式
- 安全机制 - 发送者白名单
- 配对码验证

## 安装

```bash
# 安装 Bun (如果还没有安装)
curl -fsSL https://bun.sh/install | bash
bun --version
```

# 或克隆仓库
git clone https://github.com/suyin58/claude-code-dingtalk-channel.git
cd /Users/suyin/Documents/WorkSpace/skills/claude-code-dingtalk-channel
bun install
```

# 构建
bun run build
```

# 运行
bun run src/index.ts
```

# 测试
bun test
```

# 类型检查
bun run type-check
```

## 使用方法

1. 启动 Claude Code 时使用 `--dangerously-load-development-channels` 标志

```bash
claude --dangerously-load-development-channels
```
2. 在 Claude Code 中输入 `/pair <conversationId>` 查看配对码
3. 批准后 Claude 会回复一个 6 位配对码
4. 在钉钉中与机器人对话时, 回复会出现在聊天中
5. 可选配置 AI 互动卡片模式

6. 输入配置参数
```bash
# 设置环境变量
export DINGTALK_CLIENT_ID=your_dingtalk_app_key
export DINGTALK_CLIENT_SECRET=your_dingtalk_app_secret
# 钉钉 Stream 连接地址 (可选)
export DINGTALK_STREAM_URL=${process.env.DINGTALK_STREAM_URL || 'wss://dingtalk-stream.dingtalk.com/connect'
```
