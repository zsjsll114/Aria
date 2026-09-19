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
