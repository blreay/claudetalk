# DingTalk Webhook Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add webhook bot support as an attached module to the DingTalk channel — a local HTTP server receives outgoing callbacks, processes them through callClaude (sharing the same session), and pushes stream-json events to DingTalk webhook URLs with HMAC-SHA256 signatures.

**Architecture:** Three new modules (`webhook-server.ts`, `webhook-client.ts`, `domain.ts`) are composed by `DingTalkClient`. The HTTP server receives POST requests in DingTalk outgoing callback format, routes them through the existing `channelMessageHandler`. On output, `sendMessage()` additionally pushes content to configured webhook URLs with signed requests.

**Tech Stack:** Node.js `http` module (server), `crypto` (HMAC), native `fetch` (POST), `egoroof-blowfish` (domain generation)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/core/domain.ts` | Create | Public URL generation (Blowfish + Base32) |
| `src/channels/dingtalk/webhook-client.ts` | Create | Sign and POST messages to DingTalk webhook URLs |
| `src/channels/dingtalk/webhook-server.ts` | Create | HTTP server receiving outgoing callbacks |
| `src/types.ts` | Modify | Add `WebhookConfig` interface to `ProfileConfig` |
| `src/channels/dingtalk/index_dingtalk.ts` | Modify | Integrate webhook modules into DingTalkClient |
| `src/cli.ts` | Modify | Add webhook setup wizard after channel config |
| `package.json` | Modify | Add `egoroof-blowfish` dependency |

---

### Task 1: Add `egoroof-blowfish` Dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the dependency**

Run:
```bash
cd /home/admin/git/claudetalk && npm install egoroof-blowfish
```

Expected: `package.json` updated with `"egoroof-blowfish": "^X.Y.Z"` in `dependencies`, `node_modules` updated.

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add egoroof-blowfish for webhook domain generation"
```

---

### Task 2: Add `WebhookConfig` Type

**Files:**
- Modify: `src/types.ts:392-416`

- [ ] **Step 1: Add the WebhookConfig interface**

Add the following after `DiscordProfileConfig` (after line 389) and before `ProfileConfig`:

```typescript
/** Webhook 机器人配置（DingTalk channel 附属） */
export interface WebhookConfig {
  /** 钉钉群聊机器人 webhook URL 列表 */
  webhookUrls: string[]
  /** 钉钉机器人加签密钥 */
  webhookSecret: string
  /** 本机 HTTP server 监听地址，格式 IP:端口 */
  listenAddress: string
  /** 自动生成的公网访问 URL */
  publicUrl?: string
}
```

- [ ] **Step 2: Add `webhook` field to `ProfileConfig`**

In the `ProfileConfig` interface (around line 392), add after the `discord?` field:

```typescript
  /** Webhook 机器人配置 */
  webhook?: WebhookConfig
```

- [ ] **Step 3: Verify type check passes**

Run:
```bash
cd /home/admin/git/claudetalk && npm run type-check
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add WebhookConfig interface"
```

---

### Task 3: Implement `src/core/domain.ts`

**Files:**
- Create: `src/core/domain.ts`

- [ ] **Step 1: Create domain.ts**

```typescript
import { execSync } from 'child_process'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const DEFAULT_SECRET = '_HonMeirinHello_'

function encodeBase32(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
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

function detectLocalIp(): string {
  try {
    const output = execSync('hostname -I', { encoding: 'utf-8' }).trim()
    const ip = output.split(/\s+/)[0]
    if (ip) return ip
  } catch {}
  if (process.env.INSTANCE_IP) return process.env.INSTANCE_IP
  return '127.0.0.1'
}

export async function generatePublicUrl(port: number, ip?: string): Promise<string> {
  const { Blowfish } = await import('egoroof-blowfish')

  const hostIp = ip ?? detectLocalIp()
  const upstream = `${hostIp}:${port}`

  const bf = new Blowfish(DEFAULT_SECRET, Blowfish.MODE.ECB, Blowfish.PADDING.SPACES)
  const encoded = Buffer.from(bf.encode(upstream))
  const domain = `btt-${encodeBase32(encoded)}`
  return `https://${domain}.honmeirin.alipay.com`
}
```

- [ ] **Step 2: Verify type check passes**

Run:
```bash
cd /home/admin/git/claudetalk && npm run type-check
```

Expected: No errors (may need to add `egoroof-blowfish` type declaration — see step 3).

- [ ] **Step 3: Add type declaration if needed**

If type-check fails because `egoroof-blowfish` has no types, create `src/core/egoroof-blowfish.d.ts`:

```typescript
declare module 'egoroof-blowfish' {
  export class Blowfish {
    static MODE: { ECB: number; CBC: number }
    static PADDING: { SPACES: number; NULL: number; PKCS5: number }
    constructor(key: string, mode: number, padding: number)
    encode(data: string): Uint8Array
    decode(data: Uint8Array): string
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/core/domain.ts src/core/egoroof-blowfish.d.ts
git commit -m "feat(core): add public URL generation (domain.ts)"
```

---

### Task 4: Implement `src/channels/dingtalk/webhook-client.ts`

**Files:**
- Create: `src/channels/dingtalk/webhook-client.ts`

- [ ] **Step 1: Create webhook-client.ts**

```typescript
import crypto from 'crypto'

export interface WebhookClientConfig {
  webhookUrls: string[]
  webhookSecret: string
}

function signRequest(secret: string): { timestamp: string; sign: string } {
  const timestamp = Date.now().toString()
  const stringToSign = `${timestamp}\n${secret}`
  const hmac = crypto.createHmac('sha256', secret).update(stringToSign).digest('base64')
  const sign = encodeURIComponent(hmac)
  return { timestamp, sign }
}

export class WebhookClient {
  private readonly webhookUrls: string[]
  private readonly webhookSecret: string
  private readonly logger: (msg: string) => void

  constructor(config: WebhookClientConfig, logger: (msg: string) => void) {
    this.webhookUrls = config.webhookUrls
    this.webhookSecret = config.webhookSecret
    this.logger = logger
  }

  async postToWebhooks(content: string): Promise<void> {
    if (this.webhookUrls.length === 0) return

    const results = await Promise.allSettled(
      this.webhookUrls.map((url) => this.postToSingleWebhook(url, content))
    )

    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'rejected') {
        this.logger(`[WebhookClient] POST to webhook[${i}] failed: ${result.reason}`)
      }
    }
  }

  private async postToSingleWebhook(webhookUrl: string, content: string): Promise<void> {
    let url = webhookUrl
    if (this.webhookSecret) {
      const { timestamp, sign } = signRequest(this.webhookSecret)
      const separator = webhookUrl.includes('?') ? '&' : '?'
      url = `${webhookUrl}${separator}timestamp=${timestamp}&sign=${sign}`
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content } }),
      signal: AbortSignal.timeout(10000),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status}: ${body}`)
    }
  }
}
```

- [ ] **Step 2: Verify type check passes**

Run:
```bash
cd /home/admin/git/claudetalk && npm run type-check
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/channels/dingtalk/webhook-client.ts
git commit -m "feat(dingtalk): add webhook-client for signed POST to DingTalk webhooks"
```

---

### Task 5: Implement `src/channels/dingtalk/webhook-server.ts`

**Files:**
- Create: `src/channels/dingtalk/webhook-server.ts`

- [ ] **Step 1: Create webhook-server.ts**

```typescript
import http from 'http'
import type { ChannelMessageContext } from '../../types.js'

export interface WebhookServerConfig {
  listenAddress: string
}

type MessageHandler = (context: ChannelMessageContext, message: string) => Promise<void>

export class WebhookServer {
  private server: http.Server | null = null
  private readonly host: string
  private readonly port: number
  private readonly logger: (msg: string) => void
  private messageHandler: MessageHandler | null = null

  constructor(config: WebhookServerConfig, logger: (msg: string) => void) {
    const [host, portStr] = config.listenAddress.split(':')
    this.host = host || '0.0.0.0'
    this.port = parseInt(portStr, 10) || 40000
    this.logger = logger
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  getPort(): number {
    return this.port
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'text/plain' })
          res.end('Method Not Allowed')
          return
        }
        this.handleRequest(req, res)
      })

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          this.logger(`[WebhookServer] Port ${this.port} is already in use, webhook server not started`)
          resolve()
        } else {
          reject(err)
        }
      })

      this.server.listen(this.port, this.host, () => {
        this.logger(`[WebhookServer] Listening on ${this.host}:${this.port}`)
        resolve()
      })
    })
  }

  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
      this.logger('[WebhookServer] Stopped')
    }
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString()
    })
    req.on('end', () => {
      this.processBody(body, res)
    })
  }

  private processBody(body: string, res: http.ServerResponse): void {
    let callback: {
      conversationType?: string
      conversationId?: string
      senderId?: string
      senderStaffId?: string
      text?: { content?: string }
      content?: string
      msgtype?: string
    }

    try {
      callback = JSON.parse(body)
    } catch {
      this.logger(`[WebhookServer] Invalid JSON body: ${body.substring(0, 200)}`)
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Bad Request: invalid JSON')
      return
    }

    const messageText = callback.text?.content?.trim() || callback.content?.trim() || ''
    if (!messageText) {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('OK')
      return
    }

    const conversationId = callback.conversationId || 'webhook-default'
    const senderId = callback.senderId || 'unknown'
    const isGroup = callback.conversationType === '2'
    const userId = callback.senderStaffId || ''

    const context: ChannelMessageContext = {
      conversationId,
      senderId,
      isGroup,
      userId,
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('OK')

    if (this.messageHandler) {
      this.messageHandler(context, messageText).catch((err) => {
        this.logger(`[WebhookServer] Handler error: ${err}`)
      })
    }
  }
}
```

- [ ] **Step 2: Verify type check passes**

Run:
```bash
cd /home/admin/git/claudetalk && npm run type-check
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/channels/dingtalk/webhook-server.ts
git commit -m "feat(dingtalk): add webhook-server HTTP receiver for outgoing callbacks"
```

---

### Task 6: Integrate Webhook Modules into DingTalkClient

**Files:**
- Modify: `src/channels/dingtalk/index_dingtalk.ts`

- [ ] **Step 1: Add imports at top of file**

Add after existing imports (near the top of `index_dingtalk.ts`):

```typescript
import { WebhookClient } from './webhook-client.js'
import { WebhookServer } from './webhook-server.js'
import type { WebhookConfig } from '../../types.js'
```

- [ ] **Step 2: Add webhook properties to DingTalkClient class**

Add after line 87 (after `HEARTBEAT_TIMEOUT_MS`):

```typescript
  private webhookClient: WebhookClient | null = null;
  private webhookServer: WebhookServer | null = null;
```

- [ ] **Step 3: Add webhook config parameter to constructor**

The DingTalkClient constructor receives `config: DingTalkChannelConfig`. We need to pass `WebhookConfig` through. Modify the constructor (around line 90) to accept webhook config. Add after the existing initialization (after `this.registerSelfToChatMembers()`):

```typescript
    // Initialize webhook modules if configured
    const webhookConfig = (config as unknown as { webhook?: WebhookConfig }).webhook
    if (webhookConfig?.webhookUrls?.length && webhookConfig?.listenAddress) {
      this.webhookClient = new WebhookClient(
        { webhookUrls: webhookConfig.webhookUrls, webhookSecret: webhookConfig.webhookSecret || '' },
        this.logger
      )
      this.webhookServer = new WebhookServer(
        { listenAddress: webhookConfig.listenAddress },
        this.logger
      )
    }
```

- [ ] **Step 4: Modify `start()` to launch webhook server**

After `this.startPeerMessagePolling()` (around line 360), add:

```typescript
    // Start webhook server if configured
    if (this.webhookServer) {
      this.webhookServer.onMessage((context, message) => {
        if (this.channelMessageHandler) {
          return this.channelMessageHandler(context, message)
        }
        return Promise.resolve()
      })
      await this.webhookServer.start()
    }
```

- [ ] **Step 5: Modify `stop()` to shut down webhook server**

After `this.ws.close()` block (around line 383), add:

```typescript
    if (this.webhookServer) {
      this.webhookServer.stop()
    }
```

- [ ] **Step 6: Modify `sendMessage()` to also push to webhooks**

At the end of `sendMessage()`, after the existing post-send side effects (after `writePeerMessagesFromContent`, around line 954), add:

```typescript
    // Push to webhook URLs if configured
    if (this.webhookClient) {
      this.webhookClient.postToWebhooks(content).catch((err) => {
        this.logger(`[sendMessage] Webhook push error: ${err}`)
      })
    }
```

- [ ] **Step 7: Modify the `create()` factory in `registerChannel()`**

Update the `create()` function (around line 1300) to pass webhook config through:

```typescript
  create(config: Record<string, string>) {
    const webhookRaw = config.webhook
    let webhookConfig: WebhookConfig | undefined
    if (webhookRaw) {
      try {
        webhookConfig = JSON.parse(webhookRaw) as WebhookConfig
      } catch {}
    }

    return new DingTalkClient({
      clientId: config.DINGTALK_CLIENT_ID,
      clientSecret: config.DINGTALK_CLIENT_SECRET,
      robotCode: config.DINGTALK_CLIENT_ID,
      profileName: config.profileName,
      workDir: config.workDir,
      systemPrompt: config.systemPrompt,
      webhook: webhookConfig,
    } as DingTalkChannelConfig & { webhook?: WebhookConfig })
  },
```

- [ ] **Step 8: Update `DingTalkChannelConfig` in types.ts to include webhook**

In `src/types.ts`, add to the `DingTalkChannelConfig` interface (around line 58):

```typescript
  /** Webhook 配置（附属模块） */
  webhook?: WebhookConfig;
```

- [ ] **Step 9: Update `createChannel()` in `src/index.ts` to pass webhook config**

In `src/index.ts`, the `createChannel()` function (line 48-75) builds `enrichedChannelConfig`. Add webhook config to the enriched config. After line 70 (where `workDir` is injected):

```typescript
    ...(config.webhook ? { webhook: JSON.stringify(config.webhook) } : {}),
```

- [ ] **Step 10: Verify type check passes**

Run:
```bash
cd /home/admin/git/claudetalk && npm run type-check
```

Expected: No errors.

- [ ] **Step 11: Commit**

```bash
git add src/channels/dingtalk/index_dingtalk.ts src/types.ts src/index.ts
git commit -m "feat(dingtalk): integrate webhook server and client into DingTalkClient"
```

---

### Task 7: Add Webhook Setup Wizard to CLI

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add domain import**

At the top of `src/cli.ts`, add:

```typescript
import { generatePublicUrl } from './core/domain.js'
import type { WebhookConfig } from './types.js'
```

- [ ] **Step 2: Add webhook setup section in `interactiveSetup()`**

In `interactiveSetup()`, insert the following block **after** the channel configFields loop (after line 473, the closing brace of `for (const field of descriptor.configFields)`) and **before** the systemPrompt section (line 475):

```typescript
  // 2.5 Webhook 机器人配置（仅 dingtalk channel）
  let webhookConfig: WebhookConfig | undefined
  if (channelType === 'dingtalk') {
    console.log('')
    console.log('📡 Webhook 机器人配置（可选）')
    console.log('   配置后可通过 HTTP POST 接收自定义机器人 outgoing 回调，并通过 webhook 推送响应')

    const existingWebhook = existingProfile?.webhook as WebhookConfig | undefined
    const defaultAnswer = existingWebhook ? 'y' : 'n'
    const enableWebhookInput = await promptInput(
      `是否配置 webhook 机器人？(y/N) [${defaultAnswer}]: `
    )
    const enableWebhook = (enableWebhookInput || defaultAnswer).toLowerCase() === 'y'

    if (enableWebhook) {
      // Webhook URLs
      const existingUrls = existingWebhook?.webhookUrls?.join(',') || ''
      const urlsPrompt = existingUrls
        ? `webhook URL (多个用逗号分隔) [${existingUrls.substring(0, 50)}...]: `
        : 'webhook URL (多个用逗号分隔): '
      const urlsInput = await promptInput(urlsPrompt)
      const webhookUrls = (urlsInput || existingUrls)
        .split(',')
        .map((u: string) => u.trim())
        .filter((u: string) => u.length > 0)

      // Webhook Secret
      const existingSecret = existingWebhook?.webhookSecret || ''
      const secretDisplay = existingSecret ? `${existingSecret.substring(0, 4)}****` : ''
      const secretPrompt = secretDisplay
        ? `webhook 加签密钥 [${secretDisplay}]: `
        : 'webhook 加签密钥: '
      const secretInput = await promptInput(secretPrompt)
      const webhookSecret = secretInput || existingSecret

      // Listen Address
      const existingListen = existingWebhook?.listenAddress || '0.0.0.0:40000'
      const listenInput = await promptInput(`本机监听地址 [${existingListen}]: `)
      const listenAddress = listenInput || existingListen

      // Generate public URL
      console.log('')
      console.log('🔗 正在生成公网访问地址...')
      let publicUrl = existingWebhook?.publicUrl || ''
      try {
        const port = parseInt(listenAddress.split(':')[1], 10) || 40000
        const baseUrl = await generatePublicUrl(port)
        publicUrl = `${baseUrl}/dingtalk-channel/message`
        console.log(`✅ 公网地址: ${publicUrl}`)
        console.log('⚠️  请保存此地址，配置钉钉自定义机器人时需要用到！')
      } catch (err) {
        console.log(`⚠️  公网地址生成失败: ${err}`)
        if (publicUrl) {
          console.log(`   使用上次保存的地址: ${publicUrl}`)
        } else {
          console.log('   请稍后手动配置 publicUrl')
        }
      }

      webhookConfig = { webhookUrls, webhookSecret, listenAddress, publicUrl }
    }
  }
```

- [ ] **Step 3: Include webhookConfig in the saved profile**

Modify the `profileConfig` construction (around line 528) to include webhook:

```typescript
  const profileConfig: ProfileConfig = {
    channel: channelType,
    [channelType]: channelConfig,
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(enableSubagent ? { subagentEnabled: true } : {}),
    ...(subagentModel ? { subagentModel } : {}),
    ...(webhookConfig ? { webhook: webhookConfig } : {}),
  }
```

- [ ] **Step 4: Verify type check passes**

Run:
```bash
cd /home/admin/git/claudetalk && npm run type-check
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "feat(cli): add webhook bot setup wizard with default value display"
```

---

### Task 8: Build and Smoke Test

**Files:**
- No file changes

- [ ] **Step 1: Full build**

Run:
```bash
cd /home/admin/git/claudetalk && npm run build
```

Expected: Compiles successfully, no errors.

- [ ] **Step 2: Run setup to verify webhook wizard**

Run:
```bash
cd /home/admin/git/claudetalk && node dist/cli.js --setup --profile test-webhook
```

Walk through:
1. Select dingtalk channel
2. Enter test credentials
3. Verify webhook configuration prompt appears
4. Enter test webhook URL, secret, listen address
5. Verify public URL generation
6. Confirm config saved to `.claudetalk.json` with `webhook` section

- [ ] **Step 3: Verify startup with webhook server**

Run (will fail to connect DingTalk but should start webhook server):
```bash
cd /home/admin/git/claudetalk && timeout 5 node dist/cli.js --profile test-webhook 2>&1 || true
```

Expected: Log output includes `[WebhookServer] Listening on 0.0.0.0:40000` (or the configured port).

- [ ] **Step 4: Test webhook server receives POST**

In a separate terminal (while the bot is running):
```bash
curl -X POST http://localhost:40000 \
  -H 'Content-Type: application/json' \
  -d '{"conversationType":"1","conversationId":"test123","senderId":"user1","text":{"content":"hello"}}'
```

Expected: Returns 200 OK. Bot logs show the message being received and processed (will fail at callClaude without real credentials, but the webhook intake path is verified).

- [ ] **Step 5: Clean up test profile**

Remove the test profile from `.claudetalk.json` if not needed.

- [ ] **Step 6: Commit any fixes**

If any issues were found and fixed during smoke testing:
```bash
git add -A && git commit -m "fix: address issues found during webhook smoke test"
```
