/**
 * pi-dingtalkbot
 * 
 * 钉钉智能机器人 Stream 长连接扩展 for pi
 * 支持多个机器人配置和快速切换
 * 
 * 参考: 
 * - https://open.dingtalk.com/document/development/development-robot-overview
 * - https://open.dingtalk.com/document/development/introduction-to-stream-mode
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { DWClient, TOPIC_ROBOT, TOPIC_CARD, EventAck } from "dingtalk-stream";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ============================================================================
// Config
// ============================================================================

/**
 * 钉钉机器人配置
 * 
 * 钉钉 Stream 模式连接参数：
 * - clientId: 应用的 ClientID（即 AppKey），在钉钉开发者后台 - 应用详情 获取
 * - clientSecret: 应用的 ClientSecret（即 AppSecret），在钉钉开发者后台 - 应用详情 获取
 * 
 * 注意：需要先在应用中开通"机器人"能力，并选择 Stream 模式
 */
interface BotConfig {
  clientId: string;      // ClientID（AppKey）
  clientSecret: string;   // ClientSecret（AppSecret）
  name?: string;          // 自定义名称（可选）
}

// 全局配置：所有会话共享机器人列表
interface GlobalConfig {
  bots: BotConfig[];
}

// 会话配置：每个会话独立选择启用哪个机器人
interface SessionConfig {
  activeBotId?: string;  // 当前会话启用的机器人（使用 clientId）
  enabled?: boolean;     // 当前会话是否启用
}

interface Session {
  messageId: string;
  conversationId: string;
  senderStaffId: string;
  senderNick: string;
  timestamp: number;
  botId: string;
  robotCode: string;  // 机器人编码
  sessionWebhook: string;
}

// ============================================================================
// HTTP API - 钉钉发送消息
// ============================================================================

interface DingTalkToken {
  accessToken: string;
  expireTime: number;
}

let cachedToken: DingTalkToken | null = null;

// 获取 Access Token
async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  // 检查缓存
  if (cachedToken && cachedToken.expireTime > Date.now() + 60000) {
    return cachedToken.accessToken;
  }
  
  const url = `https://oapi.dingtalk.com/gettoken?appkey=${clientId}&appsecret=${clientSecret}`;
  const res = await fetch(url);
  const data = await res.json() as { access_token?: string; errcode?: number; errmsg?: string };
  
  if (data.errcode !== 0 || !data.access_token) {
    throw new Error(`获取 AccessToken 失败: ${data.errmsg || JSON.stringify(data)}`);
  }
  
  cachedToken = {
    accessToken: data.access_token,
    expireTime: Date.now() + 2 * 60 * 60 * 1000 // 2小时
  };
  
  return cachedToken.accessToken;
}

// 发送消息到钉钉
async function sendDingTalkMessage(clientId: string, clientSecret: string, sessionWebhook: string, msgtype: string, content: any): Promise<void> {
  // 如果有 sessionWebhook，直接用它发送（无需 token）
  // 这是 Stream 模式推荐的消息回复方式
  if (sessionWebhook) {
    const url = sessionWebhook;
    const body = {
      msgtype,
      [msgtype]: content
    };
    
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    
    if (!res.ok) {
      throw new Error(`发送消息失败: HTTP ${res.status}`);
    }
    return;
  }
  
  // 否则使用旧版 API（需要 accessToken）
  const accessToken = await getAccessToken(clientId, clientSecret);
  const url = `https://oapi.dingtalk.com/robot/send?access_token=${accessToken}`;
  
  const body = {
    msgtype,
    [msgtype]: content
  };
  
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  
  if (!res.ok) {
    throw new Error(`发送消息失败: HTTP ${res.status}`);
  }
}

// ============================================================================
// Session Utils
// ============================================================================

// 获取会话唯一标识 - 使用环境变量或生成唯一ID
function getSessionId(): string {
  // 优先使用 pi 提供的环境变量
  if (process.env.PI_SESSION_ID) return process.env.PI_SESSION_ID;
  if (process.env.PI_INSTANCE_ID) return process.env.PI_INSTANCE_ID;
  
  // 备用：使用时间戳+随机数，确保唯一性
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 6);
  return `sess-${timestamp}-${random}`;
}

// 获取全局配置路径（机器人列表，所有会话共享）
function getGlobalConfigPath(): string {
  return join(homedir(), ".pi", "agent", "dingtalk-bot.json");
}

// 获取会话专属配置路径（会话选择哪个机器人，会话独立）
function getSessionConfigPath(sessionId: string): string {
  return join(homedir(), ".pi", "agent", `dingtalk-bot-session-${sessionId}.json`);
}

// 获取会话专属临时目录
function getSessionTempPath(sessionId: string): string {
  return join(homedir(), ".pi", "agent", "tmp", "dingtalk-bot", sessionId);
}

// 全局变量
let SESSION_ID: string;
let GLOBAL_CONFIG: string;
let SESSION_CONFIG: string;
let TEMP: string;

const PROMPT = `
[dingtalkbot] 钉钉机器人已连接
- 收到 @机器人 的消息会自动处理
- 回复会自动发送到对应用户的会话
- 使用 dingtalkbot-attach 发送文件`;

// ============================================================================
// Config Management
// ============================================================================

// 加载全局配置（机器人列表）
async function loadGlobalConfig(): Promise<GlobalConfig> {
  try {
    const data = JSON.parse(await readFile(GLOBAL_CONFIG, "utf8"));
    return { bots: data.bots || [] };
  } catch {
    return { bots: [] };
  }
}

// 保存全局配置（机器人列表）
async function saveGlobalConfig(c: GlobalConfig) {
  await mkdir(dirname(GLOBAL_CONFIG), { recursive: true });
  await writeFile(GLOBAL_CONFIG, JSON.stringify(c, null, "\t") + "\n");
}

// 加载会话配置（会话选择的机器人和启用状态）
async function loadSessionConfig(): Promise<SessionConfig> {
  try {
    const data = JSON.parse(await readFile(SESSION_CONFIG, "utf8"));
    return { activeBotId: data.activeBotId, enabled: data.enabled ?? true };
  } catch {
    return { enabled: true };
  }
}

// 保存会话配置
async function saveSessionConfig(c: SessionConfig) {
  await mkdir(dirname(SESSION_CONFIG), { recursive: true });
  await writeFile(SESSION_CONFIG, JSON.stringify(c, null, "\t") + "\n");
}

// 根据 clientId 查找活跃机器人
function getActiveBot(bots: BotConfig[], clientId?: string): BotConfig | undefined {
  return bots.find(b => b.clientId === clientId) || bots[0];
}

// 根据 clientId 查找机器人
function getBotById(bots: BotConfig[], clientId: string): BotConfig | undefined {
  return bots.find(b => b.clientId === clientId);
}

// 获取机器人显示名称
function getBotDisplayName(bot: BotConfig): string {
  // 优先使用用户设置的名称，否则显示完整的 ClientID
  return bot.name || bot.clientId;
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
  // 初始化路径
  SESSION_ID = getSessionId();
  GLOBAL_CONFIG = getGlobalConfigPath();
  SESSION_CONFIG = getSessionConfigPath(SESSION_ID);
  TEMP = getSessionTempPath(SESSION_ID);
  
  console.log(`[dingtalkbot] 会话ID: ${SESSION_ID.slice(0, 8)}`);
  console.log(`[dingtalkbot] 全局配置: ${GLOBAL_CONFIG}`);
  console.log(`[dingtalkbot] 会话配置: ${SESSION_CONFIG}`);
  
  // 全局机器人列表（从全局配置加载）
  let globalBots: BotConfig[] = [];
  // 会话配置（本会话选择哪个机器人）
  let sessionCfg: SessionConfig = { enabled: true };
  
  // 当前激活的机器人配置（用于发送消息）
  let activeBotConfig: BotConfig | null = null;
  
  // 当前上下文（用于在回调中更新状态）
  let currentCtx: ExtensionContext | null = null;
  
  let client: DWClient | null = null;
  let connected = false;
  let lastMessageId = "";
  let hasReplied = false;  // 防止重复回复

  const sessions = new Map<string, Session>();
  
  // 消息队列，避免并发冲突
  const messageQueue: Array<{type: string, text: string}> = [];
  let isProcessingQueue = false;
  
  // 处理消息队列
  async function processMessageQueue() {
    if (isProcessingQueue || messageQueue.length === 0) return;
    isProcessingQueue = true;
    
    const message = messageQueue.shift();
    if (message) {
      try {
        // @ts-ignore
        await pi.sendUserMessage([{ type: "text", text: message.text }]);
      } catch (err: any) {
        if (err?.message?.includes('already processing')) {
          messageQueue.unshift(message);
          console.log('[dingtalkbot] Agent 忙，消息将在 500ms 后重试');
        } else {
          console.error('[dingtalkbot] 发送消息失败:', err);
        }
      }
    }
    
    isProcessingQueue = false;
    
    if (messageQueue.length > 0) {
      setTimeout(processMessageQueue, 500);
    }
  }
  
  // 发送消息到队列
  function queueMessage(text: string) {
    messageQueue.push({ type: "text", text });
    processMessageQueue();
  }

  // 清理过期会话
  setInterval(() => {
    const now = Date.now();
    for (const [messageId, session] of sessions) {
      if (now - session.timestamp > 10 * 60 * 1000) {
        sessions.delete(messageId);
      }
    }
  }, 60000);

  // Status - 只展示 Bot 名称和连接状态，未使用时不显示
  function setStatus(msg?: string) {
    const ctx = currentCtx;
    if (!ctx) return;
    
    const active = getActiveBot(globalBots, sessionCfg.activeBotId);
    
    // 如果没有配置机器人或未连接，隐藏状态栏
    if (!active || !connected) {
      ctx.ui.setStatus("dingtalkbot", "");
      return;
    }
    
    const botName = getBotDisplayName(active);
    
    if (msg) {
      // 有错误信息时显示
      ctx.ui.setStatus("dingtalkbot", `${botName}【dingtalk】 🔴 ${msg}`);
    } else if (connected) {
      // 已连接
      ctx.ui.setStatus("dingtalkbot", `${botName}【dingtalk】 ✅ ${sessions.size}`);
    }
  }

  // 回复消息 - 使用 HTTP API
  async function replyTo(sessionId: string, content: string): Promise<void> {
    if (!connected) return;
    const session = sessions.get(sessionId);
    if (!session) {
      console.log(`[dingtalkbot] 会话不存在: ${sessionId}`);
      return;
    }
    
    try {
      await sendDingTalkMessage(
        activeBotConfig?.clientId || "",
        activeBotConfig?.clientSecret || "",
        session.sessionWebhook,
        "text",
        { content }
      );
      console.log(`[dingtalkbot] 发送消息成功`);
    } catch (err) {
      console.error('[dingtalkbot] 发送消息失败:', err);
    }
  }

  // 发送 markdown 消息
  async function replyMarkdownTo(sessionId: string, title: string, text: string): Promise<void> {
    if (!connected) return;
    const session = sessions.get(sessionId);
    if (!session) {
      console.log(`[dingtalkbot] 会话不存在: ${sessionId}`);
      return;
    }
    
    try {
      // 钉钉 markdown 只支持部分 markdown 语法
      const content = `### ${title}\n\n${text}`;
      await sendDingTalkMessage(
        activeBotConfig?.clientId || "",
        activeBotConfig?.clientSecret || "",
        session.sessionWebhook,
        "markdown",
        { title, text: content }
      );
      console.log(`[dingtalkbot] 发送 markdown 成功`);
    } catch (err) {
      console.error('[dingtalkbot] 发送 markdown 失败:', err);
    }
  }

  // 思考中提示
  async function sendThinkingMessage(sessionId: string): Promise<void> {
    if (!connected) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    
    try {
      await sendDingTalkMessage(
        activeBotConfig?.clientId || "",
        activeBotConfig?.clientSecret || "",
        session.sessionWebhook,
        "text",
        { content: "🤔 思考中..." }
      );
    } catch (err) {
      // 忽略思考消息的错误
    }
  }

  // 连接 - 添加错误保护
  async function connect(ctx: ExtensionContext, bot: BotConfig): Promise<boolean> {
    try {
      disconnect();

      // 保存上下文用于后续更新状态
      currentCtx = ctx;

      console.log(`[dingtalkbot] ⚠️ 提示: 同一机器人只能有一个连接，其他会话将被断开`);

      activeBotConfig = bot;
      const displayName = getBotDisplayName(bot);
      console.log(`[dingtalkbot] 连接中: ${displayName}`);

      client = new DWClient({
        clientId: bot.clientId,
        clientSecret: bot.clientSecret
      });

      // 注册消息处理器
      client.registerAllEventListener((event) => {
        // 只处理机器人消息
        if (event.headers?.topic !== TOPIC_ROBOT) {
          return { status: EventAck.SUCCESS };
        }

        try {
          const message = JSON.parse(event.data);
          const content = message?.text?.content || "";
          
          // 过滤空消息
          if (!content) {
            return { status: EventAck.SUCCESS };
          }

          const messageId = message.msgId || `${Date.now()}`;
          const senderStaffId = message.senderStaffId || message.senderId || "unknown";
          const senderNick = message.senderNick || "未知用户";
          const conversationId = message.conversationId || "";
          const sessionWebhook = message.sessionWebhook || "";
          const robotCode = message.robotCode || "";
          const botId = bot.clientId;

          // 如果没有设置名称且收到消息中有 robotCode，尝试用它（异步保存）
          if (!bot.name && robotCode) {
            bot.name = robotCode;
            // 异步保存到全局配置
            loadGlobalConfig().then(async (globalCfg) => {
              const idx = globalCfg.bots.findIndex(b => b.clientId === bot.clientId);
              if (idx !== -1) {
                globalCfg.bots[idx].name = robotCode;
                await saveGlobalConfig(globalCfg);
                globalBots = globalCfg.bots;
                console.log(`[dingtalkbot] 已获取机器人编码: ${robotCode}`);
                // 更新状态栏显示
                setStatus();
              }
            }).catch(err => {
              console.log(`[dingtalkbot] 保存机器人编码失败:`, err);
            });
          }

          // 获取当前机器人的显示名称
          const currentBotName = bot.name || robotCode || bot.clientId;

          console.log(`[dingtalkbot] [${currentBotName}] [${senderNick}] ${content.slice(0, 50)}...`);

          sessions.set(messageId, { 
            messageId, 
            conversationId, 
            senderStaffId, 
            senderNick,
            timestamp: Date.now(), 
            botId,
            robotCode,
            sessionWebhook
          });
          lastMessageId = messageId;
          hasReplied = false;

          // 发送"思考中"提示
          sendThinkingMessage(messageId);
          
          // 队列消息给 AI 处理
          queueMessage(`[dingtalkbot] [${currentBotName}] [${senderNick}]
${content}`);
        } catch (err) {
          console.error('[dingtalkbot] 解析消息失败:', err);
        }
        
        return { status: EventAck.SUCCESS };
      });

      // 监听连接成功事件
      client.on("connect", () => {
        console.log(`[dingtalkbot] ✅ ${displayName} 已连接`);
        connected = true;
        setStatus();
      });

      // 监听断开连接事件
      client.on("disconnect", (reason: any) => {
        const wasConnected = connected;
        connected = false;
        sessions.clear();
        
        const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason);
        const isKicked = reasonStr?.includes("kick") || reasonStr?.includes("replaced") || reasonStr?.includes("conflict") || reasonStr?.includes("403");
        const disconnectMsg = isKicked ? `被其他会话踢掉` : `断开`;
        
        console.log(`[dingtalkbot] ❌ ${displayName} ${disconnectMsg}${reasonStr ? `: ${reasonStr}` : ""}`);
        
        if (wasConnected && isKicked) {
          setStatus(`被其他会话连接 (${SESSION_ID.slice(0, 4)})`);
        } else {
          setStatus();
        }
      });

      // 监听错误事件
      client.on("error", (err: any) => {
        const errMsg = String(err);
        console.log(`[dingtalkbot] ❌ ${displayName}`, err);
        connected = false;
        
        if (errMsg.includes("already connected") || errMsg.includes("connection refused") || errMsg.includes("403")) {
          setStatus("连接被占用");
          ctx.ui.notify(`❌ ${displayName} 连接失败：该机器人已在其他会话连接`, "error");
        } else {
          setStatus(errMsg);
        }
      });

      // 启动连接
      await client.connect();
      return true;
    } catch (err) {
      console.error(`[dingtalkbot] 连接异常:`, err);
      connected = false;
      setStatus("连接异常");
      return false;
    }
  }

  function disconnect() {
    sessions.clear();
    if (client) { 
      try {
        client.disconnect();
      } catch (e) {
        // 忽略停止时的错误
      }
      client = null; 
    }
    connected = false;
    activeBotConfig = null;
  }

  // ============================================================================
  // Tools
  // ============================================================================

  pi.registerTool({
    name: "dingtalkbot-attach",
    label: "发送文件",
    description: "发送本地文件到钉钉（钉钉不支持直接发送文件，将转为链接形式发送）",
    parameters: Type.Object({
      paths: Type.Array(Type.String(), { minItems: 1, maxItems: 10 }),
    }),
    async execute(_id, p) {
      if (!client || !connected) throw new Error("机器人未连接");
      const messageId = lastMessageId;
      if (!messageId || !sessions.has(messageId)) throw new Error("无活跃会话");
      
      const session = sessions.get(messageId);
      if (!session) throw new Error("无活跃会话");
      
      const files: string[] = [];
      for (const fp of p.paths) {
        try {
          if ((await stat(fp)).isFile()) files.push(fp);
        } catch (e) {
          console.log(`[dingtalkbot] 文件不存在: ${fp}`);
        }
      }
      
      if (files.length === 0) throw new Error("没有有效的文件");
      
      // 使用 markdown 格式发送文件列表
      try {
        await sendDingTalkMessage(
          activeBotConfig?.clientId || "",
          activeBotConfig?.clientSecret || "",
          session.sessionWebhook,
          "markdown",
          { 
            title: "文件列表", 
            text: `### 📎 文件列表\n\n${files.map(f => `- ${basename(f)}`).join("\n")}\n\n> 钉钉机器人暂不支持直接发送文件附件` 
          }
        );
      } catch (err) {
        // 如果 markdown 失败，尝试文本格式
        const fileList = files.map(f => `📎 ${basename(f)}`).join("\n");
        await sendDingTalkMessage(
          activeBotConfig?.clientId || "",
          activeBotConfig?.clientSecret || "",
          session.sessionWebhook,
          "text",
          { content: `文件列表:\n${fileList}\n\n（钉钉机器人暂不支持直接发送文件附件）` }
        );
      }
      
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
    }),
    async execute(_id, p) {
      if (!client || !connected) throw new Error("机器人未连接");
      const messageId = lastMessageId;
      if (!messageId || !sessions.has(messageId)) throw new Error("无活跃会话");
      
      if (p.format === "markdown") {
        await replyMarkdownTo(messageId, "消息", p.message);
      } else {
        await replyTo(messageId, p.message);
      }
      
      return { content: [{ type: "text", text: "✅ 已发送" }], details: {} };
    },
  });

  // ============================================================================
  // Commands
  // ============================================================================

  // 【全局配置】添加机器人 - 所有会话可见
  pi.registerCommand("dingtalkbot-add", {
    description: "添加机器人（全局）",
    handler: async (_args, ctx) => {
      const name = await ctx.ui.input("机器人名称(可选)", "");
      const clientId = await ctx.ui.input("ClientID (AppKey)", "dingxxxxxxxxxxxxxxxx");
      if (!clientId) return;
      const clientSecret = await ctx.ui.input("ClientSecret (AppSecret)", "");
      if (!clientSecret) return;

      const globalCfg = await loadGlobalConfig();
      
      // 检查是否已存在
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
        sessionCfg.enabled = true;
        await saveSessionConfig(sessionCfg);
      }
      
      ctx.ui.notify(`✅ 已添加 ${name || getBotDisplayName(newBot)}（全局配置）`, "info");
      await connect(ctx, newBot);
    },
  });

  // 【全局配置】列出所有机器人
  pi.registerCommand("dingtalkbot-list", {
    description: "列出所有机器人（全局）",
    handler: async (_args, ctx) => {
      const globalCfg = await loadGlobalConfig();
      globalBots = globalCfg.bots;
      
      if (globalBots.length === 0) {
        ctx.ui.notify("全局暂无配置的机器人", "info");
      } else {
        const list = globalBots.map(b => {
          const isSessionActive = b.clientId === sessionCfg.activeBotId ? "▶" : "○";
          const isConnected = connected && b.clientId === sessionCfg.activeBotId ? "✅" : "";
          return `${isSessionActive} ${isConnected} ${getBotDisplayName(b)}`;
        }).join("\n");
        
        const activeBot = getActiveBot(globalBots, sessionCfg.activeBotId);
        const sessionInfo = sessionCfg.activeBotId 
          ? `本会话启用: ${getBotDisplayName(activeBot!)}` 
          : "本会话未启用机器人";
        
        ctx.ui.notify(`全局机器人列表（共 ${globalBots.length} 个）:\n${list}\n${sessionInfo}`, "info");
      }
    },
  });

  // 【会话配置】切换当前会话启用的机器人
  pi.registerCommand("dingtalkbot-use", {
    description: "切换机器人（本会话）",
    handler: async (_args, ctx) => {
      const globalCfg = await loadGlobalConfig();
      globalBots = globalCfg.bots;
      
      if (globalBots.length === 0) {
        ctx.ui.notify("暂无配置的机器人，请先添加", "warning");
        return;
      }
      
      const options = globalBots.map(b => {
        const isActive = b.clientId === sessionCfg.activeBotId;
        return `${isActive ? "▶ " : "○ "}${getBotDisplayName(b)}`;
      });
      
      const selected = await ctx.ui.select("选择机器人（仅本会话）", options);
      if (!selected) return;
      
      const selectedLabel = selected.replace(/^[▶○] /, "");
      const bot = globalBots.find(b => 
        getBotDisplayName(b) === selectedLabel || 
        b.clientId === selectedLabel
      );
      if (!bot) {
        ctx.ui.notify("❌ 机器人不存在", "error");
        return;
      }

      sessionCfg.activeBotId = bot.clientId;
      sessionCfg.enabled = true;
      await saveSessionConfig(sessionCfg);
      
      ctx.ui.notify(`✅ 本会话已切换到 ${getBotDisplayName(bot)}`, "info");
      await connect(ctx, bot);
    },
  });

  // 【全局配置】删除机器人
  pi.registerCommand("dingtalkbot-remove", {
    description: "删除机器人（全局）",
    handler: async (_args, ctx) => {
      const globalCfg = await loadGlobalConfig();
      globalBots = globalCfg.bots;
      
      if (globalBots.length === 0) {
        ctx.ui.notify("暂无配置的机器人", "warning");
        return;
      }
      
      const name = await ctx.ui.input("输入要删除的ClientID或名称", "");
      if (!name) return;

      const idx = globalBots.findIndex(b => 
        b.clientId === name || 
        b.name === name
      );
      if (idx === -1) {
        ctx.ui.notify("❌ 机器人不存在", "error");
        return;
      }

      const removed = globalBots.splice(idx, 1)[0];
      const removedName = getBotDisplayName(removed);
      
      await saveGlobalConfig({ bots: globalBots });
      
      if (sessionCfg.activeBotId === removed.clientId) {
        disconnect();
        const nextBot = globalBots[0];
        sessionCfg.activeBotId = nextBot?.clientId;
        await saveSessionConfig(sessionCfg);
        
        if (nextBot) {
          ctx.ui.notify(`✅ 已删除 ${removedName}，自动切换到 ${getBotDisplayName(nextBot)}`, "info");
          if (sessionCfg.enabled) await connect(ctx, nextBot);
        } else {
          ctx.ui.notify(`✅ 已删除 ${removedName}（无可用机器人）`, "info");
        }
      } else {
        ctx.ui.notify(`✅ 已删除 ${removedName}`, "info");
      }
    },
  });

  // 【混合】状态查看
  pi.registerCommand("dingtalkbot-status", {
    description: "查看机器人状态",
    handler: async (_args, ctx) => {
      const globalCfg = await loadGlobalConfig();
      globalBots = globalCfg.bots;
      
      const active = getActiveBot(globalBots, sessionCfg.activeBotId);
      if (!active) {
        ctx.ui.notify(
          `全局机器人: ${globalBots.length} 个
本会话状态: 未选择机器人`,
          "info"
        );
        return;
      }
      
      let statusIcon: string;
      let statusText: string;
      
      if (!sessionCfg.enabled) {
        statusIcon = "🔴";
        statusText = "已禁用";
      } else if (connected) {
        statusIcon = "✅";
        statusText = "已连接";
      } else {
        statusIcon = "❌";
        statusText = "已断开";
      }
      
      ctx.ui.notify(
        `${statusIcon} ${getBotDisplayName(active)}
状态: ${statusText}
ClientID: ${active.clientId}
全局机器人: ${globalBots.length} 个
本会话活跃会话: ${sessions.size} 个
会话ID: ${SESSION_ID.slice(0, 8)}`,
        "info"
      );
    },
  });

  // 【会话配置】启用本会话连接
  pi.registerCommand("dingtalkbot-enable", {
    description: "启用机器人（本会话）",
    handler: async (_args, ctx) => {
      if (sessionCfg.enabled) {
        ctx.ui.notify("本会话机器人已是启用状态", "info");
        return;
      }
      sessionCfg.enabled = true;
      await saveSessionConfig(sessionCfg);
      
      const bot = getActiveBot(globalBots, sessionCfg.activeBotId);
      if (bot) {
        await connect(ctx, bot);
        ctx.ui.notify(`✅ 本会话已启用并连接 ${getBotDisplayName(bot)}`, "info");
      } else {
        ctx.ui.notify("✅ 本会话已启用，但未选择机器人，请先添加或使用 /dingtalkbot-use 选择", "warning");
      }
      setStatus();
    },
  });

  // 【会话配置】禁用本会话连接
  pi.registerCommand("dingtalkbot-disable", {
    description: "禁用机器人（本会话）",
    handler: async (_args, ctx) => {
      if (!sessionCfg.enabled) {
        ctx.ui.notify("本会话机器人已是禁用状态", "info");
        return;
      }
      sessionCfg.enabled = false;
      await saveSessionConfig(sessionCfg);
      disconnect();
      ctx.ui.notify("🔌 本会话已禁用机器人并断开连接", "info");
      setStatus();
    },
  });

  // 【会话】查看会话详情
  pi.registerCommand("dingtalkbot-session", {
    description: "查看当前会话详情",
    handler: async (_args, ctx) => {
      if (sessions.size === 0) {
        ctx.ui.notify("暂无活跃会话", "info");
        return;
      }
      const active = getActiveBot(globalBots, sessionCfg.activeBotId);
      const sessionList = Array.from(sessions.entries()).map(([messageId, s]) => 
        `[${active ? getBotDisplayName(active) : s.botId}]
  messageId: ${messageId}
  sender: ${s.senderNick} (${s.senderStaffId})
  conversationId: ${s.conversationId}`
      ).join("\n\n");
      ctx.ui.notify(`当前会话:\n${sessionList}`, "info");
    },
  });

  // 【会话】查看会话信息
  pi.registerCommand("dingtalkbot-session-info", {
    description: "查看会话信息",
    handler: async (_args, ctx) => {
      const info = [
        `会话ID: ${SESSION_ID}`,
        `全局配置: ${GLOBAL_CONFIG}`,
        `会话配置: ${SESSION_CONFIG}`,
        `临时目录: ${TEMP}`,
        ``,
        `【全局】机器人数量: ${globalBots.length}`,
        `【会话】启用机器人: ${sessionCfg.activeBotId || "无"}`,
        `【会话】启用状态: ${sessionCfg.enabled ? "✅" : "🔴"}`,
        `【会话】连接状态: ${connected ? "🟢 已连接" : "⚪ 未连接"}`,
        `【会话】活跃消息会话: ${sessions.size} 个`,
      ].join("\n");
      ctx.ui.notify(info, "info");
    },
  });

  // ============================================================================
  // Events
  // ============================================================================

  pi.on("session_start", async (_e, ctx) => {
    try {
      // 加载全局机器人列表
      const globalCfg = await loadGlobalConfig();
      globalBots = globalCfg.bots;
      
      // 加载本会话配置
      sessionCfg = await loadSessionConfig();
      
      await mkdir(TEMP, { recursive: true });
      
      // 如果启用了且选择了机器人，则尝试连接（失败不影响 pi）
      if (sessionCfg.enabled && sessionCfg.activeBotId) {
        const bot = getBotById(globalBots, sessionCfg.activeBotId);
        if (bot) {
          const success = await connect(ctx, bot);
          if (!success) {
            console.log(`[dingtalkbot] 连接失败，但不影响 pi 使用`);
          }
        }
      }
      
      setStatus();
    } catch (err) {
      console.error(`[dingtalkbot] session_start 异常:`, err);
      // 不影响 pi 启动
    }
  });

  pi.on("session_shutdown", () => { 
    try {
      disconnect(); 
    } catch (err) {
      console.error(`[dingtalkbot] session_shutdown 异常:`, err);
    }
  });

  pi.on("before_agent_start", async (e) => ({
    systemPrompt: e.systemPrompt + PROMPT,
  }));

  pi.on("agent_end", async (e, ctx) => {
    setStatus();
    if (!lastMessageId || !sessions.has(lastMessageId) || hasReplied) return;
    
    const msg = e.messages[e.messages.length - 1] as any;
    if (!msg?.content) return;
    
    const txt = (msg.content as any[])?.find((b: any) => b.type === "text")?.text;
    if (!txt) return;
    
    const active = getActiveBot(globalBots, sessionCfg.activeBotId);
    const botName = active?.name || active?.clientId || "";
    const pattern = new RegExp(`\\[dingtalkbot\\] \\[${botName}\\] \\[([^\\]]+)\\]\\n?`, "g");
    const replyContent = txt.replace(pattern, "");
    
    if (replyContent.trim()) {
      hasReplied = true;
      await replyTo(lastMessageId, replyContent);
      console.log(`[dingtalkbot] 回复: ${replyContent.slice(0, 50)}`);
      
      setTimeout(() => {
        lastMessageId = "";
        hasReplied = false;
      }, 1000);
    }
  });
}
