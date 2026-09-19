/* ============================================================
 * 130-playlists.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 3871-4691 行 | 单元数: 47
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { API_BASE, PLAYLIST_STORAGE_KEY } from '../config/constants.js';
import { escapeHtml } from '../utils/formatters.js';
import { parseNeteaseYrc } from '../parsers/yrcParser.js';
import { parseLrc } from '../parsers/lrcParser.js';
import { detectAndParseLyrics, mergeLyrics } from '../parsers/lyricMerger.js';
import { fetchKugouLyric, fetchLyricWithFallback } from '../services/musicApi.js';
import { parseEnhancedLrc, convertToEnhancedLrc } from '../services/enhancedLrcConverter.js';
import { calculateLyricMatchScore } from '../services/lyricMatcher.js';
import { localMusicManager } from './10-config-state.js';
import { audio, renderLyrics } from './20-lyrics-render.js';
import { favoritesOverlay, songArtistEl, songTitleEl, sourceBtns } from './30-dom-refs.js';
import { getLyricOffset, updateLineTimes, updateLyricOffsetUI } from './40-playback-state.js';
import { updateLyricsHighlight } from './57-wordcloud-camera.js';
import { CTX_ICONS, showCtxConfirm, showCtxMenu } from './80-context-menu.js';
import { setBlurBackground, setCoverImage } from './100-cover-background.js';
import { getFavorites, makeSongKey, saveFavorites, setHint, toggleFavCore, updateFavoriteBtn } from './120-search-results.js';
import { renderFavoritesList } from './125-favorites.js';
import { applyVolumeOnSongChange, closePlaylists, loadPlaylistTrack } from './135-crossfade.js';
import { loadOnlineSong } from './175-track-index-online.js';
import { debouncedSaveConfigToBackend, getStreamCachedAudioUrl } from './180-boot-config.js';
/* ★ 自建平台歌单（网易云/酷狗/QQ）接入歌单页 */
import { fetchStatus, selfhostEnabled, selfhostPlaylists, selfhostPlaylistSongs } from './selfhost-runtime.js';
import { logInfo, logWarn, logError } from '../services/log.js';

/* ===== 平台来源图标（src/img 官方 SVG；供各歌单列表右下角复用） ===== */
(function installPlatformIconHelper() {
  const MAP = { tencent: 'QQMusicIcon.svg', qq: 'QQMusicIcon.svg', netease: 'NeteaseMusicIcon.svg', kugou: 'KugouMusicIcon.svg', kuwo: 'KuwoMusicIcon.svg' };
  Aria.__platformIconHTML = (source, size) => {
    const file = MAP[source];
    return file ? `<img src="src/img/${file}" alt="" style="width:${size || 13}px;height:${size || 13}px;vertical-align:-2px;margin-left:5px;border-radius:2px;opacity:.9;">` : '';
  };
})();

/* ========== 歌单系统 ========== */
const playlistsOverlay = typeof document !== 'undefined' ? document.getElementById('playlistsOverlay') : null;

const playlistsListEl = typeof document !== 'undefined' ? document.getElementById('playlistsList') : null;

/* ★ 歌单面包屑共享滚动容器：7+ 种视图共用 #playlistsList，
   切换视图必须重置 scrollTop（AGENTS.md 硬约束 #4，与 258 的 resetRankScroll 同款双 rAF 兜底） */
function resetListScroll() {
    if (!playlistsListEl) return;
    if (playlistsListEl.scrollTop !== 0) playlistsListEl.scrollTop = 0;
    requestAnimationFrame(() => { try { if (playlistsListEl) playlistsListEl.scrollTop = 0; } catch (e) { /* ignore */ } });
}
if (typeof window !== 'undefined') window.resetListScroll = resetListScroll;

const playlistsHintEl = typeof document !== 'undefined' ? document.getElementById('playlistsHint') : null;

const playlistsTitleEl = typeof document !== 'undefined' ? document.getElementById('playlistsTitle') : null;

const playlistBackBtn = typeof document !== 'undefined' ? document.getElementById('playlistBackBtn') : null;

const playlistCreateBox = typeof document !== 'undefined' ? document.getElementById('playlistCreateBox') : null;

const playlistNameInput = typeof document !== 'undefined' ? document.getElementById('playlistNameInput') : null;

const playlistCreateToggleBtn = typeof document !== 'undefined' ? document.getElementById('playlistCreateToggleBtn') : null;

const playlistCreateConfirmBtn = typeof document !== 'undefined' ? document.getElementById('playlistCreateConfirmBtn') : null;

const playlistSaveQueueBtn = typeof document !== 'undefined' ? document.getElementById('playlistSaveQueueBtn') : null;

const playlistImportToggleBtn = typeof document !== 'undefined' ? document.getElementById('playlistImportToggleBtn') : null;

const importPlaylistOverlay = typeof document !== 'undefined' ? document.getElementById('importPlaylistOverlay') : null;

const importPlaylistCloseBtn = typeof document !== 'undefined' ? document.getElementById('importPlaylistCloseBtn') : null;

const importUrlInput = typeof document !== 'undefined' ? document.getElementById('importUrlInput') : null;

const importConfirmBtn = typeof document !== 'undefined' ? document.getElementById('importConfirmBtn') : null;

const importHintEl = typeof document !== 'undefined' ? document.getElementById('importHint') : null;

const importProgressWrap = typeof document !== 'undefined' ? document.getElementById('importProgressWrap') : null;

const importProgressFill = typeof document !== 'undefined' ? document.getElementById('importProgressFill') : null;

const importProgressText = typeof document !== 'undefined' ? document.getElementById('importProgressText') : null;

const addToPlaylistOverlay = typeof document !== 'undefined' ? document.getElementById('addToPlaylistOverlay') : null;

const addToPlaylistListEl = typeof document !== 'undefined' ? document.getElementById('addToPlaylistList') : null;

const addToPlaylistHintEl = typeof document !== 'undefined' ? document.getElementById('addToPlaylistHint') : null;

const playlistsCloseBtn = typeof document !== 'undefined' ? document.getElementById('playlistsCloseBtn') : null;

const addToPlaylistCloseBtn = typeof document !== 'undefined' ? document.getElementById('addToPlaylistCloseBtn') : null;

/* 读取歌单列表 */
function getPlaylists() {
            try {
                return JSON.parse(localStorage.getItem(PLAYLIST_STORAGE_KEY) || '[]');
            } catch (e) { return []; }
        }

/* 保存歌单列表 */
function savePlaylists(list) {
            localStorage.setItem(PLAYLIST_STORAGE_KEY, JSON.stringify(list));
            if (typeof debouncedSaveConfigToBackend === 'function') debouncedSaveConfigToBackend();
        }

/* 通用 FLIP 拖拽排序管理器（支持丝滑平滑过渡动效） */
let _currentDraggingEl = null;
function _bindFlipDrag(container, itemSelector, onReorder) {
    if (!container) return;
    
    container.ondragstart = (e) => {
        const item = e.target.closest(itemSelector);
        if (!item || item.dataset.pid === '__now_playing__' || item.dataset.pid === '__local_music__') return;
        _currentDraggingEl = item;
        item.classList.add('dragging');
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', '');
        }
    };

    container.ondragover = (e) => {
        e.preventDefault();
        if (!_currentDraggingEl) return;
        const target = e.target.closest(itemSelector);
        if (!target || target === _currentDraggingEl || target.dataset.pid === '__now_playing__' || target.dataset.pid === '__local_music__') return;

        /* FLIP: First - 记录位移前所有卡片的几何 Top 坐标 */
        const items = Array.from(container.querySelectorAll(itemSelector));
        const firstPositions = new Map();
        items.forEach(el => firstPositions.set(el, el.getBoundingClientRect().top));

        /* 确定插入位置 */
        const rect = target.getBoundingClientRect();
        const isAfter = (e.clientY - rect.top) > (rect.height / 2);
        container.insertBefore(_currentDraggingEl, isAfter ? target.nextSibling : target);

        /* FLIP: Last, Invert, Play - 驱动非拖拽卡片顺滑位移过渡 */
        items.forEach(el => {
            if (el === _currentDraggingEl) return;
            const firstTop = firstPositions.get(el);
            const lastTop = el.getBoundingClientRect().top;
            const deltaY = firstTop - lastTop;
            if (deltaY !== 0) {
                el.style.transition = 'none';
                el.style.transform = `translateY(${deltaY}px)`;
                requestAnimationFrame(() => {
                    el.style.transition = 'transform 0.25s cubic-bezier(0.2, 0, 0, 1)';
                    el.style.transform = '';
                });
            }
        });
    };

    container.ondragend = () => {
        if (!_currentDraggingEl) return;
        _currentDraggingEl.classList.remove('dragging');
        _currentDraggingEl.style.transform = '';
        _currentDraggingEl = null;
        if (typeof onReorder === 'function') {
            onReorder();
        }
    };
}

/* 生成歌单唯一 ID */
function generatePlaylistId() {
            return 'pl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
        }

/* 创建新歌单 */
function createPlaylist(name) {
            name = name.trim();
            if (!name) { playlistsHintEl.textContent = '请输入歌单名称'; return false; }
            const playlists = getPlaylists();
            if (playlists.some(p => p.name === name)) {
                playlistsHintEl.textContent = '已存在同名歌单';
                return false;
            }
            playlists.unshift({
                id: generatePlaylistId(),
                name: name,
                cover: '',
                songs: [],
                createdAt: Date.now()
            });
            savePlaylists(playlists);
            renderPlaylistsView();
            return true;
        }

/* 保存当前播放队列为新歌单 */
globalThis.saveQueueMode = false;

function saveQueueAsPlaylist(name) {
            name = name.trim();
            if (!name) { playlistsHintEl.textContent = '请输入歌单名称'; return false; }
            if (playlist.length === 0) { playlistsHintEl.textContent = '播放队列为空'; return false; }
            const playlists = getPlaylists();
            if (playlists.some(p => p.name === name)) {
                playlistsHintEl.textContent = '已存在同名歌单';
                return false;
            }
            const songs = playlist.map(track => ({
                key: track.key || makeSongKey({ source: track.source, id: track.id, url: track.url, title: track.title }),
                title: track.title || '未知歌曲',
                artist: track.artist || '未知歌手',
                cover: track.cover || '',
                source: track.source || '',
                id: track.id || '',
                mid: track.mid || '',
                url: track.url || ''
            }));
            playlists.unshift({
                id: generatePlaylistId(),
                name: name,
                cover: (songs[0] && songs[0].cover) || '',
                songs: songs,
                createdAt: Date.now()
            });
            savePlaylists(playlists);
            renderPlaylistsView();
            playlistsHintEl.textContent = `已保存 ${songs.length} 首歌曲到「${name}」`;
            return true;
        }

/* 删除歌单 */
function deletePlaylist(playlistId) {
            let playlists = getPlaylists();
            playlists = playlists.filter(p => p.id !== playlistId);
            savePlaylists(playlists);
            renderPlaylistsView();
        }

/* 重命名歌单（内联输入框） */
function renamePlaylist(playlistId) {
            const playlists = getPlaylists();
            const pl = playlists.find(p => p.id === playlistId);
            if (!pl) return;
            /* 找到歌单名称的 DOM 元素 */
            const itemEl = playlistsListEl.querySelector(`.playlist-item[data-pid="${CSS.escape(playlistId)}"]`);
            if (!itemEl) return;
            const nameEl = itemEl.querySelector('.playlist-name');
            if (!nameEl) return;
            /* 替换为输入框 */
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'playlist-name-input';
            input.value = pl.name;
            input.maxLength = 30;
            nameEl.replaceWith(input);
            input.focus();
            input.select();
            /* 确认重命名 */
            let confirmed = false;
            function confirmRename() {
                if (confirmed) return;
                confirmed = true;
                const trimmed = input.value.trim();
                const newPlaylists = getPlaylists();
                const newPl = newPlaylists.find(p => p.id === playlistId);
                if (!newPl || !trimmed || trimmed === pl.name) {
                    /* 取消或无变化，恢复原名称 */
                    const span = document.createElement('div');
                    span.className = 'playlist-name';
                    span.textContent = pl.name;
                    input.replaceWith(span);
                    return;
                }
                if (newPlaylists.some(p => p.name === trimmed)) {
                    /* 同名，提示并保持输入框 */
                    confirmed = false;
                    playlistsHintEl.textContent = '已存在同名歌单';
                    input.focus();
                    input.select();
                    return;
                }
                newPl.name = trimmed;
                savePlaylists(newPlaylists);
                playlistsHintEl.textContent = '';
                renderPlaylistsView();
            }
            input?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    input.blur();
                } else if (e.key === 'Escape') {
                    confirmed = true;
                    const span = document.createElement('div');
                    span.className = 'playlist-name';
                    span.textContent = pl.name;
                    input.replaceWith(span);
                }
            });
            input?.addEventListener('blur', confirmRename);
        }

/* 歌单右键菜单 */
playlistsListEl?.addEventListener('contextmenu', (e) => {
            const item = e.target.closest('.playlist-item[data-pid]');
            if (!item) return;
            const pid = item.dataset.pid;
            /* "当前播放" 不提供右键菜单 */
            if (pid === '__now_playing__') return;
            e.preventDefault();
            const pl = getPlaylists().find(p => p.id === pid);
            if (!pl) return;
            const items = [
                { key: 'rename', label: '重命名', icon: CTX_ICONS.rename, onClick: () => renamePlaylist(pid) },
                { key: 'delete', label: '删除', icon: CTX_ICONS.trash, danger: true, onClick: () => {
                    showCtxConfirm('删除歌单', `确定要删除歌单「${pl.name}」吗？此操作无法撤销。`, () => deletePlaylist(pid));
                }}
            ];
            showCtxMenu(items, e.clientX, e.clientY);
        });

/* 阻止歌单区域的默认右键菜单 */
playlistsListEl?.addEventListener('contextmenu', (e) => {
            if (!e.target.closest('.playlist-item[data-pid]')) return;
            e.preventDefault();
        }, true);

/* 向歌单添加当前歌曲 */
function addToPlaylist(playlistId) {
            if (!currentSongData) { addToPlaylistHintEl.textContent = '请先播放歌曲'; return; }
            const playlists = getPlaylists();
            const pl = playlists.find(p => p.id === playlistId);
            if (!pl) return;
            const songKey = currentSongKey;
            if (pl.songs.some(s => s.key === songKey)) {
                addToPlaylistHintEl.textContent = '该歌曲已在歌单中';
                return;
            }
            pl.songs.push({
                key: songKey,
                title: currentSongData.title,
                artist: currentSongData.artist,
                cover: currentSongData.cover || '',
                source: currentSongData.source || '',
                id: currentSongData.id || '',
                mid: currentSongData.mid || '',
                url: currentSongData.url || ''
            });
            if (!pl.cover && currentSongData.cover) pl.cover = currentSongData.cover;
            savePlaylists(playlists);
            addToPlaylistHintEl.textContent = `已添加到「${pl.name}」`;
            if (playlistsOverlay.classList.contains('visible')) renderPlaylistsView();
        }

/* 从歌单移除歌曲 */
function removeFromPlaylist(playlistId, songIndex) {
            const playlists = getPlaylists();
            const pl = playlists.find(p => p.id === playlistId);
            if (!pl) return;
            pl.songs.splice(songIndex, 1);
            if (pl.songs.length > 0) {
                pl.cover = pl.songs[0].cover || '';
            } else {
                pl.cover = '';
            }
            savePlaylists(playlists);
            renderPlaylistDetail(playlistId);
        }

/* 渲染歌单列表视图 */
async function renderPlaylistsView() {
            resetListScroll();
            /* ★ 退出当前歌单自动退出编辑模式，不保留多选状态 */
            globalThis.plMultiEdit = false;
            globalThis.plMultiSel = new Set();
            playlistsListEl.classList.remove('song-grid-view');   /* 歌单列表视图不套用歌曲卡片布局 */
            playlistViewMode = 'list';
            currentPlaylistId = null;
            playlistsTitleEl.textContent = '歌单';
            playlistBackBtn.classList.remove('visible');
            playlistCreateBox.style.display = 'none';
            playlistNameInput.value = '';

            /* ★ 同步渲染（本地已有缓存/乐观状态），网络数据后台静默刷新：
               返回/切换歌单视图时立即可见，不再等网络往返 */
            const playlists = getPlaylists();
            let html = '';

            /* 当前播放队列入口 */
            const nowPlayingCount = playlist.length;
            html += `
                <div class="playlist-item now-playing-entry" data-pid="__now_playing__">
                    <div class="playlist-cover">
                        <span class="playlist-cover-fallback"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></span>
                    </div>
                    <div class="playlist-info">
                        <div class="playlist-name">当前播放</div>
                        <div class="playlist-meta">${nowPlayingCount > 0 ? nowPlayingCount + ' 首歌曲' : '队列为空'}</div>
                    </div>
                </div>`;

            /* 最近播放入口（历史记录见 258-rankings.js） */
            const recentCount = (typeof window !== 'undefined' && typeof window.getRecentHistory === 'function' && window.getRecentHistory().length) || 0;
            html += `
                <div class="playlist-item recent-entry" data-pid="__recent__">
                    <div class="playlist-cover" style="background: rgba(var(--theme-color-rgb), 0.12); color: var(--theme-color);">
                        <span class="playlist-cover-fallback"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 14"></polyline></svg></span>
                    </div>
                    <div class="playlist-info">
                        <div class="playlist-name">历史播放</div>
                        <div class="playlist-meta" id="recentEntryMeta">${recentCount > 0 ? recentCount + ' 首 · 点击查看' : '暂无播放记录'}</div>
                    </div>
                </div>`;

            /* 本地音乐专属入口 */
            const localCount = localSongsCache.length;
            html += `
                <div class="playlist-item local-music-entry" data-pid="__local_music__">
                    <div class="playlist-cover" style="background: rgba(var(--theme-color-rgb), 0.15); color: var(--theme-color);">
                        <span class="playlist-cover-fallback"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg></span>
                    </div>
                    <div class="playlist-info">
                        <div class="playlist-name" style="display:flex;align-items:center;gap:6px;">本地音乐 <span class="lyric-badge feat-active" style="font-size:10px;padding:1px 6px;">E-LRC</span></div>
                        <div class="playlist-meta">${localCount > 0 ? localCount + ' 首结构化单曲' : '点击上传 / 暂无歌曲'}</div>
                    </div>
                </div>`;

            /* ★ 自建平台歌单入口：网易云 → 酷狗 → QQ（未登录/未启用也显示，点击可提示登录）
               状态优先用缓存 selfPlatMetaCache，null=尚未加载→乐观显示可点击 */
            {
                const pm = selfPlatMetaCache;
                const SELF_PLAT = { netease: { name: '网易云', mark: '网', color: 'rgba(223,42,42,.25)' }, kugou: { name: '酷狗', mark: '狗', color: 'rgba(0,163,232,.25)' }, qq: { name: 'QQ音乐', mark: 'Q', color: 'rgba(47,200,135,.25)' } };
                ['netease', 'kugou', 'qq'].forEach(src => {
                    const meta = SELF_PLAT[src];
                    const ok = pm ? !!pm[src] : null;          /* true=已登录 false=未登录 null=未知(乐观) */
                    const shown = ok === null ? '点击查看' + meta.name + '歌单'
                        : (ok ? '点击查看我的' + meta.name + '歌单' : '未登录，点击去「设置 → 自建服务」登录');
                    const off = ok === false;
                    html += `
                <div class="playlist-item selfplat-entry${off ? ' selfplat-off' : ''}" data-selfplat="${src}"${off ? ` style="opacity:.55;"` : ''}>
                    <div class="playlist-cover" style="background: ${meta.color}; color: var(--theme-color);">
                        <span class="playlist-cover-fallback" style="font-size:17px;font-weight:800;">${meta.mark}</span>
                    </div>
                    <div class="playlist-info">
                        <div class="playlist-name">${meta.name}歌单</div>
                        <div class="playlist-meta">${shown}</div>
                    </div>
                </div>`;
                });
            }

            if (playlists.length === 0 && localCount === 0) {
                playlistsListEl.innerHTML = html + '<div class="empty-hint">还没有自定义歌单，点击 + 创建</div>';
                playlistsHintEl.textContent = '';
                return;
            }
            playlistsHintEl.textContent = `共 ${playlists.length} 个歌单 · ${localCount} 首本地音乐`;
            playlists.forEach(pl => {
                const name = escapeHtml(pl.name || '未命名歌单');
                const count = pl.songs.length;
                const coverHtml = pl.cover
                    ? `<img src="${escapeHtml(pl.cover)}" alt="">`
                    : `<span class="playlist-cover-fallback"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg></span>`;
                html += `
                    <div class="playlist-item custom-playlist-item" draggable="true" data-pid="${escapeHtml(pl.id)}">
                        <div class="playlist-cover">${coverHtml}</div>
                        <div class="playlist-info">
                            <div class="playlist-name">${name}</div>
                            <div class="playlist-meta">${count} 首歌曲</div>
                        </div>
                        <button class="fav-item-delete" data-del-pl="${escapeHtml(pl.id)}" title="删除歌单">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                                <polyline points="3 6 5 6 21 6"></polyline>
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            </svg>
                        </button>
                    </div>`;
            });
            playlistsListEl.innerHTML = html;
            playlistsListEl.querySelectorAll('.selfplat-entry').forEach(el => {
                el.addEventListener('click', () => {
                    const src = el.dataset.selfplat;
                    const known = !!(selfPlatMetaCache && (src in selfPlatMetaCache));
                    const okNow = known ? !!selfPlatMetaCache[src] : true; /* 未知→乐观尝试，失败后再提示 */
                    if (!okNow) {
                        /* 未登录：引导去设置 → 自建服务登录 */
                        if (typeof setHint === 'function') setHint('请先到「设置 → 自建服务」登录对应平台');
                        const ob = typeof document !== 'undefined' ? document.getElementById('openSettingsBtn') : null;
                        if (ob) { ob.click(); if (window.switchSettingsTab) setTimeout(() => { try { window.switchSettingsTab('selfhost'); } catch (_e) {} }, 80); }
                        return;
                    }
                    renderSelfPlatList(src);
                });
            });
            playlistsHintEl.textContent = `共 ${playlists.length} 个歌单 · ${localCount} 首本地音乐${selfPlatMetaCache ? ' · 3 平台' : ''}`;
            _bindFlipDrag(playlistsListEl, '.custom-playlist-item', () => {
                const newOrderPids = Array.from(playlistsListEl.querySelectorAll('.custom-playlist-item')).map(el => el.dataset.pid);
                const currentPls = getPlaylists();
                const plMap = new Map(currentPls.map(p => [p.id, p]));
                const reordered = [];
                newOrderPids.forEach(id => {
                    if (plMap.has(id)) reordered.push(plMap.get(id));
                });
                currentPls.forEach(p => {
                    if (!reordered.includes(p)) reordered.push(p);
                });
                savePlaylists(reordered);
            });

            /* ★ 后台静默刷新：本地歌曲计数 + 三平台登录状态（不阻塞已渲染内容） */
            _refreshPlaylistDynamic();
        }

/* 三平台登录状态缓存：{netease:bool, kugou:bool, qq:bool}；null=尚未加载 */
let selfPlatMetaCache = null;

/* 后台刷新歌单列表页的动态信息（本地歌曲数 / 自建平台登录态），seq 防竞态 */
let _plRefreshSeq = 0;
async function _refreshPlaylistDynamic() {
  const seq = ++_plRefreshSeq;
  const results = await Promise.all([
    localMusicManager.getLocalSongs().catch(() => null),
    fetchStatus(false).catch(() => null),
  ]);
  if (seq !== _plRefreshSeq) return;            /* 已被更新的渲染取代 */
  if (playlistViewMode !== 'list') return;      /* 已离开歌单列表页 */
  const [songs, status] = results;
  if (Array.isArray(songs)) {
    localSongsCache = songs;
    const localMetaEl = playlistsListEl?.querySelector('.local-music-entry .playlist-meta');
    if (localMetaEl) localMetaEl.textContent = songs.length > 0 ? `${songs.length} 首结构化单曲` : '点击上传 / 暂无歌曲';
  }
  if (status && typeof status === 'object') {
    selfPlatMetaCache = {};
    ['netease', 'kugou', 'qq'].forEach(src => {
      const s = status[src];
      selfPlatMetaCache[src] = !!(selfhostEnabled(src) && s && s.alive && s.loggedIn);
    });
    playlistsListEl?.querySelectorAll('.selfplat-entry').forEach(el => {
      const ok = !!selfPlatMetaCache[el.dataset.selfplat];
      const metaName = (el.querySelector('.playlist-name') || {}).textContent || '';
      el.classList.toggle('selfplat-off', !ok);
      el.style.opacity = ok ? '' : '.55';
      const metaEl = el.querySelector('.playlist-meta');
      if (metaEl) metaEl.textContent = ok ? '点击查看我的' + (metaName.replace('歌单', '')) + '歌单' : '未登录，点击去「设置 → 自建服务」登录';
    });
    playlistsHintEl.textContent = `共 ${getPlaylists().length} 个歌单 · ${localSongsCache.length} 首本地音乐 · 3 平台`;
  }
}

/* ============================================================
 * 自建平台歌单视图（网易云/酷狗/QQ）：平台列表 → 平台歌单宫格 → 歌单歌曲
 * 与本地歌单共用同一套 UI 组件（play-all-btn / rank-board-grid / result-item）。
 * 后台删除同步：网易云走平台删除接口；酷狗/QQ 提示暂不支持。
 * ============================================================ */
let selfPlatState = { src: '', cards: [], sub: null, navTitle: '', songs: [] };

let selfPlatSeq = 0;   /* 渲染竞态令牌：快速进出只让最后一次生效 */
const SELF_PLAT_UI = {
  netease: { name: '网易云', icon: 'src/img/NeteaseMusicIcon.svg', bg: 'linear-gradient(150deg, rgba(212,60,51,.55), rgba(180,40,35,.35))' },
  kugou: { name: '酷狗', icon: 'src/img/KugouMusicIcon.svg', bg: 'linear-gradient(150deg, rgba(0,131,199,.55), rgba(0,90,150,.35))' },
  qq: { name: 'QQ音乐', icon: 'src/img/QQMusicIcon.svg', bg: 'linear-gradient(150deg, rgba(23,158,103,.55), rgba(16,120,78,.35))' },
};

async function renderSelfPlatList(src) {
  resetListScroll();
  const meta = SELF_PLAT_UI[src] || { name: src, icon: '', bg: 'linear-gradient(150deg,#5b6b7f,#3f4b5c)' };
  const token = ++selfPlatSeq;
  if (selfPlatState.src !== src) selfPlatState = { src, cards: [], sub: null, navTitle: '', songs: [] };
  selfPlatState.src = src;
  playlistViewMode = 'selfplat-list';
  currentPlaylistId = '__selfplat_list__';
  playlistsTitleEl.textContent = meta.name + '歌单';
  playlistBackBtn.classList.add('visible');
  playlistCreateBox.style.display = 'none';
  /* ★ 返回/切换：本地已有卡片即时渲染，后台静默刷新 */
  const isLocal = selfPlatState.cards.length > 0;
  playlistsHintEl.textContent = isLocal ? '' : '';
  if (isLocal) buildSelfPlatCards(meta);
  else Aria.skeleton.load(playlistsListEl, 'cards', 9);
  const res = await selfhostPlaylists(src);
  if (token !== selfPlatSeq) return;   /* 已被更新的操作取代 */
  if (!res.ok) {
    if (!isLocal) playlistsListEl.innerHTML = `<div class="rank-error">${escapeHtml(res.err || '获取失败')}<br><span style="font-size:11px;opacity:.7">请到「设置 → 自建服务」登录对应平台</span></div>`;
    return;
  }
  selfPlatState.cards = res.cards || [];
  if (!selfPlatState.cards.length) {
    playlistsListEl.innerHTML = '<div class="rank-empty">该账号暂无歌单</div>';
    return;
  }
  buildSelfPlatCards(meta);
  playlistsHintEl.textContent = `来自 ${meta.name} · 共 ${selfPlatState.cards.length} 个歌单`;
}

function buildSelfPlatCards(meta) {
  playlistsListEl.classList.remove('song-grid-view');   /* 歌单宫格不套用歌曲卡片布局 */
  playlistsListEl.innerHTML = `
    <div style="font-size:11px;opacity:.6;padding:2px 4px 8px;">来自 ${meta.name} · 共 ${selfPlatState.cards.length} 个歌单（播放/操作同本地歌单）</div>
    ${Aria.__cardsCarouselBarHTML()}<div class="rank-board-grid">${selfPlatState.cards.map((b, i) => `
      <div class="rank-board-card" data-i="${i}" title="${escapeHtml(b.name)}">
        ${b.cover
        ? `<img class="rank-board-bg" src="${escapeHtml(b.cover)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
        : `<span class="rank-board-ph" style="background:${meta.bg};display:flex;align-items:center;justify-content:center;">${meta.icon ? `<img src="${meta.icon}" alt="" style="width:34px;height:34px;opacity:.9;" onerror="this.style.visibility='hidden'">` : ''}</span>`}
        <div class="rank-board-meta">
          <div class="rank-board-name">${escapeHtml(b.name)}</div>
          <div class="rank-board-count">${b.count ? b.count + ' 首' : ''}</div>
        </div>
        <span class="rank-card-src">${meta.name}</span>
      </div>`).join('')}</div>`;
  Aria.__bindCardsCarouselBar(playlistsListEl);
  playlistsListEl.querySelectorAll('.rank-board-card').forEach(card => {
    card.onclick = () => renderSelfPlatSongs(selfPlatState.cards[Number(card.dataset.i)]);
  });
}

async function renderSelfPlatSongs(card) {
  if (!card || !card.key) return;
  resetListScroll();
  const token = ++selfPlatSeq;
  selfPlatState.sub = card.key;
  selfPlatState.navTitle = card.name || '歌单';
  playlistViewMode = 'selfplat-songs';
  currentPlaylistId = '__selfplat_songs__';
  playlistsTitleEl.textContent = selfPlatState.navTitle;
  /* ★ 缓存优先：同一歌单已加载过（返回/再次进入）→ 立即渲染，后台静默刷新 */
  const useCache = Array.isArray(selfPlatState.songs) && selfPlatState.songs.length > 0;
  if (useCache) _renderSelfPlatSongsList(selfPlatState.songs);
  else { Aria.skeleton.load(playlistsListEl, 'list', 8); playlistsHintEl.textContent = ''; }
  const res = await selfhostPlaylistSongs(selfPlatState.src, card.key);
  if (token !== selfPlatSeq) return;
  if (!res.ok) {
    if (!useCache) playlistsListEl.innerHTML = `<div class="rank-error">${escapeHtml(res.err || '获取失败')}</div>`;
    return;
  }
  selfPlatState.songs = res.list || [];
  if (!selfPlatState.songs.length) {
    playlistsListEl.innerHTML = '<div class="rank-empty">该歌单暂无歌曲</div>';
    return;
  }
  /* ★ 后台刷新替换：保持用户当前滚动位置，不因重渲染跳回顶部 */
  _renderSelfPlatSongsList(selfPlatState.songs, true);
}

/* 渲染自建平台歌单歌曲列表 + 事件绑定（供缓存即时渲染/后台刷新复用） */
function _renderSelfPlatSongsList(songs, preserveScroll) {
  const savedTop = preserveScroll ? playlistsListEl.scrollTop : 0;
  let favKeys = new Set();
  try { favKeys = new Set((getFavorites() || []).map(f => makeSongKey(f))); } catch (e) { /* ignore */ }
  playlistsHintEl.textContent = `共 ${songs.length} 首`;
  /* 播放全部 + 批量下载工具栏（同本地歌单） */
  playlistsListEl.innerHTML = `
    <div class="rank-list-head" style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
      <div class="play-all-btn" id="selfPlatPlayAll" style="flex:1;margin-bottom:0;">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="#fff"><path d="M6 4l14 8-14 8V4z" stroke="#fff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path></svg>
        <span>播放全部（${songs.length}）</span>
      </div>
      <button class="setting-btn" id="selfPlatDl" style="padding:6px 10px;white-space:nowrap;" title="依次下载本歌单全部歌曲">批量下载</button>
    </div>
    ${songs.map((s, i) => {
    const name = s.name || s.song || s.title || '未知歌曲';
    const singer = s.singer || s.author || '未知歌手';
    const cover = s.cover || '';
    const np = (window.currentSongData && window.currentSongData.id === String(s.id)) ? ' now-playing-active' : '';
    const isFav = favKeys.has(makeSongKey(s));
    const coverHtml = cover
      ? `<img class="result-cover" src="${escapeHtml(cover)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
      : `<div class="result-cover" style="display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.1);"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg></div>`;
    return `<div class="result-item${np}" data-soid="${i}">
      <span class="rank-sno">${i + 1}</span>
      ${coverHtml}
      <div class="result-info">
        <div class="result-title">${escapeHtml(name)}</div>
        <div class="result-artist">${escapeHtml(singer)} ${(typeof Aria.__platformIconHTML === 'function' ? Aria.__platformIconHTML(s.source || s.src) : '')}</div>
      </div>
      <div class="result-actions">
        <button class="result-action-btn" data-soact="addnow" data-soid="${i}" title="加入当前播放">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5v14l11-7z"></path></svg>
        </button>
        <button class="result-action-btn ${isFav ? 'active-fav' : ''}" data-soact="fav" data-soid="${i}" title="${isFav ? '取消收藏' : '收藏'}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path></svg>
        </button>
      </div>
    </div>`;
  }).join('')}`;
  const __listHead = playlistsListEl.querySelector('.rank-list-head');
  if (__listHead) __listHead.appendChild(Aria.__songViewBtn(playlistsListEl));
  Aria.__applySongViewTo(playlistsListEl);
  const dlBtn = document.getElementById('selfPlatDl');
  if (dlBtn) dlBtn.onclick = () => { if (typeof window.batchDownloadSongs === 'function') window.batchDownloadSongs(songs, selfPlatState.navTitle + ' '); };
  const playAll = document.getElementById('selfPlatPlayAll');
  if (playAll) playAll.onclick = () => {
    try {
      if (typeof globalThis.playlist !== 'undefined' && Array.isArray(globalThis.playlist)) { globalThis.playlist.length = 0; globalThis.playlist.push(...songs); globalThis.currentTrackIndex = 0; }
    } catch (e) { /* ignore */ }
    loadOnlineSong(songs[0], true).catch(e => logWarn('playlists', '[自建平台] 播放全部失败:', e));
    if (typeof window.recordRecentPlay === 'function') window.recordRecentPlay(songs[0]);
    if (typeof setHint === 'function') setHint(`播放全部：${songs.length} 首已加入播放队列`);
  };
  playlistsListEl.querySelectorAll('.result-item[data-soid]').forEach(el => {
    el.onclick = (e) => {
      if (e.target.closest('[data-soact]')) return;
      const s = songs[Number(el.dataset.soid)];
      if (!s) return;
      loadOnlineSong(s).catch(e => logWarn('playlists', '[自建平台] 播放失败:', e));
      if (typeof window.recordRecentPlay === 'function') window.recordRecentPlay(s);
    };
  });
  playlistsListEl.querySelectorAll('[data-soact="addnow"]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const s = songs[Number(btn.dataset.soid)];
      if (!s) return;
      try { if (typeof globalThis.playlist !== 'undefined' && Array.isArray(globalThis.playlist)) globalThis.playlist.push(s); } catch (_e) {}
      if (typeof setHint === 'function') setHint('已加入当前播放队列');
    };
  });
  playlistsListEl.querySelectorAll('[data-soact="fav"]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const s = songs[Number(btn.dataset.soid)];
      if (!s) return;
      try {
        const { faved } = toggleFavCore(s);
        btn.classList.toggle('active-fav', faved);
        if (typeof setHint === 'function') setHint(faved ? '已加入收藏' : '已取消收藏');
      } catch (_e) {}
    };
  });
  /* ★ 后台刷新替换后恢复滚动位置（preserveScroll） */
  if (preserveScroll && savedTop > 0) playlistsListEl.scrollTop = savedTop;
}

/* 返回钩子：平台歌曲 → 平台歌单；平台歌单 → 歌单列表 */
Aria.__playlistBackHook = () => {
  if (playlistViewMode === 'selfplat-songs') { renderSelfPlatList(selfPlatState.src); return; }
  if (playlistViewMode === 'selfplat-list') { renderPlaylistsView(); return; }
  renderPlaylistsView();
};

/* 历史播放：作为歌单页二级页（不再弹独立窗口） */
function renderRecentDetail() {
  resetListScroll();
  const list = (typeof window.getRecentHistory === 'function') ? (window.getRecentHistory() || []) : [];
  playlistViewMode = 'recent-detail';
  currentPlaylistId = '__recent_detail__';
  playlistsTitleEl.textContent = '历史播放';
  playlistBackBtn.classList.add('visible');
  playlistCreateBox.style.display = 'none';
  if (!list.length) {
    playlistsListEl.innerHTML = '<div class="rank-empty">还没有播放过歌曲<br>去搜索 / 榜单 / 收藏里点一首吧</div>';
    playlistsHintEl.textContent = '';
    return;
  }
  playlistsHintEl.textContent = `共 ${list.length} 首`;
  const rows = list.map((it, i) => {
    const cover = it.cover || '';
    const np = (window.currentSongData && window.currentSongData.id === String(it.id)) ? ' now-playing-active' : '';
    return `<div class="result-item${np}" data-rh="${i}">
      ${cover ? `<img class="result-cover" src="${escapeHtml(cover)}" alt="" onerror="this.style.visibility='hidden'">` : `<div class="result-cover" style="display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.1);"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg></div>`}
      <div class="result-info">
        <div class="result-title">${escapeHtml(it.title || '未知歌曲')}</div>
        <div class="result-artist">${escapeHtml(it.artist || '未知歌手')}${it.source ? ' · ' + ({ tencent: 'QQ', kugou: '酷狗', netease: '网易', kuwo: '酷我' }[it.source] || it.source) : ''} · ${it.at ? new Date(it.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</div>
      </div>
    </div>`;
  }).join('');
  playlistsListEl.innerHTML = `
    <div class="rank-list-head" style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
      <div class="play-all-btn" id="rcPlayAll" style="flex:1;margin-bottom:0;">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="#fff"><path d="M6 4l14 8-14 8V4z" stroke="#fff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path></svg>
        <span>播放全部（${list.length}）</span>
      </div>
    </div>${rows}`;
  const hd = playlistsListEl.querySelector('.rank-list-head');
  if (hd) hd.appendChild(Aria.__songViewBtn(playlistsListEl));
  Aria.__applySongViewTo(playlistsListEl);
  const pa = document.getElementById('rcPlayAll');
  if (pa) pa.onclick = () => {
    try {
      if (typeof globalThis.playlist !== 'undefined' && Array.isArray(globalThis.playlist)) {
        globalThis.playlist.length = 0;
        globalThis.playlist.push(...list.map(it => ({ source: it.source, id: it.id, mid: it.mid, hash: it.hash, song: it.title, singer: it.artist, cover: it.cover })));
        globalThis.currentTrackIndex = 0;
      }
    } catch (e) { /* ignore */ }
    const first = { source: list[0].source, id: list[0].id, mid: list[0].mid, hash: list[0].hash, song: list[0].title, singer: list[0].artist, cover: list[0].cover };
    loadOnlineSong(first).catch(e => logWarn('playlists', '[历史] 播放全部失败:', e));
    if (typeof window.recordRecentPlay === 'function') window.recordRecentPlay(first);
    if (typeof setHint === 'function') setHint(`播放全部：${list.length} 首已加入播放队列`);
  };
  playlistsListEl.querySelectorAll('.result-item[data-rh]').forEach(el => {
    el.onclick = () => {
      const it = list[Number(el.dataset.rh)];
      if (!it) return;
      const info = { source: it.source, id: it.id, mid: it.mid, hash: it.hash, song: it.title, singer: it.artist, cover: it.cover };
      if (info.source && (info.id || info.mid || info.hash)) {
        loadOnlineSong(info).catch(e => logWarn('playlists', '[历史] 播放失败:', e));
        if (typeof window.recordRecentPlay === 'function') window.recordRecentPlay(info);
      }
    };
  });
}
Aria.__openRecentDetail = renderRecentDetail;

/* 渲染本地音乐详情视图 */
async function renderLocalMusicDetail() {
            resetListScroll();
            playlistViewMode = 'detail';
            currentPlaylistId = '__local_music__';
            playlistsTitleEl.textContent = '本地音乐';
            playlistBackBtn.classList.add('visible');
            playlistCreateBox.style.display = 'none';

            playlistsHintEl.textContent = '正在读取本地音乐库...';
            try {
                localSongsCache = await localMusicManager.getLocalSongs();
            } catch (e) { localSongsCache = []; }

            playlistsHintEl.textContent = `共 ${localSongsCache.length} 首本地歌曲 (保存在 local_music/)`;

            let html = '';

            /* 上传横幅与拖拽区 */
            html += `
                <div class="local-music-upload-banner" id="localMusicUploadBanner">
                    <div class="local-music-upload-title">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                        <span>+ 上传本地歌曲 (自动识曲 & 增强型歌词匹配)</span>
                    </div>
                    <div class="local-music-upload-sub">支持拖拽 MP3 / FLAC / M4A / WAV / OGG 到此区域，自动生成独立文件夹并转换 E-LRC 逐字歌词</div>
                    <div class="local-music-progress-box" id="localMusicProgressBox">
                        <div class="local-music-progress-bar">
                            <div class="local-music-progress-fill" id="localMusicProgressFill"></div>
                        </div>
                        <div class="local-music-progress-text" id="localMusicProgressText">准备就绪</div>
                    </div>
                    <input type="file" id="localMusicUploadInput" accept="audio/*" multiple style="display:none;">
                </div>`;

            if (localSongsCache.length === 0) {
                html += '<div class="empty-hint">暂无本地音乐，点击上方横幅上传第一首歌吧！</div>';
                playlistsListEl.innerHTML = html;
                _bindLocalMusicBannerEvents();
                return;
            }

            /* 播放全部按钮 */
            html += `
                <div class="rank-list-head" style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
                    <div class="play-all-btn" id="playAllLocalBtn" style="flex:1;margin-bottom:0;">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="#fff"><path d="M6 4l14 8-14 8V4z" stroke="#fff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path></svg>
                        <span>播放全部（${localSongsCache.length}）</span>
                    </div>
                </div>`;

            /* 本地歌曲列表 */
            localSongsCache.forEach((song, idx) => {
                const title = escapeHtml(song.title || '未知歌曲');
                const artist = escapeHtml(song.artist || '未知歌手');
                const cover = song.coverUrl || '';
                const hasWord = song.hasWordLevel;
                const score = song.matchScore || 95;

                const coverHtml = cover
                    ? `<img class="result-cover" src="${escapeHtml(cover)}" alt="" onerror="this.style.visibility='hidden'">`
                    : `<div class="result-cover" style="display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.1);"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg></div>`;

                const badgeHtml = hasWord
                    ? `<span class="lyric-badge feat-word" style="margin-left:6px;">逐字 E-LRC</span>`
                    : `<span class="lyric-badge score-med" style="margin-left:6px;">逐行 LRC</span>`;

                const scoreBadge = score >= 80
                    ? `<span class="lyric-badge score-high" style="margin-left:4px;">${score}% 契合</span>`
                    : (score > 0 ? `<span class="lyric-badge score-low" style="margin-left:4px;">${score}% 契合</span>` : '');

                html += `
                    <div class="result-item" data-local-idx="${idx}" data-folder="${escapeHtml(song.folder)}">
                        ${coverHtml}
                        <div class="result-info">
                            <div class="result-title" style="display:flex;align-items:center;">${title} ${badgeHtml} ${scoreBadge}</div>
                            <div class="result-artist">${artist} ${song.album ? '· ' + escapeHtml(song.album) : ''}</div>
                        </div>
                        <div class="result-actions">
                            <button class="result-action-btn" data-action="match-lyric-online" data-folder="${escapeHtml(song.folder)}" data-idx="${idx}" title="在线重新匹配歌词">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path></svg>
                            </button>
                            <button class="result-action-btn" data-action="upload-custom-lrc" data-folder="${escapeHtml(song.folder)}" title="上传/替换本地LRC歌词">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="18" x2="12" y2="12"></line><line x1="9" y1="15" x2="15" y2="15"></line></svg>
                            </button>
                            <button class="fav-item-delete" data-action="del-local-song" data-folder="${escapeHtml(song.folder)}" title="删除本地歌曲">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                                    <line x1="6" y1="6" x2="18" y2="18"></line>
                                    <line x1="18" y1="6" x2="6" y2="18"></line>
                                </svg>
                            </button>
                        </div>
                    </div>`;
            });

            playlistsListEl.innerHTML = html;
            const __localHead = playlistsListEl.querySelector('.rank-list-head');
            if (__localHead) __localHead.appendChild(Aria.__songViewBtn(playlistsListEl));
            Aria.__applySongViewTo(playlistsListEl);
            _bindLocalMusicBannerEvents();
            _asyncFillLocalCovers();
        }

/* ★ 对无封面本地歌曲静默补封面（/api/cover 网易云优先/QQ 兜底），不阻塞列表渲染 */
const _coverReqSet = new Set(); // 已请求过的 folder 去重（同一会话）
async function _asyncFillLocalCovers() {
    const missing = localSongsCache.filter(s => !s.coverUrl && s.title && s.title !== '未知歌曲');
    missing.forEach(async (song) => {
        if (_coverReqSet.has(song.folder)) return;
        _coverReqSet.add(song.folder);
        try {
            const cv = await fetch(`/api/cover?title=${encodeURIComponent(song.title)}&artist=${encodeURIComponent(song.artist || '')}`);
            if (!cv.ok) return;
            const cd = await cv.json();
            if (!(cd && cd.ok && cd.cover)) return;
            song.coverUrl = cd.cover;
            /* 替换列表中的封面占位（同一 DOM 只有当前渲染批次） */
            const it = playlistsListEl.querySelector(`.result-item[data-folder="${CSS.escape(song.folder)}"]`);
            if (it) {
                const box = it.querySelector('.result-cover');
                if (box && (box.tagName === 'DIV')) {
                    const img = document.createElement('img');
                    img.className = 'result-cover';
                    img.src = cd.cover;
                    img.alt = '';
                    img.onerror = () => { img.style.visibility = 'hidden'; };
                    box.replaceWith(img);
                }
            }
        } catch (e) { /* 静默失败 */ }
    });
}

/* 绑定本地音乐上传横幅事件 */
function _bindLocalMusicBannerEvents() {
            const banner = document.getElementById('localMusicUploadBanner');
            const fileInput = document.getElementById('localMusicUploadInput');
            const pBox = document.getElementById('localMusicProgressBox');
            const pFill = document.getElementById('localMusicProgressFill');
            const pText = document.getElementById('localMusicProgressText');

            if (!banner || !fileInput) return;

            banner.onclick = (e) => {
                if (e.target.tagName !== 'INPUT') fileInput.click();
            };

            banner.ondragover = (e) => {
                e.preventDefault();
                banner.classList.add('dragover');
            };
            banner.ondragleave = () => banner.classList.remove('dragover');
            banner.ondrop = async (e) => {
                e.preventDefault();
                banner.classList.remove('dragover');
                if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                    await _handleLocalFilesUpload(Array.from(e.dataTransfer.files));
                }
            };

            fileInput.onchange = async () => {
                if (fileInput.files && fileInput.files.length > 0) {
                    await _handleLocalFilesUpload(Array.from(fileInput.files));
                }
            };

            async function _handleLocalFilesUpload(files) {
                if (files.length === 0) return;
                pBox.style.display = 'block';

                const lyricFetchers = {
                    fetchKugou: async (song, singer) => {
                        const res = await fetchKugouLyric({ song, singer, duration: 0 });
                        return res ? { lines: res.parsedList, isWordLevel: true, hasTranslation: false } : null;
                    },
                    fetchNetease: async (song, singer) => {
                        const word = `${song} ${singer}`.trim();
                        const sRes = await fetch(`${API_BASE}/netease?word=${encodeURIComponent(word)}&num=1`).then(r => r.json());
                        if (sRes.code === 200 && sRes.data) {
                            const songItem = Array.isArray(sRes.data) ? sRes.data[0] : sRes.data;
                            if (songItem && songItem.id) {
                                const lData = await fetchLyricWithFallback(String(songItem.id), 'netease');
                                if (lData.yrc) return { lines: parseNeteaseYrc(lData.yrc), isWordLevel: true, hasTranslation: Boolean(lData.trans) };
                                if (lData.lrc) return { lines: parseLrc(lData.lrc), isWordLevel: false, hasTranslation: Boolean(lData.trans) };
                            }
                        }
                        return null;
                    },
                    fetchQQ: async (song, singer) => {
                        const word = `${song} ${singer}`.trim();
                        const sRes = await fetch(`${API_BASE}/tencent?word=${encodeURIComponent(word)}&num=1`).then(r => r.json());
                        if (sRes.code === 200 && sRes.data) {
                            const songItem = Array.isArray(sRes.data) ? sRes.data[0] : sRes.data;
                            if (songItem && songItem.id) {
                                const lData = await fetchLyricWithFallback(String(songItem.id), 'tencent');
                                if (lData.qrc) return { lines: parseNeteaseYrc(lData.qrc), isWordLevel: true, hasTranslation: Boolean(lData.trans) };
                                if (lData.lrc) return { lines: parseLrc(lData.lrc), isWordLevel: false, hasTranslation: Boolean(lData.trans) };
                            }
                        }
                        return null;
                    },
                    fetchLrcLib: async (song, singer) => {
                        const q = new URLSearchParams({
                            track_name: song,
                            artist_name: singer || ''
                        });
                        try {
                            const res = await fetch(`https://lrclib.net/api/get?${q.toString()}`);
                            if (res.ok) {
                                const json = await res.json();
                                if (json.syncedLyrics) {
                                    return { lines: parseLrc(json.syncedLyrics).map(l => ({ start: l.time, end: l.time + 4000, original: l.text })), isWordLevel: false, hasTranslation: false };
                                }
                            }
                        } catch (e) { logWarn('playlists', 'lrclib 歌词兜底失败:', e); }
                        return null;
                    }
                };

                for (let i = 0; i < files.length; i++) {
                    const f = files[i];
                    await localMusicManager.processLocalMusicUpload(f, (stepText, percent) => {
                        pFill.style.width = `${percent}%`;
                        pText.textContent = `[${i + 1}/${files.length}] ${f.name}: ${stepText}`;
                    }, lyricFetchers);
                }

                pText.textContent = `全部 ${files.length} 首歌曲已完成处理！`;
                setTimeout(() => {
                    renderLocalMusicDetail();
                }, 1000);
            }
        }

/* 播放本地结构化单曲 */
async function playLocalMusicSong(song) {
            if (!song) return;
            closePlaylists();
            if (typeof setHint === 'function') setHint(`正在加载本地音乐: ${song.title}`);

            // 1. 设置音轨信息
            currentSongData = {
                title: song.title || '未知歌曲',
                artist: song.artist || '未知歌手',
                album: song.album || '',
                cover: song.coverUrl || '',
                source: 'local',
                url: song.audioUrl
            };
            currentSongKey = makeSongKey(currentSongData);
            songTitleEl.textContent = currentSongData.title;
            songArtistEl.textContent = currentSongData.artist;
            if (song.coverUrl) {
                setCoverImage(song.coverUrl);
                setBlurBackground(song.coverUrl);
            }
            updateFavoriteBtn();

            // 2. 加载增强型歌词 (优先 lyrics.elrc，否则 lyrics.lrc)
            let lyricText = '';
            const lrcUrl = song.elrcUrl || song.lrcUrl;
            if (lrcUrl) {
                try {
                    const lrcRes = await fetch(lrcUrl);
                    if (lrcRes.ok) {
                        lyricText = await lrcRes.text();
                    }
                } catch (e) {
                    logWarn('playlists', '[LocalMusic] 歌词读取失败:', e);
                }
            }

            if (lyricText) {
                const parsed = parseEnhancedLrc(lyricText);
                lyrics = parsed.lines;
                activeLineIndex = -1;
                aiEmotionWords = [];
                renderLyrics(lyrics);
                updateLyricsHighlight();

                // 若本地解析出来的歌词无翻译，自动后台跨源补齐双语翻译并实时刷新
                if (!lyrics.some(l => l.translation && l.translation.trim())) {
                    (async () => {
                        try {
                            const word = `${currentSongData.title} ${currentSongData.artist || ''}`.trim();
                            const nRes = await fetch(`${API_BASE}/netease?word=${encodeURIComponent(word)}&num=1`).then(r => r.json());
                            if (nRes.code === 200 && nRes.data) {
                                const sItem = Array.isArray(nRes.data) ? nRes.data[0] : nRes.data;
                                if (sItem && sItem.id) {
                                    const lData = await fetchLyricWithFallback(String(sItem.id), 'netease');
                                    const parsedN = detectAndParseLyrics(lData);
                                    if (parsedN.translations && parsedN.translations.length > 0) {
                                        lyrics = mergeLyrics(lyrics, parsedN.translations, parsedN.romaji);
                                        renderLyrics(lyrics);
                                        updateLyricsHighlight();
                                    }
                                }
                            }
                        } catch (e) { logWarn('playlists', '本地歌词翻译/解析异常:', e); }
                    })();
                }
            } else {
                lyrics = [{ start: 0, end: 300000, original: '本地音频播放中 (点击右侧按钮可上传或替换 LRC)' }];
                activeLineIndex = -1;
                aiEmotionWords = [];
                renderLyrics(lyrics);
                updateLyricsHighlight();
            }

            // 3. 播放音频（统一走 _playLocalTrackOnReady：立即触发 AI/高潮、不续推）
            audio.pause();
            audio.removeAttribute('src');
            audio.src = getStreamCachedAudioUrl(song.audioUrl, song.id || song.title);
            audio.load();
            _playLocalTrackOnReady(playbackGeneration, { refill: false, stagger: false });
        }

if (typeof window !== 'undefined') window.playLocalMusicSong = playLocalMusicSong;

/* ==================== 本地音乐「在线重新匹配歌词」====================
 * 参考 上游参考项目 LyricMatchModal：本地歌曲 → 4 源（酷狗/网易云/QQ/LRCLIB）歌词候选
 * → 按升级版匹配评分（lyricMatcher）排序展示 → 用户点选采用 → 转 E-LRC 保存。
 * 候选歌名/歌手缺失时用本地元数据回填（评分仍以长短句/质量维度生效）。 */
const _llmOverlayRef = { el: null };

function _llmRadioEmoji(r) {
  if (!r) return '';
  return r.isWordLevel ? '逐字' : '逐行';
}

async function openLocalLyricMatch(idx, folder) {
  const song = localSongsCache[idx];
  if (!song) return;
  if (typeof setHint === 'function') setHint(`正在为「${song.title || '未知歌曲'}」在线检索歌词…`);

  /* 动态创建弹窗（复用 lyric-source 系列样式） */
  if (_llmOverlayRef.el && _llmOverlayRef.el.isConnected) _llmOverlayRef.el.remove();
  const overlay = document.createElement('div');
  overlay.className = 'lyric-source-overlay visible';
  _llmOverlayRef.el = overlay;
  overlay.innerHTML = `
    <div class="lyric-source-panel" style="width:min(560px,100%);">
      <div class="lyric-source-header">
        <span class="lyric-source-title">歌词匹配 · ${escapeHtml(song.title || '未知歌曲')}</span>
        <button class="lyric-source-close" data-llm-close="1" title="关闭"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"></line><line x1="18" y1="6" x2="6" y2="18"></line></svg></button>
      </div>
      <div class="lyric-source-body" id="llmBody" style="max-height:60vh;overflow-y:auto;padding:12px;">
        <div style="opacity:.65;text-align:center;padding:26px 0;">正在检索酷狗 / 网易云 / QQ / LRCLIB…</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('[data-llm-close="1"]')) overlay.remove();
  });

  const body = overlay.querySelector('#llmBody');
  const meta = {
    title: song.title || '',
    artist: song.artist || '',
    album: song.album || '',
    duration: Number(song.duration) || 0
  };

  /* 4 源获词器（与本地导入共用同一套取词逻辑） */
  const sources = [
    {
      label: '酷狗音乐', key: 'kugou',
      fn: async () => {
        const res = await fetchKugouLyric({ song: meta.title, singer: meta.artist, duration: 0 });
        return res ? { title: res.title || meta.title, artist: res.artist || meta.artist, lines: res.parsedList, isWordLevel: true, hasTranslation: false } : null;
      }
    },
    {
      label: '网易云音乐', key: 'netease',
      fn: async () => {
        const word = `${meta.title} ${meta.artist}`.trim();
        const sRes = await fetch(`${API_BASE}/netease?word=${encodeURIComponent(word)}&num=1`).then(r => r.json());
        if (sRes.code === 200 && sRes.data) {
          const item = Array.isArray(sRes.data) ? sRes.data[0] : sRes.data;
          if (item && item.id) {
            const lData = await fetchLyricWithFallback(String(item.id), 'netease');
            if (lData.yrc) return { title: item.name || meta.title, artist: (item.singers || [] ).map(x => x.name).join(',') || meta.artist, lines: parseNeteaseYrc(lData.yrc), isWordLevel: true, hasTranslation: Boolean(lData.trans) };
            if (lData.lrc) return { title: item.name || meta.title, artist: meta.artist, lines: parseLrc(lData.lrc), isWordLevel: false, hasTranslation: Boolean(lData.trans) };
          }
        }
        return null;
      }
    },
    {
      label: 'QQ音乐', key: 'tencent',
      fn: async () => {
        const word = `${meta.title} ${meta.artist}`.trim();
        const sRes = await fetch(`${API_BASE}/tencent?word=${encodeURIComponent(word)}&num=1`).then(r => r.json());
        if (sRes.code === 200 && sRes.data) {
          const item = Array.isArray(sRes.data) ? sRes.data[0] : sRes.data;
          if (item && item.id) {
            const lData = await fetchLyricWithFallback(String(item.id), 'tencent');
            if (lData.qrc) return { title: item.name || meta.title, artist: meta.artist, lines: parseNeteaseYrc(lData.qrc), isWordLevel: true, hasTranslation: Boolean(lData.trans) };
            if (lData.lrc) return { title: item.name || meta.title, artist: meta.artist, lines: parseLrc(lData.lrc), isWordLevel: false, hasTranslation: Boolean(lData.trans) };
          }
        }
        return null;
      }
    },
    {
      label: 'LRCLIB 开放词库', key: 'lrclib',
      fn: async () => {
        const q = new URLSearchParams({ track_name: meta.title, artist_name: meta.artist || '' });
        const res = await fetch(`https://lrclib.net/api/get?${q.toString()}`);
        if (res.ok) {
          const json = await res.json();
          if (json.syncedLyrics) {
            return { title: meta.title, artist: meta.artist, lines: parseLrc(json.syncedLyrics).map(l => ({ start: l.time, end: l.time + 4000, original: l.text })), isWordLevel: false, hasTranslation: false };
          }
        }
        return null;
      }
    }
  ];

  const outcomes = (await Promise.all(sources.map(async (s) => {
    try {
      const r = await s.fn();
      if (!r || !Array.isArray(r.lines) || r.lines.length === 0) return { src: s, cand: null };
      const cand = { ...r, label: s.label, title: r.title || meta.title, artist: r.artist || meta.artist };
      cand.score = calculateLyricMatchScore(meta, cand);
      return { src: s, cand };
    } catch (e) {
      return { src: s, cand: null };
    }
  })));
  const cands = outcomes.map(o => o.cand).filter(Boolean).sort((a, b) => b.score - a.score);

  if (cands.length === 0) {
    body.innerHTML = `<div style="opacity:.65;text-align:center;padding:26px 0;">未检索到可用歌词，可尝试上传本地 LRC 文件。</div>`;
    return;
  }

  body.innerHTML = cands.map((c, i) => {
    const preview = (c.lines.slice(0, 2).map(l => escapeHtml(l.original || l.text || '')).join(' / ')) || '（无文本预览）';
    const first = i === 0 && c.score >= 60;
    const tagCls = c.isWordLevel ? 'feat-active' : 'score-med';
    return `
      <div class="lyric-source-option" data-llm-pick="${i}" style="align-items:flex-start;gap:10px;${first ? 'border-color:var(--theme-color,#3b82f6);' : ''}">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:13px;color:#fff;display:flex;align-items:center;gap:6px;">
            ${escapeHtml(c.title || meta.title)} ${first ? '<span style="font-size:10px;color:var(--theme-color,#3b82f6);">推荐</span>' : ''}
          </div>
          <div style="font-size:11px;opacity:.7;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(c.artist || meta.artist || '未知歌手')}</div>
        </div>
        <span class="lyric-badge ${tagCls}" style="flex:0 0 auto;">${_llmRadioEmoji(c)}</span>
        <span class="lyric-badge score-high" style="flex:0 0 auto;">${c.score}%</span>
        <div style="flex:0 0 auto;display:flex;gap:8px;">
          <span class="lyric-badge" style="flex:0 0 auto;">${escapeHtml(c.sourceName || c.label)}</span>
          <button class="setting-btn primary" style="padding:4px 12px;" data-llm-adopt="${i}">采用</button>
        </div>
      </div>`;
  }).join('') + `<div style="text-align:center;padding:8px 0 2px;"><span class="setting-desc" style="margin:0;font-size:11px;">候选预览：${cands.map(c => (c.lines[0] && (c.lines[0].original || c.lines[0].text)) || '—').filter(Boolean).slice(0, 1).map(t => escapeHtml(String(t).slice(0, 30))).join('')}</span></div>`;

  /* 采用：转换 E-LRC 并保存 */
  const adopt = async (c) => {
    try {
      if (typeof setHint === 'function') setHint(`已采用「${c.title || meta.title}」歌词，保存中…`);
      const elrc = convertToEnhancedLrc(c.lines, { title: meta.title, artist: meta.artist, album: meta.album, duration: meta.duration });
      const ok = await localMusicManager.uploadCustomLrc(folder, elrc, true);
      if (typeof setHint === 'function') setHint(ok ? `✅ 已采用「${c.title || meta.title}」逐字歌词` : '保存失败，请重试');
      overlay.remove();
      renderLocalMusicDetail();
    } catch (err) {
      logWarn('playlists', '[LocalMusicMatch] 保存失败:', err);
      if (typeof setHint === 'function') setHint('保存失败：' + (err && err.message ? err.message : '未知错误'));
    }
  };
  body.addEventListener('click', (e) => {
    const pickEl = e.target.closest('[data-llm-pick]');
    const adoptBtn = e.target.closest('[data-llm-adopt]');
    if (pickEl && !adoptBtn) {
      /* 点整行 → 预览/聚焦该候选（简化：仅高亮） */
      body.querySelectorAll('[data-llm-pick]').forEach(x => x.style.borderColor = 'transparent');
      pickEl.style.borderColor = 'var(--theme-color,#3b82f6)';
    }
    if (adoptBtn) {
      const c = cands[Number(adoptBtn.dataset.llmAdopt)];
      if (c) adopt(c);
    }
  });
}
if (typeof window !== 'undefined') Aria.__openLocalLyricMatch = openLocalLyricMatch;

/* 渲染当前播放队列详情 */
function renderNowPlayingDetail() {
            resetListScroll();
            playlistViewMode = 'detail';
            currentPlaylistId = '__now_playing__';
            playlistsTitleEl.textContent = '当前播放';
            playlistBackBtn.classList.add('visible');
            playlistCreateBox.style.display = 'none';

            if (playlist.length === 0) {
                playlistsListEl.innerHTML = '<div class="empty-hint">播放队列为空</div>';
                playlistsHintEl.textContent = '';
                return;
            }
            playlistsHintEl.textContent = `共 ${playlist.length} 首歌曲`;
            let html = '';
            html += `
                <div class="rank-list-head" style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
                    <div class="play-all-btn" id="playAllBtn" data-pid="__now_playing__" style="flex:1;margin-bottom:0;">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="#fff"><path d="M6 4l14 8-14 8V4z" stroke="#fff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path></svg>
                        <span>播放全部（${playlist.length}）</span>
                    </div>
                </div>`;
            playlist.forEach((track, idx) => {
                const title = escapeHtml(track.title || '未知歌曲');
                const artist = escapeHtml(track.artist || '未知歌手');
                const cover = track.cover || '';
                const isActive = (idx === currentTrackIndex);
                html += ``
                    + `<div class="result-item${isActive ? ' now-playing-active' : ''}" data-sidx="${idx}">`
                        + `<img class="result-cover" src="${cover}" alt="" onerror="this.style.visibility='hidden'">`
                        + `<div class="result-info">`
                            + `<div class="result-title">${title}</div>`
                            + `<div class="result-artist">${artist}${(typeof Aria.__platformIconHTML === 'function' ? Aria.__platformIconHTML(track.source || track.src) : '')}</div>`
                        + `</div>`
                        + `<div class="result-actions">`
                            + `<button class="result-action-btn" data-action="addpl-np" data-sidx="${idx}" title="添加到歌单">`
                                + `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`
                            + `</button>`
                            + `<button class="fav-item-delete" data-del-np="${idx}" title="从队列移除">`
                                + `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">`
                                    + `<line x1="6" y1="6" x2="18" y2="18"></line>`
                                    + `<line x1="18" y1="6" x2="6" y2="18"></line>`
                                + `</svg>`
                            + `</button>`
                        + `</div>`
                    + `</div>`;
            });
            playlistsListEl.innerHTML = html;
            const __npHead = playlistsListEl.querySelector('.rank-list-head');
            if (__npHead) __npHead.appendChild(Aria.__songViewBtn(playlistsListEl));
            Aria.__applySongViewTo(playlistsListEl);
        }

/* 渲染歌单详情视图 */
function renderPlaylistDetail(playlistId) {
            resetListScroll();
            const playlists = getPlaylists();
            const pl = playlists.find(p => p.id === playlistId);
            if (!pl) { renderPlaylistsView(); return; }
            playlistViewMode = 'detail';
            currentPlaylistId = playlistId;
            playlistsTitleEl.textContent = pl.name;
            playlistBackBtn.classList.add('visible');
            playlistCreateBox.style.display = 'none';

            if (pl.songs.length === 0) {
                playlistsListEl.innerHTML = '<div class="empty-hint">歌单暂无歌曲</div>';
                playlistsHintEl.textContent = '';
                return;
            }
            playlistsHintEl.textContent = `共 ${pl.songs.length} 首歌曲`;
            let html = '';
            /* ★ 歌单批量操作状态（编辑模式：勾选 → 删除选中） */
            const bEdit = globalThis.plMultiEdit === true;
            if (!(globalThis.plMultiSel instanceof Set)) globalThis.plMultiSel = new Set();
            const bSel = globalThis.plMultiSel;
            /* 整单播放入口 + 批量编辑切换 */
            html += `
                <div class="rank-list-head" style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
                    <div class="play-all-btn" id="playAllBtn" data-pid="${escapeHtml(pl.id)}" style="flex:1;margin-bottom:0;">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="#fff"><path d="M6 4l14 8-14 8V4z" stroke="#fff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path></svg>
                        <span>播放全部（${pl.songs.length}）</span>
                    </div>
                    ${bEdit
                        ? `<label class="pl-batch-all" title="全选/全不选">
                            <input type="checkbox" id="plBatchAll"${bSel.size === pl.songs.length && pl.songs.length > 0 ? ' checked' : ''}>
                            <span id="plBatchAllLabel">${bSel.size === pl.songs.length && pl.songs.length > 0 ? '全不选' : '全选'}</span>
                          </label>
                          <button class="setting-btn primary" id="plBatchDone" style="padding:6px 10px;white-space:nowrap;">
                            ${bSel.size > 0 ? `删除选中(<b id="plSelCount">${bSel.size}</b>)` : '完成'}</button>`
                        : `<button class="setting-btn" id="plBatchToggle" style="padding:6px 10px;white-space:nowrap;">多选</button>
                           <button class="setting-btn" id="plBatchDl" title="依次下载本歌单全部歌曲" style="padding:6px 10px;white-space:nowrap;">批量下载</button>
                           <button class="setting-btn" id="plMergeBtn" title="合并到其它歌单" style="padding:6px 10px;white-space:nowrap;">合并到...</button>`}
                </div>`;
            /* ★ 宫格切换按钮挂载已移至 innerHTML 注入之后（见 L1427） */
            const favs = getFavorites();
            pl.songs.forEach((song, idx) => {
                const title = escapeHtml(song.title || '未知歌曲');
                const artist = escapeHtml(song.artist || '未知歌手');
                const cover = song.cover || '';
                const songKey = song.key || '';
                const isFav = favs.some(f => f.key === songKey);
                const coverHtml = cover
                    ? `<img class="result-cover" src="${escapeHtml(cover)}" alt="" onerror="this.style.visibility='hidden'">`
                    : `<div class="result-cover" style="display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.1);"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg></div>`;
                const checked = bSel.has(idx) ? ' checked' : '';
                html += `
                    <div class="result-item playlist-song-drag-item${bEdit ? ' pl-edit-on' : ''}" draggable="true" data-pid="${escapeHtml(pl.id)}" data-sidx="${idx}">
                        ${bEdit ? `<input type="checkbox" class="pl-multi-cb" data-sidx="${idx}"${checked}>` : ''}
                        ${coverHtml}
                        <div class="result-info">
                            <div class="result-title">${title}</div>
                            <div class="result-artist">${artist}${(typeof Aria.__platformIconHTML === 'function' ? Aria.__platformIconHTML(song.source || song.src) : '')}</div>
                        </div>
                        <div class="result-actions">
                            <button class="result-action-btn" data-action="addnow-pl" data-sidx="${idx}" title="加入当前播放">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5v14l11-7z"></path></svg>
                            </button>
                            <button class="result-action-btn ${isFav ? 'active-fav' : ''}" data-action="fav-pl" data-sidx="${idx}" title="${isFav ? '取消收藏' : '收藏'}">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path></svg>
                            </button>
                            ${bEdit ? '' : `<button class="fav-item-delete" data-del-song="${idx}" title="移除">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                                    <line x1="6" y1="6" x2="18" y2="18"></line>
                                    <line x1="18" y1="6" x2="6" y2="18"></line>
                                </svg>
                            </button>`}
                        </div>
                    </div>`;
            });
            playlistsListEl.innerHTML = html;

            /* ★ 修复：宫格切换按钮须在 new innerHTML 注入后挂载（此前在赋值前 query，
               .rank-list-head 取到旧视图残留/为空 → 所有歌单详情（含链接导入）缺切换按钮） */
            const __plHead = playlistsListEl.querySelector('.rank-list-head');
            if (__plHead) __plHead.appendChild(Aria.__songViewBtn(playlistsListEl));
            Aria.__applySongViewTo(playlistsListEl);

            /* ★ 批量操作交互：多选切换 / 勾选 / 删除选中 / 批量下载 / 合并到... */
            const _batchToggle = document.getElementById('plBatchToggle');
            const _batchDone = document.getElementById('plBatchDone');
            const _batchDl = document.getElementById('plBatchDl');
            const _mergeBtn = document.getElementById('plMergeBtn');
            if (_batchDl) {
                _batchDl.onclick = () => {
                    if (typeof window.batchDownloadSongs === 'function') {
                        window.batchDownloadSongs(pl.songs, pl.name + ' ');
                    } else if (typeof setHint === 'function') setHint('批量下载暂不可用');
                };
            }
            if (_mergeBtn) {
                _mergeBtn.onclick = () => {
                    if (typeof window.mergePlaylistInto === 'function') window.mergePlaylistInto(playlistId);
                    else if (typeof setHint === 'function') setHint('合并暂不可用');
                };
            }
            if (_batchToggle) {
                _batchToggle.onclick = () => {
                    globalThis.plMultiEdit = true;
                    globalThis.plMultiSel = new Set();
                    renderPlaylistDetail(playlistId);
                };
            }
            /* ★ 编辑模式下「全选 / 全不选」 */
            const _batchAll = document.getElementById('plBatchAll');
            const _batchAllLabel = document.getElementById('plBatchAllLabel');
            if (_batchAll) {
                _batchAll.onchange = () => {
                    const sel = globalThis.plMultiSel || new Set();
                    if (_batchAll.checked) pl.songs.forEach((_, i) => sel.add(i));
                    else sel.clear();
                    renderPlaylistDetail(playlistId);
                };
                if (_batchAllLabel) {
                    _batchAllLabel.textContent = _batchAll.checked ? '全不选' : '全选';
                }
            }
            if (_batchDone) {
                _batchDone.onclick = () => {
                    const sel = globalThis.plMultiSel || new Set();
                    if (sel.size > 0) {
                        const idxs = Array.from(sel).sort((a, b) => b - a);
                        const plRef = getPlaylists().find(p => p.id === playlistId);
                        if (plRef) {
                            idxs.forEach(i => { if (i >= 0 && i < plRef.songs.length) plRef.songs.splice(i, 1); });
                            if (plRef.songs.length > 0) plRef.cover = plRef.songs[0].cover || '';
                            savePlaylists(getPlaylists());
                        }
                    }
                    globalThis.plMultiEdit = false;
                    globalThis.plMultiSel = new Set();
                    renderPlaylistDetail(playlistId);
                };
            }
            if (bEdit) {
                playlistsListEl.querySelectorAll('.pl-multi-cb').forEach(cb => {
                    /* 阻止勾选冒泡到 item，避免触发放歌 */
                    cb.addEventListener('click', (e) => { e.stopPropagation(); });
                    cb.onchange = () => {
                        const i = Number(cb.dataset.sidx);
                        if (cb.checked) globalThis.plMultiSel.add(i);
                        else globalThis.plMultiSel.delete(i);
                        const cnt = document.getElementById('plSelCount');
                        if (cnt) cnt.textContent = String(globalThis.plMultiSel.size);
                        const done = document.getElementById('plBatchDone');
                        if (done) {
                            done.innerHTML = globalThis.plMultiSel.size > 0
                                ? `删除选中(<b id="plSelCount">${globalThis.plMultiSel.size}</b>)`
                                : '完成';
                        }
                        /* 同步「全选/全不选」勾选与文案 */
                        const allBox = document.getElementById('plBatchAll');
                        const allLabel = document.getElementById('plBatchAllLabel');
                        const allChecked = globalThis.plMultiSel.size === pl.songs.length && pl.songs.length > 0;
                        if (allBox) allBox.checked = allChecked;
                        if (allLabel) allLabel.textContent = allChecked ? '全不选' : '全选';
                    };
                });
                /* 编辑模式下关闭拖拽排序，避免误触 */
                playlistsListEl.querySelectorAll('.playlist-song-drag-item').forEach(el => { el.draggable = false; });
            }
            _bindFlipDrag(playlistsListEl, '.playlist-song-drag-item', () => {
                const songEls = Array.from(playlistsListEl.querySelectorAll('.playlist-song-drag-item'));
                const originalSongs = [...pl.songs];
                const newSongs = [];
                songEls.forEach(el => {
                    const origIdx = parseInt(el.dataset.sidx, 10);
                    if (!isNaN(origIdx) && originalSongs[origIdx]) {
                        newSongs.push(originalSongs[origIdx]);
                    }
                });
                if (newSongs.length === pl.songs.length) {
                    pl.songs = newSongs;
                    if (pl.songs.length > 0) pl.cover = pl.songs[0].cover || '';
                    savePlaylists(playlists);
                    /* 更新 DOM 上的 sidx 索引标记 */
                    songEls.forEach((el, newIdx) => {
                        el.dataset.sidx = newIdx;
                        el.querySelectorAll('[data-sidx]').forEach(btn => btn.dataset.sidx = newIdx);
                        el.querySelectorAll('[data-del-song]').forEach(btn => btn.dataset.delSong = newIdx);
                    });
                }
            });
        }

/* 渲染添加到歌单选择列表 */
function renderAddToPlaylistList() {
            const playlists = getPlaylists();
            if (playlists.length === 0) {
                addToPlaylistListEl.innerHTML = '<div class="empty-hint">还没有歌单，请先创建</div>';
                addToPlaylistHintEl.textContent = '';
                return;
            }
            addToPlaylistHintEl.textContent = `当前歌曲: ${currentSongData ? currentSongData.title : '未知'}`;
            const songKey = currentSongKey;
            let html = '';
            playlists.forEach(pl => {
                const name = escapeHtml(pl.name || '未命名歌单');
                const count = pl.songs.length;
                const exists = pl.songs.some(s => s.key === songKey);
                html += `
                    <div class="add-to-playlist-item ${exists ? 'disabled' : ''}" data-pid="${escapeHtml(pl.id)}">
                        <div class="add-to-playlist-name">${name}</div>
                        ${exists ? '<span class="playlist-tag">已添加</span>' : ''}
                        <div class="add-to-playlist-count">${count} 首</div>
                    </div>`;
            });
            addToPlaylistListEl.innerHTML = html;
        }

/* 从歌单歌曲对象播放（复用 loadOnlineSong / 本地播放逻辑） */
async function playFromPlaylistSong(song) {
            closePlaylists();
            playlistsHintEl.textContent = `加载中: ${song.title}`;
            if (song.source && song.id) {
                const songInfo = { id: song.id, mid: song.mid || '', song: song.title, singer: song.artist, cover: song.cover };
                currentSource = song.source;
                sourceBtns.forEach(b => b.classList.toggle('active', b.dataset.source === song.source));
                await loadOnlineSong(songInfo, true);
                playlistsHintEl.textContent = '';
            } else if (song.url) {
                playlist = [{ url: song.url, title: song.title, artist: song.artist }];
                currentTrackIndex = 0;
                audio.pause();
                audio.removeAttribute('src');
                audio.src = getStreamCachedAudioUrl(song.url, song.mid || song.id || song.title);
                audio.load();
                songTitleEl.textContent = song.title;
                songArtistEl.textContent = song.artist;
                currentSongData = { title: song.title, artist: song.artist, cover: song.cover || '', source: 'local', url: song.url };
                currentSongKey = makeSongKey(currentSongData);
                lyricOffset = getLyricOffset(currentSongKey); updateLyricOffsetUI();
                updateLineTimes();
                updateFavoriteBtn();
                if (song.cover) { setCoverImage(song.cover); setBlurBackground(song.cover); }
                playlistsHintEl.textContent = '';
                /* 等待音频就绪后再播放（统一走 _playLocalTrackOnReady，失败/超时提示歌单侧文案） */
                _playLocalTrackOnReady(playbackGeneration, {
                    refill: false, stagger: false,
                    onPlayFail: () => { playlistsHintEl.textContent = '播放失败'; },
                    onTimeout: () => { playlistsHintEl.textContent = '音频加载超时'; }
                });
            }
        }

/* 歌单详情中收藏/取消收藏某首歌曲 */
function togglePlaylistSongFav(sidx) {
            if (!currentPlaylistId) return;
            const playlists = getPlaylists();
            const pl = playlists.find(p => p.id === currentPlaylistId);
            if (!pl || !pl.songs[sidx]) return;
            const song = pl.songs[sidx];
            const songKey = song.key || makeSongKey(song);
            toggleFavCore(song, { key: songKey });
            if (currentSongKey === songKey) updateFavoriteBtn();
            renderPlaylistDetail(currentPlaylistId);
            if (favoritesOverlay.classList.contains('visible')) renderFavoritesList();
        }

/* 整单播放：把歌单所有歌曲放入 playlist 依次播放 */
async function playEntirePlaylist(playlistId) {
            const playlists = getPlaylists();
            const pl = playlists.find(p => p.id === playlistId);
            if (!pl || pl.songs.length === 0) return;
            closePlaylists();
            playlistsHintEl.textContent = `正在加载歌单: ${pl.name}`;
            /* 构造播放队列（title 多字段兜底，避免个别条目缺 title 时首曲显示「未知歌曲」） */
            playlist = pl.songs.map(s => ({
                url: null, title: s.title || s.song || s.name, artist: s.artist,
                cover: s.cover, source: s.source, id: s.id, mid: s.mid,
                key: s.key
            }));
            currentTrackIndex = 0;
            await loadPlaylistTrack(0);
            playlistsHintEl.textContent = '';
        }

export { _bindLocalMusicBannerEvents, addToPlaylist, addToPlaylistCloseBtn, addToPlaylistHintEl, addToPlaylistListEl, addToPlaylistOverlay, createPlaylist, deletePlaylist, generatePlaylistId, getPlaylists, importConfirmBtn, importHintEl, importPlaylistCloseBtn, importPlaylistOverlay, importProgressFill, importProgressText, importProgressWrap, importUrlInput, playEntirePlaylist, playFromPlaylistSong, playLocalMusicSong, playlistBackBtn, playlistCreateBox, playlistCreateConfirmBtn, playlistCreateToggleBtn, playlistImportToggleBtn, playlistNameInput, playlistSaveQueueBtn, playlistsCloseBtn, playlistsHintEl, playlistsListEl, playlistsOverlay, playlistsTitleEl, removeFromPlaylist, renamePlaylist, renderAddToPlaylistList, renderLocalMusicDetail, renderNowPlayingDetail, renderPlaylistDetail, renderPlaylistsView, savePlaylists, saveQueueAsPlaylist, togglePlaylistSongFav };
