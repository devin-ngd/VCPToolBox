const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const SmartTimeParser = require('./SmartTimeParser');

// 数据文件路径
const DATA_DIR = path.join(__dirname, 'data');
const TODOS_FILE = path.join(DATA_DIR, 'todos.json');
const TIMED_CONTACTS_DIR = path.join(__dirname, '../../VCPTimedContacts');

// 初始化智能时间解析器
const timeParser = new SmartTimeParser(process.env.TIMEZONE || 'Asia/Shanghai');

/**
 * 创建定时提醒任务
 * @param {object} todo - 待办事项对象
 */
async function createScheduledReminder(todo) {
    if (!todo.reminderTime) return;

    try {
        // 确保目录存在
        await fs.mkdir(TIMED_CONTACTS_DIR, { recursive: true });

        const taskId = `todo_remind_${todo.id}`;
        const taskData = {
            taskId: taskId,
            scheduledLocalTime: new Date(todo.reminderTime).toISOString(),
            tool_call: {
                tool_name: "TodoManager",
                arguments: {
                    command: "RemindTodo",
                    todoId: todo.id
                }
            },
            createdAt: new Date().toISOString(),
            description: `待办提醒: ${todo.title}`
        };

        const taskFile = path.join(TIMED_CONTACTS_DIR, `${taskId}.json`);
        await fs.writeFile(taskFile, JSON.stringify(taskData, null, 2), 'utf-8');
        console.log(`[TodoManager] 已创建定时提醒任务: ${taskId}`);
    } catch (error) {
        console.error(`[TodoManager] 创建定时提醒任务失败:`, error);
        // 不抛出错误，因为这不应该影响待办的创建
    }
}

/**
 * 删除定时提醒任务
 * @param {string} todoId - 待办事项ID
 */
async function deleteScheduledReminder(todoId) {
    try {
        const taskId = `todo_remind_${todoId}`;
        const taskFile = path.join(TIMED_CONTACTS_DIR, `${taskId}.json`);

        try {
            await fs.access(taskFile);
            await fs.unlink(taskFile);
            console.log(`[TodoManager] 已删除定时提醒任务: ${taskId}`);
        } catch (err) {
            // 文件不存在，忽略
            if (err.code !== 'ENOENT') {
                throw err;
            }
        }
    } catch (error) {
        console.error(`[TodoManager] 删除定时提醒任务失败:`, error);
        // 不抛出错误
    }
}

/**
 * 确保数据目录和文件存在
 */
async function ensureDataFile() {
    try {
        await fs.access(DATA_DIR);
    } catch {
        await fs.mkdir(DATA_DIR, { recursive: true });
    }

    try {
        await fs.access(TODOS_FILE);
    } catch {
        await fs.writeFile(TODOS_FILE, JSON.stringify({ todos: [] }, null, 2), 'utf-8');
    }
}

/**
 * 读取所有待办事项
 */
async function loadTodos() {
    await ensureDataFile();
    const content = await fs.readFile(TODOS_FILE, 'utf-8');
    return JSON.parse(content);
}

/**
 * 保存所有待办事项
 */
async function saveTodos(data) {
    await fs.writeFile(TODOS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * 生成唯一ID
 */
function generateId() {
    const timestamp = Date.now();
    const randomStr = crypto.randomBytes(4).toString('hex');
    return `todo_${timestamp}_${randomStr}`;
}

/**
 * 解析日期时间
 */
function parseDateTime(dateStr, timeStr) {
    if (!dateStr) return null;

    let dateTimeStr = dateStr;
    if (timeStr) {
        dateTimeStr += ` ${timeStr}`;
    }

    const date = new Date(dateTimeStr);
    return isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * 格式化待办事项用于展示
 * @param {object} todo - 待办对象
 * @param {string} format - 输出格式: 'compact' | 'standard' | 'detailed'
 */
function formatTodoForDisplay(todo, format = 'standard') {
    if (format === 'compact') {
        // 紧凑模式：单行显示
        const statusIcon = todo.status === 'completed' ? '✅' : '⏳';
        const priorityIcon = { high: '🔴', medium: '🟡', low: '🟢' }[todo.priority] || '⚪';
        let result = `${statusIcon}${priorityIcon} ${todo.title}`;

        if (todo.whenTime) {
            const whenDate = new Date(todo.whenTime);
            const now = new Date();
            const isToday = whenDate.toDateString() === now.toDateString();
            const isTomorrow = whenDate.toDateString() === new Date(now.getTime() + 86400000).toDateString();

            if (isToday) {
                result += `(今天${whenDate.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: process.env.TIMEZONE || 'Asia/Shanghai' })})`;
            } else if (isTomorrow) {
                result += `(明天${whenDate.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: process.env.TIMEZONE || 'Asia/Shanghai' })})`;
            } else {
                result += `(${whenDate.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', timeZone: process.env.TIMEZONE || 'Asia/Shanghai' })})`;
            }
        }

        return result;
    }

    // standard 和 detailed 模式
    const lines = [];
    lines.push(`📌 ID: ${todo.id}`);
    lines.push(`   标题: ${todo.title}`);

    if (todo.description && format === 'detailed') {
        lines.push(`   描述: ${todo.description}`);
    }

    const priorityEmoji = { high: '🔴', medium: '🟡', low: '🟢' };
    lines.push(`   优先级: ${priorityEmoji[todo.priority] || '⚪'} ${todo.priority}`);

    const statusEmoji = todo.status === 'completed' ? '✅' : '⏳';
    lines.push(`   状态: ${statusEmoji} ${todo.status === 'completed' ? '已完成' : '待处理'}`);

    if (todo.whenTime) {
        const whenDate = new Date(todo.whenTime);
        lines.push(`   时间: ${whenDate.toLocaleString('zh-CN', { timeZone: process.env.TIMEZONE || 'Asia/Shanghai' })}`);
    }

    if (todo.reminderTime && format === 'detailed') {
        const reminderDate = new Date(todo.reminderTime);
        lines.push(`   提醒: ${reminderDate.toLocaleString('zh-CN', { timeZone: process.env.TIMEZONE || 'Asia/Shanghai' })}`);
    }

    if (todo.tags && todo.tags.length > 0 && format === 'detailed') {
        lines.push(`   标签: ${todo.tags.map(t => `#${t}`).join(' ')}`);
    }

    if (format === 'detailed') {
        lines.push(`   创建: ${new Date(todo.createdAt).toLocaleString('zh-CN', { timeZone: process.env.TIMEZONE || 'Asia/Shanghai' })}`);

        if (todo.completedAt) {
            lines.push(`   完成: ${new Date(todo.completedAt).toLocaleString('zh-CN', { timeZone: process.env.TIMEZONE || 'Asia/Shanghai' })}`);
        }
    }

    return lines.join('\n');
}

/**
 * 创建待办事项
 */
async function createTodo(args) {
    const data = await loadTodos();

    if (!args.title) {
        throw new Error('标题是必需的参数');
    }

    // 使用智能时间解析器
    let whenTime = null;
    let reminderTime = null;

    if (args.when) {
        whenTime = timeParser.parse(args.when);

        // 如果指定了提醒偏移，计算提醒时间
        if (args.remind) {
            reminderTime = timeParser.calculateReminderTime(whenTime, args.remind);
        }
    }

    // 兼容旧参数（保留向后兼容性）
    if (!whenTime && (args.dueDate || args.dueTime)) {
        whenTime = parseDateTime(args.dueDate, args.dueTime);
    }
    if (!reminderTime && args.reminderTime) {
        reminderTime = new Date(args.reminderTime).toISOString();
    }

    // 如果有截止时间但没有提醒时间，默认提前15分钟提醒
    if (whenTime && !reminderTime) {
        const whenDate = new Date(whenTime);
        const defaultReminderDate = new Date(whenDate.getTime() - 15 * 60 * 1000); // 提前15分钟
        // 只有当提醒时间在未来时才设置
        if (defaultReminderDate > new Date()) {
            reminderTime = defaultReminderDate.toISOString();
            console.log(`[TodoManager] 为待办自动设置默认提醒时间（截止前15分钟）: ${reminderTime}`);
        }
    }

    const todo = {
        id: generateId(),
        title: args.title,
        description: args.description || '',
        priority: args.priority || 'medium',
        status: 'pending',
        tags: args.tags ? args.tags.split(',').map(t => t.trim()).filter(t => t) : [],
        whenTime: whenTime,
        reminderTime: reminderTime,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
        autoLog: args.autoLog === true || args.autoLog === 'true',
        reflection: null
    };

    data.todos.push(todo);
    await saveTodos(data);

    // 如果设置了提醒时间，创建定时任务
    if (todo.reminderTime) {
        await createScheduledReminder(todo);
    }

    const format = args.format || 'standard';
    let result = `✅ 待办事项创建成功！\n\n${formatTodoForDisplay(todo, format)}`;

    // 如果设置了提醒时间，添加定时联系提示
    if (todo.reminderTime) {
        const reminderDate = new Date(todo.reminderTime);
        const timezone = process.env.TIMEZONE || 'Asia/Shanghai';

        // 判断是否为默认提醒（没有显式指定 remind 或 reminderTime）
        const isDefaultReminder = !args.remind && !args.reminderTime;

        if (isDefaultReminder) {
            result += `\n\n⏰ 已自动设置默认提醒（截止前15分钟）：${reminderDate.toLocaleString('zh-CN', { timeZone: timezone })}`;
            result += `\n💡 提示：可使用 remind 参数自定义提醒时间，如 remind:「始」提前30分钟「末」`;
        } else {
            result += `\n\n⏰ 系统将通过定时任务在 ${reminderDate.toLocaleString('zh-CN', { timeZone: timezone })} 提醒您。`;
        }
    }

    return { status: 'success', result };
}

/**
 * 获取今日待办事项
 */
async function getDailyTodos(args = {}) {
    const data = await loadTodos();
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const todayTodos = data.todos.filter(todo => {
        if (todo.status === 'completed') return false;

        // 包含今日时间的待办
        if (todo.whenTime) {
            const whenDate = new Date(todo.whenTime);
            if (whenDate >= today && whenDate < tomorrow) {
                return true;
            }
        }

        // 包含今日有提醒的待办
        if (todo.reminderTime) {
            const reminderDate = new Date(todo.reminderTime);
            if (reminderDate >= today && reminderDate < tomorrow) {
                return true;
            }
        }

        return false;
    });

    // 按优先级和时间排序
    todayTodos.sort((a, b) => {
        const priorityOrder = { high: 3, medium: 2, low: 1 };
        const priorityDiff = (priorityOrder[b.priority] || 0) - (priorityOrder[a.priority] || 0);
        if (priorityDiff !== 0) return priorityDiff;

        if (a.whenTime && b.whenTime) {
            return new Date(a.whenTime) - new Date(b.whenTime);
        }
        return 0;
    });

    if (todayTodos.length === 0) {
        return {
            status: 'success',
            result: `📅 ${now.toLocaleDateString('zh-CN', { timeZone: process.env.TIMEZONE || 'Asia/Shanghai' })}\n\n🎉 太棒了！今天没有待办事项，享受轻松的一天吧！`
        };
    }

    const format = args.format || 'compact';
    let result = `📅 ${now.toLocaleDateString('zh-CN', { timeZone: process.env.TIMEZONE || 'Asia/Shanghai' })} - 今日待办清单\n`;
    result += `\n共有 ${todayTodos.length} 项待办事项\n`;

    if (format === 'compact') {
        result += '\n';
        todayTodos.forEach((todo, index) => {
            result += `${index + 1}. ${formatTodoForDisplay(todo, 'compact')}\n`;
        });
    } else {
        result += `\n${'='.repeat(50)}\n\n`;
        todayTodos.forEach((todo, index) => {
            result += `${index + 1}. ${formatTodoForDisplay(todo, format)}\n`;
            result += `\n${'─'.repeat(50)}\n\n`;
        });
    }

    return { status: 'success', result };
}

/**
 * 列出待办事项
 */
async function listTodos(args) {
    const data = await loadTodos();
    let todos = data.todos;

    // 状态筛选
    const status = args.status || 'pending';
    if (status !== 'all') {
        todos = todos.filter(todo => todo.status === status);
    }

    // 优先级筛选
    if (args.priority) {
        todos = todos.filter(todo => todo.priority === args.priority);
    }

    // 标签筛选
    if (args.tag) {
        todos = todos.filter(todo => todo.tags.includes(args.tag));
    }

    // 日期范围筛选
    if (args.dateRange) {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        switch (args.dateRange) {
            case 'today':
                const tomorrow = new Date(today);
                tomorrow.setDate(tomorrow.getDate() + 1);
                todos = todos.filter(todo => {
                    if (!todo.whenTime) return false;
                    const whenDate = new Date(todo.whenTime);
                    return whenDate >= today && whenDate < tomorrow;
                });
                break;
            case 'week':
                const nextWeek = new Date(today);
                nextWeek.setDate(nextWeek.getDate() + 7);
                todos = todos.filter(todo => {
                    if (!todo.whenTime) return false;
                    const whenDate = new Date(todo.whenTime);
                    return whenDate >= today && whenDate < nextWeek;
                });
                break;
            case 'month':
                const nextMonth = new Date(today);
                nextMonth.setMonth(nextMonth.getMonth() + 1);
                todos = todos.filter(todo => {
                    if (!todo.whenTime) return false;
                    const whenDate = new Date(todo.whenTime);
                    return whenDate >= today && whenDate < nextMonth;
                });
                break;
            case 'overdue':
                todos = todos.filter(todo => {
                    if (!todo.whenTime) return false;
                    return new Date(todo.whenTime) < today;
                });
                break;
        }
    }

    // 排序
    const sortBy = args.sortBy || 'whenTime';
    todos.sort((a, b) => {
        switch (sortBy) {
            case 'priority':
                const priorityOrder = { high: 3, medium: 2, low: 1 };
                return (priorityOrder[b.priority] || 0) - (priorityOrder[a.priority] || 0);
            case 'createdAt':
                return new Date(b.createdAt) - new Date(a.createdAt);
            case 'whenTime':
            default:
                if (!a.whenTime && !b.whenTime) return 0;
                if (!a.whenTime) return 1;
                if (!b.whenTime) return -1;
                return new Date(a.whenTime) - new Date(b.whenTime);
        }
    });

    if (todos.length === 0) {
        return {
            status: 'success',
            result: '📋 没有找到符合条件的待办事项。'
        };
    }

    const format = args.format || 'compact';
    let result = `📋 待办事项列表 (共 ${todos.length} 项)\n`;

    if (format === 'compact') {
        result += '\n';
        todos.forEach((todo, index) => {
            result += `${index + 1}. ${formatTodoForDisplay(todo, 'compact')}\n`;
        });
    } else {
        result += `\n${'='.repeat(50)}\n\n`;
        todos.forEach((todo, index) => {
            result += `${index + 1}. ${formatTodoForDisplay(todo, format)}\n`;
            result += `\n${'─'.repeat(50)}\n\n`;
        });
    }

    return { status: 'success', result };
}

/**
 * 更新待办事项
 */
async function updateTodo(args) {
    const data = await loadTodos();

    if (!args.todoId) {
        throw new Error('todoId 是必需的参数');
    }

    const todoIndex = data.todos.findIndex(t => t.id === args.todoId);
    if (todoIndex === -1) {
        throw new Error(`未找到ID为 ${args.todoId} 的待办事项`);
    }

    const todo = data.todos[todoIndex];

    // 更新字段
    if (args.title) todo.title = args.title;
    if (args.description !== undefined) todo.description = args.description;
    if (args.priority) todo.priority = args.priority;
    if (args.tags !== undefined) {
        todo.tags = args.tags.split(',').map(t => t.trim()).filter(t => t);
    }

    // 使用智能时间解析更新时间
    let reminderTimeChanged = false;
    const oldReminderTime = todo.reminderTime;

    if (args.when) {
        todo.whenTime = timeParser.parse(args.when);

        // 如果同时指定了提醒偏移，更新提醒时间
        if (args.remind) {
            todo.reminderTime = timeParser.calculateReminderTime(todo.whenTime, args.remind);
            reminderTimeChanged = true;
        } else if (!args.reminderTime) {
            // 如果更新了截止时间但没有指定新的提醒偏移或提醒时间
            // 且原来没有提醒时间，则设置默认提醒（提前15分钟）
            if (!todo.reminderTime && todo.whenTime) {
                const whenDate = new Date(todo.whenTime);
                const defaultReminderDate = new Date(whenDate.getTime() - 15 * 60 * 1000);
                if (defaultReminderDate > new Date()) {
                    todo.reminderTime = defaultReminderDate.toISOString();
                    reminderTimeChanged = true;
                    console.log(`[TodoManager] 为待办自动设置默认提醒时间（截止前15分钟）: ${todo.reminderTime}`);
                }
            }
        }
    }

    // 兼容旧参数
    if (args.dueDate !== undefined || args.dueTime !== undefined) {
        const dueDate = args.dueDate || (todo.whenTime ? todo.whenTime.split('T')[0] : null);
        const dueTime = args.dueTime || null;
        todo.whenTime = parseDateTime(dueDate, dueTime);
    }

    if (args.reminderTime !== undefined) {
        todo.reminderTime = args.reminderTime ? new Date(args.reminderTime).toISOString() : null;
        reminderTimeChanged = true;
    }

    // 如果提醒时间有变化，更新定时任务
    if (reminderTimeChanged) {
        // 先删除旧的定时任务
        await deleteScheduledReminder(todo.id);

        // 如果新的提醒时间存在，创建新的定时任务
        if (todo.reminderTime) {
            await createScheduledReminder(todo);
        }
    }

    if (args.status) {
        const oldStatus = todo.status;
        todo.status = args.status;

        if (args.status === 'completed' && !todo.completedAt) {
            todo.completedAt = new Date().toISOString();
            todo.dueDateReminderSent = false;
            todo.reminderSent = false;

            // 如果启用了autoLog，将完成记录写入日记
            if (todo.autoLog) {
                const reflection = args.reflection || '';
                await logTodoToDiary(todo, 'completed', reflection);
            }
        } else if (args.status === 'pending' && oldStatus === 'completed') {
            todo.completedAt = null;
            todo.dueDateReminderSent = false;
        }
    }

    // 更新反思内容
    if (args.reflection) {
        todo.reflection = args.reflection;
    }

    todo.updatedAt = new Date().toISOString();
    await saveTodos(data);

    const format = args.format || 'standard';
    return {
        status: 'success',
        result: `✅ 待办事项更新成功！\n\n${formatTodoForDisplay(todo, format)}`
    };
}

/**
 * 删除待办事项
 */
async function deleteTodo(args) {
    const data = await loadTodos();

    if (!args.todoId) {
        throw new Error('todoId 是必需的参数');
    }

    const todoIndex = data.todos.findIndex(t => t.id === args.todoId);
    if (todoIndex === -1) {
        throw new Error(`未找到ID为 ${args.todoId} 的待办事项`);
    }

    const deletedTodo = data.todos.splice(todoIndex, 1)[0];
    await saveTodos(data);

    // 删除对应的定时提醒任务
    await deleteScheduledReminder(deletedTodo.id);

    return {
        status: 'success',
        result: `🗑️ 待办事项已删除\n\n标题: ${deletedTodo.title}\nID: ${deletedTodo.id}`
    };
}

/**
 * 将待办事项记录到日记
 * @param {object} todo - 待办对象
 * @param {string} action - 动作类型 (created/completed/updated)
 * @param {string} reflection - 反思内容
 */
async function logTodoToDiary(todo, action, reflection = '') {
    try {
        const { spawn } = require('child_process');
        const pluginPath = path.join(__dirname, '..', 'DailyNoteWrite', 'DailyNoteWrite.js');

        const maid = process.env.DEFAULT_AGENT_NAME || 'TodoManager';
        const date = new Date().toISOString().split('T')[0];

        let content = '';
        if (action === 'completed') {
            content = `✅ 完成待办：${todo.title}`;
            if (reflection) {
                content += `\n\n反思：${reflection}`;
            }
            if (todo.description) {
                content += `\n\n描述：${todo.description}`;
            }
        } else if (action === 'created') {
            content = `📝 创建待办：${todo.title}`;
            if (todo.whenTime) {
                const whenDate = new Date(todo.whenTime);
                content += `\n时间：${whenDate.toLocaleString('zh-CN', { timeZone: process.env.TIMEZONE || 'Asia/Shanghai' })}`;
            }
        }

        const diaryData = {
            maid: maid,
            date: date,
            content: content,
            tags: ['待办事项', ...todo.tags]
        };

        const diaryProcess = spawn('node', [pluginPath], { cwd: path.dirname(pluginPath) });
        diaryProcess.stdin.write(JSON.stringify(diaryData));
        diaryProcess.stdin.end();

        // 不等待返回，异步处理
        diaryProcess.on('error', (err) => {
            console.error('[TodoManager] Failed to log to diary:', err);
        });

    } catch (error) {
        console.error('[TodoManager] Error logging to diary:', error);
    }
}

/**
 * 获取待办事项详情
 */
async function getTodoDetail(args) {
    const data = await loadTodos();

    if (!args.todoId) {
        throw new Error('todoId 是必需的参数');
    }

    const todo = data.todos.find(t => t.id === args.todoId);
    if (!todo) {
        throw new Error(`未找到ID为 ${args.todoId} 的待办事项`);
    }

    const format = args.format || 'detailed';
    return {
        status: 'success',
        result: `📝 待办事项详情\n\n${formatTodoForDisplay(todo, format)}`
    };
}

/**
 * 批量创建待办事项（串语法支持）
 */
async function batchCreate(args) {
    const data = await loadTodos();

    if (!args.todos || !Array.isArray(args.todos)) {
        throw new Error('todos参数必须是数组');
    }

    const results = [];
    const createdTodos = [];

    for (const todoArgs of args.todos) {
        try {
            if (!todoArgs.title) {
                results.push({ status: 'error', error: '缺少title参数' });
                continue;
            }

            let whenTime = null;
            let reminderTime = null;

            if (todoArgs.when) {
                whenTime = timeParser.parse(todoArgs.when);
                if (todoArgs.remind) {
                    reminderTime = timeParser.calculateReminderTime(whenTime, todoArgs.remind);
                }
            }

            const todo = {
                id: generateId(),
                title: todoArgs.title,
                description: todoArgs.description || '',
                priority: todoArgs.priority || 'medium',
                status: 'pending',
                tags: todoArgs.tags ? todoArgs.tags.split(',').map(t => t.trim()).filter(t => t) : [],
                whenTime: whenTime,
                reminderTime: reminderTime,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                completedAt: null,
                autoLog: todoArgs.autoLog === true || todoArgs.autoLog === 'true',
                reflection: null
            };

            data.todos.push(todo);
            createdTodos.push(todo);
            results.push({ status: 'success', id: todo.id, title: todo.title });

        } catch (error) {
            results.push({ status: 'error', error: error.message });
        }
    }

    await saveTodos(data);

    const format = args.format || 'compact';
    let result = `✅ 批量创建完成！成功: ${createdTodos.length}/${args.todos.length}\n\n`;

    if (format === 'compact') {
        createdTodos.forEach((todo, index) => {
            result += `${index + 1}. ${formatTodoForDisplay(todo, 'compact')}\n`;
        });
    } else {
        createdTodos.forEach((todo, index) => {
            result += `${index + 1}. ${formatTodoForDisplay(todo, format)}\n\n`;
        });
    }

    return { status: 'success', result, details: results };
}

/**
 * 批量更新待办事项
 */
async function batchUpdate(args) {
    const data = await loadTodos();

    if (!args.updates || !Array.isArray(args.updates)) {
        throw new Error('updates参数必须是数组');
    }

    const results = [];
    const updatedTodos = [];

    for (const updateArgs of args.updates) {
        try {
            if (!updateArgs.todoId) {
                results.push({ status: 'error', error: '缺少todoId参数' });
                continue;
            }

            const todoIndex = data.todos.findIndex(t => t.id === updateArgs.todoId);
            if (todoIndex === -1) {
                results.push({ status: 'error', error: `未找到ID为 ${updateArgs.todoId} 的待办` });
                continue;
            }

            const todo = data.todos[todoIndex];

            // 应用更新
            if (updateArgs.title) todo.title = updateArgs.title;
            if (updateArgs.description !== undefined) todo.description = updateArgs.description;
            if (updateArgs.priority) todo.priority = updateArgs.priority;
            if (updateArgs.status) {
                todo.status = updateArgs.status;
                if (updateArgs.status === 'completed' && !todo.completedAt) {
                    todo.completedAt = new Date().toISOString();
                    if (todo.autoLog) {
                        await logTodoToDiary(todo, 'completed', updateArgs.reflection || '');
                    }
                }
            }

            todo.updatedAt = new Date().toISOString();
            updatedTodos.push(todo);
            results.push({ status: 'success', id: todo.id, title: todo.title });

        } catch (error) {
            results.push({ status: 'error', error: error.message });
        }
    }

    await saveTodos(data);

    const format = args.format || 'compact';
    let result = `✅ 批量更新完成！成功: ${updatedTodos.length}/${args.updates.length}\n\n`;

    if (format === 'compact') {
        updatedTodos.forEach((todo, index) => {
            result += `${index + 1}. ${formatTodoForDisplay(todo, 'compact')}\n`;
        });
    }

    return { status: 'success', result, details: results };
}

/**
 * 批量删除待办事项
 */
async function batchDelete(args) {
    const data = await loadTodos();

    if (!args.todoIds || !Array.isArray(args.todoIds)) {
        throw new Error('todoIds参数必须是数组');
    }

    const results = [];
    const deletedTodos = [];

    for (const todoId of args.todoIds) {
        const todoIndex = data.todos.findIndex(t => t.id === todoId);
        if (todoIndex === -1) {
            results.push({ status: 'error', id: todoId, error: '未找到' });
        } else {
            const deletedTodo = data.todos.splice(todoIndex, 1)[0];
            deletedTodos.push(deletedTodo);
            results.push({ status: 'success', id: todoId, title: deletedTodo.title });
        }
    }

    await saveTodos(data);

    let result = `🗑️ 批量删除完成！成功: ${deletedTodos.length}/${args.todoIds.length}\n\n`;
    deletedTodos.forEach((todo, index) => {
        result += `${index + 1}. ${todo.title} (ID: ${todo.id})\n`;
    });

    return { status: 'success', result, details: results };
}

/**
 * 提醒待办事项
 * 此命令通常由定时任务系统自动调用
 */
async function remindTodo(args) {
    const data = await loadTodos();

    if (!args.todoId) {
        throw new Error('todoId 是必需的参数');
    }

    const todo = data.todos.find(t => t.id === args.todoId);
    if (!todo) {
        throw new Error(`未找到ID为 ${args.todoId} 的待办事项`);
    }

    // 检查待办是否已完成
    if (todo.status === 'completed') {
        return {
            status: 'success',
            result: `✅ 待办事项「${todo.title}」已完成，无需提醒。`
        };
    }

    const timezone = process.env.TIMEZONE || 'Asia/Shanghai';
    const now = new Date();

    let result = `⏰ 【待办提醒】\n\n`;
    result += `现在时间: ${now.toLocaleString('zh-CN', { timeZone: timezone })}\n\n`;
    result += formatTodoForDisplay(todo, 'detailed');

    // 检查是否已逾期
    if (todo.whenTime) {
        const whenDate = new Date(todo.whenTime);
        if (whenDate < now) {
            const overdueDays = Math.floor((now - whenDate) / (1000 * 60 * 60 * 24));
            result += `\n\n⚠️ 注意：此待办已逾期 ${overdueDays} 天！`;
        } else {
            const remainingHours = Math.floor((whenDate - now) / (1000 * 60 * 60));
            if (remainingHours < 24) {
                result += `\n\n⏳ 距离时间还有 ${remainingHours} 小时`;
            } else {
                const remainingDays = Math.floor(remainingHours / 24);
                result += `\n\n⏳ 距离时间还有 ${remainingDays} 天`;
            }
        }
    }

    result += `\n\n💡 快速操作：`;
    result += `\n- 标记完成: UpdateTodo, todoId: ${todo.id}, status: completed`;
    result += `\n- 查看详情: GetTodoDetail, todoId: ${todo.id}`;

    return { status: 'success', result };
}

/**
 * 主函数 - 处理命令分发
 */
async function main() {
    try {
        // 读取 stdin
        let inputData = '';
        for await (const chunk of process.stdin) {
            inputData += chunk;
        }

        if (!inputData.trim()) {
            throw new Error('未接收到输入数据');
        }

        const args = JSON.parse(inputData.trim());
        const command = args.command;

        if (!command) {
            throw new Error('缺少 command 参数');
        }

        let result;

        switch (command) {
            case 'CreateTodo':
                result = await createTodo(args);
                break;
            case 'ListTodos':
                result = await listTodos(args);
                break;
            case 'UpdateTodo':
                result = await updateTodo(args);
                break;
            case 'DeleteTodo':
                result = await deleteTodo(args);
                break;
            case 'GetTodoDetail':
                result = await getTodoDetail(args);
                break;
            case 'GetDailyTodos':
                result = await getDailyTodos(args);
                break;
            case 'RemindTodo':
                result = await remindTodo(args);
                break;
            case 'BatchCreate':
                result = await batchCreate(args);
                break;
            case 'BatchUpdate':
                result = await batchUpdate(args);
                break;
            case 'BatchDelete':
                result = await batchDelete(args);
                break;
            default:
                throw new Error(`未知的命令: ${command}`);
        }

        console.log(JSON.stringify(result));
        process.exit(0);

    } catch (error) {
        console.log(JSON.stringify({
            status: 'error',
            error: error.message
        }));
        process.exit(1);
    }
}

// 执行主函数
main();
