# TodoManager - 待办管理插件

**完全符合VCP设计哲学的待办管理插件** - 为AI减负，让AI专注于"做什么"而非"怎么调用"

## 🎯 AI为核心

### 1. 统一时间语义 - 告别参数混淆
```
统一为when字段，自然语言时间解析
```

### 2. 智能时间解析 - 真正的自然语言支持
AI可以直接说：
- "明天下午3点" ✅
- "下周五" ✅
- "3天后" ✅
- "今天晚上8点" ✅

无需记忆复杂的时间格式！

### 3. 智能提醒 - 默认提前15分钟
```
如果设置了截止时间但没有指定提醒：
- 自动提前15分钟提醒 ⏰
- 可通过 remind 参数自定义：remind:「始」提前30分钟「末」
- 提醒通过VCP定时任务调度器精确执行
```

**优势**：
- 不用每次都记得设置提醒
- AI更省心，用户更安心
- 提醒精确到秒级

### 4. 批量操作 - 发挥VCP并行优势
```javascript
// 一次性创建多个待办
BatchCreate({
  todos: [
    { title: "买菜", when: "今天" },
    { title: "开会", when: "明天3点" },
    { title: "写报告", when: "周五" }
  ]
})
```

### 5. 智能输出格式 - 节省80%的Token
```
compact模式：⏳🟡 团队会议(明天15:00)
standard模式：标准详细信息
detailed模式：完整信息包括反思
```

### 6. 记忆系统集成 - 待办变成成长记录
```javascript
CreateTodo({
  title: "重要会议",
  when: "明天",
  autoLog: true,  // 完成后自动写入DailyNote
  reflection: "会议很成功，学到了XXX"
})
```

## 📋 快速开始

### 基础使用（推荐方式）

**创建待办 - 自然语言版**
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」TodoManager「末」,
command:「始」CreateTodo「末」,
title:「始」团队周会「末」,
when:「始」明天下午3点「末」,
remind:「始」提前10分钟「末」,
priority:「始」high「末」
<<<[END_TOOL_REQUEST]>>>
```

**批量创建 - VCP串语法**
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」TodoManager「末」,
command:「始」BatchCreate「末」,
todos:「始」[
  {"title": "买菜", "when": "今天下午", "priority": "high"},
  {"title": "开会", "when": "明天3点", "remind": "提前10分钟"},
  {"title": "写报告", "when": "周五", "autoLog": true}
]「末」,
format:「始」compact「末」
<<<[END_TOOL_REQUEST]>>>
```

**查询待办 - 紧凑输出**
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」TodoManager「末」,
command:「始」ListTodos「末」,
status:「始」pending「末」,
format:「始」compact「末」
<<<[END_TOOL_REQUEST]>>>
```

**完成待办 - 带反思**
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」TodoManager「末」,
command:「始」UpdateTodo「末」,
todoId:「始」todo_xxx「末」,
status:「始」completed「末」,
reflection:「始」会议确定了Q4 OKR，重点是提升用户留存率「末」
<<<[END_TOOL_REQUEST]>>>
```

## 📚 完整API文档

### CreateTodo - 创建待办
**参数：**
- `title` (必需): 标题
- `when` (推荐): 时间，支持自然语言
- `remind` (可选): 提醒偏移，如"提前10分钟"
- `description` (可选): 描述
- `priority` (可选): high/medium/low
- `tags` (可选): 标签，逗号分隔
- `autoLog` (可选): true时完成后自动写入日记
- `format` (可选): 输出格式

### BatchCreate - 批量创建
**参数：**
- `todos` (必需): 待办数组，每个元素同CreateTodo
- `format` (可选): 输出格式

### ListTodos - 查询列表
**参数：**
- `status` (可选): pending/completed/all，默认pending
- `priority` (可选): high/medium/low
- `tag` (可选): 按标签筛选
- `dateRange` (可选): today/week/month/overdue
- `sortBy` (可选): whenTime/priority/createdAt
- `format` (可选): compact/standard/detailed，默认compact

### UpdateTodo - 更新待办
**参数：**
- `todoId` (必需): 待办ID
- `when` (可选): 新时间
- `remind` (可选): 新提醒偏移
- `status` (可选): pending/completed
- `reflection` (可选): 反思内容
- `format` (可选): 输出格式
- 其他字段可选

### BatchUpdate - 批量更新
**参数：**
- `updates` (必需): 更新数组，每个元素包含todoId和要更新的字段

### BatchDelete - 批量删除
**参数：**
- `todoIds` (必需): 待办ID数组

### GetDailyTodos - 今日待办
**参数：**
- `format` (可选): 输出格式

## ⚙️ 配置

编辑 `config.env`：

```env
# 每日提醒时间
DAILY_REMINDER_TIME=09:00

# 时区
TIMEZONE=Asia/Shanghai

# 默认AI Agent名称（用于日记）
DEFAULT_AGENT_NAME=Nova
```

## 🚀 VCP设计哲学体现

### 1. AI中心化思想
- ✅ 参数设计符合AI认知习惯
- ✅ 自然语言时间解析
- ✅ 智能默认值推断

### 2. 串语法支持
- ✅ BatchCreate/Update/Delete
- ✅ 一次调用完成多个操作
- ✅ 保护AI的"心流"体验

### 3. 即用即销原则
- ✅ 进程仅在调用时创建
- ✅ 完成后立即释放资源
- ✅ 无资源浪费

### 4. 记忆系统集成
- ✅ autoLog自动写日记
- ✅ reflection反思内容
- ✅ 待办成为成长记录

### 5. 智能输出
- ✅ compact模式节省token
- ✅ 根据场景选择详细度
- ✅ 提升AI上下文预算

## 🎓 最佳实践

### 1. 使用自然语言时间
```javascript
// ✅ 好
when: "明天下午3点"

// ❌ 不推荐（虽然也支持）
dueDate: "2025-10-31", dueTime: "15:00"
```

### 2. 批量操作提升效率
```javascript
// ✅ 好 - 一次调用
BatchCreate({ todos: [...] })

// ❌ 低效 - 多次调用
CreateTodo({ ... })
CreateTodo({ ... })
CreateTodo({ ... })
```

### 3. 使用紧凑模式节省token
```javascript
// ✅ 查询列表时
ListTodos({ format: "compact" })

// ✅ 查看详情时
GetTodoDetail({ todoId: "xxx", format: "detailed" })
```

### 4. 启用自动日记记录
```javascript
// ✅ 重要任务启用autoLog
CreateTodo({
  title: "重要会议",
  when: "明天",
  autoLog: true
})
```

## 📖 更多资源

- [VCP.md](../../VCP.md) - VCP设计哲学完整文档
- [TESTING.md](./TESTING.md) - 测试指南
- [DAEMON_GUIDE.md](./DAEMON_GUIDE.md) - 守护进程详解

## 🔧 故障排除

### 时间解析失败
检查时区设置：`TIMEZONE=Asia/Shanghai`

### 日记写入失败
确保DailyNoteWrite插件已安装并配置

### 批量操作部分失败
检查返回的`details`数组，查看具体错误

## 版本历史

### V2.0.0 (2025-10-30)
- ✨ 统一时间语义（when字段）
- ✨ 智能自然语言时间解析
- ✨ 批量操作支持（串语法）
- ✨ 智能输出格式（compact模式）
- ✨ 记忆系统集成（autoLog/reflection）
- 🔧 完全符合VCP设计哲学

### V1.0.0
- 基础CRUD功能
- 守护进程提醒
