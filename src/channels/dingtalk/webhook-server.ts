import http from 'http'
import type { ChannelMessageContext } from '../../types.js'

export interface WebhookServerConfig {
  listenAddress: string
}

type MessageHandler = (context: ChannelMessageContext, message: string) => Promise<void>

const SEPARATOR = '════════════════════════════════════════════════════════════════════════════════'

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
      this.dumpIncomingRequest(req, body)
      this.processBody(body, res, req)
    })
  }

  private dumpIncomingRequest(req: http.IncomingMessage, body: string): void {
    const lines = [
      SEPARATOR,
      `[WebhookServer] ◀◀◀ INCOMING REQUEST`,
      SEPARATOR,
      `${req.method} ${req.url} HTTP/${req.httpVersion}`,
      `Host: ${req.headers.host || ''}`,
    ]
    for (const [key, value] of Object.entries(req.headers)) {
      if (key === 'host') continue
      lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
    }
    lines.push('')
    lines.push(body)
    lines.push(SEPARATOR)
    this.logger(lines.join('\n'))
  }

  private dumpOutgoingResponse(statusCode: number, body: string): void {
    const lines = [
      SEPARATOR,
      `[WebhookServer] ▶▶▶ OUTGOING RESPONSE`,
      SEPARATOR,
      `HTTP ${statusCode}`,
      `Content-Type: text/plain`,
      '',
      body,
      SEPARATOR,
    ]
    this.logger(lines.join('\n'))
  }

  private processBody(body: string, res: http.ServerResponse, req: http.IncomingMessage): void {
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
      this.dumpOutgoingResponse(400, 'Bad Request: invalid JSON')
      return
    }

    const messageText = callback.text?.content?.trim() || callback.content?.trim() || ''
    if (!messageText) {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('OK')
      this.dumpOutgoingResponse(200, 'OK')
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
      source: 'webhook',
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('OK')
    this.dumpOutgoingResponse(200, 'OK')

    if (this.messageHandler) {
      this.messageHandler(context, messageText).catch((err) => {
        this.logger(`[WebhookServer] Handler error: ${err}`)
      })
    }
  }
}
