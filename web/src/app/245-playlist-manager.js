/* ============================================================
 * 245-playlist-manager.js — 右下角快捷管理"当前播放队列"
 * 列表样式与搜索页一致(封面/歌名/歌手/收藏) + 丝滑拖拽排序
 * 拖拽时其他歌曲以FLIP动画让位(惯性缓动)，松手落位commit
 * ============================================================ */
import { loadPlaylistTrack, openAddToPlaylist } from './135-crossfade.js';
import { audio } from './20-lyrics-render.js';
import { getFavorites, makeSongKey, toggleFavCore } from './120-search-results.js';
import { setPlayMode } from './75-play-mode.js';

(function () {
  const toggle = document.getElementById('playlistManagerToggle');
  const panel = document.getElementById('plmPanel');
  const mask = document.getElementById('plmMask');
  const listEl = document.getElementById('plmList');
  const countEl = document.getElementById('plmCount');
  const clearBtn = document.getElementById('plmClear');
  const closeBtn = document.getElementById('plmClose');
  if (!toggle || !panel) return;

  let drag = null;
  function getPlaylist() { return globalThis.playlist || (globalThis.playlist = []); }
  function isOpen() { return panel.classList.contains('visible'); }
  function open() { panel.classList.add('visible'); mask.classList.add('visible'); render(); }
  function close() { panel.classList.remove('visible'); mask.classList.remove('visible'); dragCleanup(); }

  /* ---- 收藏 ---- */
  function isFav(track) { return getFavorites().some(f => f.key === makeSongKey(track)); }
  function toggleFav(track) {
    toggleFavCore(track);
    render();
  }

  const FAV_SVG = (on) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path></svg>`;
  const DEL_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"></line><line x1="18" y1="6" x2="6" y2="18"></line></svg>`;

  function render() {
    const pl = getPlaylist();
    const cur = typeof globalThis.currentTrackIndex === 'number' ? globalThis.currentTrackIndex : 0;
    countEl.textContent = pl.length ? `${pl.length} 首` : '0 首';
    clearBtn.style.display = pl.length ? 'inline-flex' : 'none';
    if (!pl.length) { listEl.innerHTML = '<div class="plm-empty">队列为空</div>'; return; }
    let html = '';
    pl.forEach((t, i) => {
      const active = (i === cur);
      const title = (t && (t.title || t.song || t.name)) || '未知歌曲';
      const artist = (t && (t.artist || t.singer)) || '未知歌手';
      const cover = (t && t.cover) || '';
      const fav = isFav(t);
      const n = String(i + 1).padStart(2, '0');
      html += `<div class="result-item plm-item${active ? ' now-playing-active' : ''}${drag && drag.srcIdx === i ? ' plm-source' : ''}" data-idx="${i}" data-play="${i}" title="${active ? '正在播放，拖拽可排序' : '点击播放，拖拽可排序'}">
        <span class="plm-rank">${n}</span>
        <img class="result-cover" src="${cover}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        <div class="result-info">
          <div class="result-title">${title}</div>
          <div class="result-artist">${artist}</div>
        </div>
        <span class="result-status">${active ? '正在播放' : ''}</span>
        <div class="result-actions">
          <button class="result-action-btn" data-savepl="${i}" title="添加到歌单">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          </button>
          <button class="result-action-btn${fav ? ' active-fav' : ''}" data-fav="${i}" title="${fav ? '取消收藏' : '收藏'}">${FAV_SVG(fav)}</button>
          <button class="result-action-btn plm-del" data-del="${i}" title="从队列移除">${DEL_SVG}</button>
        </div>
      </div>`;
    });
    listEl.innerHTML = html;
  }

  /* ---- 拖拽：FLIP 让位动画 ---- */
  let ghost = null;
  /* ★ 真实拖拽结束后 350ms 内抑制 click，避免松手误触发播放 */
  let lastWasDrag = false, lastWasDragT = null;

  function dragCleanup() {
    if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
    ghost = null; drag = null;
    /* ★ 复原 pointerdown 给被点项加的 plm-source 灰色遮罩 */
    listEl.querySelectorAll('.plm-item.plm-source').forEach(el => el.classList.remove('plm-source'));
  }

  /* 把被拖项的占位元素移到 target 槽位，其余项用 FLIP 平滑让位 */
  function reorderPreview(target) {
    const items = Array.from(listEl.querySelectorAll('.plm-item'));
    const source = items.find(el => +el.dataset.idx === drag.srcIdx);
    if (!source) return;
    const others = items.filter(el => el !== source);
    const before = others.slice(0, target);
    const after = others.slice(target);
    const seq = before.concat(source, after);

    /* FLIP: First - 记录原位置 */
    items.forEach(el => { el._top = el.offsetTop; });
    /* Invert 在一帧内更新（无过渡），再到原位置 */
    seq.forEach(el => listEl.appendChild(el));
    requestAnimationFrame(() => {
      items.forEach(el => {
        const d = el.offsetTop - el._top; /* 新位置 - 旧位置 */
        if (d === 0) return;
        el.classList.add('flip-no-trans');
        /* ★ 取反：先把元素"钉回"旧位置(translateY=-d)，再移除过渡回到新位置，
           其他卡片才表现为正确地让位滑动；原实现 translateY(+d) 方向相反 */
        el.style.transform = `translateY(${-d}px)`;
        requestAnimationFrame(() => {
          void el.offsetWidth; /* 强制重排 */
          el.classList.remove('flip-no-trans');
          el.style.transform = '';
        });
      });
    });
  }

  listEl.addEventListener('pointerdown', (e) => {
    const item = e.target.closest('.plm-item');
    if (!item) return;
    if (e.target.closest('button')) return;
    if (e.target.closest('.result-status')) return;
    drag = { srcIdx: +item.dataset.idx, target: +item.dataset.idx, startX: e.clientX, startY: e.clientY, grabX: e.clientX - item.getBoundingClientRect().left, grabY: e.clientY - item.getBoundingClientRect().top, moved: false };

    const r = item.getBoundingClientRect();
    ghost = item.cloneNode(true);
    ghost.classList.remove('plm-source', 'now-playing-active');
    ghost.classList.add('plm-ghost');
    ghost.style.width = r.width + 'px';
    ghost.style.height = r.height + 'px';
    ghost.style.left = r.left + 'px';
    ghost.style.top = r.top + 'px';
    document.body.appendChild(ghost);
    item.classList.add('plm-source');
    e.preventDefault();
  });

  window.addEventListener('pointermove', (e) => {
    if (!drag || !ghost) return;
    const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) > 8) drag.moved = true;
    ghost.style.left = (e.clientX - drag.grabX) + 'px';
    ghost.style.top = (e.clientY - drag.grabY) + 'px';
    if (!drag.moved) return;

    const gy = e.clientY;
    const others = Array.from(listEl.querySelectorAll('.plm-item')).filter(el => +el.dataset.idx !== drag.srcIdx);
    let target = 0;
    for (const el of others) { const rr = el.getBoundingClientRect(); if (gy > rr.top + rr.height / 2) target++; }
    target = Math.max(0, Math.min(target, others.length));
    if (target !== drag.target) {
      drag.target = target;
      reorderPreview(target);
    }
  });

  window.addEventListener('pointerup', () => { commit(); });
  window.addEventListener('pointercancel', () => { dragCleanup(); render(); });

  function commit() {
    if (!drag) return;
    const wasDrag = drag.moved;
    /* ★ 纯点击（未拖拽）：不重排、不 render——render 会重建 innerHTML、把被点击项从 DOM 移除，
       导致紧随的 click 事件目标丢失而无法切歌。直接复原并把播放交给 click 处理。 */
    if (!wasDrag) { dragCleanup(); return; }
    const pl = getPlaylist();
    const m = pl[drag.srcIdx];
    const rest = pl.filter((_, i) => i !== drag.srcIdx);
    const arr = rest.slice();
    arr.splice(drag.target, 0, m);
    const cur = globalThis.currentTrackIndex;
    pl.length = 0; pl.push(...arr);
    if (cur === drag.srcIdx) globalThis.currentTrackIndex = arr.indexOf(m);
    else if (cur > drag.srcIdx && cur <= drag.target) globalThis.currentTrackIndex = cur - 1;
    else if (cur < drag.srcIdx && cur >= drag.target) globalThis.currentTrackIndex = cur + 1;
    dragCleanup();
    render();
    if (wasDrag) {
      lastWasDrag = true;
      clearTimeout(lastWasDragT);
      lastWasDragT = setTimeout(() => { lastWasDrag = false; }, 350);
    }
  }

  /* ---- 开关 ---- */
  toggle.addEventListener('click', (e) => { e.stopPropagation(); isOpen() ? close() : open(); });
  closeBtn.addEventListener('click', close);
  mask.addEventListener('click', close);

  /* ---- 随机排序（洗牌一次，之后顺序播放）----
   * ★ 只打乱当前队列 globalThis.playlist，不写回任何歌单存储；
   *   正在播放的曲目跟随索引移动，播完按新顺序继续（_stepTrack sequence 步进）。
   * ★ 若当前处于随机播放模式，洗牌没有意义（切歌时另行随机抽取，95-track-loading
   *   _stepTrack），自动切回顺序播放让"洗牌+顺序"语义成立。 */
  function shuffleQueue() {
    const pl = getPlaylist();
    if (pl.length < 2) return;
    const cur = typeof globalThis.currentTrackIndex === 'number' ? globalThis.currentTrackIndex : 0;
    const playing = pl[cur];
    for (let i = pl.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = pl[i]; pl[i] = pl[j]; pl[j] = tmp;
    }
    if (playing) globalThis.currentTrackIndex = pl.indexOf(playing);
    const switched = (globalThis.playMode === 'random');
    if (switched) setPlayMode('sequence');
    render();
    if (typeof window.showToast === 'function') {
      window.showToast(switched ? '已随机排序，并切回顺序播放' : '已随机排序，按新顺序播放');
    }
  }

  if (typeof window !== 'undefined') {
    /* 130-playlists「当前播放」详情页复用同一份洗牌逻辑 */
    globalThis.__shufflePlayQueue = shuffleQueue;
  }

  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const doClear = () => { globalThis.playlist.length = 0; globalThis.currentTrackIndex = 0; render(); };
    if (typeof window.showGlassConfirm === 'function') {
      window.showGlassConfirm({
        title: '清空播放队列',
        desc: '确定要清空当前整个播放队列吗？此操作不可撤销。',
        danger: true,
      }).then(ok => { if (ok) doClear(); });
    } else if (window.confirm('清空当前整个播放队列？')) {
      doClear();
    }
  });

  /* ---- 队尾自动续推开关（队列剩 ≤3 首时自动追加每日推荐，135 钩子消费） ---- */
  const headerEl = panel.querySelector('.plm-header');
  globalThis.__autoRefill = (() => { try { return localStorage.getItem('aria_auto_refill') === '1'; } catch (e) { return false; } })();
  const refillBtn = document.createElement('button');
  refillBtn.type = 'button';
  refillBtn.className = 'plm-clear plm-refill';
  const refillPaint = () => {
    refillBtn.textContent = globalThis.__autoRefill ? '续推·开' : '续推';
    refillBtn.title = '队列剩余 ≤3 首时自动追加每日推荐，让列表一直续上（点击切换）';
    refillBtn.style.color = globalThis.__autoRefill ? 'var(--theme-color, #ffcc33)' : '';
    refillBtn.style.borderColor = globalThis.__autoRefill ? 'var(--theme-color, #ffcc33)' : '';
  };
  refillPaint();
  refillBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    globalThis.__autoRefill = !globalThis.__autoRefill;
    try { localStorage.setItem('aria_auto_refill', globalThis.__autoRefill ? '1' : '0'); } catch (err) { /* ignore */ }
    refillPaint();
  });
  if (headerEl && document.getElementById('plmClear')) {
    headerEl.insertBefore(refillBtn, document.getElementById('plmClear'));
  }

  /* ---- 随机排序按钮（只洗队列，不动歌单存储） ---- */
  const shuffleBtn = document.createElement('button');
  shuffleBtn.type = 'button';
  shuffleBtn.className = 'plm-clear plm-shuffle';
  shuffleBtn.textContent = '随机排序';
  shuffleBtn.title = '打乱当前播放队列的顺序（不影响歌单原顺序），之后按新顺序播放；随机播放模式下会自动切回顺序播放';
  shuffleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    shuffleQueue();
  });
  const syncShuffleVis = () => { shuffleBtn.style.display = getPlaylist().length >= 2 ? 'inline-flex' : 'none'; };
  syncShuffleVis();
  if (headerEl && document.getElementById('plmClear')) {
    headerEl.insertBefore(shuffleBtn, document.getElementById('plmClear'));
  }
  /* 队列长度变化时同步显隐（render 是模块内函数，借 play 事件与开面板时机刷新） */
  panel.addEventListener('transitionend', syncShuffleVis);
  if (audio) audio.addEventListener('play', syncShuffleVis);

  /* ---- 点击：播放 / 收藏 / 加入歌单 / 删除（拖拽结束不算点击） ---- */
  listEl.addEventListener('click', (e) => {
    if (lastWasDrag) return;
    if (drag && drag.moved) return;
    const pl = getPlaylist();
    const cur = globalThis.currentTrackIndex;
    const saveBtn = e.target.closest('[data-savepl]');
    if (saveBtn) {
      e.stopPropagation();
      const tr = pl[+saveBtn.dataset.savepl];
      if (!tr) return;
      try {
        globalThis.currentSongData = {
          title: tr.title || tr.song || tr.name || '', artist: tr.artist || tr.singer || '', cover: tr.cover || '',
          source: tr.source || '', id: String(tr.id != null ? tr.id : ''), mid: tr.mid || ''
        };
        globalThis.currentSongKey = makeSongKey(tr);
      } catch (_e) { /* ignore */ }
      openAddToPlaylist();
      return;
    }
    const favBtn = e.target.closest('[data-fav]');
    if (favBtn) { e.stopPropagation(); toggleFav(pl[+favBtn.dataset.fav]); return; }
    const delBtn = e.target.closest('[data-del]');
    if (delBtn) {
      e.stopPropagation();
      const idx = +delBtn.dataset.del;
      pl.splice(idx, 1);
      if (cur > idx) globalThis.currentTrackIndex = cur - 1;
      else if (cur === idx) { if (pl.length) { globalThis.currentTrackIndex = Math.min(idx, pl.length - 1); loadPlaylistTrack(globalThis.currentTrackIndex); } else globalThis.currentTrackIndex = 0; }
      render();
      if (!pl.length) close();
      return;
    }
    /* data-play 已放到整行根节点：点封面/序号/空白区都能播放 */
    const info = e.target.closest('[data-play]');
    if (info) { const i = +info.dataset.play; if (i !== cur) loadPlaylistTrack(i); }
  });

  if (audio) audio.addEventListener('play', () => { if (isOpen()) render(); });
})();
