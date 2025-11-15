/**
 * SmartTimeParser - 智能时间解析器
 * 支持自然语言时间表达式，符合VCP"为AI减负"的设计哲学
 */

class SmartTimeParser {
    constructor(timezone = 'Asia/Shanghai') {
        this.timezone = timezone;
    }

    /**
     * 解析自然语言时间为ISO字符串
     * @param {string} naturalTime - 自然语言时间描述
     * @param {Date} baseDate - 基准时间（默认为当前时间）
     * @returns {string|null} ISO时间字符串
     */
    parse(naturalTime, baseDate = null) {
        if (!naturalTime || typeof naturalTime !== 'string') {
            return null;
        }

        const now = baseDate || new Date();
        const text = naturalTime.trim().toLowerCase();

        // 如果已经是ISO格式或标准日期格式，直接解析
        const isoMatch = text.match(/^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}/);
        if (isoMatch) {
            return new Date(naturalTime).toISOString();
        }

        // 如果是纯日期格式 YYYY-MM-DD
        const dateMatch = text.match(/^\d{4}-\d{2}-\d{2}$/);
        if (dateMatch) {
            const date = new Date(naturalTime + ' 09:00:00');
            return date.toISOString();
        }

        let targetDate = new Date(now);
        let hasTime = false;
        let hour = 9;
        let minute = 0;

        // 解析时间部分（如"下午3点"、"15:30"）
        const timePatterns = [
            { regex: /(\d{1,2}):(\d{2})/, handler: (m) => { hour = parseInt(m[1]); minute = parseInt(m[2]); hasTime = true; } },
            { regex: /(\d{1,2})点(\d{1,2})分/, handler: (m) => { hour = parseInt(m[1]); minute = parseInt(m[2]); hasTime = true; } },
            { regex: /(\d{1,2})点/, handler: (m) => { hour = parseInt(m[1]); minute = 0; hasTime = true; } },
            { regex: /下午(\d{1,2})点/, handler: (m) => { hour = parseInt(m[1]) + (parseInt(m[1]) < 12 ? 12 : 0); hasTime = true; } },
            { regex: /上午(\d{1,2})点/, handler: (m) => { hour = parseInt(m[1]); hasTime = true; } },
            { regex: /晚上(\d{1,2})点/, handler: (m) => { hour = parseInt(m[1]) + (parseInt(m[1]) < 12 ? 12 : 0); hasTime = true; } },
            { regex: /中午/, handler: () => { hour = 12; minute = 0; hasTime = true; } },
            { regex: /早上/, handler: () => { hour = 8; minute = 0; hasTime = true; } },
        ];

        for (const pattern of timePatterns) {
            const match = text.match(pattern.regex);
            if (match) {
                pattern.handler(match);
                break;
            }
        }

        // 解析日期部分
        if (text.includes('今天') || text.includes('今日')) {
            // 今天，保持targetDate不变
        } else if (text.includes('明天') || text.includes('明日')) {
            targetDate.setDate(targetDate.getDate() + 1);
        } else if (text.includes('后天')) {
            targetDate.setDate(targetDate.getDate() + 2);
        } else if (text.includes('大后天')) {
            targetDate.setDate(targetDate.getDate() + 3);
        } else if (text.includes('昨天')) {
            targetDate.setDate(targetDate.getDate() - 1);
        } else {
            // 匹配"N天后"、"N小时后"等
            const daysMatch = text.match(/(\d+)\s*天[后之]?后?/);
            if (daysMatch) {
                targetDate.setDate(targetDate.getDate() + parseInt(daysMatch[1]));
            }

            const hoursMatch = text.match(/(\d+)\s*[个]?小时[后之]?后?/);
            if (hoursMatch) {
                targetDate.setHours(targetDate.getHours() + parseInt(hoursMatch[1]));
                return targetDate.toISOString();
            }

            const minutesMatch = text.match(/(\d+)\s*分钟[后之]?后?/);
            if (minutesMatch) {
                targetDate.setMinutes(targetDate.getMinutes() + parseInt(minutesMatch[1]));
                return targetDate.toISOString();
            }

            // 匹配星期
            const weekdayMap = {
                '周一': 1, '周二': 2, '周三': 3, '周四': 4, '周五': 5, '周六': 6, '周日': 0, '周天': 0,
                '星期一': 1, '星期二': 2, '星期三': 3, '星期四': 4, '星期五': 5, '星期六': 6, '星期日': 0, '星期天': 0,
                'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4, 'friday': 5, 'saturday': 6, 'sunday': 0,
                'mon': 1, 'tue': 2, 'wed': 3, 'thu': 4, 'fri': 5, 'sat': 6, 'sun': 0
            };

            for (const [weekdayStr, targetWeekday] of Object.entries(weekdayMap)) {
                if (text.includes(weekdayStr)) {
                    const currentWeekday = targetDate.getDay();
                    let daysToAdd = targetWeekday - currentWeekday;

                    // 如果包含"下"字，指下周
                    if (text.includes('下周') || text.includes('下个')) {
                        daysToAdd += 7;
                    } else if (daysToAdd <= 0) {
                        // 默认指本周后面的日期，如果已过就指下周
                        daysToAdd += 7;
                    }

                    targetDate.setDate(targetDate.getDate() + daysToAdd);
                    break;
                }
            }

            // 匹配"下周"、"下个月"
            if (text.includes('下周') && !Object.keys(weekdayMap).some(w => text.includes(w))) {
                targetDate.setDate(targetDate.getDate() + 7);
            } else if (text.includes('下个月') || text.includes('下月')) {
                targetDate.setMonth(targetDate.getMonth() + 1);
            }
        }

        // 设置时间
        if (hasTime) {
            targetDate.setHours(hour, minute, 0, 0);
        } else {
            // 如果没有指定时间，默认设为9:00
            targetDate.setHours(9, 0, 0, 0);
        }

        return targetDate.toISOString();
    }

    /**
     * 解析相对时间偏移（如"提前10分钟"）
     * @param {string} offsetText - 偏移描述
     * @returns {number} 偏移的毫秒数（负数表示提前）
     */
    parseOffset(offsetText) {
        if (!offsetText || typeof offsetText !== 'string') {
            return 0;
        }

        const text = offsetText.trim().toLowerCase();
        let offset = 0;

        // 匹配"提前N分钟"
        const minutesMatch = text.match(/提前\s*(\d+)\s*分钟/);
        if (minutesMatch) {
            offset = -parseInt(minutesMatch[1]) * 60 * 1000;
        }

        // 匹配"提前N小时"
        const hoursMatch = text.match(/提前\s*(\d+)\s*小时/);
        if (hoursMatch) {
            offset = -parseInt(hoursMatch[1]) * 60 * 60 * 1000;
        }

        // 匹配"N分钟后"
        const afterMinutesMatch = text.match(/(\d+)\s*分钟后/);
        if (afterMinutesMatch) {
            offset = parseInt(afterMinutesMatch[1]) * 60 * 1000;
        }

        return offset;
    }

    /**
     * 计算提醒时间
     * @param {string} whenTime - 主时间（ISO格式）
     * @param {string} remindOffset - 提醒偏移（如"提前10分钟"）
     * @returns {string|null} 提醒时间的ISO字符串
     */
    calculateReminderTime(whenTime, remindOffset) {
        if (!whenTime) return null;
        if (!remindOffset) return null;

        const whenDate = new Date(whenTime);
        const offset = this.parseOffset(remindOffset);

        const reminderDate = new Date(whenDate.getTime() + offset);
        return reminderDate.toISOString();
    }
}

module.exports = SmartTimeParser;
