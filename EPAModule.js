/**
 * EPAModule.js
 * 嵌入投影分析模块 (Embedding Projection Analysis)
 * 功能：构建私有语义正交基底，计算向量投影、熵和逻辑深度
 */

class EPAModule {
    constructor(db, config = {}) {
        this.db = db;
        this.config = {
            maxBasisDim: config.maxBasisDim || 64,      // 最大基底维度
            minVarianceRatio: config.minVarianceRatio || 0.01, // 最小方差贡献
            clusterCount: config.clusterCount || 32,    // Tag聚类数
            dimension: config.dimension || 3072,        // 向量维度
            ...config
        };
        
        this.orthoBasis = null;      // Float32Array[], K个正交基向量
        this.basisLabels = null;     // 每个基底对应的语义标签
        this.basisEnergies = null;   // 每个基底的特征值（重要性）
        
        this.initialized = false;
    }

    /**
     * 🌟 核心：从Tag库构建正交基底
     */
    async initialize() {
        console.log('[EPA] 🧠 Initializing orthogonal basis...');
        
        try {
            // [步骤 0] 尝试从持久化缓存加载
            if (await this._loadFromCache()) {
                console.log(`[EPA] 💾 Loaded basis from persistent cache. (${this.orthoBasis.length} vectors)`);
                this.initialized = true;
                return true;
            }

            // [步骤 1] 加载所有Tag向量
            const tags = this.db.prepare(`
                SELECT id, name, vector FROM tags WHERE vector IS NOT NULL
            `).all();
            
            if (tags.length < 8) {
                console.warn('[EPA] ⚠️ Not enough tags for basis construction (min 8 required)');
                return false;
            }
            
            // 2. 构建Tag矩阵并聚类降维 (为了内存效率和语义代表性)
            const clusterData = this._clusterTags(tags, Math.min(tags.length, this.config.clusterCount));
            
            // 3. 对聚类质心做SVD分解
            // 🚀 预留 Rust 接口：如果 Vexus 引擎支持高性能 SVD，则优先调用
            let svdResult;
            if (this.config.vexusIndex && this.config.vexusIndex.computeSVD) {
                console.log('[EPA] 🦀 Using Rust-Vexus for SVD computation...');
                svdResult = await this.config.vexusIndex.computeSVD(clusterData.vectors, this.config.maxBasisDim);
            } else {
                console.log('[EPA] 🐌 Using JS Power-Iteration for SVD computation...');
                svdResult = this._computeSVD(clusterData);
            }
            
            const { U, S, labels } = svdResult;
            
            // 4. 选择主成分
            const K = this._selectBasisDimension(S);
            
            this.orthoBasis = U.slice(0, K);
            this.basisEnergies = S.slice(0, K);
            this.basisLabels = labels ? labels.slice(0, K) : clusterData.labels.slice(0, K);
            
            // [步骤 5] 持久化到数据库
            await this._saveToCache();

            console.log(`[EPA] ✅ Initialized and cached ${K} orthogonal basis vectors.`);
            this.initialized = true;
            return true;
        } catch (e) {
            console.error('[EPA] ❌ Initialization failed:', e);
            return false;
        }
    }

    /**
     * 将向量投影到正交基底
     */
    project(vector) {
        if (!this.initialized || !this.orthoBasis) {
            return { projections: null, entropy: 1, logicDepth: 0, dominantAxes: [] };
        }
        
        const vec = vector instanceof Float32Array ? vector : new Float32Array(vector);
        const K = this.orthoBasis.length;
        const dim = vec.length;
        
        const projections = new Float32Array(K);
        let totalEnergy = 0;
        
        for (let k = 0; k < K; k++) {
            let dot = 0;
            const basis = this.orthoBasis[k];
            for (let d = 0; d < dim; d++) {
                dot += vec[d] * basis[d];
            }
            projections[k] = dot;
            totalEnergy += dot * dot;
        }
        
        if (totalEnergy < 1e-12) return { projections, entropy: 1, logicDepth: 0, dominantAxes: [] };
        
        // 计算能量分布和熵
        const probabilities = new Float32Array(K);
        let entropy = 0;
        for (let k = 0; k < K; k++) {
            probabilities[k] = (projections[k] * projections[k]) / totalEnergy;
            if (probabilities[k] > 1e-12) {
                entropy -= probabilities[k] * Math.log2(probabilities[k]);
            }
        }
        
        const normalizedEntropy = entropy / Math.log2(K);
        const dominantAxes = [];
        for (let k = 0; k < K; k++) {
            if (probabilities[k] > 0.1) { // 能量占比 > 10%
                dominantAxes.push({
                    index: k,
                    label: this.basisLabels[k],
                    energy: probabilities[k],
                    projection: projections[k]
                });
            }
        }
        dominantAxes.sort((a, b) => b.energy - a.energy);
        
        return {
            projections,
            probabilities,
            entropy: normalizedEntropy,
            logicDepth: 1 - normalizedEntropy,
            dominantAxes
        };
    }

    /**
     * 检测跨域共振
     */
    detectCrossDomainResonance(vector) {
        const { dominantAxes } = this.project(vector);
        if (dominantAxes.length < 2) return { resonance: 0, bridges: [] };
        
        const bridges = [];
        for (let i = 0; i < dominantAxes.length; i++) {
            for (let j = i + 1; j < dominantAxes.length; j++) {
                const ax1 = dominantAxes[i];
                const ax2 = dominantAxes[j];
                
                // 计算基底间的余弦相似度 (理论上正交基之间相似度应接近0)
                const sim = this._basisSimilarity(ax1.index, ax2.index);
                
                if (sim < 0.3) { // 如果两个不相关的基底同时被激活
                    bridges.push({
                        from: ax1.label,
                        to: ax2.label,
                        strength: Math.sqrt(ax1.energy * ax2.energy),
                        distance: 1 - sim
                    });
                }
            }
        }
        
        const resonance = bridges.reduce((sum, b) => sum + b.strength * b.distance, 0);
        return { resonance, bridges };
    }

    // --- 内部数学辅助函数 ---

    _clusterTags(tags, k) {
        const dim = this.config.dimension;
        const vectors = tags.map(t => new Float32Array(t.vector.buffer, t.vector.byteOffset, dim));
        
        // 极简版 K-Means
        let centroids = vectors.slice(0, k).map(v => new Float32Array(v));
        for (let iter = 0; iter < 10; iter++) {
            const clusters = Array.from({ length: k }, () => []);
            vectors.forEach(v => {
                let minDist = Infinity, bestK = 0;
                centroids.forEach((c, i) => {
                    const d = this._cosineDistance(v, c);
                    if (d < minDist) { minDist = d; bestK = i; }
                });
                clusters[bestK].push(v);
            });
            
            centroids = clusters.map((cvs, i) => {
                if (cvs.length === 0) return centroids[i];
                const newC = new Float32Array(dim);
                cvs.forEach(v => v.forEach((val, d) => newC[d] += val / cvs.length));
                return newC;
            });
        }
        
        // 为质心匹配标签
        const labels = centroids.map(c => {
            let minDist = Infinity, closest = 'Unknown';
            vectors.forEach((v, i) => {
                const d = this._cosineDistance(c, v);
                if (d < minDist) { minDist = d; closest = tags[i].name; }
            });
            return closest;
        });
        
        return { vectors: centroids, labels };
    }

    /**
     * 持久化基底到 SQLite
     */
    async _saveToCache() {
        try {
            const data = {
                basis: this.orthoBasis.map(b => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64')),
                energies: Array.from(this.basisEnergies),
                labels: this.basisLabels,
                timestamp: Date.now(),
                tagCount: this.db.prepare("SELECT COUNT(*) as count FROM tags").get().count
            };
            this.db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)").run('epa_basis_cache', JSON.stringify(data));
        } catch (e) {
            console.error('[EPA] Failed to save cache:', e);
        }
    }

    /**
     * 从 SQLite 加载基底
     */
    async _loadFromCache() {
        try {
            const row = this.db.prepare("SELECT value FROM kv_store WHERE key = ?").get('epa_basis_cache');
            if (!row) return false;
            
            const data = JSON.parse(row.value);
            const currentTagCount = this.db.prepare("SELECT COUNT(*) as count FROM tags").get().count;
            
            // 如果 Tag 数量变化超过 10%，则认为缓存失效，需要重算
            if (Math.abs(data.tagCount - currentTagCount) > currentTagCount * 0.1) {
                console.log('[EPA] 🔄 Tag library changed significantly, invalidating cache.');
                return false;
            }

            this.orthoBasis = data.basis.map(b64 => {
                const buf = Buffer.from(b64, 'base64');
                return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
            });
            this.basisEnergies = new Float32Array(data.energies);
            this.basisLabels = data.labels;
            return true;
        } catch (e) {
            console.error('[EPA] Failed to load cache:', e);
            return false;
        }
    }

    _computeSVD(clusterData) {
        const { vectors, labels } = clusterData;
        const n = vectors.length;
        const dim = this.config.dimension;
        
        // 构建 Gram 矩阵 (n x n)
        const gram = new Float32Array(n * n);
        for (let i = 0; i < n; i++) {
            for (let j = i; j < n; j++) {
                let dot = 0;
                for (let d = 0; d < dim; d++) dot += vectors[i][d] * vectors[j][d];
                gram[i * n + j] = gram[j * n + i] = dot;
            }
        }
        
        const eigenvectors = [];
        const eigenvalues = [];
        const gramCopy = new Float32Array(gram);
        
        for (let k = 0; k < Math.min(n, this.config.maxBasisDim); k++) {
            const { vector: v, value } = this._powerIteration(gramCopy, n);
            if (value < 1e-6) break;
            eigenvectors.push(v);
            eigenvalues.push(value);
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) gramCopy[i * n + j] -= value * v[i] * v[j];
            }
        }
        
        const U = eigenvectors.map(v => {
            const basis = new Float32Array(dim);
            for (let i = 0; i < n; i++) {
                for (let d = 0; d < dim; d++) basis[d] += v[i] * vectors[i][d];
            }
            let mag = Math.sqrt(basis.reduce((sum, val) => sum + val * val, 0));
            if (mag > 1e-9) basis.forEach((val, d) => basis[d] /= mag);
            return basis;
        });
        
        return { U, S: eigenvalues, labels };
    }

    _powerIteration(matrix, n) {
        let v = new Float32Array(n).map(() => Math.random() - 0.5);
        let mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
        v = v.map(x => x / mag);
        
        let lastVal = 0;
        for (let i = 0; i < 30; i++) {
            const w = new Float32Array(n);
            for (let r = 0; r < n; r++) {
                for (let c = 0; c < n; c++) w[r] += matrix[r * n + c] * v[c];
            }
            const val = v.reduce((s, x, idx) => s + x * w[idx], 0);
            mag = Math.sqrt(w.reduce((s, x) => s + x * x, 0));
            if (mag < 1e-9) break;
            v = w.map(x => x / mag);
            if (Math.abs(val - lastVal) < 1e-7) break;
            lastVal = val;
        }
        return { vector: v, value: lastVal };
    }

    _selectBasisDimension(S) {
        const total = S.reduce((a, b) => a + b, 0);
        let cum = 0;
        for (let i = 0; i < S.length; i++) {
            cum += S[i];
            if (cum / total > 0.9) return Math.max(i + 1, 8);
        }
        return S.length;
    }

    _cosineDistance(v1, v2) {
        let dot = 0, m1 = 0, m2 = 0;
        for (let i = 0; i < v1.length; i++) {
            dot += v1[i] * v2[i];
            m1 += v1[i] * v1[i];
            m2 += v2[i] * v2[i];
        }
        return 1 - (dot / (Math.sqrt(m1) * Math.sqrt(m2) + 1e-12));
    }

    _basisSimilarity(i, j) {
        const b1 = this.orthoBasis[i], b2 = this.orthoBasis[j];
        let dot = 0;
        for (let d = 0; d < b1.length; d++) dot += b1[d] * b2[d];
        return Math.abs(dot);
    }
}

module.exports = EPAModule;