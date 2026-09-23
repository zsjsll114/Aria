/* ============================================================
 * 125-favorites.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 3661-3868 行 | 单元数: 14
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { escapeHtml } from '../utils/formatters.js';
import { audio } from './20-lyrics-render.js';
import { favoriteBtn, favoritesCloseBtn, favoritesHintEl, favoritesListEl, favoritesOverlay, openFavoritesBtn, songArtistEl, songTitleEl, sourceBtns } from './30-dom-refs.js';
import { setBlurBackground, setCoverImage } from './100-cover-background.js';
import { getFavorites, saveFavorites, setHint, toggleFavorite, updateFavoriteBtn } from './120-search-results.js';
import { applyVolumeOnSongChange, loadPlaylistTrack, openAddToPlaylist } from './135-crossfade.js';
import { loadOnlineSong } from './175-track-index-online.js';
import { getStreamCachedAudioUrl } from './180-boot-config.js';

favoriteBtn?.addEventListener('click', toggleFavorite);

if (typeof document !== 'undefined') {
            document.getElementById('addToPlaylistBtn')?.addEventListener('click', openAddToPlaylist);
        }

/* 渲染收藏列表 */
function renderFavoritesList() {
            const favs = getFavorites();
            if (favs.length === 0) {
                favoritesListEl.innerHTML = '<div class="empty-hint">还没有收藏的歌曲</div>';
                favoritesHintEl.textContent = '';
                return;
            }
            favoritesHintEl.textContent = `共 ${favs.length} 首收藏`;
            let html = '';
            /* 播放全部 + 视图切换 */
            html += `
                <div class="rank-list-head" style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
                    <div class="play-all-btn" id="favPlayAllBtn" style="flex:1;margin-bottom:0;">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="#fff"><path d="M6 4l14 8-14 8V4z" stroke="#fff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path></svg>
                        <span>播放全部（${favs.length}）</span>
                    </div>
                </div>`;
            favs.forEach((f, idx) => {
                const title = escapeHtml(f.title || '未知歌曲');
                const artist = escapeHtml(f.artist || '未知歌手');
                const cover = f.cover || '';
                const sourceLabel = f.source === 'tencent' ? 'QQ' : (f.source === 'netease' ? '网易云' : (f.source === 'kugou' ? '酷狗' : (f.source ? f.source : '本地')));
                html += `<div class="result-item" data-idx="${idx}">
                    <img class="result-cover" src="${cover}" alt="" onerror="this.style.visibility='hidden'">
                    <div class="result-info">
                        <div class="result-title">${title}</div>
                        <div class="result-artist">${artist} · ${sourceLabel}</div>
                    </div>
                    <div class="result-actions">
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
            const favHeadEl = favoritesListEl.querySelector('.rank-list-head');
            if (favHeadEl) favHeadEl.appendChild(Aria.__songViewBtn(favoritesListEl));
            Aria.__applySongViewTo(favoritesListEl);
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

if (typeof document !== "undefined") document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && favoritesOverlay.classList.contains('visible')) {
                closeFavorites();
            }
        });

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

/* 将收藏歌曲加入当前播放队列 */
function addFavToNowPlaying(idx) {
            const favs = getFavorites();
            if (idx < 0 || idx >= favs.length) return;
            const f = favs[idx];
            if (f.source && f.id) {
                playlist.push({
                    url: null, title: f.title, artist: f.artist,
                    cover: f.cover || '', source: f.source, id: f.id, mid: f.mid || ''
                });
            } else if (f.url) {
                playlist.push({
                    url: f.url, title: f.title, artist: f.artist, cover: f.cover || ''
                });
            }
        }

/* 播放全部收藏 */
async function playEntireFavorites() {
            const favs = getFavorites();
            if (favs.length === 0) return;
            closeFavorites();
            playlist = favs.map(f => ({
                url: f.url || null, title: f.title, artist: f.artist,
                cover: f.cover || '', source: f.source || '', id: f.id || '', mid: f.mid || '',
                key: f.key || ''
            }));
            currentTrackIndex = 0;
            await loadPlaylistTrack(0);
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
            playFromFavorite(favs[idx]);
        });

/* 从收藏播放：在线歌曲重新请求接口，本地歌曲直接用记录的url */
async function playFromFavorite(fav) {
            closeFavorites();
            favoritesHintEl.textContent = `加载中: ${fav.title}`;
            /* ★ 推断有效音源：老收藏/跨源播放可能没记录 source，缺省按 mid 推断，
               （有 mid=QQ，否则网易云）。effSource 同时写进 songInfo.source，
               使 fetchLyricWithFallback 优先用 songInfo.source，而非易被预加载并发改写的
               模块级 currentSource —— 这是收藏点歌偶发「有音无词」的根因。 */
            const effSource = fav.source || (fav.mid ? 'tencent' : (fav.id ? 'netease' : ''));
            if (effSource && fav.id) {
                /* 在线歌曲：复用 loadOnlineSong 流程，构造 songInfo */
                const songInfo = { id: fav.id, mid: fav.mid || '', song: fav.title, singer: fav.artist, cover: fav.cover, source: effSource };
                currentSource = effSource;
                /* 同步音源切换按钮状态 */
                sourceBtns.forEach(b => {
                    b.classList.toggle('active', b.dataset.source === effSource);
                });
                await loadOnlineSong(songInfo, true);
                favoritesHintEl.textContent = '';
            } else if (fav.url) {
                /* 本地文件（url 为 blob，刷新后失效，作容错处理） */
                playlist = [{ url: fav.url, title: fav.title, artist: fav.artist }];
                currentTrackIndex = 0;
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
