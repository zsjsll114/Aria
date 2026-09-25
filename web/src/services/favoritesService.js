/* ============================================================
 * ⚠ 封存：未接线模块（从入口 web/src/app/index.js 静态不可达）
 *
 * 证据：scripts/audits/module-reachability.mjs 复扫（2026-09-25）——没有任何存活模块 import 本文件，
 *       运行期不会加载；在这里改东西不会生效。
 * 活实现：app/120-search-results.js（getFavorites / makeSongKey / saveFavorites）+ app/125-favorites.js（收藏页 UI）
 * 为什么还留着：docs/模块化重构方案.md 阶段 2-4 把本层列为目标架构，是否删除属产品决定；
 *       现按「原地冻结」处理，配套门禁见 eslint.config.mjs 的 no-restricted-imports。
 * state 双写已由 infrastructure/globalBridge.js 收口（state 是唯一存储，globalThis 同名键是视图），
 * 所以接线不再会读到初始值；但仍须逐模块从活实现重新抽取——见 core/stallDetector.js 等已接管模块的
 * 头注释：旧快照普遍缺活实现后来补的修复，直接接线等于退回旧行为。
 * ============================================================ */

/**
 * services/favoritesService.js — 收藏夹 CRUD（localStorage 持久化）
 * 纯数据操作，不依赖 DOM
 */
import { FAV_STORAGE_KEY } from '../config/constants.js';
import { logInfo, logWarn, logError } from './log.js';

export function getFavorites() {
    try {
        return JSON.parse(localStorage.getItem(FAV_STORAGE_KEY) || '[]');
    } catch (e) { return []; }
}

export function saveFavorites(list) {
    try {
        localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify(list));
    } catch (e) { logError('favoritesService', '保存收藏失败:', e); }
}

/** 生成歌曲唯一标识：在线歌曲用 source+id，本地文件用 url */
export function makeSongKey(song) {
    if (!song) return '';
    if (song.source && song.id) return `${song.source}:${song.id}`;
    return 'local:' + (song.url || song.title || '');
}
