// VectorDBStorage.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs').promises;

/**
 * SQLite存储层 - 管理向量数据库的所有持久化操作
 */
class VectorDBStorage {
    constructor(storePath) {
        this.dbPath = path.join(storePath, 'vectordb.sqlite');
        this.db = null;
        this.storePath = storePath;
    }

    /**
     * ✅ 确保数据库已初始化
     * @private
     */
    _ensureInitialized() {
        if (!this.db) {
            throw new Error('[VectorDBStorage] Database not initialized. Call initialize() first.');
        }
    }

    /**
     * 初始化数据库连接和表结构
     */
    async initialize() {
        console.log('[VectorDBStorage] Initializing SQLite database...');
        
        // 确保目录存在
        await fs.mkdir(this.storePath, { recursive: true });
        
        // 打开数据库连接（启用WAL模式提升并发性能）
        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('cache_size = -64000'); // 64MB缓存
        this.db.pragma('temp_store = MEMORY');
        
        // 创建表结构
        this.createTables();
        
        // ✅ 执行数据库迁移（移除旧约束）
        this.migrateDatabase();
        
        console.log('[VectorDBStorage] Database initialized successfully.');
    }

    /**
     * 创建所有必需的表
     */
    createTables() {
        // 日记本元信息表
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS diaries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                vector_count INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_diaries_name ON diaries(name);
            CREATE INDEX IF NOT EXISTS idx_diaries_updated ON diaries(updated_at);
        `);

        // 文件哈希记录表
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                diary_id INTEGER NOT NULL,
                filename TEXT NOT NULL,
                file_hash TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (diary_id) REFERENCES diaries(id) ON DELETE CASCADE,
                UNIQUE(diary_id, filename)
            );
            CREATE INDEX IF NOT EXISTS idx_files_diary ON files(diary_id);
            CREATE INDEX IF NOT EXISTS idx_files_hash ON files(file_hash);
        `);

        // 文本块存储表
        // ✅ 修复：移除chunk_hash的UNIQUE约束，允许同一日记本不同日期有相同内容
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                diary_id INTEGER NOT NULL,
                label INTEGER NOT NULL,
                text TEXT NOT NULL,
                source_file TEXT NOT NULL,
                chunk_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (diary_id) REFERENCES diaries(id) ON DELETE CASCADE,
                UNIQUE(diary_id, label)
            );
            CREATE INDEX IF NOT EXISTS idx_chunks_diary ON chunks(diary_id);
            CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(diary_id, chunk_hash);
            CREATE INDEX IF NOT EXISTS idx_chunks_label ON chunks(diary_id, label);
        `);

        // 日记本名称向量缓存表
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS diary_name_vectors (
                diary_id INTEGER PRIMARY KEY,
                vector BLOB NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (diary_id) REFERENCES diaries(id) ON DELETE CASCADE
            );
        `);

        // 使用统计表
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS usage_stats (
                diary_id INTEGER PRIMARY KEY,
                frequency INTEGER DEFAULT 0,
                last_accessed INTEGER,
                FOREIGN KEY (diary_id) REFERENCES diaries(id) ON DELETE CASCADE
            );
        `);

        // ✅ 系统配置表（用于缓存embedding维度等全局配置）
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS system_config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
        `);

        // 失败重建记录表
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS failed_rebuilds (
                diary_name TEXT PRIMARY KEY,
                count INTEGER DEFAULT 0,
                first_attempt INTEGER,
                last_attempt INTEGER,
                last_error TEXT,
                pause_until INTEGER
            );
        `);

        // ✅ 新增：渐进式构建进度表
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS build_progress (
                diary_id INTEGER PRIMARY KEY,
                processed_files TEXT NOT NULL,
                total_files INTEGER NOT NULL,
                last_processed_file TEXT,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (diary_id) REFERENCES diaries(id) ON DELETE CASCADE
            );
        `);
    }

    /**
     * ✅ 数据库迁移：移除chunks表的UNIQUE(diary_id, chunk_hash)约束
     */
    migrateDatabase() {
        try {
            // 检查chunks表是否存在旧的UNIQUE约束
            const tableInfo = this.db.pragma('table_info(chunks)');
            const indexes = this.db.pragma('index_list(chunks)');
            
            // 查找是否有UNIQUE(diary_id, chunk_hash)约束
            let hasOldConstraint = false;
            for (const index of indexes) {
                if (index.unique === 1) {
                    const indexInfo = this.db.pragma(`index_info(${index.name})`);
                    const columns = indexInfo.map(col => col.name);
                    // 检查是否是针对chunk_hash的唯一索引
                    if (columns.includes('chunk_hash') && columns.includes('diary_id') && columns.length === 2) {
                        hasOldConstraint = true;
                        console.log(`[VectorDBStorage] Found old UNIQUE constraint on chunks table: ${index.name}`);
                        break;
                    }
                }
            }
            
            if (hasOldConstraint) {
                console.log('[VectorDBStorage] ⚠️ Migrating database: removing UNIQUE(diary_id, chunk_hash) constraint...');
                
                // SQLite不支持直接修改约束，需要重建表
                const transaction = this.db.transaction(() => {
                    // 1. 创建新表（没有旧约束）
                    this.db.exec(`
                        CREATE TABLE chunks_new (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            diary_id INTEGER NOT NULL,
                            label INTEGER NOT NULL,
                            text TEXT NOT NULL,
                            source_file TEXT NOT NULL,
                            chunk_hash TEXT NOT NULL,
                            created_at INTEGER NOT NULL,
                            FOREIGN KEY (diary_id) REFERENCES diaries(id) ON DELETE CASCADE,
                            UNIQUE(diary_id, label)
                        );
                    `);
                    
                    // 2. 复制数据
                    this.db.exec(`
                        INSERT INTO chunks_new (id, diary_id, label, text, source_file, chunk_hash, created_at)
                        SELECT id, diary_id, label, text, source_file, chunk_hash, created_at
                        FROM chunks;
                    `);
                    
                    // 3. 删除旧表
                    this.db.exec('DROP TABLE chunks;');
                    
                    // 4. 重命名新表
                    this.db.exec('ALTER TABLE chunks_new RENAME TO chunks;');
                    
                    // 5. 重建索引
                    this.db.exec(`
                        CREATE INDEX IF NOT EXISTS idx_chunks_diary ON chunks(diary_id);
                        CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(diary_id, chunk_hash);
                        CREATE INDEX IF NOT EXISTS idx_chunks_label ON chunks(diary_id, label);
                    `);
                });
                
                transaction();
                console.log('[VectorDBStorage] ✅ Database migration completed successfully!');
            } else {
                console.log('[VectorDBStorage] ✅ Database schema is up-to-date, no migration needed.');
            }
        } catch (error) {
            console.error('[VectorDBStorage] ❌ Database migration failed:', error);
            console.error('[VectorDBStorage] This may cause issues with duplicate content handling.');
            console.error('[VectorDBStorage] Consider manually deleting the vectordb.sqlite file and restarting.');
        }
    }

    /**
     * 获取或创建日记本ID
     */
    getOrCreateDiary(diaryName) {
        this._ensureInitialized();
        const select = this.db.prepare('SELECT id FROM diaries WHERE name = ?');
        let row = select.get(diaryName);
        
        if (!row) {
            const now = Date.now();
            const insert = this.db.prepare(
                'INSERT INTO diaries (name, created_at, updated_at) VALUES (?, ?, ?)'
            );
            const result = insert.run(diaryName, now, now);
            return result.lastInsertRowid;
        }
        
        return row.id;
    }

    /**
     * 获取日记本的文件哈希映射
     */
    getFileHashes(diaryName) {
        this._ensureInitialized();
        const diaryId = this.getOrCreateDiary(diaryName);
        const select = this.db.prepare(
            'SELECT filename, file_hash FROM files WHERE diary_id = ?'
        );
        const rows = select.all(diaryId);
        
        const hashes = {};
        for (const row of rows) {
            hashes[row.filename] = row.file_hash;
        }
        return hashes;
    }

    /**
     * 批量更新文件哈希（事务处理）
     */
    updateFileHashes(diaryName, fileHashes) {
        this._ensureInitialized();
        const diaryId = this.getOrCreateDiary(diaryName);
        const now = Date.now();
        
        const transaction = this.db.transaction(() => {
            // 删除旧记录
            const deleteStmt = this.db.prepare('DELETE FROM files WHERE diary_id = ?');
            deleteStmt.run(diaryId);
            
            // 插入新记录
            const insertStmt = this.db.prepare(
                'INSERT INTO files (diary_id, filename, file_hash, updated_at) VALUES (?, ?, ?, ?)'
            );
            
            for (const [filename, hash] of Object.entries(fileHashes)) {
                insertStmt.run(diaryId, filename, hash, now);
            }
            
            // 更新日记本的更新时间
            const updateDiary = this.db.prepare(
                'UPDATE diaries SET updated_at = ? WHERE id = ?'
            );
            updateDiary.run(now, diaryId);
        });
        
        transaction();
    }

    /**
     * 获取日记本的所有chunk映射
     */
    getChunkMap(diaryName) {
        this._ensureInitialized();
        const diaryId = this.getOrCreateDiary(diaryName);
        const select = this.db.prepare(
            'SELECT label, text, source_file, chunk_hash FROM chunks WHERE diary_id = ? ORDER BY label'
        );
        const rows = select.all(diaryId);
        
        const chunkMap = {};
        for (const row of rows) {
            chunkMap[row.label] = {
                text: row.text,
                sourceFile: row.source_file,
                chunkHash: row.chunk_hash
            };
        }
        return chunkMap;
    }

    /**
     * ✅ 高效获取chunk数量（不加载数据）
     * 专为大型数据集优化，避免加载所有chunk到内存
     */
    getChunkCount(diaryName) {
        this._ensureInitialized();
        const diaryId = this.getOrCreateDiary(diaryName);
        const select = this.db.prepare(
            'SELECT COUNT(*) as count FROM chunks WHERE diary_id = ?'
        );
        const result = select.get(diaryId);
        return result ? result.count : 0;
    }

    /**
     * 批量保存chunks（事务处理）
     */
    saveChunks(diaryName, chunkMap) {
        this._ensureInitialized();
        const diaryId = this.getOrCreateDiary(diaryName);
        const now = Date.now();
        
        const transaction = this.db.transaction(() => {
            // 删除旧chunks
            const deleteStmt = this.db.prepare('DELETE FROM chunks WHERE diary_id = ?');
            deleteStmt.run(diaryId);
            
            // 插入新chunks
            const insertStmt = this.db.prepare(
                'INSERT INTO chunks (diary_id, label, text, source_file, chunk_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)'
            );
            
            let count = 0;
            for (const [label, data] of Object.entries(chunkMap)) {
                insertStmt.run(
                    diaryId,
                    parseInt(label),
                    data.text,
                    data.sourceFile,
                    data.chunkHash,
                    now
                );
                count++;
            }
            
            // 更新向量计数
            const updateCount = this.db.prepare(
                'UPDATE diaries SET vector_count = ?, updated_at = ? WHERE id = ?'
            );
            updateCount.run(count, now, diaryId);
        });
        
        transaction();
    }

    /**
     * 删除指定label的chunks（批量）
     */
    deleteChunksByLabels(diaryName, labels) {
        if (labels.length === 0) return;
        
        const diaryId = this.getOrCreateDiary(diaryName);
        const placeholders = labels.map(() => '?').join(',');
        const deleteStmt = this.db.prepare(
            `DELETE FROM chunks WHERE diary_id = ? AND label IN (${placeholders})`
        );
        deleteStmt.run(diaryId, ...labels);
    }

    /**
     * 添加新chunks（批量）
     */
    addChunks(diaryName, chunksData) {
        if (chunksData.length === 0) return;
        
        const diaryId = this.getOrCreateDiary(diaryName);
        const now = Date.now();
        
        const transaction = this.db.transaction(() => {
            const insertStmt = this.db.prepare(
                'INSERT INTO chunks (diary_id, label, text, source_file, chunk_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)'
            );
            
            for (const chunk of chunksData) {
                insertStmt.run(
                    diaryId,
                    chunk.label,
                    chunk.text,
                    chunk.sourceFile,
                    chunk.chunkHash,
                    now
                );
            }
            
            // 更新向量计数
            const count = this.db.prepare(
                'SELECT COUNT(*) as count FROM chunks WHERE diary_id = ?'
            ).get(diaryId).count;
            
            const updateCount = this.db.prepare(
                'UPDATE diaries SET vector_count = ?, updated_at = ? WHERE id = ?'
            );
            updateCount.run(count, now, diaryId);
        });
        
        transaction();
    }

    /**
     * 根据chunk_hash查找已存在的label
     */
    findChunkByHash(diaryName, chunkHash) {
        const diaryId = this.getOrCreateDiary(diaryName);
        const select = this.db.prepare(
            'SELECT label FROM chunks WHERE diary_id = ? AND chunk_hash = ?'
        );
        const row = select.get(diaryId, chunkHash);
        return row ? row.label : null;
    }

    /**
     * 保存日记本名称向量
     */
    saveDiaryNameVectors(diaryNameVectors) {
        this._ensureInitialized();
        const transaction = this.db.transaction(() => {
            const upsert = this.db.prepare(`
                INSERT INTO diary_name_vectors (diary_id, vector, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(diary_id) DO UPDATE SET
                    vector = excluded.vector,
                    updated_at = excluded.updated_at
            `);
            
            const now = Date.now();
            for (const [diaryName, vector] of diaryNameVectors.entries()) {
                const diaryId = this.getOrCreateDiary(diaryName);
                const vectorBuffer = Buffer.from(new Float64Array(vector).buffer);
                upsert.run(diaryId, vectorBuffer, now);
            }
        });
        
        transaction();
    }

    /**
     * 加载所有日记本名称向量
     */
    loadDiaryNameVectors() {
        this._ensureInitialized();
        const select = this.db.prepare(`
            SELECT d.name, v.vector
            FROM diary_name_vectors v
            JOIN diaries d ON v.diary_id = d.id
        `);
        const rows = select.all();
        
        const vectors = new Map();
        for (const row of rows) {
            const buffer = Buffer.from(row.vector);
            const vector = Array.from(new Float64Array(buffer.buffer, buffer.byteOffset, buffer.length / 8));
            vectors.set(row.name, vector);
        }
        return vectors;
    }

    /**
     * 更新使用统计（批量）
     */
    updateUsageStats(statsMap) {
        this._ensureInitialized();
        const transaction = this.db.transaction(() => {
            const upsert = this.db.prepare(`
                INSERT INTO usage_stats (diary_id, frequency, last_accessed)
                VALUES (?, ?, ?)
                ON CONFLICT(diary_id) DO UPDATE SET
                    frequency = frequency + excluded.frequency,
                    last_accessed = excluded.last_accessed
            `);
            
            for (const [diaryName, stats] of statsMap.entries()) {
                const diaryId = this.getOrCreateDiary(diaryName);
                upsert.run(diaryId, stats.frequency, stats.lastAccessed);
            }
        });
        
        transaction();
    }

    /**
     * 加载使用统计
     */
    loadUsageStats() {
        this._ensureInitialized();
        const select = this.db.prepare(`
            SELECT d.name, u.frequency, u.last_accessed
            FROM usage_stats u
            JOIN diaries d ON u.diary_id = d.id
        `);
        const rows = select.all();
        
        const stats = {};
        for (const row of rows) {
            stats[row.name] = {
                frequency: row.frequency,
                lastAccessed: row.last_accessed
            };
        }
        return stats;
    }

    /**
     * 记录失败的重建
     */
    recordFailedRebuild(diaryName, errorMessage) {
        this._ensureInitialized();
        const now = Date.now();
        
        const select = this.db.prepare(
            'SELECT * FROM failed_rebuilds WHERE diary_name = ?'
        );
        const record = select.get(diaryName);
        
        if (!record) {
            const insert = this.db.prepare(`
                INSERT INTO failed_rebuilds (diary_name, count, first_attempt, last_attempt, last_error)
                VALUES (?, 1, ?, ?, ?)
            `);
            insert.run(diaryName, now, now, errorMessage);
        } else {
            const timeSpan = now - record.first_attempt;
            let pauseUntil = null;
            let newCount = record.count + 1;
            let firstAttempt = record.first_attempt;
            
            // 如果超过1小时，重置计数
            if (timeSpan > 3600000) {
                newCount = 1;
                firstAttempt = now;
            } else if (newCount >= 3) {
                // 1小时内失败3次，暂停24小时
                pauseUntil = now + 24 * 3600000;
            }
            
            const update = this.db.prepare(`
                UPDATE failed_rebuilds
                SET count = ?, first_attempt = ?, last_attempt = ?, last_error = ?, pause_until = ?
                WHERE diary_name = ?
            `);
            update.run(newCount, firstAttempt, now, errorMessage, pauseUntil, diaryName);
        }
    }

    /**
     * 加载失败重建记录
     */
    loadFailedRebuilds() {
        const select = this.db.prepare('SELECT * FROM failed_rebuilds');
        const rows = select.all();
        
        const failedRebuilds = new Map();
        for (const row of rows) {
            failedRebuilds.set(row.diary_name, {
                count: row.count,
                firstAttempt: row.first_attempt,
                lastAttempt: row.last_attempt,
                lastError: row.last_error,
                pauseUntil: row.pause_until
            });
        }
        return failedRebuilds;
    }

    /**
     * 检查是否在暂停期
     */
    isRebuildPaused(diaryName) {
        this._ensureInitialized();
        const select = this.db.prepare(
            'SELECT pause_until FROM failed_rebuilds WHERE diary_name = ?'
        );
        const row = select.get(diaryName);
        
        if (!row || !row.pause_until) return false;
        return Date.now() < row.pause_until;
    }

    /**
     * 清除失败重建记录（重建成功后调用）
     */
    clearFailedRebuild(diaryName) {
        this._ensureInitialized();
        const deleteStmt = this.db.prepare(
            'DELETE FROM failed_rebuilds WHERE diary_name = ?'
        );
        deleteStmt.run(diaryName);
        console.log(`[VectorDBStorage] Cleared failed rebuild record for "${diaryName}"`);
    }

    /**
     * ✅ 保存渐进式构建进度
     */
    saveBuildProgress(diaryName, processedFiles, totalFiles, lastProcessedFile) {
        this._ensureInitialized();
        const diaryId = this.getOrCreateDiary(diaryName);
        const now = Date.now();
        
        const upsert = this.db.prepare(`
            INSERT INTO build_progress (diary_id, processed_files, total_files, last_processed_file, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(diary_id) DO UPDATE SET
                processed_files = excluded.processed_files,
                total_files = excluded.total_files,
                last_processed_file = excluded.last_processed_file,
                updated_at = excluded.updated_at
        `);
        
        upsert.run(diaryId, JSON.stringify(processedFiles), totalFiles, lastProcessedFile, now);
    }

    /**
     * ✅ 获取渐进式构建进度
     */
    getBuildProgress(diaryName) {
        this._ensureInitialized();
        const diaryId = this.getOrCreateDiary(diaryName);
        const select = this.db.prepare(
            'SELECT * FROM build_progress WHERE diary_id = ?'
        );
        const row = select.get(diaryId);
        
        if (!row) return null;
        
        return {
            processedFiles: JSON.parse(row.processed_files),
            totalFiles: row.total_files,
            lastProcessedFile: row.last_processed_file,
            updatedAt: row.updated_at
        };
    }

    /**
     * ✅ 清除构建进度（构建完成后调用）
     */
    clearBuildProgress(diaryName) {
        this._ensureInitialized();
        const diaryId = this.getOrCreateDiary(diaryName);
        const deleteStmt = this.db.prepare(
            'DELETE FROM build_progress WHERE diary_id = ?'
        );
        deleteStmt.run(diaryId);
    }

    /**
     * ✅ 保存embedding维度到缓存
     */
    saveEmbeddingDimensions(dimensions) {
        this._ensureInitialized();
        const now = Date.now();
        const upsert = this.db.prepare(`
            INSERT INTO system_config (key, value, updated_at)
            VALUES ('embedding_dimensions', ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
        `);
        upsert.run(String(dimensions), now);
        console.log(`[VectorDBStorage] Cached embedding dimensions: ${dimensions}`);
    }

    /**
     * ✅ 从缓存加载embedding维度
     */
    getEmbeddingDimensions() {
        this._ensureInitialized();
        const select = this.db.prepare(
            'SELECT value FROM system_config WHERE key = ?'
        );
        const row = select.get('embedding_dimensions');
        return row ? parseInt(row.value) : null;
    }

    /**
     * 删除日记本的所有数据
     */
    deleteDiary(diaryName) {
        this._ensureInitialized();
        const select = this.db.prepare('SELECT id FROM diaries WHERE name = ?');
        const row = select.get(diaryName);
        
        if (!row) return;
        
        // CASCADE会自动删除关联的所有数据
        const deleteStmt = this.db.prepare('DELETE FROM diaries WHERE id = ?');
        deleteStmt.run(row.id);
    }

    /**
     * 获取所有日记本名称
     */
    getAllDiaryNames() {
        this._ensureInitialized();
        const select = this.db.prepare('SELECT name FROM diaries ORDER BY name');
        const rows = select.all();
        return rows.map(row => row.name);
    }

    /**
     * 获取数据库统计信息
     */
    getStats() {
        this._ensureInitialized();
        const diaryCount = this.db.prepare('SELECT COUNT(*) as count FROM diaries').get().count;
        const chunkCount = this.db.prepare('SELECT COUNT(*) as count FROM chunks').get().count;
        const fileCount = this.db.prepare('SELECT COUNT(*) as count FROM files').get().count;
        
        return {
            diaryCount,
            chunkCount,
            fileCount,
            dbSize: this.getDbSize()
        };
    }

    /**
     * 获取数据库文件大小
     */
    getDbSize() {
        try {
            const stats = require('fs').statSync(this.dbPath);
            return stats.size;
        } catch (e) {
            return 0;
        }
    }

    /**
     * 优化数据库（清理碎片）
     */
    optimize() {
        this._ensureInitialized();
        console.log('[VectorDBStorage] Optimizing database...');
        this.db.pragma('optimize');
        this.db.exec('VACUUM');
        console.log('[VectorDBStorage] Database optimized.');
    }

    /**
     * 关闭数据库连接
     */
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
            console.log('[VectorDBStorage] Database connection closed.');
        }
    }
}

module.exports = VectorDBStorage;