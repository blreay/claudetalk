/**
 * 统一日志模块
 *
 * 所有日志格式：[yyyy-MM-dd HH:mm:ss.SSS] [channel profile] message
 * 使用 createLogger(channel?, profile?) 创建带上下文前缀的局部 logger
 */

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
 * 基础日志函数，直接输出到 stderr
 */
export function log(msg: string): void {
  console.error(`[${formatTimestamp()}] ${msg}`)
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
