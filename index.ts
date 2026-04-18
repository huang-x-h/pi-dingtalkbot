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
  timestamp: number;       // 最后活跃时间
  hasReplied: boolean;     // 是否已回复（避免重复）
  queueNoticeSent?: boolean; // 是否已发送排队提示
}

// ============================================================================
// HTTP API
// ============================================================================

// 钉钉消息类型限制
const DINGTALK_TEXT_LIMIT = 2048;
const DINGTALK_MARKDOWN_LIMIT = 4096;

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
  // 检测常见的 markdown 语法
  const markdownPatterns = [
    /^#{1,6}\s/m,           // 标题: # ## ###
    /\*\*.*?\*\*/,          // 粗体: **text**
    /\*.*?\*/,              // 斜体: *text*
    /`{1,3}[^`]+`{1,3}/,    // 代码: `code` 或 ```code```
    /\[.*?\]\(.*?\)/,       // 链接: [text](url)
    /!\[.*?\]\(.*?\)/,      // 图片: ![alt](url)
    /^\s*[-*+]\s/m,         // 列表: - item
    /^\s*\d+\.\s/m,         // 有序列表: 1. item
    /^\s*>\s/m,             // 引用: > quote
    /\|.*\|.*\|/,           // 表格: | a | b |
    /-{3,}/,                // 分割线: ---
  ];
  
  return markdownPatterns.some(pattern => pattern.test(text));
}

// 发送消息（自动检测类型，不拆分）
async function sendReply(sessionWebhook: string, text: string): Promise<void> {
  const trimmedText = text.trim();
  if (!trimmedText) return;
  
  // 检测是否包含 markdown 语法
  const isMarkdown = containsMarkdown(trimmedText);
  
  if (isMarkdown) {
    // 使用 markdown 类型，不拆分
    await sendMessage(sessionWebhook, "markdown", { 
      title: "消息", 
      text: trimmedText 
    });
  } else {
    // 使用 text 类型，不拆分
    await sendMessage(sessionWebhook, "text", { content: trimmedText });
  }
}

// 发送长文本消息，自动拆分（仅 text 类型）
async function sendLongText(sessionWebhook: string, text: string): Promise<void> {
  const limit = DINGTALK_TEXT_LIMIT - 20; // 预留空间给序号
  
  if (text.length <= limit) {
    await sendMessage(sessionWebhook, "text", { content: text });
    return;
  }
  
  // 计算需要拆分的条数
  const totalChunks = Math.ceil(text.length / limit);
  let sent = 0;
  
  while (sent < text.length) {
    const chunk = text.slice(sent, sent + limit);
    const isFirst = sent === 0;
    const isLast = sent + limit >= text.length;
    const current = Math.floor(sent / limit) + 1;
    
    // 构造带序号的消息
    let msg = chunk;
    if (totalChunks > 1) {
      if (isFirst) {
        msg = `[(${current}/${totalChunks})]
${chunk}`;
      } else if (isLast) {
        msg = `[(${current}/${totalChunks})]
${chunk}`;
      } else {
        msg = `[(${current}/${totalChunks})]
${chunk}`;
      }
    }
    
    await sendMessage(sessionWebhook, "text", { content: msg });
    sent += limit;
    
    // 如果还有更多内容，添加短暂延迟避免频率限制
    if (sent < text.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
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

  // 钉钉会话映射表 - 按 messageId 索引
  const dingTalkSessions = new Map<string, DingTalkSession>();

  // 每个会话独立的处理状态
  const pendingMessages = new Map<string, {
    resolve: () => void;
    sessionWebhook: string;
    senderNick: string;
  }>();

  // 消息队列 - 使用数组存储待处理消息
  const messageQueue: Array<{
    messageId: string;
    senderNick: string;
    sessionWebhook: string;
    content: string;
    botName: string;
  }> = [];
  
  // 正在处理的消息ID
  let currentProcessingMessageId: string | null = null;
  let isProcessing = false;
  
  // ============================================================================
  // 消息处理核心逻辑
  // ============================================================================

  // 处理单条消息（等待完整处理完成，包括AI回复）
  async function processSingleMessage(
    messageId: string,
    senderNick: string,
    sessionWebhook: string,
    content: string,
    botName: string
  ): Promise<void> {
    currentProcessingMessageId = messageId;
    
    try {
      // 发送思考中提示
      try { 
        await sendMessage(sessionWebhook, "text", { content: "🤔 思考中..." }); 
      } catch {}

      // 构造消息，格式：[dingtalkbot] [机器人名] [用户昵称] [messageId]\n内容
      const messageText = `[dingtalkbot] [${botName}] [${senderNick}] [${messageId}]\n${content}`;
      
      // 创建一个 Promise 来等待 AI 回复
      const waitForReply = new Promise<void>((resolve) => {
        pendingMessages.set(messageId, {
          resolve,
          sessionWebhook,
          senderNick
        });
      });
      
      // 发送给 AI 处理，添加重试逻辑
      let retries = 0;
      const maxRetries = 5;
      let sent = false;
      
      while (retries < maxRetries && !sent) {
        try {
          // @ts-ignore
          await pi.sendUserMessage([{ type: "text", text: messageText }], { deliverAs: "steer" });
          sent = true;
        } catch (err: any) {
          if (err?.message?.includes("already processing")) {
            retries++;
            console.log(`[dingtalkbot] Agent 忙，${retries}/${maxRetries} 重试...`);
            await new Promise(r => setTimeout(r, 1000)); // 等待 1 秒
          } else {
            // 其他错误，记录并退出
            console.error(`[dingtalkbot] 发送消息失败:`, err?.message);
            pendingMessages.delete(messageId);
            throw err;
          }
        }
      }
      
      if (!sent) {
        pendingMessages.delete(messageId);
        throw new Error("无法发送消息给 AI");
      }
      
      // 等待 AI 回复（最多等待 5 分钟）
      const timeoutPromise = new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error("等待 AI 回复超时")), 5 * 60 * 1000);
      });
      
      await Promise.race([waitForReply, timeoutPromise]);
      
    } finally {
      currentProcessingMessageId = null;
      pendingMessages.delete(messageId);
    }
  }

  async function processNextMessage(): Promise<void> {
    if (isProcessing) {
      console.log(`[dingtalkbot] 消息处理器正忙，等待...`);
      return;
    }
    
    if (messageQueue.length === 0) return;
    
    isProcessing = true;
    
    try {
      // 使用 while 循环顺序处理队列中的所有消息
      while (messageQueue.length > 0) {
        const { messageId, senderNick, sessionWebhook, content, botName } = messageQueue.shift()!;
        
        console.log(`[dingtalkbot] 处理消息 [${messageId.slice(0, 8)}...] 队列剩余: ${messageQueue.length}`);
        
        try {
          await processSingleMessage(messageId, senderNick, sessionWebhook, content, botName);
          console.log(`[dingtalkbot] 消息 [${messageId.slice(0, 8)}...] 处理完成`);
        } catch (err) {
          console.error(`[dingtalkbot] 处理消息 [${messageId.slice(0, 8)}...] 失败:`, err);
          // 继续处理下一条消息
        }
      }
    } finally {
      isProcessing = false;
      // 检查是否有新消息加入队列
      if (messageQueue.length > 0) {
        // 使用 setTimeout 避免递归调用栈过深
        setTimeout(() => processNextMessage(), 0);
      }
    }
  }

  function queueDingTalkMessage(
    messageId: string,
    senderNick: string,
    sessionWebhook: string,
    content: string,
    botName: string
  ): void {
    // 统计同一会话在队列中的消息数量（同一用户/群组）
    const sessionQueueCount = messageQueue.filter(m => m.sessionWebhook === sessionWebhook).length;
    
    // 检查当前正在处理的消息是否属于同一会话
    let isProcessingSameSession = false;
    if (isProcessing && currentProcessingMessageId) {
      const currentSession = dingTalkSessions.get(currentProcessingMessageId);
      if (currentSession && currentSession.sessionWebhook === sessionWebhook) {
        isProcessingSameSession = true;
      }
    }
    
    // 只有同一会话忙碌时才提示（不同会话的用户不互相影响）
    const isSessionBusy = isProcessingSameSession || sessionQueueCount > 0;
    const queuePosition = sessionQueueCount + 1; // 在同一会话中的排队位置
    
    messageQueue.push({ messageId, senderNick, sessionWebhook, content, botName });
    console.log(`[dingtalkbot] 消息入队 [${messageId.slice(0, 8)}...] 队列长度: ${messageQueue.length}, 同会话排队: ${sessionQueueCount}`);
    
    // 获取会话信息
    const session = dingTalkSessions.get(messageId);
    
    // 如果同一会话正在忙且未发送过排队提示，立即发送提示
    if (isSessionBusy && session && !session.queueNoticeSent) {
      session.queueNoticeSent = true;
      
      let noticeText: string;
      if (queuePosition === 1 && isProcessingSameSession) {
        // 同一会话的上一条正在处理
        noticeText = "⏳ 正在处理您的上一条消息，请稍等...";
      } else {
        // 同一会话有多条排队
        noticeText = `⏳ 您有 ${queuePosition} 条消息正在排队处理，请稍等...`;
      }
      
      // 异步发送提示，不阻塞入队
      sendMessage(sessionWebhook, "text", { content: noticeText }).catch(err => {
        console.log(`[dingtalkbot] 发送排队提示失败:`, err);
      });
    }
    
    // 启动处理（如果尚未运行）
    processNextMessage();
  }

  // ============================================================================
  // 辅助函数
  // ============================================================================

  function setStatus(msg?: string) {
    if (!currentCtx) return;
    
    const active = globalBots.find(b => b.clientId === sessionCfg.activeBotId) || globalBots[0];
    if (!active || !connected) {
      currentCtx.ui.setStatus("dingtalkbot", "");
      return;
    }
    
    const botName = getBotDisplayName(active);
    currentCtx.ui.setStatus("dingtalkbot", 
      msg ? `${botName}【dingtalk】 🔴 ${msg}` : `${botName}【dingtalk】 ✅ ${dingTalkSessions.size}`
    );
  }

  // 从消息文本中提取 messageId
  function extractMessageIdFromResponse(response: string, botName: string): { messageId: string | null; content: string } {
    // 匹配格式: [dingtalkbot] [机器人名] [用户昵称] [messageId]\n内容
    const pattern = new RegExp(`\\[dingtalkbot\\] \\[${botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\] \\[([^\\]]+)\\] \\[([^\\]]+)\\]\\n?`, "g");
    const match = pattern.exec(response);
    
    if (match) {
      const messageId = match[2];
      const content = response.replace(match[0], "");
      return { messageId, content };
    }
    
    // 降级：尝试匹配不含 messageId 的旧格式
    const oldPattern = new RegExp(`\\[dingtalkbot\\] \\[${botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\] \\[([^\\]]+)\\]\\n?`, "g");
    const oldMatch = oldPattern.exec(response);
    
    if (oldMatch) {
      // 对于旧格式，尝试找到最近的未回复会话
      const senderNick = oldMatch[1];
      for (const [msgId, session] of dingTalkSessions) {
        if (session.senderNick === senderNick && !session.hasReplied) {
          return { messageId: msgId, content: response.replace(oldMatch[0], "") };
        }
      }
    }
    
    return { messageId: null, content: response };
  }

  // ============================================================================
  // 连接管理
  // ============================================================================

  async function connect(ctx: ExtensionContext, bot: BotConfig): Promise<boolean> {
    try {
      disconnect();
      currentCtx = ctx;
      activeBotConfig = bot;
      
      console.log(`[dingtalkbot] 连接中: ${getBotDisplayName(bot)}`);
      console.log(`[dingtalkbot] ⚠️ 同一机器人只能有一个连接`);

      // @ts-ignore
      client = new DWClient({ clientId: bot.clientId, clientSecret: bot.clientSecret });

      client.registerCallbackListener(TOPIC_ROBOT, async (res) => {
        try {
          const message = JSON.parse(res.data);
          const content = message?.text?.content;
          if (!content) return { status: EventAck.SUCCESS };

          const messageId = message.msgId || `${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
          const senderNick = message.senderNick || "未知用户";
          const sessionWebhook = message.sessionWebhook || "";
          const botName = getBotDisplayName(bot);

          console.log(`[dingtalkbot] [${botName}] [${senderNick}] msgId=${messageId} content=${content.slice(0, 30)}...`);

          // 存储会话上下文
          const session: DingTalkSession = {
            messageId,
            senderNick,
            sessionWebhook,
            timestamp: Date.now(),
            hasReplied: false,
            queueNoticeSent: false
          };
          dingTalkSessions.set(messageId, session);

          // 如果会话过多，清理最老的
          if (dingTalkSessions.size > 100) {
            const entries = Array.from(dingTalkSessions.entries())
              .sort((a, b) => a[1].timestamp - b[1].timestamp);
            for (let i = 0; i < entries.length - 50; i++) {
              dingTalkSessions.delete(entries[i][0]);
            }
          }

          // 异步处理消息（不阻塞回调）
          queueDingTalkMessage(messageId, senderNick, sessionWebhook, content, botName);

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
        
        console.log(`[dingtalkbot] ❌ ${getBotDisplayName(bot)} ${isKicked ? "被其他会话踢掉" : "断开"}${reasonStr ? `: ${reasonStr}` : ""}`);
        setStatus(wasConnected && isKicked ? `被其他会话连接 (${SESSION_ID.slice(0, 4)})` : undefined);
      });

      client.on("error", (err: any) => {
        const errMsg = String(err);
        connected = false;
        console.log(`[dingtalkbot] ❌ ${getBotDisplayName(bot)}`, err);
        
        if (errMsg.includes("already connected") || errMsg.includes("connection refused") || errMsg.includes("403")) {
          setStatus("连接被占用");
          currentCtx?.ui.notify(`❌ ${getBotDisplayName(bot)} 连接失败：机器人已在其他会话连接`, "error");
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
    dingTalkSessions.clear();
    messageQueue.length = 0;
    isProcessing = false;
    
    if (client) { 
      try { client.disconnect(); } catch {}
      client = null; 
    }
    connected = false;
    activeBotConfig = null;
  }

  // 获取最近的未回复会话
  function getLatestSession(): DingTalkSession | null {
    let latest: DingTalkSession | null = null;
    for (const session of dingTalkSessions.values()) {
      if (!session.hasReplied) {
        if (!latest || session.timestamp > latest.timestamp) {
          latest = session;
        }
      }
    }
    return latest;
  }

  // ============================================================================
  // Tools
  // ============================================================================

  pi.registerTool({
    name: "dingtalkbot-attach",
    label: "发送文件",
    description: "发送本地文件到钉钉（转为链接形式）",
    parameters: Type.Object({ 
      paths: Type.Array(Type.String(), { minItems: 1, maxItems: 10 }),
      messageId: Type.Optional(Type.String()),  // 可指定消息ID
    }),
    async execute(_id, p) {
      if (!client || !connected) throw new Error("机器人未连接");
      
      // 优先使用指定的 messageId，否则使用最近的会话
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
      messageId: Type.Optional(Type.String()),  // 可指定消息ID
    }),
    async execute(_id, p) {
      if (!client || !connected) throw new Error("机器人未连接");
      
      // 优先使用指定的 messageId，否则使用最近的会话
      const targetMsgId = p.messageId;
      const session = targetMsgId ? dingTalkSessions.get(targetMsgId) : getLatestSession();
      if (!session) throw new Error("无活跃会话");
      
      if (p.format === "markdown") {
        await sendMessage(session.sessionWebhook, "markdown", { title: "消息", text: `### 消息\n\n${p.message}` });
      } else {
        await sendMessage(session.sessionWebhook, "text", { content: p.message });
      }
      return { content: [{ type: "text", text: "✅ 已发送" }], details: {} };
    },
  });

  // ============================================================================
  // Commands
  // ============================================================================

  pi.registerCommand("dingtalkbot-add", {
    description: "添加机器人",
    handler: async (_args, ctx) => {
      const name = await ctx.ui.input("机器人名称(可选)", "");
      const clientId = await ctx.ui.input("ClientID (AppKey)", "dingxxxxxxxxxxxxxxxx");
      if (!clientId) return;
      const clientSecret = await ctx.ui.input("ClientSecret (AppSecret)", "");
      if (!clientSecret) return;

      const globalCfg = await loadGlobalConfig();
      if (globalCfg.bots.find(b => b.clientId === clientId.trim())) {
        ctx.ui.notify("❌ 该机器人已存在", "error");
        return;
      }
      
      const newBot: BotConfig = { clientId: clientId.trim(), clientSecret: clientSecret.trim(), name: name?.trim() || undefined };
      globalCfg.bots.push(newBot);
      await saveGlobalConfig(globalCfg);
      globalBots = globalCfg.bots;
      
      if (!sessionCfg.activeBotId) {
        sessionCfg.activeBotId = clientId.trim();
        sessionCfg.enabled = true;
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
        const isConn = connected && isActive ? "✅" : "";
        return `${isActive ? "▶" : "○"} ${isConn} ${getBotDisplayName(b)}`;
      }).join("\n");
      
      const activeBot = globalBots.find(b => b.clientId === sessionCfg.activeBotId) || globalBots[0];
      ctx.ui.notify(`机器人列表（共 ${globalBots.length} 个）:\n${list}\n\n本会话: ${getBotDisplayName(activeBot)}`, "info");
    },
  });

  pi.registerCommand("dingtalkbot-use", {
    description: "切换机器人",
    handler: async (_args, ctx) => {
      globalBots = (await loadGlobalConfig()).bots;
      
      if (globalBots.length === 0) {
        ctx.ui.notify("暂无配置的机器人，请先添加", "warning");
        return;
      }
      
      const options = globalBots.map(b => `${b.clientId === sessionCfg.activeBotId ? "▶ " : "○ "}${getBotDisplayName(b)}`);
      const selected = await ctx.ui.select("选择机器人", options);
      if (!selected) return;
      
      const label = selected.replace(/^[▶○] /, "");
      const bot = globalBots.find(b => getBotDisplayName(b) === label || b.clientId === label);
      if (!bot) return;

      sessionCfg.activeBotId = bot.clientId;
      sessionCfg.enabled = true;
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
          ctx.ui.notify(`✅ 已删除 ${getBotDisplayName(removed)}，切换到 ${getBotDisplayName(nextBot)}`, "info");
          if (sessionCfg.enabled) await connect(ctx, nextBot);
        } else {
          ctx.ui.notify(`✅ 已删除 ${getBotDisplayName(removed)}（无可用机器人）`, "info");
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
      const active = globalBots.find(b => b.clientId === sessionCfg.activeBotId) || globalBots[0];
      
      if (!active) {
        ctx.ui.notify(`全局机器人: ${globalBots.length} 个\n本会话状态: 未选择机器人`, "info");
        return;
      }
      
      const statusIcon = !sessionCfg.enabled ? "🔴 禁用" : connected ? "✅ 已连接" : "❌ 已断开";
      ctx.ui.notify(
        `${statusIcon}\n机器人: ${getBotDisplayName(active)}\nClientID: ${active.clientId}\n全局: ${globalBots.length} 个\n会话: ${dingTalkSessions.size} 个`,
        "info"
      );
    },
  });

  pi.registerCommand("dingtalkbot-enable", {
    description: "启用机器人",
    handler: async (_args, ctx) => {
      if (sessionCfg.enabled) {
        ctx.ui.notify("已是启用状态", "info");
        return;
      }
      sessionCfg.enabled = true;
      await saveSessionConfig(sessionCfg);
      
      const bot = globalBots.find(b => b.clientId === sessionCfg.activeBotId) || globalBots[0];
      if (bot) {
        await connect(ctx, bot);
        ctx.ui.notify(`✅ 已启用 ${getBotDisplayName(bot)}`, "info");
      } else {
        ctx.ui.notify("✅ 已启用，请先添加机器人", "warning");
      }
    },
  });

  pi.registerCommand("dingtalkbot-disable", {
    description: "禁用机器人",
    handler: async (_args, ctx) => {
      if (!sessionCfg.enabled) {
        ctx.ui.notify("已是禁用状态", "info");
        return;
      }
      sessionCfg.enabled = false;
      await saveSessionConfig(sessionCfg);
      disconnect();
      ctx.ui.notify("🔌 已禁用并断开连接", "info");
    },
  });

  pi.registerCommand("dingtalkbot-session", {
    description: "查看会话详情",
    handler: async (_args, ctx) => {
      if (dingTalkSessions.size === 0) {
        ctx.ui.notify("暂无活跃会话", "info");
        return;
      }
      const active = globalBots.find(b => b.clientId === sessionCfg.activeBotId);
      const list = Array.from(dingTalkSessions.values()).map(s => 
        `[${active ? getBotDisplayName(active) : ""}] ${s.senderNick} (${s.messageId.slice(0, 8)}...)`
      ).join("\n");
      ctx.ui.notify(`活跃会话:\n${list}`, "info");
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
    
    const active = globalBots.find(b => b.clientId === sessionCfg.activeBotId) || globalBots[0];
    const botName = getBotDisplayName(active);
    
    // 从回复中提取 messageId 和内容
    const { messageId, content } = extractMessageIdFromResponse(txt, botName);
    
    // 首先尝试匹配到 pendingMessages 中等待回复的消息
    if (messageId && pendingMessages.has(messageId)) {
      const pending = pendingMessages.get(messageId)!;
      
      if (content.trim()) {
        const session = dingTalkSessions.get(messageId);
        if (session && !session.hasReplied) {
          session.hasReplied = true;
          await sendReply(session.sessionWebhook, content.trim());
          console.log(`[dingtalkbot] 回复 [${messageId.slice(0, 8)}...]: ${content.slice(0, 50)}`);
        }
      }
      
      // 通知等待的 processSingleMessage 可以继续了
      pending.resolve();
      return;
    }
    
    // 降级处理：如果没有匹配到 pendingMessages，尝试从 dingTalkSessions 匹配
    if (content.trim() && messageId) {
      const session = dingTalkSessions.get(messageId);
      if (session && !session.hasReplied) {
        session.hasReplied = true;
        await sendReply(session.sessionWebhook, content.trim());
        console.log(`[dingtalkbot] 回复 [降级 ${messageId.slice(0, 8)}...]: ${content.slice(0, 50)}`);
      }
    } else if (content.trim()) {
      // 最后的降级：发给当前正在处理的消息或最新的未回复会话
      const targetMessageId = currentProcessingMessageId || 
        Array.from(dingTalkSessions.entries())
          .filter(([_, s]) => !s.hasReplied)
          .sort((a, b) => b[1].timestamp - a[1].timestamp)[0]?.[0];
      
      if (targetMessageId) {
        const session = dingTalkSessions.get(targetMessageId);
        if (session && !session.hasReplied) {
          session.hasReplied = true;
          await sendReply(session.sessionWebhook, content.trim());
          console.log(`[dingtalkbot] 回复 [紧急降级 ${targetMessageId.slice(0, 8)}...]: ${content.slice(0, 50)}`);
        }
        
        // 如果有等待的 Promise，也通知它
        const pending = pendingMessages.get(targetMessageId);
        if (pending) {
          pending.resolve();
        }
      }
    }
  });
}
