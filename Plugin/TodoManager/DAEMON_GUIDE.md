# TodoManager 提醒守护进程（简化版）指南

## 概述

TodoManager 提醒守护进程已优化为**混合模式**：
- **守护进程**：负责每日待办汇总、逾期检查等周期性任务
- **定时任务调度器**：负责单次待办提醒

这种架构充分利用了 VCP 系统的定时任务调度机制，减少了守护进程的负担，提高了提醒的精确性。

## 功能特性

### 1. 自动启动
- 当 VCP 系统启动并加载 TodoManager 插件时，提醒守护进程会自动启动
- 守护进程作为子进程运行，与主服务器独立但受其管理
- 无需手动操作

### 2. 守护进程职责（简化）
守护进程现在只负责以下周期性任务：

#### 每日待办汇总
- 默认每天早上 8 点发送（可通过 `DAILY_SUMMARY_HOUR` 配置）
- 汇总内容包括：
  - 🚨 逾期待办（已过期但未完成）
  - 📌 今日待办（今天截止）
  - 📋 未来待办（显示最近 3 个）
  - 📝 无截止日期的待办

#### 逾期待办检查
- 每小时检查一次（无需太频繁）
- 自动标记逾期状态
- 发送逾期提醒通知

### 3. 单次提醒（新机制）
单次待办提醒现在通过 **VCP 定时任务调度器** 实现：

- 创建待办时，如果设置了 `reminderTime`，会自动创建定时任务文件
- 任务文件存储在 `VCPTimedContacts/` 目录
- 到达提醒时间时，调度器自动调用 `TodoManager` 的 `RemindTodo` 命令
- 提醒完成后，任务文件自动删除

**优势**：
- ⚡ 更精确的时间控制（精确到秒）
- 📉 减少守护进程资源占用
- 🔄 自动清理已完成的提醒
- 🏗️ 符合 VCP 架构哲学

### 4. 自动关闭
- 当 VCP 系统关闭时，守护进程会自动停止
- 支持优雅关闭，确保所有正在处理的任务完成
- 如果守护进程 5 秒内未响应，会被强制终止

### 5. 日志输出
- 守护进程的所有日志会输出到 VCP 主控制台
- 日志前缀为 `[TodoManager/Daemon]`，方便识别
- 启动时会显示"简化版"标识

## 工作原理

### 配置文件
在 `plugin-manifest.json` 中添加了守护进程配置：

```json
{
  "daemon": {
    "enabled": true,
    "script": "ReminderDaemon.js",
    "description": "待办提醒守护进程，负责每日汇总和逾期检查"
  }
}
```

### 启动流程
1. VCP 系统启动
2. PluginManager 加载所有插件
3. 检测到 TodoManager 配置了守护进程
4. 自动启动 ReminderDaemon.js（简化版）
5. 守护进程开始周期性检查

### 停止流程

1. VCP 系统收到关闭信号（Ctrl+C 或 SIGTERM）
2. PluginManager 开始关闭流程
3. 向所有守护进程发送 SIGTERM 信号
4. 等待最多 5 秒让进程优雅退出
5. 超时则强制终止（SIGKILL）

## 环境变量配置

守护进程会继承 TodoManager 插件的环境变量配置（`Plugin/TodoManager/config.env`）：

```env
# 默认Agent名称（接收提醒的对象）
DEFAULT_AGENT_NAME=Nova

# 时区设置
TIMEZONE=Asia/Shanghai

# VCP服务器地址（用于发送提醒）
VCP_SERVER_HOST=localhost
VCP_SERVER_PORT=8855

# 每日待办汇总推送时间（小时，24小时制）
DAILY_SUMMARY_HOUR=9
```

## 单次提醒机制（新）

### 创建待办时自动创建定时任务

当你创建带有提醒时间的待办时：

```javascript
<<<[TOOL_REQUEST]>>>
tool_name:「始」TodoManager「末」,
command:「始」CreateTodo「末」,
title:「始」开会「末」,
when:「始」明天下午3点「末」,
remind:「始」提前10分钟「末」
<<<[END_TOOL_REQUEST]>>>
```

系统会自动：

1. 在 `VCPTimedContacts/` 目录创建一个定时任务文件
2. 文件名：`todo_remind_{todoId}.json`
3. 内容包含调用 `TodoManager` 的 `RemindTodo` 命令的信息

### 提醒触发流程

1. VCP 定时任务调度器监控 `VCPTimedContacts/` 目录
2. 到达提醒时间时，调度器自动执行任务
3. 调用 `TodoManager` 的 `RemindTodo` 命令
4. 通过 WebSocket 推送提醒到前端
5. 任务文件自动删除

### 更新/删除待办时的处理

- **更新待办时间**：删除旧的定时任务文件，创建新的
- **删除待办**：同时删除对应的定时任务文件
- **完成待办**：定时任务保留（如需要可手动清理）

## 守护进程职责（简化后）

### 1. 每日待办汇总

- **触发时间**：每天早上 8 点（可通过 `DAILY_SUMMARY_HOUR` 配置）
- **检查频率**：每 5 分钟检查一次是否到了发送时间
- **发送条件**：到达指定小时且当天还未发送过
- **汇总内容**：
  - 🚨 逾期待办（已过期但未完成）
  - 📌 今日待办（今天截止）
  - 📋 未来待办（显示最近 3 个）
  - 📝 无截止日期的待办

### 2. 逾期待办检查

- **检查频率**：每小时一次
- **触发条件**：待办有截止时间且已过期
- **操作**：发送逾期提醒，标记已提醒状态
- **避免重复**：同一待办只提醒一次逾期

### 3. 提醒消息格式

- **通过 WebSocket** 发送到 VCPLog 频道
- **消息类型**：
  - `daily_summary`：每日汇总
  - `overdue`：逾期提醒
  - `normal`：单次提醒（由定时任务触发）

## 禁用守护进程

如果需要禁用自动启动，可以修改 `plugin-manifest.json`：

```json
{
  "daemon": {
    "enabled": false,  // 改为 false
    "script": "ReminderDaemon.js",
    "description": "待办提醒守护进程"
  }
}
```

然后重启 VCP 系统即可。

**注意**：禁用守护进程后，每日汇总和逾期检查将不再工作，但单次提醒仍然正常（由定时任务调度器处理）。

## 故障排查

### 守护进程未启动

1. 检查 `plugin-manifest.json` 中 `daemon.enabled` 是否为 `true`
2. 查看启动日志，确认没有错误信息
3. 确认 `ReminderDaemon.js` 文件存在且无语法错误
4. 检查日志中是否有"简化版"标识

### 单次提醒未收到

1. 检查 `VCPTimedContacts/` 目录是否存在对应的任务文件
2. 查看定时任务调度器日志
3. 确认提醒时间格式正确
4. 检查待办的 `reminderTime` 字段

### 每日汇总未收到

1. 检查 `DAILY_SUMMARY_HOUR` 配置是否正确
2. 确认守护进程正在运行
3. 查看守护进程日志中的汇总发送记录
4. 确认 WebSocket 连接正常
3. 查看守护进程日志，确认提醒已发送

### 守护进程异常退出
1. 查看错误日志，找出退出原因
2. 检查 `data/todos.json` 文件格式是否正确
3. 确认环境变量配置无误

## 高级配置

### 修改检查间隔
在 `ReminderDaemon.js` 中修改：

```javascript
const CHECK_INTERVAL = 60 * 1000; // 改为你需要的间隔（毫秒）
```

### 修改提醒缓冲时间
```javascript
const REMINDER_BUFFER = 5 * 60 * 1000; // 改为你需要的缓冲时间（毫秒）
```

### 自定义每日汇总时间
在 `config.env` 中设置：

```env
DAILY_SUMMARY_HOUR=9  # 改为早上 9 点发送
```

## 日志示例

正常启动：
```
[PluginManager] 启动 TodoManager 守护进程: ReminderDaemon.js
[TodoManager/Daemon] ============================================================
[TodoManager/Daemon] [ReminderDaemon] TodoManager 提醒守护进程启动
[TodoManager/Daemon] ============================================================
[TodoManager/Daemon] ✓ 守护进程已启动 (PID: 12345)
```

发送提醒：
```
[TodoManager/Daemon] [ReminderDaemon] ✓ 已发送提醒: 购买生日礼物 -> Nova
```

系统关闭：
```
[PluginManager] 停止 TodoManager 守护进程...
[TodoManager/Daemon] [ReminderDaemon] 接收到停止信号，正在退出...
[TodoManager/Daemon] ✓ 守护进程已停止
```

## 总结

现在你完全不需要手动启动提醒守护进程了！只要启动 VCP 系统，TodoManager 的提醒功能就会自动工作。系统关闭时也会自动停止，非常方便。

## 技术更新 (2025-10-29)

### 内部 HTTP 推送机制（当前实现）


提醒守护进程通过调用 **AgentMessage 插件**，将提醒以 agent_message 格式发送至前端。

#### 实现方式

```js
// 调用 AgentMessage.js 插件进程
const { spawn } = require('child_process');
const proc = spawn('node', [agentMessagePath], {
    stdio: ['pipe', 'pipe', 'inherit']
});

// 发送参数
const params = {
    Maid: 'Nova',          // Agent 名称
    message: '提醒内容文本'  // 格式化后的提醒消息
};
proc.stdin.write(JSON.stringify(params));
proc.stdin.end();
```

AgentMessage 插件将自动通过 WebSocket 广播到前端的消息通道。

#### 优势

- ✅ 与其他 Agent 消息统一格式，便于前端查看和管理
- ✅ 利用现有插件机制，无需额外路由
- ✅ 消息带时间戳和 Agent 标识，追溯清晰

#### 启动延迟

为确保前端就绪，**每日待办汇总**在启动后延迟 **2分钟** 执行首次检查：

```text
[ReminderDaemon] 每日待办汇总将在2分钟后执行...
[ReminderDaemon] 开始执行延迟的每日待办检查
```

#### 消息流向

```text
ReminderDaemon.js
  ↓ (调用 AgentMessage.js 插件)
AgentMessage.js
  ↓ (返回 agent_message 格式 JSON)
server.js (主进程插件处理器)
  ↓ (WebSocket broadcast)
vcpchat 前端
  ↓
用户界面
```
