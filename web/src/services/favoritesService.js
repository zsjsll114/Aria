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
