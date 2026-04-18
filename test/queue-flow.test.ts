/**
 * 消息队列流程模拟测试
 * 
 * 模拟完整的流程：
 * 1. 消息入队
 * 2. processNextMessage 处理
 * 3. agent_end 触发
 * 4. 继续处理下一条
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('消息队列完整流程模拟', () => {
  // 模拟状态
  let messageQueue: any[] = [];
  let isProcessing = false;
  let currentProcessingMessageId: string | null = null;
  let messageTimeouts: Map<string, any> = new Map();
  let dingTalkSessions: Map<string, any> = new Map();
  let processedMessages: string[] = [];
  let piMessages: any[] = []; // 模拟 pi 接收到的消息

  // 模拟 pi.sendUserMessage
  const mockPiSendUserMessage = vi.fn();
  
  // 模拟 sendReply
  const mockSendReply = vi.fn();

  beforeEach(() => {
    messageQueue = [];
    isProcessing = false;
    currentProcessingMessageId = null;
    messageTimeouts.clear();
    dingTalkSessions.clear();
    processedMessages = [];
    piMessages = [];
    mockPiSendUserMessage.mockClear();
    mockSendReply.mockClear();
  });

  // 模拟 registerCallbackListener 中的处理
  async function onDingTalkMessage(message: any) {
    const { messageId, senderNick, sessionWebhook, content, botName } = message;
    
    console.log(`[模拟] 消息入队 [${messageId}], 当前队列长度: ${messageQueue.length}`);
    
    // 消息入队
    messageQueue.push({ messageId, senderNick, sessionWebhook, content, botName });
    
    // 尝试启动处理
    await processNextMessage();
  }

  // 模拟 processNextMessage
  async function processNextMessage() {
    console.log(`[模拟] processNextMessage 被调用, isProcessing=${isProcessing}, queueLength=${messageQueue.length}`);
    
    if (isProcessing) {
      console.log(`[模拟] 正在处理中，跳过`);
      return;
    }
    
    if (messageQueue.length === 0) {
      console.log(`[模拟] 队列为空，跳过`);
      return;
    }
    
    isProcessing = true;
    const msg = messageQueue.shift()!;
    const { messageId, senderNick, sessionWebhook, content, botName } = msg;
    
    console.log(`[模拟] 开始处理消息 ${messageId}, 队列剩余: ${messageQueue.length}`);
    
    currentProcessingMessageId = messageId;
    
    // 存储会话
    dingTalkSessions.set(messageId, {
      messageId,
      senderNick,
      sessionWebhook,
      timestamp: Date.now()
    });
    
    // 构造消息文本
    const messageText = `[dingtalkbot] [${botName}] [${senderNick}] [${messageId}]\n${content}`;
    
    // 模拟发送给 pi
    piMessages.push({ messageId, text: messageText });
    mockPiSendUserMessage(messageText);
    
    console.log(`[模拟] 已发送给 pi [${messageId}]，等待处理完成...`);
    
    // 注意：这里不等待，isProcessing 保持 true
    // 等待 agent_end 触发
  }

  // 模拟 agent_end
  async function onAgentEnd(piResponse: any) {
    const { messageId, content } = piResponse;
    
    console.log(`[模拟] agent_end 触发, messageId=${messageId}, current=${currentProcessingMessageId}`);
    
    // 找到会话
    const session = dingTalkSessions.get(messageId);
    if (session) {
      mockSendReply(content);
      console.log(`[模拟] 回复钉钉用户: ${content.slice(0, 30)}...`);
      dingTalkSessions.delete(messageId);
    }
    
    // 关键逻辑：是否继续处理下一条
    const shouldContinue = (messageId && messageId === currentProcessingMessageId) || 
                           (isProcessing && messageQueue.length > 0);
    
    console.log(`[模拟] shouldContinue=${shouldContinue}, isProcessing=${isProcessing}, queue=${messageQueue.length}`);
    
    if (shouldContinue) {
      const completedId = messageId || currentProcessingMessageId;
      console.log(`[模拟] 消息 ${completedId} 处理完成，继续下一条，队列剩余: ${messageQueue.length}`);
      
      isProcessing = false;
      currentProcessingMessageId = null;
      processedMessages.push(completedId);
      
      // 触发下一条
      if (messageQueue.length > 0) {
        await processNextMessage();
      }
    } else {
      console.log(`[模拟] 不继续处理: messageId=${messageId}, current=${currentProcessingMessageId}, isProcessing=${isProcessing}`);
    }
  }

  /**
   * 测试场景1：正常顺序处理两条消息
   */
  it('应该顺序处理两条消息', async () => {
    // 消息1到达
    await onDingTalkMessage({
      messageId: 'msg1',
      senderNick: '用户A',
      sessionWebhook: 'webhook1',
      content: '消息1内容',
      botName: '机器人'
    });
    
    expect(messageQueue.length).toBe(0);
    expect(isProcessing).toBe(true);
    expect(currentProcessingMessageId).toBe('msg1');
    
    // 消息2到达（正在处理消息1）
    await onDingTalkMessage({
      messageId: 'msg2',
      senderNick: '用户A',
      sessionWebhook: 'webhook1',
      content: '消息2内容',
      botName: '机器人'
    });
    
    expect(messageQueue.length).toBe(1);
    expect(messageQueue[0].messageId).toBe('msg2');
    
    // 模拟 pi 处理完成消息1
    await onAgentEnd({
      messageId: 'msg1',
      content: '回复消息1'
    });
    
    // 验证消息2开始处理
    expect(isProcessing).toBe(true);
    expect(currentProcessingMessageId).toBe('msg2');
    expect(messageQueue.length).toBe(0);
    expect(processedMessages).toContain('msg1');
    
    // 模拟 pi 处理完成消息2
    await onAgentEnd({
      messageId: 'msg2',
      content: '回复消息2'
    });
    
    expect(isProcessing).toBe(false);
    expect(currentProcessingMessageId).toBeNull();
    expect(processedMessages).toEqual(['msg1', 'msg2']);
  });

  /**
   * 测试场景2：快速连续发送3条消息
   */
  it('应该正确处理连续3条消息', async () => {
    // 连续发送3条消息
    await onDingTalkMessage({ messageId: 'msg1', senderNick: '用户A', sessionWebhook: 'webhook1', content: '内容1', botName: '机器人' });
    await onDingTalkMessage({ messageId: 'msg2', senderNick: '用户A', sessionWebhook: 'webhook1', content: '内容2', botName: '机器人' });
    await onDingTalkMessage({ messageId: 'msg3', senderNick: '用户A', sessionWebhook: 'webhook1', content: '内容3', botName: '机器人' });
    
    // 只有msg1在处理，其他在队列
    expect(currentProcessingMessageId).toBe('msg1');
    expect(messageQueue.length).toBe(2);
    expect(messageQueue.map(m => m.messageId)).toEqual(['msg2', 'msg3']);
    
    // 完成msg1
    await onAgentEnd({ messageId: 'msg1', content: '回复1' });
    
    expect(currentProcessingMessageId).toBe('msg2');
    expect(messageQueue.length).toBe(1);
    expect(messageQueue[0].messageId).toBe('msg3');
    
    // 完成msg2
    await onAgentEnd({ messageId: 'msg2', content: '回复2' });
    
    expect(currentProcessingMessageId).toBe('msg3');
    expect(messageQueue.length).toBe(0);
    
    // 完成msg3
    await onAgentEnd({ messageId: 'msg3', content: '回复3' });
    
    expect(isProcessing).toBe(false);
    expect(processedMessages).toEqual(['msg1', 'msg2', 'msg3']);
  });

  /**
   * 测试场景3：agent_end messageId 不匹配的情况
   */
  it('messageId不匹配时应使用兜底逻辑继续处理', async () => {
    await onDingTalkMessage({ messageId: 'msg1', senderNick: '用户A', sessionWebhook: 'webhook1', content: '内容1', botName: '机器人' });
    await onDingTalkMessage({ messageId: 'msg2', senderNick: '用户A', sessionWebhook: 'webhook1', content: '内容2', botName: '机器人' });
    
    // agent_end 返回错误的 messageId（模拟提取失败）
    await onAgentEnd({ messageId: 'wrong-id', content: '回复' });
    
    // 应该继续处理，因为 isProcessing=true 且 queue.length>0
    expect(currentProcessingMessageId).toBe('msg2');
    expect(processedMessages.length).toBe(1); // 有一条被处理
  });

  /**
   * 测试场景4：模拟真实场景 - 队列只增不减
   */
  it('模拟队列只增不减的问题场景', async () => {
    // 模拟用户报告的场景
    const messages = [];
    
    // 发送消息1
    await onDingTalkMessage({ messageId: 'msg1', senderNick: '用户', sessionWebhook: 'webhook', content: '测试1', botName: '机器人' });
    messages.push('msg1');
    
    // 等待"处理完成"
    await onAgentEnd({ messageId: 'msg1', content: '回复1' });
    
    // 此时应该开始处理msg2（如果有的话）
    // 但如果没有，isProcessing应该为false
    
    // 再发送消息2
    await onDingTalkMessage({ messageId: 'msg2', senderNick: '用户', sessionWebhook: 'webhook', content: '测试2', botName: '机器人' });
    messages.push('msg2');
    
    // 检查状态
    console.log(`[调试] 消息1完成后: isProcessing=${isProcessing}, current=${currentProcessingMessageId}, queue=${messageQueue.length}`);
    
    // 验证消息2应该开始处理（因为消息1已完成，isProcessing被重置）
    expect(currentProcessingMessageId).toBe('msg2');
  });
});
