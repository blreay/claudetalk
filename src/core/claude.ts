/**
 * Claude CLI 调用层 + Session 管理
 * 两个 Channel（钉钉、Discord）共享此模块，各自独立处理消息后调用 callClaude
 */

import { spawn } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ChannelType, ClaudeTalkConfig } from '../types.js'
import { createLogger, log } from './logger.js'

// Re-export for index.ts compatibility
export { createLogger, log } from './logger.js'

// ========== Session 持久化 ==========
// session 文件存放在工作目录下的 .claudetalk-sessions.json
// 注意：SESSION_FILE 在模块加载时还不知道 workDir，所以用函数动态获取路径

function getSessionFile(workDir: string): string {
  return join(workDir, '.claudetalk-sessions.json')
}

/** 实时输出选项（持久化到 session 中） */
export interface RealtimeOutputOptions {
  /** 是否发送 agent 的 thinking 内容 */
  showThinking: boolean
  /** 是否发送 agent 的 text 内容 */
  showText: boolean
  /** 是否发送 result 内容（可能导致重复） */
  showResult: boolean
}

/** 默认选项：只开启 text */
export const DEFAULT_REALTIME_OPTIONS: RealtimeOutputOptions = {
  showThinking: false,
  showText: false,
  showResult: false,
}

export interface SessionEntry {
  sessionId: string
  lastActiveAt: number
  isGroup: boolean
  conversationId: string
  userId: string
  subagentEnabled: boolean
  channel: ChannelType
  /** 实时输出选项（可选，缺失时使用默认值） */
  realtimeOptions?: RealtimeOutputOptions
}

function parseSessionEntry(value: unknown, key: string): SessionEntry | null {
  if (value && typeof value === 'object' && 'sessionId' in value) {
    const entry = value as SessionEntry
    if (!entry.userId) entry.userId = ''
    if (entry.subagentEnabled === undefined) entry.subagentEnabled = false
    if (!entry.channel) entry.channel = 'dingtalk'
    // realtimeOptions 缺失时使用默认值
    if (!entry.realtimeOptions) {
      entry.realtimeOptions = { ...DEFAULT_REALTIME_OPTIONS }
    }
    return entry
  }
  return null
}

function loadSessionMap(workDir: string): Map<string, SessionEntry> {
  const sessionFile = getSessionFile(workDir)
  if (!existsSync(sessionFile)) {
    return new Map()
  }
  try {
    const content = readFileSync(sessionFile, 'utf-8')
    const raw = JSON.parse(content) as Record<string, unknown>
    const entries = new Map<string, SessionEntry>()
    for (const [key, value] of Object.entries(raw)) {
      const entry = parseSessionEntry(value, key)
      if (entry) {
        entries.set(key, entry)
      }
    }
    return entries
  } catch (error) {
    log(`[session] Failed to load sessions: ${error}`)
    return new Map()
  }
}

function saveSessionMap(workDir: string, sessionMap: Map<string, SessionEntry>): void {
  const sessionFile = getSessionFile(workDir)
  try {
    const entries = Object.fromEntries(sessionMap)
    writeFileSync(sessionFile, JSON.stringify(entries, null, 2) + '\n', 'utf-8')
  } catch (error) {
    log(`[session] Failed to save sessions: ${error}`)
  }
}

// 按 workDir 缓存 session map，避免每次都读文件
const sessionMapCache = new Map<string, Map<string, SessionEntry>>()

function getSessionMap(workDir: string): Map<string, SessionEntry> {
  if (!sessionMapCache.has(workDir)) {
    sessionMapCache.set(workDir, loadSessionMap(workDir))
  }
  return sessionMapCache.get(workDir)!
}

/**
 * 生成 session key
 * 格式：conversationId|workDir|profile|channel
 * 不同 profile、不同 channel 的 session 完全隔离
 */
export function getSessionKey(
  conversationId: string,
  workDir: string,
  profile?: string,
  channel?: ChannelType
): string {
  const parts = [conversationId, workDir]
  if (profile) parts.push(profile)
  if (channel) parts.push(channel)
  return parts.join('|')
}

/**
 * 清除指定会话的 session
 */
export function clearSession(
  conversationId: string,
  workDir: string,
  profile?: string,
  channel?: ChannelType
): boolean {
  const sessionMap = getSessionMap(workDir)
  const sessionKey = getSessionKey(conversationId, workDir, profile, channel)
  const hadSession = sessionMap.has(sessionKey)
  if (hadSession) {
    sessionMap.delete(sessionKey)
    saveSessionMap(workDir, sessionMap)
  }
  return hadSession
}

/**
 * 获取指定会话的实时输出选项
 * 如果会话不存在或没有设置，返回默认值
 */
export function getRealtimeOptions(
  conversationId: string,
  workDir: string,
  profile?: string,
  channel?: ChannelType
): RealtimeOutputOptions {
  const sessionMap = getSessionMap(workDir)
  const sessionKey = getSessionKey(conversationId, workDir, profile, channel)
  const entry = sessionMap.get(sessionKey)
  return entry?.realtimeOptions ?? { ...DEFAULT_REALTIME_OPTIONS }
}

/**
 * 更新指定会话的实时输出选项
 * 如果会话不存在，创建一个占位条目
 */
export function updateRealtimeOptions(
  conversationId: string,
  workDir: string,
  options: Partial<RealtimeOutputOptions>,
  profile?: string,
  channel?: ChannelType
): RealtimeOutputOptions {
  const sessionMap = getSessionMap(workDir)
  const sessionKey = getSessionKey(conversationId, workDir, profile, channel)
  const entry = sessionMap.get(sessionKey)

  const currentOptions = entry?.realtimeOptions ?? { ...DEFAULT_REALTIME_OPTIONS }
  const newOptions: RealtimeOutputOptions = {
    ...currentOptions,
    ...options,
  }

  if (entry) {
    entry.realtimeOptions = newOptions
  } else {
    // 创建占位条目（没有 sessionId，仅用于存储设置）
    sessionMap.set(sessionKey, {
      sessionId: '',
      lastActiveAt: Date.now(),
      isGroup: false,
      conversationId,
      userId: '',
      subagentEnabled: false,
      channel: channel ?? 'dingtalk',
      realtimeOptions: newOptions,
    })
  }
  saveSessionMap(workDir, sessionMap)
  return newOptions
}

/**
 * 找当前 workDir、channel、profile 下最近活跃的私聊会话，用于发上线通知
 * @param workDir - 工作目录
 * @param channel - 消息通道类型，避免跨 channel 通知
 * @param profile - profile 名称，避免同一 channel 下不同飞书应用（AppId 不同）互相通知
 */
export function findLastActivePrivateSession(
  workDir: string,
  channel: ChannelType,
  profile?: string
): SessionEntry | null {
  const sessionMap = getSessionMap(workDir)
  let latestEntry: SessionEntry | null = null
  for (const [key, entry] of sessionMap) {
    const parts = key.split('|')
    if (parts[1] !== workDir) continue
    if (entry.isGroup) continue
    if (entry.channel !== channel) continue
    // 过滤 profile：同一 channel 下不同飞书应用的 open_id 不能互用
    if (profile && parts[2] !== profile) continue
    if (!latestEntry || entry.lastActiveAt > latestEntry.lastActiveAt) {
      latestEntry = entry
    }
  }
  return latestEntry
}

// ========== 配置加载 ==========

function loadConfigFromFile(filePath: string, profile?: string): ClaudeTalkConfig | null {
  if (!existsSync(filePath)) {
    return null
  }
  try {
    const content = readFileSync(filePath, 'utf-8')
    const raw = JSON.parse(content)

    if (profile && !raw.profiles?.[profile]) {
      return null
    }

    const profileOverride = profile ? (raw.profiles?.[profile] ?? {}) : {}
    return {
      ...raw,
      ...profileOverride,
      profiles: undefined,
    }
  } catch {
    return null
  }
}

export function loadConfig(workDir: string, profile?: string): ClaudeTalkConfig | null {
  const localConfigFile = join(workDir, '.claudetalk.json')
  return loadConfigFromFile(localConfigFile, profile)
}

// ========== SubAgent 构建 ==========

/**
 * 解析 .claude/agents/{profileName}.md 文件
 * 格式：YAML frontmatter（---包裹）+ 正文（即 prompt 内容）
 * 返回从文件中提取的 agent 定义字段，优先级高于 .claudetalk.json 中的配置
 */
function parseAgentMdFile(workDir: string, profileName: string): {
  description?: string
  prompt?: string
  model?: string
  tools?: string[]
  disallowedTools?: string[]
} | null {
  const agentFilePath = join(workDir, '.claude', 'agents', `${profileName}.md`)
  if (!existsSync(agentFilePath)) {
    return null
  }

  try {
    const content = readFileSync(agentFilePath, 'utf-8')
    const result: {
      description?: string
      prompt?: string
      model?: string
      tools?: string[]
      disallowedTools?: string[]
    } = {}

    // 解析 YAML frontmatter（--- 包裹的部分）
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
    if (frontmatterMatch) {
      const yamlSection = frontmatterMatch[1]
      const bodySection = frontmatterMatch[2].trim()

      // 简单解析 YAML 字段（不引入外部依赖）
      for (const line of yamlSection.split('\n')) {
        const colonIndex = line.indexOf(':')
        if (colonIndex === -1) continue
        const key = line.slice(0, colonIndex).trim()
        const value = line.slice(colonIndex + 1).trim().replace(/^["']|["']$/g, '')

        if (key === 'description') result.description = value
        if (key === 'model') result.model = value
        if (key === 'tools') {
          // 支持 tools: [Read, Write] 或 tools: Read, Write 格式
          result.tools = value.replace(/[\[\]]/g, '').split(',').map(t => t.trim()).filter(Boolean)
        }
        if (key === 'disallowedTools') {
          result.disallowedTools = value.replace(/[\[\]]/g, '').split(',').map(t => t.trim()).filter(Boolean)
        }
      }

      // 正文作为 prompt
      if (bodySection) {
        result.prompt = bodySection
      }
    } else {
      // 没有 frontmatter，整个文件内容作为 prompt
      result.prompt = content.trim()
    }

    log(`[agent-md] Loaded agent definition from ${agentFilePath}`)
    return result
  } catch (error) {
    log(`[agent-md] Failed to parse ${agentFilePath}: ${error}`)
    return null
  }
}

/**
 * 构建 --agents 参数的 JSON 字符串
 * 优先级：.claude/agents/{profileName}.md > .claudetalk.json 中的 systemPrompt 配置
 */
function buildAgentJson(profileName: string, config: ClaudeTalkConfig, workDir: string): string | null {
  // 优先读取 .claude/agents/{profileName}.md
  const agentMd = parseAgentMdFile(workDir, profileName)

  const agentDef: Record<string, unknown> = agentMd
    ? {
        // 使用 agent.md 中的字段
        description: agentMd.description || `${profileName} 角色助手`,
        prompt: agentMd.prompt || `你是 ${profileName} 角色，负责相关工作。`,
        ...(agentMd.model ? { model: agentMd.model } : {}),
        ...(agentMd.tools?.length ? { tools: agentMd.tools } : {}),
        ...(agentMd.disallowedTools?.length ? { disallowedTools: agentMd.disallowedTools } : {}),
      }
    : {
        // 降级：使用 .claudetalk.json 中的 systemPrompt 配置
        description: config.systemPrompt
          ? `${profileName} 角色助手。${config.systemPrompt}`
          : `${profileName} 角色助手，负责相关工作。`,
        prompt: config.systemPrompt || `你是 ${profileName} 角色，负责相关工作。`,
        ...(config.subagentModel ? { model: config.subagentModel } : {}),
        ...(config.subagentPermissions?.allow?.length ? { tools: config.subagentPermissions.allow } : {}),
        ...(config.subagentPermissions?.deny?.length ? { disallowedTools: config.subagentPermissions.deny } : {}),
      }

  try {
    return JSON.stringify({ [profileName]: agentDef })
  } catch {
    return null
  }
}

// ========== Claude CLI 调用 ==========

interface ClaudeResponse {
  type: string
  subtype: string
  is_error: boolean
  result: string
  session_id: string
  duration_ms: number
  stop_reason: string
  message?: unknown
}

export interface CallClaudeOptions {
  message: string
  conversationId: string
  workDir: string
  isGroup?: boolean
  userId?: string
  profile?: string
  channel?: ChannelType
  /** 加工后的消息（由 Channel 处理后生成），有值时替换原始 message 发送给 Claude */
  processedMessage?: string
  /** 实时消息回调，当收到 stream-json 输出时调用 */
  onProgress?: (message: string) => void
  /** 实时输出选项（从 session 中读取） */
  realtimeOptions?: RealtimeOutputOptions
}

/**
 * 调用 claude -p CLI 处理消息，支持多轮会话
 *
 * 新建 session 策略：
 * - 有 profile 且启用 SubAgent → 通过 --agents 传入 SubAgent 定义
 * - 有 profile 但未启用 SubAgent → 通过 --append-system-prompt 传入角色信息
 * - 无 profile → 不传额外参数，Claude 自动委托
 */
export async function callClaude(options: CallClaudeOptions): Promise<string> {
  const {
    message,
    conversationId,
    workDir,
    isGroup = false,
    userId = '',
    profile,
    channel = 'dingtalk',
    processedMessage,
  } = options

  const logger = createLogger(profile)
  const sessionMap = getSessionMap(workDir)
  const sessionKey = getSessionKey(conversationId, workDir, profile, channel)
  const existingEntry = sessionMap.get(sessionKey)
  const existingSessionId = existingEntry?.sessionId

  const currentConfig = loadConfig(workDir, profile)
  const currentSubagentEnabled = currentConfig?.subagentEnabled ?? false
  const currentSystemPrompt = currentConfig?.systemPrompt
  const ccEngine = currentConfig?.ccEngine ?? 'claude'

  // 根据 ccEngine 决定使用的命令和参数
  // codefuse 和 codefuse-cc 都使用 cfuse 命令
  const isCodefuse = ccEngine === 'codefuse' || ccEngine === 'codefuse-cc'
  const ccCommand = isCodefuse ? 'cfuse' : 'claude'
  // 只有 codefuse-cc 需要在 args 最前面加 --cc
  const needsCcFlag = ccEngine === 'codefuse-cc'
  const args = needsCcFlag
    ? ['--cc', '-p', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--verbose']
    : ['-p', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--verbose']

  if (existingSessionId && existingEntry) {
    // 配置变化时清除旧 session，重建
    if (existingEntry.subagentEnabled !== currentSubagentEnabled) {
      logger(`[session] Config changed: subagentEnabled ${existingEntry.subagentEnabled} -> ${currentSubagentEnabled}, clearing old session`)
      sessionMap.delete(sessionKey)
      saveSessionMap(workDir, sessionMap)
      return callClaude(options)
    }

    // 恢复 session 时也需要传入 --agents，否则 Claude Code 找不到 SubAgent 定义
    if (profile && currentSubagentEnabled && currentConfig) {
      const agentJson = buildAgentJson(profile, currentConfig, workDir)
      if (agentJson) args.push('--agents', agentJson)
    }
    args.push('--resume', existingSessionId)
  } else {
    if (profile && currentSubagentEnabled && currentConfig) {
      const agentJson = buildAgentJson(profile, currentConfig, workDir)
      if (agentJson) args.push('--agents', agentJson)
    } else if (profile && !currentSubagentEnabled && currentSystemPrompt) {
      args.push('--append-system-prompt', currentSystemPrompt)
    }
  }

  if (existingSessionId) {
    logger(`[claude] Resuming session: conversationId=${conversationId}, ccEngine=${ccEngine}, ccCommand=${ccCommand}`)
  } else {
    logger(`[claude] New session: conversationId=${conversationId}, ccEngine=${ccEngine}, ccCommand=${ccCommand}, subagentEnabled=${currentSubagentEnabled}`)
  }

  return new Promise((resolve, reject) => {
    const child = spawn(ccCommand, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workDir,
      env: { ...process.env },
      shell: process.platform === 'win32',
    })

    let stdout = ''
    let stderr = ''
    let lineBuffer = '' // 用于处理不完整的行
    let hasSentResult = false // 标记是否已发送过 result 类型的 message
    // 从 options 读取实时输出选项，缺失时使用默认值
    const realtimeOpts = options.realtimeOptions ?? DEFAULT_REALTIME_OPTIONS
    const sendRealTimeThinking = realtimeOpts.showThinking
    const sendRealTimeAgentTxt = realtimeOpts.showText
    const sendRealTimeResult = realtimeOpts.showResult

    child.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString()
      stdout += chunk
      lineBuffer += chunk

      // 按换行符分割，处理完整的行
      const lines = lineBuffer.split('\n')
      // 最后一行可能不完整，保留在 buffer 中
      lineBuffer = lines.pop() || ''

      for (const line of lines) {
        const trimmedLine = line.trim()
        if (!trimmedLine || !trimmedLine.startsWith('{')) continue

        try {
          const jsonLine = JSON.parse(trimmedLine) as {
            type?: string
            message?: unknown
          }
          logger(`[claude] stream-json line: type=${jsonLine.type} line=${trimmedLine}`)

          // type 为 assistant 时，提取 message.content 中的 thinking 和 text 字段
          if (jsonLine.type === 'assistant' && jsonLine.message) {
            const msg = jsonLine.message
            if (msg && typeof msg === 'object' && 'content' in msg) {
              const content = (msg as { content?: unknown }).content
              // content 可能是数组
              if (Array.isArray(content)) {
                for (const item of content) {
                  if (item && typeof item === 'object') {
                    // 提取 thinking 字段
                    if (sendRealTimeThinking && 'thinking' in item && item.thinking) {
                      const thinkingText = String(item.thinking)
                      if (thinkingText && options.onProgress) {
                        logger(`[claude] sendRealTimeThinking=${thinkingText}`)
                        options.onProgress(thinkingText)
                      }
                    }
                    // 提取 text 字段
                    if (sendRealTimeAgentTxt && 'text' in item && item.text) {
                      const textContent = String(item.text)
                      if (textContent && options.onProgress) {
                        logger(`[claude] sendText=${textContent}`)
                        options.onProgress(textContent)
                      }
                    }
                  }
                }
              } else if (typeof content === 'object' && content !== null) {
                // content 是对象
                const contentObj = content as Record<string, unknown>
                if (sendRealTimeThinking && 'thinking' in contentObj && contentObj.thinking) {
                  const thinkingText = String(contentObj.thinking)
                  if (thinkingText && options.onProgress) {
                    logger(`[claude] sendRealTimeThinking2=${thinkingText}`)
                    options.onProgress(thinkingText)
                  }
                }
                if (sendRealTimeAgentTxt && 'text' in contentObj && contentObj.text) {
                  const textContent = String(contentObj.text)
                  if (textContent && options.onProgress) {
                    logger(`[claude] sendText2=${textContent}`)
                    options.onProgress(textContent)
                  }
                }
              }
            }
          }

          // type 为 result 时，发送 message 域（如果没有则使用 result 域）的内容
          if (jsonLine.type === 'result') {
            const parsedLine = jsonLine as { message?: unknown; result?: string }
            const msg = parsedLine.message ?? parsedLine.result
            const messageText = typeof msg === 'string' ? msg : JSON.stringify(msg)
            if (sendRealTimeResult && messageText && options.onProgress) {
              options.onProgress(messageText)
              hasSentResult = true
            }
          }
        } catch {
          // 解析失败，忽略该行
          logger(`[claude] parse failed stream-json line: line=${trimmedLine}`)
        }
      }
    })
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

    // 优先使用加工后的消息（包含历史消息和角色信息），否则使用原始消息
    const baseMessage = processedMessage ?? message
    const actualMessage =
      profile && currentSubagentEnabled
        ? `Use the ${profile} agent to handle this: ${baseMessage}`
        : baseMessage

    // 打印完整 prompt，便于调试
    logger(`[claude] ===== Full Prompt =====`)
    logger(`[claude] args: ${JSON.stringify(args)}`)
    logger(`[claude] prompt (${actualMessage.length} chars):\n${actualMessage}`)
    logger(`[claude] ========================`)

    child.stdin.write(actualMessage)
    child.stdin.end()

    child.on('close', (code: number | null) => {

      if (code !== 0) {
        const isSessionInvalid =
          stderr.includes('No conversation found') ||
          stderr.includes('session ID') ||
          stderr.includes('Invalid session') ||
          stderr.includes('Session not found') ||
          stderr.includes('--resume')
        if (isSessionInvalid) {
          logger(`[claude] Session invalid, clearing and retrying`)
          sessionMap.delete(sessionKey)
          saveSessionMap(workDir, sessionMap)
          callClaude({ ...options, channel }).then(resolve).catch(reject)
          return
        }

        if (stderr.includes('Permission denied') || stderr.includes('EACCES')) {
          reject(new Error(`Claude CLI 权限错误: ${stderr}`))
          return
        }

        if (stderr.includes('command not found') || stderr.includes('ENOENT')) {
          reject(new Error(`Claude CLI 未找到，请确认已安装: ${stderr}`))
          return
        }

        reject(new Error(`claude exited with code ${code}. stderr: ${stderr || '(empty)'}, stdout: ${stdout || '(empty)'}`))
        return
      }

      try {
        const lines = stdout.trim().split('\n')
        const lastJsonLine = lines.filter(line => line.startsWith('{')).pop()
        if (!lastJsonLine) {
          resolve(stdout.trim())
          return
        }

        const response = JSON.parse(lastJsonLine) as ClaudeResponse
        logger(`[claude] Done: duration=${response.duration_ms}ms, session_id=${response.session_id}`)
        logger(`[claude] lastJsonLine=${lastJsonLine}`)

        if (response.session_id) {
          // 保留现有的 realtimeOptions，避免被覆盖
          const existingRealtimeOptions = existingEntry?.realtimeOptions ?? options.realtimeOptions ?? DEFAULT_REALTIME_OPTIONS
          sessionMap.set(sessionKey, {
            sessionId: response.session_id,
            lastActiveAt: Date.now(),
            isGroup,
            conversationId,
            userId,
            subagentEnabled: currentSubagentEnabled,
            channel,
            realtimeOptions: existingRealtimeOptions,
          })
          saveSessionMap(workDir, sessionMap)
        }

        if (response.is_error) {
          reject(new Error(`Claude error: ${response.result}`))
          return
        }

        // 如果未发送过 result 类型的 message，则发送最后一行的 message（如果没有 message 则使用 result）
        // 否则返回空字符串，让 index.ts 不发送
        
        // 目前强制重新发送最终的结果，确保时序一致
        hasSentResult=false
        if (!hasSentResult) {
          const lastMessage = response.message ?? response.result
          const messageText = typeof lastMessage === 'string'
            ? lastMessage
            : JSON.stringify(lastMessage)
          resolve(messageText)
        } else {
          // 已发送过 result，返回空字符串（不发送最后一行）
          resolve('')
        }
        logger(`[claude] waitting for new input from user`)
      } catch (parseError) {
        logger(`[claude] Failed to parse JSON, returning raw output: ${parseError}`)
        resolve(stdout.trim())
      }
    })

    child.on('error', (error: Error) => {
      logger(`[claude] Spawn error: ${error.message}`)
      reject(error)
    })
  })
}
