/**
 * pi-dingtalkbot
 * 
 * 钉钉智能机器人 Stream 长连接扩展 for pi
 * 支持多个机器人配置和快速切换
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { DWClient, TOPIC_ROBOT, EventAck } from "dingtalk-stream";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ============================================================================
// Config
// ============================================================================

interface BotConfig {
  clientId: string;
  clientSecret: string;
  name?: string;
}

interface GlobalConfig {
  bots: BotConfig[];
}

interface SessionConfig {
  activeBotId?: string;
  enabled?: boolean;
}

// 钉钉会话上下文 - 跟踪每个用户的会话
interface DingTalkSession {
  messageId: string;      // 消息ID
  senderNick: string;      // 发送者昵称
  sessionWebhook: string;  // 会话 Webhook
  conversationId?: string; // 会话ID（用于关联主动发送的消息）
  timestamp: number;       // 最后活跃时间
}

// 等待回复的状态
interface PendingReply {
  messageId: string;        // 主动发送的消息ID
  conversationId: string;   // 会话ID
  content: string;          // 发送内容
  timestamp: number;        // 发送时间
  timeout: NodeJS.Timeout;  // 超时定时器
  resolve: (value: { reply: string; message: any }) => void;  // 成功回调
  reject: (reason: Error) => void;  // 失败回调
}

// ============================================================================
// HTTP API
// ============================================================================

async function sendMessage(sessionWebhook: string, msgtype: string, content: any): Promise<void> {
  const res = await fetch(sessionWebhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype, [msgtype]: content })
  });
  if (!res.ok) throw new Error(`发送消息失败: HTTP ${res.status}`);
}

// 检测内容是否包含 markdown 语法
function containsMarkdown(text: string): boolean {
  const markdownPatterns = [
    /^#{1,6}\s/m,           // 标题
    /\*\*.*?\*\*/,          // 粗体
    /\*.*?\*/,              // 斜体
    /`{1,3}[^`]+`{1,3}/,    // 代码
    /\[.*?\]\(.*?\)/,       // 链接
    /!\[.*?\]\(.*?\)/,      // 图片
    /^\s*[-*+]\s/m,         // 列表
    /^\s*\d+\.\s/m,         // 有序列表
    /^\s*>\s/m,             // 引用
    /\|.*\|.*\|/,           // 表格
    /-{3,}/,                // 分割线
  ];
  return markdownPatterns.some(pattern => pattern.test(text));
}

// 发送消息（自动检测类型）
async function sendReply(sessionWebhook: string, text: string): Promise<void> {
  const trimmedText = text.trim();
  if (!trimmedText) return;
  
  if (containsMarkdown(trimmedText)) {
    await sendMessage(sessionWebhook, "markdown", { title: "消息", text: trimmedText });
  } else {
    await sendMessage(sessionWebhook, "text", { content: trimmedText });
  }
}

// ============================================================================
// Utils
// ============================================================================

function getSessionId(): string {
  return process.env.PI_SESSION_ID || process.env.PI_INSTANCE_ID || 
    `sess-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;
}

function getConfigPath(): string {
  return join(homedir(), ".pi", "agent", "dingtalk-bot.json");
}

function getSessionConfigPath(sessionId: string): string {
  return join(homedir(), ".pi", "agent", `dingtalk-bot-session-${sessionId}.json`);
}

async function loadGlobalConfig(): Promise<GlobalConfig> {
  try {
    const data = JSON.parse(await readFile(getConfigPath(), "utf8"));
    return { bots: data.bots || [] };
  } catch {
    return { bots: [] };
  }
}

async function saveGlobalConfig(c: GlobalConfig) {
  await mkdir(dirname(getConfigPath()), { recursive: true });
  await writeFile(getConfigPath(), JSON.stringify(c, null, "\t") + "\n");
}

async function loadSessionConfig(): Promise<SessionConfig> {
  try {
    const data = JSON.parse(await readFile(getSessionConfigPath(SESSION_ID), "utf8"));
    return { activeBotId: data.activeBotId, enabled: data.enabled ?? true };
  } catch {
    return { enabled: true };
  }
}

async function saveSessionConfig(c: SessionConfig) {
  await mkdir(dirname(getSessionConfigPath(SESSION_ID)), { recursive: true });
  await writeFile(getSessionConfigPath(SESSION_ID), JSON.stringify(c, null, "\t") + "\n");
}

function getBotDisplayName(bot: BotConfig): string {
  return bot.name || bot.clientId;
}

const PROMPT = `
[dingtalkbot] 钉钉机器人已连接
- 收到 @机器人 的消息会自动处理
- 回复会自动发送到对应用户的会话
- 使用 dingtalkbot-attach 发送文件`;

// ============================================================================
// Extension
// ============================================================================

const SESSION_ID = getSessionId();

export default function (pi: ExtensionAPI) {
  
  let globalBots: BotConfig[] = [];
  let sessionCfg: SessionConfig = { enabled: true };
  let activeBotConfig: BotConfig | null = null;
  let currentCtx: ExtensionContext | null = null;
  let client: DWClient | null = null;
  let connected = false;

  // 钉钉会话映射表 - 用于回复时找到对应的 webhook
  const dingTalkSessions = new Map<string, DingTalkSession>();

  // 【增强3】会话独立队列 - 按会话分组，不同用户独立处理
  const sessionQueues = new Map<string, Array<{
    messageId: string;
    senderNick: string;
    sessionWebhook: string;
    content: string;
    botName: string;
    timestamp: number;
  }>>();
  const sessionProcessing = new Map<string, boolean>();

  // 兼容旧接口 - 保留全局队列用于某些场景
  const messageQueue: Array<{
    messageId: string;
    senderNick: string;
    sessionWebhook: string;
    content: string;
    botName: string;
  }> = [];

  // 等待回复的状态存储
  const pendingReplies = new Map<string, PendingReply>();
  const PENDING_CLEANUP_INTERVAL = 60 * 1000; // 1分钟清理一次

  // 消息超时跟踪（防止 agent_end 不触发导致卡住）
  const messageTimeouts = new Map<string, NodeJS.Timeout>();
  const MESSAGE_TIMEOUT = 5 * 60 * 1000; // 5分钟超时

  // 已处理的消息ID（用于去重，防止同一消息被处理多次）
  const processedMessages = new Set<string>();
  const PROCESSED_CLEANUP_INTERVAL = 60 * 1000; // 1分钟清理一次
  const PROCESSED_MESSAGE_TTL = 10 * 60 * 1000; // 10分钟后从记录中移除

  // 当前正在处理的消息ID（用于等待处理完成）
  let currentProcessingMessageId: string | null = null;
  let isProcessing = false;

  // 【增强2】处理进度通知 - 10秒后发送进度提示
  const PROGRESS_NOTIFY_DELAY = 10 * 1000; // 10秒

  // 获取指定会话的队列长度（前面还有几条消息）
  function getSessionQueueLength(conversationId: string): number {
    return sessionQueues.get(conversationId)?.length || 0;
  }

  // 会话是否正在处理
  function isSessionProcessing(conversationId: string): boolean {
    return sessionProcessing.get(conversationId) || false;
  }

  // 设置会话处理状态
  function setSessionProcessing(conversationId: string, processing: boolean) {
    sessionProcessing.set(conversationId, processing);
  }

  // 生成唯一消息ID
  function generateMessageId(): string {
    return `msg-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;
  }

  // 从 webhook 提取会话标识
  function extractConversationId(webhook: string): string {
    // webhook 格式: https://oapi.dingtalk.com/robot/send?access_token=xxx
    // 使用 access_token 作为会话标识
    const match = webhook.match(/access_token=([^&]+)/);
    return match?.[1] || webhook;
  }

  // 查找会话是否有等待中的回复
  function hasPendingReply(conversationId: string): boolean {
    for (const pending of pendingReplies.values()) {
      if (pending.conversationId === conversationId) {
        return true;
      }
    }
    return false;
  }

  // 查找并处理匹配的待回复
  function handlePendingReply(conversationId: string, content: string, message: any): boolean {
    for (const [id, pending] of pendingReplies) {
      if (pending.conversationId === conversationId) {
        clearTimeout(pending.timeout);
        pendingReplies.delete(id);
        pending.resolve({ reply: content, message });
        return true;
      }
    }
    return false;
  }

  // 清理超时的待回复
  function cleanupPendingReplies() {
    const now = Date.now();
    const TIMEOUT = 5 * 60 * 1000; // 5分钟超时
    for (const [id, pending] of pendingReplies) {
      if (now - pending.timestamp > TIMEOUT) {
        clearTimeout(pending.timeout);
        pendingReplies.delete(id);
        pending.reject(new Error("等待回复超时"));
      }
    }
  }

  // 启动定期清理
  const cleanupInterval = setInterval(cleanupPendingReplies, PENDING_CLEANUP_INTERVAL);

  // 清理已处理消息记录
  function cleanupProcessedMessages() {
    // 定期清理过期的已处理记录，防止内存泄漏
    // 注意：这里只是简单记录，10分钟后自动过期
  }

  // 检查消息是否已处理过
  function isMessageProcessed(messageId: string): boolean {
    return processedMessages.has(messageId);
  }

  // 标记消息已处理
  function markMessageProcessed(messageId: string) {
    processedMessages.add(messageId);
    // 10分钟后自动移除（简化处理，不使用额外定时器）
    setTimeout(() => {
      processedMessages.delete(messageId);
    }, PROCESSED_MESSAGE_TTL);
  }

  // 【增强2】发送处理进度通知
  async function sendProgressNotification(
    messageId: string,
    sessionWebhook: string,
    senderNick: string
  ): Promise<void> {
    if (currentProcessingMessageId !== messageId) return; // 消息已被处理完
    

    await sendReply(sessionWebhook, `⏳ 还在处理中，请稍候...`);
  }

  // 【增强3】处理队列中下一条消息（会话独立版）
  async function processNextForSession(conversationId: string): Promise<void> {
    const queue = sessionQueues.get(conversationId);
    if (!queue || queue.length === 0) return;
    
    // 该会话是否正在处理
    if (isSessionProcessing(conversationId)) return;
    setSessionProcessing(conversationId, true);
    
    const msg = queue.shift()!;
    const { messageId, senderNick, sessionWebhook, content, botName } = msg;
    
    currentProcessingMessageId = messageId;
    isProcessing = true;
    
    try {
      // 存储会话上下文
      dingTalkSessions.set(messageId, {
        messageId,
        senderNick,
        sessionWebhook,
        conversationId,
        timestamp: Date.now()
      });

      // 发送给 pi 处理
      const messageText = `[dingtalkbot] [${botName}] [${senderNick}] [${messageId}]\n${content}`;
      
      try {
        // @ts-ignore
        await pi.sendUserMessage([{ type: "text", text: messageText }], { deliverAs: "steer" });
        
        // 设置进度通知定时器（10秒后发送）
        const progressTimeoutId = setTimeout(() => {
          sendProgressNotification(messageId, sessionWebhook, senderNick);
        }, PROGRESS_NOTIFY_DELAY);
        messageTimeouts.set(messageId + '_progress', progressTimeoutId);
        
        // 设置超时保护（防止 agent_end 不触发导致卡住）
        const timeoutId = setTimeout(() => {
          console.log(`[dingtalkbot] 消息 ${messageId.slice(0, 8)}... 处理超时`);
          if (currentProcessingMessageId === messageId) {
            isProcessing = false;
            currentProcessingMessageId = null;
            dingTalkSessions.delete(messageId);
            messageTimeouts.delete(messageId);
            messageTimeouts.delete(messageId + '_progress');
            setSessionProcessing(conversationId, false);
            // 继续处理该会话的下一条消息
            processNextForSession(conversationId);
          }
        }, MESSAGE_TIMEOUT);
        messageTimeouts.set(messageId, timeoutId);
        
      } catch (err) {
        console.error('[dingtalkbot] 发送给 pi 失败:', err);
        isProcessing = false;
        currentProcessingMessageId = null;
        setSessionProcessing(conversationId, false);
        processNextForSession(conversationId);
      }
    } catch (err) {
      console.error('[dingtalkbot] 处理消息失败:', err);
      isProcessing = false;
      currentProcessingMessageId = null;
      setSessionProcessing(conversationId, false);
      processNextForSession(conversationId);
    }
  }

  // 发送消息并等待回复
  async function sendAndWait(
    sessionWebhook: string,
    content: string,
    options?: { timeout?: number }
  ): Promise<{ reply: string; message: any }> {
    const conversationId = extractConversationId(sessionWebhook);
    
    // 检查是否已有等待中的回复
    if (hasPendingReply(conversationId)) {
      throw new Error("该会话已有等待中的消息，请等待用户回复或取消等待");
    }

    const msgId = generateMessageId();
    
    // 先发送消息
    await sendReply(sessionWebhook, content);
    
    return new Promise((resolve, reject) => {
      const timeoutMs = (options?.timeout || 300) * 1000; // 默认5分钟
      
      const timeout = setTimeout(() => {
        pendingReplies.delete(msgId);
        reject(new Error(`等待回复超时（${options?.timeout || 300}秒）`));
      }, timeoutMs);
      
      pendingReplies.set(msgId, {
        messageId: msgId,
        conversationId,
        content,
        timestamp: Date.now(),
        timeout,
        resolve,
        reject
      });
    });
  }

  // 处理队列中下一条消息
  async function processNextMessage(): Promise<void> {
    if (isProcessing) return;
    if (messageQueue.length === 0) return;
    
    isProcessing = true;
    const msg = messageQueue.shift()!;
    const { messageId, senderNick, sessionWebhook, content, botName } = msg;
    
    currentProcessingMessageId = messageId;
    
    try {
      const conversationId = extractConversationId(sessionWebhook);
      // 存储会话上下文
      dingTalkSessions.set(messageId, {
        messageId,
        senderNick,
        sessionWebhook,
        conversationId,
        timestamp: Date.now()
      });

      // 发送给 pi 处理
      const messageText = `[dingtalkbot] [${botName}] [${senderNick}] [${messageId}]\n${content}`;
      
      try {
        // @ts-ignore
        await pi.sendUserMessage([{ type: "text", text: messageText }], { deliverAs: "steer" });
        
        // 设置超时保护（防止 agent_end 不触发导致卡住）
        const timeoutId = setTimeout(() => {
          console.log(`[dingtalkbot] 消息 ${messageId.slice(0, 8)}... 处理超时`);
          if (currentProcessingMessageId === messageId) {
            isProcessing = false;
            currentProcessingMessageId = null;
            dingTalkSessions.delete(messageId);
            messageTimeouts.delete(messageId);
            processNextMessage();
          }
        }, MESSAGE_TIMEOUT);
        messageTimeouts.set(messageId, timeoutId);
        
      } catch (err) {
        console.error('[dingtalkbot] 发送给 pi 失败:', err);
        // 发送失败，继续处理下一条
        isProcessing = false;
        currentProcessingMessageId = null;
        processNextMessage();
      }
    } catch (err) {
      console.error('[dingtalkbot] 处理消息失败:', err);
      isProcessing = false;
      currentProcessingMessageId = null;
      processNextMessage();
    }
    // 注意：isProcessing 保持 true，直到 agent_end 处理完成
  }

  // ============================================================================
  // Connection
  // ============================================================================

  async function connect(ctx: ExtensionContext, bot: BotConfig): Promise<boolean> {
    try {
      disconnect();
      currentCtx = ctx;
      activeBotConfig = bot;
      
      // @ts-ignore
      client = new DWClient({ clientId: bot.clientId, clientSecret: bot.clientSecret });

      client.registerCallbackListener(TOPIC_ROBOT, async (res) => {
        try {
          const message = JSON.parse(res.data);
          const content = message?.text?.content;
          if (!content) return { status: EventAck.SUCCESS };

          const messageId = message.msgId || generateMessageId();
          const senderNick = message.senderNick || "未知用户";
          const sessionWebhook = message.sessionWebhook || "";
          const conversationId = message.conversationId || extractConversationId(sessionWebhook);
          const botName = getBotDisplayName(bot);

          // 检查是否有等待该会话回复的消息
          if (handlePendingReply(conversationId, content, message)) {
            return { status: EventAck.SUCCESS };
          }

          // 【去重检查】防止同一消息被重复处理
          if (isMessageProcessed(messageId)) {
            return { status: EventAck.SUCCESS };
          }
          markMessageProcessed(messageId);

          // 【增强1&3】使用会话独立队列
          if (!sessionQueues.has(conversationId)) {
            sessionQueues.set(conversationId, []);
          }
          const queue = sessionQueues.get(conversationId)!;
          const queueLength = queue.length;
          
          // 消息入队到会话队列
          queue.push({ messageId, senderNick, sessionWebhook, content, botName, timestamp: Date.now() });


          // 【增强1】显示队列位置，让用户知道前面还有多少消息
          const queuePosition = queueLength + 1;
          let ackMessage = "👋 收到";
          if (queuePosition > 1) {
            ackMessage = `👋 收到，你是第 ${queuePosition} 位，前面还有 ${queueLength} 条消息...`;
          } else if (isSessionProcessing(conversationId)) {
            ackMessage = `👋 收到，正在处理中...`;
          } else {
            ackMessage = `👋 收到，正在思考中...`;
          }
          await sendReply(sessionWebhook, ackMessage);


          // 【增强3】启动该会话的处理（会话独立，不会阻塞其他会话）
          processNextForSession(conversationId);

          return { status: EventAck.SUCCESS };
        } catch (err) {
          console.error('[dingtalkbot] 解析消息失败:', err);
          return { status: EventAck.SUCCESS };
        }
      });

      client.on("connect", () => {
        connected = true;
        setStatus();
      });

      client.on("disconnect", (reason: any) => {
        const wasConnected = connected;
        connected = false;
        dingTalkSessions.clear();
        
        const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason);
        const isKicked = reasonStr?.includes("kick") || reasonStr?.includes("replaced") || reasonStr?.includes("403");
        
        console.log(`[dingtalkbot] ❌ ${getBotDisplayName(bot)} ${isKicked ? "被踢" : "断开"}${reasonStr ? `: ${reasonStr}` : ""}`);
        setStatus(wasConnected && isKicked ? `被踢 (${SESSION_ID.slice(0, 4)})` : undefined);
      });

      client.on("error", (err: any) => {
        const errMsg = String(err);
        connected = false;
        console.log(`[dingtalkbot] ❌ ${getBotDisplayName(bot)}`, err);
        
        if (errMsg.includes("already connected") || errMsg.includes("403")) {
          setStatus("连接被占用");
          currentCtx?.ui.notify(`❌ ${getBotDisplayName(bot)} 已被其他会话连接`, "error");
        } else {
          setStatus(errMsg);
        }
      });

      await client.connect();
      connected = true;
      setStatus();
      return true;
    } catch (err) {
      console.error(`[dingtalkbot] 连接异常:`, err);
      connected = false;
      setStatus("连接异常");
      return false;
    }
  }

  function disconnect() {
    // 清理所有等待中的回复
    for (const [id, pending] of pendingReplies) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("机器人已断开连接"));
    }
    pendingReplies.clear();
    
    // 清理定时器
    clearInterval(cleanupInterval);
    
    dingTalkSessions.clear();
    if (client) { 
      try { client.disconnect(); } catch {}
      client = null; 
    }
    connected = false;
    activeBotConfig = null;
  }

  function setStatus(msg?: string) {
    if (!currentCtx) return;
    
    const active = globalBots.find(b => b.clientId === sessionCfg.activeBotId) || globalBots[0];
    if (!active || !connected) {
      currentCtx.ui.setStatus("dingtalkbot", "");
      return;
    }
    
    const botName = getBotDisplayName(active);
    currentCtx.ui.setStatus("dingtalkbot", 
      msg ? `${botName} 🔴 ${msg}` : `${botName} ✅`
    );
  }

  // ============================================================================
  // Tools
  // ============================================================================

  function getLatestSession(): DingTalkSession | null {
    let latest: DingTalkSession | null = null;
    for (const session of dingTalkSessions.values()) {
      if (!latest || session.timestamp > latest.timestamp) {
        latest = session;
      }
    }
    return latest;
  }

  pi.registerTool({
    name: "dingtalkbot-attach",
    label: "发送文件",
    description: "发送本地文件到钉钉（转为链接形式）",
    parameters: Type.Object({ 
      paths: Type.Array(Type.String(), { minItems: 1, maxItems: 10 }),
      messageId: Type.Optional(Type.String()),
    }),
    async execute(_id, p) {
      if (!client || !connected) throw new Error("机器人未连接");
      
      const targetMsgId = p.messageId;
      const session = targetMsgId ? dingTalkSessions.get(targetMsgId) : getLatestSession();
      if (!session) throw new Error("无活跃会话");
      
      const files: string[] = [];
      for (const fp of p.paths) {
        try { if ((await stat(fp)).isFile()) files.push(basename(fp)); } catch {}
      }
      if (files.length === 0) throw new Error("没有有效的文件");
      
      const text = `📎 文件列表:\n${files.map(f => `- ${f}`).join("\n")}\n\n（钉钉机器人暂不支持直接发送文件附件）`;
      await sendMessage(session.sessionWebhook, "text", { content: text });
      return { content: [{ type: "text", text: `已发送 ${files.length} 个文件信息` }], details: {} };
    },
  });

  pi.registerTool({
    name: "dingtalkbot-send",
    label: "发送消息",
    description: "发送消息到钉钉",
    parameters: Type.Object({
      message: Type.String(),
      format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("markdown")], { default: "text" })),
      messageId: Type.Optional(Type.String()),
    }),
    async execute(_id, p) {
      if (!client || !connected) throw new Error("机器人未连接");
      
      const targetMsgId = p.messageId;
      const session = targetMsgId ? dingTalkSessions.get(targetMsgId) : getLatestSession();
      if (!session) throw new Error("无活跃会话");
      
      if (p.format === "markdown") {
        await sendMessage(session.sessionWebhook, "markdown", { title: "消息", text: p.message });
      } else {
        await sendMessage(session.sessionWebhook, "text", { content: p.message });
      }
      return { content: [{ type: "text", text: "✅ 已发送" }], details: {} };
    },
  });

  pi.registerTool({
    name: "dingtalkbot-send-and-wait",
    label: "发送并等待回复",
    description: "发送消息到钉钉并等待用户回复，超时后自动取消",
    parameters: Type.Object({
      message: Type.String({ description: "要发送的消息内容" }),
      timeout: Type.Optional(Type.Number({ default: 300, description: "等待超时时间（秒），默认300秒（5分钟）" })),
      format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("markdown")], { default: "text" })),
      messageId: Type.Optional(Type.String({ description: "指定会话的消息ID，不传则发送到最新会话" })),
    }),
    async execute(_id, p) {
      if (!client || !connected) throw new Error("机器人未连接");
      
      const targetMsgId = p.messageId;
      const session = targetMsgId ? dingTalkSessions.get(targetMsgId) : getLatestSession();
      if (!session) throw new Error("无活跃会话，请先与机器人对话或指定messageId");
      
      const sendContent = p.message;
      
      try {
        // 发送消息并等待回复
        const result = await sendAndWait(session.sessionWebhook, sendContent, { timeout: p.timeout });
        
        // 提取用户回复的关键信息
        const replyPreview = result.reply.slice(0, 100);
        const replyText = result.reply.length > 100 ? replyPreview + "..." : replyPreview;
        
        return { 
          content: [{ 
            type: "text", 
            text: `📨 已收到回复 (${Math.round((Date.now() - (result.message as any).createTime) / 1000)}秒):\n${replyText}` 
          }],
          details: { 
            reply: result.reply,
            message: result.message,
            senderNick: result.message.senderNick,
            sendContent: sendContent,
          }
        };
      } catch (err: any) {
        if (err.message.includes("超时")) {
          return { 
            content: [{ type: "text", text: `⏱️ ${err.message}` }], 
            details: { timeout: p.timeout || 300, error: err.message, reply: '', message: null, senderNick: '', sendContent: '' }
          } as any;
        }
        throw err;
      }
    },
  });

  pi.registerTool({
    name: "dingtalkbot-cancel-wait",
    label: "取消等待",
    description: "取消指定会话的等待状态",
    parameters: Type.Object({
      messageId: Type.Optional(Type.String({ description: "会话的消息ID，不传则取消最新会话的等待" })),
    }),
    async execute(_id, p) {
      if (!client || !connected) throw new Error("机器人未连接");
      
      const targetMsgId = p.messageId;
      const session = targetMsgId ? dingTalkSessions.get(targetMsgId) : getLatestSession();
      if (!session) throw new Error("无活跃会话");
      
      const conversationId = extractConversationId(session.sessionWebhook);
      let cancelled = false;
      
      for (const [id, pending] of pendingReplies) {
        if (pending.conversationId === conversationId) {
          clearTimeout(pending.timeout);
          pendingReplies.delete(id);
          pending.reject(new Error("等待被取消"));
          cancelled = true;
          break;
        }
      }
      
      return { 
        content: [{ type: "text", text: cancelled ? "✅ 已取消等待" : "ℹ️ 该会话没有等待中的消息" }], 
        details: { cancelled, conversationId }
      };
    },
  });

  // ============================================================================
  // Commands
  // ============================================================================

  pi.registerCommand("dingtalkbot-add", {
    description: "添加机器人",
    handler: async (_args, ctx) => {
      const name = await ctx.ui.input("机器人名称(可选)", "");
      const clientId = await ctx.ui.input("ClientID", "dingxxxxxxxxxxxxxxxx");
      if (!clientId) return;
      const clientSecret = await ctx.ui.input("ClientSecret", "");
      if (!clientSecret) return;

      const globalCfg = await loadGlobalConfig();
      if (globalCfg.bots.find(b => b.clientId === clientId.trim())) {
        ctx.ui.notify("❌ 该机器人已存在", "error");
        return;
      }
      
      const newBot: BotConfig = { 
        clientId: clientId.trim(), 
        clientSecret: clientSecret.trim(), 
        name: name?.trim() || undefined 
      };
      globalCfg.bots.push(newBot);
      await saveGlobalConfig(globalCfg);
      globalBots = globalCfg.bots;
      
      if (!sessionCfg.activeBotId) {
        sessionCfg.activeBotId = clientId.trim();
        await saveSessionConfig(sessionCfg);
      }
      
      ctx.ui.notify(`✅ 已添加 ${name || getBotDisplayName(newBot)}`, "info");
      await connect(ctx, newBot);
    },
  });

  pi.registerCommand("dingtalkbot-list", {
    description: "列出所有机器人",
    handler: async (_args, ctx) => {
      globalBots = (await loadGlobalConfig()).bots;
      
      if (globalBots.length === 0) {
        ctx.ui.notify("暂无配置的机器人", "info");
        return;
      }
      
      const list = globalBots.map(b => {
        const isActive = b.clientId === sessionCfg.activeBotId;
        return `${isActive ? "▶" : "○"} ${getBotDisplayName(b)}`;
      }).join("\n");
      
      const activeBot = globalBots.find(b => b.clientId === sessionCfg.activeBotId);
      ctx.ui.notify(`机器人列表:\n${list}`, "info");
    },
  });

  pi.registerCommand("dingtalkbot-use", {
    description: "切换机器人",
    handler: async (_args, ctx) => {
      globalBots = (await loadGlobalConfig()).bots;
      
      if (globalBots.length === 0) {
        ctx.ui.notify("暂无配置的机器人", "warning");
        return;
      }
      
      const options = globalBots.map(b => `${b.clientId === sessionCfg.activeBotId ? "▶ " : "○ "}${getBotDisplayName(b)}`);
      const selected = await ctx.ui.select("选择机器人", options);
      if (!selected) return;
      
      const label = selected.replace(/^[▶○] /, "");
      const bot = globalBots.find(b => getBotDisplayName(b) === label || b.clientId === label);
      if (!bot) return;

      sessionCfg.activeBotId = bot.clientId;
      await saveSessionConfig(sessionCfg);
      
      ctx.ui.notify(`✅ 已切换到 ${getBotDisplayName(bot)}`, "info");
      await connect(ctx, bot);
    },
  });

  pi.registerCommand("dingtalkbot-remove", {
    description: "删除机器人",
    handler: async (_args, ctx) => {
      globalBots = (await loadGlobalConfig()).bots;
      
      if (globalBots.length === 0) {
        ctx.ui.notify("暂无配置的机器人", "warning");
        return;
      }
      
      const name = await ctx.ui.input("输入要删除的 ClientID 或名称", "");
      if (!name) return;

      const idx = globalBots.findIndex(b => b.clientId === name || b.name === name);
      if (idx === -1) {
        ctx.ui.notify("❌ 机器人不存在", "error");
        return;
      }

      const removed = globalBots.splice(idx, 1)[0];
      await saveGlobalConfig({ bots: globalBots });
      
      if (sessionCfg.activeBotId === removed.clientId) {
        disconnect();
        const nextBot = globalBots[0];
        sessionCfg.activeBotId = nextBot?.clientId;
        await saveSessionConfig(sessionCfg);
        
        if (nextBot) {
          ctx.ui.notify(`✅ 已删除，切换到 ${getBotDisplayName(nextBot)}`, "info");
          await connect(ctx, nextBot);
        } else {
          ctx.ui.notify(`✅ 已删除`, "info");
        }
      } else {
        ctx.ui.notify(`✅ 已删除 ${getBotDisplayName(removed)}`, "info");
      }
    },
  });

  pi.registerCommand("dingtalkbot-status", {
    description: "查看机器人状态",
    handler: async (_args, ctx) => {
      globalBots = (await loadGlobalConfig()).bots;
      const active = globalBots.find(b => b.clientId === sessionCfg.activeBotId);
      
      if (!active) {
        ctx.ui.notify(`机器人: ${globalBots.length} 个\n状态: 未选择`, "info");
        return;
      }
      
      const status = !sessionCfg.enabled ? "🔴 禁用" : connected ? "✅ 已连接" : "❌ 已断开";
      ctx.ui.notify(`${status}\n机器人: ${getBotDisplayName(active)}`, "info");
    },
  });

  pi.registerCommand("dingtalkbot-enable", {
    description: "启用机器人",
    handler: async (_args, ctx) => {
      sessionCfg.enabled = true;
      await saveSessionConfig(sessionCfg);
      
      const bot = globalBots.find(b => b.clientId === sessionCfg.activeBotId) || globalBots[0];
      if (bot) {
        await connect(ctx, bot);
        ctx.ui.notify(`✅ 已启用 ${getBotDisplayName(bot)}`, "info");
      }
    },
  });

  pi.registerCommand("dingtalkbot-disable", {
    description: "禁用机器人",
    handler: async (_args, ctx) => {
      sessionCfg.enabled = false;
      await saveSessionConfig(sessionCfg);
      disconnect();
      ctx.ui.notify("🔌 已禁用", "info");
    },
  });

  // ============================================================================
  // Events
  // ============================================================================

  pi.on("session_start", async (_e, ctx) => {
    try {
      globalBots = (await loadGlobalConfig()).bots;
      sessionCfg = await loadSessionConfig();
      
      if (sessionCfg.enabled && sessionCfg.activeBotId) {
        const bot = globalBots.find(b => b.clientId === sessionCfg.activeBotId);
        if (bot) await connect(ctx, bot);
      }
      setStatus();
    } catch (err) {
      console.error(`[dingtalkbot] session_start 异常:`, err);
    }
  });

  pi.on("session_shutdown", () => disconnect());

  pi.on("before_agent_start", async (e) => ({
    systemPrompt: e.systemPrompt + PROMPT,
  }));

  pi.on("agent_end", async (e) => {
    setStatus();
    
    const msg = e.messages[e.messages.length - 1] as any;
    const txt = (msg?.content as any[])?.find((b: any) => b.type === "text")?.text;
    if (!txt?.trim()) return;
    
    // 从回复中提取 messageId
    // 格式: [dingtalkbot] [机器人名] [用户昵称] [messageId]
    const match = txt.match(/\[dingtalkbot\] \[.*?\] \[.*?\] \[(.+?)\]\n/);
    const messageId = match?.[1];
    const content = messageId ? txt.replace(match[0], "") : txt;
    
    if (!content.trim()) return;
    
    // 找到对应的会话并回复
    let session: DingTalkSession | null | undefined;
    
    if (messageId) {
      session = dingTalkSessions.get(messageId);
    }
    
    // 如果没找到，使用最新的会话
    if (!session) {
      session = getLatestSession();
    }
    
    if (session) {
      await sendReply(session.sessionWebhook, content.trim());

      // 回复后删除会话记录
      dingTalkSessions.delete(session.messageId);
      
      // 【增强3】清除进度通知定时器
      if (messageId) {
        const timeoutId = messageTimeouts.get(messageId);
        if (timeoutId) {
          clearTimeout(timeoutId);
          messageTimeouts.delete(messageId);
        }
        const progressTimeoutId = messageTimeouts.get(messageId + '_progress');
        if (progressTimeoutId) {
          clearTimeout(progressTimeoutId);
          messageTimeouts.delete(messageId + '_progress');
        }
      }
      
      // 【增强3】继续处理该会话的下一条消息
      if (session.conversationId) {
        const conversationId = session.conversationId;
        isProcessing = false;
        currentProcessingMessageId = null;
        setSessionProcessing(conversationId, false);
        processNextForSession(conversationId);
      }
    }
  });
}
