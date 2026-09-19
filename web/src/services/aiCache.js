/**
 * services/aiCache.js — AI 分析结果 IndexedDB 持久化缓存
 * 解决 localStorage 5MB 限制
 * 本文件是 LyricsPlayerDB（AI_DB_NAME）唯一属主：upgrade 阶段幂等创建
 * aiThemeCache + chorusCache 双 store。★勿再在其它模块内另开 indexedDB.open，
 * 否则并发 open 竞争会漏建 store（历史上 chorusCache 缺失即由此而来）。
 */
import { AI_DB_NAME, AI_DB_VERSION, AI_STORE_NAME } from '../config/constants.js';
import { logInfo, logWarn, logError } from './log.js';

/* 高潮检测缓存 store（v4 起统一在本文件创建，不再由 200-settings-panel 私建） */
const CHORUS_STORE_NAME = 'chorusCache';

let aiDbReady = null;

/** 获取 IndexedDB 连接（懒初始化，幂等建库：两个 store 缺哪个补哪个） */
function getAiDb() {
    if (aiDbReady) return aiDbReady;
    aiDbReady = new Promise((resolve, reject) => {
        if (!window.indexedDB) {
            reject(new Error('IndexedDB not supported'));
            return;
        }
        const req = indexedDB.open(AI_DB_NAME, AI_DB_VERSION);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(AI_STORE_NAME)) {
                db.createObjectStore(AI_STORE_NAME, { keyPath: 'key' });
            }
            if (!db.objectStoreNames.contains(CHORUS_STORE_NAME)) {
                db.createObjectStore(CHORUS_STORE_NAME, { keyPath: 'key' });
            }
        };
    });
    return aiDbReady;
}

/** 从 IndexedDB 读取单条缓存 */
export async function aiCacheGet(key) {
    try {
        const db = await getAiDb();
        return new Promise((resolve) => {
            const tx = db.transaction(AI_STORE_NAME, 'readonly');
            const req = tx.objectStore(AI_STORE_NAME).get(key);
            req.onsuccess = () => resolve(req.result ? req.result.data : null);
            req.onerror = () => resolve(null);
        });
    } catch (e) { return null; }
}

/** 写入单条缓存到 IndexedDB */
export async function aiCacheSet(key, data) {
    try {
        const db = await getAiDb();
        return new Promise((resolve) => {
            const tx = db.transaction(AI_STORE_NAME, 'readwrite');
            tx.objectStore(AI_STORE_NAME).put({ key, data, ts: Date.now() });
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        });
    } catch (e) { return false; }
}

/** 获取所有缓存（用于导出） */
export async function aiCacheGetAll() {
    try {
        const db = await getAiDb();
        return new Promise((resolve) => {
            const tx = db.transaction(AI_STORE_NAME, 'readonly');
            const req = tx.objectStore(AI_STORE_NAME).getAll();
            req.onsuccess = () => {
                const result = {};
                for (const row of (req.result || [])) {
                    result[row.key] = row.data;
                }
                resolve(result);
            };
            req.onerror = () => resolve({});
        });
    } catch (e) { return {}; }
}

/** 批量导入缓存（用于导入配置文件） */
export async function aiCacheBulkSet(entries) {
    try {
        const db = await getAiDb();
        return new Promise((resolve) => {
            const tx = db.transaction(AI_STORE_NAME, 'readwrite');
            const store = tx.objectStore(AI_STORE_NAME);
            let count = 0;
            for (const [key, data] of Object.entries(entries)) {
                store.put({ key, data, ts: Date.now() });
                count++;
            }
            tx.oncomplete = () => { logInfo('aiCache', `AI 缓存导入 ${count} 条`); resolve(count); };
            tx.onerror = () => resolve(0);
        });
    } catch (e) { return 0; }
}

/** 清空所有缓存 */
export async function aiCacheClear() {
    try {
        const db = await getAiDb();
        return new Promise((resolve) => {
            const tx = db.transaction(AI_STORE_NAME, 'readwrite');
            tx.objectStore(AI_STORE_NAME).clear();
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        });
    } catch (e) { return false; }
}

/** 获取缓存条数 */
export async function aiCacheCount() {
    try {
        const db = await getAiDb();
        return new Promise((resolve) => {
            const tx = db.transaction(AI_STORE_NAME, 'readonly');
            const req = tx.objectStore(AI_STORE_NAME).count();
            req.onsuccess = () => resolve(req.result || 0);
            req.onerror = () => resolve(0);
        });
    } catch (e) { return 0; }
}

/* ========== 高潮检测缓存读写（v4 起从此导出，200-settings-panel 仅 import） ========== */

/** 读取单条高潮缓存 */
export async function chorusCacheGet(key) {
    try {
        const db = await getAiDb();
        return new Promise((resolve) => {
            const tx = db.transaction(CHORUS_STORE_NAME, 'readonly');
            const req = tx.objectStore(CHORUS_STORE_NAME).get(key);
            req.onsuccess = () => resolve(req.result ? req.result.data : null);
            req.onerror = () => resolve(null);
        });
    } catch (e) { return null; }
}

/** 写入单条高潮缓存 */
export async function chorusCacheSet(key, data) {
    try {
        const db = await getAiDb();
        return new Promise((resolve) => {
            const tx = db.transaction(CHORUS_STORE_NAME, 'readwrite');
            tx.objectStore(CHORUS_STORE_NAME).put({ key, data, ts: Date.now() });
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        });
    } catch (e) { return false; }
}

/** 清空高潮缓存 */
export async function chorusCacheClear() {
    try {
        const db = await getAiDb();
        return new Promise((resolve) => {
            const tx = db.transaction(CHORUS_STORE_NAME, 'readwrite');
            tx.objectStore(CHORUS_STORE_NAME).clear();
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        });
    } catch (e) { return false; }
}

/** 获取高潮缓存条数 */
export async function chorusCacheCount() {
    try {
        const db = await getAiDb();
        return new Promise((resolve) => {
            const tx = db.transaction(CHORUS_STORE_NAME, 'readonly');
            const req = tx.objectStore(CHORUS_STORE_NAME).count();
            req.onsuccess = () => resolve(req.result || 0);
            req.onerror = () => resolve(0);
        });
    } catch (e) { return 0; }
}
