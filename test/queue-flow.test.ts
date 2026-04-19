/**
 * 钉钉机器人队列处理测试
 * 
 * 测试功能：
 * 1. 会话独立队列
 * 2. 消息去重
 * 3. 队列位置显示
 * 4. 进度通知
 * 5. send-and-wait
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ============================================================================
// 模拟状态
// ============================================================================

interface QueueItem {
  messageId: string;
  senderNick: string;
  sessionWebhook: string;
  content: string;
  botName: string;
  timestamp: number;
}

interface DingTalkSession {
  messageId: string;
  senderNick: string;
  sessionWebhook: string;
  conversationId: string;
  timestamp: number;
}

// 全局状态
let sessionQueues: Map<string, QueueItem[]>;
let sessionProcessing: Map<string, boolean>;
let processedMessages: Set<string>;
let notifiedPoints: Map<string, Set<number>>;
let messageTimeouts: Map<string, any>;
let dingTalkSessions: Map<string, DingTalkSession>;
let pendingReplies: Map<string, any>;

let currentProcessingMessageId: string | null;
let isProcessing: boolean;

let sentMessages: string[] = []; // 模拟发送的消息
let piMessages: string[] = [];   // 模拟 pi 接收的消息

// 进度通知配置
const PROGRESS_NOTIFY_POINTS = [
  { delay: 300000, message: "⏳ 还在处理中，请耐心等待..." },      // 5分钟
  { delay: 900000, message: "⏳ 处理时间较长，请继续等待..." },     // 15分钟
  { delay: 1800000, message: "⏳ 仍在处理中，可能需要较长时间..." }, // 30分钟
  { delay: 3600000, message: "⏳ 已处理超过1小时，感谢您的耐心..." }, // 1小时
];

// ============================================================================
// 模拟函数
// ============================================================================

const mockSendReply = vi.fn((webhook: string, content: string) => {
  sentMessages.push(content);
  return Promise.resolve();
});

function extractConversationId(webhook: string): string {
  const match = webhook.match(/access_token=([^&]+)/);
  return match?.[1] || webhook;
}

function isMessageProcessed(messageId: string): boolean {
  return processedMessages.has(messageId);
}

function markMessageProcessed(messageId: string) {
  processedMessages.add(messageId);
}

function isSessionProcessing(conversationId: string): boolean {
  return sessionProcessing.get(conversationId) || false;
}

function setSessionProcessing(conversationId: string, processing: boolean) {
  sessionProcessing.set(conversationId, processing);
}

function getSessionQueueLength(conversationId: string): number {
  return sessionQueues.get(conversationId)?.length || 0;
}

// 模拟 processNextForSession
async function processNextForSession(conversationId: string) {
  const queue = sessionQueues.get(conversationId);
  if (!queue || queue.length === 0) return;
  
  if (isSessionProcessing(conversationId)) return;
  setSessionProcessing(conversationId, true);
  
  const msg = queue.shift()!;
  const { messageId, senderNick, sessionWebhook, content, botName } = msg;
  
  currentProcessingMessageId = messageId;
  isProcessing = true;
  
  dingTalkSessions.set(messageId, {
    messageId,
    senderNick,
    sessionWebhook,
    conversationId,
    timestamp: Date.now()
  });

  const messageText = `[dingtalkbot] [${botName}] [${senderNick}] [${messageId}]\n${content}`;
  piMessages.push(messageText);
  
  // 不等待，agent_end 会触发
}

// 模拟消息到达
async function onMessage(message: {
  messageId: string;
  senderNick: string;
  sessionWebhook: string;
  content: string;
  botName: string;
}) {
  const { messageId, senderNick, sessionWebhook, content, botName } = message;
  const conversationId = extractConversationId(sessionWebhook);
  
  // 去重检查
  if (isMessageProcessed(messageId)) {
    return { skipped: true, reason: 'duplicate' };
  }
  markMessageProcessed(messageId);
  
  // 会话队列
  if (!sessionQueues.has(conversationId)) {
    sessionQueues.set(conversationId, []);
  }
  const queue = sessionQueues.get(conversationId)!;
  const queueLength = queue.length;
  
  // 入队
  queue.push({ messageId, senderNick, sessionWebhook, content, botName, timestamp: Date.now() });
  
  // 确认消息 - queueLength 是入队前队列中已有的消息数量
  let ackMessage = "👋 收到";
  if (queueLength > 0) {
    // 队列中有等待的消息，显示位置
    ackMessage = `👋 收到，你是第 ${queueLength + 1} 位，前面还有 ${queueLength} 条消息...`;
  } else if (isSessionProcessing(conversationId)) {
    // 队列为空但正在处理
    ackMessage = `👋 收到，正在处理中...`;
  } else {
    // 队列为空且没有处理中
    ackMessage = `👋 收到，正在思考中...`;
  }
  await mockSendReply(sessionWebhook, ackMessage);
  
  // 启动处理
  await processNextForSession(conversationId);
  
  return { queueLength, ackMessage };
}

// 模拟 agent_end
async function onAgentEnd(params: {
  messageId: string;
  content: string;
}) {
  const { messageId, content } = params;
  
  const session = dingTalkSessions.get(messageId);
  if (!session) return;
  
  await mockSendReply(session.sessionWebhook, content);
  dingTalkSessions.delete(messageId);
  
  // 清理 notifiedPoints
  notifiedPoints.delete(messageId);
  
  // 继续处理下一条
  if (session.conversationId) {
    isProcessing = false;
    currentProcessingMessageId = null;
    setSessionProcessing(session.conversationId, false);
    await processNextForSession(session.conversationId);
  }
}

// 模拟 send-and-wait
async function sendAndWait(
  sessionWebhook: string,
  content: string,
  options?: { timeout?: number }
): Promise<{ reply: string }> {
  const conversationId = extractConversationId(sessionWebhook);
  
  await mockSendReply(sessionWebhook, content);
  
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingReplies.delete(conversationId);
      reject(new Error("超时"));
    }, (options?.timeout || 300) * 1000);
    
    pendingReplies.set(conversationId, {
      conversationId,
      content,
      timeout,
      resolve,
      reject
    });
  });
}

// ============================================================================
// 测试
// ============================================================================

describe('钉钉机器人队列处理', () => {

  beforeEach(() => {
    // 重置状态
    sessionQueues = new Map();
    sessionProcessing = new Map();
    processedMessages = new Set();
    notifiedPoints = new Map();
    messageTimeouts = new Map();
    dingTalkSessions = new Map();
    pendingReplies = new Map();
    currentProcessingMessageId = null;
    isProcessing = false;
    sentMessages = [];
    piMessages = [];
    
    mockSendReply.mockClear();
  });

  afterEach(() => {
    // 清理所有定时器
    vi.clearAllTimers();
  });

  // ===========================================================================
  // 测试1：基础消息处理
  // ===========================================================================
  describe('基础消息处理', () => {

    it('应该正确处理单条消息', async () => {
      const result = await onMessage({
        messageId: 'msg1',
        senderNick: '用户A',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=tokenA',
        content: '你好',
        botName: '机器人'
      });

      expect(result.queueLength).toBe(0);
      expect(result.ackMessage).toBe('👋 收到，正在思考中...');
      expect(piMessages.length).toBe(1);
      expect(piMessages[0]).toContain('msg1');
      expect(sentMessages).toContain('👋 收到，正在思考中...');
    });

    it('应该在 agent_end 后处理下一条', async () => {
      await onMessage({
        messageId: 'msg1',
        senderNick: '用户A',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=tokenA',
        content: '消息1',
        botName: '机器人'
      });

      await onAgentEnd({ messageId: 'msg1', content: '回复1' });

      expect(sentMessages).toContain('回复1');
      expect(currentProcessingMessageId).toBeNull();
    });

  });

  // ===========================================================================
  // 测试2：会话独立队列
  // ===========================================================================
  describe('会话独立队列', () => {

    it('应该隔离不同会话的消息', async () => {
      // 用户A发消息
      await onMessage({
        messageId: 'msgA1',
        senderNick: '用户A',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=tokenA',
        content: 'A的消息1',
        botName: '机器人'
      });

      // 用户B发消息
      await onMessage({
        messageId: 'msgB1',
        senderNick: '用户B',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=tokenB',
        content: 'B的消息1',
        botName: '机器人'
      });

      // 用户A应该还在处理中（因为是独立队列）
      expect(isSessionProcessing('tokenA')).toBe(true);
      expect(isSessionProcessing('tokenB')).toBe(true);
      
      // 两个会话都在处理
      expect(currentProcessingMessageId).not.toBeNull();
    });

    it('同一会话的消息应该排队', async () => {
      // 用户A连续发3条消息
      await onMessage({
        messageId: 'msgA1',
        senderNick: '用户A',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=tokenA',
        content: 'A的消息1',
        botName: '机器人'
      });

      await onMessage({
        messageId: 'msgA2',
        senderNick: '用户A',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=tokenA',
        content: 'A的消息2',
        botName: '机器人'
      });

      await onMessage({
        messageId: 'msgA3',
        senderNick: '用户A',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=tokenA',
        content: 'A的消息3',
        botName: '机器人'
      });

      // 队列应该有2条（msgA1在处理）
      const queue = sessionQueues.get('tokenA');
      expect(queue?.length).toBe(2);
      expect(queue?.map(m => m.messageId)).toEqual(['msgA2', 'msgA3']);
    });

  });

  // ===========================================================================
  // 测试3：消息去重
  // ===========================================================================
  describe('消息去重', () => {

    it('应该丢弃重复消息', async () => {
      // 发同一条消息两次
      await onMessage({
        messageId: 'msg1',
        senderNick: '用户A',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=tokenA',
        content: '你好',
        botName: '机器人'
      });

      const result2 = await onMessage({
        messageId: 'msg1', // 相同的 messageId
        senderNick: '用户A',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=tokenA',
        content: '你好',
        botName: '机器人'
      });

      expect(result2.skipped).toBe(true);
      expect(result2.reason).toBe('duplicate');
      
      // 应该只发送一条确认
      const ackCount = sentMessages.filter(m => m.includes('👋 收到')).length;
      expect(ackCount).toBe(1);
      
      // pi 应该只收到一条消息
      expect(piMessages.length).toBe(1);
    });

  });

  // ===========================================================================
  // 测试4：队列位置显示
  // ===========================================================================
  describe('队列位置显示', () => {

    it('第一条消息应该显示"正在思考中"', async () => {
      const result = await onMessage({
        messageId: 'msg1',
        senderNick: '用户A',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=tokenA',
        content: '你好',
        botName: '机器人'
      });

      expect(result.ackMessage).toBe('👋 收到，正在思考中...');
    });

    it('第二条消息应该显示处理中（因为前一条已从队列移除）', async () => {
      // 先发一条
      await onMessage({
        messageId: 'msg1',
        senderNick: '用户A',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=tokenA',
        content: '你好',
        botName: '机器人'
      });

      // 再发一条
      const result = await onMessage({
        messageId: 'msg2',
        senderNick: '用户A',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=tokenA',
        content: '第二条',
        botName: '机器人'
      });

      // 因为 msg1 已被处理（从队列移除），所以队列为空，显示处理中
      expect(result.ackMessage).toBe('👋 收到，正在处理中...');
    });

    it('应该在消息处理完成后正确处理下一条', async () => {
      await onMessage({
        messageId: 'msg1',
        senderNick: '用户A',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=tokenA',
        content: '消息1',
        botName: '机器人'
      });

      await onMessage({
        messageId: 'msg2',
        senderNick: '用户A',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=tokenA',
        content: '消息2',
        botName: '机器人'
      });

      // 完成msg1后，msg2应该开始处理
      await onAgentEnd({ messageId: 'msg1', content: '回复1' });
      
      // 等待处理完成
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(piMessages.some(m => m.includes('msg2'))).toBe(true);
    });

  });

  // ===========================================================================
  // 测试5：进度通知
  // ===========================================================================
  describe('进度通知', () => {

    it('应该配置正确的通知时间点', () => {
      expect(PROGRESS_NOTIFY_POINTS[0].delay).toBe(5 * 60 * 1000);      // 5分钟
      expect(PROGRESS_NOTIFY_POINTS[1].delay).toBe(15 * 60 * 1000);    // 15分钟
      expect(PROGRESS_NOTIFY_POINTS[2].delay).toBe(30 * 60 * 1000);    // 30分钟
      expect(PROGRESS_NOTIFY_POINTS[3].delay).toBe(60 * 60 * 1000);    // 1小时
    });

    it('应该发送正确的通知消息', () => {
      expect(PROGRESS_NOTIFY_POINTS[0].message).toContain('还在处理中');
      expect(PROGRESS_NOTIFY_POINTS[1].message).toContain('处理时间较长');
      expect(PROGRESS_NOTIFY_POINTS[2].message).toContain('仍在处理中');
      expect(PROGRESS_NOTIFY_POINTS[3].message).toContain('超过1小时');
    });

    it('notifiedPoints 应该正确记录已发送通知', () => {
      const msgId = 'msg1';
      notifiedPoints.set(msgId, new Set());
      notifiedPoints.get(msgId)!.add(300000); // 5分钟已发送
      
      expect(notifiedPoints.get(msgId)?.has(300000)).toBe(true);
      expect(notifiedPoints.get(msgId)?.has(900000)).toBe(false);
    });

  });

  // ===========================================================================
  // 测试6：send-and-wait
  // ===========================================================================
  describe('send-and-wait', () => {

    it('应该发送消息并等待回复', async () => {
      const promise = sendAndWait(
        'https://oapi.dingtalk.com/robot/send?access_token=tokenA',
        '请确认',
        { timeout: 5 }
      );

      expect(sentMessages).toContain('请确认');
    });

    it('应该正确调用 sendReply', async () => {
      const promise = sendAndWait(
        'https://oapi.dingtalk.com/robot/send?access_token=tokenA',
        '请确认',
        { timeout: 5 }
      );

      // 消息应该被发送
      expect(sentMessages).toContain('请确认');
      
      // pendingReplies 应该被设置（由于 Promise 执行时机，可能需要等待）
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(pendingReplies.has('tokenA')).toBe(true);
    });

  });

  // ===========================================================================
  // 测试7：完整流程
  // ===========================================================================
  describe('完整流程', () => {

    it('应该正确处理两个用户的完整流程', async () => {
      // 用户A发消息
      await onMessage({
        messageId: 'msgA1',
        senderNick: '用户A',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=tokenA',
        content: 'A的消息',
        botName: '机器人'
      });

      // 用户B发消息
      await onMessage({
        messageId: 'msgB1',
        senderNick: '用户B',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=tokenB',
        content: 'B的消息',
        botName: '机器人'
      });

      // 两个会话都应该在处理中
      expect(isSessionProcessing('tokenA')).toBe(true);
      expect(isSessionProcessing('tokenB')).toBe(true);

      // 完成用户A的消息
      await onAgentEnd({ messageId: 'msgA1', content: 'A的回复' });
      expect(sentMessages).toContain('A的回复');
      expect(isSessionProcessing('tokenA')).toBe(false);

      // 完成用户B的消息
      await onAgentEnd({ messageId: 'msgB1', content: 'B的回复' });
      expect(sentMessages).toContain('B的回复');
      expect(isSessionProcessing('tokenB')).toBe(false);
    });

    it('应该正确处理同一用户的连续消息', async () => {
      // 用户A发3条消息
      await onMessage({
        messageId: 'msg1',
        senderNick: '用户A',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=tokenA',
        content: '消息1',
        botName: '机器人'
      });

      await onMessage({
        messageId: 'msg2',
        senderNick: '用户A',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=tokenA',
        content: '消息2',
        botName: '机器人'
      });

      await onMessage({
        messageId: 'msg3',
        senderNick: '用户A',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=tokenA',
        content: '消息3',
        botName: '机器人'
      });

      // msg1 应该在处理中
      expect(isSessionProcessing('tokenA')).toBe(true);
      expect(currentProcessingMessageId).toBe('msg1');

      // 完成msg1后，msg2应该开始处理
      await onAgentEnd({ messageId: 'msg1', content: '回复1' });
      expect(currentProcessingMessageId).toBe('msg2');

      // 完成msg2后，msg3应该开始处理
      await onAgentEnd({ messageId: 'msg2', content: '回复2' });
      expect(currentProcessingMessageId).toBe('msg3');

      // 完成msg3
      await onAgentEnd({ messageId: 'msg3', content: '回复3' });
      
      // 所有消息应该处理完成
      expect(sessionQueues.get('tokenA')?.length).toBe(0);
      expect(piMessages.length).toBe(3);
    });

  });

});
