import crypto from 'crypto'

export interface WebhookClientConfig {
  webhookUrls: string[]
  webhookSecret: string
}

const SEPARATOR = '════════════════════════════════════════════════════════════════════════════════'

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

    const reqBody = JSON.stringify({ msgtype: 'text', text: { content } })
    const reqHeaders = { 'Content-Type': 'application/json' }

    this.dumpOutgoingRequest(url, reqHeaders, reqBody)

    const response = await fetch(url, {
      method: 'POST',
      headers: reqHeaders,
      body: reqBody,
      signal: AbortSignal.timeout(10000),
    })

    const resBody = await response.text().catch(() => '')
    this.dumpIncomingResponse(url, response.status, Object.fromEntries(response.headers.entries()), resBody)

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${resBody}`)
    }
  }

  private dumpOutgoingRequest(url: string, headers: Record<string, string>, body: string): void {
    const lines = [
      SEPARATOR,
      `[WebhookClient] ▶▶▶ OUTGOING REQUEST`,
      SEPARATOR,
      `POST ${url}`,
    ]
    for (const [key, value] of Object.entries(headers)) {
      lines.push(`${key}: ${value}`)
    }
    lines.push('')
    lines.push(body)
    lines.push(SEPARATOR)
    this.logger(lines.join('\n'))
  }

  private dumpIncomingResponse(url: string, status: number, headers: Record<string, string>, body: string): void {
    const lines = [
      SEPARATOR,
      `[WebhookClient] ◀◀◀ RESPONSE (${status})`,
      SEPARATOR,
      `HTTP ${status} from ${url}`,
    ]
    for (const [key, value] of Object.entries(headers)) {
      lines.push(`${key}: ${value}`)
    }
    lines.push('')
    lines.push(body)
    lines.push(SEPARATOR)
    this.logger(lines.join('\n'))
  }
}
