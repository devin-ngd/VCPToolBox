# 默认提醒功能测试指南

## 功能说明

当创建或更新待办事项时，如果：
- ✅ 设置了截止时间（`when` 参数）
- ❌ 没有指定提醒偏移（`remind` 参数）
- ❌ 没有指定提醒时间（`reminderTime` 参数）

系统会**自动设置提前15分钟的提醒**。

## 测试场景

### 场景 1：创建待办，有截止时间，无提醒
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」TodoManager「末」,
command:「始」CreateTodo「末」,
title:「始」测试默认提醒「末」,
when:「始」明天下午3点「末」
<<<[END_TOOL_REQUEST]>>>
```

**预期结果**：
- ✅ 创建成功
- ⏰ 自动设置提醒时间为：明天 14:45（提前15分钟）
- 📢 提示信息：`已自动设置默认提醒（截止前15分钟）`
- 📁 在 `VCPTimedContacts/` 目录创建任务文件 `todo_remind_{id}.json`

### 场景 2：创建待办，有截止时间，显式指定提醒
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」TodoManager「末」,
command:「始」CreateTodo「末」,
title:「始」测试自定义提醒「末」,
when:「始」明天下午3点「末」,
remind:「始」提前30分钟「末」
<<<[END_TOOL_REQUEST]>>>
```

**预期结果**：
- ✅ 创建成功
- ⏰ 提醒时间为：明天 14:30（自定义的提前30分钟）
- 📢 提示信息：`系统将通过定时任务在...提醒您`（不显示"默认提醒"）

### 场景 3：创建待办，无截止时间
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」TodoManager「末」,
command:「始」CreateTodo「末」,
title:「始」没有截止时间的待办「末」,
description:「始」这是一个没有时间限制的任务「末」
<<<[END_TOOL_REQUEST]>>>
```

**预期结果**：
- ✅ 创建成功
- ❌ 无提醒时间
- 📁 不创建定时任务文件

### 场景 4：更新待办，添加截止时间
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」TodoManager「末」,
command:「始」UpdateTodo「末」,
todoId:「始」{之前创建的ID}「末」,
when:「始」后天上午10点「末」
<<<[END_TOOL_REQUEST]>>>
```

**预期结果**：
- ✅ 更新成功
- ⏰ 自动设置提醒时间为：后天 09:45
- 📁 创建新的定时任务文件

### 场景 5：截止时间已过期（过去时间）
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」TodoManager「末」,
command:「始」CreateTodo「末」,
title:「始」过去的时间「末」,
when:「始」昨天下午3点「末」
<<<[END_TOOL_REQUEST]>>>
```

**预期结果**：
- ✅ 创建成功
- ❌ 不设置提醒（因为提前15分钟的时间已经过去了）
- 📁 不创建定时任务文件

## 验证步骤

1. **查看创建结果**
   - 检查返回信息中是否有提醒时间
   - 确认提示文字是"默认提醒"还是"自定义提醒"

2. **检查定时任务文件**
   ```cmd
   dir d:\workspace\agents\VCPToolBox\VCPTimedContacts\todo_remind_*.json
   ```

3. **查看任务文件内容**
   ```cmd
   type d:\workspace\agents\VCPToolBox\VCPTimedContacts\todo_remind_{id}.json
   ```
   应包含：
   - `scheduledLocalTime`: 提醒时间
   - `tool_call.tool_name`: "TodoManager"
   - `tool_call.arguments.command`: "RemindTodo"
   - `tool_call.arguments.todoId`: 待办ID

4. **等待提醒触发**
   - 到达设定时间时，系统会自动调用 RemindTodo
   - 通过 WebSocket 推送提醒消息

## 调试信息

在 `TodoManager.js` 中添加了日志：
```javascript
console.log(`[TodoManager] 为待办自动设置默认提醒时间（截止前15分钟）: ${reminderTime}`);
```

可在服务器日志中查看是否触发了默认提醒逻辑。

## 优化建议

如果需要修改默认提醒时间（15分钟），可以：
1. 在 `config.env` 中添加配置项：`DEFAULT_REMINDER_MINUTES=15`
2. 修改代码读取配置：
   ```javascript
   const defaultMinutes = parseInt(process.env.DEFAULT_REMINDER_MINUTES || '15', 10);
   const defaultReminderDate = new Date(whenDate.getTime() - defaultMinutes * 60 * 1000);
   ```
