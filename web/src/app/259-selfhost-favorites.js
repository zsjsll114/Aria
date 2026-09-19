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
import { selfhostEnabled, selfhostFavorites, selfhostPlaylists, selfhostPlaylistSongs } from './selfhost-runtime.js';
import { setHint, getFavorites, makeSongKey, saveFavorites, toggleFavCore } from './120-search-results.js';
import { openAddToPlaylist } from './135-crossfade.js';
import { logInfo, logWarn, logError } from '../services/log.js';

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
  } catch (e) { /* ignore */ }
  return null;
}
function favCacheSet(src, mode, data) {
  try { localStorage.setItem(favCacheKey(src, mode), JSON.stringify({ at: Date.now(), data })); } catch (e) { /* ignore */ }
}

const state = { src: 'netease', mode: 'liked', sub: null, navTitle: '', cards: [], pool: [] };

const SRC_LABEL = { qq: 'QQ音乐', kugou: '酷狗音乐', netease: '网易云' };

function openSelfFavorites() {
  const ov = $('selfFavOverlay');
  if (!ov) return;
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
  $('selfFavModes')?.querySelectorAll('.rank-chip').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.fmode === state.mode));
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
async function loadCurrent() {
  const listEl = $('selfFavList');
  if (!listEl) return;
  if (!selfhostEnabled(state.src)) {
    listEl.innerHTML = `<div class="rank-error">「${SRC_LABEL[state.src]}」未启用自建服务<br><span style="font-size:11px;opacity:.7">请到「设置 → 自建服务」启用并扫码登录</span></div>`;
    return;
  }
  if (state.sub && state.mode === 'playlists') {
    const key = state.sub;
    setFavNav(true, state.navTitle, 0);
    /* 缓存秒开 + 后台刷新 */
    const cachedList = favCacheGet(state.src, 'pl_' + key);
    if (Array.isArray(cachedList) && cachedList.length) {
      setFavNav(true, state.navTitle, cachedList.length);
      renderSongList(cachedList);
    } else {
      Aria.skeleton.load(listEl, 'list', 8);
    }
    const res = await selfhostPlaylistSongs(state.src, key);
    if (!res.ok) {
      if (!Array.isArray(cachedList) || !cachedList.length) listEl.innerHTML = `<div class="rank-error">${esc(res.err || '获取失败')}</div>`;
      return;
    }
    favCacheSet(state.src, 'pl_' + key, res.list);
    setFavNav(true, res.title || state.navTitle, res.list.length);
    renderSongList(res.list);
    return;
  }
  /* 顶层：我喜欢的歌 / 我的歌单 */
  setFavNav(false);
  if (state.mode === 'liked') return loadLiked(listEl);
  return loadPlaylists(listEl);
}

async function loadLiked(listEl) {
  const cached = favCacheGet(state.src, 'liked');
  if (Array.isArray(cached) && cached.length) {
    setFavNav(true, '我喜欢的歌 · ' + SRC_LABEL[state.src], cached.length);
    renderSongList(cached);
  } else {
    Aria.skeleton.load(listEl, 'list', 9);
  }
  const res = await selfhostFavorites(state.src);
  if (!res.ok) {
    if (!Array.isArray(cached) || !cached.length) listEl.innerHTML = `<div class="rank-error">${esc(res.err || '获取失败')}<br><span style="font-size:11px;opacity:.7">请先到「设置 → 自建服务」扫码登录对应平台</span></div>`;
    return;
  }
  if (res.unsupported) {
    listEl.innerHTML = `<div class="rank-empty">${SRC_LABEL[state.src]} 此接口仅返回统计信息，无法取完整曲目<br><span style="font-size:11px;opacity:.85">可切换到「我的歌单」查看收藏的歌单</span></div>
      <div style="text-align:center;margin-top:14px;"><button class="rank-retry" id="selfFavGoPlaylists">查看我的歌单</button></div>`;
    const b = $('selfFavGoPlaylists');
    if (b) b.onclick = () => { state.mode = 'playlists'; syncModes(); loadCurrent(); };
    return;
  }
  if (!res.list || !res.list.length) {
    if (!Array.isArray(cached) || !cached.length) listEl.innerHTML = '<div class="rank-empty">«我喜欢的歌»还没有歌曲</div>';
    return;
  }
  favCacheSet(state.src, 'liked', res.list);
  setFavNav(true, res.title, res.list.length);
  renderSongList(res.list);
}

async function loadPlaylists(listEl) {
  const cached = favCacheGet(state.src, 'playlists');
  if (Array.isArray(cached) && cached.length) {
    state.cards = cached;
    renderCards(cached);
  } else {
    Aria.skeleton.load(listEl, 'cards', 9);
  }
  const res = await selfhostPlaylists(state.src);
  if (!res.ok) {
    if (!Array.isArray(cached) || !cached.length) listEl.innerHTML = `<div class="rank-error">${esc(res.err || '获取失败')}<br><span style="font-size:11px;opacity:.7">请先到「设置 → 自建服务」扫码登录对应平台</span></div>`;
    return;
  }
  const cards = res.cards || [];
  if (!cards.length) {
    if (!Array.isArray(cached) || !cached.length) listEl.innerHTML = '<div class="rank-empty">该账号暂无歌单</div>';
    return;
  }
  state.cards = cards;
  favCacheSet(state.src, 'playlists', cards);
  renderCards(cards);
}

/* 普通歌单样式歌曲列表（.result-item 行式，顶部播放全部 + 行内操作按钮，与榜单/歌单一致） */
function renderSongList(songs) {
  const listEl = $('selfFavList');
  if (!Array.isArray(songs) || !songs.length) {
    listEl.innerHTML = '<div class="rank-empty">该列表暂无歌曲</div>';
    return;
  }
  let favKeys = new Set();
  try { favKeys = new Set((getFavorites() || []).map(f => makeSongKey(f))); } catch (e) { /* ignore */ }
  listEl.innerHTML = `
    <div class="rank-playall" style="display:flex;align-items:center;justify-content:space-between;padding:9px 14px;margin-bottom:10px;background:rgba(255,255,255,.07);border-radius:10px;cursor:pointer;">
      <span style="font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M8 5v14l11-7z"></path></svg>播放全部（${songs.length}）
      </span>
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
          <button class="result-action-btn" data-action="addnow-self" data-i="${i}" title="加入当前播放">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5v14l11-7z"></path></svg>
          </button>
          <button class="result-action-btn" data-action="addpl-self" data-i="${i}" title="添加到歌单">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          </button>
          <button class="result-action-btn ${isFav ? 'active-fav' : ''}" data-action="fav-self" data-i="${i}" title="${isFav ? '取消收藏' : '收藏'}">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path></svg>
          </button>
        </div>
      </div>`;
    }).join('')}`;
  state.pool = songs;
  const playAllBar = listEl.querySelector('.rank-playall');
  if (playAllBar) playAllBar.onclick = () => playAllFavSongs(songs);
  if (playAllBar) playAllBar.appendChild(Aria.__songViewBtn(listEl));
  Aria.__applySongViewTo(listEl);
  listEl.querySelectorAll('.result-item').forEach(el => {
    el.onclick = (e) => { if (e.target.closest('.result-action-btn')) return; playFavSong(Number(el.dataset.i)); };
  });
  listEl.querySelectorAll('.result-action-btn[data-action="addnow-self"]').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); addFavSongNow(songs[Number(btn.dataset.i)]); };
  });
  listEl.querySelectorAll('.result-action-btn[data-action="addpl-self"]').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); addFavSongToPlaylist(songs[Number(btn.dataset.i)]); };
  });
  listEl.querySelectorAll('.result-action-btn[data-action="fav-self"]').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); toggleFavSong(songs[Number(btn.dataset.i)], btn); };
  });
}

/* 播放全部：整单进队列并播第一首 */
function playAllFavSongs(songs) {
  if (!Array.isArray(songs) || !songs.length) return;
  try {
    if (typeof globalThis.playlist !== 'undefined' && Array.isArray(globalThis.playlist)) {
      globalThis.playlist.length = 0;
      globalThis.playlist.push(...songs);
      globalThis.currentTrackIndex = 0;
    }
  } catch (e) { /* ignore */ }
  loadOnlineSong(songs[0], true).catch(e => logWarn('selfhostFavorites', '[自建收藏] 播放全部失败:', e));
  if (typeof window.recordRecentPlay === 'function') window.recordRecentPlay(songs[0]);
  if (typeof setHint === 'function') setHint(`播放全部：${songs.length} 首已加入播放队列`);
}
/* 加入当前播放 */
function addFavSongNow(song) {
  if (!song) return;
  try { if (typeof globalThis.playlist !== 'undefined' && Array.isArray(globalThis.playlist)) globalThis.playlist.push(song); } catch (e) { /* ignore */ }
  if (typeof setHint === 'function') setHint('已加入当前播放队列');
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
  loadOnlineSong(s).catch(e => logWarn('selfhostFavorites', '[自建收藏] 播放失败:', e));
  if (typeof window.recordRecentPlay === 'function') window.recordRecentPlay(s);
}

/* 歌单宫格（复用 .rank-board-grid 卡片样式） */
function renderCards(cards) {
  const listEl = $('selfFavList');
  listEl.classList.remove('song-grid-view');   /* 歌单宫格视图不套用歌曲卡片布局 */
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
  state.navTitle = b.name;
  syncModes();
  await loadCurrent();
}

function backToTop() {
  state.sub = null;
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
})();

window.openSelfFavorites = openSelfFavorites;
window.closeSelfFavorites = closeSelfFavorites;