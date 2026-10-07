/* ============================================================
 * 297-artist-page.js — 歌手页（全屏 overlay，无前端路由）
 *
 * 形态对齐 rankingsOverlay（258）：独占显示、顶部标题 + 关闭、内部滚动容器。
 * 入口有三处（Phase 1 先接搜索结果）：
 *   · 搜索结果行的歌手名（150 渲染的 .artist-link）
 *   · 播放器下方 #songArtist（Phase 2）
 *   · 榜单/歌单/收藏列表（Phase 2）
 *
 * ★ 独占显示不是洁癖：这些 overlay 同为全屏层且 z-index 互有高低，叠加时
 *   上层会吃掉下层的点击热区（258 的 openRankings 注释记录了同类故障）。
 *
 * ★ 竞态：openArtist 期间用户可能点开另一位歌手 —— 用 _seq 序号丢弃过期响应，
 *   否则先慢后快的两个请求会让页面显示 A 的头像配 B 的歌曲。
 * ============================================================ */
import { escapeHtml as esc } from '../utils/formatters.js';
import { hueOfName } from '../utils/colorUtils.js';
import { logCatch } from '../services/log.js';
import { fetchArtist } from '../services/artistApi.js';
import { getFavorites, toggleFavCore } from './120-search-results.js';
import { openAddToPlaylist } from './135-crossfade.js';
import { loadOnlineSong } from './175-track-index-online.js';

function el(id) { return document.getElementById(id); }

const SRC_LABEL = { tencent: 'QQ音乐', netease: '网易云音乐', kugou: '酷狗音乐', qishui: '汽水音乐', kuwo: '酷我音乐' };

/* 与搜索页共用的歌曲键规则（120 的 makeSongKey 同义：source:id） */
function keyOf(song) {
    if (!song) return '';
    if (song.source && song.id) return `${song.source}:${song.id}`;
    return '';
}

let _seq = 0;
let _current = null;      /* 当前歌手描述符 */
let _data = null;         /* 最近一次拉到的详情 */
let _tab = 'songs';

/* ---------------- 打开 / 关闭 ---------------- */

const EXCLUSIVE = [
    'rankingsOverlay', 'playlistsOverlay', 'searchOverlay', 'favoritesOverlay',
    'addToPlaylistOverlay', 'selfFavOverlay', 'recentOverlay', 'statsOverlay',
];

/* ★ 返回上下文（2026-10-03 真机实测复现）：从歌曲卡片的歌手名点进来时，
   底下还压着「搜索结果 / 榜单 / 歌单 / 收藏」这一层。openArtist 会把它们全部
   摘掉 .visible（EXCLUSIVE，避免全屏层叠压吃点击热区），但 closeArtist 原来
   只关自己 —— 用户就被直接扔回播放器主界面，刚才那页列表连同滚动位置全丢。
   （探针实测：关掉歌手页后 `#searchOverlay.visible === false`。）
   现在开页前快照「哪一层 + 各滚动容器的 scrollTop」，关闭时原样还原。
   显隐走 opacity/visibility（motion.css），display 恒为 flex —— 所以隐藏期间
   scrollTop 本来就保得住，这里仍然显式恢复，防的是还原时列表被重渲染。 */
let _returnCtx = null;

function snapshotReturnContext() {
    for (const id of EXCLUSIVE) {
        const node = el(id);
        if (!node || !node.classList.contains('visible')) continue;
        const scrolls = [];
        node.querySelectorAll('*').forEach(n => {
            if (n.scrollTop > 0) scrolls.push([n, n.scrollTop]);
        });
        return { id, scrolls };
    }
    return null;
}

export async function openArtist(artist, opts = {}) {
    if (!artist) return;
    const hasId = !!(artist.artistId || artist.artistMid);
    if (!hasId && !artist.name) return;
    const ov = el('artistOverlay');
    if (!ov) return;

    _returnCtx = snapshotReturnContext();

    EXCLUSIVE.forEach(id => el(id)?.classList.remove('visible'));
    document.querySelectorAll('.aria-dialog-overlay').forEach(n => {
        try { n.remove(); } catch (e) { logCatch('artistPage', e); }
    });

    const my = ++_seq;
    _current = artist;
    _data = null;
    _tab = 'songs';

    const title = el('artistPageTitle');
    if (title) title.textContent = SRC_LABEL[artist.source] || '歌手';
    renderHead(artist);
    renderTabs();
    setBodySkeleton();
    ov.classList.add('visible');
    const scroller = el('artistList');
    if (scroller) scroller.scrollTop = 0;

    const data = await fetchArtist(artist, opts);
    if (my !== _seq) return;      /* 期间又开了别的歌手 → 丢弃本次响应 */

    _data = data;
    if (data && data.name) {
        _current = Object.assign({}, artist, {
            name: data.name,
            avatar: data.avatar || artist.avatar || '',
            stat: data.stat || '',
        });
    }
    renderHead(_current);
    renderTabs(_current);
    renderTab();
}

export function closeArtist() {
    el('artistOverlay')?.classList.remove('visible');
    /* 还原进入前的浮层（见 _returnCtx 注释）。ctx 一次性消费：重复调用 closeArtist
       不会把已经还原的层再翻出来。 */
    const ctx = _returnCtx;
    _returnCtx = null;
    if (!ctx) return;
    const node = el(ctx.id);
    if (!node) return;
    node.classList.add('visible');
    (ctx.scrolls || []).forEach(([n, top]) => {
        if (n && n.isConnected) n.scrollTop = top;
    });
}

export function isArtistPageOpen() { return !!el('artistOverlay')?.classList.contains('visible'); }

/* ---------------- 头部 ---------------- */

function renderHead(a) {
    /* ★ 三处信息源要合并着读：openArtist 时只有入口给的那点信息（可能带头像、多半没有
       统计），详情回来后才补齐。此前只看入参 a，导致「头像明明拉到了却不显示」——
       因为 _current 是 Object.assign({}, artist, {name}) 合出来的，avatar/stat 都丢了。 */
    const src = (a && a.source) || (_data && _data.source) || '';
    const name = (a && a.name) || (_data && _data.name) || '未知歌手';
    const avatar = (a && a.avatar) || (_data && _data.avatar) || '';
    const stat = (_data && _data.stat) || (a && a.stat) || '';

    const av = el('artistAvatar');
    if (av) {
        /* ★ 2026-10-03：无头像（酷狗 UGC 号上游就没有头像）或头像图 404 时，
           不再留一个灰圈，而是「按名字取色的纯色底 + 首字」——与搜索页歌手卡
           同一套观感，色相共用 utils/colorUtils.hueOfName（同一个人在两处同色）。
           ★ 首字必须用 textContent 写：歌手名来自上游，不能走 innerHTML。
           ★ 首字是常驻的，靠 .has-img 隐藏：这样图片 404 时只要去掉 has-img
           就自动露出首字，不需要给 background-image 挂 onerror（它没有）。 */
        let ini = av.querySelector('.artist-avatar-initial');
        if (!ini) {
            ini = document.createElement('span');
            ini.className = 'artist-avatar-initial';
            av.appendChild(ini);
        }
        ini.textContent = String(name || '?').slice(0, 1).toUpperCase();
        av.style.setProperty('--ah', String(hueOfName(name)));
        if (avatar) {
            /* background-image 里不需要 HTML 转义，但要把可能破坏 url() 的字符去掉 */
            const url = String(avatar).replace(/["\\()\s]/g, '');
            av.style.backgroundImage = `url("${url}")`;
            av.classList.add('has-img');
            /* ★ background-image 没有 onerror，若头像 404 会一直挂着 has-img
               → 首字被藏、图又加载不出来 → 又变成空气泡。用 Image 预载探测一次，
               失败即摘 has-img + 清 backgroundImage，露出纯色底 + 首字。 */
            if (av._avatarProbe !== url) {
                av._avatarProbe = url;
                const probe = new Image();
                probe.onerror = () => {
                    if (av._avatarProbe !== url) return;
                    av.classList.remove('has-img');
                    av.style.backgroundImage = '';
                };
                probe.src = url;
            }
        } else {
            av._avatarProbe = '';
            av.style.backgroundImage = '';
            av.classList.remove('has-img');
        }
    }
    const nm = el('artistName');
    if (nm) nm.textContent = name;
    const sub = el('artistSub');
    if (sub) sub.textContent = [SRC_LABEL[src] || '', stat].filter(Boolean).join(' · ');

    const d = el('artistDesc');
    if (!d) return;
    const text = (_data && _data.desc) || '';
    if (!text) {
        d.textContent = '';
        d.style.display = 'none';
        return;
    }
    d.style.display = '';
    d.textContent = text;
    d.classList.remove('expanded');
}

/* ---------------- 标签页 ---------------- */

function renderTabs() {
    const tabs = el('artistTabs');
    if (!tabs) return;
    /* 专辑为空时整个 tab 条隐藏，避免点进去是空页 */
    const hasAlbums = !!(_data && _data.albums && _data.albums.length);
    tabs.style.display = hasAlbums ? '' : 'none';
    tabs.querySelectorAll('.artist-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.atab === _tab);
    });
}

function renderTab() {
    const list = el('artistList');
    if (!list) return;
    list.scrollTop = 0;
    if (!_data) { setBodySkeleton(); return; }
    const html = (_tab === 'albums') ? albumsHtml(_data) : songsHtml(_data);
    if (globalThis.Aria && globalThis.Aria.skeleton) globalThis.Aria.skeleton.settle(list, html);
    else list.innerHTML = html;
}

function setBodySkeleton() {
    const list = el('artistList');
    if (!list) return;
    if (globalThis.Aria && globalThis.Aria.skeleton) globalThis.Aria.skeleton.load(list, 'list', 6);
    else list.innerHTML = '';
}

/* ---------------- 视图 ---------------- */

function emptyHtml(text) {
    return `<div class="artist-empty">${esc(text)}</div>`;
}

function songsHtml(d) {
    if (d.empty) return emptyHtml('歌手信息暂时不可用');
    if (!d.songs.length) return emptyHtml(d.partial ? '作品暂时拉不到，稍后再试' : '暂无作品');
    const favs = getFavorites();
    let html = `<div class="play-all-btn" id="artistPlayAllBtn">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="#fff"><path d="M6 4l14 8-14 8V4z" stroke="#fff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path></svg>
        <span>播放全部（${d.songs.length}）</span>
    </div>`;
    d.songs.forEach((s, i) => {
        const isFav = favs.some(f => f.key === keyOf(s));
        html += `<div class="result-item artist-song" data-idx="${i}">
            <img class="result-cover" src="${esc(s.cover || '')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
            <div class="result-info">
                <div class="result-title">${esc(s.song || '未知歌曲')}</div>
                <div class="result-artist">${esc(s.album || '')}</div>
            </div>
            <div class="result-actions">
                <button class="result-action-btn ${isFav ? 'active-fav' : ''}" data-act="fav" data-idx="${i}" title="${isFav ? '取消收藏' : '收藏'}">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path></svg>
                </button>
                <button class="result-action-btn" data-act="addpl" data-idx="${i}" title="添加到歌单">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                </button>
            </div>
        </div>`;
    });
    return html;
}

function albumsHtml(d) {
    if (!d.albums.length) return emptyHtml('暂无专辑');
    let html = '<div class="artist-album-grid">';
    d.albums.forEach((a, i) => {
        html += `<div class="artist-album" data-album-idx="${i}" title="${esc(a.name)}">
            <img class="artist-album-cover" src="${esc(a.cover || '')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
            <div class="artist-album-name">${esc(a.name || '')}</div>
            <div class="artist-album-year">${esc(a.year || '')}</div>
        </div>`;
    });
    return html + '</div>';
}

/* ---------------- 交互 ---------------- */

function songAt(i) {
    return (_data && _data.songs && _data.songs[i]) || null;
}

function playSongAt(i) {
    const s = songAt(i);
    if (s) loadOnlineSong(s);
}

function toggleSongFav(i) {
    const s = songAt(i);
    if (!s) return;
    toggleFavCore(s, { key: keyOf(s) });
    renderTab();
}

function addSongToPlaylist(i) {
    const s = songAt(i);
    if (!s) return;
    /* 135 的 openAddToPlaylist 读全局 currentSongData（150 的搜索结果也走同一条路）。
       裸赋值而非 globalThis.xxx：这两个键已在 10-config-state.js 登记（顶层裸写是
       本项目的既有写法，加 globalThis. 前缀反而会触发 no-restricted-syntax）。 */
    currentSongData = {
        title: s.song || '未知歌曲',
        artist: s.singer || (_current && _current.name) || '未知歌手',
        cover: s.cover || '',
        source: s.source,
        id: s.id,
        mid: s.mid || '',
    };
    currentSongKey = keyOf(s);
    openAddToPlaylist();
}

if (typeof document !== 'undefined') {
    el('artistCloseBtn')?.addEventListener('click', closeArtist);

    /* 点遮罩空白处关闭（与 searchOverlay 同款） */
    el('artistOverlay')?.addEventListener('click', (e) => {
        if (e.target === el('artistOverlay')) closeArtist();
    });

    /* 简介折叠：点击展开/收起 */
    el('artistDesc')?.addEventListener('click', () => {
        el('artistDesc')?.classList.toggle('expanded');
    });

    /* 标签切换 */
    el('artistTabs')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.artist-tab');
        if (!btn) return;
        const tab = btn.dataset.atab;
        if (!tab || tab === _tab) return;
        _tab = tab;
        renderTabs();
        renderTab();
    });

    /* ★ 事件委托：列表 innerHTML 每次渲染都被重建，逐个绑定必然失效。
       顺序很重要 —— 先判操作按钮，再判整行播放。 */
    el('artistList')?.addEventListener('click', (e) => {
        const act = e.target.closest('.result-action-btn');
        if (act) {
            e.stopPropagation();
            const i = parseInt(act.dataset.idx, 10);
            if (isNaN(i)) return;
            if (act.dataset.act === 'fav') toggleSongFav(i);
            else if (act.dataset.act === 'addpl') addSongToPlaylist(i);
            return;
        }
        if (e.target.closest('#artistPlayAllBtn')) {
            if (_data && _data.songs.length) loadOnlineSong(_data.songs[0]);
            return;
        }
        const album = e.target.closest('.artist-album');
        if (album) {
            const i = parseInt(album.dataset.albumIdx, 10);
            const a = _data && _data.albums && _data.albums[i];
            if (!a) return;
            /* 专辑页还没做：先用「歌手 + 专辑名」发起一次搜索，比点了没反应好 */
            const kw = `${_current?.name || ''} ${a.name || ''}`.trim();
            if (!kw) return;
            closeArtist();
            if (globalThis.Aria && typeof globalThis.Aria.__openSearchWithKeyword === 'function') {
                globalThis.Aria.__openSearchWithKeyword(kw);
            }
            return;
        }
        const row = e.target.closest('.artist-song');
        if (!row) return;
        const i = parseInt(row.dataset.idx, 10);
        if (!isNaN(i)) playSongAt(i);
    });
}

/* ★ 挂到 Aria 命名空间供 150 调用（打开入口在搜索结果行的歌手名上）。
   刻意不写 `import { openArtist } from './297-artist-page.js'` —— 分片间已经有
   120↔130↔135↔150 的静态环，再加一条只会把求值顺序问题放大；这里沿用项目既有的
   「typeof 探测 + 惰性调用」装配方式（见 index.js 头注释）。
   ★ 写成 Aria.xxx 而非 globalThis.Aria = {}：Aria 由 000-aria-ns.js 建立且已在
   eslint 的 PROJECT_GLOBAL_KEYS 登记，重新赋值是「新增裸键」，会被门禁拦下。 */
if (typeof Aria !== 'undefined') {
    Aria.openArtist = openArtist;
    Aria.closeArtist = closeArtist;
    Aria.isArtistPageOpen = isArtistPageOpen;
}
