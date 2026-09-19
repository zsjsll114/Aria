/* ============================================================
 * 30-dom-refs.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 587-3893 行 | 单元数: 33
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */

const playBtn = typeof document !== 'undefined' ? document.getElementById('playBtn') : null;

const playIcon = typeof document !== 'undefined' ? document.getElementById('playIcon') : null;

const prevBtn = typeof document !== 'undefined' ? document.getElementById('prevBtn') : null;

const nextBtn = typeof document !== 'undefined' ? document.getElementById('nextBtn') : null;

const playModeBtn = typeof document !== 'undefined' ? document.getElementById('playModeBtn') : null;

const playModeIcon = typeof document !== 'undefined' ? document.getElementById('playModeIcon') : null;

const progressEl = typeof document !== 'undefined' ? document.getElementById('progress') : null;

const progressTrack = typeof document !== 'undefined' ? document.getElementById('progressTrack') : null;

const currentTimeEl = typeof document !== 'undefined' ? document.getElementById('currentTime') : null;

const totalTimeEl = typeof document !== 'undefined' ? document.getElementById('totalTime') : null;

const volumeTrack = typeof document !== 'undefined' ? document.getElementById('volumeTrack') : null;

const volumeBar = typeof document !== 'undefined' ? document.getElementById('volumeBar') : null;

const volumeIcon = typeof document !== 'undefined' ? document.getElementById('volumeIcon') : null;

const songCover = typeof document !== 'undefined' ? document.getElementById('songCover') : null;

const songCover2 = typeof document !== 'undefined' ? document.getElementById('songCover2') : null;

const songTitleEl = typeof document !== 'undefined' ? document.getElementById('songTitle') : null;

const songArtistEl = typeof document !== 'undefined' ? document.getElementById('songArtist') : null;

const loadMusicBtn = typeof document !== 'undefined' ? document.getElementById('loadMusicBtn') : null;

const musicFileInput = typeof document !== 'undefined' ? document.getElementById('musicFileInput') : null;

const searchInput = typeof document !== 'undefined' ? document.getElementById('searchInput') : null;

const searchBtn = typeof document !== 'undefined' ? document.getElementById('searchBtn') : null;

const searchResultsEl = typeof document !== 'undefined' ? document.getElementById('searchResults') : null;

const sourceBtns = typeof document !== 'undefined' ? document.querySelectorAll('.source-btn') : null;

const searchOverlay = typeof document !== 'undefined' ? document.getElementById('searchOverlay') : null;

const openSearchBtn = typeof document !== 'undefined' ? document.getElementById('openSearchBtn') : null;

const searchCloseBtn = typeof document !== 'undefined' ? document.getElementById('searchCloseBtn') : null;

const favoriteBtn = typeof document !== 'undefined' ? document.getElementById('favoriteBtn') : null;

const openFavoritesBtn = typeof document !== 'undefined' ? document.getElementById('openFavoritesBtn') : null;

const favoritesOverlay = typeof document !== 'undefined' ? document.getElementById('favoritesOverlay') : null;

const favoritesCloseBtn = typeof document !== 'undefined' ? document.getElementById('favoritesCloseBtn') : null;

const favoritesListEl = typeof document !== 'undefined' ? document.getElementById('favoritesList') : null;

const favoritesHintEl = typeof document !== 'undefined' ? document.getElementById('favoritesHint') : null;

const openPlaylistsBtn = typeof document !== 'undefined' ? document.getElementById('openPlaylistsBtn') : null;

export { currentTimeEl, favoriteBtn, favoritesCloseBtn, favoritesHintEl, favoritesListEl, favoritesOverlay, loadMusicBtn, musicFileInput, nextBtn, openFavoritesBtn, openPlaylistsBtn, openSearchBtn, playBtn, playIcon, playModeBtn, playModeIcon, prevBtn, progressEl, progressTrack, searchBtn, searchCloseBtn, searchInput, searchOverlay, searchResultsEl, songArtistEl, songCover, songCover2, songTitleEl, sourceBtns, totalTimeEl, volumeBar, volumeIcon, volumeTrack };
