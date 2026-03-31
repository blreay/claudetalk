/**
 * Claude Code Feishu Channel - 飞书 API 客户端
 *
 * 使用飞书官方 SDK (@larksuiteoapi/node-sdk) 的 WSClient 建立 WebSocket 长连接
 * 需要在飞书开放平台开启"使用长连接接收事件"并订阅 im.message.receive_v1 事件
 * 文档: https://open.feishu.cn/document/server-docs/im-v1/message/create
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as Lark from '@larksuiteoapi/node-sdk';
import type {
  Channel,
  ChannelMessageContext,
  FeishuChannelConfig,
} from '../types.js';
import { registerChannel } from './registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';

// ========== 内部类型定义 ==========

interface FeishuTokenResponse {
  code: number;
  msg: string;
  tenant_access_token: string;
  expire: number;
}

interface FeishuBotInfoResponse {
  code: number;
  msg: string;
  bot: {
    app_name: string;
    avatar_url: string;
    ip_white_list: string[];
    open_id: string;
  };
}

// 飞书 SDK im.message.receive_v1 回调的事件数据结构
// SDK 已路由好事件类型，data 直接是 { sender, message }，不含 header/event 包装层
interface FeishuMessageEvent {
  sender: {
    sender_id: {
      user_id: string;
      union_id: string;
      open_id: string;
    };
    sender_type: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time: string;
    chat_id: string;
    chat_type: 'p2p' | 'group';
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: {
        user_id: string;
        union_id: string;
        open_id: string;
      };
      name: string;
      tenant_key: string;
    }>;
  };
}

// 飞书发送消息响应
interface FeishuSendMessageResponse {
  code: number;
  msg: string;
  data?: {
    message_id: string;
  };
}

// 飞书文本消息内容
interface FeishuTextContent {
  text: string;
}

/**
 * 飞书 API 客户端，实现 Channel 接口
 *
 * 接收消息：使用飞书 WebSocket 长连接（需要飞书开放平台开启"使用长连接接收事件"）
 * 发送消息：使用飞书 IM API
 */
export class FeishuClient implements Channel {
  private config: FeishuChannelConfig;
  private tokenCache: { accessToken: string; expiresAt: number } | null = null;
  private botOpenId: string | null = null;
  private channelMessageHandler: ((context: ChannelMessageContext, message: string) => Promise<void>) | null = null;
  private wsClient: Lark.WSClient | null = null;
  // 消息去重缓存：message_id -> timestamp
  private processedMessageIds = new Map<string, number>();
  private readonly DEDUP_TTL_MS = 30000; // 30秒内的重复消息忽略

  constructor(config: FeishuChannelConfig) {
    this.config = config;
  }

  /**
   * 注册 Channel 统一消息处理器（实现 Channel 接口）
   */
  onMessage(handler: (context: ChannelMessageContext, message: string) => Promise<void>): void {
    this.channelMessageHandler = handler;
  }

  /**
   * 发送上线通知（实现 Channel 接口）
   */
  async sendOnlineNotification(userId: string, workDir: string): Promise<void> {
    const notifyText = `✅ ClaudeTalk 已上线\n📁 工作目录: ${workDir}`;
    try {
      await this.sendTextMessage(userId, notifyText, false);
    } catch (error) {
      console.error(`[feishu][notify] Failed to send online notification: ${error}`);
    }
  }

  /**
   * 获取 Tenant Access Token
   */
  async getAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now()) {
      return this.tokenCache.accessToken;
    }

    const response = await fetch(
      `${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      }
    );

    const data = (await response.json()) as FeishuTokenResponse;

    if (data.code !== 0) {
      throw new Error(`Failed to get feishu access token: ${data.msg}`);
    }

    // 缓存 token（提前 60 秒过期）
    this.tokenCache = {
      accessToken: data.tenant_access_token,
      expiresAt: Date.now() + (data.expire - 60) * 1000,
    };

    return data.tenant_access_token;
  }

  /**
   * 获取机器人自身的 open_id（用于识别群聊中 @ 机器人的消息）
   */
  private async fetchBotOpenId(): Promise<string> {
    if (this.botOpenId) {
      return this.botOpenId;
    }

    const accessToken = await this.getAccessToken();
    const response = await fetch(`${FEISHU_API_BASE}/bot/v3/info`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const data = (await response.json()) as FeishuBotInfoResponse;

    if (data.code !== 0) {
      throw new Error(`Failed to get feishu bot info: ${data.msg}`);
    }

    this.botOpenId = data.bot.open_id;
    console.error(`[feishu] Bot open_id: ${this.botOpenId}`);
    return this.botOpenId;
  }


  /**
   * 启动 WebSocket 长连接，开始接收飞书消息
   * 使用飞书官方 SDK WSClient，内部自动处理认证、心跳、重连
   */
  async start(): Promise<void> {
    if (!this.config.appId || !this.config.appSecret) {
      throw new Error(
        'Missing required feishu configuration.\n' +
        'Please set:\n' +
        '  export FEISHU_APP_ID=your_app_id\n' +
        '  export FEISHU_APP_SECRET=your_app_secret'
      );
    }

    console.error('[feishu] Connecting to Feishu WebSocket...');

    // 预先获取机器人 open_id，用于群聊 @ 检测
    await this.fetchBotOpenId();

    // 创建事件分发器，注册消息处理器
    const eventDispatcher = new Lark.EventDispatcher({});
    eventDispatcher.register({
      'im.message.receive_v1': async (data) => {
        try {
          // SDK 已解析好事件数据，直接转为内部类型处理
          await this.handleMessageEvent(data as unknown as FeishuMessageEvent);
        } catch (error) {
          console.error(`[feishu] Failed to handle message event: ${error}`);
        }
      },
    });

    // 创建 WSClient，使用官方 SDK 建立长连接（自动处理认证、心跳、重连）
    this.wsClient = new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });

    return new Promise((resolve, reject) => {
      try {
        this.wsClient!.start({ eventDispatcher });
        console.error('[feishu] WebSocket client started');
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 停止 WebSocket 连接
   */
  stop(): void {
    this.wsClient = null;
    console.error('[feishu] WebSocket stopped');
  }

  /**
   * 处理飞书消息事件
   * SDK 已通过 eventDispatcher.register 路由好事件类型，data 直接是 { sender, message }
   */
  private async handleMessageEvent(event: FeishuMessageEvent): Promise<void> {
    const { sender, message } = event;
    const isGroup = message.chat_type === 'group';

    // 消息去重：忽略 30 秒内已处理过的消息
    const messageId = message.message_id;
    const now = Date.now();
    const lastProcessed = this.processedMessageIds.get(messageId);
    if (lastProcessed && (now - lastProcessed) < this.DEDUP_TTL_MS) {
      console.error(`[feishu] Ignoring duplicate message: ${messageId}`);
      return;
    }
    this.processedMessageIds.set(messageId, now);

    // 清理过期的去重缓存
    for (const [id, timestamp] of this.processedMessageIds.entries()) {
      if (now - timestamp > this.DEDUP_TTL_MS) {
        this.processedMessageIds.delete(id);
      }
    }
    const senderId = sender.sender_id.open_id;
    const conversationId = message.chat_id;

    // 群聊策略检查
    if (isGroup) {
      const groupPolicy = this.config.groupPolicy || 'at_only';

      if (groupPolicy === 'disabled') {
        console.error('[feishu] Group chat is disabled, ignoring message');
        return;
      }

      if (groupPolicy === 'at_only') {
        // 只响应 @ 机器人的消息
        const botOpenId = await this.fetchBotOpenId();
        const isMentioned = message.mentions?.some(
          (mention) => mention.id.open_id === botOpenId
        );
        if (!isMentioned) {
          console.error('[feishu] Bot not mentioned in group, ignoring message');
          return;
        }
      }

      if (groupPolicy === 'allowlist') {
        const groupAllowFrom = this.config.groupAllowFrom || this.config.allowFrom || [];
        if (!groupAllowFrom.includes(senderId)) {
          console.error(`[feishu] Sender ${senderId} not in group allowlist, ignoring`);
          return;
        }
      }
    } else {
      // 私聊策略检查
      const dmPolicy = this.config.dmPolicy || 'open';
      if (dmPolicy === 'allowlist') {
        const allowFrom = this.config.allowFrom || [];
        if (!allowFrom.includes(senderId)) {
          console.error(`[feishu] Sender ${senderId} not in allowlist, ignoring`);
          return;
        }
      }
    }

    // 目前只处理文本消息
    if (message.message_type !== 'text') {
      console.error(`[feishu] Unsupported message type: ${message.message_type}, ignoring`);
      return;
    }

    // 解析文本内容
    let messageText = '';
    try {
      const content = JSON.parse(message.content) as FeishuTextContent;
      messageText = content.text || '';
    } catch {
      messageText = message.content;
    }

    // 群聊中去掉 @ 机器人的文本前缀（如 "@机器人名 你好" → "你好"）
    if (isGroup && message.mentions) {
      for (const mention of message.mentions) {
        messageText = messageText.replace(`@${mention.name}`, '').trim();
      }
    }

    if (!messageText.trim()) {
      console.error('[feishu] Empty message content, ignoring');
      return;
    }

    console.error(`[feishu] Received message from ${senderId} in ${conversationId}: ${messageText}`);

    if (this.channelMessageHandler) {
      // 飞书群聊默认启用上下文功能（固定 20 条历史消息）
      let contextMessage: string | undefined;
      if (isGroup) {
        console.log(`[feishu] Group chat detected, building context message...`);
        try {
          contextMessage = await this.buildContextMessage(event, messageText);
          console.log(`[feishu] Context message built successfully`);
        } catch (error) {
          console.error(`[feishu] Failed to build context message: ${error}`);
        }
      } else {
        console.log(`[feishu] Private chat, context disabled`);
      }

      const context: ChannelMessageContext = {
        conversationId,
        senderId,
        isGroup,
        userId: senderId,
        contextMessage,
      };
      await this.channelMessageHandler(context, messageText);
    }
  }

  /**
   * 获取群聊历史消息
   * 需要飞书开放平台申请 im:message:readonly 权限
   */
  private async getChatHistory(
    conversationId: string,
    limit: number
  ): Promise<Array<{
    messageId: string;
    senderOpenId: string;
    messageText: string;
    timestamp: number;
    mentions: Array<{ name: string; openId: string }>;
  }>> {
    console.log(`[feishu] Getting chat history: conversationId=${conversationId}, limit=${limit}`);
    const accessToken = await this.getAccessToken();
    const response = await fetch(
      `${FEISHU_API_BASE}/im/v1/messages?container_id_type=chat&container_id=${conversationId}&page_size=${limit}&sort_type=ByCreateTimeDesc`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    const data = (await response.json()) as {
      code: number;
      msg: string;
      data?: {
        items?: Array<{
          message_id: string;
          create_time: string;
          sender: { sender_id: { open_id: string } };
          body: { content: string };
          mentions?: Array<{ name: string; id: { open_id: string } }>;
        }>;
      };
    };

    if (data.code !== 0) {
      throw new Error(`Failed to get feishu chat history: ${data.msg}`);
    }

    const items = data.data?.items || [];
    console.log(`[feishu] Retrieved ${items.length} history messages`);
    return items.map((item) => {
      let messageText = '';
      try {
        const body = JSON.parse(item.body.content) as { text?: string };
        messageText = body.text || item.body.content;
      } catch {
        messageText = item.body.content;
      }

      return {
        messageId: item.message_id,
        senderOpenId: item.sender.sender_id.open_id,
        messageText,
        timestamp: parseInt(item.create_time),
        mentions: (item.mentions || []).map((mention) => ({
          name: mention.name,
          openId: mention.id.open_id,
        })),
      };
    });
  }

  /**
   * 构建群聊上下文消息
   * 读取模板文件，替换变量后返回完整的上下文字符串
   */
  private async buildContextMessage(
    event: FeishuMessageEvent,
    messageText: string
  ): Promise<string> {
    const { sender, message } = event;
    const conversationId = message.chat_id;
    const historySize = 5; // 固定 5 条历史消息

    console.log(`[feishu] Building context message: conversationId=${conversationId}, sender=${sender.sender_id.open_id}, message="${messageText.substring(0, 100)}..."`);

    // 获取历史消息
    const history = await this.getChatHistory(conversationId, historySize);

    // 读取模板文件（优先读取工作目录下的自定义模板，否则使用默认模板）
    const defaultTemplatePath = path.join(__dirname, '../core/context-message.template');
    const templateContent = fs.readFileSync(defaultTemplatePath, 'utf-8');

    // 构建 mentions 段落
    const currentMentions = message.mentions || [];
    console.log(`[feishu] Current message mentions: ${currentMentions.length} people`);
    const mentionsSection = currentMentions.length > 0
      ? `- **提及了**:\n${currentMentions.map((m) => `  - ${m.name} (open_id: ${m.id.open_id})`).join('\n')}`
      : '';

    // 构建历史消息段落（已按时间倒序，最新的在前）
    const historySection = history.length > 0
      ? history.map((msg) => {
          const mentionsPart = msg.mentions.length > 0
            ? `\n  - **提及了**: ${msg.mentions.map((m) => `${m.name}(${m.openId})`).join(', ')}`
            : '';
          return `- **发送者**: \`${msg.senderOpenId}\`\n  - **内容**: ${msg.messageText}${mentionsPart}`;
        }).join('\n\n')
      : '（暂无历史消息）';

    console.log(`[feishu] Context built: profileName="${this.config.profileName || '(none)'}", historySize=${historySize}, historyCount=${history.length}`);

    // 替换模板变量
    const result = templateContent
      .replace(/\{\{profileName\}\}/g, this.config.profileName || '')
      .replace(/\{\{systemPrompt\}\}/g, this.config.systemPrompt || '')
      .replace(/\{\{senderOpenId\}\}/g, sender.sender_id.open_id)
      .replace(/\{\{messageText\}\}/g, messageText)
      .replace(/\{\{mentionsSection\}\}/g, mentionsSection)
      .replace(/\{\{historySection\}\}/g, historySection);

    console.log(`[feishu] Final context message length: ${result.length} chars`);
    return result;
  }

  /**
   * 发送消息（实现 Channel 接口）
   */
  async sendMessage(
    conversationId: string,
    content: string,
    isGroup: boolean
  ): Promise<void> {
    const messageType = this.config.messageType || 'text';

    if (messageType === 'post') {
      await this.sendPostMessage(conversationId, content, isGroup);
    } else {
      await this.sendTextMessage(conversationId, content, isGroup);
    }
  }

  /**
   * 发送文本消息
   *
   * @param receiverId - 私聊时为用户 open_id，群聊时为 chat_id
   * @param isGroup - 是否群聊，决定 receive_id_type
   */
  async sendTextMessage(
    receiverId: string,
    content: string,
    isGroup: boolean
  ): Promise<FeishuSendMessageResponse> {
    const accessToken = await this.getAccessToken();
    // 无论私聊还是群聊，conversationId 都是 chat_id（oc_ 开头）
    // 飞书私聊的 p2p 会话也有 chat_id，统一用 chat_id 类型发送
    const receiveIdType = 'chat_id';
    void isGroup; // isGroup 保留参数兼容性，实际不影响发送类型

    const response = await fetch(
      `${FEISHU_API_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          receive_id: receiverId,
          msg_type: 'text',
          content: JSON.stringify({ text: content }),
        }),
      }
    );

    const data = (await response.json()) as FeishuSendMessageResponse;

    if (data.code !== 0) {
      throw new Error(`Failed to send feishu text message: ${data.msg}`);
    }

    return data;
  }

  /**
   * 发送富文本（post）消息
   *
   * 飞书不支持标准 Markdown，使用 post 类型富文本消息
   * 将内容按行拆分为段落，保留换行结构
   */
  async sendPostMessage(
    receiverId: string,
    content: string,
    isGroup: boolean
  ): Promise<FeishuSendMessageResponse> {
    const accessToken = await this.getAccessToken();
    // 无论私聊还是群聊，conversationId 都是 chat_id（oc_ 开头）
    const receiveIdType = 'chat_id';
    void isGroup;

    const postContent = {
      zh_cn: {
        title: 'Claude',
        content: content.split('\n').map((line) => [{ tag: 'text', text: line }]),
      },
    };

    const response = await fetch(
      `${FEISHU_API_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          receive_id: receiverId,
          msg_type: 'post',
          content: JSON.stringify(postContent),
        }),
      }
    );

    const data = (await response.json()) as FeishuSendMessageResponse;

    if (data.code !== 0) {
      // 降级为文本消息
      console.error(`[feishu] Failed to send post message (code=${data.code}), falling back to text: ${data.msg}`);
      return this.sendTextMessage(receiverId, content, isGroup);
    }

    return data;
  }
}

// ========== Channel 自注册 ==========

registerChannel({
  type: 'feishu',
  label: '飞书机器人',
  configFields: [
    {
      key: 'FEISHU_APP_ID',
      label: 'FEISHU_APP_ID (App ID)',
      required: true,
      hint: '在飞书开放平台 (https://open.feishu.cn) 创建应用获取',
    },
    {
      key: 'FEISHU_APP_SECRET',
      label: 'FEISHU_APP_SECRET (App Secret)',
      required: true,
      secret: true,
    },
  ],
  create(config) {
    return new FeishuClient({
      appId: config.FEISHU_APP_ID,
      appSecret: config.FEISHU_APP_SECRET,
      profileName: config.profileName,
      systemPrompt: config.systemPrompt,
    });
  },
});
