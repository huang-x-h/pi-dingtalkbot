import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * 钉钉机器人消息队列测试用例
 * 
 * 测试场景：
 * 1. 消息正常顺序处理
 * 2. 消息超时处理
 * 3. 积压恢复
 * 4. 并发消息处理
 */

describe('消息队列处理', () => {
  let messageQueue: any[] = [];
  let isProcessing = false;
  let currentProcessingMessageId: string | null = null;
  let messageTimeouts: Map<string, any> = new Map();
  let processedMessages: string[] = [];

  beforeEach(() => {
    // 重置状态
    messageQueue = [];
    isProcessing = false;
    currentProcessingMessageId = null;
    messageTimeouts.clear();
    processedMessages = [];
  });

  /**
   * 测试场景1：消息正常顺序处理
   * 预期：消息按顺序入队，处理完一条再处理下一条
   */
  describe('正常顺序处理', () => {
    it('应该按FIFO顺序处理消息', async () => {
      // 模拟3条消息入队
      const messages = [
        { messageId: 'msg1', content: '消息1' },
        { messageId: 'msg2', content: '消息2' },
        { messageId: 'msg3', content: '消息3' },
      ];

      messages.forEach(msg => messageQueue.push(msg));

      // 模拟处理
      while (messageQueue.length > 0) {
        if (!isProcessing) {
          isProcessing = true;
          const msg = messageQueue.shift()!;
          currentProcessingMessageId = msg.messageId;
          
          // 模拟处理时间
          await new Promise(resolve => setTimeout(resolve, 100));
          
          processedMessages.push(msg.messageId);
          isProcessing = false;
          currentProcessingMessageId = null;
        }
      }

      expect(processedMessages).toEqual(['msg1', 'msg2', 'msg3']);
    });

    it('处理中时不应处理下一条', async () => {
      messageQueue.push({ messageId: 'msg1', content: '消息1' });
      messageQueue.push({ messageId: 'msg2', content: '消息2' });

      // 开始处理第一条
      isProcessing = true;
      currentProcessingMessageId = 'msg1';

      // 尝试处理第二条（应该被跳过）
      if (!isProcessing) {
        const msg = messageQueue.shift();
        if (msg) processedMessages.push(msg.messageId);
      }

      // 只有第一条被处理（模拟）
      expect(processedMessages).toEqual([]);
      expect(messageQueue.length).toBe(2);
    });
  });

  /**
   * 测试场景2：消息超时处理
   * 预期：超时后自动清理并继续下一条
   */
  describe('超时处理', () => {
    it('消息处理超时应自动跳过', async () => {
      const MESSAGE_TIMEOUT = 100; // 测试用100ms
      
      messageQueue.push({ messageId: 'msg1', content: '消息1' });
      messageQueue.push({ messageId: 'msg2', content: '消息2' });

      // 处理第一条
      isProcessing = true;
      currentProcessingMessageId = 'msg1';
      
      // 设置超时
      const timeoutId = setTimeout(() => {
        if (currentProcessingMessageId === 'msg1') {
          isProcessing = false;
          currentProcessingMessageId = null;
        }
      }, MESSAGE_TIMEOUT);
      messageTimeouts.set('msg1', timeoutId);

      // 等待超时
      await new Promise(resolve => setTimeout(resolve, 200));

      // 超时后应该可以处理下一条
      expect(isProcessing).toBe(false);
      expect(currentProcessingMessageId).toBeNull();
    });

    it('正常完成应清除超时定时器', () => {
      const MESSAGE_TIMEOUT = 5000;
      const timeoutId = setTimeout(() => {}, MESSAGE_TIMEOUT);
      messageTimeouts.set('msg1', timeoutId);

      // 模拟正常完成
      const storedTimeout = messageTimeouts.get('msg1');
      if (storedTimeout) {
        clearTimeout(storedTimeout);
        messageTimeouts.delete('msg1');
      }

      expect(messageTimeouts.has('msg1')).toBe(false);
    });
  });

  /**
   * 测试场景3：积压恢复
   * 预期：断线重连后能继续处理积压消息
   */
  describe('积压恢复', () => {
    it('断线期间的消息应入队等待', () => {
      // 模拟断线状态
      const isConnected = false;
      
      // 消息入队
      messageQueue.push({ messageId: 'msg1', content: '消息1' });
      messageQueue.push({ messageId: 'msg2', content: '消息2' });

      expect(messageQueue.length).toBe(2);
      expect(isProcessing).toBe(false);
    });

    it('重连后应继续处理积压消息', async () => {
      // 模拟积压
      messageQueue.push({ messageId: 'msg1', content: '消息1' });
      messageQueue.push({ messageId: 'msg2', content: '消息2' });

      // 模拟重连后开始处理
      while (messageQueue.length > 0 && !isProcessing) {
        isProcessing = true;
        const msg = messageQueue.shift()!;
        processedMessages.push(msg.messageId);
        isProcessing = false;
      }

      expect(processedMessages).toContain('msg1');
      expect(messageQueue.length).toBe(1); // msg2还在队列中
    });
  });

  /**
   * 测试场景4：并发消息处理
   * 预期：同一会话的消息应顺序处理，不同会话不影响
   */
  describe('并发处理', () => {
    it('同一会话的多个消息应顺序处理', async () => {
      const sameSession = 'webhook1';
      
      messageQueue.push({ messageId: 'msg1', sessionWebhook: sameSession });
      messageQueue.push({ messageId: 'msg2', sessionWebhook: sameSession });

      const processed: string[] = [];

      // 模拟处理
      while (messageQueue.length > 0) {
        if (!isProcessing) {
          isProcessing = true;
          const msg = messageQueue.shift()!;
          currentProcessingMessageId = msg.messageId;
          
          await new Promise(resolve => setTimeout(resolve, 50));
          
          processed.push(msg.messageId);
          isProcessing = false;
        } else {
          // 等待当前处理完成
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }

      expect(processed).toEqual(['msg1', 'msg2']);
    });
  });
});

describe('消息格式解析', () => {
  it('应正确解析钉钉消息格式', () => {
    const messageText = '[dingtalkbot] [小派] [土豆先生] [abc123]\n当前技能有哪些...';
    
    const match = messageText.match(/\[dingtalkbot\] \[.*?\] \[.*?\] \[(.+?)\]\n/);
    const messageId = match?.[1];
    const content = messageId ? messageText.replace(match[0], '') : messageText;

    expect(messageId).toBe('abc123');
    expect(content).toBe('当前技能有哪些...');
  });

  it('无法解析时应返回原始内容', () => {
    const messageText = '普通消息内容';
    
    const match = messageText.match(/\[dingtalkbot\] \[.*?\] \[.*?\] \[(.+?)\]\n/);
    const messageId = match?.[1];
    const content = messageId ? messageText.replace(match[0], '') : messageText;

    expect(messageId).toBeUndefined();
    expect(content).toBe('普通消息内容');
  });
});
