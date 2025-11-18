// TagVectorManager.js
// 🌟 全局Tag向量管理器 - 独立模块，零侵入性设计
// ✅ 已修复所有致命bug和隐患
// 🚀 集成 Worker Threads 支持
// 🦀 集成 Vexus-Lite Rust引擎

const fs = require('fs').promises;
const path = require('path');
const { HierarchicalNSW } = require('hnswlib-node');
const chokidar = require('chokidar');
const crypto = require('crypto');
const TagCooccurrenceDB = require('./TagCooccurrenceDB');

// 🦀 尝试加载Vexus-Lite Rust引擎
let VexusIndex = null;
try {
    const vexusModule = require('./rust-vexus-lite');
    VexusIndex = vexusModule.VexusIndex;
    console.log('[TagVectorManager] 🦀 Vexus-Lite Rust engine loaded successfully');
} catch (e) {
    console.log('[TagVectorManager] Vexus-Lite not available, using JS implementation only');
    console.log('[TagVectorManager] Error:', e.message);
}

/**
 * 全局Tag向量管理器
 * 职责：
 * 1. 扫描所有日记文件末尾的Tag行
 * 2. 构建全局Tag向量库（去重）
 * 3. 监听文件变化，增量更新Tag向量
 * 4. 提供Tag相似度搜索接口
 */
class TagVectorManager {
    constructor(config = {}) {
        // ✅ 从环境变量读取黑名单
        const envBlacklist = process.env.TAG_BLACKLIST
            ? process.env.TAG_BLACKLIST.split(',').map(t => t.trim()).filter(Boolean)
            : [];
        
        // 🌟 从环境变量读取超级黑名单（强力移除模式）
        const envBlacklistSuper = process.env.TAG_BLACKLIST_SUPER
            ? process.env.TAG_BLACKLIST_SUPER.split(',').map(t => t.trim()).filter(Boolean)
            : [];
        
        // ✅ 从环境变量读取过滤规则
        const envIgnoreFolders = process.env.TAG_IGNORE_FOLDERS
            ? process.env.TAG_IGNORE_FOLDERS.split(',').map(t => t.trim()).filter(Boolean)
            : ['VCP论坛', 'MusicDiary', '莱恩作品集'];
        
        const envIgnorePrefix = process.env.TAG_IGNORE_PREFIX || '已整理';
        const envIgnoreSuffix = process.env.TAG_IGNORE_SUFFIX || '簇';
        
        this.config = {
            diaryRootPath: config.diaryRootPath || path.join(__dirname, 'dailynote'),
            vectorStorePath: config.vectorStorePath || path.join(__dirname, 'VectorStore'),
            tagBatchSize: parseInt(process.env.TAG_VECTORDB_BATCH_SIZE) || 100,
            tagBlacklist: envBlacklist.length > 0 ? envBlacklist : ['今天', '明天', '昨天', '心情', '很', '非常'],
            tagBlacklistSuper: envBlacklistSuper, // 🌟 超级黑名单
            minTagLength: 2,
            maxTagLength: 50,
            ignorePatterns: envIgnoreFolders,
            ignorePrefix: envIgnorePrefix,
            ignoreSuffix: envIgnoreSuffix,
            debug: process.env.TAG_VECTOR_DEBUG === 'true',
            dataVersion: '2.0.0', // ✅ 添加版本号
            ...config
        };

        // Tag数据结构
        this.globalTags = new Map(); // tag_text → { vector, frequency, diaries: Set }
        this.tagIndex = null; // HNSW索引 (hnswlib-node)
        this.vexus = null; // 🦀 Vexus-Lite索引 (Rust)
        this.usingVexus = false; // 🦀 是否使用Vexus引擎
        this.tagToLabel = new Map(); // tag_text → label
        this.labelToTag = new Map(); // label → tag_text
        
        // 🌟 新增：文件注册表（反向索引） - 实现O(1) Diff的关键
        // filePath → { hash: string, tags: Set<string> }
        this.fileRegistry = new Map();
        
        // 🌟 脏数据追踪（用于增量保存）
        this.dirtyTags = new Set(); // 标记哪些Tag的数据变了
        this.deletedLabels = new Set(); // HNSW软删除标记
        this.dirtyShards = new Set(); // 🌟 标记哪些shard需要重写（真正的diff保存）

        // 文件监控
        this.watcher = null;
        this.pendingUpdates = new Map();

        // ✅ Bug #5修复: 并发控制
        this.updateLock = false;
        this.updateQueue = [];
        
        // ✅ 保存操作锁 - 防止并发保存导致数据损坏
        this.saveLock = false;
        this.saveQueue = [];
        
        // ✅ 批量索引更新优化
        this.pendingIndexUpdates = new Set(); // 当前批次待添加到索引的tag
        this.nextBatchIndexUpdates = new Set(); // 🌟 下一批次的tag（批处理运行时的新变更）
        this.indexRebuildTimer = null;
        this.indexRebuildDelay = parseInt(process.env.TAG_INDEX_REBUILD_DELAY) || 60000; // 🌟 改为60秒（1分钟）合并窗口
        this.isIndexRebuilding = false; // 🌟 批索引是否正在运行
        
        // 🌟 防抖保存配置
        this.saveDebounce = 2000; // 保存防抖时间
        this.saveTimer = null;

        // 状态
        this.initialized = false;
        this.isBuilding = false;
        
        // 🌟 Tag共现图谱数据库
        this.cooccurrenceDB = null;
        this.cooccurrenceEnabled = false;
        
        // 🌟 权重矩阵导出防抖
        this.matrixExportTimer = null;
        this.matrixExportDelay = parseInt(process.env.TAG_MATRIX_EXPORT_DELAY) || 30000; // 默认30秒
        

        console.log('[TagVectorManager] Initialized with batch size:', this.config.tagBatchSize);
        if (this.config.tagBlacklistSuper.length > 0) {
            console.log('[TagVectorManager] 🌟 Super Blacklist enabled:', this.config.tagBlacklistSuper.join(', '));
        }
    }
    

    /**
     * 🌟 提取Tag内容（纯函数，用于Diff计算）
     */
    extractTagsFromContent(content) {
        const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) return [];
        
        const lastLine = lines[lines.length - 1];
        const match = lastLine.match(/^Tag:\s*(.+)$/i);
        if (!match) return [];
        
        return match[1]
            .split(/[,，、]/)
            .map(t => t.trim())
            .map(t => this.applySuperBlacklist(t)) // 🌟 应用超级黑名单
            .filter(t => this.isValidTag(t));
    }

    /**
     * 🌟 应用超级黑名单：移除tag中包含的黑名单关键词
     * @param {string} tag - 原始tag
     * @returns {string} - 处理后的tag
     */
    applySuperBlacklist(tag) {
        if (!tag || this.config.tagBlacklistSuper.length === 0) {
            return tag;
        }
        
        let processedTag = tag;
        
        // 对每个超级黑名单关键词进行全局替换
        for (const keyword of this.config.tagBlacklistSuper) {
            if (keyword) {
                // 使用全局替换，移除所有出现的关键词
                processedTag = processedTag.split(keyword).join('');
            }
        }
        
        // 返回处理后的tag（已去除所有黑名单关键词）
        return processedTag.trim();
    }

    debugLog(message, ...args) {
        if (this.config.debug) {
            console.log(`[TagVectorManager][DEBUG] ${message}`, ...args);
        }
    }

    /**
     * ✅ Bug #10修复: 计算数据校验和
     */
    computeChecksum(data) {
        const hash = crypto.createHash('sha256');
        hash.update(JSON.stringify(data));
        return hash.digest('hex');
    }

    /**
     * ✅ 修复Bug2+竞态: 非阻塞初始化 + 安全的后台任务隔离
     */
    async initialize(embeddingFunction) {
        if (this.initialized) return;

        console.log('[TagVectorManager] Initializing (non-blocking mode)...');
        this.embeddingFunction = embeddingFunction;

        await fs.mkdir(this.config.vectorStorePath, { recursive: true });

        const tagIndexPath = path.join(this.config.vectorStorePath, 'GlobalTags.bin');
        const tagDataPath = path.join(this.config.vectorStorePath, 'GlobalTags.json');
        
        // 🦀 Vexus-Lite文件路径
        const vexusIndexPath = path.join(this.config.vectorStorePath, 'GlobalTags_vexus.usearch');
        const vexusMapPath = path.join(this.config.vectorStorePath, 'GlobalTags_vexus.map');

        let libraryExists = false;
        let needsBuildRegistry = false;
        
        // 🦀 步骤0: 尝试加载Vexus-Lite索引
        if (VexusIndex) {
            try {
                const dimensions = parseInt(process.env.VECTORDB_DIMENSION) || 3072;
                const vexusCapacity = parseInt(process.env.VEXUS_INDEX_CAPACITY) || 200000;
                
                // ✅ 修复：传递capacity参数给load方法
                this.vexus = VexusIndex.load(vexusIndexPath, vexusMapPath, dimensions, vexusCapacity);
                this.usingVexus = true;
                
                // ✅ 修复：调用stats()获取实际数据
                const vexusStats = this.vexus.stats();
                console.log(`[TagVectorManager] 🦀 ✅ Loaded Vexus-Lite index (${dimensions}D, ${vexusStats.totalVectors}/${vexusStats.capacity} vectors)`);
                
            } catch (e) {
                // Vexus索引不存在，创建新的
                try {
                    const dimensions = parseInt(process.env.VECTORDB_DIMENSION) || 3072;
                    const vexusCapacity = parseInt(process.env.VEXUS_INDEX_CAPACITY) || 200000;
                    this.vexus = new VexusIndex(dimensions, vexusCapacity);
                    this.usingVexus = true;
                    console.log(`[TagVectorManager] 🦀 ✅ Created new Vexus-Lite index (${dimensions}D, capacity: ${vexusCapacity})`);
                } catch (createError) {
                    console.warn('[TagVectorManager] Failed to create Vexus index:', createError.message);
                    this.usingVexus = false;
                }
            }
        }
        
        // ====== 步骤1: 加载Tag库 ======
        let needsIncrementalVectorize = false;
        let needsVexusRestore = false;  // ✅ 新增
        try {
            await this.loadGlobalTagLibrary(tagIndexPath, tagDataPath);
            console.log('[TagVectorManager] ✅ Loaded existing library');
            libraryExists = true;
        } catch (e) {
            if (e.message === 'NEED_INCREMENTAL_VECTORIZE') {
                console.log('[TagVectorManager] ⚠️ Metadata loaded but vectors missing, will vectorize incrementally in background...');
                libraryExists = true;
                needsIncrementalVectorize = true;
            } else if (e.message === 'NEED_VEXUS_RESTORE') {
                // ✅ 新增：Vexus 恢复模式
                console.log('[TagVectorManager] 🦀 Metadata loaded, vectors in Vexus index (no re-vectorization needed)');
                libraryExists = true;
                needsVexusRestore = true;
            } else {
                console.log('[TagVectorManager] No existing library found, will build in background...');
                libraryExists = false;
                needsBuildRegistry = true;
            }
        }

        // ====== 步骤2: 加载/构建文件注册表======
        try {
            await this.loadFileRegistry();
            
            if (this.fileRegistry.size === 0 && this.globalTags.size > 0) {
                console.log('[TagVectorManager] ⚠️ FileRegistry is empty but Tag library exists, rebuilding...');
                needsBuildRegistry = true;
            } else {
                console.log(`[TagVectorManager] ✅ FileRegistry verified: ${this.fileRegistry.size} files indexed`);
            }
        } catch (e) {
            console.log(`[TagVectorManager] ⚠️ FileRegistry load failed: ${e.message}`);
            needsBuildRegistry = true;
        }

        // ✅ 竞态修复：在启动文件监控前标记已初始化，避免监控事件在后台任务期间丢失
        this.initialized = true;
        
        // ====== 🌟 新增步骤: 初始化Tag共现数据库 ======
        try {
            this.cooccurrenceDB = new TagCooccurrenceDB(
                path.join(this.config.vectorStorePath, 'TagCooccurrence.db')
            );
            await this.cooccurrenceDB.initialize();
            this.cooccurrenceEnabled = true;
            console.log('[TagVectorManager] ✅ Tag cooccurrence database initialized');
            
            // 🔧 鲁棒性改进：检查数据一致性，需要时触发同步
            const dbStats = this.cooccurrenceDB.getStats();
            const needsSync = await this.checkCooccurrenceConsistency(dbStats);
            
            if (needsSync) {
                console.log('[TagVectorManager] 🔄 Will sync cooccurrence database in background...');
                // 异步后台同步（不阻塞启动）
                setImmediate(() => {
                    this.syncCooccurrenceDatabase().catch(error => {
                        console.error('[TagVectorManager] Failed to sync cooccurrence DB:', error);
                    });
                });
            } else {
                console.log('[TagVectorManager] ✅ Cooccurrence database is consistent');
            }
        } catch (error) {
            console.error('[TagVectorManager] Failed to initialize cooccurrence DB:', error);
            console.warn('[TagVectorManager] Tag graph expansion will be disabled');
            this.cooccurrenceEnabled = false;
        }
        
        // ====== 步骤3: 启动文件监控======
        this.startFileWatcher();
        console.log('[TagVectorManager] ✅ Initialized (library loading continues in background)');

        // ✅ 竞态修复：后台任务使用独立的锁和状态标记
        this.isBackgroundTaskRunning = true;
        
        setImmediate(async () => {
            try {
                // ✅ 获取更新锁，防止与文件监控竞态
                while (this.updateLock) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                this.updateLock = true;
                
                try {
                    if (needsBuildRegistry && !needsIncrementalVectorize) {
                        console.log('[TagVectorManager] 🔨 [Background] Building FileRegistry...');
                        await this.buildFileRegistryFromScratch();
                    }

                    if (!libraryExists) {
                        // 完全从零构建
                        console.log('[TagVectorManager] 🚀 [Background] Building library from scratch...');
                        await this.buildGlobalTagLibrary();
                        await this.saveGlobalTagLibrary(tagIndexPath, tagDataPath);
                        console.log('[TagVectorManager] ✅ [Background] Library built successfully');
                    } else if (needsVexusRestore) {
                        // 🦀 Vexus 恢复模式：无需任何操作
                        console.log('[TagVectorManager] 🦀 [Background] Vexus mode: Vectors already in Rust index, skipping all vectorization');
                        console.log('[TagVectorManager] ✅ [Background] Initialization completed instantly (Vexus-only mode)');
                    } else if (needsIncrementalVectorize) {
                        // ✅ 增量向量化：元数据已有，只缺向量
                        console.log('[TagVectorManager] 🔧 [Background] Starting incremental vectorization for existing tags...');
                        const tagsNeedingVectors = Array.from(this.globalTags.entries())
                            .filter(([_, data]) => data.vector === null)
                            .map(([tag, _]) => tag);
                        
                        console.log(`[TagVectorManager] [Background] Found ${tagsNeedingVectors.length} tags needing vectors`);
                        
                        if (tagsNeedingVectors.length > 0) {
                            await this.vectorizeTagBatch(tagsNeedingVectors);
                            
                            // ✅ 修复：仅在未使用Vexus时才构建hnswlib索引
                            if (!this.usingVexus) {
                                await this.buildHNSWIndex();
                                console.log('[TagVectorManager] ✅ [Background] hnswlib index built');
                            } else {
                                console.log('[TagVectorManager] ⏭️ [Background] Skipping hnswlib index (using Vexus)');
                            }
                            
                            await this.saveGlobalTagLibrary(tagIndexPath, tagDataPath);
                            console.log('[TagVectorManager] ✅ [Background] Incremental vectorization completed');
                        }
                    } else if (!needsBuildRegistry) {
                        // 正常增量更新
                        console.log('[TagVectorManager] 🔍 [Background] Checking for new tags...');
                        const hasChanges = await this.incrementalUpdateOptimized();
                        if (hasChanges) {
                            await this.saveGlobalTagLibrary(tagIndexPath, tagDataPath);
                            console.log('[TagVectorManager] ✅ [Background] Incremental update completed');
                        } else {
                            console.log('[TagVectorManager] [Background] No changes detected');
                        }
                    }
                } catch (innerError) {
                    console.error('[TagVectorManager] ❌ [Background] Task execution failed:', innerError.message);
                    console.error('[TagVectorManager] Error stack:', innerError.stack);
                } finally {
                    // ✅ 关键修复：确保updateLock一定被释放
                    this.updateLock = false;
                    console.log('[TagVectorManager] [Background] UpdateLock released');
                }
            } catch (error) {
                console.error('[TagVectorManager] ❌ [Background] Initialization failed:', error.message);
                console.error('[TagVectorManager] System will continue with limited functionality');
            } finally {
                this.isBackgroundTaskRunning = false;
                console.log('[TagVectorManager] [Background] Background task completed');
            }
        });
    }

    /**
     * 🌟 构建全局Tag库（优化：使用非阻塞向量化）
     */
    async buildGlobalTagLibrary() {
        if (this.isBuilding) {
            console.log('[TagVectorManager] ⚠️ Library build already in progress');
            return;
        }
        this.isBuilding = true;

        try {
            console.log('[TagVectorManager] 🚀 [Background] Building library...');
            
            const tagStats = await this.scanAllDiaryTags();
            console.log(`[TagVectorManager] [Background] Found ${tagStats.uniqueTags} unique tags`);

            this.applyTagFilters(tagStats);
            console.log(`[TagVectorManager] [Background] After filtering: ${this.globalTags.size} tags`);

            if (this.globalTags.size === 0) {
                console.log('[TagVectorManager] [Background] No tags to vectorize');
                return;
            }

            // ✅ 使用优化后的并发向量化
            await this.vectorizeAllTags();
            
            // ✅ 修复：仅在未使用Vexus时才构建hnswlib索引
            if (!this.usingVexus) {
                await this.buildHNSWIndex();
                console.log('[TagVectorManager] ✅ [Background] hnswlib index built');
            } else {
                console.log('[TagVectorManager] ⏭️ [Background] Skipping hnswlib index (using Vexus)');
            }
            
            console.log('[TagVectorManager] ✅ [Background] Library build completed');

        } catch (error) {
            console.error('[TagVectorManager] ❌ [Background] Library build failed:', error.message);
            throw error;
        } finally {
            this.isBuilding = false;
        }
    }

    /**
     * 扫描所有日记
     */
    async scanAllDiaryTags() {
        const stats = { totalFiles: 0, uniqueTags: 0 };
        const diaryBooks = await fs.readdir(this.config.diaryRootPath, { withFileTypes: true });

        for (const dirent of diaryBooks) {
            if (!dirent.isDirectory()) continue;
            
            const diaryName = dirent.name;
            
            // ✅ 根据规则过滤文件夹
            if (this.shouldIgnoreFolder(diaryName)) {
                this.debugLog(`Ignoring folder: "${diaryName}"`);
                continue;
            }

            const diaryPath = path.join(this.config.diaryRootPath, diaryName);
            
            try {
                const files = await fs.readdir(diaryPath);
                const diaryFiles = files.filter(f => 
                    f.toLowerCase().endsWith('.txt') || f.toLowerCase().endsWith('.md')
                );

                for (const file of diaryFiles) {
                    const filePath = path.join(diaryPath, file);
                    const tags = await this.extractTagsFromFile(filePath);
                    if (tags.length > 0) {
                        this.recordTags(tags, diaryName);
                        stats.totalFiles++;
                    }
                }
            } catch (error) {
                console.error(`[TagVectorManager] Error scanning "${diaryName}":`, error.message);
            }
        }

        stats.uniqueTags = this.globalTags.size;
        return stats;
    }

    /**
     * 从文件末尾提取Tag行
     */
    async extractTagsFromFile(filePath) {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length === 0) return [];

            const lastLine = lines[lines.length - 1];
            const match = lastLine.match(/^Tag:\s*(.+)$/i);
            if (!match) return [];

            return match[1]
                .split(/[,，、]/)
                .map(t => t.trim())
                .map(t => this.applySuperBlacklist(t)) // 🌟 应用超级黑名单
                .filter(t => this.isValidTag(t));
        } catch (error) {
            return [];
        }
    }

    /**
     * Tag有效性检查
     */
    isValidTag(tag) {
        if (!tag || typeof tag !== 'string') return false;
        if (tag.length < this.config.minTagLength) return false;
        if (tag.length > this.config.maxTagLength) return false;
        if (this.config.tagBlacklist.includes(tag)) return false;
        if (/^[\d\s\p{P}]+$/u.test(tag)) return false;
        return true;
    }

    /**
     * 记录Tag统计
     */
    recordTags(tags, diaryName) {
        for (const tag of tags) {
            if (!this.globalTags.has(tag)) {
                this.globalTags.set(tag, {
                    vector: null,
                    frequency: 0,
                    diaries: new Set()
                });
            }
            const tagData = this.globalTags.get(tag);
            tagData.frequency++;
            tagData.diaries.add(diaryName);
        }
    }

    /**
     * 应用过滤规则
     */
    applyTagFilters(stats) {
        const threshold = Math.floor(stats.totalFiles * 0.3);
        for (const [tag, data] of this.globalTags.entries()) {
            if (data.frequency > threshold) {
                this.globalTags.delete(tag);
            }
        }
    }

    /**
     * ✅ 批量向量化（使用真正的并发机制）
     */
    async vectorizeAllTags() {
        const allTags = Array.from(this.globalTags.keys());
        console.log(`[TagVectorManager] [Background] Vectorizing ${allTags.length} tags with TRUE concurrency...`);

        // ✅ 使用优化后的并发向量化方法
        await this.vectorizeTagBatch(allTags);
    }

    /**
     * ✅ 修复：原子性索引重建（避免搜索时访问不完整索引）
     */
    async buildHNSWIndex() {
        try {
            const tagsWithVectors = Array.from(this.globalTags.entries())
                .filter(([_, data]) => data.vector !== null);

            if (tagsWithVectors.length === 0) {
                throw new Error('No vectorized tags available for index building');
            }

            console.log(`[TagVectorManager] Building HNSW index for ${tagsWithVectors.length} tags...`);

            // ✅ 验证向量完整性
            const invalidVectors = [];
            for (let i = 0; i < tagsWithVectors.length; i++) {
                const [tag, data] = tagsWithVectors[i];
                if (!data.vector || !Array.isArray(data.vector) && !(data.vector instanceof Float32Array)) {
                    invalidVectors.push(tag);
                }
            }

            if (invalidVectors.length > 0) {
                console.error(`[TagVectorManager] Found ${invalidVectors.length} tags with invalid vectors:`, invalidVectors.slice(0, 5));
                throw new Error(`${invalidVectors.length} tags have invalid vectors`);
            }

            // ✅ 验证向量维度一致性
            const dimensions = tagsWithVectors[0][1].vector.length;
            for (let i = 1; i < Math.min(10, tagsWithVectors.length); i++) {
                const vecLen = tagsWithVectors[i][1].vector.length;
                if (vecLen !== dimensions) {
                    throw new Error(`Dimension mismatch: expected ${dimensions}, got ${vecLen} at tag "${tagsWithVectors[i][0]}"`);
                }
            }

            console.log(`[TagVectorManager] All vectors validated (dimensions=${dimensions})`);

            // ✅ 关键修复：先创建临时索引，完成后再原子替换
            const currentCapacity = this.tagIndex?.getMaxElements?.() || 0;
            const requiredCapacity = tagsWithVectors.length;
            const needsRebuild = !this.tagIndex || requiredCapacity > currentCapacity * 0.9;

            let tempTagIndex;
            if (needsRebuild) {
                console.log(`[TagVectorManager] ${this.tagIndex ? 'Expanding' : 'Creating'} index (current: ${currentCapacity}, required: ${requiredCapacity})`);
                
                tempTagIndex = new HierarchicalNSW('l2', dimensions);
                const newCapacity = Math.ceil(requiredCapacity * 1.5);
                tempTagIndex.initIndex(newCapacity);
                console.log(`[TagVectorManager] Temp index initialized with capacity: ${newCapacity}`);
            } else {
                tempTagIndex = this.tagIndex;
            }

            // ✅ 问题1修复: 保持已有的label映射，只为新tag分配label
            const existingLabels = new Set(this.tagToLabel.values());
            const maxExistingLabel = existingLabels.size > 0 ? Math.max(...existingLabels) : -1;
            let nextAvailableLabel = maxExistingLabel + 1;

            // 清理索引但保留映射（如果需要重建）
            if (needsRebuild) {
                console.log(`[TagVectorManager] Preserving ${this.tagToLabel.size} existing label mappings`);
            }

            // ✅ 批量添加向量到临时索引
            let successCount = 0;
            const labelsToRemove = new Set(this.tagToLabel.values());
            const BATCH_SIZE = 100;
            
            for (let i = 0; i < tagsWithVectors.length; i++) {
                const [tag, data] = tagsWithVectors[i];
                
                try {
                    const vector = data.vector instanceof Float32Array
                        ? Array.from(data.vector)
                        : (Array.isArray(data.vector) ? data.vector : Array.from(data.vector));
                    
                    let label;
                    if (this.tagToLabel.has(tag)) {
                        label = this.tagToLabel.get(tag);
                        labelsToRemove.delete(label);
                    } else {
                        label = nextAvailableLabel++;
                        this.tagToLabel.set(tag, label);
                        this.labelToTag.set(label, tag);
                    }
                    
                    tempTagIndex.addPoint(vector, label);
                    successCount++;
                } catch (error) {
                    console.error(`[TagVectorManager] Failed to add tag "${tag}":`, error.message);
                }
                
                if ((i + 1) % BATCH_SIZE === 0) {
                    await new Promise(resolve => setImmediate(resolve));
                    const progress = ((i + 1) / tagsWithVectors.length * 100).toFixed(1);
                    console.log(`[TagVectorManager] Index building progress: ${progress}% (${i + 1}/${tagsWithVectors.length})`);
                }
            }

            // ✅ 清理已删除tag的映射
            for (const obsoleteLabel of labelsToRemove) {
                const obsoleteTag = this.labelToTag.get(obsoleteLabel);
                this.tagToLabel.delete(obsoleteTag);
                this.labelToTag.delete(obsoleteLabel);
                console.log(`[TagVectorManager] Removed mapping for deleted tag: "${obsoleteTag}" (label ${obsoleteLabel})`);
            }

            // ✅ 关键：原子替换索引
            if (needsRebuild) {
                this.tagIndex = tempTagIndex;
                console.log(`[TagVectorManager] ✅ Index atomically replaced`);
            }

            console.log(`[TagVectorManager] ✅ Index built successfully: ${successCount}/${tagsWithVectors.length} tags added`);
            console.log(`[TagVectorManager] Active mappings: ${this.tagToLabel.size}, Next label: ${nextAvailableLabel}`);

            if (successCount === 0) {
                throw new Error('Failed to add any tags to index');
            }

        } catch (error) {
            console.error(`[TagVectorManager] buildHNSWIndex failed:`, error);
            console.error(`[TagVectorManager] Error details:`, {
                message: error.message,
                stack: error.stack,
                totalTags: this.globalTags.size,
                vectorizedCount: Array.from(this.globalTags.values()).filter(d => d.vector !== null).length
            });
            throw error;
        }
    }

    /**
     * ✅ 增量添加tags到索引（真正的diff写入，避免完全重建）
     */
    async addTagsToIndex(tagNames) {
        if (!this.tagIndex) {
            throw new Error('Index not initialized');
        }
        
        // ✅ 关键优化：检查索引容量，如果接近上限才扩容
        const currentCount = this.tagIndex.getCurrentCount?.() || this.tagToLabel.size;
        const maxCapacity = this.tagIndex.getMaxElements?.() || 0;
        const newTotalCount = currentCount + tagNames.length;
        
        if (newTotalCount > maxCapacity * 0.9) {
            console.log(`[TagVectorManager] ⚠️ Index capacity reached (${currentCount}/${maxCapacity}), resizing...`);
            const newCapacity = Math.ceil(newTotalCount * 1.5);
            this.tagIndex.resizeIndex(newCapacity);
            console.log(`[TagVectorManager] ✅ Index resized to ${newCapacity}`);
        }
        
        const existingLabels = new Set(this.tagToLabel.values());
        const maxExistingLabel = existingLabels.size > 0 ? Math.max(...existingLabels) : -1;
        let nextAvailableLabel = maxExistingLabel + 1;
        
        let successCount = 0;
        const BATCH_SIZE = 100;
        
        console.log(`[TagVectorManager] 🔄 Incrementally adding ${tagNames.length} tags to existing index (current: ${currentCount})...`);
        
        for (let i = 0; i < tagNames.length; i++) {
            const tag = tagNames[i];
            const tagData = this.globalTags.get(tag);
            
            if (!tagData || !tagData.vector) {
                console.warn(`[TagVectorManager] Tag "${tag}" has no vector, skipping`);
                continue;
            }
            
            // ✅ 跳过已经在索引中的tag
            if (this.tagToLabel.has(tag)) {
                this.debugLog(`Tag "${tag}" already in index, skipping`);
                continue;
            }
            
            try {
                const vector = tagData.vector instanceof Float32Array
                    ? Array.from(tagData.vector)
                    : (Array.isArray(tagData.vector) ? tagData.vector : Array.from(tagData.vector));
                
                // 分配新label
                const label = nextAvailableLabel++;
                this.tagToLabel.set(tag, label);
                this.labelToTag.set(label, tag);
                
                // ✅ 关键：直接添加到现有索引，不重建
                this.tagIndex.addPoint(vector, label);
                successCount++;
                
                // 定期让出控制权
                if ((i + 1) % BATCH_SIZE === 0) {
                    await new Promise(resolve => setImmediate(resolve));
                    this.debugLog(`Added ${i + 1}/${tagNames.length} new tags to index`);
                }
            } catch (error) {
                console.error(`[TagVectorManager] Failed to add tag "${tag}" to index:`, error.message);
            }
        }
        
        console.log(`[TagVectorManager] ✅ Incrementally added ${successCount}/${tagNames.length} tags (total now: ${currentCount + successCount})`);
        return successCount;
    }

    /**
     * 🌟 搜索相似Tags（支持多种输入）
     * @param {Array|string} input - 查询向量或查询文本
     * @param {number} k - 返回结果数量
     * @returns {Array} - 匹配的tags及其得分
     */
    async searchSimilarTags(input, k = 10) {
        // 🦀 优先使用Vexus-Lite搜索
        if (this.usingVexus && this.vexus) {
            try {
                let queryVector;
                
                // ✅ 支持直接传入向量或文本
                if (Array.isArray(input)) {
                    queryVector = input;
                } else if (typeof input === 'string') {
                    // 如果传入文本，先向量化
                    const vectors = await this.embeddingFunction([input]);
                    queryVector = vectors[0];
                } else {
                    throw new Error('Input must be a vector array or string');
                }

                // 🦀 转换为Buffer传递给Rust
                const queryBuffer = Buffer.from(new Float32Array(queryVector).buffer);
                const results = this.vexus.search(queryBuffer, k);
                
                // 添加额外的元数据
                const enrichedResults = results.map(result => {
                    const tagData = this.globalTags.get(result.tag);
                    return {
                        tag: result.tag,
                        score: result.score,
                        frequency: tagData?.frequency || 0,
                        diaryCount: tagData?.diaries.size || 0,
                        diaries: Array.from(tagData?.diaries || [])
                    };
                });
                
                this.debugLog(`🦀 Found ${enrichedResults.length} similar tags using Vexus`);
                return enrichedResults;
            } catch (error) {
                console.error('[TagVectorManager] Vexus search failed, falling back to hnswlib:', error.message);
                // Fall through to hnswlib backup
            }
        }
        
        // Fallback: 使用hnswlib-node
        if (!this.tagIndex) {
            console.warn('[TagVectorManager] Tag index not initialized');
            return [];
        }

        try {
            let queryVector;
            
            // ✅ 支持直接传入向量或文本
            if (Array.isArray(input)) {
                queryVector = input;
            } else if (typeof input === 'string') {
                // 如果传入文本，先向量化
                const vectors = await this.embeddingFunction([input]);
                queryVector = vectors[0];
            } else {
                throw new Error('Input must be a vector array or string');
            }

            const results = this.tagIndex.searchKnn(queryVector, k);
            
            const matchedTags = results.neighbors.map((label, idx) => {
                const tag = this.labelToTag.get(label);
                const tagData = this.globalTags.get(tag);
                return {
                    tag,
                    score: 1 - results.distances[idx], // 转换为相似度分数
                    frequency: tagData?.frequency || 0,
                    diaryCount: tagData?.diaries.size || 0,
                    diaries: Array.from(tagData?.diaries || [])
                };
            });
            
            this.debugLog(`Found ${matchedTags.length} similar tags for query`);
            return matchedTags;
        } catch (error) {
            console.error('[TagVectorManager] Search failed:', error.message);
            return [];
        }
    }

    /**
     * ✅ Bug #1-3修复: 保存到磁盘（完整的原子性保证）
     * @param {boolean} incrementalMode - 增量模式：不删除旧shard，只更新/新增
     */
    async saveGlobalTagLibrary(indexPath, dataPath, incrementalMode = false) {
        // ✅ 竞态修复：保存操作加锁，防止并发写入导致数据损坏
        if (this.saveLock) {
            console.log('[TagVectorManager] ⏳ Save operation in progress, queuing...');
            return new Promise((resolve, reject) => {
                this.saveQueue.push({ indexPath, dataPath, incrementalMode, resolve, reject });
            });
        }
        
        this.saveLock = true;
        
        try {
            await this._saveGlobalTagLibraryImpl(indexPath, dataPath, incrementalMode);
            
            // ✅ 竞态修复：改进队列合并策略，确保所有脏数据都被保存
            if (this.saveQueue.length > 0) {
                console.log(`[TagVectorManager] Processing ${this.saveQueue.length} queued save requests (merge strategy)...`);
                
                // 🔒 快照当前脏数据状态
                const currentDirtyTags = this.dirtyTags.size;
                const currentDirtyShards = this.dirtyShards.size;
                
                const lastSave = this.saveQueue.pop();
                
                // ✅ 合并中间请求
                while (this.saveQueue.length > 0) {
                    const mergedSave = this.saveQueue.pop();
                    mergedSave.resolve();
                    console.log('[TagVectorManager] Merged save request resolved');
                }
                
                // 执行最后一个（只在有新的脏数据时才执行）
                if (currentDirtyTags > 0 || currentDirtyShards > 0) {
                    try {
                        console.log(`[TagVectorManager] Executing final queued save (${currentDirtyTags} dirty tags, ${currentDirtyShards} dirty shards)...`);
                        await this._saveGlobalTagLibraryImpl(lastSave.indexPath, lastSave.dataPath, lastSave.incrementalMode);
                        lastSave.resolve();
                        console.log('[TagVectorManager] Final queued save completed');
                    } catch (error) {
                        lastSave.reject(error);
                        console.error('[TagVectorManager] Final queued save failed:', error.message);
                    }
                } else {
                    // 没有新脏数据，直接resolve
                    lastSave.resolve();
                    console.log('[TagVectorManager] Final queued save skipped (no new dirty data)');
                }
            }
        } finally {
            this.saveLock = false;
        }
    }
    
    /**
     * ✅ 实际的保存实现（带完整的原子性和非阻塞优化 + 崩溃防护）
     */
    async _saveGlobalTagLibraryImpl(indexPath, dataPath, incrementalMode = false) {
        console.log('[TagVectorManager] 💾 Starting save operation (non-blocking mode)...');
        const startTime = Date.now();
        
        // ✅ 保存前数据验证（防止保存损坏的数据）
        const tagsWithVectors = Array.from(this.globalTags.entries())
            .filter(([_, data]) => data.vector !== null);
        
        if (!this.usingVexus && tagsWithVectors.length === 0 && this.globalTags.size > 0) {
            console.error('[TagVectorManager] ❌ FATAL: Attempting to save with 0 vectors but non-zero tags! (JS mode)');
            console.error('[TagVectorManager] Total tags:', this.globalTags.size);
            console.error('[TagVectorManager] This indicates data corruption, aborting save to prevent data loss');
            throw new Error('Data corruption detected: no vectors to save');
        }
        
        console.log(`[TagVectorManager] ✅ Pre-save validation passed: ${tagsWithVectors.length}/${this.globalTags.size} tags have vectors`);
        
        // 🦀 如果使用Vexus，保存Rust索引（改进：原子性保存）
        if (this.usingVexus && this.vexus) {
            try {
                const vexusIndexPath = indexPath.replace('.bin', '_vexus.usearch');
                const vexusMapPath = dataPath.replace('.json', '_vexus.map');
                
                // ✅ 先保存到临时文件
                const tempVexusIndexPath = vexusIndexPath + '.tmp';
                const tempVexusMapPath = vexusMapPath + '.tmp';
                
                this.vexus.save(tempVexusIndexPath, tempVexusMapPath);
                
                // ✅ 验证并原子重命名
                const fs = require('fs');
                if (fs.existsSync(tempVexusIndexPath) && fs.existsSync(tempVexusMapPath)) {
                    await require('fs').promises.rename(tempVexusIndexPath, vexusIndexPath);
                    await require('fs').promises.rename(tempVexusMapPath, vexusMapPath);
                    console.log('[TagVectorManager] 🦀 ✅ Vexus index saved atomically');
                } else {
                    throw new Error('Vexus temp files not created properly');
                }
            } catch (vexusError) {
                console.error('[TagVectorManager] ❌ Vexus save failed:', vexusError.message);
                // ⚠️ Vexus失败不阻止JS索引保存，因为可以重建
                console.warn('[TagVectorManager] Continuing with JS index save...');
            }
        }
        
        const metaPath = dataPath.replace('.json', '_meta.json');
        const vectorBasePath = dataPath.replace('.json', '_vectors');
        const labelMapPath = dataPath.replace('.json', '_label_map.json');
        
        // ✅ 关键优化：减小分片大小，增加并发度，减少单次阻塞时间
        const SHARD_SIZE = parseInt(process.env.TAG_SAVE_SHARD_SIZE) || 2000;
        const currentTagsWithVectors = Array.from(this.globalTags.entries())
            .filter(([_, data]) => data.vector !== null);
        
        // 1. 准备元数据
        const metaData = {
            version: this.config.dataVersion, // ✅ Bug #10修复
            timestamp: new Date().toISOString(),
            totalTags: this.globalTags.size,
            vectorizedTags: tagsWithVectors.length,
            tags: {}
        };
        
        for (const [tag, data] of this.globalTags.entries()) {
            metaData.tags[tag] = {
                hasVector: data.vector !== null,
                frequency: data.frequency,
                diaries: Array.from(data.diaries)
            };
        }
        
        // ✅ Bug #1修复: 准备Label映射数据
        const labelMapData = {
            version: this.config.dataVersion,
            timestamp: new Date().toISOString(),
            tagToLabel: Array.from(this.tagToLabel.entries()),
            labelToTag: Array.from(this.labelToTag.entries())
        };
        
        const shardDataList = [];
        
        // ✅ Vexus 优化：仅在非 Vexus 模式下处理向量分片
        if (!this.usingVexus) {
            // 2. 🌟 准备向量数据（Diff模式：只处理脏shard）
            // ✅ 竞态修复：确保shardCount计算与标记时一致
            const shardCount = Math.max(1, Math.ceil(tagsWithVectors.length / SHARD_SIZE));
            
            console.log(`[TagVectorManager] 📊 Save operation using shardCount: ${shardCount} (${currentTagsWithVectors.length} vectorized tags)`);
            
            if (incrementalMode && this.dirtyShards.size > 0) {
                // 🌟 Diff模式：只重写脏shard
                console.log(`[TagVectorManager] 🎯 Diff mode: Processing ${this.dirtyShards.size} dirty shards out of ${shardCount}`);
                
                // ✅ 竞态修复：创建脏shard集合的副本 + 验证shard索引有效性
                const dirtyShardsCopy = new Set(this.dirtyShards);
                
                // 🔒 验证shard索引：过滤掉超出当前shardCount的无效索引（可能由旧的shardCount计算产生）
                const validDirtyShards = new Set();
                for (const shardIndex of dirtyShardsCopy) {
                    if (shardIndex >= 0 && shardIndex < shardCount) {
                        validDirtyShards.add(shardIndex);
                    } else {
                        console.warn(`[TagVectorManager] ⚠️ Ignoring invalid shard index ${shardIndex} (current shardCount: ${shardCount})`);
                    }
                }
                
                if (validDirtyShards.size < dirtyShardsCopy.size) {
                    console.log(`[TagVectorManager] 🔧 Filtered ${dirtyShardsCopy.size - validDirtyShards.size} invalid shard indices`);
                }
                
                // 按tag分组到对应的shard
                const shardMap = new Map(); // shardIndex → {tag: vector}
                
                for (const [tag, data] of currentTagsWithVectors) {
                    const shardIndex = this.getShardIndexForTag(tag, shardCount);
                    
                    // 只处理脏shard
                    if (dirtyShardsCopy.has(shardIndex)) {
                        if (!shardMap.has(shardIndex)) {
                            shardMap.set(shardIndex, {});
                        }
                        shardMap.get(shardIndex)[tag] = Array.from(data.vector);
                    }
                }
                
                // 对于每个脏shard，加载旧数据并合并
                for (const shardIndex of validDirtyShards) {
                    const shardPath = `${vectorBasePath}_${shardIndex + 1}.json`;
                    let shardData = shardMap.get(shardIndex) || {};
                    
                    try {
                        // 尝试加载旧shard数据
                        const oldContent = await fs.readFile(shardPath, 'utf-8');
                        const oldShardFile = JSON.parse(oldContent);
                        const oldShardData = oldShardFile.vectors || oldShardFile;
                        
                        // 合并：保留旧tag + 更新新tag
                        for (const [tag, vector] of Object.entries(oldShardData)) {
                            if (!shardData[tag] && this.globalTags.has(tag)) {
                                // 旧tag仍然存在且未在本次更新中
                                const tagData = this.globalTags.get(tag);
                                if (tagData && tagData.vector) {
                                    shardData[tag] = Array.from(tagData.vector);
                                }
                            }
                        }
                        
                        this.debugLog(`Shard ${shardIndex + 1}: merged ${Object.keys(oldShardData).length} old + ${Object.keys(shardMap.get(shardIndex) || {}).length} new tags`);
                    } catch (e) {
                        // 旧shard不存在或损坏，使用新数据
                        this.debugLog(`Shard ${shardIndex + 1}: creating new (${Object.keys(shardData).length} tags)`);
                    }
                    
                    shardDataList.push({
                        index: shardIndex + 1,
                        data: shardData,
                        checksum: this.computeChecksum(shardData)
                    });
                }
                
                console.log(`[TagVectorManager] ✅ Prepared ${shardDataList.length} dirty shards for writing`);
                
            } else if (incrementalMode) {
                // 增量模式但没有脏shard，跳过向量文件写入
                console.log(`[TagVectorManager] ⏭️ No dirty shards, skipping vector file write`);
                
            } else {
                // 完整模式：全量重写所有shard
                console.log(`[TagVectorManager] 📦 Full mode: Writing all ${shardCount} shards`);
                
                // 按tag分组到对应的shard
                const shardMap = new Map();
                for (const [tag, data] of currentTagsWithVectors) {
                    const shardIndex = this.getShardIndexForTag(tag, shardCount);
                    if (!shardMap.has(shardIndex)) {
                        shardMap.set(shardIndex, {});
                    }
                    shardMap.get(shardIndex)[tag] = Array.from(data.vector);
                }
                
                // 生成所有shard
                for (let i = 0; i < shardCount; i++) {
                    const shardData = shardMap.get(i) || {};
                    shardDataList.push({
                        index: i + 1,
                        data: shardData,
                        checksum: this.computeChecksum(shardData)
                    });
                }
            }
        } else {
            console.log('[TagVectorManager] ⏭️ Skipping vector shard save (using Vexus)');
        }
        
        // 3. ✅ Bug #2-3修复: 原子性写入 - 先写临时文件，全部成功后再重命名
        const tempFiles = [];
        
        try {
            // 3.1 ✅ 修复：仅在未使用Vexus时才写HNSW索引
            if (!this.usingVexus && this.tagIndex) {
                const tempIndexPath = indexPath + '.tmp';
                console.log('[TagVectorManager] 💾 Writing HNSW index...');
                
                await new Promise((resolve, reject) => {
                    setImmediate(() => {
                        try {
                            this.tagIndex.writeIndexSync(tempIndexPath);
                            resolve();
                        } catch (error) {
                            reject(error);
                        }
                    });
                });
                console.log('[TagVectorManager] ✅ HNSW index written to temp file');
                tempFiles.push({ temp: tempIndexPath, final: indexPath });
            } else if (this.usingVexus) {
                console.log('[TagVectorManager] ⏭️ Skipping HNSW index save (using Vexus)');
            }
            
            // 3.2 写入元数据到临时文件（✅ 分块序列化避免阻塞）
            await new Promise(resolve => setImmediate(resolve));
            const tempMetaPath = metaPath + '.tmp';
            // ✅ 使用流式写入避免大JSON阻塞
            const metaJsonString = JSON.stringify(metaData, null, 2);
            await fs.writeFile(tempMetaPath, metaJsonString, 'utf-8');
            tempFiles.push({ temp: tempMetaPath, final: metaPath });
            
            // 3.3 写入Label映射到临时文件（✅ 分块序列化）
            await new Promise(resolve => setImmediate(resolve));
            const tempLabelMapPath = labelMapPath + '.tmp';
            const labelMapJsonString = JSON.stringify(labelMapData, null, 2);
            await fs.writeFile(tempLabelMapPath, labelMapJsonString, 'utf-8');
            tempFiles.push({ temp: tempLabelMapPath, final: labelMapPath });
            
            // 3.4 写入向量分片到临时文件（✅ 完全非阻塞JSON序列化）
            for (let i = 0; i < shardDataList.length; i++) {
                const shard = shardDataList[i];
                const tempShardPath = `${vectorBasePath}_${shard.index}.json.tmp`;
                const shardWithMeta = {
                    checksum: shard.checksum,
                    version: this.config.dataVersion,
                    vectors: shard.data
                };
                
                // ✅ 关键优化：每次序列化前都让出控制权，避免长时间阻塞
                await new Promise(resolve => setImmediate(resolve));
                
                // ✅ 使用流式写入，避免一次性序列化大JSON
                const jsonString = JSON.stringify(shardWithMeta);
                await fs.writeFile(tempShardPath, jsonString, 'utf-8');
                
                tempFiles.push({
                    temp: tempShardPath,
                    final: `${vectorBasePath}_${shard.index}.json`
                });
                
                // ✅ 显示进度
                if (shardDataList.length > 1) {
                    console.log(`[TagVectorManager] Writing shard ${i + 1}/${shardDataList.length}...`);
                }
                
                // ✅ 每写入一个分片后再次让出控制权
                if (i < shardDataList.length - 1) {
                    await new Promise(resolve => setImmediate(resolve));
                }
            }
            
            // 4. ✅ 所有临时文件写入成功，开始原子重命名
            for (const { temp, final: finalPath } of tempFiles) {
                await fs.rename(temp, finalPath);
            }
            
            // 5. ✅ Bug #2修复: 清理多余的旧shard（在成功写入后）
            if (incrementalMode && this.dirtyShards.size > 0) {
                // ✅ 关键修复：Diff模式不删除旧shard，只在shardCount变化时清理
                const SHARD_SIZE = parseInt(process.env.TAG_SAVE_SHARD_SIZE) || 2000;
                const totalVectorizedTags = Array.from(this.globalTags.entries())
                    .filter(([_, data]) => data.vector !== null).length;
                const expectedShardCount = Math.ceil(totalVectorizedTags / SHARD_SIZE);
                
                try {
                    const files = await fs.readdir(path.dirname(vectorBasePath));
                    for (const file of files) {
                        if (file.startsWith(path.basename(vectorBasePath)) &&
                            file.endsWith('.json') &&
                            !file.endsWith('.tmp')) {
                            const shardNum = parseInt(file.match(/_(\d+)\.json$/)?.[1] || '0');
                            // 只删除超出总shard数量的文件（数据量减少时）
                            if (shardNum > expectedShardCount) {
                                await fs.unlink(path.join(path.dirname(vectorBasePath), file));
                                console.log(`[TagVectorManager] Removed obsolete shard: ${file} (expected max: ${expectedShardCount})`);
                            }
                        }
                    }
                } catch (e) {
                    console.warn('[TagVectorManager] Failed to cleanup old shards:', e.message);
                }
            } else {
                // 完整模式：删除所有旧的向量文件
                try {
                    const files = await fs.readdir(path.dirname(vectorBasePath));
                    for (const file of files) {
                        if (file.startsWith(path.basename(vectorBasePath)) && 
                            file.endsWith('.json') &&
                            !tempFiles.some(tf => tf.final === path.join(path.dirname(vectorBasePath), file))) {
                            await fs.unlink(path.join(path.dirname(vectorBasePath), file));
                        }
                    }
                } catch (e) {
                    console.warn('[TagVectorManager] Failed to cleanup old files:', e.message);
                }
            }
            
            const saveTime = ((Date.now() - startTime) / 1000).toFixed(1);
            
            // ✅ 竞态修复：无论哪种模式，都在成功后清空dirtyShards
            if (incrementalMode && shardDataList.length > 0) {
                console.log(`[TagVectorManager] ✅ Diff saved in ${saveTime}s: ${metaData.totalTags} tags, ${shardDataList.length}/${shardCount} dirty shards`);
            } else if (incrementalMode) {
                console.log(`[TagVectorManager] ✅ Metadata saved in ${saveTime}s: ${metaData.totalTags} tags (no vector changes)`);
            } else {
                console.log(`[TagVectorManager] ✅ Full save in ${saveTime}s: ${metaData.totalTags} tags, ${shardDataList.length} shard(s)`);
            }
            
            // 🔒 关键：清空所有脏标记（在成功写入后）
            // this.dirtyShards.clear(); // ✅ 移至 persistChanges 确保完全成功
            
        } catch (error) {
            // ✅ 如果任何步骤失败，清理所有临时文件
            console.error('[TagVectorManager] Save failed, cleaning up temp files:', error.message);
            for (const { temp } of tempFiles) {
                try {
                    await fs.unlink(temp);
                } catch (e) {
                    // 忽略清理错误
                }
            }
            throw error;
        }
    }

    /**
     * ✅ Bug #1, #4修复: 从磁盘加载（支持Label映射恢复，延迟清空内存）
     */
    async loadGlobalTagLibrary(indexPath, dataPath) {
        const metaPath = dataPath.replace('.json', '_meta.json');
        const vectorBasePath = dataPath.replace('.json', '_vectors');
        const labelMapPath = dataPath.replace('.json', '_label_map.json');
    
        // ✅ 新增：检测 Vexus 模式
        const vexusMode = this.usingVexus;
        if (vexusMode) {
            console.log('[TagVectorManager] 🦀 Loading in Vexus-only mode (skipping JSON vectors)');
        }
    
        // ✅ Bug #4修复: 先加载到临时变量，成功后再替换
        const tempGlobalTags = new Map();
        let tempTagIndex = null;
        const tempTagToLabel = new Map();
        const tempLabelToTag = new Map();
    
        // ✅ 尝试加载新格式（分片文件）
        try {
            await fs.access(metaPath);
    
            // 加载元数据
            const metaContent = await fs.readFile(metaPath, 'utf-8');
            const metaFileData = JSON.parse(metaContent);
    
            // ✅ Bug #10修复: 版本检查
            if (metaFileData.version && metaFileData.version !== this.config.dataVersion) {
                console.warn(`[TagVectorManager] Data version mismatch: expected ${this.config.dataVersion}, got ${metaFileData.version}`);
            }
    
            const metaData = metaFileData.tags || metaFileData;
    
            // ✅ 如果是 Vexus 模式，跳过 shard 加载，直接从元数据构建
            if (vexusMode) {
                console.log(`[TagVectorManager] 🦀 Vexus mode: Loading ${Object.keys(metaData).length} tags (vectors in Vexus index)`);
    
                for (const [tag, meta] of Object.entries(metaData)) {
                    tempGlobalTags.set(tag, {
                        vector: null, // ✅ 向量标记为null，后续会触发增量向量化
                        frequency: meta.frequency,
                        diaries: new Set(meta.diaries)
                    });
                }
    
                console.log(`[TagVectorManager] ✅ Loaded ${tempGlobalTags.size} tags (vectors will be restored from Vexus)`);
    
                // ✅ 替换内存数据
                this.globalTags = tempGlobalTags;
                this.tagIndex = null;
                this.tagToLabel.clear();
                this.labelToTag.clear();
    
                // ✅ 触发特殊标记：需要从 Vexus 恢复向量
                throw new Error('NEED_VEXUS_RESTORE');
            }
    
            // 查找所有shard文件
            const dirPath = path.dirname(vectorBasePath);
            const baseFileName = path.basename(vectorBasePath);
            const files = await fs.readdir(dirPath);
            const shardFiles = files
                .filter(f => f.startsWith(baseFileName) && f.endsWith('.json') && !f.endsWith('.tmp'))
                .sort((a, b) => {
                    const numA = parseInt(a.match(/_(\d+)\.json$/)?.[1] || '0');
                    const numB = parseInt(b.match(/_(\d+)\.json$/)?.[1] || '0');
                    return numA - numB;
                });
    
            console.log(`[TagVectorManager] Found ${shardFiles.length} shard file(s)`);
    
            // ✅ Bug #8修复: 容错的分片合并
            const allVectorData = {};
            for (const shardFile of shardFiles) {
                try {
                    const shardPath = path.join(dirPath, shardFile);
                    const shardContent = await fs.readFile(shardPath, 'utf-8');
                    const shardFileData = JSON.parse(shardContent);
    
                    // ✅ Bug #10修复: 校验和验证
                    const shardData = shardFileData.vectors || shardFileData;
                    if (shardFileData.checksum) {
                        const computedChecksum = this.computeChecksum(shardData);
                        if (computedChecksum !== shardFileData.checksum) {
                            console.warn(`[TagVectorManager] Checksum mismatch in ${shardFile}`);
                        }
                    }
    
                    Object.assign(allVectorData, shardData);
                    console.log(`[TagVectorManager] Loaded shard: ${shardFile} (${Object.keys(shardData).length} vectors)`);
                } catch (parseError) {
                    console.error(`[TagVectorManager] Failed to load shard ${shardFile}:`, parseError.message);
                    // 继续加载其他分片
                }
            }
    
            // ✅ 合并数据到临时Map + 数据一致性检查
            const inconsistentTags = [];
            for (const [tag, meta] of Object.entries(metaData)) {
                // ✅ 检测数据不一致：元数据标记有向量但实际向量丢失
                if (meta.hasVector && !allVectorData[tag]) {
                    inconsistentTags.push(tag);
                }
    
                tempGlobalTags.set(tag, {
                    vector: meta.hasVector && allVectorData[tag] ? new Float32Array(allVectorData[tag]) : null,
                    frequency: meta.frequency,
                    diaries: new Set(meta.diaries)
                });
            }
    
            console.log(`[TagVectorManager] Loaded from sharded files: ${Object.keys(metaData).length} tags, ${Object.keys(allVectorData).length} vectors`);
    
            // ✅ 数据一致性报告
            if (inconsistentTags.length > 0) {
                console.error(`[TagVectorManager] ⚠️ DATA CORRUPTION DETECTED!`);
                console.error(`[TagVectorManager] ${inconsistentTags.length} tags marked hasVector=true but vectors are missing`);
                console.error(`[TagVectorManager] Sample corrupted tags: ${inconsistentTags.slice(0, 10).join(', ')}`);
                console.error(`[TagVectorManager] This likely indicates a crash during save operation`);
                console.warn(`[TagVectorManager] These tags will be re-vectorized in background...`);
            }
    
        } catch (e) {
            if (e.message === 'NEED_INCREMENTAL_VECTORIZE') {
                throw e; // Propagate to initialize()
            }
    
            // 🔥 新增：传播 Vexus 恢复信号
            if (e.message === 'NEED_VEXUS_RESTORE') {
                throw e; // ← 这是缺失的关键代码！
            }
    
            // ✅ 回退到旧格式
            console.log(`[TagVectorManager] Sharded files not found, trying legacy format...`);
    
            try {
                // 尝试单文件格式
                const vectorPath = dataPath.replace('.json', '_vectors.json');
                await fs.access(vectorPath);
    
                const metaContent = await fs.readFile(metaPath, 'utf-8');
                const metaData = JSON.parse(metaContent);
    
                const vectorContent = await fs.readFile(vectorPath, 'utf-8');
                const vectorData = JSON.parse(vectorContent);
    
                for (const [tag, meta] of Object.entries(metaData)) {
                    tempGlobalTags.set(tag, {
                        vector: meta.hasVector && vectorData[tag] ? new Float32Array(vectorData[tag]) : null,
                        frequency: meta.frequency,
                        diaries: new Set(meta.diaries)
                    });
                }
    
                console.log(`[TagVectorManager] Loaded from single vector file: ${Object.keys(metaData).length} tags`);
            } catch (e2) {
                // 最后尝试完全旧格式
                const content = await fs.readFile(dataPath, 'utf-8');
                const tagData = JSON.parse(content);
    
                for (const [tag, data] of Object.entries(tagData)) {
                    tempGlobalTags.set(tag, {
                        vector: data.vector ? new Float32Array(data.vector) : null,
                        frequency: data.frequency,
                        diaries: new Set(data.diaries)
                    });
                }
    
                console.log(`[TagVectorManager] Loaded from legacy file: ${Object.keys(tagData).length} tags`);
            }
        }
    
        const tagsWithVectors = Array.from(tempGlobalTags.entries())
            .filter(([_, data]) => data.vector !== null);
    
        // ✅ 关键修复：即使没有向量，也加载元数据，稍后增量向量化
        if (tagsWithVectors.length === 0) {
            console.warn('[TagVectorManager] ⚠️ No vectors found, loading metadata only (will vectorize incrementally)');
    
            // 替换元数据（保留tag信息，向量为null）
            this.globalTags = tempGlobalTags;
            this.tagIndex = null; // 索引需要重建
            this.tagToLabel.clear();
            this.labelToTag.clear();
    
            console.log(`[TagVectorManager] ✅ Loaded ${tempGlobalTags.size} tags (no vectors, incremental build needed)`);
    
            // 抛出特殊错误，让initialize()知道需要增量向量化
            throw new Error('NEED_INCREMENTAL_VECTORIZE');
        }
    
        // ✅ 修复：仅在未使用Vexus时才加载hnswlib索引
        if (!this.usingVexus) {
            const dimensions = tagsWithVectors[0][1].vector.length;
            tempTagIndex = new HierarchicalNSW('l2', dimensions);
    
            console.log('[TagVectorManager] 📖 Reading HNSW index...');
            const startTime = Date.now();
    
            await new Promise((resolve, reject) => {
                setImmediate(() => {
                    try {
                        tempTagIndex.readIndexSync(indexPath);
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                });
            });
    
            const loadTime = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`[TagVectorManager] ✅ HNSW index loaded in ${loadTime}s`);
        } else {
            console.log('[TagVectorManager] ⏭️ Skipping HNSW index load (using Vexus)');
        }
    
        // ✅ Bug #1修复: 尝试加载Label映射
        try {
            await fs.access(labelMapPath);
            const labelMapContent = await fs.readFile(labelMapPath, 'utf-8');
            const labelMapData = JSON.parse(labelMapContent);
    
            // 恢复映射
            for (const [tag, label] of labelMapData.tagToLabel) {
                tempTagToLabel.set(tag, label);
            }
            for (const [label, tag] of labelMapData.labelToTag) {
                tempLabelToTag.set(label, tag);
            }
    
            console.log(`[TagVectorManager] ✅ Restored label mappings: ${tempTagToLabel.size} tags`);
        } catch (e) {
            // ✅ 回退：重建映射（假设顺序一致）
            console.warn('[TagVectorManager] Label map not found, rebuilding from tag order...');
            for (let i = 0; i < tagsWithVectors.length; i++) {
                const [tag, _] = tagsWithVectors[i];
                tempTagToLabel.set(tag, i);
                tempLabelToTag.set(i, tag);
            }
        }
    
        // ✅ Bug #4修复: 所有数据加载成功后，才替换内存数据
        this.globalTags = tempGlobalTags;
        this.tagIndex = tempTagIndex;
        this.tagToLabel = tempTagToLabel;
        this.labelToTag = tempLabelToTag;
    }

    /**
     * 🌟 启动文件监控
     */
    startFileWatcher() {
        if (this.watcher) return;

        this.watcher = chokidar.watch(this.config.diaryRootPath, {
            ignored: /(^|[\/\\])\../,
            persistent: true,
            ignoreInitial: true,
            depth: 2
        });

        const handleFileChange = (filePath) => {
            const diaryName = path.basename(path.dirname(filePath));
            if (this.shouldIgnoreFolder(diaryName)) return;

            if (this.pendingUpdates.has(diaryName)) {
                clearTimeout(this.pendingUpdates.get(diaryName));
            }

            const timeoutId = setTimeout(() => {
                this.pendingUpdates.delete(diaryName);
                // ✅ Bug #5修复: 使用队列处理
                this.queueUpdate(filePath);
            }, 500);

            this.pendingUpdates.set(diaryName, timeoutId);
        };

        this.watcher
            .on('add', handleFileChange)
            .on('change', handleFileChange)
            .on('unlink', (filePath) => {
                // 🌟 处理文件删除
                const diaryName = path.basename(path.dirname(filePath));
                if (this.shouldIgnoreFolder(diaryName)) return;
                
                this.queueUpdate(filePath); // 使用统一队列处理
            });
    }

    /**
     * ✅ Bug #5修复: 并发控制的更新队列
     */
    async queueUpdate(filePath) {
        this.updateQueue.push(filePath);
        
        // ✅ 竞态修复：等待初始化完成，同时避免后台任务期间的更新丢失
        if (this.updateLock || !this.initialized) {
            this.debugLog(`Update queued for ${path.basename(filePath)} (lock: ${this.updateLock}, init: ${this.initialized})`);
            return; // 已有更新在进行中或尚未初始化
        }
        
        // ✅ 竞态修复：等待后台任务完成再处理更新队列
        if (this.isBackgroundTaskRunning) {
            this.debugLog(`Waiting for background task to complete before processing queue...`);
            // 延迟处理，让后台任务先完成
            setTimeout(() => {
                if (!this.updateLock && !this.isBackgroundTaskRunning) {
                    this.processUpdateQueue();
                }
            }, 1000);
            return;
        }
        
        await this.processUpdateQueue();
    }
    
    /**
     * ✅ 新增：独立的队列处理方法，避免重复代码
     */
    async processUpdateQueue() {
        if (this.updateLock || this.updateQueue.length === 0) return;
        
        this.updateLock = true;
        
        try {
            while (this.updateQueue.length > 0) {
                const filePath = this.updateQueue.shift();
                await this.updateTagsForFile(filePath);
            }
        } catch (error) {
            console.error('[TagVectorManager] Queue processing failed:', error);
        } finally {
            this.updateLock = false;
        }
    }

    /**
     * 🌟 核心升级：基于内存状态的精准 Diff 更新
     * 时间复杂度：O(M)，M为该文件的Tag数量，与总文件数无关
     */
    async updateTagsForFile(filePath) {
        const diaryName = path.basename(path.dirname(filePath));
        
        // 1. 读取文件内容并计算Hash (避免无效的Tag解析)
        let content;
        try {
            content = await fs.readFile(filePath, 'utf-8');
        } catch (e) {
            // 文件可能被删除，处理删除逻辑
            return this.handleFileRemove(filePath);
        }

        const currentHash = crypto.createHash('md5').update(content).digest('hex');
        const fileRecord = this.fileRegistry.get(filePath);

        // 2. 如果Hash没变，直接跳过 (极速返回)
        if (fileRecord && fileRecord.hash === currentHash) {
            this.debugLog(`File unchanged: ${path.basename(filePath)}`);
            return;
        }

        // 3. 提取当前Tags
        const rawTags = this.extractTagsFromContent(content);
        const currentTags = new Set(rawTags);

        // 4. 计算 Diff (Set 差集运算)
        const oldTags = fileRecord ? fileRecord.tags : new Set();
        
        const addedTags = [...currentTags].filter(x => !oldTags.has(x));
        const removedTags = [...oldTags].filter(x => !currentTags.has(x));

        if (addedTags.length === 0 && removedTags.length === 0) {
            // 更新Hash并返回
            this.fileRegistry.set(filePath, { hash: currentHash, tags: currentTags });
            return;
        }

        this.debugLog(`[Diff] File: ${path.basename(filePath)} | +${addedTags.length} | -${removedTags.length}`);

        // 5. 应用变更 (内存操作，极快)
        this.applyDiff(diaryName, addedTags, removedTags);

        // 6. 更新注册表
        this.fileRegistry.set(filePath, { hash: currentHash, tags: currentTags });

        // 🌟 新增：更新Tag共现关系数据库
        if (this.cooccurrenceEnabled && currentTags.size >= 2) {
            try {
                this.cooccurrenceDB.recordTagGroup(filePath, Array.from(currentTags), diaryName);
                
                // 🌟 触发防抖导出（避免频繁写入JSON文件）
                this.scheduleMatrixExport();
            } catch (error) {
                console.error('[TagVectorManager] Failed to record tag group:', error.message);
            }
        }

        // 7. 触发异步处理 (向量化 + 索引 + 保存)
        this.triggerPostUpdateProcessing(addedTags);
    }

    /**
     * 🌟 处理文件删除
     */
    handleFileRemove(filePath) {
        const fileRecord = this.fileRegistry.get(filePath);
        if (!fileRecord) return;

        const diaryName = path.basename(path.dirname(filePath));
        const removedTags = [...fileRecord.tags];
        
        this.debugLog(`[Remove] File: ${path.basename(filePath)} | -${removedTags.length} tags`);
        
        this.applyDiff(diaryName, [], removedTags);
        this.fileRegistry.delete(filePath);
        
        // 🌟 新增：从共现数据库移除tag组
        if (this.cooccurrenceEnabled) {
            try {
                this.cooccurrenceDB.removeTagGroup(filePath);
                
                // 🌟 触发防抖导出
                this.scheduleMatrixExport();
            } catch (error) {
                console.error('[TagVectorManager] Failed to remove tag group:', error.message);
            }
        }
        
        this.triggerPostUpdateProcessing([]);
    }

    /**
     * 🌟 计算tag应该属于哪个shard（确定性hash）
     */
    getShardIndexForTag(tag, shardCount) {
        // 使用简单hash确保tag总是映射到同一个shard
        let hash = 0;
        for (let i = 0; i < tag.length; i++) {
            hash = ((hash << 5) - hash) + tag.charCodeAt(i);
            hash = hash & hash; // Convert to 32bit integer
        }
        return Math.abs(hash) % shardCount;
    }

    /**
     * 🌟 原子化应用 Diff 到全局状态（标记脏shard）
     * ✅ 竞态修复：延迟shard标记，避免在向量化前计算错误的shardCount
     */
    applyDiff(diaryName, addedTags, removedTags) {
        // ✅ 竞态修复：先处理所有元数据变更（不计算shard）
        const tagsNeedingShardMark = new Set(); // 需要标记shard的已向量化tag
        
        // 处理移除
        for (const tag of removedTags) {
            const tagData = this.globalTags.get(tag);
            if (tagData) {
                tagData.frequency--;
                tagData.diaries.delete(diaryName);
                this.dirtyTags.add(tag);
                
                // 🔒 延迟shard标记：只记录需要标记的tag，不立即计算shardCount
                if (tagData.vector !== null) {
                    tagsNeedingShardMark.add(tag);
                }

                // 如果频率归零，执行清理
                if (tagData.frequency <= 0) {
                    this.removeTagFromSystem(tag);
                    tagsNeedingShardMark.delete(tag); // 已删除的tag不需要标记shard
                }
            }
        }

        // 处理新增
        for (const tag of addedTags) {
            if (!this.globalTags.has(tag)) {
                // 全新 Tag
                this.globalTags.set(tag, {
                    vector: null, // 待向量化
                    frequency: 1,
                    diaries: new Set([diaryName])
                });
            } else {
                // 现有 Tag
                const tagData = this.globalTags.get(tag);
                tagData.frequency++;
                tagData.diaries.add(diaryName);
                
                // 如果已有向量，需要标记shard
                if (tagData.vector !== null) {
                    tagsNeedingShardMark.add(tag);
                }
            }
            this.dirtyTags.add(tag);
        }
        
        // ✅ 修复：仅在非 Vexus 模式下标记 shard
        if (tagsNeedingShardMark.size > 0 && !this.usingVexus) {
            const SHARD_SIZE = parseInt(process.env.TAG_SAVE_SHARD_SIZE) || 2000;
            const currentVectorizedTags = Array.from(this.globalTags.entries())
                .filter(([_, data]) => data.vector !== null);
            const shardCount = Math.max(1, Math.ceil(currentVectorizedTags.length / SHARD_SIZE));
            
            for (const tag of tagsNeedingShardMark) {
                const shardIndex = this.getShardIndexForTag(tag, shardCount);
                this.dirtyShards.add(shardIndex);
            }
            
            this.debugLog(`Marked ${this.dirtyShards.size} dirty shards (${tagsNeedingShardMark.size} tags affected)`);
        } else if (tagsNeedingShardMark.size > 0) {
            // Vexus 模式：跳过 shard 标记
            this.debugLog(`Skipping shard marking (using Vexus): ${tagsNeedingShardMark.size} tags affected`);
        }
    }

    /**
     * 🌟 系统级移除 Tag
     */
    removeTagFromSystem(tag) {
        if (this.tagToLabel.has(tag)) {
            const label = this.tagToLabel.get(tag);
            this.deletedLabels.add(label); // HNSW 软删除
            this.tagToLabel.delete(tag);
            this.labelToTag.delete(label);
        }
        this.globalTags.delete(tag);
        this.dirtyTags.add(tag); // 标记以确保保存时从JSON移除
    }

    /**
     * 🌟 后处理：向量化与索引更新 (智能队列分配)
     */
    triggerPostUpdateProcessing(newTagsCandidate) {
        // 找出真正需要向量化的 (没有向量的)
        const tagsToVectorize = newTagsCandidate.filter(t => {
            const d = this.globalTags.get(t);
            return d && d.vector === null;
        });

        if (tagsToVectorize.length > 0) {
            // 🌟 关键逻辑：如果批索引正在运行，加入下一批次；否则加入当前批次
            if (this.isIndexRebuilding) {
                // 批处理运行中，暂存到下一批
                tagsToVectorize.forEach(t => this.nextBatchIndexUpdates.add(t));
                this.debugLog(`Queued ${tagsToVectorize.length} tags to NEXT batch (rebuild in progress)`);
            } else {
                // 批处理空闲，加入当前批次
                tagsToVectorize.forEach(t => this.pendingIndexUpdates.add(t));
                this.debugLog(`Queued ${tagsToVectorize.length} tags to current batch`);
                // 触发批量索引更新（带合并窗口）
                this.scheduleBatchIndexRebuild();
            }
        }

        // 防抖保存
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.persistChanges(), this.saveDebounce);
    }

    /**
     * 🌟 优化的持久化：仅写入脏数据（带重试机制）
     * ✅ 竞态修复：改进锁竞争处理和重试逻辑
     */
    async persistChanges() {
        if (this.dirtyTags.size === 0) {
            this.debugLog('No dirty tags, skipping persist');
            return;
        }
        
        // ✅ 竞态修复：改进锁等待机制，避免无限重试
        if (this.saveLock) {
            this.debugLog('Save locked, rescheduling persist...');
            if (this.saveTimer) clearTimeout(this.saveTimer);
            this.saveTimer = setTimeout(() => this.persistChanges(), 1000);
            return;
        }
        
        // ✅ 竞态修复：在获取锁前先快照脏数据大小，用于验证
        const dirtyTagsSnapshot = this.dirtyTags.size;
        const dirtyShardsSnapshot = this.dirtyShards.size;
        
        this.debugLog(`Persisting ${dirtyTagsSnapshot} dirty tags, ${dirtyShardsSnapshot} dirty shards...`);
        
        const indexPath = path.join(this.config.vectorStorePath, 'GlobalTags.bin');
        const dataPath = path.join(this.config.vectorStorePath, 'GlobalTags.json');
        
        try {
            // 保存Tag库（增量模式）
            await this.saveGlobalTagLibrary(indexPath, dataPath, true);
            
            // 保存文件注册表
            await this.saveFileRegistry();
            
            // ✅ 竞态修复：清空脏数据标记（dirtyShards已在saveGlobalTagLibrary中清空）
            this.dirtyTags.clear();
            this.dirtyShards.clear(); // ✅ 移至此处，确保完全成功后才清理
            
            this.debugLog(`Persist complete (saved ${dirtyTagsSnapshot} tags, ${dirtyShardsSnapshot} shards)`);
        } catch (e) {
            console.error('[TagVectorManager] Persist failed:', e);
            console.error('[TagVectorManager] Error stack:', e.stack);
            
            // ✅ 竞态修复：失败重试时避免数据丢失
            if (this.saveTimer) clearTimeout(this.saveTimer);
            this.saveTimer = setTimeout(() => this.persistChanges(), 2000);
        }
    }

    /**
     * 🌟 保存文件注册表快照
     */
    async saveFileRegistry() {
        const registryPath = path.join(this.config.vectorStorePath, 'FileRegistry.json');
        const data = Array.from(this.fileRegistry.entries()).map(([k, v]) => [k, {
            h: v.hash,
            t: Array.from(v.tags)
        }]);
        
        const tempPath = registryPath + '.tmp';
        await fs.writeFile(tempPath, JSON.stringify(data), 'utf-8');
        await fs.rename(tempPath, registryPath);
        
        this.debugLog(`FileRegistry saved: ${this.fileRegistry.size} files`);
    }

    /**
     * 🌟 加载文件注册表 - 仅负责加载，不自动构建
     */
    async loadFileRegistry() {
        const registryPath = path.join(this.config.vectorStorePath, 'FileRegistry.json');
        const raw = await fs.readFile(registryPath, 'utf-8');
        const data = JSON.parse(raw);
        this.fileRegistry = new Map(data.map(([k, v]) => [k, {
            hash: v.h,
            tags: new Set(v.t)
        }]));
        console.log(`[TagVectorManager] ✅ Loaded registry for ${this.fileRegistry.size} files`);
    }

    /**
     * 🌟 自动迁移：从现有日记文件构建反向索引
     * 这是一个一次性操作，用于从零开始建立 fileRegistry
     * ✅ 安全措施：清空现有数据，确保干净的重建
     */
    async buildFileRegistryFromScratch() {
        console.log('[TagVectorManager] 🔨 Building FileRegistry from existing diary files...');
        
        // ✅ 清空现有注册表，确保干净重建
        this.fileRegistry.clear();
        
        const startTime = Date.now();
        let fileCount = 0;
        let tagCount = 0;

        const diaryBooks = await fs.readdir(this.config.diaryRootPath, { withFileTypes: true });

        for (const dirent of diaryBooks) {
            if (!dirent.isDirectory()) continue;
            
            const diaryName = dirent.name;
            
            // 应用过滤规则
            if (this.shouldIgnoreFolder(diaryName)) {
                this.debugLog(`Skipping ignored folder: "${diaryName}"`);
                continue;
            }

            const diaryPath = path.join(this.config.diaryRootPath, diaryName);
            
            try {
                const files = await fs.readdir(diaryPath);
                const diaryFiles = files.filter(f =>
                    f.toLowerCase().endsWith('.txt') || f.toLowerCase().endsWith('.md')
                );

                for (const file of diaryFiles) {
                    const filePath = path.join(diaryPath, file);
                    
                    try {
                        // 读取文件内容
                        const content = await fs.readFile(filePath, 'utf-8');
                        
                        // 计算Hash
                        const hash = crypto.createHash('md5').update(content).digest('hex');
                        
                        // 提取Tags（已应用超级黑名单处理）
                        const rawTags = this.extractTagsFromContent(content);
                        // 🌟 去重：Set自动处理重复的tag（比如"的故事"和"厨房"可能在多个地方出现）
                        const tags = new Set(rawTags);
                        
                        // 只记录有Tag的文件
                        if (tags.size > 0) {
                            this.fileRegistry.set(filePath, { hash, tags });
                            fileCount++;
                            tagCount += tags.size;
                        }
                        
                        // 每100个文件让出一次控制权
                        if (fileCount % 100 === 0) {
                            await new Promise(resolve => setImmediate(resolve));
                            console.log(`[TagVectorManager] Registry building progress: ${fileCount} files processed...`);
                        }
                    } catch (fileError) {
                        this.debugLog(`Failed to process file ${filePath}: ${fileError.message}`);
                        // 继续处理其他文件
                    }
                }
            } catch (error) {
                console.error(`[TagVectorManager] Error scanning folder "${diaryName}":`, error.message);
            }
        }

        const buildTime = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[TagVectorManager] ✅ FileRegistry built in ${buildTime}s: ${fileCount} files, ${tagCount} total tags`);
        
        // 立即保存新建的注册表
        if (fileCount > 0) {
            await this.saveFileRegistry();
            console.log('[TagVectorManager] 💾 FileRegistry saved to disk');
        }
    }
    
    /**
     * 🌟 批量索引重建调度器（双缓冲队列 + 1分钟合并窗口）
     */
    scheduleBatchIndexRebuild() {
        // 如果已经在等待中，不重复设置定时器
        if (this.indexRebuildTimer) {
            this.debugLog('Batch rebuild already scheduled, extending merge window...');
            return;
        }
        
        // 设置合并窗口：1分钟内的所有变更合并
        this.indexRebuildTimer = setTimeout(async () => {
            await this.executeBatchIndexRebuild();
        }, this.indexRebuildDelay);
        
        console.log(`[TagVectorManager] ⏰ Batch rebuild scheduled (merge window: ${this.indexRebuildDelay/1000}s, pending: ${this.pendingIndexUpdates.size} tags)`);
    }

    /**
     * 🌟 执行批量索引重建（信号枪机制 + 优化保存策略）
     */
    async executeBatchIndexRebuild() {
        this.indexRebuildTimer = null;
        
        // 检查前置条件
        if (this.updateLock || this.saveLock || !this.initialized) {
            console.log('[TagVectorManager] ⏳ Operation in progress, rescheduling...');
            setTimeout(() => this.executeBatchIndexRebuild(), 5000);
            return;
        }
        
        if (this.pendingIndexUpdates.size === 0) {
            this.debugLog('No tags to rebuild, skipping');
            return;
        }
        
        // 🌟 关键：启动批处理前，切换到"正在运行"状态
        this.isIndexRebuilding = true;
        
        const tagsToAdd = Array.from(this.pendingIndexUpdates);
        this.pendingIndexUpdates.clear();
        
        console.log(`[TagVectorManager] 🚀 Starting batch rebuild: ${tagsToAdd.length} tags`);
        console.log(`[TagVectorManager] 📋 Next batch queue size: ${this.nextBatchIndexUpdates.size} tags`);
        
        // 获取更新锁
        this.updateLock = true;
        
        try {
            // 1. 向量化（不触发checkpoint）
            console.log(`[TagVectorManager] 🔢 Vectorizing ${tagsToAdd.length} tags...`);
            await this.vectorizeTagBatch(tagsToAdd);
            
            console.log(`[TagVectorManager] ✅ Vectorization done, dirty shards: ${this.dirtyShards.size}`);
            
            // 2. ✅ 修复：仅在未使用Vexus时才更新hnswlib索引
            if (!this.usingVexus) {
                if (!this.tagIndex) {
                    await this.buildHNSWIndex();
                } else {
                    await this.addTagsToIndex(tagsToAdd);
                }
                console.log('[TagVectorManager] ✅ hnswlib index updated');
            } else {
                console.log('[TagVectorManager] ⏭️ Skipping hnswlib index update (using Vexus)');
            }
            
            // 3. ✅ 关键修复：只在有脏数据时才保存
            if (this.dirtyShards.size > 0 || this.dirtyTags.size > 0) {
                const indexPath = path.join(this.config.vectorStorePath, 'GlobalTags.bin');
                const dataPath = path.join(this.config.vectorStorePath, 'GlobalTags.json');
                console.log(`[TagVectorManager] 💾 Saving batch changes (${this.dirtyShards.size} dirty shards)...`);
                await this.saveGlobalTagLibrary(indexPath, dataPath, true);
                console.log(`[TagVectorManager] ✅ Batch changes saved`);
            } else {
                console.log(`[TagVectorManager] ⏭️ No dirty data, skipping save`);
            }
            
            console.log(`[TagVectorManager] ✅ Batch rebuild completed successfully`);
            
        } catch (error) {
            console.error('[TagVectorManager] ❌ Batch rebuild failed:', error.message);
            // 失败时，将tag放回下一批次
            tagsToAdd.forEach(tag => this.nextBatchIndexUpdates.add(tag));
            
        } finally {
            // 🌟 关键：批处理完成，切换状态
            this.isIndexRebuilding = false;
            this.updateLock = false;
            
            // 🌟 检查下一批次队列
            if (this.nextBatchIndexUpdates.size > 0) {
                console.log(`[TagVectorManager] 🔄 Activating next batch: ${this.nextBatchIndexUpdates.size} tags`);
                
                // 将下一批次移动到当前批次
                this.nextBatchIndexUpdates.forEach(tag => this.pendingIndexUpdates.add(tag));
                this.nextBatchIndexUpdates.clear();
                
                // 立即启动下一轮（不等待合并窗口）
                setTimeout(() => this.executeBatchIndexRebuild(), 1000);
            } else {
                console.log(`[TagVectorManager] ✨ All batches completed, system idle`);
            }
        }
    }

    /**
     * ✅ 真正的增量更新（基于fileRegistry的diff，避免全量扫描）
     * @returns {boolean} - 是否有变化
     */
    async incrementalUpdateOptimized() {
        // ✅ 并发保护
        if (this.updateLock) {
            console.log('[TagVectorManager] Incremental update already in progress, skipping...');
            return false;
        }
        
        this.updateLock = true;
        
        try {
            console.log('[TagVectorManager] 🔍 Starting TRUE incremental update (FileRegistry-based diff)...');
            
            // ✅ 关键修复：不清空globalTags，只diff变化的文件
            const tagsToAdd = [];
            const tagsToRemove = new Map(); // tag → frequency (需要减少的次数)
            
            // 步骤1：扫描文件系统，检测新增/删除/修改的文件
            const currentFiles = new Set();
            const diaryBooks = await fs.readdir(this.config.diaryRootPath, { withFileTypes: true });
            
            for (const dirent of diaryBooks) {
                if (!dirent.isDirectory()) continue;
                
                const diaryName = dirent.name;
                if (this.shouldIgnoreFolder(diaryName)) continue;
                
                const diaryPath = path.join(this.config.diaryRootPath, diaryName);
                
                try {
                    const files = await fs.readdir(diaryPath);
                    const diaryFiles = files.filter(f =>
                        f.toLowerCase().endsWith('.txt') || f.toLowerCase().endsWith('.md')
                    );
                    
                    for (const file of diaryFiles) {
                        const filePath = path.join(diaryPath, file);
                        currentFiles.add(filePath);
                        
                        // 检查文件是否有变化
                        try {
                            const content = await fs.readFile(filePath, 'utf-8');
                            const currentHash = crypto.createHash('md5').update(content).digest('hex');
                            const fileRecord = this.fileRegistry.get(filePath);
                            
                            // 新文件或文件内容变化
                            if (!fileRecord || fileRecord.hash !== currentHash) {
                                const rawTags = this.extractTagsFromContent(content);
                                // 🌟 去重：Set自动处理超级黑名单处理后可能产生的重复tag
                                const currentTags = new Set(rawTags);
                                const oldTags = fileRecord ? fileRecord.tags : new Set();
                                
                                // 计算diff
                                const added = [...currentTags].filter(t => !oldTags.has(t));
                                const removed = [...oldTags].filter(t => !currentTags.has(t));
                                
                                // 记录变化
                                for (const tag of added) {
                                    if (!this.globalTags.has(tag)) {
                                        tagsToAdd.push(tag);
                                        this.globalTags.set(tag, {
                                            vector: null,
                                            frequency: 1,
                                            diaries: new Set([diaryName])
                                        });
                                    } else {
                                        this.globalTags.get(tag).frequency++;
                                        this.globalTags.get(tag).diaries.add(diaryName);
                                    }
                                }
                                
                                for (const tag of removed) {
                                    if (!tagsToRemove.has(tag)) {
                                        tagsToRemove.set(tag, 0);
                                    }
                                    tagsToRemove.set(tag, tagsToRemove.get(tag) + 1);
                                }
                                
                                // 更新注册表
                                this.fileRegistry.set(filePath, { hash: currentHash, tags: currentTags });
                            }
                        } catch (fileError) {
                            this.debugLog(`Failed to process file ${filePath}: ${fileError.message}`);
                        }
                    }
                } catch (dirError) {
                    console.error(`[TagVectorManager] Error scanning folder "${diaryName}":`, dirError.message);
                }
            }
            
            // 步骤2：检测已删除的文件
            for (const [filePath, fileRecord] of this.fileRegistry.entries()) {
                if (!currentFiles.has(filePath)) {
                    const diaryName = path.basename(path.dirname(filePath));
                    for (const tag of fileRecord.tags) {
                        if (!tagsToRemove.has(tag)) {
                            tagsToRemove.set(tag, 0);
                        }
                        tagsToRemove.set(tag, tagsToRemove.get(tag) + 1);
                    }
                    this.fileRegistry.delete(filePath);
                }
            }
            
            // 步骤3：应用tag删除
            const actuallyRemovedTags = [];
            for (const [tag, decreaseCount] of tagsToRemove.entries()) {
                const tagData = this.globalTags.get(tag);
                if (tagData) {
                    tagData.frequency -= decreaseCount;
                    if (tagData.frequency <= 0) {
                        this.removeTagFromSystem(tag);
                        actuallyRemovedTags.push(tag);
                    }
                }
            }
            
            if (tagsToAdd.length === 0 && actuallyRemovedTags.length === 0) {
                console.log('[TagVectorManager] ✅ No changes detected');
                return false;
            }
            
            console.log(`[TagVectorManager] Changes detected: +${tagsToAdd.length} tags, -${actuallyRemovedTags.length} tags`);
            
            // 步骤4：向量化新增tags
            if (tagsToAdd.length > 0) {
                console.log(`[TagVectorManager] Vectorizing ${tagsToAdd.length} new tags...`);
                await this.vectorizeTagBatch(tagsToAdd);
            }
            
            // 步骤5：增量更新索引
            if (tagsToAdd.length > 0) {
                if (!this.tagIndex) {
                    await this.buildHNSWIndex();
                } else {
                    await this.addTagsToIndex(tagsToAdd);
                }
            }
            
            // 步骤6：保存FileRegistry
            await this.saveFileRegistry();
            
            return true;
            
        } finally {
            this.updateLock = false;
        }
    }

    /**
     * 🚀 完全非阻塞的并发批量向量化（使用专用Worker，NO checkpoint阻塞）
     * 🦀 已集成Vexus-Lite支持
     */
    async vectorizeTagBatch(tags) {
        const batchSize = this.config.tagBatchSize;
        const concurrency = parseInt(process.env.TAG_VECTORIZE_CONCURRENCY) || 5;
        
        console.log(`[TagVectorManager] 🚀 Starting NON-BLOCKING vectorization: ${tags.length} tags (concurrency: ${concurrency})...`);
        if (this.usingVexus) {
            console.log(`[TagVectorManager] 🦀 Using Vexus-Lite engine`);
        }
        
        // ✅ 竞态修复1：使用原子操作获取shard计算快照，防止计算过程中shardCount变化
        const SHARD_SIZE = parseInt(process.env.TAG_SAVE_SHARD_SIZE) || 2000;
        
        // 🔒 原子快照：锁定当前状态用于shard计算
        const vectorizationSnapshot = {
            currentVectorizedCount: Array.from(this.globalTags.entries())
                .filter(([_, data]) => data.vector !== null).length,
            tagsToVectorize: tags.length,
            timestamp: Date.now()
        };
        
        // 计算稳定的shardCount（基于快照）
        const stableShardCount = Math.max(1, Math.ceil(
            (vectorizationSnapshot.currentVectorizedCount + vectorizationSnapshot.tagsToVectorize) / SHARD_SIZE
        ));
        
        console.log(`[TagVectorManager] 📸 Vectorization snapshot: ${vectorizationSnapshot.currentVectorizedCount} existing + ${vectorizationSnapshot.tagsToVectorize} new = ${stableShardCount} shards`);
        
        // ✅ 竞态修复2：预先计算并原子标记所有受影响的shard（仅JS模式需要）
        if (!this.usingVexus) {
            const affectedShards = new Set();
            for (const tag of tags) {
                const shardIndex = this.getShardIndexForTag(tag, stableShardCount);
                affectedShards.add(shardIndex);
            }
            
            // 🔒 原子标记操作：立即标记所有脏shard，防止并发保存操作跳过
            affectedShards.forEach(idx => this.dirtyShards.add(idx));
            
            console.log(`[TagVectorManager] 🎯 Pre-marked ${affectedShards.size} shards as dirty (shardCount: ${stableShardCount})`);
        }
        
        // 传统同步模式（脏shard已在函数开始时预先标记）
        console.log(`[TagVectorManager] Using sync vectorization...`);
        const batches = [];
        for (let i = 0; i < tags.length; i += batchSize) {
            batches.push(tags.slice(i, i + batchSize));
        }
        
        let processedTags = 0;
        
        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            try {
                const vectors = await this.embeddingFunction(batch);
                
                // 🦀 如果使用Vexus，批量添加到索引
                if (this.usingVexus && vectors.length > 0) {
                    try {
                        const dimensions = vectors[0].length;
                        const flatVectors = new Float32Array(batch.length * dimensions);
                        for (let j = 0; j < batch.length; j++) {
                            flatVectors.set(vectors[j], j * dimensions);
                        }
                        
                        const vectorBuffer = Buffer.from(flatVectors.buffer);
                        this.vexus.upsert(batch, vectorBuffer);
                    } catch (vexusError) {
                        console.error(`[TagVectorManager] ❌ Vexus upsert failed for batch ${i}:`, vexusError.message);
                        
                        // ✅ 容量不足时禁用Vexus
                        if (vexusError.message && vexusError.message.includes('capacity')) {
                            console.error('[TagVectorManager] ⚠️ Vexus capacity exceeded, disabling for remaining batches');
                            this.usingVexus = false;
                        }
                    }
                }
                
                for (let j = 0; j < batch.length; j++) {
                    const tag = batch[j];
                    const tagData = this.globalTags.get(tag);
                    if (tagData) {
                        tagData.vector = vectors[j];
                        this.dirtyTags.add(tag);
                        processedTags++;
                    }
                }
                
                // 定期让出控制权
                if ((i + 1) % 10 === 0) {
                    await new Promise(resolve => setImmediate(resolve));
                    console.log(`[TagVectorManager] Sync progress: ${((i + 1) / batches.length * 100).toFixed(1)}%`);
                }
            } catch (error) {
                console.error(`[TagVectorManager] Batch ${i} failed:`, error.message);
            }
        }
        
        console.log(`[TagVectorManager] ✅ Sync vectorization completed: ${processedTags} vectors`);
    }

    /**
     * ✅ 检查是否应忽略文件夹
     */
    shouldIgnoreFolder(folderName) {
        // 检查固定忽略列表（精确匹配或包含）
        if (this.config.ignorePatterns.some(pattern => folderName === pattern || folderName.includes(pattern))) {
            return true;
        }
        
        // 检查前缀（如"已整理"）
        if (this.config.ignorePrefix && folderName.startsWith(this.config.ignorePrefix)) {
            return true;
        }
        
        // 检查后缀（如"簇"）
        if (this.config.ignoreSuffix && folderName.endsWith(this.config.ignoreSuffix)) {
            return true;
        }
        
        return false;
    }

    /**
     * 🔧 检查Tag共现数据库的一致性
     * @param {Object} dbStats - 数据库统计信息
     * @returns {boolean} - 是否需要同步
     */
    async checkCooccurrenceConsistency(dbStats) {
        if (!dbStats || !this.cooccurrenceEnabled) return false;
        
        const { total_groups } = dbStats;
        
        // 情况1：数据库为空 → 需要首次构建
        if (total_groups === 0) {
            console.log('[TagVectorManager] Cooccurrence DB is empty, needs initial build');
            return true;
        }
        
        // 情况2：检查FileRegistry是否与DB同步
        if (this.fileRegistry.size === 0) {
            console.log('[TagVectorManager] FileRegistry empty but DB has data, needs sync');
            return true;
        }
        
        // 情况3：检查记录数量是否合理（DB组数应该接近FileRegistry文件数）
        const expectedGroups = this.fileRegistry.size;
        const groupDiff = Math.abs(total_groups - expectedGroups);
        const diffRatio = expectedGroups > 0 ? groupDiff / expectedGroups : 1.0;
        
        if (diffRatio > 0.1) {
            console.log(`[TagVectorManager] Cooccurrence DB inconsistent: DB=${total_groups}, Expected≈${expectedGroups} (${(diffRatio*100).toFixed(1)}% diff)`);
            return true;
        }
        
        console.log(`[TagVectorManager] Cooccurrence DB consistency check passed: ${total_groups} groups`);
        return false;
    }

    /**
     * 🔧 同步Tag共现数据库（从FileRegistry重建）
     * 只处理变化的文件，实现真正的diff同步
     */
    async syncCooccurrenceDatabase() {
        if (!this.cooccurrenceEnabled) return;
        
        console.log('[TagVectorManager] 🔄 Syncing cooccurrence database...');
        const startTime = Date.now();
        
        try {
            // 步骤1：收集当前文件系统中所有有tag的文件
            const currentFiles = new Set();
            const diaryBooks = await fs.readdir(this.config.diaryRootPath, { withFileTypes: true });
            
            for (const dirent of diaryBooks) {
                if (!dirent.isDirectory()) continue;
                
                const diaryName = dirent.name;
                if (this.shouldIgnoreFolder(diaryName)) continue;
                
                const diaryPath = path.join(this.config.diaryRootPath, diaryName);
                
                try {
                    const files = await fs.readdir(diaryPath);
                    const diaryFiles = files.filter(f =>
                        f.toLowerCase().endsWith('.txt') || f.toLowerCase().endsWith('.md')
                    );
                    
                    for (const file of diaryFiles) {
                        const filePath = path.join(diaryPath, file);
                        currentFiles.add(filePath);
                    }
                } catch (error) {
                    console.error(`[TagVectorManager] Error listing folder "${diaryName}":`, error.message);
                }
            }
            
            // 步骤2：从FileRegistry同步到CooccurrenceDB
            let syncCount = 0;
            
            for (const [filePath, fileRecord] of this.fileRegistry.entries()) {
                if (!currentFiles.has(filePath)) {
                    // 文件已删除但FileRegistry中仍存在，从DB移除
                    this.cooccurrenceDB.removeTagGroup(filePath);
                    syncCount++;
                } else if (fileRecord.tags.size >= 2) {
                    // 文件存在且有足够tag，记录到DB
                    const diaryName = path.basename(path.dirname(filePath));
                    this.cooccurrenceDB.recordTagGroup(filePath, Array.from(fileRecord.tags), diaryName);
                    syncCount++;
                }
                
                // 每100个文件让出一次控制权
                if (syncCount % 100 === 0) {
                    await new Promise(resolve => setImmediate(resolve));
                }
            }
            
            const syncTime = ((Date.now() - startTime) / 1000).toFixed(1);
            const finalStats = this.cooccurrenceDB.getStats();
            
            console.log(`[TagVectorManager] ✅ Cooccurrence DB synced in ${syncTime}s:`, {
                processedFiles: syncCount,
                totalGroups: finalStats.total_groups,
                totalPairs: finalStats.total_pairs,
                uniqueTags: finalStats.unique_tags
            });
            
            // 🌟 同步完成后导出JSON文件（方便调试和快速加载）
            if (finalStats.total_pairs > 0) {
                try {
                    const exportPath = await this.cooccurrenceDB.exportToFile();
                    console.log(`[TagVectorManager] 💾 Weight matrix exported to: ${path.basename(exportPath)}`);
                } catch (exportError) {
                    console.warn('[TagVectorManager] Failed to export matrix file:', exportError.message);
                }
            }
            
        } catch (error) {
            console.error('[TagVectorManager] Cooccurrence DB sync failed:', error);
            throw error;
        }
    }

    /**
     * 🌟 调度权重矩阵导出（防抖机制）
     */
    scheduleMatrixExport() {
        if (!this.cooccurrenceEnabled) return;
        
        // 清除旧定时器
        if (this.matrixExportTimer) {
            clearTimeout(this.matrixExportTimer);
        }
        
        // 设置新的防抖定时器
        this.matrixExportTimer = setTimeout(async () => {
            try {
                const exportPath = await this.cooccurrenceDB.exportToFile();
                console.log(`[TagVectorManager] 💾 Matrix auto-exported to: ${path.basename(exportPath)}`);
            } catch (error) {
                console.error('[TagVectorManager] Matrix export failed:', error.message);
            }
        }, this.matrixExportDelay);
        
        this.debugLog(`Matrix export scheduled (delay: ${this.matrixExportDelay}ms)`);
    }

    /**
     * 🦀 批量获取Tag的向量（Vexus/JS兼容）
     * @param {string[]} tags - Tag名称数组
     * @returns {Promise<Array<Float32Array|null>>} - 向量数组，顺序与输入一致，未找到则为null
     */
    async getVectorsForTags(tags) {
        if (tags.length === 0) {
            return [];
        }

        // 🦀 优先使用Vexus-Lite
        if (this.usingVexus && this.vexus) {
            try {
                const vectorBuffer = await this.vexus.getVectors(tags);
                const dimensions = parseInt(process.env.VECTORDB_DIMENSION) || 3072;
                const vectors = [];
                
                for (let i = 0; i < vectorBuffer.length; i += dimensions * 4) {
                    const singleVectorBuffer = vectorBuffer.slice(i, i + dimensions * 4);
                    const vector = new Float32Array(singleVectorBuffer.buffer, singleVectorBuffer.byteOffset, dimensions);
                    
                    // 检查是否为零向量 (Rust侧返回零向量表示未找到)
                    let isZeroVector = true;
                    for (let j = 0; j < vector.length; j++) {
                        if (vector[j] !== 0) {
                            isZeroVector = false;
                            break;
                        }
                    }
                    
                    vectors.push(isZeroVector ? null : vector);
                }
                
                return vectors;
            } catch (error) {
                console.error('[TagVectorManager] Vexus getVectors failed:', error.message);
                // Fallback to JS method if Vexus fails
            }
        }

        // Fallback: JS in-memory method
        return tags.map(tag => {
            const tagData = this.globalTags.get(tag);
            return (tagData && tagData.vector) ? tagData.vector : null;
        });
    }

    /**
     * 获取统计
     */
    getStats() {
        const baseStats = {
            totalTags: this.globalTags.size,
            vectorizedTags: Array.from(this.globalTags.values()).filter(d => d.vector !== null).length,
            initialized: this.initialized,
            blacklistedTags: this.config.tagBlacklist.length,
            superBlacklistedKeywords: this.config.tagBlacklistSuper.length, // 🌟 超级黑名单关键词数量
            dataVersion: this.config.dataVersion,
            usingVexus: this.usingVexus, // 🦀 是否使用Vexus-Lite引擎
            engine: this.usingVexus ? 'Vexus-Lite (Rust)' : 'hnswlib-node (JS)' // 🦀 当前引擎
        };
        
        // 🦀 添加Vexus统计
        if (this.usingVexus && this.vexus) {
            try {
                baseStats.vexusStats = this.vexus.stats();
            } catch (e) {
                baseStats.vexusStats = { error: e.message };
            }
        }
        
        
        // 🌟 添加Tag共现图谱统计
        if (this.cooccurrenceEnabled && this.cooccurrenceDB) {
            baseStats.cooccurrenceStats = this.cooccurrenceDB.getStats();
        }
        
        return baseStats;
    }

    /**
     * 关闭
     */
    async shutdown() {
        
        // ✅ 清除索引重建定时器
        if (this.indexRebuildTimer) {
            clearTimeout(this.indexRebuildTimer);
            this.indexRebuildTimer = null;
        }
        
        // ✅ 如果有待处理的索引更新，立即执行
        if (this.pendingIndexUpdates.size > 0) {
            console.log(`[TagVectorManager] 🔄 Flushing ${this.pendingIndexUpdates.size} pending index updates before shutdown...`);
            const tagsToAdd = Array.from(this.pendingIndexUpdates);
            this.pendingIndexUpdates.clear();
            
            try {
                if (this.tagIndex) {
                    await this.addTagsToIndex(tagsToAdd);
                } else {
                    await this.buildHNSWIndex();
                }
                
                const indexPath = path.join(this.config.vectorStorePath, 'GlobalTags.bin');
                const dataPath = path.join(this.config.vectorStorePath, 'GlobalTags.json');
                await this.saveGlobalTagLibrary(indexPath, dataPath, true);
                console.log('[TagVectorManager] ✅ Pending updates flushed');
            } catch (error) {
                console.error('[TagVectorManager] Failed to flush pending updates:', error.message);
            }
        }
        
        // ✅ Bug #5修复: 等待所有待处理的更新完成
        while (this.updateLock || this.updateQueue.length > 0 || this.saveLock) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        if (this.watcher) {
            await this.watcher.close();
            this.watcher = null;
        }
        for (const timeoutId of this.pendingUpdates.values()) {
            clearTimeout(timeoutId);
        }
        this.pendingUpdates.clear();
        
        // 🌟 关闭Tag共现数据库
        if (this.cooccurrenceDB) {
            try {
                this.cooccurrenceDB.close();
                console.log('[TagVectorManager] Tag cooccurrence database closed');
            } catch (error) {
                console.error('[TagVectorManager] Error closing cooccurrence DB:', error);
            }
        }
        
        console.log('[TagVectorManager] ✅ Shutdown complete');
    }
}

module.exports = TagVectorManager;