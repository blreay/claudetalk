# DingTalk Webhook 机器人设计

## 概述

为现有 DingTalk channel 增加 webhook 类型机器人支持，作为 DingTalkClient 的附属输入/输出模块。启动时同时初始化 websocket 长连接和 HTTP webhook server，两个通道共享同一个 Claude session。

**核心需求：**
- claudetalk 启动 HTTP server 接收钉钉自定义机器人 outgoing 回调
- 收到的消息通过 callClaude 处理（与 websocket 通道共享 session）
- Claude 执行过程中的 stream-json 事件和最终结果，通过钉钉 webhook URL POST 推送
- 流式输出逻辑（/thinking on/off 等）与 websocket 通道共用同一套配置

## 配置结构

### `.claudetalk.json` 示例

```json
{
  "profiles": {
    "pm": {
      "channel": "dingtalk",
      "dingtalk": {
        "DINGTALK_CLIENT_ID": "xxx",
        "DINGTALK_CLIENT_SECRET": "xxx"
      },
      "webhook": {
        "webhookUrls": [
          "https://oapi.dingtalk.com/robot/send?access_token=xxx"
        ],
        "webhookSecret": "SECxxxxxxxxxx",
        "listenAddress": "0.0.0.0:40000",
        "publicUrl": "https://btt-xxxx.honmeirin.alipay.com/dingtalk-channel/message"
      },
      "systemPrompt": "你是产品经理"
    }
  }
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `webhookUrls` | `string[]` | 钉钉群聊机器人 webhook URL 列表（setup 时逗号分隔输入） |
| `webhookSecret` | `string` | 钉钉机器人加签密钥 |
| `listenAddress` | `string` | 本机 HTTP server 监听地址，格式 `IP:端口` |
| `publicUrl` | `string` | 自动生成的公网访问 URL（domain 生成后自动填入） |

### TypeScript 类型

```typescript
interface WebhookConfig {
  webhookUrls: string[]
  webhookSecret: string
  listenAddress: string
  publicUrl?: string
}

// ProfileConfig 增加字段
interface ProfileConfig {
  // ...existing fields
  webhook?: WebhookConfig
}
```

## 模块拆分

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/channels/dingtalk/webhook-server.ts` | HTTP server：启停、接收钉钉 outgoing 回调、解析请求体、调用 channelMessageHandler |
| `src/channels/dingtalk/webhook-client.ts` | 向钉钉 webhook URL POST 消息：HMAC-SHA256 签名、构造请求体、多 URL 并行发送 |
| `src/core/domain.ts` | 公网 URL 生成：Blowfish ECB 加密 + Base32 编码，从 generate-domain.sh 移植 |

### DingTalkClient 改动

- `constructor`: 如果配置了 `webhook`，创建 `WebhookServer` + `WebhookClient` 实例
- `start()`: 调用 `webhookServer.start()` 启动 HTTP server
- `stop()`: 调用 `webhookServer.stop()` 关闭 server
- `sendMessage()`: 发送后额外调用 `webhookClient.postToWebhooks(content)`

## 数据流

### 输入方向（接收 outgoing 回调）

```
钉钉自定义机器人 outgoing 回调
  → HTTP POST to listenAddress
  → WebhookServer 解析 body（DingTalkInboundCallback 格式）
  → 提取 text.content, conversationId, senderId
  → 构造 ChannelMessageContext
  → 调用 DingTalkClient.channelMessageHandler(context, messageText)
  → 复用完全相同的消息处理链（callClaude → stream-json → onProgress → sendMessage）
```

### 输出方向（推送到 webhook）

```
callClaude 的 onProgress 回调 / 最终结果
  → DingTalkClient.sendMessage(conversationId, content, isGroup)
      → 现有逻辑：通过钉钉 API 回复（websocket 通道）
      → 新增：WebhookClient.postToWebhooks(content)
          → 计算 timestamp + HMAC-SHA256 签名
          → 构造 { msgtype: "text", text: { content } }
          → 对每个 webhookUrl 并行 POST（Promise.allSettled）
```

### Session 共享

无需改动。同一个 DingTalkClient 实例 = 同一个 profile，session key 四维度（`conversationId|workDir|profile|channel`）完全一致。Webhook server 收到的消息如果 conversationId 与 websocket 群相同，自然命中同一个 session。

## Setup 流程

在现有钉钉 channel 配置步骤（configFields）完成后、SubAgent 配置之前，插入 webhook 配置环节。重新运行 setup 时从 `existingProfile.webhook` 读取现有值作为默认值回显。

```
📡 Webhook 机器人配置（可选）

是否配置 webhook 机器人？(y/N) [y]:                    ← 已配置过则默认 y
webhook URL (多个用逗号分隔) [https://oapi...token]:   ← 回显现有值
webhook 加签密钥 [SEC****]:                             ← secret 类型只显示前4位
本机监听地址 [0.0.0.0:40000]:                          ← 回显现有值

🔗 正在生成公网访问地址...
✅ 公网地址: https://btt-xxxx.honmeirin.alipay.com/dingtalk-channel/message
⚠️  请保存此地址，配置钉钉自定义机器人时需要用到！
```

每个字段逻辑：
- 用户直接回车 → 保留现有值
- 用户输入新值 → 覆盖
- secret 字段回显时只显示前 4 位 + `****`

## webhook-client.ts 签名逻辑

从 shell 脚本移植为纯 JS 实现：

```typescript
import crypto from 'crypto'

function signWebhookRequest(secret: string): { timestamp: string; sign: string } {
  const timestamp = Date.now().toString()
  const stringToSign = `${timestamp}\n${secret}`
  const hmac = crypto.createHmac('sha256', secret).update(stringToSign).digest('base64')
  const sign = encodeURIComponent(hmac)
  return { timestamp, sign }
}

async function postToWebhook(webhookUrl: string, content: string, secret: string): Promise<void> {
  const { timestamp, sign } = signWebhookRequest(secret)
  const url = `${webhookUrl}&timestamp=${timestamp}&sign=${sign}`
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content } }),
    signal: AbortSignal.timeout(10000),
  })
}
```

## domain.ts 公网 URL 生成

从 `~/work/mychain/generate-domain.sh` 内联 Node.js 脚本移植：

```typescript
import { Blowfish } from 'egoroof-blowfish'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const DEFAULT_SECRET = '_HonMeirinHello_'

function encodeBase32(buf: Buffer): string {
  let bits = 0, value = 0, out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out.toLowerCase()
}

export function generatePublicUrl(port: number, ip?: string): string {
  const hostIp = ip ?? detectLocalIp()
  const upstream = `${hostIp}:${port}`
  const bf = new Blowfish(DEFAULT_SECRET, Blowfish.MODE.ECB, Blowfish.PADDING.SPACES)
  const encoded = Buffer.from(bf.encode(upstream))
  const domain = `btt-${encodeBase32(encoded)}`
  return `https://${domain}.honmeirin.alipay.com`
}
```

依赖 `egoroof-blowfish` 添加到 `package.json`。

## 错误处理

### Webhook Server

| 场景 | 处理方式 |
|------|----------|
| POST body 解析失败（非 JSON / 缺字段） | 返回 400，日志记录，不调 callClaude |
| `text.content` 为空 | 返回 200（静默忽略） |
| callClaude 执行异常 | 捕获错误，返回 500，通过 webhook POST 错误提示 |
| 端口被占用 | 启动时报错日志，不影响 websocket 通道 |

### Webhook Client

| 场景 | 处理方式 |
|------|----------|
| 某个 URL POST 失败 | 日志记录，不影响其他 URL（`Promise.allSettled`） |
| 网络超时 | 单次 POST 10s 超时后放弃 |
| secret 为空 | POST 时不带签名参数 |

### 配置不完整的启动行为

- `webhook.listenAddress` 或 `webhook.webhookUrls` 为空 → 不启动 webhook server，只走 websocket
- 日志输出警告提示

### Domain 生成容错

- `egoroof-blowfish` 不可用 → setup 报错提示安装
- IP 检测失败 → fallback `127.0.0.1`，提示用户手动指定

## 技术选型

| 需求 | 选型 | 理由 |
|------|------|------|
| HTTP server | `http.createServer` | 零依赖，功能足够 |
| HMAC-SHA256 签名 | `crypto` 模块 | Node.js 内置 |
| HTTP POST | `fetch` | Node 18+ / Bun 内置 |
| Blowfish 加密 | `egoroof-blowfish` | generate-domain.sh 已使用，添加为 package.json 依赖 |
| Base32 编码 | 自实现 | 20 行代码，无需额外依赖 |

不引入 Express、Koa 等框架。
