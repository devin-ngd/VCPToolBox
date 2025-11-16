const fs = require('fs').promises;
const path = require('path');

/**
 * TodoAnalyzer - 待办趋势分析静态插件
 * 符合VCP设计哲学：为AI提供智能的数据洞察
 */

const TODOS_FILE = path.join(__dirname, '..', 'TodoManager', 'data', 'todos.json');

async function analyzeTodos() {
    try {
        // 读取待办数据
        const data = await fs.readFile(TODOS_FILE, 'utf-8');
        const { todos } = JSON.parse(data);

        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        // 基础统计
        const total = todos.length;
        const pending = todos.filter(t => t.status === 'pending').length;
        const completed = todos.filter(t => t.status === 'completed').length;

        // 优先级分布
        const highPriority = todos.filter(t => t.status === 'pending' && t.priority === 'high').length;
        const mediumPriority = todos.filter(t => t.status === 'pending' && t.priority === 'medium').length;
        const lowPriority = todos.filter(t => t.status === 'pending' && t.priority === 'low').length;

        // 时间分析
        const overdue = todos.filter(t => {
            if (t.status === 'completed' || !t.whenTime) return false;
            return new Date(t.whenTime) < today;
        }).length;

        const todayTodos = todos.filter(t => {
            if (t.status === 'completed' || !t.whenTime) return false;
            const whenDate = new Date(t.whenTime);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);
            return whenDate >= today && whenDate < tomorrow;
        }).length;

        const thisWeek = todos.filter(t => {
            if (t.status === 'completed' || !t.whenTime) return false;
            const whenDate = new Date(t.whenTime);
            const nextWeek = new Date(today);
            nextWeek.setDate(nextWeek.getDate() + 7);
            return whenDate >= today && whenDate < nextWeek;
        }).length;

        // 完成率分析
        const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

        // 最近7天完成情况
        const sevenDaysAgo = new Date(today);
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const recentCompleted = todos.filter(t => {
            if (!t.completedAt) return false;
            return new Date(t.completedAt) >= sevenDaysAgo;
        }).length;

        // 标签统计（Top 5）
        const tagCounts = {};
        todos.filter(t => t.status === 'pending').forEach(todo => {
            if (todo.tags && Array.isArray(todo.tags)) {
                todo.tags.forEach(tag => {
                    tagCounts[tag] = (tagCounts[tag] || 0) + 1;
                });
            }
        });

        const topTags = Object.entries(tagCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([tag, count]) => `#${tag}(${count})`)
            .join(', ');

        // 生成紧凑的分析报告
        const report = [
            `📊 待办概览: ${pending}待办/${completed}已完成(${completionRate}%)`,
            `⚠️ 紧急度: ${highPriority}🔴 ${mediumPriority}🟡 ${lowPriority}🟢`,
            overdue > 0 ? `🚨 逾期: ${overdue}项` : null,
            todayTodos > 0 ? `📅 今日: ${todayTodos}项` : null,
            thisWeek > 0 ? `📆 本周: ${thisWeek}项` : null,
            recentCompleted > 0 ? `✅ 7天完成: ${recentCompleted}项` : null,
            topTags ? `🏷️ 热门: ${topTags}` : null
        ].filter(Boolean).join(' | ');

        console.log(report);

    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('📊 待办概览: 暂无数据');
        } else {
            console.error(`待办分析失败: ${error.message}`);
        }
    }
}

// 执行分析
analyzeTodos();
