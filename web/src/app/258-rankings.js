/* ============================================================
 * 258-rankings.js — 手写分片：音乐榜单 / 最近播放 / 播放统计 / EQ 分享码 / 通用毛玻璃输入弹窗 / 歌单批量下载·合并
 * 榜单交互：
 *   ① 弹窗与搜索一致（search-modal 640 毛玻璃），顶部 .source-toggle 三源切换
 *   ② 榜单列表 = 封面宫格（每榜一张方形封面卡）；点击进入该榜
 *   ③ 榜内歌曲 = 普通歌单样式（.result-item 行式列表，从上到下）
 * 最近播放 = 子歌单样式（同样是歌单行式，最近到最久）。
 * 数据统一走服务端 /api/rank/*（超时/UA/Referer 可控，酷狗自动剥 HTML 裹 JSON）。
 * ============================================================ */
import { API_BASE } from '../config/constants.js';
import { audio } from './20-lyrics-render.js';
import { loadOnlineSong, fetchPlayUrlForPreload } from './175-track-index-online.js';
import { loadPlaylistTrack, openAddToPlaylist } from './135-crossfade.js';
import { setHint, getFavorites, makeSongKey, saveFavorites, toggleFavCore } from './120-search-results.js';
import { getPlaylists, savePlaylists, renderPlaylistsView } from './130-playlists.js';
import { dayRecommend, selfhostEnabled } from './selfhost-runtime.js';
import { logInfo, logWarn, logError } from '../services/log.js';
import { applyEqGains, buildEqBands, buildEqPresets } from './90-eq.js'; // EQ 分享码导入（90-eq 不 import 258，无环）

const $ = (id) => typeof document !== 'undefined' ? document.getElementById(id) : null;

/* ================= 骨架屏（统一规范） =================
   Aria.__skeleton 定义在 005-skeleton.js（最早加载），样式在 rankings.css：
   __skeleton('cards', n) → 宫格卡骨架；__skeleton('list', n) → 列表行骨架；
   __skeleton('lyrics', n) → 歌词区骨架。本分片仅消费，不再重复定义。
   ★ 已统一改用带时序的 Aria.skeleton.load(el, kind, n)（延迟显示，快响应不闪骨架）；
     本文件仅第 199 行例外——那里骨架与固定行 mineEntry() 是拼接的，
     load() 的 prefix 选项虽支持，但紧随其后要 querySelector 绑事件，行为不同故暂留。 */

/* ================= 通用 fetch（带超时；本地 /api/ 直连，其余走 /proxy） ================= */
async function fetchJson(url, timeoutMs = 12000, raw = false) {
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const useProxy = !/^https?:\/\/localhost|\/api\//.test(url);
        const finalUrl = useProxy ? `/proxy?url=${encodeURIComponent(url)}` : url;
        const res = await fetch(finalUrl, { signal: ctl.signal });
        const text = await res.text();
        return raw ? text : (() => { try { return JSON.parse(text); } catch (e) { return null; } })();
    } catch (e) {
        return null;
    } finally {
        clearTimeout(tid);
    }
}

/* ============================================================
 * 一、通用毛玻璃输入弹窗（符合 search-modal 毛玻璃规范）
 *   用于：新歌单命名 / EQ 导入分享码 / EQ 保存为预设 等
 * ============================================================ */
window.showGlassPrompt = function (opts) {
    opts = opts || {};
    const ov = document.createElement('div');
    ov.className = 'search-overlay gp-overlay';
    ov.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2100;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(0,0,0,.45);backdrop-filter:saturate(180%) blur(40px);-webkit-backdrop-filter:saturate(180%) blur(40px);';
    ov.innerHTML = `
        <div class="gp-modal">
            <div class="gp-title">${opts.title || '输入'}</div>
            <div class="gp-sub" style="${opts.desc ? '' : 'display:none'}">${opts.desc || ''}</div>
            <input class="gp-input" type="text" placeholder="${opts.placeholder || ''}" value="${opts.value || ''}" maxlength="60" autocomplete="off">
            <div class="gp-actions">
                <button class="gp-cancel">取消</button>
                <button class="gp-ok">确定</button>
            </div>
        </div>`;
    requestAnimationFrame(() => { const inp = ov.querySelector('.gp-input'); if (inp) { inp.focus(); inp.select(); } });
    const close = () => ov.remove();
    const submit = () => {
        const val = String(ov.querySelector('.gp-input').value || '').trim();
        close();
        if (opts.onSubmit) opts.onSubmit(val);
    };
    ov.querySelector('.gp-cancel').onclick = close;
    ov.querySelector('.gp-ok').onclick = submit;
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    const inp = ov.querySelector('.gp-input');
    if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } if (e.key === 'Escape') close(); });
    document.body.appendChild(ov);
    return ov;
};

/* 通用"从列表选择"弹窗（合并到歌单等） */
window.showGlassPick = function (opts) {
    opts = opts || {};
    const ov = document.createElement('div');
    ov.className = 'search-overlay gp-overlay';
    ov.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2100;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(0,0,0,.45);backdrop-filter:saturate(180%) blur(40px);-webkit-backdrop-filter:saturate(180%) blur(40px);';
    ov.innerHTML = `
        <div class="gp-modal gp-pick">
            <div class="gp-title">${opts.title || '选择'}</div>
            <div class="gp-pick-list">${(opts.items || []).map((it, i) => `<button class="gp-pick-item" data-i="${i}">${it.name}${it.meta ? `<span class="gp-pick-meta">${it.meta}</span>` : ''}</button>`).join('') || '<div style="padding:18px;color:rgba(255,255,255,.5);font-size:13px">没有可选项</div>'}</div>
            <div class="gp-actions"><button class="gp-cancel">取消</button></div>
        </div>`;
    const close = () => ov.remove();
    ov.querySelector('.gp-cancel').onclick = close;
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    ov.querySelectorAll('.gp-pick-item').forEach(btn => {
        btn.onclick = () => {
            const idx = Number(btn.dataset.i);
            close();
            if (opts.onPick) opts.onPick(idx);
        };
    });
    document.body.appendChild(ov);
    return ov;
};

/* ============================================================
 * 二、榜单逻辑（榜宫格 → 榜内歌单列表）
 * ============================================================ */
let rankState = {
    src: 'qq', boards: [], boardIdx: -1,
    view: 'boards',   // 'boards' | 'songs' | 'daily'
    daily: false,     // 是否每日推荐视图（返回键应关闭弹窗而非回榜单）
    loading: false
};

/* ================= 榜单音源顺序与切换按钮渲染 ================= */
/* 顺序规范（用户指定）：QQ → 酷狗 → 网易云。
   ★ 未启用自建 vendor 的平台**往后延**（用户要求"没有这些自建服务的 vendor 就往后延"）：
     用稳定排序把「已启用」的整组排到前面，组内仍保持 QQ→酷狗→网易云的次序。
   ⚠ 这里只影响**按钮顺序**，不隐藏任何音源——榜单数据走 /api/rank/*（公网），
     未启用自建也能取到，隐藏反而会让用户以为坏了。 */
const RANK_SRC_ORDER = ['qq', 'kugou', 'netease'];
const RANK_SRC_LABEL = { qq: 'QQ音乐', kugou: '酷狗音乐', netease: '网易云' };

function orderedRankSources() {
    const enabled = (src) => {
        try { return !!(typeof selfhostEnabled === 'function' && selfhostEnabled(src)); }
        catch { return false; }
    };
    return [...RANK_SRC_ORDER].sort((a, b) => (enabled(b) ? 1 : 0) - (enabled(a) ? 1 : 0));
}

/* 弹窗左上角标题：随视图切换（此前是写死的「榜单」，导致每日推荐页标题错成"榜单"）。
   榜单宫格 → 「榜单」；每日推荐 → 「每日推荐」 */
function setRankPageTitle(text) {
    const t = $('rankPageTitle');
    if (t && text) t.textContent = text;
}

/* 重建音源切换按钮（openRankings 与 loadRankSource 共用，避免两处顺序不一致） */
function renderRankTabs(activeSrc) {
    const rt = $('rankTabs');
    if (!rt) return;
    rt.style.display = '';
    rt.innerHTML = orderedRankSources()
        .map(s => `<button class="source-btn${s === activeSrc ? ' active' : ''}" data-rsrc="${s}">${RANK_SRC_LABEL[s]}</button>`)
        .join('');
}

function openRankings() {
    const ov = $('rankingsOverlay');
    if (!ov) return;
    /* ★ 独占显示：先关掉其它弹窗（歌单/搜索/收藏/添加到歌单/毛玻璃对话框）。
       原因：这些弹窗与榜单同为全屏层，且毛玻璃对话框 z-index 2400 高于榜单的 1000——
       一旦叠加，榜单顶部的音源按钮坐标会被上层元素吃掉，真实鼠标点击静默失效
       （实测：歌单弹窗与榜单同屏时，点「酷狗音乐」前后 active 都停在 qq）。 */
    ['playlistsOverlay', 'searchOverlay', 'favoritesOverlay', 'addToPlaylistOverlay']
        .forEach(id => document.getElementById(id)?.classList.remove('visible'));
    document.querySelectorAll('.aria-dialog-overlay')
        .forEach(el => { try { el.remove(); } catch { /* ignore */ } });
    /* ★ 榜单页 = 可切换音源的榜单宫格。
       三平台热门聚合（约 120 首）**不再占用榜单页**——那是「每日推荐」的内容；
       原先 openAggregatedDaily() 会把 rankTabs 整行 display:none，
       导致「没有音源切换按钮 / 关闭按钮跑到左上角 / 没有标题」三连症状。 */
    rankState.daily = false;
    setRankPageTitle('榜单');
    renderRankTabs(rankState.src);
    ov.classList.add('visible');
    loadRankSource(rankState.src);
}
function closeRankings() { $('rankingsOverlay')?.classList.remove('visible'); }

/* ★ 三平台日推聚合视图（进入榜单页面的默认内容）：
   并行拉取网易云/QQ/酷狗日推，合并所有有内容的平台列表（跨平台一个大列表，可直接播放）；
   全部平台都拿不到 → 回退热门榜单宫格 */
/* 三平台热门聚合（约 120 首，QQ→酷狗→网易云 优先）的**榜单页视图**。
   ⚠ 当前无入口，属于有意保留：
   · 它的职责（"刚启动应用时装进播放队列的开篇歌单"）现在由
     `180-boot-config.js pickPlatformStartQueue()` 承担——那才是正主；
   · 榜单页按用户要求改为「可切源的榜单宫格」，不再显示聚合（原先由 openRankings 调用，
     而它会 display:none 掉 rankTabs，导致"没有音源切换按钮/关闭按钮跑到左上角"）。
   保留本函数以备将来需要"聚合列表视图"（例如接给「每日推荐」按钮）。
   eslint-disable 仅为保持 warning 基线，不是遗漏。 */
// eslint-disable-next-line no-unused-vars
async function openAggregatedDaily() {
    const ov = $('rankingsOverlay');
    const listEl = $('rankList');
    if (!ov || !listEl) return;
    rankState.view = 'daily'; rankState.daily = true;
    /* 聚合视图：隐藏返回键、chips 与三平台 tab（回退榜单时 loadRankSource 会全套恢复） */
    if ($('rankNav')) { $('rankNav').hidden = true; $('rankNav').style.display = 'none'; }
    if ($('rankChips')) $('rankChips').hidden = true;
    if ($('rankTabs')) $('rankTabs').style.display = 'none';
    if ($('rankNavTitle')) $('rankNavTitle').textContent = '每日推荐';
    if ($('rankNavCount')) $('rankNavCount').textContent = '';
    resetRankScroll();
    songSkeletonFor(listEl, 6);

    /* 三平台并行拉取，单平台失败/为空只影响该平台，不拖垮整体 */
    const results = await Promise.all(
        dailySrcOrder.map(src => dayRecommend(src)
            .then(r => ({ src, r }))
            .catch(e => ({ src, r: { ok: false, err: (e && e.message) || '网络异常' } })))
    );
    const merged = [];
    for (const { src, r } of results) {
        if (r && r.ok && Array.isArray(r.list) && r.list.length) {
            for (const s of r.list) merged.push(s);
        }
    }
    if (merged.length) {
        const okSrcs = results
            .filter(x => x.r && x.r.ok && Array.isArray(x.r.list) && x.r.list.length)
            .map(x => DAILY_SRC_LABEL[x.src] || x.src);
        if ($('rankNavCount')) $('rankNavCount').textContent = `${merged.length} 首`;
        renderSongs(merged.map(s => ({ song: s.name || '', singer: s.singer || '', cover: s.cover || '', id: s.id, source: s.source })));
        if (typeof setHint === 'function') setHint(`每日推荐：${okSrcs.join(' + ')} 已合并`);
        return;
    }
    /* ★ 三个平台都没有日推 → 回退热门榜单宫格 */
    logWarn('rankings', `[Daily] 三平台日推均不可用（${results.map(x => x.src + '=' + ((x.r && x.r.err) || (x.r && x.r.ok ? 'empty' : 'fail'))).join('，')}），回退热门榜单`);
    rankState.daily = false;   /* 榜单内返回键应回宫格而非关闭弹窗 */
    const rt2 = $('rankTabs');
    if (rt2) rt2.style.display = '';   /* ★ 恢复三源切换栏（聚合期间被隐藏），loadRankSource 会重建其内容 */
    loadRankSource(rankState.src);
}

/* ============================================================
 * ★ 歌单弹窗默认视图：三平台日推聚合（135 openPlaylists 优先调用）
 *   进入歌单页直接看日推大列表；三平台都没有日推 → 打开热门榜单。
 *   顶部保留「我的歌单」入口，可随时回本地歌单列表。
 * ============================================================ */
globalThis.Aria.__openDefaultPlaylistView = async function () {
    const listEl = $('playlistsList');
    const titleEl = $('playlistsTitle');
    const backBtn = $('playlistBackBtn');
    if (!listEl) return false;
    if (titleEl) titleEl.textContent = '每日推荐';
    if (backBtn) backBtn.classList.remove('visible');   /* 聚合视图用「我的歌单」入口卡片替代返回键 */
    if (typeof Aria !== 'undefined') Aria.__playlistBackHook = null;
    if (typeof window.resetListScroll === 'function') window.resetListScroll();   /* 歌单面板滚动复位 */

    const mineEntry = () => `<div class="playlist-item" id="dailyBackToMine" style="cursor:pointer;">
        <div class="playlist-cover"><span class="playlist-cover-fallback"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 5h12a3 3 0 0 1 3 3v11"></path><path d="M3 5v14h12a3 3 0 0 0 3-3V5"></path></svg></span></div>
        <div class="playlist-info"><div class="playlist-name">我的歌单</div><div class="playlist-meta">本地创建/收藏的歌单 · 点击进入</div></div>
    </div>`;
    listEl.innerHTML = mineEntry() + (Aria.__skeleton ? Aria.__skeleton('list', 6) : '<div class="empty-hint">加载中...</div>');
    const mineRow = listEl.querySelector('#dailyBackToMine');
    if (mineRow) mineRow.onclick = () => renderPlaylistsView();

    /* 三平台并行拉取日推，合并所有有内容的平台 */
    const results = await Promise.all(
        dailySrcOrder.map(src => dayRecommend(src)
            .then(r => ({ src, r }))
            .catch(e => ({ src, r: { ok: false, err: (e && e.message) || '网络异常' } })))
    );
    const merged = [];
    for (const { src, r } of results) {
        if (r && r.ok && Array.isArray(r.list) && r.list.length) {
            for (const s of r.list) merged.push({ song: s.name || '', singer: s.singer || '', cover: s.cover || '', id: s.id, source: s.source });
        }
    }
    if (merged.length) {
        renderDailyRowsInto(listEl, mineEntry(), merged);
        const okSrcs = results.filter(x => x.r && x.r.ok && Array.isArray(x.r.list) && x.r.list.length)
            .map(x => DAILY_SRC_LABEL[x.src] || x.src);
        if (typeof setHint === 'function') setHint(`每日推荐：${okSrcs.join(' + ')} 已合并`);
        return true;
    }
    /* ★ 三平台都没有日推 → 直接打开热门榜单 */
    logWarn('rankings', `[Daily] 歌单默认视图：三平台日推均不可用（${results.map(x => x.src + '=' + ((x.r && x.r.err) || (x.r && x.r.ok ? 'empty' : 'fail'))).join('，')}）→ 热门榜单`);
    listEl.innerHTML = mineEntry() + `<div class="rank-error" style="margin:18px 6px;">今日日推暂时不可用（三平台未启用/离线）<br><span style="font-size:11px;opacity:.75">已自动为你打开热门榜单</span></div>`;
    const mineRow2 = listEl.querySelector('#dailyBackToMine');
    if (mineRow2) mineRow2.onclick = () => renderPlaylistsView();
    openRankings();   /* 榜单弹窗默认聚合→无日推→榜单宫格，与歌单弹窗同屏覆盖展示 */
    return false;
};

/* 在歌单面板渲染日推行列表（复用排行行样式；可播放全部/单曲/收藏） */
function renderDailyRowsInto(listEl, mineEntryHtml, songs) {
    const favs = new Set((getFavorites() || []).map(f => makeSongKey(f)));
    const playAllRow = `
        <div class="rank-list-head" style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
            <div class="rank-playall" id="dailyRowPlayAll" style="flex:1;display:flex;align-items:center;gap:6px;padding:9px 14px;background:rgba(255,255,255,.07);border-radius:10px;cursor:pointer;">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M8 5v14l11-7z"></path></svg>播放全部（${songs.length}）
            </div>
        </div>`;
    let rows = '';
    songs.forEach((s, i) => {
        const name = esc(s.song || ''), singer = esc(s.singer || '');
        const cover = s.cover || '';
        const isFav = favs.has(makeSongKey(s));
        const coverHtml = cover
            ? `<img class="result-cover" src="${esc(cover)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
            : `<div class="result-cover" style="display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.1);"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg></div>`;
        rows += `<div class="result-item" data-i="${i}">
            ${coverHtml}
            <div class="result-info">
                <div class="result-title">${name}</div>
                <div class="result-artist">${singer}</div>
            </div>
            <div class="result-actions">
                <button class="result-action-btn ${isFav ? 'active-fav' : ''}" data-action="fav-daily" data-i="${i}" title="${isFav ? '取消收藏' : '收藏'}">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path></svg>
                </button>
            </div>
        </div>`;
    });
    listEl.innerHTML = mineEntryHtml + playAllRow + rows;
    const mineRow = listEl.querySelector('#dailyBackToMine');
    if (mineRow) mineRow.onclick = () => renderPlaylistsView();
    const playAll = listEl.querySelector('#dailyRowPlayAll');
    if (playAll) playAll.onclick = () => playAllRankSongs(songs);
    listEl.querySelectorAll('.result-item').forEach(el => {
        el.onclick = (e) => { if (e.target.closest('.result-action-btn')) return; loadOnlineSong(songs[Number(el.dataset.i)]).catch(err => logWarn('rankings', '[Daily] 播放失败:', err)); };
    });
    listEl.querySelectorAll('.result-action-btn[data-action="fav-daily"]').forEach(btn => {
        btn.onclick = (e) => { e.stopPropagation(); toggleRankFav(songs[Number(btn.dataset.i)], btn); };
    });
}

/* ============================================================
 * ★ 供启动流程调用：各平台「热歌榜」前 N 首合并（未登录/无日推时的开篇歌单）
 *   取 QQ / 酷狗 / 网易云各自热歌（无"热歌"则取首个）榜单前 N 首，
 *   统一为 {title, artist, cover, source, id} 可播放队列。
 * @returns {Promise<Array>} 最多 cap × 3 首（每平台最多 cap）
 * ============================================================ */
globalThis.Aria.__fetchHotBoardQueue = async function (cap = 30) {
    const queue = [];
    const pushTrack = (x) => {
        if (!x) return;
        const id = x.id !== undefined && x.id !== null && x.id !== '' ? String(x.id) : (x.mid || x.songmid || '');
        if (!id) return;
        queue.push({ title: x.song || x.title || x.name || '未知歌曲', artist: x.singer || x.artist || x.author || '', cover: x.cover || '', source: x.source || '', id, mid: x.mid || '' });
    };
    /* QQ：热歌/飙升榜优先，否则首个榜 */
    try {
        const j = await fetchJson('/api/rank/qq', 25000);
        const groups = (j && j.code === 0 && j.data && Array.isArray(j.data.group)) ? j.data.group : [];
        const all = [];
        groups.forEach(g => (g.toplist || []).forEach(t => all.push({ key: t.topId, name: t.title || '' })));
        const pick = all.find(b => /热歌|飙升/.test(b.name)) || all[0];
        if (pick) {
            const d = await fetchJson(`/api/rank/qq?id=${encodeURIComponent(pick.key)}`, 30000);
            const data = (d && d.code === 0 && Array.isArray(d.data)) ? d.data : null;
            if (data) data.slice(0, cap).forEach(s => pushTrack({ ...s, source: s.source || 'qq' }));
        }
    } catch (e) { /* 单平台失败不拖垮整体 */ }
    /* 酷狗：热歌/飙升榜优先，否则首个榜 */
    try {
        const obj = await fetchJson('/api/rank/kugou', 40000);
        const info = (obj && obj.data && Array.isArray(obj.data.info)) ? obj.data.info : [];
        const pick = info.find(b => /热歌|飙升/.test(b.rankname || '')) || info[0];
        if (pick && pick.rankid) {
            const d = await fetchJson(`/api/rank/kugou?id=${encodeURIComponent(pick.rankid)}`, 45000);
            const data = (d && d.code === 0 && Array.isArray(d.data) && d.data.length) ? d.data : null;
            if (data) data.slice(0, cap).forEach(s => pushTrack({ ...normalizeRankSong(s, 'kugou') }));
        }
    } catch (e) { /* 忽略 */ }
    /* 网易云：热歌榜优先，否则首个榜 */
    try {
        const j = await fetchJson('/api/rank/ncm', 35000);
        const raw = (j && j.code === 0 && Array.isArray(j.data)) ? j.data
            : ((j && j.code === 0 && j.data && Array.isArray(j.data.data)) ? j.data.data : null);
        const pick = (raw || []).find(b => /热歌/.test(b.name || '')) || (raw && raw[0]);
        if (pick && pick.id) {
            const d = await fetchJson(`/api/rank/ncm?id=${encodeURIComponent(pick.id)}`, 30000);
            const data = (d && d.code === 0 && Array.isArray(d.data)) ? d.data : null;
            if (data) data.slice(0, cap).forEach(t => pushTrack({
                song: t.name || '', singer: Array.isArray(t.ar) ? t.ar.map(a => a.name).join(' / ') : (t.artistName || ''),
                cover: (t.al && (t.al.picUrl || t.al.url)) || '', id: t.id, source: 'netease'
            }));
        }
    } catch (e) { /* 忽略 */ }
    return queue.slice(0, cap * 3);
};

/* 每日推荐：三平台分栏（QQ / 酷狗 / 网易云）
   ★ 顺序按用户要求：QQ 优先 → 酷狗 → 网易云（聚合与日推 tab 都读这个数组） */
const dailySrcOrder = ['qq', 'kugou', 'netease'];
const DAILY_SRC_LABEL = { netease: '网易云', qq: 'QQ音乐', kugou: '酷狗音乐' };
let dailyState = { src: 'netease', loading: false, cache: {} };

function renderDailyTracks(list) {
    if (!Array.isArray(list) || !list.length) return;
    if ($('rankNavCount')) $('rankNavCount').textContent = `${list.length} 首`;
    renderSongs(list.map(s => ({ song: s.name || '', singer: s.singer || '', cover: s.cover || '', id: s.id, source: s.source })));
}

async function openDailyRecommend(overSrc) {
    const ov = $('rankingsOverlay');
    if (!ov) return;
    /* ★ 事件监听直接挂 openDailyRecommend 时，overSrc 会拿到 PointerEvent 对象——
       必须只接受字符串音源，否则 dailyState.src 被污染成事件对象，
       报错文案会拼出 "[object PointerEvent]" */
    const src = (typeof overSrc === 'string' && overSrc) || dailyState.src || 'netease';
    dailyState.src = src;
    ov.classList.add('visible');
    rankState.view = 'daily'; rankState.daily = true;
    setRankPageTitle('每日推荐');   /* 标题跟随视图，避免显示成"榜单" */
    /* 每日推荐：无需返回键与 chips —— 隐藏 rankNav(back) 与 rankChips */
    if ($('rankNav')) { $('rankNav').hidden = true; $('rankNav').style.display = 'none'; }
    if ($('rankChips')) $('rankChips').hidden = true;
    /* 三平台 tab 渲染进 rankTabs 区域（仅用于日推，点按切源） */
    const rt = $('rankTabs');
    if (rt) {
        rt.style.display = '';
        rt.innerHTML = dailySrcOrder.map(src => `<button class="source-btn${src === dailyState.src ? ' active' : ''}" data-daily="${src}">${DAILY_SRC_LABEL[src]}</button>`).join('');
        rt.querySelectorAll('.source-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const s = btn.dataset.daily;
                if (s === dailyState.src || dailyState.loading) return;
                dailyState.src = s;
                rt.querySelectorAll('.source-btn').forEach(b => b.classList.toggle('active', b.dataset.daily === s));
                loadDailyList($('rankList'));
            });
        });
    }
    if ($('rankNavTitle')) $('rankNavTitle').textContent = '每日推荐';
    if ($('rankNavCount')) $('rankNavCount').textContent = '';
    loadDailyList($('rankList'));
}

/* ★ 歌曲列表骨架跟随宫格/列表视图（songView）：宫格时出卡片骨架并给容器
   套 song-grid-view——否则开启宫格后骨架仍是列表、内容却是宫格（用户反馈） */
function songSkeletonFor(el, n) {
    const grid = Aria.__songView === 'grid';
    Aria.skeleton.load(el, grid ? 'cards' : 'list', grid ? Math.max(6, Math.round(n / 2)) : n);
    Aria.__applySongViewTo(el);
}

async function loadDailyList(listEl) {
    if (!listEl) return;
    const lbl = DAILY_SRC_LABEL[dailyState.src] || (typeof dailyState.src === 'string' ? dailyState.src : '') || '';
    dailyState.loading = true;
    resetRankScroll();
    /* ★ 命中缓存先秒开渲染，再后台静默刷新 */
    const cached = dailyState.cache[dailyState.src];
    if (Array.isArray(cached) && cached.length) {
        renderDailyTracks(cached);
    } else {
        songSkeletonFor(listEl, 6);
    }
    const res = await dayRecommend(dailyState.src);
    dailyState.loading = false;
    if (!res.ok) {
        if (!Array.isArray(cached) || !cached.length) listEl.innerHTML = `<div class="rank-error">${esc(res.err || '获取失败')}<br><span style="font-size:11px;opacity:.7">请到「设置 → 自建服务」启用「${lbl}」</span></div>`;
        return;
    }
    if (!res.list || !res.list.length) {
        if (!Array.isArray(cached) || !cached.length) listEl.innerHTML = `<div class="rank-error">「${lbl}」今日暂无推荐歌曲${dailyState.src === 'qq' ? '<br><span style="font-size:11px;opacity:.7">QQ 日推可能需要登录，可切到网易云/酷狗</span>' : ''}</div>`;
        return;
    }
    dailyState.cache[dailyState.src] = res.list;
    renderDailyTracks(res.list);
}

function setRankNav(show, title, count) {
    const nav = $('rankNav');
    const tt = $('rankNavTitle');
    const cc = $('rankNavCount');
    if (nav) { nav.hidden = !show; nav.style.display = show ? '' : 'none'; }
    if (tt) tt.textContent = title || '';
    if (cc) cc.textContent = count ? `${count} 首` : '';
}

/* ★ 榜单宫格与榜内歌曲共用同一个 #rankList 滚动容器：
   切换视图时必须重置滚动，否则进入榜内滚动后返回宫格位置被联动。 */
function resetRankScroll() {
    const listEl = $('rankList');
    if (!listEl) return;
    if (listEl.scrollTop !== 0) listEl.scrollTop = 0;
    requestAnimationFrame(() => { try { listEl.scrollTop = 0; } catch (e) { /* ignore */ } });
}

/* ★ 榜单不做持久缓存（用户反馈：命中缓存"先显示→滑一半变 skeleton→又出现"体验差）：
   每次进入统一 skeleton → 新鲜数据，不静默刷新也不复用旧列表 */
const rankBoardCache = {};
const rankBoardCacheAt = {}; /* ★ lint/回归修复：e8ec26a 去缓存时误删声明但保留 300 行写入，每次 loadRankSource 抛 ReferenceError 被 catch 吞掉 → 榜单渲染中断 */
let rankSeq = 0;

async function loadRankSource(src, force, silent) {
    /* ★ 防止 src 被污染为 undefined（如点击残留 data-daily 按钮）：非法值一律回落 qq */
    if (!['qq', 'kugou', 'netease'].includes(src)) src = 'qq';
    const my = ++rankSeq;
    rankState.src = src;
    rankState.boards = [];
    rankState.boardIdx = -1;
    rankState.view = 'boards';
    force = false; /* ★ 去缓存：一律重新拉取 */
    /* ★ 导航栏/视图先统一复位：无论命中与否，切源都必须回到「榜单宫格 + 无返回栏」，
       避免从榜内直接切 tab 时残留上一来源的榜名标题栏 */
    setRankNav(false);
    $('rankChips').hidden = true;
    /* ★ 先强制重建音源 tabs（每日推荐会把 rankTabs 改写成 data-daily 结构），
       再按当前 src 置高亮——彻底杜绝"没有选中/多选"的错乱残留。
       顺序与 openRankings 共用 renderRankTabs：QQ→酷狗→网易云，未启用自建的平台往后延 */
    renderRankTabs(src);
    const listEl = $('rankList');
    if (!listEl) return;
    Aria.skeleton.load(listEl, 'cards', 12);

    try {
        let boards = [];
        if (src === 'qq') {
            const j = await fetchJson('/api/rank/qq', 35000);
            const groups = (j && j.code === 0 && j.data && Array.isArray(j.data.group)) ? j.data.group : null;
            if (!groups) throw new Error('QQ 榜单接口不可用');
            groups.forEach(g => (g.toplist || []).forEach((t, ti) => {
                boards.push({
                    key: t.topId,
                    name: t.title || `榜 ${t.topId}`,
                    cover: (t.song && t.song[0] && t.song[0].cover) || t.cover || '',
                    listen: t.listen || 0,
                    songs: t.song || [],
                    _full: false,   /* 需点击进入后经 /api/rank/qq?id= 拉全量 */
                    hue: (g.groupId + ti) % 10
                });
            }));
            if (!boards.length) throw new Error('QQ 榜单为空');
        } else if (src === 'kugou') {
            const obj = await fetchJson('/api/rank/kugou', 40000);
            const info = (obj && obj.data && Array.isArray(obj.data.info)) ? obj.data.info : [];
            if (!info.length) throw new Error('酷狗榜单为空');
            info.forEach((it, i) => {
                const c = it.album_img_9 || it.banner_9 || it.img_9 || '';
                boards.push({
                    key: it.rankid,
                    name: it.rankname || '榜单',
                    cover: c ? String(c).replace('{size}', '400') : '',
                    songs: (it.songinfo || []).map(s => normalizeRankSong(s, 'kugou')),
                    /* ★ 酷狗榜单列表只有 3 首预览(songinfo)，play_times 才是卡片真实人气；
                       歌曲总数 total 在进入榜后从详情接口回填 */
                    playTimes: it.play_times || 0,
                    total: 0,
                    _full: false,
                    hue: i % 10
                });
            });
        } else {
            const j = await fetchJson('/api/rank/ncm', 35000);
            /* 兼容两种形状：老源 60s.viki.moe 返回 data[]；net ease vendor 返回 data.data[] */
            const raw = (j && j.code === 0 && Array.isArray(j.data)) ? j.data
                       : ((j && j.code === 0 && j.data && Array.isArray(j.data.data)) ? j.data.data : null);
            const data = raw || [];
            if (!data || !data.length) throw new Error('网易云榜单接口不可用');
            data.forEach((it, i) => boards.push({ key: String(it.id), name: it.name || `榜 ${it.id}`, cover: it.cover || '', songs: null, _full: false, hue: i % 10, meta: it }));
        }
        if (my !== rankSeq) return;
        rankState.boards = boards;
        rankBoardCache[src] = boards;
        rankBoardCacheAt[src] = Date.now();
        renderBoards(!!silent);
    } catch (err) {
        if (my !== rankSeq) return;
        listEl.innerHTML = `<div class="rank-error">${(err && err.message) || '加载失败'}<br><button class="rank-retry" onclick="Aria.__rankRetry&&Aria.__rankRetry()">重试</button></div>`;
    }
}

/* ① 榜宫格 */
function renderBoards(preserveScroll) {
    rankState.view = 'boards';
    setRankNav(false);
    $('rankChips').hidden = true;
    const listEl = $('rankList');
    if (!listEl) return;
    /* ★ 静默刷新(preserveScroll)：保持用户当前滚动位置，后台换列表不打扰浏览；
       主动操作（切源/打开/返回）才回顶 */
    const savedTop = preserveScroll ? listEl.scrollTop : 0;
    if (!preserveScroll) resetRankScroll();
    listEl.classList.remove('song-grid-view');   /* 榜宫格视图不套用歌曲卡片布局 */
    const pal = ['#5b6b7f', '#7a6f8e', '#7d8a6a', '#8a6a6a', '#6a7f8e', '#8e7a6a', '#6a8e7f', '#8e6a7f', '#6f7f8e', '#7f8e6a'];
    const fmtBig = (n) => { n = Number(n) || 0; return n >= 100000000 ? (n / 100000000).toFixed(1).replace(/\.0$/, '') + '亿' : n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + '万' : String(n); };
    const boardMeta = (b) => {
        /* ★ 榜单卡片不显示「预览 N 首」：酷狗列表接口只带 3 首预览(songinfo)、
           QQ 也只带 preview 数，会把百首大榜显示成"3 首"（误导）。
           只显示真实信息：详情回填的总数 → 人气播放量；都没有就不显示标签 */
        if (b.total > 0) return `${b.total} 首`;
        if (b.playTimes > 0) return `${fmtBig(b.playTimes)} 播放`;
        return '';
    };
    /* ★ 不再渲染 __cardsCarouselBarHTML()（那个宫格/横向轮播切换按钮）：
       它是**歌单列表**的功能，榜单列表（各榜封面宫格）不需要，用户已明确要求移除。
       但仍调用 __bindCardsCarouselBar 以**沿用用户已保存的布局偏好**
       （无按钮时它只做 apply，不再显示切换入口）。 */
    listEl.innerHTML = `<div class="rank-board-grid">${rankState.boards.map((b, i) => `
        <div class="rank-board-card" data-i="${i}" title="${esc(b.name)}">
            ${b.cover
                ? `<img class="rank-board-bg" src="${esc(b.cover)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
                : `<span class="rank-board-ph" style="background:linear-gradient(150deg,${pal[b.hue % pal.length]},${pal[(b.hue + 4) % pal.length]});"></span>`}
            <div class="rank-board-meta">
                <div class="rank-board-name">${esc(b.name)}</div>
                <div class="rank-board-count">${boardMeta(b)}</div>
            </div>
            <span class="rank-card-src">${({ qq: 'QQ', kugou: '酷狗', netease: '网易' })[rankState.src] || ''}</span>
        </div>`).join('')}</div>`;
    Aria.__bindCardsCarouselBar(listEl);
    listEl.querySelectorAll('.rank-board-card').forEach(card => {
        card.onclick = () => openBoard(Number(card.dataset.i));
    });
    if (preserveScroll && savedTop > 0) listEl.scrollTop = savedTop;
}

/* ② 点击榜 → 榜内歌单列表 */
async function openBoard(idx) {
    const b = rankState.boards[idx];
    if (!b) return;
    rankState.boardIdx = idx;
    rankState.view = 'songs';
    $('rankChips').hidden = true;
    resetRankScroll();
    setRankNav(true, b.name, (b.songs && b.songs.length) || 0);
    const listEl = $('rankList');
    /* ★ 避免「先显示→变 skeleton→又出现」：已有本榜歌曲（本会话拉过/带预览）直接渲染，
       只有真空时才先出骨架；后台刷新完成后由 renderSongs 静默替换一次，不再回 skeleton */
    if (!Array.isArray(b.songs) || !b.songs.length) songSkeletonFor(listEl, 9);
    if (rankState.src === 'qq' && !b._full) {
        const j = await fetchJson(`/api/rank/qq?id=${encodeURIComponent(b.key)}`, 25000);
        const data = (j && j.code === 0 && Array.isArray(j.data)) ? j.data : null;
        b.songs = (data && data.length) ? data : b.songs;
        b._full = true;
    } else if (rankState.src === 'kugou' && !b._full) {
        /* ★ 酷狗 mobilecdnbj 冷启动/限流时首请求可能返回空：同一次点击内自动重试 1 次，
           避免"第一次进入只出 3 首预览、第二次才正常"的体验断层 */
        let data = null, total = null;
        for (let kt = 0; kt < 2 && !data; kt++) {
            if (kt > 0) await new Promise(r => setTimeout(r, 450));
            const j = await fetchJson(`/api/rank/kugou?id=${encodeURIComponent(b.key)}`, 45000);
            data = (j && j.code === 0 && Array.isArray(j.data) && j.data.length) ? j.data : null;
            if (!data && j && !Array.isArray(j.data)) data = null;
            total = (j && j.total) ? Number(j.total) : null;
        }
        if (data) {
            b.songs = data.map(s => normalizeRankSong(s, 'kugou'));
            if (total > 0) b.total = total;   /* 详情接口带真实歌曲总数，裁片回填右上右下角 */
        }
        /* 失败不置 _full：允许用户再次点击进入自动重试 */
        b._full = !!data;
    } else if (rankState.src === 'netease') {
        const j = await fetchJson(`/api/rank/ncm?id=${encodeURIComponent(b.key)}`, 25000);
        const data = (j && j.code === 0 && Array.isArray(j.data)) ? j.data : null;
        if (data && data.length) {
            b.songs = data.map(t => ({
                song: t.name || '', singer: (Array.isArray(t.ar) ? t.ar.map(a => a.name).join(' / ') : (t.artistName || '')),
                cover: (t.al && (t.al.picUrl || t.al.url)) || b.meta.cover || '', id: t.id, source: 'netease'
            }));
        }
    }
    setRankNav(true, b.name, (b.songs && b.songs.length) || 0);
    if (b.songs && b.songs.length) {
        renderSongs(b.songs);
    } else {
        listEl.innerHTML = `<div class="rank-error">该榜歌曲暂不可用<br><span style="font-size:11px;opacity:.7">可切换其它榜单，或用搜索播放同名歌曲</span></div>`;
    }
}

/* ③ 普通歌单样式的歌曲列表（result-item 行式，从上到下） */
function renderSongs(songs) {
    const listEl = $('rankList');
    resetRankScroll();
    if (!Array.isArray(songs) || !songs.length) {
        listEl.innerHTML = '<div class="rank-empty">该榜单暂无歌曲</div>';
        return;
    }
    let favKeys = new Set();
    try { favKeys = new Set((getFavorites() || []).map(f => makeSongKey(f))); } catch (e) { /* ignore */ }
    listEl.innerHTML = `
        <div class="rank-list-head" style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
            <div class="rank-playall" style="flex:1;display:flex;align-items:center;gap:6px;padding:9px 14px;background:rgba(255,255,255,.07);border-radius:10px;cursor:pointer;">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M8 5v14l11-7z"></path></svg>播放全部（${songs.length}）
            </div>
            <button class="setting-btn icon-btn" id="rankPlayAllDl" style="width:34px;height:34px;padding:0;display:inline-flex;align-items:center;justify-content:center;" title="批量下载整单歌曲" aria-label="批量下载">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            </button>
        </div>
        ${songs.map((s, i) => {
        const name = s.song || s.name || s.title || '';
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
                <div class="result-artist">${esc(singer)}</div>
            </div>
            <div class="result-actions">
                <button class="result-action-btn" data-action="addnow-rank" data-i="${i}" title="加入当前播放">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5v14l11-7z"></path></svg>
                </button>
                <button class="result-action-btn" data-action="addpl-rank" data-i="${i}" title="添加到歌单">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                </button>
                <button class="result-action-btn ${isFav ? 'active-fav' : ''}" data-action="fav-rank" data-i="${i}" title="${isFav ? '取消收藏' : '收藏'}">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path></svg>
                </button>
            </div>
        </div>`;
    }).join('')}`;
    /* ★ 榜内歌单恢复 行式⇄宫格 切换（用户要求；与歌单/收藏列表同一套 B1 规范）。
       按钮必须在 innerHTML 注入之后挂载，否则 .rank-list-head 取到旧节点。 */
    const __rankViewHead = listEl.querySelector('.rank-list-head');
    if (__rankViewHead) __rankViewHead.appendChild(Aria.__songViewBtn(listEl));
    Aria.__applySongViewTo(listEl);
    const playAllBar = listEl.querySelector('.rank-playall');
    if (playAllBar) playAllBar.onclick = () => playAllRankSongs(songs);
    const dlBtn = document.getElementById('rankPlayAllDl');
    if (dlBtn) dlBtn.onclick = (e) => { e.stopPropagation(); batchDownloadSongs(songs, '榜单'); };
    listEl.querySelectorAll('.result-item').forEach(el => {
        el.onclick = (e) => { if (e.target.closest('.result-action-btn')) return; playRankSong(Number(el.dataset.i)); };
    });
    listEl.querySelectorAll('.result-action-btn[data-action="addnow-rank"]').forEach(btn => {
        btn.onclick = (e) => { e.stopPropagation(); addNowRankSong(songs[Number(btn.dataset.i)]); };
    });
    listEl.querySelectorAll('.result-action-btn[data-action="addpl-rank"]').forEach(btn => {
        btn.onclick = (e) => { e.stopPropagation(); addRankSongToPlaylist(songs[Number(btn.dataset.i)]); };
    });
    listEl.querySelectorAll('.result-action-btn[data-action="fav-rank"]').forEach(btn => {
        btn.onclick = (e) => { e.stopPropagation(); toggleRankFav(songs[Number(btn.dataset.i)], btn); };
    });
}

/* 播放全部：整单设为播放队列并播第一首
   ★ skipPlaylistUpdate=true：loadOnlineSong 内部默认会把队列覆盖成单曲
   （playlist=[{...}]），不传 true 会清掉刚 push 的全部歌曲 → 只播第一首 */
function playAllRankSongs(songs) {
    if (!Array.isArray(songs) || !songs.length) return;
    try {
        if (typeof globalThis.playlist !== 'undefined' && Array.isArray(globalThis.playlist)) {
            globalThis.playlist.length = 0;
            globalThis.playlist.push(...songs);
            globalThis.currentTrackIndex = 0;
        }
    } catch (e) { /* ignore */ }
    loadOnlineSong(songs[0], true).catch(e => logWarn('rankings', '[Rank] 播放全部失败:', e));
    if (typeof window.recordRecentPlay === 'function') window.recordRecentPlay(songs[0]);
    if (typeof setHint === 'function') setHint(`播放全部：${songs.length} 首已加入播放队列`);
}
/* 加入当前播放 */
function addNowRankSong(song) {
    if (!song) return;
    try {
        if (typeof globalThis.playlist !== 'undefined' && Array.isArray(globalThis.playlist)) {
            globalThis.playlist.push(song);
        }
    } catch (e) { /* ignore */ }
    if (typeof setHint === 'function') setHint('已加入当前播放队列');
}
/* 添加到指定歌单：复用全局「加入歌单」弹层（130 renderAddToPlaylistList），
   先同步 globalThis.currentSongData/currentSongKey 为该曲，再打开弹层 */
function addRankSongToPlaylist(song) {
    if (!song) return;
    try {
        globalThis.currentSongData = {
            title: song.song || song.name || '', artist: song.singer || '', cover: song.cover || '',
            source: song.source || '', id: String(song.id != null ? song.id : '')
        };
        globalThis.currentSongKey = makeSongKey(song);
    } catch (e) { /* ignore */ }
    if (typeof openAddToPlaylist === 'function') openAddToPlaylist();
    else if (typeof setHint === 'function') setHint('请点击右上角「＋」将当前歌曲加入歌单');
}
/* 收藏 / 取消收藏 */
function toggleRankFav(song, btn) {
    if (!song) return;
    try {
        const { faved } = toggleFavCore(song);
        if (btn) btn.classList.toggle('active-fav', faved);
        if (typeof setHint === 'function') setHint(faved ? '已加入收藏' : '已取消收藏');
    } catch (e) { logWarn('rankings', '[Rank] 收藏失败:', e); }
}

function normalizeRankSong(s, src) {
    const tp = s.trans_param || s.trans_obj || {};
    const name = s.name || s.title || s.songname || '';
    const singer = s.singer || s.author || s.singername
        || (Array.isArray(s.authors) ? s.authors.map(a => a.author_name || a.name).join(' / ') : '')
        || (Array.isArray(s.ar) ? s.ar.map(a => a.name).join(' / ') : '');
    /* ★ album_sizable_cover/union_cover 含 {size} 占位符，必须替换为具体尺寸，
       否则 img src 带 {size} 加载失败 → 榜单歌曲全没封面 → 播放也不切封面 */
    const _cov = (u) => (u ? String(u).replace('{size}', '500') : '');
    const cover = _cov(s.cover) || _cov(s.album_sizable_cover) || _cov(tp.union_cover)
        || (s.al && (s.al.picUrl || s.al.url));
    let out = { song: name, singer, cover, id: String(s.id != null ? s.id : s.songId), source: src };
    if (src === 'kugou') {
        out.hash = s.hash || tp.hash_multitrack || tp.ogg_320_hash || s['320hash'] || '';
        out.id = out.hash || String(s.album_audio_id || s.id || '');
        /* 歌手兜底：酷狗榜内作者的 filename 形如「作者 - 歌名」，singername 可能为空 */
        if (!out.singer && name) {
            const m = String(name).match(/^(.*?)\s*-\s*(.*)$/);
            if (m && m[2]) out.singer = m[1].trim();
        }
    }
    if (src === 'netease') out.id = String(s.id);
    if (src === 'qq') out.id = String(s.songId || s.id);
    return out;
}

function playRankSong(idx) {
    const s = rankState.boards[rankState.boardIdx]?.songs[idx];
    if (!s) return;
    if (rankState.src === 'kugou' && !s.hash && !s.id) { tip('酷狗该曲缺少播放标识'); return; }
    loadOnlineSong(s).catch(e => logWarn('rankings', '[Rank] 播放失败:', e));
    if (typeof recordRecentPlay === 'function') recordRecentPlay(s);
}

/* 返回：每日推荐视图 → 关闭弹窗；榜单内 → 回榜单宫格 */
function backToBoards() {
    if (rankState.daily) {
        rankState.daily = false;
        closeRankings();
        return;
    }
    rankState.view = 'boards';
    $('rankChips').hidden = true;
    setRankNav(false);
    renderBoards();
}

/* ============================================================
 * 三、最近播放历史（子歌单样式，最近 → 久远，localStorage）
 * ============================================================ */
const RECENT_KEY = 'aria_recent_history';
const RECENT_MAX = 60;

function getRecentHistory() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch (e) { return []; }
}
function saveRecentHistory(list) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch (e) {}
}
if (typeof window !== 'undefined') {
    /* 130-playlists 历史播放子页的单条删除/清空复用 */
    window.saveRecentHistory = saveRecentHistory;
    window.getRecentHistory = getRecentHistory;
}

function recordRecentPlay(songInfo) {
    if (!songInfo || !(songInfo.id || songInfo.mid || songInfo.hash)) return;
    const key = `${songInfo.source || ''}:${songInfo.id || songInfo.mid || songInfo.hash}`;
    const item = {
        key,
        title: songInfo.title || songInfo.song || '未知歌曲',
        artist: songInfo.artist || songInfo.singer || '未知歌手',
        cover: songInfo.cover || '',
        source: songInfo.source || '',
        id: songInfo.id || songInfo.mid || songInfo.hash || '',
        mid: songInfo.mid || '',
        hash: songInfo.hash || '',
        at: Date.now()
    };
    let list = getRecentHistory().filter(it => it.key !== key);
    list.unshift(item);
    saveRecentHistory(list);
    renderRecentWidget();
}
window.recordRecentPlay = recordRecentPlay;

function renderRecentWidget() {
    const recent = getRecentHistory();
    const el = $('recentEntryMeta');
    if (el) el.textContent = recent.length ? `${recent.length} 首 · 点击查看` : '暂无播放记录';
}

function openRecent() {
    const ov = $('recentOverlay');
    if (!ov) return;
    ov.classList.add('visible');
    const list = getRecentHistory();
    const listEl = $('recentList');
    if (!list.length) {
        listEl.innerHTML = '<div class="rank-empty">还没有播放过歌曲<br>去搜索 / 榜单 / 收藏里点一首吧</div>';
        return;
    }
    listEl.innerHTML = list.map((it, i) => `
        <div class="result-item" data-i="${i}">
            ${it.cover ? `<img class="result-cover" src="${esc(it.cover)}" alt="" onerror="this.style.visibility='hidden'">` : `<div class="result-cover" style="display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.1);"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg></div>`}
            <div class="result-info">
                <div class="result-title">${esc(it.title)}</div>
                <div class="result-artist">${esc(it.artist)}${it.source ? ' · ' + ({tencent:'QQ',kugou:'酷狗',netease:'网易',kuwo:'酷我'}[it.source] || it.source) : ''} · ${it.at ? new Date(it.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</div>
            </div>
            <button class="rank-del" data-i="${i}" title="移出">×</button>
        </div>`).join('');
    listEl.querySelectorAll('.result-item').forEach(el => {
        el.onclick = (e) => {
            if (e.target.closest('.rank-del')) return;
            const it = list[Number(el.dataset.i)];
            if (!it) return;
            const info = { source: it.source, id: it.id, mid: it.mid, hash: it.hash, song: it.title, singer: it.artist, cover: it.cover };
            if (info.source && (info.id || info.mid || info.hash)) {
                loadOnlineSong(info).catch(e => logWarn('rankings', '[Recent] 播放失败:', e));
                recordRecentPlay(info);
            }
        };
    });
    listEl.querySelectorAll('.rank-del').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const l2 = getRecentHistory();
            l2.splice(Number(btn.dataset.i), 1);
            saveRecentHistory(l2);
            openRecent();
            renderRecentWidget();
        };
    });
}
function closeRecent() { $('recentOverlay')?.classList.remove('visible'); }

/* ============================================================
 * 四、播放统计（640 宽 search-modal；KPI + 常听歌曲/歌手 + 近 7 日）
 * ============================================================ */
const STATS_KEY = 'aria_play_stats';

function loadStats() {
    try { return JSON.parse(localStorage.getItem(STATS_KEY) || 'null') || defaultStats(); } catch (e) { return defaultStats(); }
}
function defaultStats() {
    return { totalPlays: 0, totalMs: 0, firstAt: 0, songs: {}, artists: {}, days: {} };
}
function saveStats(s) {
    try { localStorage.setItem(STATS_KEY, JSON.stringify(s)); } catch (e) {}
}
let _statAcc = 0;
window.recordPlayStats = function (sec) {
    if (!window.currentSongData) return;
    const st = loadStats();
    const d = window.currentSongData;
    const k = `${d.source || ''}:${d.id || d.mid || ''}`;
    const s = Math.max(0, sec || 0);
    _statAcc += s;
    /* ★ 统一用毫秒存储：变量名 totalMs / songs[k].ms / days[day] 都暗示 ms 单位 */
    const ms = Math.round(s * 1000);
    st.totalMs += ms;
    const day = new Date().toISOString().slice(0, 10);
    st.days[day] = (st.days[day] || 0) + ms;
    if (!st.firstAt) st.firstAt = Date.now();
    if (_statAcc >= 30) {
        _statAcc = 0;
        st.totalPlays += 1;
        st.songs[k] = st.songs[k] || { title: d.title || '未知', artist: d.artist || '', n: 0, ms: 0 };
        st.songs[k].n += 1;
        st.songs[k].title = d.title || st.songs[k].title;
        st.songs[k].artist = d.artist || st.songs[k].artist;
        st.songs[k].ms += ms;
        const ak = d.artist || '未知';
        st.artists[ak] = st.artists[ak] || { n: 0, ms: 0 };
        st.artists[ak].n += 1;
        st.artists[ak].ms += ms;
    }
    /* ★ 每次上报都落盘：否则累计<30s 时统计全不保存，近7日/累计收听永远 0s */
    saveStats(st);
};

function fmtMs(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}秒`;
    if (s < 3600) return `${Math.floor(s / 60)}分${s % 60}秒`;
    return `${Math.floor(s / 3600)}时${Math.floor((s % 3600) / 60)}分`;
}

function openStats() {
    const ov = $('statsOverlay');
    if (!ov) return;
    ov.classList.add('visible');
    const st = loadStats();
    const body = $('statsBody');
    const songs = Object.entries(st.songs).sort((a, b) => b[1].n - a[1].n).slice(0, 8);
    const artists = Object.entries(st.artists).sort((a, b) => b[1].n - a[1].n).slice(0, 8);
    const days7 = Object.entries(st.days).sort().slice(-7);
    const maxSong = songs.length ? songs[0][1].n : 1;
    const maxArt = artists.length ? artists[0][1].n : 1;
    const maxDay = days7.length ? Math.max(...days7.map(x => x[1])) : 1;
    body.innerHTML = `
        <div class="stats-kpis">
            <div class="stats-kpi"><div class="v">${st.totalPlays}</div><div class="l">累计播放</div></div>
            <div class="stats-kpi"><div class="v">${fmtMs(st.totalMs)}</div><div class="l">累计收听</div></div>
            <div class="stats-kpi"><div class="v">${Object.keys(st.songs).length}</div><div class="l">听过的歌</div></div>
            <div class="stats-kpi"><div class="v">${Object.keys(st.artists).length}</div><div class="l">听过的歌手</div></div>
        </div>
        <div class="stats-block">
            <div class="stats-block-title">常听歌曲</div>
            ${songs.length ? songs.map(([k, v]) => `<div class="stats-bar-row">
                <div class="stats-bar-name">${esc(v.title)}</div>
                <div class="stats-bar-track"><div class="stats-bar-fill" style="width:${(v.n / maxSong * 100).toFixed(1)}%"></div></div>
                <div class="stats-bar-val">${v.n} 次</div></div>`).join('') : '<div class="stats-empty" style="padding:10px">暂无数据，多听几首吧</div>'}
        </div>
        <div class="stats-block">
            <div class="stats-block-title">常听歌手</div>
            ${artists.length ? artists.map(([k, v]) => `<div class="stats-bar-row">
                <div class="stats-bar-name">${esc(k)}</div>
                <div class="stats-bar-track"><div class="stats-bar-fill" style="width:${(v.n / maxArt * 100).toFixed(1)}%"></div></div>
                <div class="stats-bar-val">${v.n} 首</div></div>`).join('') : '<div class="stats-empty" style="padding:10px">暂无数据</div>'}
        </div>
        <div class="stats-block">
            <div class="stats-block-title">近 7 日收听时长</div>
            ${days7.length ? days7.map(([d, ms]) => `<div class="stats-bar-row">
                <div class="stats-bar-name">${d.slice(5)}</div>
                <div class="stats-bar-track"><div class="stats-bar-fill" style="width:${(ms / maxDay * 100).toFixed(1)}%"></div></div>
                <div class="stats-bar-val">${fmtMs(ms)}</div></div>`).join('') : '<div class="stats-empty" style="padding:10px">暂无数据</div>'}
        </div>`;
}
function closeStats() { $('statsOverlay')?.classList.remove('visible'); }

/* ============================================================
 * 五、EQ 分享码（复制 / 导入走毛玻璃弹窗）
 * ============================================================ */
function b64EncodeUnicode(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64DecodeUnicode(str) { return decodeURIComponent(escape(atob(str))); }
function tip(msg) {
    try { if (typeof setHint === 'function') { setHint(msg); return; } } catch (e) {}
    try { if (window.setHint) window.setHint(msg); } catch (e) {}
}
window.copyEqShareCode = function () {
    if (typeof eqGains === 'undefined' || typeof eqActivePreset === 'undefined') { tip('均衡器未就绪'); return; }
    const payload = JSON.stringify({ v: 1, g: eqGains, p: eqActivePreset || '自定义' });
    const code = 'AriaEQ1.' + b64EncodeUnicode(payload);
    try {
        navigator.clipboard.writeText(code).then(() => tip('EQ 分享码已复制'), () => tip('复制失败，手动拷贝: ' + code));
    } catch (e) { tip('复制失败'); }
};
window.importEqShareCode = function () {
    /* ★ 自行设计的毛玻璃输入弹窗（替代浏览器原生 prompt） */
    window.showGlassPrompt({
        title: '导入 EQ 分享码',
        placeholder: 'AriaEQ1.xxx',
        value: '',
        onSubmit(value) {
            if (!value) return;
            try {
                const base = value.trim().replace(/^AriaEQ1\./, '');
                const obj = JSON.parse(b64DecodeUnicode(base));
                if (obj && Array.isArray(obj.g) && obj.g.length === 10) {
                    if (typeof applyEqGains === 'function') applyEqGains(obj.g.map(Number));
                    if (typeof buildEqBands === 'function') buildEqBands();
                    if (typeof buildEqPresets === 'function') buildEqPresets();
                    tip('EQ 预设已导入');
                } else {
                    tip('分享码无效');
                }
            } catch (e) { tip('分享码解析失败'); }
        }
    });
};

/* ============================================================
 * 六、歌单批量下载 / 合并
 * ============================================================ */
window.batchDownloadSongs = async function (songs, label) {
    if (!Array.isArray(songs) || !songs.length) return tip((label || '') + '没有可下载的歌曲');
    let ok = 0, fail = 0;
    tip(`开始批量下载 ${songs.length} 首...`);
    for (let i = 0; i < songs.length; i++) {
        const s = songs[i];
        const src = s.source || window.currentSongData?.source || '';
        const id = s.id || s.mid || '';
        const mid = s.mid || '';
        if (!src || !id) { fail++; continue; }
        try {
            const url = await fetchPlayUrlForPreload(String(id), mid, src, s.title || s.song || '', s.duration || s.interval || 0);
            if (!url) { fail++; continue; }
            let blob = null;
            try {
                const res = await fetch(url);
                if (res.ok) blob = await res.blob();
            } catch (e) { logWarn('rankings', '批量下载预载失败:', e); }
            if (!blob) {
                try {
                    const pr = await fetch(`/proxy?url=${encodeURIComponent(url)}`);
                    if (pr.ok) blob = await pr.blob();
                } catch (e) { logWarn('rankings', '批量下载代理兜底失败:', e); }
            }
            if (blob) {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `${(s.artist || s.singer || '') ? (s.artist || s.singer) + ' - ' : ''}${(s.title || s.song || i + 1)}.mp3`;
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(a.href), 2000);
                ok++;
            } else { fail++; }
        } catch (e) { fail++; }
        await new Promise(r => setTimeout(r, 400));
    }
    tip(`批量下载完成：成功 ${ok} 首，失败 ${fail} 首`);
};

window.mergePlaylistInto = function (srcPlId) {
    const pls = getPlaylists();
    const srcPl = pls.find(p => p.id === srcPlId);
    const items = pls.filter(p => p.id !== srcPlId).map(p => ({
        name: p.name,
        meta: `${p.songs.length} 首`
    }));
    window.showGlassPick({
        title: `将「${srcPl ? srcPl.name : '当前歌单'}」合并到...`,
        items,
        onPick(i) {
            const others = getPlaylists().filter(p => p.id !== srcPlId);
            const target = others[i];
            if (!target || !srcPl) return;
            const keys = new Set(target.songs.map(s => s.key || `${s.source}:${s.id || s.mid}`));
            srcPl.songs.forEach(s => {
                const k = s.key || `${s.source}:${s.id || s.mid}`;
                if (!keys.has(k)) { target.songs.push({ ...s }); keys.add(k); }
            });
            savePlaylists(getPlaylists());
            tip(`已合并 ${srcPl.songs.length} 首到「${target.name}」`);
        }
    });
};

/* ================= 通用转义 ================= */
function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ================= 事件挂接 ================= */
(function initRankingsUI() {
    if (typeof document === 'undefined') return;
    $('openRankingsBtn')?.addEventListener('click', openRankings);
    $('openDailyBtn')?.addEventListener('click', openDailyRecommend);
    $('rankingsCloseBtn')?.addEventListener('click', closeRankings);
    $('rankingsOverlay')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeRankings(); });
    $('rankTabs')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.source-btn');
        /* ★ 仅处理榜单源按钮；残留的 data-daily 按钮（dataset.rsrc 为空）直接忽略，
           避免把 undefined 传入 loadRankSource 导致选中错乱/误落网易云分支 */
        if (btn && btn.dataset.rsrc && btn.dataset.rsrc !== rankState.src) loadRankSource(btn.dataset.rsrc);
    });
    $('rankBackBtn')?.addEventListener('click', backToBoards);
    Aria.__rankRetry = () => loadRankSource(rankState.src);

    $('openStatsBtn')?.addEventListener('click', openStats);
    $('statsCloseBtn')?.addEventListener('click', closeStats);
    $('statsOverlay')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeStats(); });

    $('recentCloseBtn')?.addEventListener('click', closeRecent);
    $('recentOverlay')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeRecent(); });

    /* EQ 分享码按钮 */
    $('eqShareBtn')?.addEventListener('click', () => window.copyEqShareCode());
    $('eqImportBtn')?.addEventListener('click', () => window.importEqShareCode());

    /* 启动统计 tick（5s 汇总时长）★ 无条件启动：audio 加载完成前先置 null，就绪后自动接管 */
    if (!Aria.__statsTimer) {
        let last = 0;
        Aria.__statsTimer = setInterval(() => {
            try {
                if (typeof audio !== 'undefined' && audio && !audio.paused && window.currentSongData) {
                    const t = audio.currentTime || 0;
                    const dt = t - last;
                    if (dt > 0 && dt < 30) window.recordPlayStats(dt);
                    last = t;
                } else {
                    /* 无可播音频或切歌后 currentTime 重置，基准归零避免误报大段时长 */
                    last = 0;
                    if (typeof audio !== 'undefined' && audio) last = audio.currentTime || 0;
                }
            } catch (e) {}
        }, 5000);
    }
})();

Aria.__rankRefresh = () => loadRankSource(rankState.src);

/* 跨分片 API */
window.openRecent = openRecent;
window.closeRecent = closeRecent;
window.getRecentHistory = getRecentHistory;
window.openBoard = openBoard;
window.backToBoards = backToBoards;

export { openRankings, closeRankings, loadRankSource, openRecent, openStats, renderRecentWidget, recordRecentPlay, getRecentHistory, saveRecentHistory };