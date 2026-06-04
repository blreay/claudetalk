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
