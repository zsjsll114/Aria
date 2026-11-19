/* ============================================================
 * 125-favorites.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 3661-3868 行 | 单元数: 14
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { escapeHtml } from '../utils/formatters.js';
import { audio } from './20-lyrics-render.js';
import { favoriteBtn, favoritesCloseBtn, favoritesHintEl, favoritesListEl, favoritesOverlay, openFavoritesBtn, songArtistEl, songTitleEl } from './30-dom-refs.js';
import { setBlurBackground, setCoverImage } from './100-cover-background.js';
import { getFavorites, saveFavorites, setHint, toggleFavorite, updateFavoriteBtn } from './120-search-results.js';
import { applyVolumeOnSongChange, loadPlaylistTrack, openAddToPlaylist } from './135-crossfade.js';
import { loadOnlineSong } from './175-track-index-online.js';
import { getStreamCachedAudioUrl } from './180-boot-config.js';
import { buildCollectionQueue, enqueueTrack } from '../core/playlistQueue.js';

favoriteBtn?.addEventListener('click', toggleFavorite);

if (typeof document !== 'undefined') {
            document.getElementById('addToPlaylistBtn')?.addEventListener('click', openAddToPlaylist);
        }

/* 渲染收藏列表 */
function renderFavoritesList() {
            const favs = getFavorites();
            if (favs.length === 0) {
                Aria.__clearSongView(favoritesListEl);
                favoritesListEl.innerHTML = '<div class="empty-hint">还没有收藏的歌曲</div>';
                favoritesHintEl.textContent = '';
                return;
            }
            favoritesHintEl.textContent = `共 ${favs.length} 首收藏`;
            let html = '';
            /* 播放全部 + 视图切换 */
            html += `
                <div class="rank-list-head">
                    <div class="play-all-btn" id="favPlayAllBtn">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="#fff"><path d="M6 4l14 8-14 8V4z" stroke="#fff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path></svg>
                        <span>播放全部（${favs.length}）</span>
                    </div>
                </div>`;
            favs.forEach((f, idx) => {
                const title = escapeHtml(f.title || '未知歌曲');
                const artist = escapeHtml(f.artist || '未知歌手');
                const cover = f.cover || '';
                const sourceLabel = f.source === 'tencent' ? 'QQ' : (f.source === 'netease' ? '网易云音乐' : (f.source === 'kugou' ? '酷狗' : (f.source ? escapeHtml(f.source) : '本地')));
                html += `<div class="result-item" data-idx="${idx}">
                    <img class="result-cover" src="${escapeHtml(cover)}" alt="" onerror="this.style.visibility='hidden'">
                    <div class="result-info">
                        <div class="result-title">${title}</div>
                        <div class="result-artist">${artist} · ${sourceLabel}</div>
                    </div>
                    <div class="result-actions">
                        <button class="result-action-btn" data-action="playnext" data-idx="${idx}" title="下一首播放">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4l8 5-8 5V4z"></path><line x1="15" y1="6" x2="21" y2="6"></line><line x1="15" y1="12" x2="21" y2="12"></line><line x1="5" y1="18" x2="21" y2="18"></line></svg>
                        </button>
                        <button class="result-action-btn" data-action="addnow" data-idx="${idx}" title="加入当前播放">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5v14l11-7z"></path></svg>
                        </button>
                        <button class="result-action-btn" data-action="addpl" data-idx="${idx}" title="添加到歌单">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                        </button>
                        <button class="fav-item-delete" data-del="${idx}" title="移除">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <polyline points="3 6 5 6 21 6"></polyline>
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            </svg>
                        </button>
                    </div>
                </div>`;
            });
            favoritesListEl.innerHTML = html;
            Aria.__mountSongView(favoritesListEl);
        }

/* 打开/关闭收藏列表（与搜索弹窗一致的弹出动画） */
function openFavorites() {
favoritesOverlay.classList.add('visible');
renderFavoritesList();
}

function closeFavorites() {
            favoritesOverlay.classList.remove('visible');
        }

openFavoritesBtn?.addEventListener('click', openFavorites);

favoritesCloseBtn?.addEventListener('click', closeFavorites);

favoritesOverlay?.addEventListener('click', (e) => {
            if (e.target === favoritesOverlay) closeFavorites();
        });

/* ESC 关闭 —— ★ 2026-10-05（P3-b）移到 150-search-engine.js 的「逐层 ESC」链。
   此处原有一份独立 handler：收藏页叠在搜索页上按一次 ESC 时，
   document(本处) 先关收藏页，window(150) 的逐层链接着又关掉搜索页 —— 一次 ESC 连关两层。
   现在 ESC 只有一处实现：150 的逐层链（顺序即层序）。 */

/* 将收藏歌曲添加到歌单 */
function addFavToPlaylist(idx) {
            const favs = getFavorites();
            if (idx < 0 || idx >= favs.length) return;
            const f = favs[idx];
            currentSongData = {
                title: f.title || '未知歌曲',
                artist: f.artist || '未知歌手',
                cover: f.cover || '',
                source: f.source || '',
                id: f.id || '',
                mid: f.mid || ''
            };
            currentSongKey = f.key || '';
            openAddToPlaylist();
        }

/* 将收藏歌曲设为下一首播放 */
function playNextFav(idx) {
            const favs = getFavorites();
            if (idx < 0 || idx >= favs.length) return;
            const f = favs[idx];
            const fb = f.source || (f.mid ? 'tencent' : (f.id ? 'netease' : ''));
            if (typeof globalThis.Aria !== 'undefined' && typeof globalThis.Aria.enqueuePlayNextTrack === 'function') {
                const res = globalThis.Aria.enqueuePlayNextTrack(f, fb);
                if (typeof setHint === 'function' && res && res.message) setHint(res.message);
                return;
            }
            addFavToNowPlaying(idx);
        }

/* 将收藏歌曲加入当前播放队列 */
function addFavToNowPlaying(idx) {
            const favs = getFavorites();
            if (idx < 0 || idx >= favs.length) return;
            const f = favs[idx];
            const res = enqueueTrack(playlist, f, f.source || (f.mid ? 'tencent' : (f.id ? 'netease' : '')));
            if (typeof setHint === 'function') {
                if (res.added) setHint('已加入当前播放队列');
                else if (res.duplicate) setHint('已在当前播放队列中');
            }
        }

/* 播放全部收藏 */
async function playEntireFavorites() {
            const favs = getFavorites();
            if (favs.length === 0) return;
            closeFavorites();
            const q = buildCollectionQueue(favs, 0);
            if (!q.playlist.length) return;
            playlist = q.playlist;
            currentTrackIndex = q.currentTrackIndex;
            await loadPlaylistTrack(currentTrackIndex);
        }

/* 收藏列表点击：播放、删除或加入歌单 */
favoritesListEl?.addEventListener('click', (e) => {
            /* 播放全部 */
            const playAll = e.target.closest('#favPlayAllBtn');
            if (playAll) {
                playEntireFavorites();
                return;
            }
            /* 操作按钮优先 */
            const actionBtn = e.target.closest('.result-action-btn');
            if (actionBtn) {
                e.stopPropagation();
                const idx = parseInt(actionBtn.dataset.idx);
                if (isNaN(idx)) return;
                if (actionBtn.dataset.action === 'addpl') {
                    addFavToPlaylist(idx);
                } else if (actionBtn.dataset.action === 'playnext') {
                    playNextFav(idx);
                } else if (actionBtn.dataset.action === 'addnow') {
                    addFavToNowPlaying(idx);
                }
                return;
            }
            const delBtn = e.target.closest('.fav-item-delete');
            if (delBtn) {
                e.stopPropagation();
                const delIdx = parseInt(delBtn.dataset.del);
                const favs = getFavorites();
                if (delIdx >= 0 && delIdx < favs.length) {
                    favs.splice(delIdx, 1);
                    saveFavorites(favs);
                    renderFavoritesList();
                    updateFavoriteBtn();
                }
                return;
            }
            const item = e.target.closest('.result-item');
            if (!item) return;
            const idx = parseInt(item.dataset.idx);
            const favs = getFavorites();
            if (isNaN(idx) || !favs[idx]) return;
            const q = buildCollectionQueue(favs, idx);
            if (q.playlist.length) {
                playlist = q.playlist;
                currentTrackIndex = q.currentTrackIndex;
                playFromFavorite(q.playlist[currentTrackIndex], { skipPlaylistUpdate: true });
            } else {
                playFromFavorite(favs[idx]);
            }
        });

/* 从收藏播放：在线歌曲重新请求接口，本地歌曲直接用记录的url */
async function playFromFavorite(fav, opts) {
            closeFavorites();
            favoritesHintEl.textContent = `加载中: ${fav.title}`;
            /* ★ 推断有效音源：老收藏/跨源播放可能没记录 source，缺省按 mid 推断，
               （有 mid=QQ，否则网易云）。effSource 同时写进 songInfo.source，
               使 fetchLyricWithFallback 优先用 songInfo.source，而非易被预加载并发改写的
               模块级 currentSource —— 这是收藏点歌偶发「有音无词」的根因。 */
            const effSource = fav.source || (fav.mid ? 'tencent' : (fav.id ? 'netease' : ''));
            if (effSource && effSource !== 'local' && (fav.id || fav.mid || fav.hash)) {
                /* 在线歌曲：复用 loadOnlineSong 流程，构造 songInfo */
                const songInfo = {
                    id: fav.id || fav.hash || fav.mid || '',
                    mid: fav.mid || '',
                    hash: fav.hash || '',
                    song: fav.title || fav.song || '',
                    singer: fav.artist || fav.singer || '',
                    cover: fav.cover || '',
                    source: effSource
                };
                currentSource = effSource;
                await loadOnlineSong(songInfo, Boolean(opts && opts.skipPlaylistUpdate));
                favoritesHintEl.textContent = '';
            } else if (fav.url) {
                /* 本地文件（url 为 blob，刷新后失效，作容错处理） */
                if (!opts || !opts.skipPlaylistUpdate) {
                    playlist = [{ url: fav.url, title: fav.title, artist: fav.artist, isLocal: true, source: 'local' }];
                    currentTrackIndex = 0;
                }
                audio.pause();
                audio.removeAttribute('src');
                audio.src = getStreamCachedAudioUrl(fav.url, fav.mid || fav.id || fav.title);
                audio.load();
                songTitleEl.textContent = fav.title;
                songArtistEl.textContent = fav.artist;
                setHint('');
                favoritesHintEl.textContent = '';
                if (fav.cover) { setCoverImage(fav.cover); setBlurBackground(fav.cover); }
                /* 等待音频就绪后再播放（统一走 _playLocalTrackOnReady，失败/超时提示收藏侧文案） */
                _playLocalTrackOnReady(playbackGeneration, {
                    refill: false, stagger: false,
                    onPlayFail: () => { favoritesHintEl.textContent = '播放失败（本地文件链接可能已失效）'; },
                    onTimeout: () => { favoritesHintEl.textContent = '音频加载超时'; }
                });
            }
        }

export { addFavToNowPlaying, addFavToPlaylist, closeFavorites, openFavorites, playEntireFavorites, playFromFavorite, renderFavoritesList };
