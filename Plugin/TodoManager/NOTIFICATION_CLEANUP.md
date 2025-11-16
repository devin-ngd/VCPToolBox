# Windows 通知机制清理说明

## 📝 背景

TodoManager 的提醒机制经过重构，从 **AgentMessage** 改为 **VCPLog + 定时任务调度器** 的混合架构。

## 🔄 变更内容

### 1. ReminderDaemon.js
**修改前：**
```javascript
console.log(`消息发送方式: AgentMessage 插件（WebSocket 广播）`);
console.log(`提醒缓冲: ${REMINDER_BUFFER / 1000} 秒`);
console.log(`重试间隔: ${RETRY_INTERVAL / 1000} 秒`);
```

**修改后：**
```javascript
console.log(`消息发送方式: VCPLog（WebSocket 广播）`);
// 移除了已废弃的 REMINDER_BUFFER 和 RETRY_INTERVAL
```

**原因：** 更新日志信息以反映实际使用的通知机制（VCPLog 而非 AgentMessage）。

---

### 2. VCPWinNotify.Py（增强版）

**移除的代码：**
```python
elif data.get("type") == "agent_message" and data.get("data"):
    # 处理来自 AgentMessage 的消息（例如待办提醒）
    msg_data = data["data"]
    agent_name = msg_data.get("recipient", "Agent")
    message_content = msg_data.get("message", "")

    lines = message_content.split("\n", 1)
    if "【" in lines[0] and "】" in lines[0]:
        notification_title = lines[0].strip()
        notification_content = lines[1] if len(lines) > 1 else message_content
    else:
        notification_title = f"{agent_name} 的消息"
        notification_content = message_content

    show_notification(notification_title, notification_content)
```

**保留的代码：**
```python
if data.get("type") == "vcp_log" and data.get("data"):
    # 处理 VCPLog 消息
    # ...
elif data.get("type") == "connection_ack":
    # 连接确认
    # ...
else:
    # 记录未处理的消息类型
    print(f"收到未处理的消息类型: {data.get('type', 'unknown')}")
```

---

### 3. WinNotify.py（基础版）

**移除的代码：**
```python
if log_data.get("type") == "agent_message" and "message" in log_data:
    notification_content = log_data["message"]
    if "title" in log_data:
        notification_title = log_data["title"]
```

**简化原因：** VCPLog 已经统一处理所有通知，不再需要内嵌的 `agent_message` 处理逻辑。

---

## 🎯 当前架构

### 提醒消息流向

```
┌─────────────────────────────────────────────────────────┐
│                   TodoManager 提醒系统                    │
└─────────────────────────────────────────────────────────┘
                         │
                         ├── 单次提醒（定时任务）
                         │   └─> VCPTimedContacts/*.json
                         │       └─> RemindTodo 命令
                         │           └─> 工具调用结果返回给 AI
                         │
                         └── 周期提醒（Daemon）
                             ├─> 每日汇总（8:00）
                             └─> 逾期检查（每小时）
                                 └─> HTTP POST /internal/vcplog-broadcast
                                     └─> VCPLog WebSocket 广播
                                         └─> Windows 通知客户端
                                             ├─> VCPWinNotify.Py
                                             └─> WinNotify.py
```

### 消息类型处理

| 消息类型 | 发送者 | 接收处理 | 用途 |
|---------|--------|---------|------|
| `vcp_log` | ReminderDaemon | ✅ Python 客户端 | 每日汇总、逾期提醒 |
| `connection_ack` | WebSocketServer | ✅ Python 客户端 | 连接确认 |
| `agent_message` | AgentMessage 插件 | ❌ **已废弃** | 旧的 Agent 间通信 |

---

## 🗑️ 为什么移除 AgentMessage 处理？

### 1️⃣ **TodoManager 不再使用**
- 单次提醒通过 **定时任务调度器** 触发
- 周期提醒通过 **VCPLog** 发送
- 无任何代码调用 AgentMessage 插件

### 2️⃣ **代码冗余**
```python
# WinNotify.py - 移除前有两层处理
if data.get("type") == "vcp_log":
    if log_data.get("type") == "agent_message":  # 内层处理
        # ... 嵌套的 agent_message 处理
```
- VCPLog 已经是统一的通知通道
- 不需要在 VCPLog 内再处理 agent_message 子类型

### 3️⃣ **避免混淆**
- **AgentMessage 插件** 仍然存在于系统中（`Plugin/AgentMessage/AgentMessage.js`）
- 但 **TodoManager 不使用它**
- 保留旧代码会误导维护者

---

## ✅ 验证清单

- [x] ReminderDaemon.js 日志显示 "VCPLog（WebSocket 广播）"
- [x] Python 客户端只处理 `vcp_log` 和 `connection_ack`
- [x] 移除 `agent_message` 嵌套处理逻辑
- [x] 记录未处理的消息类型（便于调试）
- [x] 保持向后兼容（忽略未知消息类型，不崩溃）

---

## 📌 注意事项

### AgentMessage 插件未删除
虽然 TodoManager 不再使用，但 **AgentMessage 插件本身保留**：
- 位置：`Plugin/AgentMessage/AgentMessage.js`
- 原因：可能被其他插件或功能使用
- 如需删除，需全局搜索确认无依赖

### 如果需要恢复 AgentMessage 支持
如果未来其他插件需要通过 AgentMessage 发送通知：

1. 在 Python 客户端添加顶级处理：
```python
elif data.get("type") == "agent_message" and data.get("data"):
    msg_data = data["data"]
    message = msg_data.get("message", "")
    show_notification("Agent 消息", message)
```

2. **不要** 在 VCPLog 内嵌套处理 agent_message

---

## 📚 相关文档

- [TodoManager README](./README.md) - 用户指南
- [DAEMON_GUIDE.md](./DAEMON_GUIDE.md) - Daemon 守护进程说明
- [test_default_reminder.md](./test_default_reminder.md) - 测试指南

---

**更新日期：** 2025-10-31
**相关 Issue：** 清理 Windows 通知机制代码冗余
**影响范围：** VCPWinNotify.Py, WinNotify.py, ReminderDaemon.js
