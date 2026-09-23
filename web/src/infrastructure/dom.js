/**
 * infrastructure/dom.js — DOM 元素引用缓存
 * 集中管理原 IIFE 中散落的 60+ 个 getElementById 调用
 * 在 10-config-state.js 的 DOMContentLoaded 中调用 initDom() 初始化，其他模块通过 import { dom } 使用
 */

export const dom = {};

/** 初始化所有 DOM 引用（在 DOMContentLoaded 后调用） */
export function initDom() {
    const get = (id) => document.getElementById(id);
    const qsa = (sel) => document.querySelectorAll(sel);

    // 音频元素
    dom.audio = get('audioPlayer');

    // 播放控制
    dom.playBtn = get('playBtn');
    dom.playIcon = get('playIcon');
    dom.prevBtn = get('prevBtn');
    dom.nextBtn = get('nextBtn');
    dom.playModeBtn = get('playModeBtn');
    dom.playModeIcon = get('playModeIcon');

    // 进度条
    dom.progressEl = get('progress');
    dom.progressTrack = get('progressTrack');
    dom.currentTimeEl = get('currentTime');
    dom.totalTimeEl = get('totalTime');

    // 音量
    dom.volumeTrack = get('volumeTrack');
    dom.volumeBar = get('volumeBar');
    dom.volumeIcon = get('volumeIcon');

    // 封面 & 歌曲信息
    dom.songCover = get('songCover');
    dom.songCover2 = get('songCover2');
    dom.songTitleEl = get('songTitle');
    dom.songArtistEl = get('songArtist');

    // 文件加载
    dom.loadMusicBtn = get('loadMusicBtn');
    dom.musicFileInput = get('musicFileInput');

    // 搜索
    dom.searchInput = get('searchInput');
    dom.searchBtn = get('searchBtn');
    dom.searchResultsEl = get('searchResults');
    dom.sourceBtns = qsa('.source-btn');
    dom.searchOverlay = get('searchOverlay');
    dom.openSearchBtn = get('openSearchBtn');
    dom.searchCloseBtn = get('searchCloseBtn');
    dom.searchHintEl = get('searchHint');
    dom.searchPlayAllBtn = get('searchPlayAllBtn');

    // 收藏
    dom.favoriteBtn = get('favoriteBtn');
    dom.openFavoritesBtn = get('openFavoritesBtn');
    dom.favoritesOverlay = get('favoritesOverlay');
    dom.favoritesCloseBtn = get('favoritesCloseBtn');
    dom.favoritesListEl = get('favoritesList');
    dom.favoritesHintEl = get('favoritesHint');

    // 歌单
    dom.playlistsOverlay = get('playlistsOverlay');
    dom.playlistsListEl = get('playlistsList');
    dom.playlistsHintEl = get('playlistsHint');
    dom.playlistsTitleEl = get('playlistsTitle');
    dom.playlistCreateBox = get('playlistCreateBox');
    dom.playlistNameInput = get('playlistNameInput');
    dom.playlistCreateConfirmBtn = get('playlistCreateConfirmBtn');
    dom.playlistBackBtn = get('playlistBackBtn');
    dom.playlistAiAnalyzeBtn = get('playlistAiAnalyzeBtn');
    dom.playlistAiProgress = get('playlistAiProgress');
    dom.playlistAiProgressFill = get('playlistAiProgressFill');
    dom.playlistAiProgressText = get('playlistAiProgressText');

    // 添加到歌单
    dom.addToPlaylistOverlay = get('addToPlaylistOverlay');
    dom.addToPlaylistListEl = get('addToPlaylistList');
    dom.addToPlaylistCloseBtn = get('addToPlaylistCloseBtn');

    // 导入歌单
    dom.importPlaylistOverlay = get('importPlaylistOverlay');
    dom.importUrlInput = get('importUrlInput');
    dom.importConfirmBtn = get('importConfirmBtn');
    dom.importPlaylistCloseBtn = get('importPlaylistCloseBtn');
    dom.importHint = get('importHint');
    dom.importProgressWrap = get('importProgressWrap');
    dom.importProgressFill = get('importProgressFill');
    dom.importProgressText = get('importProgressText');

    // 右键菜单 & 确认框
    dom.ctxMenu = get('ctxMenu');
    dom.ctxConfirm = get('ctxConfirm');
    dom.ctxConfirmTitle = get('ctxConfirmTitle');
    dom.ctxConfirmMsg = get('ctxConfirmMsg');
    dom.ctxConfirmOk = get('ctxConfirmOk');
    dom.ctxConfirmCancel = get('ctxConfirmCancel');
    dom.moreBtn = get('moreBtn');

    // 均衡器
    dom.eqPanel = get('eqPanel');
    dom.eqBands = get('eqBands');
    dom.eqPresets = get('eqPresets');
    dom.eqTitle = get('eqTitle');

    // AI 面板
    dom.aiStatusPanel = get('aiStatusPanel');
    dom.aiStatusText = get('aiStatusText');

    // 设置面板
    dom.settingsOverlay = get('settingsOverlay');
    dom.openSettingsBtn = get('openSettingsBtn');
    dom.settingsCloseBtn = get('settingsCloseBtn');
    dom.settingsTabs = get('settingsTabs');
    dom.settingsBody = get('settingsBody');

    // 背景
    dom.blurBackground = get('blurBackground');
    dom.blurBackground2 = get('blurBackground2');
    dom.colorOverlay = get('colorOverlay');

    // 歌词容器
    dom.lyricsContainer = document.querySelector('.lyrics-container');
    dom.lyricsScroll = get('lyricsScroll');

    // 欢迎页
    dom.welcomeOverlay = get('welcomeOverlay');
    dom.welcomeBtn = get('welcomeBtn');

    // 取色器
    dom.colorPickerOverlay = get('colorPickerOverlay');
    dom.colorPickerCloseBtn = get('colorPickerCloseBtn');
    dom.colorPickerTitleText = get('colorPickerTitleText');
    dom.colorPickerHex = get('colorPickerHex');
    dom.hsvPreview = get('hsvPreview');
    dom.hsvSvCanvas = get('hsvSvCanvas');
    dom.hsvHueCanvas = get('hsvHueCanvas');

    // 视图模式
    dom.openViewModeBtn = get('openViewModeBtn');
    dom.viewModeOverlay = get('viewModeOverlay');
}

/** 获取模糊背景层（双层交叉淡入淡出） */
export function getBlurBgLayers() {
    return [dom.blurBackground, dom.blurBackground2].filter(Boolean);
}

/** 获取封面层（双层交叉淡入淡出） */
export function getCoverLayers() {
    return [dom.songCover, dom.songCover2].filter(Boolean);
}
