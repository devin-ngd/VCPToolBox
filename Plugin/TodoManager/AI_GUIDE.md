# TodoManager AI使用指南

## 📝 快速上手

### 最简单的用法
```
用户："明天下午3点提醒我开会"

AI应该：
<<<[TOOL_REQUEST]>>>
tool_name:「始」TodoManager「末」,
command:「始」CreateTodo「末」,
title:「始」开会「末」,
when:「始」明天下午3点「末」,
remind:「始」提前10分钟「末」
<<<[END_TOOL_REQUEST]>>>
```

### 批量创建（VCP串语法）
```
用户："帮我创建几个待办：今天买菜，明天开会，周五交报告"

AI应该：
<<<[TOOL_REQUEST]>>>
tool_name:「始」TodoManager「末」,
command:「始」BatchCreate「末」,
todos:「始」[
  {"title": "买菜", "when": "今天"},
  {"title": "开会", "when": "明天"},
  {"title": "交报告", "when": "周五"}
]「末」,
format:「始」compact「末」
<<<[END_TOOL_REQUEST]>>>
```

## 🕐 支持的时间表达

AI可以直接使用自然语言：

| 用户说 | AI写 | 解析结果 |
|--------|------|----------|
| 今天 | when: "今天" | 今天09:00 |
| 明天下午3点 | when: "明天下午3点" | 明天15:00 |
| 下周五 | when: "下周五" | 下周五09:00 |
| 3天后 | when: "3天后" | 3天后09:00 |
| 后天晚上8点 | when: "后天晚上8点" | 后天20:00 |

**无需记忆YYYY-MM-DD HH:mm这种复杂格式！**

## 📊 输出格式选择

### compact - 紧凑模式（推荐用于列表）
```
⏳🟡 团队会议(明天15:00)
✅🔴 完成报告(已完成)
```
**节省80%的token！**

### standard - 标准模式（默认）
```
📌 ID: todo_xxx
   标题: 团队会议
   优先级: 🟡 medium
   状态: ⏳ 待处理
   时间: 2025-10-31 15:00
```

### detailed - 详细模式（用于单个查看）
```
包含所有信息：创建时间、完成时间、反思内容等
```

## 💡 常见场景最佳实践

### 场景1：用户想查看待办列表
```
用户："显示我的待办"

AI应该使用compact格式：
command: "ListTodos",
format: "compact"

输出简洁，易读，省token！
```

### 场景2：用户想看某个待办的详情
```
用户："详细看看第一个待办"

AI应该使用detailed格式：
command: "GetTodoDetail",
todoId: "todo_xxx",
format: "detailed"
```

### 场景3：完成待办并记录反思
```
用户："完成了会议，讨论了Q4目标"

AI应该：
command: "UpdateTodo",
todoId: "todo_xxx",
status: "completed",
reflection: "讨论了Q4目标，重点是提升用户留存"

如果创建时设置了autoLog: true，这条反思会自动写入日记！
```

### 场景4：批量标记完成
```
用户："把前三个都标记为完成"

AI应该：
command: "BatchUpdate",
updates: [
  {"todoId": "todo_1", "status": "completed"},
  {"todoId": "todo_2", "status": "completed"},
  {"todoId": "todo_3", "status": "completed"}
]
```

## 🎓 进阶技巧

### 技巧1：利用autoLog建立成长记录
```
创建重要任务时：
autoLog: true

完成时添加reflection：
reflection: "学到了XXX，下次可以改进YYY"

→ 自动写入DailyNote，积累经验！
```

### 技巧2：善用remind参数
```
when: "明天下午3点",
remind: "提前10分钟"

→ 系统会自动在14:50提醒
```

### 技巧3：批量操作提升效率
```
// ❌ 不好 - 调用3次
CreateTodo(...)
CreateTodo(...)
CreateTodo(...)

// ✅ 好 - 调用1次
BatchCreate({ todos: [...] })

→ 符合VCP并行哲学！
```

## 🚫 常见错误（V1遗留问题）

### 错误1：还在用dueDate/dueTime
```
❌ 不要这样：
dueDate: "2025-10-31",
dueTime: "15:00"

✅ 应该这样：
when: "周五下午3点"
```

### 错误2：分不清提醒和截止
```
V2已经没有这个问题了！
when就是时间，remind是可选的提前提醒。
```

### 错误3：查询列表用detailed格式
```
❌ 不要：
ListTodos({ format: "detailed" })
→ 返回大量文本，浪费token

✅ 应该：
ListTodos({ format: "compact" })
→ 简洁高效
```

## 🔄 从V1迁移

如果AI还记得V1的参数，请忘掉它们：

| 忘掉这些 | 改用这些 |
|----------|----------|
| dueDate | when |
| dueTime | when |
| reminderTime | when + remind |

**一个when字段统一所有时间！**

## 📚 完整命令速查

### CreateTodo
- when: 时间（自然语言）
- remind: 提醒偏移
- autoLog: 是否自动记日记

### BatchCreate
- todos: 待办数组
- format: 输出格式

### ListTodos
- format: 推荐用"compact"
- status/priority/tag: 筛选条件

### UpdateTodo
- reflection: 完成时的反思
- when: 更新时间

### BatchUpdate/BatchDelete
- 批量操作，一次搞定

## 💬 与用户沟通建议

当用户说模糊时间时，AI可以：
```
用户："提醒我开会"

AI："好的，请问是什么时候的会议？"
（然后用when字段设置时间）

或者智能推断：
如果上下文有时间线索，直接使用
```

## 🎯 核心记忆点

1. **忘掉dueDate/reminderTime** - 只用when
2. **自然语言时间** - "明天下午3点"比"2025-10-31 15:00"更好
3. **批量操作** - 能BatchCreate就不要循环CreateTodo
4. **compact格式** - 列表查询的默认选择
5. **autoLog** - 重要任务记得开启

## 🚀 这才是VCP哲学

TodoManager V2让AI专注于：
- ✅ 理解用户意图
- ✅ 规划任务
- ✅ 批量编排

而不是：
- ❌ 记忆复杂参数
- ❌ 区分时间概念
- ❌ 格式化日期字符串

**为AI减负，释放创造力！**
