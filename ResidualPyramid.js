/**
 * ResidualPyramid.js
 * 残差金字塔模块
 * 功能：计算多层级语义残差，分析握手差值特征，检测新颖度与噪声
 */

class ResidualPyramid {
    constructor(tagIndex, db, config = {}) {
        this.tagIndex = tagIndex;
        this.db = db;
        this.config = {
            maxLevels: config.maxLevels || 3,
            topK: config.topK || 10,
            residualThreshold: config.residualThreshold || 0.3,
            dimension: config.dimension || 3072,
            ...config
        };
    }

    /**
     * 🌟 核心：计算查询向量的残差金字塔
     * @param {Float32Array|Array} queryVector - 原始查询向量
     */
    analyze(queryVector) {
        const dim = this.config.dimension;
        const pyramid = {
            levels: [],
            totalExplained: 0,      // 被Tag解释的总能量
            finalResidual: null,    // 最终残差
            features: {}            // 提取的特征
        };

        let currentVector = queryVector instanceof Float32Array ? queryVector : new Float32Array(queryVector);
        let currentMagnitude = this._magnitude(currentVector);
        const originalMagnitude = currentMagnitude;
        
        for (let level = 0; level < this.config.maxLevels; level++) {
            // 1. 搜索当前向量的最近Tags
            // ⚠️ 使用 byteOffset 和 byteLength 确保 Buffer 视图正确
            const searchBuffer = Buffer.from(currentVector.buffer, currentVector.byteOffset, currentVector.byteLength);
            let tagResults;
            try {
                tagResults = this.tagIndex.search(searchBuffer, this.config.topK);
            } catch (e) {
                console.warn(`[Residual] Search failed at level ${level}:`, e.message);
                break;
            }
            
            if (!tagResults || tagResults.length === 0) break;

            // 2. 获取Tag详细信息 (向量)
            const tagIds = tagResults.map(r => r.id);
            const tags = this._getTagVectors(tagIds);
            if (tags.length === 0) break;
            
            // 3. 🌟 计算握手差值 (Handshakes)
            const handshakes = this._computeHandshakes(currentVector, tags);
            
            // 4. 🌟 计算投影和残差
            const { projection, residual, weights } = this._computeProjectionAndResidual(
                currentVector, tags, tagResults
            );
            
            const residualMagnitude = this._magnitude(residual);
            const explainedRatio = 1 - (residualMagnitude / (currentMagnitude + 1e-12));
            
            pyramid.levels.push({
                level,
                tags: tags.map((t, i) => {
                    // 找到对应的 score
                    const res = tagResults.find(r => r.id === t.id);
                    return {
                        id: t.id,
                        name: t.name,
                        similarity: res ? res.score : 0,
                        weight: weights[i],
                        handshakeMagnitude: handshakes.magnitudes[i]
                    };
                }),
                projectionMagnitude: this._magnitude(projection),
                residualMagnitude,
                explainedRatio,
                handshakeFeatures: this._analyzeHandshakes(handshakes)
            });
            
            pyramid.totalExplained += (currentMagnitude - residualMagnitude) / originalMagnitude;
            
            // 检查是否应该继续 (残差足够小则停止)
            if (residualMagnitude < this.config.residualThreshold * originalMagnitude) {
                currentVector = residual;
                break; 
            }
            
            // 用残差作为下一级的输入
            currentVector = residual;
            currentMagnitude = residualMagnitude;
        }
        
        pyramid.finalResidual = currentVector;
        pyramid.features = this._extractPyramidFeatures(pyramid);
        
        return pyramid;
    }

    /**
     * 计算握手差值（查询与每个Tag的差向量）
     */
    _computeHandshakes(query, tags) {
        const dim = this.config.dimension;
        const n = tags.length;
        
        const magnitudes = [];    // 差向量模长
        const directions = [];    // 差向量方向（归一化）
        
        for (let i = 0; i < n; i++) {
            const tagVec = new Float32Array(tags[i].vector.buffer, tags[i].vector.byteOffset, dim);
            
            // Δ = Q - Tag
            const delta = new Float32Array(dim);
            let magSq = 0;
            for (let d = 0; d < dim; d++) {
                delta[d] = query[d] - tagVec[d];
                magSq += delta[d] * delta[d];
            }
            const mag = Math.sqrt(magSq);
            magnitudes.push(mag);
            
            // 归一化方向
            const dir = new Float32Array(dim);
            if (mag > 1e-9) {
                for (let d = 0; d < dim; d++) dir[d] = delta[d] / mag;
            }
            directions.push(dir);
        }
        
        return { magnitudes, directions };
    }

    /**
     * 分析握手差值的统计特征
     */
    _analyzeHandshakes(handshakes) {
        const n = handshakes.magnitudes.length;
        if (n === 0) return null;
        
        const dim = this.config.dimension;
        
        // 1. 差值方向的一致性 (Coherence)
        const avgDirection = new Float32Array(dim);
        for (let i = 0; i < n; i++) {
            for (let d = 0; d < dim; d++) {
                avgDirection[d] += handshakes.directions[i][d] / n;
            }
        }
        const directionCoherence = this._magnitude(avgDirection);
        
        // 2. 差值模式性 (Pattern Strength)
        let pairwiseSimilarity = 0;
        let pairCount = 0;
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                let dot = 0;
                for (let d = 0; d < dim; d++) {
                    dot += handshakes.directions[i][d] * handshakes.directions[j][d];
                }
                pairwiseSimilarity += Math.abs(dot);
                pairCount++;
            }
        }
        const avgPairwiseSim = pairCount > 0 ? pairwiseSimilarity / pairCount : 0;
        
        return {
            directionCoherence,
            patternStrength: avgPairwiseSim,
            // 🌟 关键指标
            noveltySignal: directionCoherence * (1 + avgPairwiseSim),
            noiseSignal: (1 - directionCoherence) * (1 - avgPairwiseSim)
        };
    }

    /**
     * 计算最优投影和残差
     */
    _computeProjectionAndResidual(query, tags, scores) {
        const dim = this.config.dimension;
        const n = tags.length;
        
        // 使用相似度的 softmax 作为权重 (增强对比度)
        const maxScore = Math.max(...scores.map(s => s.score));
        const expScores = scores.map(s => Math.exp((s.score - maxScore) * 5));
        const sumExp = expScores.reduce((a, b) => a + b, 0);
        const weights = expScores.map(e => e / sumExp);
        
        const projection = new Float32Array(dim);
        for (let i = 0; i < n; i++) {
            const tagVec = new Float32Array(tags[i].vector.buffer, tags[i].vector.byteOffset, dim);
            for (let d = 0; d < dim; d++) {
                projection[d] += weights[i] * tagVec[d];
            }
        }
        
        const residual = new Float32Array(dim);
        for (let d = 0; d < dim; d++) {
            residual[d] = query[d] - projection[d];
        }
        
        return { projection, residual, weights };
    }

    /**
     * 从金字塔中提取综合特征
     */
    _extractPyramidFeatures(pyramid) {
        if (pyramid.levels.length === 0) {
            return { depth: 0, coverage: 0, novelty: 1, coherence: 0, tagMemoActivation: 0 };
        }

        const level0 = pyramid.levels[0];
        const handshake = level0.handshakeFeatures;
        
        const coverage = pyramid.totalExplained;
        const novelty = handshake ? handshake.noveltySignal : 0;
        
        // 相干度：Tag 之间的语义一致性 (分数越接近，相干度越高)
        const tagScores = level0.tags.map(t => t.similarity);
        const scoreSpread = Math.max(...tagScores) - Math.min(...tagScores);
        const coherence = 1 - scoreSpread; 

        return {
            depth: pyramid.levels.length,
            coverage,
            novelty,
            coherence,
            // 🌟 综合决策指标
            tagMemoActivation: coverage * coherence * (1 - (handshake?.noiseSignal || 0)),
            expansionSignal: novelty * (1 - (handshake?.noiseSignal || 0))
        };
    }

    _getTagVectors(ids) {
        const placeholders = ids.map(() => '?').join(',');
        return this.db.prepare(`
            SELECT id, name, vector FROM tags WHERE id IN (${placeholders})
        `).all(...ids);
    }

    _magnitude(vec) {
        let sum = 0;
        for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
        return Math.sqrt(sum);
    }
}

module.exports = ResidualPyramid;