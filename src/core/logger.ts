/**
 * 统一日志模块
 *
 * 所有日志格式：[yyyy-MM-dd HH:mm:ss.SSS] [channel profile] message
 * 使用 createLogger(channel?, profile?) 创建带上下文前缀的局部 logger
 */

import * as fs from 'fs'
import * as path from 'path'

// per-profile 日志流：key = profile name（'_shared' 用于无 profile 的全局日志）
const logStreams = new Map<string, fs.WriteStream>()
let currentProfile: string | null = null

/**
 * 初始化日志文件
 * @param workDir - 工作目录
 * @param profile - profile 名称，每个 profile 写入独立日志文件
 */
export function initLogFile(workDir: string, profile?: string): void {
  const claudetalkDir = path.join(workDir, '.claudetalk')

  if (!fs.existsSync(claudetalkDir)) {
    fs.mkdirSync(claudetalkDir, { recursive: true })
  }

  const date = new Date()
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

  const streamKey = profile || '_shared'
  currentProfile = streamKey

  if (logStreams.has(streamKey)) return

  const fileName = profile
    ? `claudetalk-${profile}-${dateStr}.log`
    : `claudetalk-${dateStr}.log`
  const logFilePath = path.join(claudetalkDir, fileName)

  const stream = fs.createWriteStream(logFilePath, { flags: 'a' })
  logStreams.set(streamKey, stream)

  let header = `\n${'='.repeat(80)}\n`
  header += `ClaudeTalk Log Session Started: ${formatTimestamp()}\n`
  header += `${'='.repeat(80)}\n\n`
  stream.write(header)
}

/**
 * 关闭日志文件（关闭当前 profile 或全部）
 */
export function closeLogFile(): void {
  for (const [key, stream] of logStreams) {
    if (stream && !stream.destroyed) {
      stream.write(`\n${'='.repeat(80)}\n`)
      stream.write(`ClaudeTalk Log Session Ended: ${formatTimestamp()}\n`)
      stream.write(`${'='.repeat(80)}\n`)
      stream.end()
    }
    logStreams.delete(key)
  }
}

function formatTimestamp(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hours = String(now.getHours()).padStart(2, '0')
  const minutes = String(now.getMinutes()).padStart(2, '0')
  const seconds = String(now.getSeconds()).padStart(2, '0')
  const ms = String(now.getMilliseconds()).padStart(3, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`
}

/**
 * 基础日志函数，同时输出到 stderr 和日志文件
 */
export function log(msg: string): void {
  const logMessage = `[${formatTimestamp()}] ${msg}`

  console.error(logMessage)

  const stream = logStreams.get(currentProfile || '_shared')
  if (stream && !stream.destroyed) {
    stream.write(logMessage + '\n')
  }
}

/**
 * 创建带上下文前缀的局部 logger
 *
 * @param channel - 消息通道类型，如 feishu、dingtalk、discord
 * @param profile - profile 名称，如 pm、fdev
 *
 * 输出格式示例：
 * - createLogger('feishu', 'pm')    → [2026-04-01 18:00:00.123] [feishu pm] message
 * - createLogger('dingtalk')        → [2026-04-01 18:00:00.123] [dingtalk] message
 * - createLogger(undefined, 'pm')   → [2026-04-01 18:00:00.123] [profile=pm] message
 * - createLogger()                  → [2026-04-01 18:00:00.123] message
 */
export function createLogger(channel?: string, profile?: string): (msg: string) => void {
  let prefix = ''
  if (channel && profile) {
    prefix = `[${channel} ${profile}] `
  } else if (channel) {
    prefix = `[${channel}] `
  } else if (profile) {
    prefix = `[profile=${profile}] `
  }
  return (msg: string) => log(`${prefix}${msg}`)
}
