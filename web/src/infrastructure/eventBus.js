/**
 * infrastructure/eventBus.js — 轻量级事件总线
 * 替代原 IIFE 内函数间的直接调用，实现模块解耦
 * 各模块通过 eventBus.on() 订阅、eventBus.emit() 发布
 */

const listeners = new Map();

export const eventBus = {
    /** 订阅事件，返回取消订阅函数 */
    on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(handler);
        return () => listeners.get(event)?.delete(handler);
    },

    /** 订阅一次（触发后自动取消） */
    once(event, handler) {
        const unsub = this.on(event, (...args) => {
            unsub();
            handler(...args);
        });
        return unsub;
    },

    /** 发布事件 */
    emit(event, ...args) {
        const handlers = listeners.get(event);
        if (handlers) handlers.forEach(h => h(...args));
    },

    /** 取消订阅 */
    off(event, handler) {
        listeners.get(event)?.delete(handler);
    },
};

/** 预定义事件清单 — 作为约定，各模块按此通信 */
export const EVENTS = {
    // 音频事件
    SONG_LOADING:        'song:loading',        // { songInfo } 开始加载歌曲
    SONG_LOADED:         'song:loaded',          // { songData } 歌曲加载完成
    SONG_CHANGED:        'song:changed',         // { songData } 当前歌曲切换
    PLAY:                'audio:play',           // 播放开始
    PAUSE:               'audio:pause',          // 播放暂停
    ENDED:               'audio:ended',          // 播放结束
    TIME_UPDATE:         'audio:timeupdate',     // { currentTime } 时间更新
    PLAYBACK_ERROR:      'audio:error',          // { error } 播放错误/卡死
    STALL_DETECTED:      'audio:stall',          // 检测到卡死

    // 播放列表事件
    TRACK_CHANGED:       'playlist:trackChanged', // { index } 当前曲目索引变化
    PLAYLIST_UPDATED:    'playlist:updated',      // { playlist } 播放列表内容变化

    // 歌词事件
    LYRICS_LOADED:       'lyrics:loaded',        // { lyrics } 歌词解析完成
    LYRICS_RENDERED:     'lyrics:rendered',      // 歌词 DOM 渲染完成
    ACTIVE_LINE_CHANGED: 'lyrics:lineChanged',   // { oldIndex, newIndex } 高亮行变化

    // 收藏/歌单事件
    FAVORITES_UPDATED:   'favorites:updated',    // 收藏列表变化
    PLAYLISTS_UPDATED:   'playlists:updated',    // 歌单列表变化

    // 设置事件
    SETTINGS_LOADED:     'settings:loaded',      // 设置从 localStorage 加载完成
    SETTINGS_CHANGED:    'settings:changed',     // { key, value } 设置项变化
    SETTINGS_APPLIED:    'settings:applied',     // applyAllSettings 完成

    // AI 事件
    AI_ANALYSIS_START:   'ai:analysisStart',     // { songKey } 开始 AI 分析
    AI_ANALYSIS_DONE:    'ai:analysisDone',      // { songKey, theme } 分析完成
    AI_ANALYSIS_ERROR:   'ai:analysisError',     // { songKey, error } 分析失败
    AI_THEME_APPLIED:    'ai:themeApplied',      // { theme } 主题已应用

    // UI 事件
    VIEW_MODE_CHANGED:   'ui:viewModeChanged',   // { mode } 视图模式切换
    SEARCH_OPENED:       'ui:searchOpened',
    SEARCH_CLOSED:       'ui:searchClosed',
    SETTINGS_OPENED:     'ui:settingsOpened',
    SETTINGS_CLOSED:     'ui:settingsClosed',

    // 性能事件
    PERFORMANCE_CHANGED: 'perf:changed',         // { level } 性能等级变化
};
