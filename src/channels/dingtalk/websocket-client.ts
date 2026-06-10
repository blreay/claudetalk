import type { ChannelMessageContext } from '../../types.js'

export interface WebsocketClientConfig {
  serverUrl: string
  profileName?: string
}

type MessageHandler = (context: ChannelMessageContext, message: string) => Promise<void>

const SEPARATOR = '════════════════════════════════════════════════════════════════════════════════'

interface IncomingEnvelope {
  type?: string
  action?: string
  event?: string
  data?: unknown
  payload?: unknown
  message?: unknown
}

interface IncomingMessagePayload {
  conversationType?: string
  conversationId?: string
  senderId?: string
  senderStaffId?: string
  text?: { content?: string }
  content?: string
  msgtype?: string
}

export class WebhookWebsocketClient {
  private ws: WebSocket | null = null
  private messageHandler: MessageHandler | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pullTimer: ReturnType<typeof setInterval> | null = null
  private reconnectDelayMs = 3000
  private manuallyClosed = false
  private readonly serverUrl: string
  private readonly profileName?: string
  private readonly logger: (msg: string) => void

  constructor(config: WebsocketClientConfig, logger: (msg: string) => void) {
    this.serverUrl = config.serverUrl
    this.profileName = config.profileName
    this.logger = logger
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  async start(): Promise<void> {
    this.manuallyClosed = false
    this.reconnectDelayMs = 3000
    await this.connect()
  }

  stop(): void {
    this.manuallyClosed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.stopPullLoop()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.logger('[WebhookWebsocketClient] Stopped')
  }

  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.logger(`[WebhookWebsocketClient] Connecting to ${this.serverUrl}`)
      const ws = new WebSocket(this.serverUrl)
      this.ws = ws
      let opened = false

      ws.onopen = () => {
        opened = true
        this.reconnectDelayMs = 3000
        this.logger('[WebhookWebsocketClient] Connected')
        this.sendPull()
        this.startPullLoop()
        resolve()
      }

      ws.onmessage = (event) => {
        this.handleFrame(String(event.data)).catch((err) => {
          this.logger(`[WebhookWebsocketClient] Handler error: ${err}`)
        })
      }

      ws.onerror = (error) => {
        this.logger(`[WebhookWebsocketClient] WebSocket error: ${JSON.stringify(error)}`)
        if (!opened) {
          reject(new Error('websocket connection failed'))
        }
      }

      ws.onclose = (event) => {
        this.logger(`[WebhookWebsocketClient] Disconnected: code=${event.code}, reason=${event.reason}`)
        if (this.ws === ws) this.ws = null
        this.stopPullLoop()
        if (!this.manuallyClosed) {
          this.scheduleReconnect()
        }
      }
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    const delay = this.reconnectDelayMs
    this.logger(`[WebhookWebsocketClient] Reconnecting in ${delay}ms...`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch((err) => {
        this.logger(`[WebhookWebsocketClient] Reconnect failed: ${err}`)
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 60000)
        if (!this.manuallyClosed) this.scheduleReconnect()
      })
    }, delay)
  }

  private sendPull(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const payload = {
      type: 'pull',
      profileName: this.profileName,
      timestamp: Date.now(),
    }
    this.ws.send(JSON.stringify(payload))
    this.logger(`[WebhookWebsocketClient] Sent pull request: ${JSON.stringify(payload)}`)
  }

  private startPullLoop(): void {
    this.stopPullLoop()
    this.pullTimer = setInterval(() => {
      this.sendPull()
    }, 30 * 1000)
  }

  private stopPullLoop(): void {
    if (this.pullTimer) {
      clearInterval(this.pullTimer)
      this.pullTimer = null
    }
  }

  private async handleFrame(rawData: string): Promise<void> {
    this.dumpIncomingFrame(rawData)

    let parsed: unknown
    try {
      parsed = JSON.parse(rawData)
    } catch {
      this.logger(`[WebhookWebsocketClient] Invalid JSON frame: ${rawData.substring(0, 200)}`)
      this.logger('[WebhookWebsocketClient] Frame ignored: websocket channel expects JSON message frames. This frame will not trigger agent processing.')
      return
    }

    const payloads = this.extractPayloads(parsed)
    if (payloads.length === 0) {
      this.logger('[WebhookWebsocketClient] No message payload extracted from frame; agent processing was not triggered.')
      this.logFrameHint(parsed)
      return
    }
    for (const payload of payloads) {
      await this.processPayload(payload)
    }
  }

  private extractPayloads(parsed: unknown): IncomingMessagePayload[] {
    if (Array.isArray(parsed)) {
      return parsed.flatMap((item) => this.extractPayloads(item))
    }

    if (!this.isObject(parsed)) return []
    const envelope = parsed as IncomingEnvelope
    const frameType = envelope.type || envelope.action || envelope.event

    if (frameType === 'ping') {
      this.sendJson({ type: 'pong', timestamp: Date.now() })
      return []
    }

    if (frameType === 'pull' || frameType === 'push' || frameType === 'message') {
      const nested = envelope.data ?? envelope.payload ?? envelope.message
      if (Array.isArray(nested)) return nested.flatMap((item) => this.extractPayloads(item))
      if (this.isObject(nested)) return [nested as IncomingMessagePayload]
      if (frameType === 'pull') {
        this.logger('[WebhookWebsocketClient] Received a pull frame without message data. If this is an echo of our pull request, it is not a DingTalk message source.')
      }
      return []
    }

    return [parsed as IncomingMessagePayload]
  }

  private async processPayload(callback: IncomingMessagePayload): Promise<void> {
    const messageText = callback.text?.content?.trim() || callback.content?.trim() || ''
    if (!messageText) {
      this.logger(`[WebhookWebsocketClient] Payload ignored: no text.content/content field found. payload=${JSON.stringify(callback).substring(0, 500)}`)
      return
    }

    const conversationId = callback.conversationId || 'webhook-websocket-default'
    const senderId = callback.senderId || 'unknown'
    const isGroup = callback.conversationType === '2'
    const userId = callback.senderStaffId || ''

    const context: ChannelMessageContext = {
      conversationId,
      senderId,
      isGroup,
      userId,
      source: 'webhook',
    }

    await this.messageHandler?.(context, messageText)
    this.sendJson({ type: 'ack', conversationId, timestamp: Date.now() })
  }

  private logFrameHint(parsed: unknown): void {
    if (!this.isObject(parsed)) return
    const envelope = parsed as IncomingEnvelope
    const frameType = envelope.type || envelope.action || envelope.event

    if (frameType === 'pull') {
      this.logger('[WebhookWebsocketClient] Diagnostic: received type=pull but no data/payload/message object. Public echo websocket services commonly echo our pull request; they cannot deliver DingTalk messages.')
      return
    }

    if (frameType) {
      this.logger(`[WebhookWebsocketClient] Diagnostic: unsupported or empty frame type=${frameType}. Expected a message frame containing data/payload/message with text.content or content.`)
    }
  }

  private sendJson(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(payload))
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
  }

  private dumpIncomingFrame(body: string): void {
    const lines = [
      SEPARATOR,
      '[WebhookWebsocketClient] ◀◀◀ INCOMING FRAME',
      SEPARATOR,
      body,
      SEPARATOR,
    ]
    this.logger(lines.join('\n'))
  }
}
