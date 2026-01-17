/**
 * ContextVectorManager - 上下文向量对应映射管理模块
 * 
 * 功能：
 * 1. 维护当前会话中所有消息（除最后一条 AI 和用户消息外）的向量映射。
 * 2. 提供模糊匹配技术，处理 AI 或用户对上下文的微小编辑。
 * 3. 为后续的“上下文向量衰减聚合系统”提供底层数据支持。
 */

const crypto = require('crypto');

class ContextVectorManager {
    constructor(plugin) {
        this.plugin = plugin;
        // 核心映射：normalizedHash -> { vector, role, originalText, timestamp }
        this.vectorMap = new Map();
        // 顺序索引：用于按顺序获取向量
        this.historyAssistantVectors = [];
        this.historyUserVectors = [];
        
        // 模糊匹配阈值 (0.0 ~ 1.0)，用于判断两个文本是否足够相似以复用向量，因为是用于提取特征向量所以模糊程度可以大一点
        this.fuzzyThreshold = 0.85;
        this.decayRate = 0.85; // 默认衰减率
    }

    /**
     * 文本归一化处理
     */
    _normalize(text) {
        if (!text) return '';
        // 复用插件的清理逻辑
        let cleaned = this.plugin._stripHtml(text);
        cleaned = this.plugin._stripEmoji(cleaned);
        // 移除多余空格、换行，转小写
        return cleaned.toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * 生成内容哈希
     */
    _generateHash(text) {
        return crypto.createHash('sha256').update(text).digest('hex');
    }

    /**
     * 简单的字符串相似度算法 (Dice's Coefficient)
     * 用于处理微小编辑时的模糊匹配
     */
    _calculateSimilarity(str1, str2) {
        if (str1 === str2) return 1.0;
        if (str1.length < 2 || str2.length < 2) return 0;

        const getBigrams = (str) => {
            const bigrams = new Set();
            for (let i = 0; i < str.length - 1; i++) {
                bigrams.add(str.substring(i, i + 2));
            }
            return bigrams;
        };

        const b1 = getBigrams(str1);
        const b2 = getBigrams(str2);
        let intersect = 0;
        for (const b of b1) {
            if (b2.has(b)) intersect++;
        }

        return (2.0 * intersect) / (b1.size + b2.size);
    }

    /**
     * 尝试在现有缓存中寻找模糊匹配的向量
     */
    _findFuzzyMatch(normalizedText) {
        for (const entry of this.vectorMap.values()) {
            const similarity = this._calculateSimilarity(normalizedText, this._normalize(entry.originalText));
            if (similarity >= this.fuzzyThreshold) {
                return entry.vector;
            }
        }
        return null;
    }

    /**
     * 更新上下文映射
     * @param {Array} messages - 当前会话的消息数组
     */
    async updateContext(messages) {
        if (!Array.isArray(messages)) return;

        const newAssistantVectors = [];
        const newUserVectors = [];

        // 识别最后的消息索引以进行排除
        const lastUserIndex = messages.findLastIndex(m => m.role === 'user');
        const lastAiIndex = messages.findLastIndex(m => m.role === 'assistant');

        const tasks = messages.map(async (msg, index) => {
            // 排除逻辑：系统消息、最后一个用户消息、最后一个 AI 消息
            if (msg.role === 'system') return;
            if (index === lastUserIndex || index === lastAiIndex) return;

            const content = typeof msg.content === 'string' 
                ? msg.content 
                : (Array.isArray(msg.content) ? msg.content.find(p => p.type === 'text')?.text : '') || '';
            
            if (!content || content.length < 2) return;

            const normalized = this._normalize(content);
            const hash = this._generateHash(normalized);

            let vector = null;

            // 1. 精确匹配
            if (this.vectorMap.has(hash)) {
                vector = this.vectorMap.get(hash).vector;
            } 
            // 2. 模糊匹配 (处理微小编辑)
            else {
                vector = this._findFuzzyMatch(normalized);
                
                // 3. 如果都没有，则请求新向量
                if (!vector) {
                    vector = await this.plugin.getSingleEmbeddingCached(content);
                }

                // 存入映射
                if (vector) {
                    this.vectorMap.set(hash, {
                        vector,
                        role: msg.role,
                        originalText: content,
                        timestamp: Date.now()
                    });
                }
            }

            if (vector) {
                const entry = { vector, index, role: msg.role };
                if (msg.role === 'assistant') {
                    newAssistantVectors.push(entry);
                } else if (msg.role === 'user') {
                    newUserVectors.push(entry);
                }
            }
        });

        await Promise.all(tasks);

        // 保持原始顺序
        this.historyAssistantVectors = newAssistantVectors.sort((a, b) => a.index - b.index).map(v => v.vector);
        this.historyUserVectors = newUserVectors.sort((a, b) => a.index - b.index).map(v => v.vector);

        console.log(`[ContextVectorManager] 上下文向量映射已更新。历史AI向量: ${this.historyAssistantVectors.length}, 历史用户向量: ${this.historyUserVectors.length}`);
    }

    /**
     * 公共查询接口：获取所有历史 AI 输出的向量
     */
    getHistoryAssistantVectors() {
        return this.historyAssistantVectors;
    }

    /**
     * 公共查询接口：获取所有历史用户输入的向量
     */
    getHistoryUserVectors() {
        return this.historyUserVectors;
    }

    /**
     * 聚合多楼层向量，近期楼层权重更高 (衰减聚合)
     * @param {string} role - 'assistant' 或 'user'
     * @returns {Float32Array|null} 聚合后的向量
     */
    aggregateContext(role = 'assistant') {
        const vectors = role === 'assistant' ? this.historyAssistantVectors : this.historyUserVectors;
        if (vectors.length === 0) return null;

        const dim = vectors[0].length;
        const aggregated = new Float32Array(dim);
        let totalWeight = 0;

        // 这里的 index 越大表示越接近当前楼层
        vectors.forEach((vector, idx) => {
            // 指数衰减：越早的楼层权重越低
            // 假设当前楼层是 vectors.length
            const age = vectors.length - idx;
            const weight = Math.pow(this.decayRate, age);

            for (let i = 0; i < dim; i++) {
                aggregated[i] += vector[i] * weight;
            }
            totalWeight += weight;
        });

        if (totalWeight > 0) {
            for (let i = 0; i < dim; i++) {
                aggregated[i] /= totalWeight;
            }
        }

        return aggregated;
    }

    /**
     * 计算向量的"逻辑深度指数" L
     * 核心思想：如果向量能量集中在少数维度，说明逻辑聚焦
     *
     * @param {Array|Float32Array} vector - 向量
     * @param {number} topK - 只看前K个最大分量
     * @returns {number} L ∈ [0, 1]，越高表示逻辑越集中
     */
    computeLogicDepth(vector, topK = 64) {
        if (!vector) return 0;
        const dim = vector.length;
        const energies = new Float32Array(dim);
        let totalEnergy = 0;

        for (let i = 0; i < dim; i++) {
            energies[i] = vector[i] * vector[i];
            totalEnergy += energies[i];
        }

        if (totalEnergy < 1e-9) return 0;

        const sorted = Array.from(energies).sort((a, b) => b - a);
        let topKEnergy = 0;
        const actualTopK = Math.min(topK, dim);
        for (let i = 0; i < actualTopK; i++) {
            topKEnergy += sorted[i];
        }

        const concentration = topKEnergy / totalEnergy;
        const expectedUniform = actualTopK / dim;
        const L = (concentration - expectedUniform) / (1 - expectedUniform);

        return Math.max(0, Math.min(1, L));
    }

    /**
     * 计算语义宽度指数 S
     * 核心思想：向量的模长反映了语义的确定性/强度
     */
    computeSemanticWidth(vector) {
        if (!vector) return 0;
        let sumSq = 0;
        for (let i = 0; i < vector.length; i++) {
            sumSq += vector[i] * vector[i];
        }
        const magnitude = Math.sqrt(sumSq);
        const spreadFactor = 1.2; // 可调参数
        return magnitude * spreadFactor;
    }

    /**
     * 获取特定索引范围的向量（高级查询）
     */
    getVectorsByRange(role, start, end) {
        // 预留接口
        return [];
    }

    /**
     * 清理过期或过多的映射
     */
    cleanup(maxSize = 1000) {
        if (this.vectorMap.size > maxSize) {
            // 简单的 LRU 或全部清空
            this.vectorMap.clear();
        }
    }
}

module.exports = ContextVectorManager;