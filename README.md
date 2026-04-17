# pi-dingtalkbot

> 钉钉智能机器人 Stream 长连接扩展 for pi

使用钉钉官方 `dingtalk-stream` SDK 实现。

## 功能特性

- 🔗 **Stream 长连接** - 自动重连，断线无忧
- 🤖 **多机器人支持** - 支持配置多个机器人，快速切换
- 🏠 **全局配置共享** - 机器人列表全局共享，所有会话可见
- 🎯 **会话独立选择** - 每个会话独立选择启用哪个机器人
- 👥 **多人会话管理** - 按 messageId 区分不同用户
- 🔄 **消息自动转发** - 收到 @机器人 的消息自动处理
- 📤 **回复自动发送** - AI 回复自动发送到钉钉

## 安装

### 通过 npm（推荐）
```bash
pi install npm:pi-dingtalkbot
```

### 通过 Git
```bash
pi install git:github.com/huang-x-h/pi-dingtalkbot
```

### 本地开发
```bash
pi install ./D:/codebase/github/pi-dingtalkbot
```

## 快速开始

### 1. 获取钉钉机器人凭证

1. 登录 [钉钉开发者后台](https://open.dingtalk.com/)
2. 创建**企业内部应用**
3. 在**应用功能**中添加**机器人**能力
4. 选择 **Stream 模式** 并发布
5. 在**应用详情**获取：
   - **ClientID**（即 AppKey）
   - **ClientSecret**（即 AppSecret）

### 2. 添加机器人（全局配置）

```
/dingtalkbot-add
# 机器人名称(可选): 我的助手
# ClientID (AppKey): dingxxxxxxxxxxxxxxxx
# ClientSecret (AppSecret): xxxxxxxxxxxxxxx
```

> 添加后所有会话都能看到这个机器人

### 3. 查看机器人列表（全局）

```
/dingtalkbot-list

输出示例：
全局机器人列表（共 2 个）：
▶ ✅ 我的助手...  ← ▶ 表示本会话正在使用
○ 测试助手...
本会话启用: 我的助手...
```

### 4. 选择本会话使用的机器人

```
/dingtalkbot-use
# 选择机器人（仅本会话）: 测试助手

✅ 本会话已切换到 测试助手...
```

## 配置参数说明

钉钉 Stream 模式只需要两个核心参数：

| 参数 | 说明 | 获取位置 |
|------|------|----------|
| **ClientID** | 即 AppKey，应用的唯一标识 | 钉钉开发者后台 → 应用详情 |
| **ClientSecret** | 即 AppSecret，应用的密钥 | 钉钉开发者后台 → 应用详情 |

> ⚠️ **注意**：需要在应用中开通"机器人"能力，并选择 **Stream 模式** 发布后才能使用。

## 完整命令说明

### 全局配置命令

#### `/dingtalkbot-add` - 添加机器人（全局）

添加机器人到全局配置，**所有会话都能使用**。

```
/dingtalkbot-add
  机器人名称(可选): 工作助手
  ClientID (AppKey): dingxxxxxxxxxxxxx
  ClientSecret (AppSecret): xxxxxxxxxxxxxxx

✅ 已添加 工作助手...（全局配置）
```

#### `/dingtalkbot-list` - 列出机器人（全局）

显示全局机器人列表，带本会话启用标记：
- `▶` - 本会话正在使用的机器人
- `○` - 其他机器人
- `✅` - 当前已连接

#### `/dingtalkbot-remove` - 删除机器人（全局）

从全局配置删除机器人，**所有会话都将失去该机器人**。

### 会话配置命令

#### `/dingtalkbot-use` - 切换机器人（本会话）

选择本会话使用哪个机器人，**不影响其他会话**。

#### `/dingtalkbot-enable` - 启用机器人（本会话）

启用本会话的机器人连接。

#### `/dingtalkbot-disable` - 禁用机器人（本会话）

禁用本会话的机器人连接，**不影响其他会话**。

#### `/dingtalkbot-status` - 查看状态

显示混合信息：全局机器人数量 + 本会话详细状态。

```
✅ 工作助手...
状态: 已连接
ClientID: dingxxxxxxxxxxxxx
全局机器人: 3 个
本会话活跃会话: 2 个
会话ID: abc12345
```

#### `/dingtalkbot-session-info` - 会话信息

显示本会话的配置详情。

## Tools

### `dingtalkbot-send`

发送消息到钉钉。

```typescript
{
  message: string;      // 要发送的消息内容
  format?: "text" | "markdown";  // 消息格式，默认 text
}
```

**示例：**
```
使用 dingtalkbot-send 发送消息 "你好" 到钉钉
使用 dingtalkbot-send 发送 markdown 格式消息 "# 标题\n这是内容" 到钉钉
```

### `dingtalkbot-attach`

发送文件列表到钉钉（钉钉机器人不支持直接发送文件附件，将转为消息列表形式通知）。

```typescript
{
  paths: string[];  // 文件路径列表（最多10个）
}
```

**示例：**
```
使用 dingtalkbot-attach 发送文件 "D:/documents/report.pdf"
使用 dingtalkbot-attach 发送多个文件 ["file1.txt", "file2.txt"]
```

## ⚠️ 重要限制

> **同一机器人（ClientID）只能在一个会话中连接**
>
> 钉钉官方限制：同一个 ClientID 同时只能有一个 Stream 连接。

### 冲突场景

```
Session A (已连接工作助手)     Session B
├─ 状态: ✅ 工作助手            ├─ 执行 /dingtalkbot-use 工作助手
├─ 运行中                      ├─ 连接成功
│                              │
│  ◄──── 被踢掉 ──────────────┤
│
└─ 状态: ❌ 被其他会话连接      └─ 状态: ✅ 工作助手
```

### 解决方式

1. **不同会话使用不同机器人**（推荐）
   - Session A: 工作助手 (ClientID-A)
   - Session B: 个人助手 (ClientID-B)

2. **手动切换**
   - 在 Session A 执行 `/dingtalkbot-disable` 断开
   - 在 Session B 执行 `/dingtalkbot-enable` 连接

## 配置存储

| 类型 | 路径 | 内容 | 共享方式 |
|------|------|------|---------|
| **全局配置** | `~/.pi/agent/dingtalk-bot.json` | 机器人列表 (clientId, clientSecret, name) | **所有会话共享** |
| **会话配置** | `~/.pi/agent/dingtalk-bot-session-{id}.json` | activeBotId, enabled | **仅本会话** |
| **临时文件** | `~/.pi/agent/tmp/dingtalk-bot/{id}/` | 上传文件等 | **仅本会话** |

## 工作原理

```
┌─────────────────────────────────────────────────────────────┐
│                         pi 会话 A                            │
│  ┌─────────────────┐        ┌─────────────────────────────┐ │
│  │  全局配置加载    │◄───────│  ~/.pi/agent/dingtalk-bot.json│ │
│  │  bots: [...]    │        │  机器人列表（共享）          │ │
│  └─────────────────┘        └─────────────────────────────┘ │
│           │                                                  │
│           ▼                                                  │
│  ┌─────────────────┐        ┌─────────────────────────────┐ │
│  │  会话配置加载    │◄───────│ dingtalk-bot-session-A.json   │ │
│  │  activeBotId    │        │  activeBotId, enabled       │ │
│  │  enabled        │        │  （本会话独立）              │ │
│  └─────────────────┘        └─────────────────────────────┘ │
│           │                                                  │
│           ▼                                                  │
│  ┌─────────────────┐                                       │
│  │   DWClient      │◄──────────────┐                       │
│  │   Stream 连接    │               │                       │
│  └─────────────────┘               │                       │
│           │                        │                       │
│           ▼                        │                       │
│  ┌─────────────────┐               │                       │
│  │   钉钉           │◄──────────────┘                       │
│  │   Stream 网关    │                                      │
│  └─────────────────┘                                       │
│                                                              │
│  回复消息:                                                   │
│  ┌─────────────────┐                                       │
│  │   HTTP API      │────────► 钉钉服务器                   │
│  │   sessionWebhook │     (通过消息中的 webhook 地址)       │
│  └─────────────────┘                                       │
└─────────────────────────────────────────────────────────────┘
```

## 参考

- [钉钉智能机器人开发文档](https://open.dingtalk.com/document/development/development-robot-overview)
- [钉钉消息接口文档](https://open.dingtalk.com/document/development/message-corpconversation-overview)
- [Stream 模式介绍](https://open.dingtalk.com/document/development/introduction-to-stream-mode)
- [dingtalk-stream SDK](https://www.npmjs.com/package/dingtalk-stream)

## License

MIT
