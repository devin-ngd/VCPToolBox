/**
 * FileLock - 简单的文件锁实现
 * 防止并发写入导致数据损坏
 */

const fs = require('fs').promises;
const path = require('path');

class FileLock {
    constructor(lockDir = './data') {
        this.lockDir = lockDir;
        this.locks = new Map(); // 内存中跟踪锁状态
    }

    /**
     * 获取锁文件路径
     */
    _getLockPath(resourceName) {
        return path.join(this.lockDir, `.${resourceName}.lock`);
    }

    /**
     * 尝试获取锁
     * @param {string} resourceName - 资源名称（如 'todos'）
     * @param {number} timeout - 超时时间（毫秒），默认 5000ms
     * @param {number} retryInterval - 重试间隔（毫秒），默认 50ms
     * @returns {Promise<string>} 锁ID
     */
    async acquire(resourceName, timeout = 5000, retryInterval = 50) {
        const lockPath = this._getLockPath(resourceName);
        const lockId = `${process.pid}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const startTime = Date.now();

        // 确保锁目录存在
        await fs.mkdir(this.lockDir, { recursive: true });

        while (Date.now() - startTime < timeout) {
            try {
                // 尝试创建锁文件（wx 标志表示如果文件存在则失败）
                await fs.writeFile(lockPath, JSON.stringify({
                    lockId: lockId,
                    pid: process.pid,
                    acquiredAt: new Date().toISOString()
                }), { flag: 'wx' });

                // 成功获取锁
                this.locks.set(resourceName, { lockId, lockPath });
                return lockId;

            } catch (error) {
                if (error.code === 'EEXIST') {
                    // 锁文件已存在，检查是否为僵尸锁
                    try {
                        const lockContent = await fs.readFile(lockPath, 'utf-8');
                        const lockInfo = JSON.parse(lockContent);
                        const lockAge = Date.now() - new Date(lockInfo.acquiredAt).getTime();

                        // 如果锁超过 30 秒，认为是僵尸锁，强制清除
                        if (lockAge > 30000) {
                            console.error(`[FileLock] 检测到僵尸锁 (${resourceName})，年龄: ${lockAge}ms，强制清除`);
                            await this._forceRelease(resourceName);
                            continue;
                        }
                    } catch (readError) {
                        // 读取锁文件失败，可能正在被删除，继续重试
                    }

                    // 等待后重试
                    await this._sleep(retryInterval);
                } else {
                    throw error;
                }
            }
        }

        throw new Error(`[FileLock] 获取锁超时: ${resourceName} (${timeout}ms)`);
    }

    /**
     * 释放锁
     * @param {string} resourceName - 资源名称
     * @param {string} lockId - 锁ID（可选，用于验证）
     */
    async release(resourceName, lockId = null) {
        const lockInfo = this.locks.get(resourceName);

        if (!lockInfo) {
            console.warn(`[FileLock] 尝试释放未持有的锁: ${resourceName}`);
            return;
        }

        // 如果提供了 lockId，验证是否匹配
        if (lockId && lockInfo.lockId !== lockId) {
            console.warn(`[FileLock] 锁ID不匹配: ${resourceName}, 期望 ${lockInfo.lockId}, 实际 ${lockId}`);
            return;
        }

        try {
            await fs.unlink(lockInfo.lockPath);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error(`[FileLock] 释放锁失败: ${resourceName}`, error);
            }
        } finally {
            this.locks.delete(resourceName);
        }
    }

    /**
     * 强制释放锁（清理僵尸锁）
     */
    async _forceRelease(resourceName) {
        const lockPath = this._getLockPath(resourceName);
        try {
            await fs.unlink(lockPath);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
    }

    /**
     * 在锁保护下执行操作
     * @param {string} resourceName - 资源名称
     * @param {Function} fn - 要执行的异步函数
     * @param {number} timeout - 获取锁的超时时间
     * @returns {Promise<any>} 函数执行结果
     */
    async withLock(resourceName, fn, timeout = 5000) {
        let lockId = null;
        try {
            lockId = await this.acquire(resourceName, timeout);
            return await fn();
        } finally {
            if (lockId) {
                await this.release(resourceName, lockId);
            }
        }
    }

    /**
     * 延迟函数
     */
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 清理所有当前进程持有的锁（进程退出时调用）
     */
    async cleanup() {
        const resources = Array.from(this.locks.keys());
        for (const resource of resources) {
            await this.release(resource);
        }
    }
}

// 创建全局单例
const fileLock = new FileLock(path.join(__dirname, 'data'));

// 进程退出时自动清理
process.on('exit', () => {
    // 同步清理（exit 事件中不能使用异步）
    const resources = Array.from(fileLock.locks.keys());
    for (const resource of resources) {
        const lockInfo = fileLock.locks.get(resource);
        try {
            require('fs').unlinkSync(lockInfo.lockPath);
        } catch (error) {
            // 忽略错误
        }
    }
});

// 处理未捕获的异常
process.on('uncaughtException', async (error) => {
    console.error('[FileLock] 未捕获异常，清理锁', error);
    await fileLock.cleanup();
});

process.on('SIGINT', async () => {
    console.log('[FileLock] 收到 SIGINT 信号，清理锁');
    await fileLock.cleanup();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('[FileLock] 收到 SIGTERM 信号，清理锁');
    await fileLock.cleanup();
    process.exit(0);
});

module.exports = fileLock;
