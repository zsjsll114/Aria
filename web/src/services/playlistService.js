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
