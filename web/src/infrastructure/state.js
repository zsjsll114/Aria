/**
 * infrastructure/state.js — 全局状态单例
 * 替代原 IIFE 闭包中的所有 let/const 变量
 * 所有模块通过 import { state } 使用，写入时直接 state.xxx = yyy
 */

export const state = {
    // ===== 播放器状态 =====
    isPlaying: false,
    currentTime: 0,            // ms
    volume: 80,
    playMode: 'sequence',      // 'sequence' | 'loop' | 'random'
    currentPlaybackRate: 1,
    preservesPitch: true,

    // ===== 歌词状态 =====
    lyrics: [],
    activeLineIndex: -1,
    lineElements: [],
    wordElementsByLine: [],
    wordHighlightElementsByLine: [],
    lastWordProgress: new Map(),
    isUserScrolling: false,
    currentScrollY: 0,
    scrollTimeout: null,
    lyricsRafId: null,
    isLyricsLoopRunning: false,

    // ===== 播放列表状态 =====
    playlist: [],
    currentTrackIndex: 0,
    isLoadingSong: false,
    playbackGeneration: 0,     // 代际控制（异步竞争保护）
    retryCount: 0,
    lastLoadedSongInfo: null,

    // ===== 歌曲标识 =====
    currentSongKey: '',
    currentSongData: null,

    // ===== 搜索状态 =====
    currentSource: 'tencent',  // 'tencent' | 'netease'
    searchResultsCache: [],
    lastSearchCache: { tencent: null, netease: null },
    lastSearchKeyword: { tencent: '', netease: '' },

    // ===== AI 状态 =====
    aiThemeCache: {},
    currentAiTheme: null,
    aiEmotionWords: [],
    isAiAnalyzing: false,
    currentAiAbortController: null,

    // ===== 均衡器状态 =====
    audioCtx: null,
    eqSourceNode: null,
    eqFilterNodes: [],
    eqGains: new Array(10).fill(0),
    eqActivePreset: '默认',
    eqInited: false,
    eqInitFailed: false,

    // ===== 卡死检测状态 =====
    stallTimer: null,
    isBuffering: false,
    stallLastTime: 0,
    stallCheckGeneration: 0,

    // ===== 淡入淡出状态 =====
    fadeOutVolumeRafId: null,
    fadeOutVolumeTimeoutId: null,
    fadeInVolumeRafId: null,
    fadeInVolumeTimeoutId: null,

    // ===== 进度条缓存 =====
    lastPercent: -1,
    lastFormattedTime: '',

    // ===== 右键菜单状态 =====
    ctxSubmenuEl: null,
    ctxConfirmCallback: null,
    submenuHideTimer: null,

    // ===== 初始化状态 =====
    initSongStarted: false,
    preloadedSongReady: null,
    pendingPlayAfterPreload: false,

    // ===== 歌单视图状态 =====
    playlistViewMode: 'list',  // 'list' | 'detail'
    currentPlaylistId: null,

    // ===== 自定义字体 =====
    customFonts: {},

    // ===== Blob URL 管理 =====
    blobUrls: new Set(),

    // ===== 设置（由 config/defaults.js 初始化，loadSettings 覆盖）=====
    appSettings: null,
};

/** 批量更新状态 */
export function setState(updates) {
    Object.assign(state, updates);
}
