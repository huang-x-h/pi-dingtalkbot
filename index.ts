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

  // 消息队列 - 等待发送给 pi 的消息
  const messageQueue: Array<{
    messageId: string;
    senderNick: string;
    sessionWebhook: string;
    content: string;
    botName: string;
  }> = [];

  // 消息超时跟踪（防止 agent_end 不触发导致卡住）
  const messageTimeouts = new Map<string, NodeJS.Timeout>();
  const MESSAGE_TIMEOUT = 5 * 60 * 1000; // 5分钟超时

  // 当前正在处理的消息ID（用于等待处理完成）
  let currentProcessingMessageId: string | null = null;
  let isProcessing = false;

  // 处理队列中下一条消息
  async function processNextMessage(): Promise<void> {
    console.log(`[dingtalkbot] processNextMessage 被调用, isProcessing=${isProcessing}, queueLength=${messageQueue.length}`);
    
    if (isProcessing) {
      console.log(`[dingtalkbot] 正在处理中，跳过`);
      return;
    }
    
    if (messageQueue.length === 0) {
      console.log(`[dingtalkbot] 队列为空，跳过`);
      return;
    }
    
    isProcessing = true;
    const msg = messageQueue.shift()!;
    const { messageId, senderNick, sessionWebhook, content, botName } = msg;
    
    console.log(`[dingtalkbot] 开始处理消息 ${messageId.slice(0, 8)}..., 队列剩余: ${messageQueue.length}`);
    
    currentProcessingMessageId = messageId;
    
    try {
      console.log(`[dingtalkbot] 发送消息给 pi [${messageId.slice(0, 8)}...]`);
      
      // 存储会话上下文
      dingTalkSessions.set(messageId, {
        messageId,
        senderNick,
        sessionWebhook,
        timestamp: Date.now()
      });

      // 发送给 pi 处理
      const messageText = `[dingtalkbot] [${botName}] [${senderNick}] [${messageId}]\n${content}`;
      
      try {
        // @ts-ignore
        await pi.sendUserMessage([{ type: "text", text: messageText }], { deliverAs: "steer" });
        console.log(`[dingtalkbot] 已发送给 pi，等待处理完成...`);
        
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
      
      console.log(`[dingtalkbot] 连接中: ${getBotDisplayName(bot)}`);

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

          console.log(`[dingtalkbot] [${botName}] [${senderNick}] content=${content.slice(0, 30)}...`);

          // 消息入队，等待顺序处理
          messageQueue.push({ messageId, senderNick, sessionWebhook, content, botName });
          console.log(`[dingtalkbot] 消息入队 [${messageId.slice(0, 8)}...] 队列长度: ${messageQueue.length}`);

          // 启动处理（如果尚未在处理）
          processNextMessage();

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
      console.log(`[dingtalkbot] 回复 [${session.senderNick}]: ${content.slice(0, 50)}`);
      // 回复后删除会话记录
      dingTalkSessions.delete(session.messageId);
    }
    
    // 调试日志：显示提取结果
    console.log(`[dingtalkbot] agent_end: extracted messageId=${messageId}, current=${currentProcessingMessageId}, isProcessing=${isProcessing}`);
    
    // 如果当前处理的消息已完成，继续处理下一条
    // 条件1：messageId 匹配（正常情况）
    // 条件2：isProcessing 为 true 且队列中有消息（兜底，防止卡住）
    const shouldContinue = (messageId && messageId === currentProcessingMessageId) || 
                           (isProcessing && messageQueue.length > 0);
    
    if (shouldContinue) {
      const completedId = messageId || currentProcessingMessageId;
      console.log(`[dingtalkbot] 消息 ${completedId?.slice(0, 8)}... 处理完成，继续下一条，队列剩余: ${messageQueue.length}`);
      
      // 清除超时定时器
      if (completedId) {
        const timeoutId = messageTimeouts.get(completedId);
        if (timeoutId) {
          clearTimeout(timeoutId);
          messageTimeouts.delete(completedId);
        }
      }
      
      isProcessing = false;
      currentProcessingMessageId = null;
      // 触发下一条消息处理
      if (messageQueue.length > 0) {
        processNextMessage();
      }
    } else {
      console.log(`[dingtalkbot] 不继续处理: messageId=${messageId}, current=${currentProcessingMessageId}, isProcessing=${isProcessing}, queue=${messageQueue.length}`);
    }
  });
}
