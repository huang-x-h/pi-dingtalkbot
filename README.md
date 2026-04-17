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

## 快速开始

### 1. 获取钉钉机器人凭证

1. 登录 [钉钉开放平台](https://open.dingtalk.com/)
2. 创建企业内部应用
3. 添加机器人能力
4. 获取 **ClientID** 和 **ClientSecret**
5. 发布机器人版本

### 2. 添加机器人（全局配置）

```
/dingtalkbot-add
# 机器人名称(可选): 我的助手
# ClientID: dingxxxxxxxxxxxxxxxx
# ClientSecret: xxxxxxxxxxxxxxx
```

> 添加后所有会话都能看到这个机器人

### 3. 查看机器人列表（全局）

```
/dingtalkbot-list

输出示例：
全局机器人列表（共 2 个）：
▶ ✅ 助手A (ding111...)  ← ▶ 表示本会话正在使用
○ 助手B (ding222...)
本会话启用: 助手A
```

### 4. 选择本会话使用的机器人

```
/dingtalkbot-use
# 选择机器人（仅本会话）: 助手B

✅ 本会话已切换到 助手B
```

## 完整命令说明

### 全局配置命令

#### `/dingtalkbot-add` - 添加机器人（全局）

添加机器人到全局配置，**所有会话都能使用**。

```
/dingtalkbot-add
  名称: 工作助手
  ClientID: dingxxxxxxxxxxxxx
  ClientSecret: xxxxxxxxxxxxxxx

✅ 已添加 工作助手（全局配置）
```

#### `/dingtalkbot-list` - 列出机器人（全局）

显示全局机器人列表，带本会话启用标记：
- `▶` - 本会话正在使用的机器人
- `○` - 其他机器人
- `✅` - 当前已连接

```
/dingtalkbot-list

全局机器人列表（共 3 个）：
▶ ✅ 工作助手
○ 测试助手
○ 个人助手
本会话启用: 工作助手
```

#### `/dingtalkbot-remove` - 删除机器人（全局）

从全局配置删除机器人，**所有会话都将失去该机器人**。

```
/dingtalkbot-remove
  输入要删除的ClientID或名称: 工作助手

✅ 已删除 工作助手
```

### 会话配置命令

#### `/dingtalkbot-use` - 切换机器人（本会话）

选择本会话使用哪个机器人，**不影响其他会话**。

```
/dingtalkbot-use
  选择机器人（仅本会话）:
  ○ 工作助手
  ▶ 测试助手  ← 当前选择
  ○ 个人助手

✅ 本会话已切换到 测试助手
```

#### `/dingtalkbot-enable` - 启用机器人（本会话）

启用本会话的机器人连接。

```
/dingtalkbot-enable
✅ 本会话已启用并连接 工作助手
```

#### `/dingtalkbot-disable` - 禁用机器人（本会话）

禁用本会话的机器人连接，**不影响其他会话**。

```
/dingtalkbot-disable
🔌 本会话已禁用机器人并断开连接
```

#### `/dingtalkbot-status` - 查看状态

显示混合信息：全局机器人数量 + 本会话详细状态。

```
/dingtalkbot-status

✅ 工作助手
状态: 已连接
全局机器人: 3 个
本会话活跃会话: 2 个
会话ID: abc12345
```

#### `/dingtalkbot-session-info` - 会话信息

显示本会话的配置详情。

```
/dingtalkbot-session-info

会话ID: pid-1234
全局配置: ~/.pi/agent/dingtalk-bot.json
会话配置: ~/.pi/agent/dingtalk-bot-session-pid-1234.json
临时目录: ~/.pi/agent/tmp/dingtalk-bot/pid-1234

【全局】机器人数量: 3
【会话】启用机器人: dingxxxxxxxxxxxxx
【会话】启用状态: ✅
【会话】连接状态: 🟢 已连接
【会话】活跃消息会话: 2 个
```

## Tools

### `dingtalkbot-send`

发送消息到钉钉。

```typescript
{
  message: string;      // 要发送的消息内容
  format?: "text" | "markdown";  // 消息格式，默认 text
}
```

### `dingtalkbot-attach`

发送文件到钉钉（钉钉机器人不支持直接发送文件，将转为消息列表形式通知）。

```typescript
{
  paths: string[];  // 文件路径列表（最多10个）
}
```

## 使用场景示例

### 场景1：团队协作，共享机器人池

```
全局配置: 3 个机器人
├─ 工作助手 (ClientID-A)
├─ 测试助手 (ClientID-B)
└─ 个人助手 (ClientID-C)

Session A (张三)          Session B (李四)
├─ 选择: 工作助手          ├─ 选择: 测试助手
├─ 状态: ✅ 已连接         ├─ 状态: ✅ 已连接
└─ 独立运行               └─ 独立运行

Session C (王五)
├─ 选择: 个人助手
├─ 状态: ✅ 已连接
└─ 独立运行
```

**特点**：
- ✅ 机器人配置一次，团队共享
- ✅ 每个人独立选择使用哪个机器人
- ✅ 互不干扰

### 场景2：多项目并行

```
Terminal 1 (项目A)        Terminal 2 (项目B)
├─ /dingtalkbot-use       ├─ /dingtalkbot-use
│   选择: 项目A机器人      │   选择: 项目B机器人
├─ 状态: 🤖[1234] ✅       ├─ 状态: 🤖[5678] ✅
└─ 连接 ClientID-A        └─ 连接 ClientID-B
```

### 场景3：工作/生活分离

```
Session 1 (工作)          Session 2 (生活)
├─ 机器人: 工作助手        ├─ 机器人: 个人助手
├─ 配置: 公司钉钉应用      ├─ 配置: 个人钉钉应用
└─ 消息: 工作群           └─ 消息: 家庭群
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
│  │   智能机器人     │                                      │
│  └─────────────────┘                                       │
└─────────────────────────────────────────────────────────────┘
```

## 参考

- [钉钉智能机器人开发文档](https://open.dingtalk.com/document/development/development-robot-overview)
- [钉钉消息接口文档](https://open.dingtalk.com/document/development/message-corpconversation-overview)
- [dingtalk-stream SDK](https://www.npmjs.com/package/dingtalk-stream)

## License

MIT
