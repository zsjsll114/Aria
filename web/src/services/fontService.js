/* ============================================================
 * ⚠ 封存：未接线模块（从入口 web/src/app/index.js 静态不可达）
 *
 * 证据：scripts/audits/module-reachability.mjs 复扫（2026-09-25）——没有任何存活模块 import 本文件，
 *       运行期不会加载；在这里改东西不会生效。
 * 活实现：app/215-multilang-fonts.js（多语字体、自定义字体扫描与 FontFace 注册）
 * 为什么还留着：docs/模块化重构方案.md 阶段 2-4 把本层列为目标架构，是否删除属产品决定；
 *       现按「原地冻结」处理，配套门禁见 eslint.config.mjs 的 no-restricted-imports。
 * state 双写已由 infrastructure/globalBridge.js 收口（state 是唯一存储，globalThis 同名键是视图），
 * 所以接线不再会读到初始值；但仍须逐模块从活实现重新抽取——见 core/stallDetector.js 等已接管模块的
 * 头注释：旧快照普遍缺活实现后来补的修复，直接接线等于退回旧行为。
 * ============================================================ */

/**
 * services/fontService.js — 自定义字体 IndexedDB 存储
 * FontFace API 加载 + IndexedDB 持久化
 */
import { FONT_DB_NAME, FONT_STORE } from '../config/constants.js';
import { logInfo, logWarn, logError } from './log.js';

let fontDB = null;

/** 打开字体数据库 */
export function openFontDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(FONT_DB_NAME, 1);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(FONT_STORE)) {
                db.createObjectStore(FONT_STORE, { keyPath: 'key' });
            }
        };
        req.onsuccess = (e) => { fontDB = e.target.result; resolve(fontDB); };
        req.onerror = () => reject(req.error);
    });
}

/** 保存字体到 IndexedDB */
export function saveFontToDB(key, family, label, buffer) {
    return new Promise((resolve, reject) => {
        const tx = fontDB.transaction([FONT_STORE], 'readwrite');
        tx.objectStore(FONT_STORE).put({ key, family, label, buffer });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/** 获取所有已存储的字体 */
export function getAllFontsFromDB() {
    return new Promise((resolve, reject) => {
        const tx = fontDB.transaction([FONT_STORE], 'readonly');
        const req = tx.objectStore(FONT_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

/** 删除字体 */
export function deleteFontFromDB(key) {
    return new Promise((resolve, reject) => {
        const tx = fontDB.transaction([FONT_STORE], 'readwrite');
        tx.objectStore(FONT_STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/** 加载单个字体到文档 */
export async function loadFontFace(key, family, buffer) {
    try {
        const fontFace = new FontFace(family, buffer);
        await fontFace.load();
        document.fonts.add(fontFace);
        return true;
    } catch (e) {
        logError('fontService', '字体加载失败:', e);
        return false;
    }
}
