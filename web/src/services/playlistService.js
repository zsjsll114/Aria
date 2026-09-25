/* ============================================================
 * ⚠ 封存：未接线模块（从入口 web/src/app/index.js 静态不可达）
 *
 * 证据：scripts/audits/module-reachability.mjs 复扫（2026-09-25）——没有任何存活模块 import 本文件，
 *       运行期不会加载；在这里改东西不会生效。
 * 活实现：app/130-playlists.js（歌单页与自建平台歌单）+ app/245-playlist-manager.js（当前播放队列）
 * 为什么还留着：docs/模块化重构方案.md 阶段 2-4 把本层列为目标架构，是否删除属产品决定；
 *       现按「原地冻结」处理，配套门禁见 eslint.config.mjs 的 no-restricted-imports。
 * state 双写已由 infrastructure/globalBridge.js 收口（state 是唯一存储，globalThis 同名键是视图），
 * 所以接线不再会读到初始值；但仍须逐模块从活实现重新抽取——见 core/stallDetector.js 等已接管模块的
 * 头注释：旧快照普遍缺活实现后来补的修复，直接接线等于退回旧行为。
 * ============================================================ */

/**
 * services/playlistService.js — 歌单 CRUD（localStorage 持久化）
 * 纯数据操作，不依赖 DOM
 */
import { PLAYLIST_STORAGE_KEY } from '../config/constants.js';

export function getPlaylists() {
    try {
        return JSON.parse(localStorage.getItem(PLAYLIST_STORAGE_KEY) || '[]');
    } catch (e) { return []; }
}

export function savePlaylists(list) {
    localStorage.setItem(PLAYLIST_STORAGE_KEY, JSON.stringify(list));
}

/** 生成歌单唯一 ID */
export function generatePlaylistId() {
    return 'pl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

/** 创建新歌单（纯数据，返回新歌单列表） */
export function createPlaylistData(name) {
    const playlists = getPlaylists();
    if (playlists.some(p => p.name === name)) {
        return { success: false, error: '已存在同名歌单', playlists };
    }
    playlists.unshift({
        id: generatePlaylistId(),
        name: name,
        cover: '',
        songs: [],
        createdAt: Date.now()
    });
    savePlaylists(playlists);
    return { success: true, playlists };
}

/** 删除歌单（纯数据，返回新歌单列表） */
export function deletePlaylistData(playlistId) {
    let playlists = getPlaylists();
    playlists = playlists.filter(p => p.id !== playlistId);
    savePlaylists(playlists);
    return playlists;
}
