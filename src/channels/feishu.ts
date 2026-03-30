/**
 * Claude Code Feishu Channel - 飞书 API 客户端
 *
 * 使用飞书开放平台 WebSocket 长连接接收消息（类似钉钉 Stream）
 * 需要在飞书开放平台开启"使用长连接接收事件"
 * 文档: https://open.feishu.cn/document/server-docs/im-v1/message/create
 */

import type {
  Channel,
  ChannelMessageContext,
  FeishuChannelConfig,
} from '../types.js';
import { registerChannel } from './registry.js';

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

interface FeishuWsEndpointResponse {
  code: number;
  msg: string;
  data: {
    url: string;
  };
}

// 飞书 WebSocket 长连接帧
interface FeishuWsFrame {
  // type=0: 握手确认, type=1: 心跳 pong, type=2: 业务消息
  type: number;
  headers?: Record<string, string>;
  payload?: string;
}

// 飞书消息事件 payload
interface FeishuMessageEvent {
  schema: string;
  header: {
    event_id: string;
    event_type: string;
    create_time: string;
    token: string;
    app_id: string;
    tenant_key: string;
  };
  event: {
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
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private isManuallyClosed: boolean = false;
  private reconnectDelayMs: number = 3000;

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
   * 获取 WebSocket 长连接端点 URL
   */
  private async fetchWsEndpoint(): Promise<string> {
    const accessToken = await this.getAccessToken();

    const response = await fetch(`${FEISHU_API_BASE}/api/v1/ws/endpoint`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ app_id: this.config.appId }),
    });

    const data = (await response.json()) as FeishuWsEndpointResponse;

    if (data.code !== 0) {
      throw new Error(`Failed to get feishu ws endpoint: ${data.msg}`);
    }

    return data.data.url;
  }

  /**
   * 启动 WebSocket 长连接，开始接收飞书消息
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

    this.isManuallyClosed = false;
    this.reconnectDelayMs = 3000;

    await this.connectWs();
  }

  /**
   * 停止 WebSocket 连接
   */
  stop(): void {
    this.isManuallyClosed = true;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    console.error('[feishu] WebSocket stopped');
  }

  /**
   * 建立 WebSocket 长连接
   */
  private async connectWs(): Promise<void> {
    const wsUrl = await this.fetchWsEndpoint();
    console.error(`[feishu] Connecting to endpoint: ${wsUrl.substring(0, 60)}...`);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.onopen = () => {
        console.error('[feishu] WebSocket connected');
        this.reconnectDelayMs = 3000;

        // 每 30 秒发送心跳，保持连接活跃
        this.heartbeatTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 1 }));
          }
        }, 30000);

        resolve();
      };

      ws.onmessage = async (event) => {
        try {
          const frame = JSON.parse(event.data as string) as FeishuWsFrame;
          await this.handleWsFrame(ws, frame);
        } catch (error) {
          console.error(`[feishu] Failed to handle ws frame: ${error}`);
        }
      };

      ws.onerror = (error) => {
        console.error(`[feishu] WebSocket error:`, error);
      };

      ws.onclose = (event) => {
        console.error(`[feishu] WebSocket disconnected: code=${event.code}, reason=${event.reason}`);
        this.ws = null;

        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }

        if (!this.isManuallyClosed) {
          this.reconnectDelayMs = 3000;
          console.error(`[feishu] Scheduling reconnect in ${this.reconnectDelayMs}ms...`);
          this.reconnectTimer = setTimeout(() => {
            this.startReconnectLoop();
          }, this.reconnectDelayMs);
        }
      };
    });
  }

  /**
   * 启动重连循环，持续重连直到成功或手动停止
   */
  private startReconnectLoop(): void {
    const attemptReconnect = async (): Promise<void> => {
      try {
        console.error(`[feishu] Attempting to reconnect...`);
        await this.connectWs();
        console.error(`[feishu] Reconnected successfully`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[feishu] Reconnect failed: ${errorMessage}`);

        // 指数退避，最大 60 秒
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 60000);

        if (!this.isManuallyClosed) {
          console.error(`[feishu] Will retry in ${this.reconnectDelayMs}ms...`);
          this.reconnectTimer = setTimeout(attemptReconnect, this.reconnectDelayMs);
        }
      }
    };

    attemptReconnect();
  }

  /**
   * 处理 WebSocket 帧
   *
   * 飞书 WS 帧类型：
   * - type=0: 握手/连接建立确认，无需处理
   * - type=1: 心跳 pong，无需处理
   * - type=2: 业务消息（事件推送）
   */
  private async handleWsFrame(ws: WebSocket, frame: FeishuWsFrame): Promise<void> {
    console.error(`[feishu] ws frame type=${frame.type}`);

    if (frame.type === 0 || frame.type === 1) {
      return;
    }

    if (frame.type === 2 && frame.payload) {
      // 立即回 ACK，避免阻塞 WebSocket 帧循环（Claude 处理消息可能需要数十秒）
      const bizMsgId = frame.headers?.['biz-msg-unique-id'] || '';
      ws.send(JSON.stringify({
        type: 2,
        headers: { 'biz-msg-unique-id': bizMsgId },
        payload: JSON.stringify({ code: 0 }),
      }));

      // 异步处理消息，不阻塞当前帧循环，确保心跳等帧能正常响应
      Promise.resolve().then(async () => {
        try {
          const event = JSON.parse(frame.payload!) as FeishuMessageEvent;
          await this.handleMessageEvent(event);
        } catch (error) {
          console.error(`[feishu] Failed to parse message event: ${error}`);
        }
      });
    }
  }

  /**
   * 处理飞书消息事件
   */
  private async handleMessageEvent(event: FeishuMessageEvent): Promise<void> {
    // 只处理消息接收事件
    if (event.header?.event_type !== 'im.message.receive_v1') {
      console.error(`[feishu] Ignoring event type: ${event.header?.event_type}`);
      return;
    }

    const { sender, message } = event.event;
    const isGroup = message.chat_type === 'group';
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
      const context: ChannelMessageContext = {
        conversationId,
        senderId,
        isGroup,
        userId: senderId,
      };
      await this.channelMessageHandler(context, messageText);
    }
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
    const receiveIdType = isGroup ? 'chat_id' : 'open_id';

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
    const receiveIdType = isGroup ? 'chat_id' : 'open_id';

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
    });
  },
});
