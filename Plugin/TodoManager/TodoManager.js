const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const SmartTimeParser = require('./SmartTimeParser');
const fileLock = require('./FileLock');

// 数据文件路径
const DATA_DIR = path.join(__dirname, 'data');
const TODOS_FILE = path.join(DATA_DIR, 'todos.json');
const TIMED_CONTACTS_DIR = path.join(__dirname, '../../VCPTimedContacts');
const DEFAULT_REMINDER_OFFSET_MINUTES = (() => {
    const value = parseInt(process.env.DEFAULT_REMINDER_MINUTES || '60', 10);
    return Number.isFinite(value) && value > 0 ? value : 60;
})();
const DEFAULT_REMINDER_LABEL = DEFAULT_REMINDER_OFFSET_MINUTES % 60 === 0
    ? `截止前${DEFAULT_REMINDER_OFFSET_MINUTES / 60}小时`
    : `截止前${DEFAULT_REMINDER_OFFSET_MINUTES}分钟`;

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
        console.error(`[TodoManager] 已创建定时提醒任务: ${taskId}`);
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
            console.error(`[TodoManager] 已删除定时提醒任务: ${taskId}`);
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
 * 读取所有待办事项（无锁，内部使用）
 */
async function _loadTodosUnsafe() {
    await ensureDataFile();
    const content = await fs.readFile(TODOS_FILE, 'utf-8');
    return JSON.parse(content);
}

/**
 * 保存所有待办事项（无锁，内部使用）
 */
async function _saveTodosUnsafe(data) {
    await fs.writeFile(TODOS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * 读取所有待办事项（带锁保护）- 仅用于简单读取
 */
async function loadTodos() {
    return await fileLock.withLock('todos', async () => {
        return await _loadTodosUnsafe();
    });
}

/**
 * 保存所有待办事项（带锁保护）- 仅用于简单保存
 */
async function saveTodos(data) {
    await fileLock.withLock('todos', async () => {
        await _saveTodosUnsafe(data);
    });
}

/**
 * 在锁保护下执行完整的读-改-写操作
 * @param {Function} fn - 接收 data 参数并修改它的函数
 * @returns {Promise<any>} fn 的返回值
 */
async function withTodosTransaction(fn) {
    return await fileLock.withLock('todos', async () => {
        const data = await _loadTodosUnsafe();
        const result = await fn(data);
        await _saveTodosUnsafe(data);
        return result;
    });
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

function computeDefaultReminderTime(whenTime) {
    if (!whenTime) return null;
    const whenDate = new Date(whenTime);
    if (isNaN(whenDate.getTime())) return null;
    const reminderDate = new Date(whenDate.getTime() - DEFAULT_REMINDER_OFFSET_MINUTES * 60 * 1000);
    if (isNaN(reminderDate.getTime()) || reminderDate <= new Date()) {
        return null;
    }
    return reminderDate.toISOString();
}

/**
 * 错误码定义
 */
const ERROR_CODES = {
    // 格式相关错误 (1000-1099)
    INVALID_JSON: 1001,
    MISSING_VERSION: 1002,
    UNSUPPORTED_VERSION: 1003,
    INVALID_SCHEMA: 1004,

    // 数据相关错误 (1100-1199)
    MISSING_REQUIRED_FIELD: 1101,
    INVALID_FIELD_TYPE: 1102,
    INVALID_ENUM_VALUE: 1103,
    INVALID_DATA: 1104,

    // 业务逻辑错误 (1200-1299)
    TODO_NOT_FOUND: 1201,
    INVALID_TODO_STATUS: 1202,
    INVALID_DEADLINE: 1203,

    // 系统错误 (1300-1399)
    PARSE_ERROR: 1301,
    SERIALIZE_ERROR: 1302,
    NETWORK_ERROR: 1303
};

/**
 * 自动检测提醒格式版本
 * @param {string|object} data - 接收到的数据
 * @returns {object} 检测结果 {version, format, parsedData}
 */
function detectReminderFormat(data) {
    // 尝试JSON.parse
    try {
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;

        // 检查是否为结构化格式
        if (parsed && parsed.version === '2.0' && parsed.type === 'TODO_REMINDER') {
            return {
                version: '2.0',
                format: 'structured',
                parsedData: parsed
            };
        }

        // 检查是否为v1.0对象格式
        if (parsed && parsed.type === 'TODO_REMINDER' && !parsed.version) {
            return {
                version: '1.0',
                format: 'legacy_object',
                parsedData: parsed
            };
        }

        // 如果不是对象，则为纯文本
        return {
            version: '1.0',
            format: 'legacy_text',
            parsedData: data
        };
    } catch (e) {
        // JSON解析失败，按纯文本处理
        return {
            version: '1.0',
            format: 'legacy_text',
            parsedData: data
        };
    }
}

/**
 * 安全解析提醒数据
 * @param {string|object} rawData - 原始数据
 * @returns {object} 解析结果
 */
function safeParseReminder(rawData) {
    try {
        // 1. 尝试JSON.parse
        const parsed = typeof rawData === 'string'
            ? JSON.parse(rawData)
            : rawData;

        // 2. 验证必要字段
        if (!parsed.type || parsed.type !== 'TODO_REMINDER') {
            throw new Error('缺少type字段或类型不正确');
        }

        // 3. 检查版本
        if (!parsed.version) {
            // v1.0格式，按legacy处理
            return {
                success: true,
                version: '1.0',
                data: parsed,
                isLegacy: true
            };
        }

        // 4. 验证v2.0格式
        if (parsed.version !== '2.0') {
            throw new Error(`不支持的版本: ${parsed.version}`);
        }

        return {
            success: true,
            version: '2.0',
            data: parsed,
            isLegacy: false
        };

    } catch (error) {
        // 记录错误
        console.error('Reminder parse error:', error);

        // 尝试降级处理
        if (typeof rawData === 'string') {
            return {
                success: false,
                error: {
                    code: ERROR_CODES.PARSE_ERROR,
                    type: 'PARSE_ERROR',
                    message: error.message,
                    details: { originalData: rawData }
                },
                fallback: {
                    version: '1.0',
                    message: '降级到纯文本格式',
                    textData: rawData
                }
            };
        }

        return {
            success: false,
            error: {
                code: ERROR_CODES.INVALID_DATA,
                type: 'INVALID_DATA',
                message: '数据格式完全无效'
            }
        };
    }
}

/**
 * 生成提醒唯一标识符
 */
function generateReminderId(todoId, timestamp) {
    return `reminder_${timestamp}_${todoId.split('_').pop()}`;
}

/**
 * 计算完成进度（基于子任务或时间）
 */
function calculateProgress(todo) {
    // 如果有子任务，根据子任务完成情况计算
    if (todo.subTasks && todo.subTasks.length > 0) {
        const completed = todo.subTasks.filter(st => st.completed).length;
        return completed / todo.subTasks.length;
    }

    // 如果有待办时间，根据时间计算进度
    if (todo.whenTime && todo.createdAt) {
        const created = new Date(todo.createdAt).getTime();
        const due = new Date(todo.whenTime).getTime();
        const now = Date.now();

        if (now >= due) {
            return todo.status === 'completed' ? 1 : 0;
        }

        const total = due - created;
        const elapsed = now - created;
        return Math.min(Math.max(elapsed / total, 0), 1);
    }

    // 默认值
    return todo.status === 'completed' ? 1 : 0;
}

/**
 * 生成时间信息
 */
function generateTimeInfo(todo, reminderType = 'normal') {
    if (!todo.whenTime) {
        return {
            timeRemaining: null,
            minutesRemaining: null,
            isUrgent: false
        };
    }

    const now = new Date();
    const dueDate = new Date(todo.whenTime);
    const diffMs = dueDate - now;
    const diffMinutes = Math.floor(diffMs / (1000 * 60));

    let timeRemaining;
    if (diffMs < 0) {
        timeRemaining = '已逾期';
    } else if (diffMinutes < 60) {
        timeRemaining = `${diffMinutes}分钟后截止`;
    } else if (diffMinutes < 24 * 60) {
        const hours = Math.floor(diffMinutes / 60);
        timeRemaining = `${hours}小时后截止`;
    } else {
        const days = Math.floor(diffMinutes / (24 * 60));
        timeRemaining = `${days}天后截止`;
    }

    return {
        timeRemaining: timeRemaining,
        minutesRemaining: diffMinutes > 0 ? diffMinutes : null,
        isUrgent: diffMinutes > 0 && diffMinutes <= 30
    };
}

/**
 * 生成逾期信息
 */
function generateOverdueInfo(todo) {
    if (!todo.whenTime) return null;

    const now = new Date();
    const dueDate = new Date(todo.whenTime);
    const overdueMs = now - dueDate;

    if (overdueMs <= 0) return null;

    const daysOverdue = Math.floor(overdueMs / (1000 * 60 * 60 * 24));
    const hoursOverdue = Math.floor((overdueMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

    let severity;
    if (daysOverdue >= 7) {
        severity = 'severe';
    } else if (daysOverdue >= 3) {
        severity = 'moderate';
    } else {
        severity = 'mild';
    }

    return {
        daysOverdue: daysOverdue,
        hoursOverdue: hoursOverdue,
        severity: severity
    };
}

/**
 * 生成操作按钮列表
 */
function generateActions(todo, reminderType) {
    const actions = [
        {
            type: 'complete',
            label: '标记完成',
            command: `UpdateTodo status:completed todoId:${todo.id}`,
            disabled: false
        },
        {
            type: 'view',
            label: '查看详情',
            command: `GetTodoDetail todoId:${todo.id}`,
            disabled: false
        }
    ];

    if (reminderType === 'normal' && todo.whenTime) {
        actions.push({
            type: 'snooze',
            label: '稍后提醒',
            command: `SnoozeReminder todoId:${todo.id} minutes:30`,
            disabled: false
        });
    }

    if (reminderType === 'overdue') {
        actions.push({
            type: 'reschedule',
            label: '修改截止时间',
            command: `UpdateTodo todoId:${todo.id} when:tomorrow`,
            disabled: false
        });
    }

    return actions;
}

/**
 * 生成显示配置
 */
function generateDisplayConfig(priority, reminderType) {
    const priorityConfig = {
        high: { color: '#e74c3c', icon: 'exclamation-circle' },
        medium: { color: '#f39c12', icon: 'clock' },
        low: { color: '#2ecc71', icon: 'check-circle' },
        normal: { color: '#3498db', icon: 'circle' }
    };

    const config = priorityConfig[priority] || priorityConfig.normal;

    let color = config.color;
    if (reminderType === 'overdue') {
        color = '#e74c3c';
    } else if (reminderType === 'daily_summary') {
        color = '#3498db';
    }

    return {
        showNotification: true,
        playSound: reminderType !== 'daily_summary',
        icon: config.icon,
        color: color
    };
}

/**
 * 生成结构化JSON提醒格式（v2.0）
 */
function generateStructuredReminder(todo, reminderType = 'normal', options = {}) {
    const now = Date.now();

    // 基础字段回退处理
    const safeTitle = (todo.title && String(todo.title).trim()) ? todo.title : '未命名待办';
    const safeContent = (todo.description && String(todo.description).trim())
        ? todo.description
        : (reminderType === 'daily_summary' ? safeTitle : safeTitle); // 汇总类也回退到标题

    const createdTs = (() => {
        if (todo.createdAt) {
            const t = new Date(todo.createdAt).getTime();
            return isNaN(t) ? now : t;
        }
        return now;
    })();
    const updatedTs = (() => {
        if (todo.updatedAt) {
            const t = new Date(todo.updatedAt).getTime();
            return isNaN(t) ? createdTs : t;
        }
        return createdTs;
    })();

    const reminder = {
        version: '2.0',
        type: 'TODO_REMINDER',
        reminderType: reminderType,
        priority: todo.priority || 'normal',
        data: {
            id: generateReminderId(todo.id, now),
            todoId: todo.id,
            title: safeTitle,
            content: safeContent,
            status: todo.status,
            deadline: todo.whenTime || null,
            createdAt: createdTs,
            updatedAt: updatedTs,
            tags: todo.tags || [],
            assignee: todo.assignee || null,
            priority: todo.priority || 'normal',
            progress: calculateProgress(todo),
            timeInfo: generateTimeInfo(todo, reminderType),
            subTasks: todo.subTasks || []
        },
        metadata: {
            source: 'TodoManager',
            agentName: options.agentName || 'System',
            timestamp: now,
            sessionId: options.sessionId || null,
            messageId: options.messageId || null,
            format: 'structured'
        },
        actions: generateActions(todo, reminderType),
        display: generateDisplayConfig(todo.priority, reminderType)
    };

    // 根据提醒类型添加特殊字段
    if (reminderType === 'overdue') {
        reminder.data.overdueInfo = generateOverdueInfo(todo);
    } else if (reminderType === 'daily_summary') {
        reminder.data.summary = options.summary || null;
        reminder.data.relatedTodos = options.relatedTodos || [];
    }

    return reminder;
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
    if (!args.title) {
        throw new Error('标题是必需的参数');
    }

    // 使用智能时间解析器
    let whenTime = null;
    let reminderTime = null;
    let defaultReminderApplied = false;
    const remindArgProvided = Object.prototype.hasOwnProperty.call(args, 'remind');
    const reminderTimeArgProvided = Object.prototype.hasOwnProperty.call(args, 'reminderTime');
    const reminderExplicitlyProvided = remindArgProvided || reminderTimeArgProvided;

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
    if (!reminderTime && reminderTimeArgProvided) {
        reminderTime = args.reminderTime ? new Date(args.reminderTime).toISOString() : null;
    }

    // 如果有截止时间且未显式指定提醒时间，自动应用默认提醒
    if (whenTime && !reminderTime && !reminderExplicitlyProvided) {
        const defaultReminderTime = computeDefaultReminderTime(whenTime);
        if (defaultReminderTime) {
            reminderTime = defaultReminderTime;
            defaultReminderApplied = true;
            console.error(`[TodoManager] 为待办自动设置默认提醒时间（${DEFAULT_REMINDER_LABEL}）: ${reminderTime}`);
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

    // 使用事务保护读-改-写操作
    await withTodosTransaction(async (data) => {
        data.todos.push(todo);
    });

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
        const isDefaultReminder = (!args.remind && !reminderTimeArgProvided) || defaultReminderApplied;

        if (isDefaultReminder && !reminderTimeArgProvided) {
            result += `\n\n⏰ 已自动设置默认提醒（${DEFAULT_REMINDER_LABEL}）：${reminderDate.toLocaleString('zh-CN', { timeZone: timezone })}`;
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

        // 包含未指定日期但未完成的任务（这些任务默认应在今日完成）
        if (!todo.whenTime && !todo.reminderTime) {
            return true;
        }

        return false;
    });

    // 按优先级和时间排序（有日期的优先按时间，无日期的按优先级）
    const todosWithDate = todayTodos.filter(t => t.whenTime);
    const todosWithoutDate = todayTodos.filter(t => !t.whenTime);

    // 有日期的按时间排序
    todosWithDate.sort((a, b) => {
        if (a.whenTime && b.whenTime) {
            return new Date(a.whenTime) - new Date(b.whenTime);
        }
        return 0;
    });

    // 无日期的按优先级排序
    todosWithoutDate.sort((a, b) => {
        const priorityOrder = { high: 3, medium: 2, low: 1 };
        return (priorityOrder[b.priority] || 0) - (priorityOrder[a.priority] || 0);
    });

    // 合并列表（无日期的排在后面）
    const sortedTodos = [...todosWithDate, ...todosWithoutDate];

    if (sortedTodos.length === 0) {
        return {
            status: 'success',
            result: `📅 ${now.toLocaleDateString('zh-CN', { timeZone: process.env.TIMEZONE || 'Asia/Shanghai' })}\n\n🎉 太棒了！今天没有待办事项，享受轻松的一天吧！`
        };
    }

    const format = args.format || 'compact';
    let result = `📅 ${now.toLocaleDateString('zh-CN', { timeZone: process.env.TIMEZONE || 'Asia/Shanghai' })} - 今日待办清单\n`;
    result += `\n共有 ${sortedTodos.length} 项待办事项`;

    // 如果有无日期的任务，添加说明
    if (todosWithoutDate.length > 0) {
        result += `\n💡 注：其中 ${todosWithoutDate.length} 项未指定日期，建议今日完成\n`;
    }

    result += '\n';

    if (format === 'compact') {
        sortedTodos.forEach((todo, index) => {
            let display = formatTodoForDisplay(todo, 'compact');
            // 为无日期的任务添加特殊标记
            if (!todo.whenTime) {
                display = `📋 ${display}`;
            }
            result += `${index + 1}. ${display}\n`;
        });
    } else {
        result += `\n${'='.repeat(50)}\n\n`;
        sortedTodos.forEach((todo, index) => {
            let display = formatTodoForDisplay(todo, format);
            // 为无日期的任务添加特殊标记
            if (!todo.whenTime) {
                display = `📋 【未指定日期，建议今日完成】\n${display}`;
            }
            result += `${index + 1}. ${display}\n`;
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
    const hasRemindArg = Object.prototype.hasOwnProperty.call(args, 'remind');
    const hasReminderTimeArg = Object.prototype.hasOwnProperty.call(args, 'reminderTime');
    const reminderInstructionsProvided = hasRemindArg || hasReminderTimeArg;
    const dueDateChanged = Boolean(args.when) || Object.prototype.hasOwnProperty.call(args, 'dueDate') || Object.prototype.hasOwnProperty.call(args, 'dueTime');

    // 更新字段
    if (args.title) todo.title = args.title;
    if (args.description !== undefined) todo.description = args.description;
    if (args.priority) todo.priority = args.priority;
    if (args.tags !== undefined) {
        todo.tags = args.tags.split(',').map(t => t.trim()).filter(t => t);
    }

    // 使用智能时间解析更新时间
    let reminderTimeChanged = false;

    if (args.when) {
        todo.whenTime = timeParser.parse(args.when);

        // 如果同时指定了提醒偏移，更新提醒时间
        if (args.remind) {
            todo.reminderTime = timeParser.calculateReminderTime(todo.whenTime, args.remind);
            reminderTimeChanged = true;
        }
    }

    // 兼容旧参数
    if (args.dueDate !== undefined || args.dueTime !== undefined) {
        const dueDate = args.dueDate || (todo.whenTime ? todo.whenTime.split('T')[0] : null);
        const dueTime = args.dueTime || null;
        todo.whenTime = parseDateTime(dueDate, dueTime);
    }

    if (dueDateChanged && todo.whenTime && !reminderInstructionsProvided) {
        const defaultReminderTime = computeDefaultReminderTime(todo.whenTime);
        if (defaultReminderTime && todo.reminderTime !== defaultReminderTime) {
            todo.reminderTime = defaultReminderTime;
            reminderTimeChanged = true;
            console.error(`[TodoManager] 为待办自动设置默认提醒时间（${DEFAULT_REMINDER_LABEL}）: ${todo.reminderTime}`);
        }
    }

    if (hasReminderTimeArg) {
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
            todo.whenTimeReminderSent = false;
            todo.reminderSent = false;

            // 如果启用了autoLog，将完成记录写入日记
            if (todo.autoLog) {
                const reflection = args.reflection || '';
                await logTodoToDiary(todo, 'completed', reflection);
            }
        } else if (args.status === 'pending' && oldStatus === 'completed') {
            todo.completedAt = null;
            todo.whenTimeReminderSent = false;
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
            const remindArgProvided = Object.prototype.hasOwnProperty.call(todoArgs, 'remind');
            const reminderTimeArgProvided = Object.prototype.hasOwnProperty.call(todoArgs, 'reminderTime');

            if (todoArgs.when) {
                whenTime = timeParser.parse(todoArgs.when);
                if (todoArgs.remind) {
                    reminderTime = timeParser.calculateReminderTime(whenTime, todoArgs.remind);
                }
            }

            if (!reminderTime && reminderTimeArgProvided) {
                reminderTime = todoArgs.reminderTime ? new Date(todoArgs.reminderTime).toISOString() : null;
            }

            if (whenTime && !reminderTime && !remindArgProvided && !reminderTimeArgProvided) {
                const defaultReminderTime = computeDefaultReminderTime(whenTime);
                if (defaultReminderTime) {
                    reminderTime = defaultReminderTime;
                    console.error(`[TodoManager] 为批量创建的待办自动设置默认提醒时间（${DEFAULT_REMINDER_LABEL}）: ${reminderTime}`);
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
 * 支持结构化JSON v2.0格式输出和传统文本格式
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

    // 检查输出格式（默认v2.0结构化格式）
    const format = args.format || '2.0';

    if (format === '2.0' || format === 'structured') {
        // 生成结构化JSON v2.0格式
        const structuredReminder = generateStructuredReminder(todo, 'normal', {
            agentName: args.agentName || process.env.DEFAULT_AGENT_NAME || 'System',
            sessionId: args.sessionId || null,
            messageId: args.messageId || null
        });

        return {
            status: 'success',
            result: structuredReminder
        };
    }

    // 传统v1.0文本格式（向后兼容）
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

// 导出函数供其他模块使用
module.exports = {
    // 核心函数
    createTodo,
    listTodos,
    updateTodo,
    deleteTodo,
    getTodoDetail,
    getDailyTodos,
    remindTodo,
    batchCreate,
    batchUpdate,
    batchDelete,

    // 结构化输出相关函数
    generateStructuredReminder,
    generateId,
    generateReminderId,
    calculateProgress,
    generateTimeInfo,
    generateOverdueInfo,
    generateActions,
    generateDisplayConfig,
    formatTodoForDisplay,

    // 错误处理和兼容性函数
    detectReminderFormat,
    safeParseReminder,
    ERROR_CODES,

    // 工具函数
    parseDateTime,
    loadTodos,
    saveTodos
};

// 执行主函数（仅在直接运行时）
if (require.main === module) {
    main();
}
