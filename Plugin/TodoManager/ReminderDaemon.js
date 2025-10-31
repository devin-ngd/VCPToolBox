const fs = require('fs').promises;
const path = require('path');
const http = require('http');

// 配置
const DATA_DIR = path.join(__dirname, 'data');
const TODOS_FILE = path.join(DATA_DIR, 'todos.json');
const CHECK_INTERVAL = 60 * 1000; // 每60秒检查一次
const DAILY_SUMMARY_HOUR = parseInt(process.env.DAILY_SUMMARY_HOUR || '8', 10); // 默认早上8点

// 已发送汇总记录（使用 Set 存储日期）
const sentDailySummaries = new Set();

/**
 * 读取待办数据
 */
async function loadTodos() {
    try {
        const content = await fs.readFile(TODOS_FILE, 'utf-8');
        return JSON.parse(content);
    } catch (error) {
        console.error(`[ReminderDaemon] 读取待办文件失败: ${error.message}`);
        return { todos: [] };
    }
}

/**
 * 保存待办数据
 */
async function saveTodos(data) {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.writeFile(TODOS_FILE, JSON.stringify(data, null, 2), 'utf-8');
        return true;
    } catch (error) {
        console.error(`[ReminderDaemon] 写入待办文件失败: ${error.message}`);
        return false;
    }
}

/**
 * 通过 VCPLog 将提醒推送到前端（使用 WebSocket 广播）
 * @param {Object} todo - 待办事项对象
 * @param {string} agentName - Agent名称
 */
async function sendReminderToAgent(todo, agentName = 'Nova') {
    const timezone = process.env.TIMEZONE || 'Asia/Shanghai';
    const now = new Date();

    let message = `⏰ 【待办提醒】\n\n`;
    message += `📌 标题: ${todo.title}\n`;
    if (todo.description) {
        message += `📝 描述: ${todo.description}\n`;
    }
    const priorityEmoji = { high: '🔴', medium: '🟡', low: '🟢' };
    if (todo.priority) {
        message += `${priorityEmoji[todo.priority] || '⚪'} 优先级: ${todo.priority}\n`;
    }
    if (todo.dueDateTime) {
        const dueDate = new Date(todo.dueDateTime);
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

    try {
        // 守护进程通过 HTTP 请求发送提醒到主进程
        // 因为守护进程是独立进程，无法直接访问主进程的模块实例

        // 判断提醒类型
        let reminderType = 'normal';
        if (todo.id === 'daily_summary') {
            reminderType = 'daily_summary';
        } else if (todo.id && todo.id.startsWith('overdue_')) {
            reminderType = 'overdue';
        }

        const broadcastData = {
            type: 'TODO_REMINDER',          // 固定类型标识
            reminderType: reminderType,     // 提醒子类型：normal, daily_summary, overdue
            agentName: agentName,
            todoId: todo.id,
            title: todo.title,
            message: message,
            priority: todo.priority,
            dueDateTime: todo.dueDateTime,
            tags: todo.tags || [],
            timestamp: now.toISOString()
        };

        return new Promise((resolve, reject) => {
            const postData = JSON.stringify(broadcastData);
            const port = process.env.PORT || 8855;

            const options = {
                hostname: 'localhost',
                port: port,
                path: '/internal/vcplog-broadcast',  // 改为 VCPLog 通道
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
                        console.log(`[ReminderDaemon] ✓ 已通过 VCPLog 发送提醒: ${todo.title} -> ${agentName}`);
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
    } catch (error) {
        console.error(`[ReminderDaemon] × 发送提醒失败: ${error.message}`);
        console.error(`[ReminderDaemon] × 错误堆栈:`, error.stack);
        return false;
    }
}

/**
 * 检查每日待办汇总（简化版）
 */
async function checkDailyTodos() {
    const data = await loadTodos();
    const now = new Date();
    const timezone = process.env.TIMEZONE || 'Asia/Shanghai';
    const agentName = process.env.DEFAULT_AGENT_NAME || 'Nova';

    // 检查是否到了每日汇总时间（默认早上8点）
    const currentHour = now.getHours();
    if (currentHour !== DAILY_SUMMARY_HOUR) {
        return; // 不在汇总时间，跳过
    }

    // 获取今天的日期键
    const todayKey = now.toDateString();
    if (sentDailySummaries.has(todayKey)) {
        return; // 今天已发送过，跳过
    }

    // 获取今天的日期（仅日期部分，去掉时间）
    const today = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
    today.setHours(0, 0, 0, 0);

    // 收集所有未完成的待办事项，并按类别分组
    const overdueTodos = []; // 逾期的待办
    const todayTodos = []; // 今天到期的待办
    const upcomingTodos = []; // 未来的待办
    const noDateTodos = []; // 没有截止日期的待办

    data.todos.forEach(todo => {
        if (todo.status === 'completed') return;

        if (todo.dueDateTime) {
            const dueDate = new Date(todo.dueDateTime);
            const dueDateOnly = new Date(dueDate.toLocaleString('en-US', { timeZone: timezone }));
            dueDateOnly.setHours(0, 0, 0, 0);

            if (dueDateOnly.getTime() < today.getTime()) {
                overdueTodos.push(todo);
            } else if (dueDateOnly.getTime() === today.getTime()) {
                todayTodos.push(todo);
            } else {
                upcomingTodos.push(todo);
            }
        } else {
            // 没有截止日期的待办
            noDateTodos.push(todo);
        }
    });

    const totalTodos = overdueTodos.length + todayTodos.length + upcomingTodos.length + noDateTodos.length;

    // 如果有待办事项，发送汇总提醒
    if (totalTodos > 0) {
        let summaryMessage = `📅 【每日待办汇总】\n\n`;
        summaryMessage += `今天是 ${today.toLocaleDateString('zh-CN', { timeZone: timezone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n`;
        summaryMessage += `共有 ${totalTodos} 个未完成的待办事项\n\n`;

        // 逾期的待办（最优先显示）
        if (overdueTodos.length > 0) {
            summaryMessage += `🚨 【逾期待办】（${overdueTodos.length} 项）\n`;
            overdueTodos.forEach((todo, index) => {
                const priorityEmoji = { high: '🔴', medium: '🟡', low: '🟢' };
                summaryMessage += `${index + 1}. ${priorityEmoji[todo.priority] || '⚪'} ${todo.title}\n`;
                if (todo.dueDateTime) {
                    const dueDate = new Date(todo.dueDateTime);
                    const overdueDays = Math.floor((now - dueDate) / (1000 * 60 * 60 * 24));
                    summaryMessage += `   ⏰ 已逾期 ${overdueDays} 天\n`;
                }
                if (todo.description) {
                    const shortDesc = todo.description.length > 40 ? todo.description.substring(0, 40) + '...' : todo.description;
                    summaryMessage += `   📝 ${shortDesc}\n`;
                }
                summaryMessage += '\n';
            });
        }

        // 今天到期的待办
        if (todayTodos.length > 0) {
            summaryMessage += `📌 【今日待办】（${todayTodos.length} 项）\n`;
            todayTodos.forEach((todo, index) => {
                const priorityEmoji = { high: '🔴', medium: '🟡', low: '🟢' };
                summaryMessage += `${index + 1}. ${priorityEmoji[todo.priority] || '⚪'} ${todo.title}\n`;
                if (todo.dueDateTime) {
                    const dueDate = new Date(todo.dueDateTime);
                    summaryMessage += `   ⏰ ${dueDate.toLocaleTimeString('zh-CN', { timeZone: timezone, hour: '2-digit', minute: '2-digit' })}\n`;
                }
                if (todo.description) {
                    const shortDesc = todo.description.length > 40 ? todo.description.substring(0, 40) + '...' : todo.description;
                    summaryMessage += `   📝 ${shortDesc}\n`;
                }
                summaryMessage += '\n';
            });
        }

        // 未来的待办（只显示数量，不详细列出）
        if (upcomingTodos.length > 0) {
            summaryMessage += `📋 【未来待办】（${upcomingTodos.length} 项）\n`;
            // 按截止日期排序，显示最近的3个
            upcomingTodos.sort((a, b) => new Date(a.dueDateTime) - new Date(b.dueDateTime));
            const showCount = Math.min(3, upcomingTodos.length);
            for (let i = 0; i < showCount; i++) {
                const todo = upcomingTodos[i];
                const priorityEmoji = { high: '🔴', medium: '🟡', low: '🟢' };
                const dueDate = new Date(todo.dueDateTime);
                const daysUntil = Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24));
                summaryMessage += `${i + 1}. ${priorityEmoji[todo.priority] || '⚪'} ${todo.title} (${daysUntil}天后)\n`;
            }
            if (upcomingTodos.length > 3) {
                summaryMessage += `   ... 还有 ${upcomingTodos.length - 3} 项\n`;
            }
            summaryMessage += '\n';
        }

        // 没有截止日期的待办（只显示数量）
        if (noDateTodos.length > 0) {
            summaryMessage += `📝 【无截止日期】（${noDateTodos.length} 项）\n\n`;
        }

        summaryMessage += `💡 使用"查看今日待办"命令可以查看更多详情`;

        try {
            // 使用 sendReminderToAgent 发送每日汇总，它会通过 WebSocket 发送
            await sendReminderToAgent({
                id: 'daily_summary',
                title: '每日待办汇总',
                description: summaryMessage,
                priority: 'medium'
            }, agentName);

            sentDailySummaries.add(todayKey);
            console.log(`[ReminderDaemon] ✓ 已发送每日待办汇总 (总计 ${totalTodos} 项: 逾期 ${overdueTodos.length}, 今日 ${todayTodos.length}, 未来 ${upcomingTodos.length}, 无日期 ${noDateTodos.length})`);
        } catch (error) {
            console.error(`[ReminderDaemon] 发送每日待办汇总失败: ${error.message}`);
        }
    } else {
        // 即使没有待办，也标记为已发送，避免重复检查
        sentDailySummaries.add(todayKey);
        console.log(`[ReminderDaemon] 今日无待办事项，跳过汇总`);
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
        if (!todo.dueDateTime) continue;

        // 初始化截止提醒相关字段
        if (typeof todo.dueDateReminderSent === 'undefined') {
            todo.dueDateReminderSent = false;
            dataModified = true;
        }

        const dueDate = new Date(todo.dueDateTime);

        // 检查是否已经到达或超过截止时间
        if (now < dueDate) continue;

        // 如果已经发送过截止提醒，则跳过
        if (todo.dueDateReminderSent === true) continue;

        // 检查是否需要重试（失败的情况）
        const lastDueAttemptAt = todo.lastDueDateReminderAttemptAt ? new Date(todo.lastDueDateReminderAttemptAt) : null;
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
            todo.dueDateReminderSent = true;
            todo.dueDateReminderSentAt = now.toISOString();
            todo.updatedAt = now.toISOString();
            overdueRemindersSent++;
            dataModified = true;
        } catch (error) {
            // 失败：记录并等待5分钟后重试
            console.error(`[ReminderDaemon] 发送截止提醒失败: ${error.message}`);
            todo.dueDateReminderSent = false;
            todo.dueDateReminderFailCount = (todo.dueDateReminderFailCount || 0) + 1;
            todo.lastDueDateReminderAttemptAt = now.toISOString();
            todo.nextDueDateReminderRetryAt = new Date(now.getTime() + RETRY_INTERVAL).toISOString();
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
    console.log('='.repeat(60));

    // 单次提醒已改用定时任务调度器，注释掉此检查
    // await checkAndSendReminders();

    // 立即执行一次截止时间检查
    await checkOverdueTodos();

    // 延迟2分钟执行每日待办检查，确保前端就绪
    console.log('[ReminderDaemon] 每日待办汇总将在2分钟后执行...');
    setTimeout(async () => {
        try {
            console.log('[ReminderDaemon] 开始执行延迟的每日待办检查');
            await checkDailyTodos();
        } catch (error) {
            console.error(`[ReminderDaemon] 延迟检查每日待办时出错: ${error.message}`);
        }
    }, 2 * 60 * 1000); // 2分钟延迟

    // 单次提醒已改用定时任务调度器，注释掉此定时检查
    // setInterval(async () => {
    //     try {
    //         await checkAndSendReminders();
    //     } catch (error) {
    //         console.error(`[ReminderDaemon] 检查提醒时出错: ${error.message}`);
    //     }
    // }, CHECK_INTERVAL);

    // 设置定时检查（截止时间）- 改为每小时检查一次
    setInterval(async () => {
        try {
            await checkOverdueTodos();
        } catch (error) {
            console.error(`[ReminderDaemon] 检查截止时间时出错: ${error.message}`);
        }
    }, CHECK_INTERVAL);

    // 每天在配置的小时之后，整天内每5分钟重试发送“每日待办汇总”，直到当天发送成功
    const dailySummaryHour = parseInt(process.env.DAILY_SUMMARY_HOUR || '8');
    setInterval(async () => {
        const now = new Date();
        const timezone = process.env.TIMEZONE || 'Asia/Shanghai';
        const localNow = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
        const scheduled = new Date(localNow);
        scheduled.setHours(dailySummaryHour, 0, 0, 0);

        // 只要已到达当日配置的整点（含）且“当日未成功发送”，就重复尝试
        if (localNow >= scheduled) {
            try {
                await checkDailyTodos();
            } catch (error) {
                console.error(`[ReminderDaemon] 检查每日待办时出错: ${error.message}`);
            }
        }
    }, 5 * 60 * 1000); // 每5分钟检查一次是否到了发送时间

    console.log(`[ReminderDaemon] 每日待办汇总时间: ${dailySummaryHour}:00（当天到点后未成功将持续重试）`);
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
