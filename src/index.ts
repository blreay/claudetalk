#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { DingTalkClient } from './dingtalk.js'
import { DingTalkChannelConfig, DingTalkInboundCallback } from './types.js'

const config: DingTalkChannelConfig = {
  clientId: process.env.DINGTALK_CLIENT_ID || '',
  clientSecret: process.env.DINGTALK_CLIENT_SECRET || '',
  robotCode: process.env.DINGTALK_ROBOT_CODE || process.env.DINGTALK_CLIENT_ID || '',
  corpId: process.env.DINGTALK_CORP_ID || '',
  agentId: process.env.DINGTALK_AGENT_ID || '',
  dmPolicy: (process.env.DINGTALK_DM_POLICY as 'open' | 'pairing' | 'allowlist') || 'open',
  groupPolicy: (process.env.DINGTALK_GROUP_POLICY as 'open' | 'allowlist' | 'disabled') || 'open',
  allowFrom: process.env.DINGTALK_ALLOW_FROM?.split(',').filter(Boolean) || [],
  messageType: (process.env.DINGTALK_MESSAGE_TYPE as 'markdown' | 'card') || 'markdown',
  cardTemplateId: process.env.DINGTALK_CARD_TEMPLATE_ID || '',
  cardTemplateKey: process.env.DINGTALK_CARD_TEMPLATE_KEY || 'content',
}

const mcp = new Server(
  { name: 'dingtalk', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: `Messages arrive as <channel source="dingtalk" chat_id="...">.
Reply with the reply tool, passing the chat_id from the tag.
This channel connects to DingTalk via Stream mode (WebSocket), requiring no public IP.`,
  }
)

const dingtalkClient = new DingTalkClient(config)

// 注册消息处理器：收到钉钉消息后，通过 MCP channel 协议转发给 Claude Code
dingtalkClient.onMessage(async (callback: DingTalkInboundCallback) => {
  let messageText = ''
  try {
    const content = JSON.parse(callback.content)
    messageText = content.content || content.text || JSON.stringify(content)
  } catch {
    messageText = callback.content
  }

  const isGroup = callback.conversationType === '2'
  const chatId = callback.conversationId

  // 通过 MCP experimental channel 协议将消息发送给 Claude Code
  await mcp.notification({
    method: 'notifications/message',
    params: {
      role: 'user',
      content: `<channel source="dingtalk" chat_id="${chatId}" sender_id="${callback.senderId}" is_group="${isGroup}">\n${messageText}\n</channel>`,
    },
  })
})

// Register reply tool
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Send a message back over this DingTalk channel',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'The conversation to reply in' },
        text: { type: 'string', description: 'The message to send' },
      },
      required: ['chat_id', 'text'],
    },
  }],
}))

// Handle reply tool calls
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'reply') {
    const { chat_id, text } = req.params.arguments as { chat_id: string; text: string }

    try {
      const isGroup = chat_id.startsWith('cid')
      await dingtalkClient.sendMessage(chat_id, text, isGroup)
      return { content: [{ type: 'text', text: 'sent' }] }
    } catch (error) {
      console.error(`Failed to send reply: ${error}`)
      return {
        content: [{ type: 'text', text: `Failed to send: ${error}` }],
        isError: true,
      }
    }
  }

  throw new Error(`Unknown tool: ${req.params.name}`)
})

// Connect to MCP transport
await mcp.connect(new StdioServerTransport())
console.error('DingTalk MCP server started')

// Start DingTalk client
await dingtalkClient.start()
