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
