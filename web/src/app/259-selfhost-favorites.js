/* ============================================================
 * 259-selfhost-favorites.js — 自建服务「收藏」（我喜欢的歌 / 我的歌单）
 * - 独立弹窗 #selfFavOverlay，仿榜单弹窗（search-overlay / search-modal）
 * - 顶部 source-toggle#selfFavTabs 三平台；#selfFavModes 两种视图
 * - 「我的歌单」点卡片进入歌单内歌曲，返回箭头回列表
 * - 数据走 selfhost-runtime 的 selfhostFavorites/Playlists/PlaylistSongs
 * - 播放复用 loadOnlineSong（在线播放链），记录最近播放
 * 任何异常都安全降级为弹窗内报错，不阻塞主播放层。
 * ============================================================ */
import { loadOnlineSong } from './175-track-index-online.js';
import { invalidateSelfhostCaches, selfhostCloudLike, selfhostEnabled, selfhostFavorites, selfhostPlaylists, selfhostPlaylistSongs } from './selfhost-runtime.js';
import { setHint, getFavorites, makeSongKey, saveFavorites, toggleFavCore } from './120-search-results.js';
import { loadPlaylistTrack, openAddToPlaylist } from './135-crossfade.js';
import { buildCollectionQueue, enqueueTrack } from '../core/playlistQueue.js';
import { logCatch, logInfo, logWarn, logError } from '../services/log.js';

const $ = (id) => typeof document !== 'undefined' ? document.getElementById(id) : null;

/* 通用转义（与 258-rankings 等分片一致） */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ★ 自建歌单缓存：进入先用缓存秒开，再后台刷新（TTL 5 分钟） */
const FAV_CACHE_TTL = 5 * 60 * 1000;
function favCacheKey(src, mode) { return 'selfhost_fav_cache_' + src + '_' + String(mode).replace(/[^A-Za-z0-9_:.-]/g, '_'); }
function favCacheGet(src, mode) {
  try {
    const c = JSON.parse(localStorage.getItem(favCacheKey(src, mode)) || 'null');
    if (c && Date.now() - c.at < FAV_CACHE_TTL) return c.data;
  } catch (e) { logCatch('selfhostFavorites', e); }
  return null;
}
function favCacheSet(src, mode, data) {
  try { localStorage.setItem(favCacheKey(src, mode), JSON.stringify({ at: Date.now(), data })); } catch (e) { logCatch('selfhostFavorites', e); }
}
function clearAllFavCaches() {
  try {
    const rm = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('selfhost_fav_cache_')) rm.push(k);
    }
    rm.forEach(k => localStorage.removeItem(k));
  } catch (e) { logCatch('selfhostFavorites', e); }
}

const state = { src: 'netease', mode: 'liked', sub: null, subCard: null, navTitle: '', cards: [], pool: [] };
let _favLoadSeq = 0;

const SRC_LABEL = { qq: 'QQ音乐', kugou: '酷狗音乐', netease: '网易云' };

function openSelfFavorites(initialSrc) {
  const ov = $('selfFavOverlay');
  if (!ov) return;
  if (initialSrc && SRC_LABEL[initialSrc]) state.src = initialSrc;
  /* ★ 每次打开先重建平台 tab（防残留 active / 与默认 src 不一致），再统一高亮，
     避免"无选中/全选中且显示的平台与选中不符"的错乱 */
  const tabs = $('selfFavTabs');
  if (tabs) {
    tabs.innerHTML = '<button class="source-btn" data-fsrc="qq">QQ音乐</button><button class="source-btn" data-fsrc="kugou">酷狗音乐</button><button class="source-btn" data-fsrc="netease">网易云</button>';
  }
  ov.classList.add('visible');
  state.sub = null;
  syncTabs();
  syncModes();
  loadCurrent();
}
function closeSelfFavorites() { $('selfFavOverlay')?.classList.remove('visible'); }

/* 顶部平台 tab 高亮 */
function syncTabs() {
  $('selfFavTabs')?.querySelectorAll('.source-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.fsrc === state.src));
}
function syncModes() {
  $('selfFavModes')?.querySelectorAll('.rank-chip').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.fmode === state.mode);
    if (btn.dataset.fmode === 'liked') {
      btn.textContent = state.src === 'kugou' ? '默认收藏' : '我喜欢的歌';
    }
  });
}

function setFavNav(show, title, count) {
  const nav = $('selfFavNav');
  if (nav) nav.hidden = !show;
  const tt = $('selfFavNavTitle');
  const cc = $('selfFavNavCount');
  if (tt) tt.textContent = title || '';
  if (cc) cc.textContent = count && count > 0 ? `${count} 首` : '';
  $('selfFavModes').hidden = state.sub ? true : false;
}

/* 命中当前视图：liked / playlists / playlist(卡片已点开) */
async function loadCurrent(forceRefresh = false) {
  const listEl = $('selfFavList');
  if (!listEl) return;
  const seq = ++_favLoadSeq;
  const src = state.src;
  if (!selfhostEnabled(src)) {
    Aria.__clearSongView?.(listEl, false);
    listEl.innerHTML = `<div class="rank-error">「${SRC_LABEL[src]}」未启用自建服务<br><span style="font-size:11px;opacity:.7">请到「设置 → 自建服务」启用并扫码登录</span></div>`;
    return;
  }
  if (state.sub && state.mode === 'playlists') {
    const key = state.sub;
    setFavNav(true, state.navTitle, 0);
    /* 缓存秒开 + 后台刷新 */
    const cachedList = forceRefresh ? null : favCacheGet(src, 'pl_' + key);
    if (Array.isArray(cachedList) && cachedList.length) {
      setFavNav(true, state.navTitle, cachedList.length);
      renderSongList(cachedList);
    } else {
      Aria.skeleton.load(listEl, 'list', 8);
    }
    const res = await selfhostPlaylistSongs(src, key, state.subCard);
    if (seq !== _favLoadSeq || state.src !== src) return;
    if (!res.ok) {
      if (!Array.isArray(cachedList) || !cachedList.length) {
        Aria.__clearSongView?.(listEl, false);
        listEl.innerHTML = `<div class="rank-error">${esc(res.err || '获取失败')}</div>`;
      }
      return;
    }
    favCacheSet(src, 'pl_' + key, res.list);
    setFavNav(true, res.title || state.navTitle, res.list.length);
    renderSongList(res.list);
    return;
  }
  /* 顶层：我喜欢的歌 / 我的歌单 */
  setFavNav(false);
  if (state.mode === 'liked') return loadLiked(listEl, forceRefresh, seq, src);
  return loadPlaylists(listEl, forceRefresh, seq, src);
}

async function loadLiked(listEl, forceRefresh = false, seq = _favLoadSeq, src = state.src) {
  const favName = src === 'kugou' ? '默认收藏' : '我喜欢的歌';
  const cached = forceRefresh ? null : favCacheGet(src, 'liked');
  if (Array.isArray(cached) && cached.length) {
    setFavNav(true, `${favName} · ${SRC_LABEL[src]}`, cached.length);
    renderSongList(cached);
  } else {
    Aria.skeleton.load(listEl, 'list', 9);
  }
  const res = await selfhostFavorites(src);
  if (seq !== _favLoadSeq || state.src !== src) return;
  if (!res.ok) {
    if (!Array.isArray(cached) || !cached.length) {
      Aria.__clearSongView?.(listEl, false);
      listEl.innerHTML = `<div class="rank-error">${esc(res.err || '获取失败')}<br><span style="font-size:11px;opacity:.7">请先到「设置 → 自建服务」扫码登录对应平台</span></div>`;
    }
    return;
  }
  if (res.unsupported) {
    Aria.__clearSongView?.(listEl, false);
    listEl.innerHTML = `<div class="rank-empty">${SRC_LABEL[src]} 此接口仅返回统计信息，无法取完整曲目<br><span style="font-size:11px;opacity:.85">可切换到「我的歌单」查看收藏的歌单</span></div>
      <div style="text-align:center;margin-top:14px;"><button class="rank-retry" id="selfFavGoPlaylists">查看我的歌单</button></div>`;
    const b = $('selfFavGoPlaylists');
    if (b) b.onclick = () => { state.mode = 'playlists'; syncModes(); loadCurrent(); };
    return;
  }
  if (!res.list || !res.list.length) {
    if (!Array.isArray(cached) || !cached.length) {
      Aria.__clearSongView?.(listEl, false);
      listEl.innerHTML = `<div class="rank-empty">«${esc(favName)}»还没有歌曲</div>`;
    }
    return;
  }
  favCacheSet(src, 'liked', res.list);
  setFavNav(true, res.title, res.list.length);
  renderSongList(res.list);
}

async function loadPlaylists(listEl, forceRefresh = false, seq = _favLoadSeq, src = state.src) {
  const cached = forceRefresh ? null : favCacheGet(src, 'playlists');
  if (Array.isArray(cached) && cached.length) {
    state.cards = cached;
    renderCards(cached);
  } else {
    Aria.skeleton.load(listEl, 'cards', 9);
  }
  const res = await selfhostPlaylists(src);
  if (seq !== _favLoadSeq || state.src !== src) return;
  if (!res.ok) {
    if (!Array.isArray(cached) || !cached.length) {
      Aria.__clearSongView?.(listEl, false);
      listEl.innerHTML = `<div class="rank-error">${esc(res.err || '获取失败')}<br><span style="font-size:11px;opacity:.7">请先到「设置 → 自建服务」扫码登录对应平台</span></div>`;
    }
    return;
  }
  const cards = res.cards || [];
  if (!cards.length) {
    if (!Array.isArray(cached) || !cached.length) {
      Aria.__clearSongView?.(listEl, false);
      listEl.innerHTML = '<div class="rank-empty">账号下暂无歌单</div>';
    }
    return;
  }
  state.cards = cards;
  favCacheSet(src, 'playlists', cards);
  renderCards(cards);
}

/* 普通歌单样式歌曲列表（.result-item 行式，顶部播放全部 + 行内操作按钮，与榜单/歌单一致） */
function renderSongList(songs) {
  const listEl = $('selfFavList');
  if (!Array.isArray(songs) || !songs.length) {
    Aria.__clearSongView?.(listEl, false);
    listEl.innerHTML = '<div class="rank-empty">该列表暂无歌曲</div>';
    return;
  }
  let favKeys = new Set();
  try { favKeys = new Set((getFavorites() || []).map(f => makeSongKey(f))); } catch (e) { /* ignore */ }
  listEl.innerHTML = `
    <div class="rank-list-head">
      <div class="rank-playall">
        <span style="font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M8 5v14l11-7z"></path></svg>播放全部（${songs.length}）
        </span>
      </div>
    </div>
    ${songs.map((s, i) => {
      const name = s.name || s.song || s.title || '';
      const singer = s.singer || s.author || '';
      const cover = s.cover || '';
      const np = (window.currentSongData && window.currentSongData.id === String(s.id)) ? ' now-playing-active' : '';
      const isFav = favKeys.has(makeSongKey(s));
      const coverHtml = cover
        ? `<img class="result-cover" src="${esc(cover)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
        : `<div class="result-cover" style="display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.1);"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg></div>`;
      return `<div class="result-item${np}" data-i="${i}">
        <span class="rank-sno">${i + 1}</span>
        ${coverHtml}
        <div class="result-info">
          <div class="result-title">${esc(name)}</div>
          <div class="result-artist">${esc(singer)}${s.source ? ' · ' + ({ tencent: 'QQ', kugou: '酷狗', netease: '网易', kuwo: '酷我' }[s.source] || s.source) : ''}</div>
        </div>
        <div class="result-actions">
          <button class="result-action-btn" data-action="playnext-self" data-i="${i}" title="下一首播放">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4l8 5-8 5V4z"></path><line x1="15" y1="6" x2="21" y2="6"></line><line x1="15" y1="12" x2="21" y2="12"></line><line x1="5" y1="18" x2="21" y2="18"></line></svg>
          </button>
          <button class="result-action-btn" data-action="addnow-self" data-i="${i}" title="加入当前播放">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5v14l11-7z"></path></svg>
          </button>
          <button class="result-action-btn" data-action="addpl-self" data-i="${i}" title="添加到歌单">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          </button>
          ${state.src === 'netease' ? `<button class="result-action-btn ${state.mode === 'liked' ? 'active-fav' : ''}" data-action="cloudlike-self" data-i="${i}" title="${state.mode === 'liked' ? '取消云端红心' : '红心同步到云端'}">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="${state.mode === 'liked' ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
          </button>` : ''}
          <button class="result-action-btn ${isFav ? 'active-fav' : ''}" data-action="fav-self" data-i="${i}" title="${isFav ? '取消收藏' : '收藏'}">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path></svg>
          </button>
        </div>
      </div>`;
    }).join('')}`;
  state.pool = songs;
  const playAllBar = listEl.querySelector('.rank-playall');
  if (playAllBar) playAllBar.onclick = () => playAllFavSongs(songs);
  Aria.__mountSongView(listEl);
  listEl.querySelectorAll('.result-item').forEach(el => {
    el.onclick = (e) => { if (e.target.closest('.result-action-btn')) return; playFavSong(Number(el.dataset.i)); };
  });
  listEl.querySelectorAll('.result-action-btn[data-action="playnext-self"]').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); playNextFavSong(songs[Number(btn.dataset.i)]); };
  });
  listEl.querySelectorAll('.result-action-btn[data-action="addnow-self"]').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); addFavSongNow(songs[Number(btn.dataset.i)]); };
  });
  listEl.querySelectorAll('.result-action-btn[data-action="addpl-self"]').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); addFavSongToPlaylist(songs[Number(btn.dataset.i)]); };
  });
  listEl.querySelectorAll('.result-action-btn[data-action="cloudlike-self"]').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const s = songs[Number(btn.dataset.i)];
      const wantLike = !btn.classList.contains('active-fav');
      btn.disabled = true;
      const r = await selfhostCloudLike(state.src, s, wantLike);
      btn.disabled = false;
      if (!r.ok) {
        if (typeof setHint === 'function') setHint(r.err || '云端红心操作失败');
        return;
      }
      btn.classList.toggle('active-fav', wantLike);
      const svg = btn.querySelector('svg');
      if (svg) svg.setAttribute('fill', wantLike ? 'currentColor' : 'none');
      if (typeof setHint === 'function') setHint(wantLike ? '已红心同步到云端' : '已取消云端红心');
      try { localStorage.removeItem(favCacheKey(state.src, 'liked')); } catch (err) { logCatch('selfhostFavorites', err); }
    };
  });
  listEl.querySelectorAll('.result-action-btn[data-action="fav-self"]').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); toggleFavSong(songs[Number(btn.dataset.i)], btn); };
  });
}

/* 播放全部：整单进队列并播第一首 */
function playAllFavSongs(songs) {
  if (!Array.isArray(songs) || !songs.length) return;
  const q = buildCollectionQueue(songs, 0, state.src || '');
  if (!q.playlist.length) return;
  try {
    if (typeof globalThis.playlist !== 'undefined' && Array.isArray(globalThis.playlist)) {
      globalThis.playlist = q.playlist;
      globalThis.currentTrackIndex = q.currentTrackIndex;
    }
  } catch (e) { logCatch('selfhostFavorites', e); }
  loadPlaylistTrack(0).catch(e => logWarn('selfhostFavorites', '[自建收藏] 播放全部失败:', e));
  if (typeof window.recordRecentPlay === 'function') window.recordRecentPlay(q.playlist[0]);
  if (typeof setHint === 'function') setHint(`播放全部：${q.playlist.length} 首已加入播放队列`);
}
/* 下一首播放 */
function playNextFavSong(song) {
  if (!song) return;
  if (typeof globalThis.Aria !== 'undefined' && typeof globalThis.Aria.enqueuePlayNextTrack === 'function') {
    const res = globalThis.Aria.enqueuePlayNextTrack(song, state.src || '');
    if (typeof setHint === 'function' && res && res.message) setHint(res.message);
    return;
  }
  addFavSongNow(song);
}
/* 加入当前播放 */
function addFavSongNow(song) {
  if (!song) return;
  let res = { added: false, duplicate: false };
  try {
    if (typeof globalThis.playlist !== 'undefined' && Array.isArray(globalThis.playlist)) {
      res = enqueueTrack(globalThis.playlist, song, state.src || '');
    }
  } catch (e) { logCatch('selfhostFavorites', e); }
  if (typeof setHint === 'function') {
    if (res.added) setHint('已加入当前播放队列');
    else if (res.duplicate) setHint('已在当前播放队列中');
  }
}
/* 添加到指定歌单：复用全局「加入歌单」弹层（130 renderAddToPlaylistList） */
function addFavSongToPlaylist(song) {
  if (!song) return;
  try {
    globalThis.currentSongData = {
      title: song.name || song.song || '',
      artist: song.singer || '',
      cover: song.cover || '',
      source: song.source || '',
      id: String(song.id != null ? song.id : '')
    };
    globalThis.currentSongKey = makeSongKey(song);
  } catch (e) { /* ignore */ }
  if (typeof openAddToPlaylist === 'function') openAddToPlaylist();
}
/* 收藏 / 取消收藏 */
function toggleFavSong(song, btn) {
  if (!song) return;
  try {
    const { faved } = toggleFavCore(song);
    if (btn) btn.classList.toggle('active-fav', faved);
    if (typeof setHint === 'function') setHint(faved ? '已加入收藏' : '已取消收藏');
  } catch (e) { logWarn('selfhostFavorites', '[自建收藏] 收藏失败:', e); }
}

function playFavSong(idx) {
  const s = state.pool[idx];
  if (!s) return;
  const q = buildCollectionQueue(state.pool, idx, state.src || '');
  if (!q.playlist.length) return;
  try {
    if (typeof globalThis.playlist !== 'undefined' && Array.isArray(globalThis.playlist)) {
      globalThis.playlist = q.playlist;
      globalThis.currentTrackIndex = q.currentTrackIndex;
    }
  } catch (e) { logCatch('selfhostFavorites', e); }
  loadPlaylistTrack(q.currentTrackIndex).catch(e => logWarn('selfhostFavorites', '[自建收藏] 播放失败:', e));
  if (typeof window.recordRecentPlay === 'function') window.recordRecentPlay(q.playlist[q.currentTrackIndex]);
}

/* 歌单宫格（复用 .rank-board-grid 卡片样式） */
function renderCards(cards) {
  const listEl = $('selfFavList');
  Aria.__clearSongView?.(listEl, false);   /* 歌单宫格视图不套用歌曲卡片布局 */
  const pal = ['#5b6b7f', '#7a6f8e', '#7d8a6a', '#8a6a6a', '#6a7f8e', '#8e7a6a', '#6a8e7f', '#8e6a7f', '#6f7f8e', '#7f8e6a'];
  listEl.innerHTML = Aria.__cardsCarouselBarHTML() + `<div class="rank-board-grid">${cards.map((b, i) => `
    <div class="rank-board-card" data-i="${i}" title="${esc(b.name)}">
      ${b.cover
        ? `<img class="rank-board-bg" src="${esc(b.cover)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
        : `<span class="rank-board-ph" style="background:linear-gradient(150deg,${pal[i % pal.length]},${pal[(i + 4) % pal.length]});"></span>`}
      <div class="rank-board-meta">
        <div class="rank-board-name">${esc(b.name)}</div>
        <div class="rank-board-count">${b.count ? b.count + ' 首' : ''}</div>
      </div>
      <span class="rank-card-src">${SRC_LABEL[state.src]}</span>
    </div>`).join('')}</div>`;
  Aria.__bindCardsCarouselBar(listEl);
  listEl.querySelectorAll('.rank-board-card').forEach(card => {
    card.onclick = () => openFavPlaylist(Number(card.dataset.i));
  });
}

async function openFavPlaylist(idx) {
  const b = (state.cards || [])[idx];
  if (!b || !b.key) return;
  state.sub = b.key;
  state.subCard = b;
  state.navTitle = b.name;
  syncModes();
  await loadCurrent();
}

function backToTop() {
  state.sub = null;
  state.subCard = null;
  state.navTitle = '';
  syncModes();
  loadCurrent();
}

(function initSelfFavorites() {
  if (typeof document === 'undefined') return;
  $('openSelfFavBtn')?.addEventListener('click', openSelfFavorites);
  $('selfFavCloseBtn')?.addEventListener('click', closeSelfFavorites);
  $('selfFavOverlay')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeSelfFavorites(); });
  $('selfFavTabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.source-btn');
    if (!btn || btn.dataset.fsrc === state.src) return;
    state.src = btn.dataset.fsrc;
    state.sub = null;
    state.subCard = null;
    state.navTitle = '';
    syncTabs();
    syncModes();
    loadCurrent();
  });
  $('selfFavModes')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.rank-chip');
    if (!btn) return;
    state.mode = btn.dataset.fmode;
    state.sub = null;
    state.navTitle = '';
    syncModes();
    loadCurrent();
  });
  $('selfFavBackBtn')?.addEventListener('click', backToTop);
  $('selfFavRefreshBtn')?.addEventListener('click', () => {
    invalidateSelfhostCaches();
    clearAllFavCaches();
    loadCurrent(true);
  });
  if (typeof window !== 'undefined') {
    window.addEventListener('selfhost-auth-changed', () => {
      clearAllFavCaches();
      if ($('selfFavOverlay')?.classList.contains('visible')) loadCurrent(true);
    });
  }
})();

window.openSelfFavorites = openSelfFavorites;
window.closeSelfFavorites = closeSelfFavorites;