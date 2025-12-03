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
        let hasExplicitDate = false; // 是否明确指定了日期

        // 解析时间部分（如"下午3点"、"15:30"）
        // 注意：需要先匹配带具体时间的模式，再匹配纯时段词，最后匹配纯数字模式
        const timePatterns = [
            // 带具体时间的模式（优先级最高）
            { regex: /下午(\d{1,2})点(\d{1,2})分/, handler: (m) => { hour = parseInt(m[1]) + (parseInt(m[1]) < 12 ? 12 : 0); minute = parseInt(m[2]); hasTime = true; } },
            { regex: /下午(\d{1,2})点/, handler: (m) => { hour = parseInt(m[1]) + (parseInt(m[1]) < 12 ? 12 : 0); minute = 0; hasTime = true; } },
            { regex: /上午(\d{1,2})点(\d{1,2})分/, handler: (m) => { hour = parseInt(m[1]); minute = parseInt(m[2]); hasTime = true; } },
            { regex: /上午(\d{1,2})点/, handler: (m) => { hour = parseInt(m[1]); minute = 0; hasTime = true; } },
            { regex: /晚上(\d{1,2})点(\d{1,2})分/, handler: (m) => { hour = parseInt(m[1]) + (parseInt(m[1]) < 12 ? 12 : 0); minute = parseInt(m[2]); hasTime = true; } },
            { regex: /晚上(\d{1,2})点/, handler: (m) => { hour = parseInt(m[1]) + (parseInt(m[1]) < 12 ? 12 : 0); minute = 0; hasTime = true; } },
            { regex: /凌晨(\d{1,2})点(\d{1,2})分/, handler: (m) => { hour = parseInt(m[1]); minute = parseInt(m[2]); hasTime = true; } },
            { regex: /凌晨(\d{1,2})点/, handler: (m) => { hour = parseInt(m[1]); minute = 0; hasTime = true; } },
            { regex: /傍晚(\d{1,2})点(\d{1,2})分/, handler: (m) => { hour = parseInt(m[1]) + (parseInt(m[1]) < 12 ? 12 : 0); minute = parseInt(m[2]); hasTime = true; } },
            { regex: /傍晚(\d{1,2})点/, handler: (m) => { hour = parseInt(m[1]) + (parseInt(m[1]) < 12 ? 12 : 0); minute = 0; hasTime = true; } },

            // 纯时段词（默认时间）
            { regex: /深夜|半夜/, handler: () => { hour = 23; minute = 0; hasTime = true; } },
            { regex: /凌晨/, handler: () => { hour = 2; minute = 0; hasTime = true; } },
            { regex: /早上|清晨|早晨/, handler: () => { hour = 8; minute = 0; hasTime = true; } },
            { regex: /上午/, handler: () => { hour = 10; minute = 30; hasTime = true; } },
            { regex: /中午/, handler: () => { hour = 12; minute = 0; hasTime = true; } },
            { regex: /下午/, handler: () => { hour = 15; minute = 0; hasTime = true; } },
            { regex: /傍晚|黄昏/, handler: () => { hour = 18; minute = 0; hasTime = true; } },
            { regex: /晚上/, handler: () => { hour = 21; minute = 0; hasTime = true; } },

            // 纯数字模式（优先级最低，需要智能判断上下午）
            { regex: /(\d{1,2}):(\d{2})/, handler: (m) => { hour = parseInt(m[1]); minute = parseInt(m[2]); hasTime = true; } },
            { regex: /(\d{1,2})点(\d{1,2})分/, handler: (m) => { hour = parseInt(m[1]); minute = parseInt(m[2]); hasTime = true; } },
            { regex: /(\d{1,2})点/, handler: (m) => { hour = parseInt(m[1]); minute = 0; hasTime = true; } },
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
            hasExplicitDate = true;
            // 今天，保持targetDate不变
        } else if (text.includes('明天') || text.includes('明日')) {
            hasExplicitDate = true;
            targetDate.setDate(targetDate.getDate() + 1);
        } else if (text.includes('后天')) {
            hasExplicitDate = true;
            targetDate.setDate(targetDate.getDate() + 2);
        } else if (text.includes('大后天')) {
            hasExplicitDate = true;
            targetDate.setDate(targetDate.getDate() + 3);
        } else if (text.includes('昨天')) {
            hasExplicitDate = true;
            targetDate.setDate(targetDate.getDate() - 1);
        } else {
            // 匹配"N天后"、"N小时后"等
            const daysMatch = text.match(/(\d+)\s*天[\u540e\u4e4b]?/);
            if (daysMatch) {
                hasExplicitDate = true;
                targetDate.setDate(targetDate.getDate() + parseInt(daysMatch[1]));
            }

            const hoursMatch = text.match(/(\d+)\s*[个]?小时[\u540e\u4e4b]?/);
            if (hoursMatch) {
                targetDate.setHours(targetDate.getHours() + parseInt(hoursMatch[1]));
                return targetDate.toISOString();
            }

            const minutesMatch = text.match(/(\d+)\s*分钟[\u540e\u4e4b]?/);
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
                    hasExplicitDate = true;
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
                hasExplicitDate = true;
                targetDate.setDate(targetDate.getDate() + 7);
            } else if (text.includes('下个月') || text.includes('下月')) {
                hasExplicitDate = true;
                targetDate.setMonth(targetDate.getMonth() + 1);
            }
        }

        // 智能判断上下午（仅当纯数字输入且未明确指定上下午时）
        if (hasTime && hour >= 0 && hour <= 23) {
            const hasAmPmKeyword = /上午|下午|晚上|凌晨|早上|清晨|早晨|中午|傍晚|黄昏|深夜|半夜/.test(text);

            if (!hasAmPmKeyword) {
                // 纯数字输入，需要智能判断
                let adjustedHour = hour;

                // 1. 11、12点默认为上午（除非明确说半夜）
                if (hour === 11 || hour === 12) {
                    adjustedHour = hour;
                }
                // 2. 0-7点默认为下午（除非明确说凌晨）
                else if (hour >= 0 && hour <= 7) {
                    adjustedHour = hour + 12;
                }
                // 3. 8-10点默认为上午
                else if (hour >= 8 && hour <= 10) {
                    adjustedHour = hour;
                }
                // 4. 13-23点保持原样（已经是24小时制）
                else if (hour >= 13 && hour <= 23) {
                    adjustedHour = hour;
                }

                // 设置调整后的时间
                targetDate.setHours(adjustedHour, minute, 0, 0);

                // 如果没有明确指定日期，确保解析的时间在当前时间之后
                if (!hasExplicitDate) {
                    if (targetDate.getTime() <= now.getTime()) {
                        // 如果解析的时间已经过去，则认为是指明天
                        targetDate.setDate(targetDate.getDate() + 1);
                    }
                }
            } else {
                // 有明确的上下午关键词，直接设置时间
                targetDate.setHours(hour, minute, 0, 0);
            }
        } else if (hasTime) {
            // 设置时间
            targetDate.setHours(hour, minute, 0, 0);
        } else {
            // 如果没有指定时间，默认设为9:00
            targetDate.setHours(9, 0, 0, 0);
        }

        // 验证日期有效性
        if (isNaN(targetDate.getTime())) {
            console.error(`[SmartTimeParser] 无效的日期解析结果: ${naturalTime}`);
            return null;
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
        if (isNaN(whenDate.getTime())) {
            console.error(`[SmartTimeParser] 无效的whenTime: ${whenTime}`);
            return null;
        }

        const offset = this.parseOffset(remindOffset);
        const reminderDate = new Date(whenDate.getTime() + offset);

        if (isNaN(reminderDate.getTime())) {
            console.error(`[SmartTimeParser] 计算提醒时间失败: whenTime=${whenTime}, offset=${offset}`);
            return null;
        }

        return reminderDate.toISOString();
    }
}

module.exports = SmartTimeParser;
