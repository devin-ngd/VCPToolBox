const fs = require('fs').promises;
const path = require('path');
const http = require('http');
const fileLock = require('./FileLock');

// 自动加载本地环境配置文件
const DAEMON_CONFIG_PATH = path.join(__dirname, 'todo-daemon.env');
(async () => {
    try {
        const configContent = await fs.readFile(DAEMON_CONFIG_PATH, 'utf-8');
        const configLines = configContent.split('\n');

        for (const line of configLines) {
            const trimmed = line.trim();
            // 跳过注释和空行
            if (!trimmed || trimmed.startsWith('#')) continue;

            const equalIndex = trimmed.indexOf('=');
            if (equalIndex > 0) {
                const key = trimmed.substring(0, equalIndex).trim();
                const value = trimmed.substring(equalIndex + 1).trim();

                // 只设置未存在的环境变量
                if (!process.env[key]) {
                    process.env[key] = value;
                }
            }
        }

        console.log(`[ReminderDaemon] 已加载本地配置文件: ${DAEMON_CONFIG_PATH}`);
    } catch (error) {
        // 如果配置文件不存在或读取失败，使用默认配置
        console.log(`[ReminderDaemon] 未找到本地配置文件，使用默认配置: ${error.message}`);
    }
})();

// 配置
const DATA_DIR = path.join(__dirname, 'data');
const TODOS_FILE = path.join(DATA_DIR, 'todos.json');
const ARCHIVE_FILE = path.join(DATA_DIR, 'todos_archive.json');
const ARCHIVE_THRESHOLD_DAYS = 7; // 归档阈值天数
const CHECK_INTERVAL = 60 * 1000; // 每60秒检查一次
const DAILY_SUMMARY_HOUR = parseInt(process.env.DAILY_SUMMARY_HOUR || '9', 10); // 默认早上9点
const STARTUP_REMINDER_ENABLED = process.env.STARTUP_REMINDER_ENABLED !== 'false'; // 默认启用系统启动提醒，除非明确设置为false
const STARTUP_REMINDER_DELAY = parseInt(process.env.STARTUP_REMINDER_DELAY || '120', 10); // 已弃用，不再使用固定延迟
const RETRY_INTERVAL = 5 * 60 * 1000; // 5分钟重试间隔（已弃用）

// 已发送汇总记录（使用 Set 存储日期）
const sentDailySummaries = new Set();

// 已提醒记录（使用 Set 存储待办ID和时间戳）
const remindedTodos = new Set();

// 启动标志，避免重复执行
let startupReminderSent = false;

// HTTP服务器监听VCPLog连接状态
const REMINDER_HTTP_PORT = parseInt(process.env.REMINDER_HTTP_PORT || '8856', 10);
const server = http.createServer(async (req, res) => {
    // 设置CORS头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.url === '/vcplog-connected' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                console.log(`[ReminderDaemon] 收到VCPLog连接通知: ${data.message}`);

                // 延迟3秒后执行系统启动提醒（仅执行一次）
                if (STARTUP_REMINDER_ENABLED && !startupReminderSent) {
                    startupReminderSent = true;
                    console.log('[ReminderDaemon] 将在3秒后执行系统启动提醒');
                    setTimeout(async () => {
                        console.log('[ReminderDaemon] 开始执行系统启动通用提醒');
                        try {
                            await checkStartupReminders();
                        } catch (error) {
                            console.error(`[ReminderDaemon] 执行系统启动提醒失败: ${error.message}`);
                        }
                    }, 3000);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok' }));
            } catch (error) {
                console.error(`[ReminderDaemon] 处理VCPLog连接通知失败: ${error.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', message: error.message }));
            }
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

// 启动HTTP服务器
server.listen(REMINDER_HTTP_PORT, () => {
    console.log(`[ReminderDaemon] HTTP监听器已启动，端口: ${REMINDER_HTTP_PORT}`);
    console.log(`[ReminderDaemon] VCPLog连接通知地址: http://localhost:${REMINDER_HTTP_PORT}/vcplog-connected`);
});

/**
 * 读取待办数据（带锁保护）
 */
async function loadTodos() {
    return await fileLock.withLock('todos', async () => {
        try {
            const content = await fs.readFile(TODOS_FILE, 'utf-8');
            return JSON.parse(content);
        } catch (error) {
            console.error(`[ReminderDaemon] 读取待办文件失败: ${error.message}`);
            return { todos: [] };
        }
    });
}

/**
 * 保存待办数据（带锁保护）
 */
async function saveTodos(data) {
    return await fileLock.withLock('todos', async () => {
        try {
            await fs.mkdir(DATA_DIR, { recursive: true });
            await fs.writeFile(TODOS_FILE, JSON.stringify(data, null, 2), 'utf-8');
            return true;
        } catch (error) {
            console.error(`[ReminderDaemon] 保存待办文件失败: ${error.message}`);
            return false;
        }
    });
}
    } catch (error) {
        console.error(`[ReminderDaemon] 写入待办文件失败: ${error.message}`);
        return false;
    }
}

/**
 * 发送广播数据到前端
 * @param {Object} broadcastData - 要发送的数据
 * @param {string} todoTitle - 待办标题（用于日志）
 * @param {string} agentName - 代理名称（用于日志）
 */
function sendBroadcastData(broadcastData, todoTitle, agentName) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(broadcastData);
        const port = process.env.PORT || 8855;

        const options = {
            hostname: 'localhost',
            port: port,
            path: '/internal/vcplog-broadcast',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = http.request(options, (res) => {
            let responseData = '';

            res.on('data', (chunk) => {
                responseData += chunk;
            });

            res.on('end', () => {
                if (res.statusCode === 200) {
                    console.log(`[ReminderDaemon] ✓ 已通过 VCPLog 发送提醒: ${todoTitle} -> ${agentName}`);
                    resolve(true);
                } else {
                    console.error(`[ReminderDaemon] × HTTP 请求失败，状态码: ${res.statusCode}`);
                    console.error(`[ReminderDaemon] × 响应: ${responseData}`);
                    reject(new Error(`HTTP ${res.statusCode}: ${responseData}`));
                }
            });
        });

        req.on('error', (error) => {
            console.error(`[ReminderDaemon] × HTTP 请求错误: ${error.message}`);
            reject(error);
        });

        req.write(postData);
        req.end();
    });
}

/**
 * 通过 VCPLog 将提醒推送到前端（使用 WebSocket 广播）
 * 支持v2.0结构化JSON格式和v1.0文本格式
 * @param {Object} todo - 待办事项对象
 * @param {string} agentName - Agent名称
 * @param {Object} options - 附加选项
 */
async function sendReminderToAgent(todo, agentName = 'Nova', options = {}) {
    const timezone = process.env.TIMEZONE || 'Asia/Shanghai';
    const now = new Date();

    try {
        // 判断提醒类型
        let reminderType = 'normal';
        if (todo.id === 'daily_summary') {
            // 统一使用 daily_summary 作为每日汇总ID
            reminderType = 'daily_summary';
        } else if (todo.id && todo.id.startsWith('overdue_')) {
            reminderType = 'overdue';
        } else if (todo.originalTodoId) {
            // 来自截止时间检查的特殊todo
            reminderType = 'overdue';
        }

        // 检查是否使用结构化格式（默认v2.0）
        const useStructuredFormat = options.format !== '1.0' && options.format !== 'legacy';

        if (useStructuredFormat) {
            // v2.0结构化JSON格式
            try {
                // 动态导入TodoManager模块
                const todoManagerPath = path.join(__dirname, 'TodoManager.js');
                delete require.cache[require.resolve(todoManagerPath)];
                const TodoManager = require(todoManagerPath);

                // 生成结构化提醒
                const structuredReminder = TodoManager.generateStructuredReminder(todo, reminderType, {
                    agentName: agentName,
                    sessionId: options.sessionId || null,
                    messageId: options.messageId || null,
                    summary: todo.summary || options.summary || null,
                    relatedTodos: todo.items || options.relatedTodos || []
                });

                return await sendBroadcastData(structuredReminder, todo.title, agentName);
            } catch (error) {
                console.error(`[ReminderDaemon] 生成结构化提醒失败，降级到v1.0格式: ${error.message}`);
                // 降级到v1.0格式，继续执行下面的代码
            }
        }

        // v1.0文本格式（向后兼容）
        let message = `⏰ 【待办提醒】\n\n`;
        message += `📌 标题: ${todo.title}\n`;
        if (todo.description) {
            message += `📝 描述: ${todo.description}\n`;
        }
        const priorityEmoji = { high: '🔴', medium: '🟡', low: '🟢' };
        if (todo.priority) {
            message += `${priorityEmoji[todo.priority] || '⚪'} 优先级: ${todo.priority}\n`;
        }
        if (todo.whenTime) {
            const dueDate = new Date(todo.whenTime);
            message += `⏱️ 截止时间: ${dueDate.toLocaleString('zh-CN', { timeZone: timezone })}\n`;
            if (dueDate < now) {
                const overdueDays = Math.floor((now - dueDate) / (1000 * 60 * 60 * 24));
                message += `⚠️ 已逾期 ${overdueDays} 天！\n`;
            } else {
                const remainingHours = Math.floor((dueDate - now) / (1000 * 60 * 60));
                if (remainingHours < 24) {
                    message += `⏳ 距离截止还有 ${remainingHours} 小时\n`;
                } else {
                    const remainingDays = Math.floor(remainingHours / 24);
                    message += `⏳ 距离截止还有 ${remainingDays} 天\n`;
                }
            }
        }
        if (todo.tags && todo.tags.length > 0) {
            message += `🏷️ 标签: ${todo.tags.map(t => `#${t}`).join(' ')}\n`;
        }
        message += `\n💡 快速操作提示：`;
        message += `\n- 可以说"标记第一个待办为完成"来完成此任务`;
        message += `\n- 可以说"查看待办详情 ${todo.id}"来查看完整信息`;
        message += `\n- ID: ${todo.id}`;

        const broadcastData = {
            type: 'TODO_REMINDER',
            reminderType: reminderType,
            agentName: agentName,
            todoId: todo.id,
            title: todo.title,
            message: message,
            priority: todo.priority,
            whenTime: todo.whenTime,
            tags: todo.tags || [],
            timestamp: now.toISOString()
        };

        return await sendBroadcastData(broadcastData, todo.title, agentName);

    } catch (error) {
        console.error(`[ReminderDaemon] × 发送提醒失败: ${error.message}`);
        console.error(`[ReminderDaemon] × 错误堆栈:`, error.stack);
        return false;
    }
}

/**
 * 生成每日汇总数据（统一逻辑）
 * @param {Array} todos - 所有待办事项
 * @param {string} timezone - 时区
 * @returns {Object} 汇总数据
 */
function generateDailySummaryData(todos, timezone) {
    const now = new Date();
    const localNow = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
    const todayStart = new Date(localNow);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(todayStart);
    todayEnd.setHours(23, 59, 59, 999);

    // 筛选当天的所有任务（包括已完成和未完成）
    const allTodayTodos = todos.filter(todo => {
        if (!todo.whenTime) return false; // 无日期的不算今日任务
        const dueDate = new Date(todo.whenTime);
        const localDueDate = new Date(dueDate.toLocaleString('en-US', { timeZone: timezone }));
        return localDueDate >= todayStart && localDueDate <= todayEnd;
    });

    // 筛选已过期的未完成任务（截止日期在今天之前）
    const overdueTodos = todos.filter(todo => {
        if (todo.status === 'completed') return false;
        if (!todo.whenTime) return false;
        const dueDate = new Date(todo.whenTime);
        const localDueDate = new Date(dueDate.toLocaleString('en-US', { timeZone: timezone }));
        return localDueDate < todayStart; // 在今天开始之前就是过期
    });

    // 筛选无截止日期的未完成任务
    const noDateTodos = todos.filter(todo => {
        return todo.status !== 'completed' && !todo.whenTime;
    });

    // 汇总：当天所有任务 + 逾期未完成 + 无截止日期未完成
    const summaryItems = [
        ...allTodayTodos,           // 当天的所有任务
        ...overdueTodos,            // 已过期的未完成任务
        ...noDateTodos              // 无截止日期的未完成任务
    ];

    // 去重（基于todo id）
    const uniqueItems = summaryItems.filter((item, index, self) =>
        index === self.findIndex(t => t.id === item.id)
    );

    // 构建汇总统计信息
    const completedTodos = todos.filter(todo => todo.status === 'completed');
    const totalTodos = todos.length;
    const totalIncomplete = todos.filter(todo => todo.status !== 'completed').length;
    const overdueCount = overdueTodos.length; // 仅统计有日期的逾期任务

    return {
        uniqueItems,
        allTodayTodos,
        overdueTodos,
        noDateTodos,
        summary: {
            total: totalTodos,
            completed: completedTodos.length,
            pending: totalIncomplete,
            overdue: overdueCount
        }
    };
}

/**
 * 检查每日待办汇总（简化版）
 */
async function checkDailyTodos() {
    const data = await loadTodos();
    const timezone = process.env.TIMEZONE || 'Asia/Shanghai';
    const agentName = process.env.DEFAULT_AGENT_NAME || 'Nova';
    const now = new Date();
    const localNow = new Date(now.toLocaleString('en-US', { timeZone: timezone }));

    // 检查是否到了每日汇总时间（按配置的时区判断）
    const currentHour = localNow.getHours();
    if (currentHour !== DAILY_SUMMARY_HOUR) {
        return; // 不在汇总时间，跳过
    }

    // 获取今天的日期键（使用本地时区）
    const todayKey = localNow.toDateString();
    if (sentDailySummaries.has(todayKey)) {
        return; // 今天已发送过，跳过
    }

    console.log('[ReminderDaemon] 开始执行每日待办汇总检查...');

    const summaryData = generateDailySummaryData(data.todos, timezone);

    if (summaryData.uniqueItems.length === 0) {
        console.log('[ReminderDaemon] 没有需要汇总的待办事项，跳过每日待办汇总');
        return;
    }

    // 发送每日汇总提醒
    try {
        await sendReminderToAgent({
            id: 'daily_summary',
            title: '每日待办汇总',
            priority: 'normal',
            type: 'TODO_REMINDER',
            reminderType: 'daily_summary',
            items: summaryData.uniqueItems,
            summary: summaryData.summary
        }, agentName, { format: '2.0' });

        sentDailySummaries.add(todayKey);
        console.log(`[ReminderDaemon] ✓ 已发送每日待办汇总`);
        console.log(`[ReminderDaemon]   - 总任务: ${summaryData.summary.total} 个`);
        console.log(`[ReminderDaemon]   - 已完成: ${summaryData.summary.completed} 个`);
        console.log(`[ReminderDaemon]   - 待办: ${summaryData.summary.pending} 个`);
        console.log(`[ReminderDaemon]   - 今日任务: ${summaryData.allTodayTodos.length} 个`);
        console.log(`[ReminderDaemon]   - 逾期未完成: ${summaryData.overdueTodos.length} 个`);
        console.log(`[ReminderDaemon]   - 无截止日期: ${summaryData.noDateTodos.length} 个`);
    } catch (error) {
        console.error(`[ReminderDaemon] 发送每日待办汇总失败: ${error.message}`);
    }
}

/**
 * 检查并发送截止时间到达的提醒（未完成的待办）
 */
async function checkOverdueTodos() {
    const data = await loadTodos();
    const now = new Date();
    const agentName = process.env.DEFAULT_AGENT_NAME || 'Nova';

    let overdueRemindersSent = 0;
    let dataModified = false;

    for (const todo of data.todos) {
        // 跳过已完成的待办
        if (todo.status === 'completed') continue;

        // 只处理有截止时间的待办
        if (!todo.whenTime) continue;

        // 初始化截止提醒相关字段
        if (typeof todo.whenTimeReminderSent === 'undefined') {
            todo.whenTimeReminderSent = false;
            dataModified = true;
        }

        const dueDate = new Date(todo.whenTime);

        // 检查是否已经到达或超过截止时间
        if (now < dueDate) continue;

        // 如果已经发送过截止提醒，则跳过
        if (todo.whenTimeReminderSent === true) continue;

        // 检查是否需要重试（失败的情况）
        const lastDueAttemptAt = todo.lastWhenTimeReminderAttemptAt ? new Date(todo.lastWhenTimeReminderAttemptAt) : null;
        const readyToRetry = !lastDueAttemptAt || (now - lastDueAttemptAt >= RETRY_INTERVAL);
        if (!readyToRetry) continue;

        // 构建截止时间提醒消息
        const timezone = process.env.TIMEZONE || 'Asia/Shanghai';
        const overdueDuration = now - dueDate;
        const overdueDays = Math.floor(overdueDuration / (1000 * 60 * 60 * 24));
        const overdueHours = Math.floor((overdueDuration % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

        let overdueMessage = `⚠️ 【截止时间提醒】\n\n`;
        overdueMessage += `📌 标题: ${todo.title}\n`;

        if (todo.description) {
            overdueMessage += `📝 描述: ${todo.description}\n`;
        }

        const priorityEmoji = { high: '🔴', medium: '🟡', low: '🟢' };
        if (todo.priority) {
            overdueMessage += `${priorityEmoji[todo.priority] || '⚪'} 优先级: ${todo.priority}\n`;
        }

        overdueMessage += `⏱️ 截止时间: ${dueDate.toLocaleString('zh-CN', { timeZone: timezone })}\n`;

        if (overdueDays > 0) {
            overdueMessage += `🚨 已逾期 ${overdueDays} 天 ${overdueHours} 小时！请尽快处理\n`;
        } else if (overdueHours > 0) {
            overdueMessage += `🚨 已逾期 ${overdueHours} 小时！请尽快处理\n`;
        } else {
            overdueMessage += `🚨 截止时间已到！请立即处理\n`;
        }

        if (todo.tags && todo.tags.length > 0) {
            overdueMessage += `🏷️ 标签: ${todo.tags.map(t => `#${t}`).join(' ')}\n`;
        }

        overdueMessage += `\n💡 快速操作提示：`;
        overdueMessage += `\n- 可以说"标记待办 ${todo.id} 为完成"来完成此任务`;
        overdueMessage += `\n- 可以说"修改待办 ${todo.id} 截止时间为明天"来延期`;
        overdueMessage += `\n- ID: ${todo.id}`;

        const overdueTodo = {
            id: `overdue_${todo.id}`,
            title: `【逾期】${todo.title}`,
            description: overdueMessage,
            priority: 'high',
            originalTodoId: todo.id
        };

        try {
            await sendReminderToAgent(overdueTodo, agentName);
            // 成功
            todo.whenTimeReminderSent = true;
            todo.whenTimeReminderSentAt = now.toISOString();
            todo.updatedAt = now.toISOString();
            overdueRemindersSent++;
            dataModified = true;
        } catch (error) {
            // 失败：记录并等待5分钟后重试
            console.error(`[ReminderDaemon] 发送截止提醒失败: ${error.message}`);
            todo.whenTimeReminderSent = false;
            todo.whenTimeReminderFailCount = (todo.whenTimeReminderFailCount || 0) + 1;
            todo.lastWhenTimeReminderAttemptAt = now.toISOString();
            todo.nextWhenTimeReminderRetryAt = new Date(now.getTime() + RETRY_INTERVAL).toISOString();
            todo.updatedAt = now.toISOString();
            dataModified = true;
        }
    }

    if (dataModified) {
        await saveTodos(data);
    }

    if (overdueRemindersSent > 0) {
        console.log(`[ReminderDaemon] 本轮发送了 ${overdueRemindersSent} 条截止提醒`);
    }
}

/**
 * 检查系统启动时的每日待办汇总（与定时汇总使用相同逻辑）
 */
async function checkStartupReminders() {
    if (!STARTUP_REMINDER_ENABLED) {
        console.log('[ReminderDaemon] 系统启动提醒功能已禁用');
        return;
    }

    console.log('[ReminderDaemon] 开始执行系统启动每日待办汇总...');

    const data = await loadTodos();
    const agentName = process.env.DEFAULT_AGENT_NAME || 'Nova';
    const timezone = process.env.TIMEZONE || 'Asia/Shanghai';

    const summaryData = generateDailySummaryData(data.todos, timezone);

    if (summaryData.uniqueItems.length === 0) {
        console.log('[ReminderDaemon] 没有需要汇总的待办事项，跳过系统启动提醒');
        return;
    }

    try {
        // 使用与定时汇总相同的格式
        await sendReminderToAgent({
            id: 'daily_summary',
            title: '每日待办汇总',
            priority: 'normal',
            type: 'TODO_REMINDER',
            reminderType: 'daily_summary',
            items: summaryData.uniqueItems,
            summary: summaryData.summary
        }, agentName, { format: '2.0' });

        console.log(`[ReminderDaemon] ✓ 已发送系统启动每日汇总`);
        console.log(`[ReminderDaemon]   - 总任务: ${summaryData.summary.total} 个`);
        console.log(`[ReminderDaemon]   - 已完成: ${summaryData.summary.completed} 个`);
        console.log(`[ReminderDaemon]   - 待办: ${summaryData.summary.pending} 个`);
        console.log(`[ReminderDaemon]   - 今日任务: ${summaryData.allTodayTodos.length} 个`);
        console.log(`[ReminderDaemon]   - 逾期未完成: ${summaryData.overdueTodos.length} 个`);
        console.log(`[ReminderDaemon]   - 无截止日期: ${summaryData.noDateTodos.length} 个`);
    } catch (error) {
        console.error(`[ReminderDaemon] × 发送系统启动每日汇总失败: ${error.message}`);
    }
}

/**
 * 检查并发送到期的提醒
 */
async function checkAndSendReminders() {
    const data = await loadTodos();
    const now = new Date();
    const agentName = process.env.DEFAULT_AGENT_NAME || 'Nova';

    let remindersSent = 0;
    let dataModified = false;

    for (const todo of data.todos) {
        // 跳过已完成的待办
        if (todo.status === 'completed') continue;

        // 仅处理设置了提醒时间的待办
        if (!todo.reminderTime) continue;

        // 初始化扩展字段
        if (typeof todo.reminderSent === 'undefined') {
            todo.reminderSent = false;
            dataModified = true;
        }
        if (typeof todo.reminderFailCount === 'undefined') {
            todo.reminderFailCount = 0;
            dataModified = true;
        }

        const reminderTime = new Date(todo.reminderTime);
        // 尚未到提醒时间则跳过
        if (now < reminderTime) continue;

        // 如果已经成功提醒过，则跳过
        if (todo.reminderSent === true) continue;

        const lastAttemptAt = todo.lastReminderAttemptAt ? new Date(todo.lastReminderAttemptAt) : null;
        const readyToRetry = !lastAttemptAt || (now - lastAttemptAt >= RETRY_INTERVAL);
        if (!readyToRetry) continue;

        try {
            await sendReminderToAgent(todo, agentName);
            // 成功
            todo.reminderSent = true;
            todo.reminderSentAt = now.toISOString();
            todo.updatedAt = now.toISOString();
            remindersSent++;
            dataModified = true;
        } catch (error) {
            // 失败：记录并等待5分钟后重试
            console.error(`[ReminderDaemon] 发送提醒失败: ${error.message}`);
            todo.reminderSent = false;
            todo.reminderFailCount = (todo.reminderFailCount || 0) + 1;
            todo.lastReminderAttemptAt = now.toISOString();
            todo.nextReminderRetryAt = new Date(now.getTime() + RETRY_INTERVAL).toISOString();
            todo.updatedAt = now.toISOString();
            dataModified = true;
        }
    }

    if (dataModified) {
        await saveTodos(data);
    }

    if (remindersSent > 0) {
        console.log(`[ReminderDaemon] 本轮发送了 ${remindersSent} 条提醒`);
    }
}

/**
 * 清理旧的提醒记录
 */
function cleanOldReminders() {
    const now = Date.now();
    const oldSize = remindedTodos.size;

    for (const key of remindedTodos) {
        // 提取时间戳（格式：todoId_timestamp）
        const timestamp = parseInt(key.split('_').pop());
        const age = now - timestamp;

        // 删除超过24小时的记录
        if (age > 24 * 60 * 60 * 1000) {
            remindedTodos.delete(key);
        }
    }

    console.log(`[ReminderDaemon] 清理提醒记录: ${oldSize} -> ${remindedTodos.size}`);
}

/**
 * 归档已完成的任务
 */
async function archiveCompletedTodos() {
    console.log('[ReminderDaemon] 开始检查待归档任务...');
    const now = new Date();
    const thresholdDate = new Date(now.getTime() - ARCHIVE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);

    try {
        // 1. 读取主文件
        const todosData = await loadTodos();
        if (!todosData.todos || todosData.todos.length === 0) {
            return;
        }

        // 2. 筛选需要归档的任务
        const todosToArchive = todosData.todos.filter(todo => {
            if (todo.status !== 'completed') return false;
            // 使用 completedAt 或 updatedAt 判断
            const completedTime = todo.completedAt ? new Date(todo.completedAt) : (todo.updatedAt ? new Date(todo.updatedAt) : null);
            if (!completedTime) return false;
            return completedTime < thresholdDate;
        });

        if (todosToArchive.length === 0) {
            console.log('[ReminderDaemon] 没有需要归档的任务');
            return;
        }

        console.log(`[ReminderDaemon] 发现 ${todosToArchive.length} 个任务需要归档`);

        // 3. 读取或初始化归档文件
        let archiveData = { todos: [] };
        try {
            const archiveContent = await fs.readFile(ARCHIVE_FILE, 'utf-8');
            archiveData = JSON.parse(archiveContent);
        } catch (error) {
            // 如果文件不存在，使用默认空结构
            if (error.code !== 'ENOENT') {
                console.error(`[ReminderDaemon] 读取归档文件失败: ${error.message}`);
                throw error; // 关键错误，停止归档
            }
        }

        // 4. 添加到归档数据
        archiveData.todos = [...archiveData.todos, ...todosToArchive];

        // 5. 写入归档文件 (先写归档，确保安全)
        await fs.writeFile(ARCHIVE_FILE, JSON.stringify(archiveData, null, 2), 'utf-8');
        console.log(`[ReminderDaemon] 已写入归档文件: ${ARCHIVE_FILE}`);

        // 6. 从主数据中移除
        const remainingTodos = todosData.todos.filter(todo => !todosToArchive.includes(todo));
        todosData.todos = remainingTodos;

        // 7. 更新主文件
        await saveTodos(todosData);
        console.log(`[ReminderDaemon] 已从主文件中移除归档任务，剩余: ${remainingTodos.length}`);
        console.log(`[ReminderDaemon] 归档完成`);

    } catch (error) {
        console.error(`[ReminderDaemon] 归档过程出错: ${error.message}`);
    }
}

/**
 * 启动提醒守护进程
 */
async function startDaemon() {
    console.log('='.repeat(60));
    console.log('[ReminderDaemon] TodoManager 提醒守护进程启动（简化版）');
    console.log('='.repeat(60));
    console.log(`检查间隔: ${CHECK_INTERVAL / 1000} 秒`);
    console.log(`消息发送方式: VCPLog（WebSocket 广播）`);
    console.log(`默认Agent: ${process.env.DEFAULT_AGENT_NAME || 'Nova'}`);
    console.log(`时区设置: ${process.env.TIMEZONE || 'Asia/Shanghai'}`);
    console.log(`系统启动提醒: ${STARTUP_REMINDER_ENABLED ? '启用 (VCPLog连接后执行)' : '禁用'}`);
    console.log('='.repeat(60));

    // 立即执行一次截止时间检查
    await checkOverdueTodos();

    // 设置定时检查（按设置时间提醒）- 每60秒检查一次
    setInterval(async () => {
        try {
            await checkAndSendReminders();
        } catch (error) {
            console.error(`[ReminderDaemon] 检查提醒时出错: ${error.message}`);
        }
    }, CHECK_INTERVAL);

    // 设置定时检查（截止时间）- 每60秒检查一次
    setInterval(async () => {
        try {
            await checkOverdueTodos();
        } catch (error) {
            console.error(`[ReminderDaemon] 检查截止时间时出错: ${error.message}`);
        }
    }, CHECK_INTERVAL);

    // 每天在配置的小时执行一次"每日待办汇总"
    const dailySummaryHour = parseInt(process.env.DAILY_SUMMARY_HOUR || '8');
    setInterval(async () => {
        const now = new Date();
        const timezone = process.env.TIMEZONE || 'Asia/Shanghai';
        const localNow = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
        const scheduled = new Date(localNow);
        scheduled.setHours(dailySummaryHour, 0, 0, 0);
        const previousScheduled = new Date(scheduled);
        previousScheduled.setDate(scheduled.getDate() - 1);

        // 如果当前时间正好是配置的整点（或整点后1分钟内），执行一次
        if (localNow >= scheduled && localNow < new Date(scheduled.getTime() + 60000)) {
            // 检查今天是否已经发送过
            if (!sentDailySummaries.has(scheduled.toDateString())) {
                try {
                    await checkDailyTodos();
                    // 执行归档检查
                    await archiveCompletedTodos();
                } catch (error) {
                    console.error(`[ReminderDaemon] 检查每日待办或归档时出错: ${error.message}`);
                }
            }
        }
    }, 60000); // 每分钟检查一次

    console.log(`[ReminderDaemon] 每日待办汇总时间: ${dailySummaryHour}:00`);
    console.log('[ReminderDaemon] 守护进程运行中...\n');
}

// 优雅退出处理
process.on('SIGINT', () => {
    console.log('\n[ReminderDaemon] 接收到停止信号，正在退出...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n[ReminderDaemon] 接收到终止信号，正在退出...');
    process.exit(0);
});

// 启动守护进程
startDaemon().catch(error => {
    console.error(`[ReminderDaemon] 启动失败: ${error.message}`);
    process.exit(1);
});
