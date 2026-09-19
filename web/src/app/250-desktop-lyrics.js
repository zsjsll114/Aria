/* ============================================================
 * 250-desktop-lyrics.js — 桌面歌词
 * 主窗口侧：开关按钮状态维护 + 每 120ms 把当前行/进度/逐字词/翻译
 * 写入 localStorage('aria_dtk_state')，desktop_lyrics 窗口经
 * storage 事件即时渲染（同源跨窗口共享存储）。
 * ============================================================ */
import { audio } from './20-lyrics-render.js';
import { saveSettings } from './180-boot-config.js';

(function () {
  const btn = document.getElementById('desktopLyricsBtn');
  if (!btn) return;

  /* ★ 远程页面的 window.__TAURI__ 是注入的，可能晚于本模块 eval（与 240-titlebar 同源问题）。
     因此不能在此处一次性捕获 invoke —— 必须在点击/调用时动态解析，
     否则注入一旦晚到，invoke 永久为 null，桌面歌词按钮形同虚设。 */
  function getInvoke() {
    const TA = window.__TAURI__;
    return TA && TA.core && typeof TA.core.invoke === 'function' ? TA.core.invoke.bind(TA.core) : null;
  }

  const LS_STATE = 'aria_dtk_state';
  const LS_ENABLED = 'aria_dtk_enabled';
  const LS_LOCKED = 'aria_dtk_locked';
  const LS_POS = 'aria_dtk_pos';
  const LS_CLOSED = 'aria_dtk_closed';
  /* ★ 应用设置档（与 constants.js 的 SETTINGS_STORAGE_KEY 一致），
     桌面歌词位置随 settings 一并同步到后端 user_config.json */
  const LS_SETTINGS = 'lyrics_player_settings';

  let enabled = localStorage.getItem(LS_ENABLED) === '1';

  function refreshBtn() {
    const locked = localStorage.getItem(LS_LOCKED) === '1' && enabled;
    btn.classList.toggle('active-dl', enabled);
    btn.setAttribute('data-tooltip', locked ? '解锁桌面歌词' : '桌面歌词');
    btn.setAttribute('aria-label', locked ? '解锁桌面歌词' : '桌面歌词');
  }

  /* ★ 从 userconfig(设置档 interface.desktopLyricsPosition) 读取上次位置 */
  function readPosFromSettings() {
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      if (!raw) return null;
      const s = JSON.parse(raw);
      const pos = s && s.interface ? s.interface.desktopLyricsPosition : null;
      if (Array.isArray(pos) && pos.length === 2 && isFinite(pos[0]) && isFinite(pos[1])) return [pos[0], pos[1]];
      return null;
    } catch (_e) { return null; }
  }

  function readSavedPos() {
    const p = readPosFromSettings();
    if (p) return p;
    try {
      const q = JSON.parse(localStorage.getItem(LS_POS) || 'null');
      if (Array.isArray(q) && q.length === 2 && isFinite(q[0]) && isFinite(q[1])) return [q[0], q[1]];
    } catch (_e) {}
    return null;
  }

  /* 位置写入 userconfig 档：歌词窗口拖动后写 aria_dtk_pos，
     本窗口收到 storage 事件后合并进 settings 档再同步后端 */
  function persistPosToSettings(pos) {
    if (!Array.isArray(pos) || pos.length < 2) return;
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      let s = null;
      try { s = raw ? JSON.parse(raw) : null; } catch (_e) { s = null; }
      if (!s || typeof s !== 'object') s = {};
      if (!s.interface || typeof s.interface !== 'object') s.interface = {};
      s.interface.desktopLyricsPosition = [pos[0], pos[1]];
      localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
      /* 同步进内存 appSettings，避免 saveSettings 整体覆盖时丢位置 */
      if (typeof window !== 'undefined' && window.appSettings) {
        if (!window.appSettings.interface) window.appSettings.interface = {};
        window.appSettings.interface.desktopLyricsPosition = [pos[0], pos[1]];
      }
      /* 防抖同步到本地 user_config.json */
      if (typeof window !== 'undefined' && typeof window.syncConfigToBackend === 'function') {
        clearTimeout(window._dtkPosCfgT);
        window._dtkPosCfgT = setTimeout(function () { window.syncConfigToBackend(); }, 400);
      }
    } catch (_e) {}
  }

  async function showWin() {
    const invoke = getInvoke();
    if (!invoke) return;
    const pos = readSavedPos();
    await invoke('desktop_lyrics_show', { show: true, x: pos ? pos[0] : null, y: pos ? pos[1] : null }).catch(() => {});
    if (localStorage.getItem(LS_LOCKED) === '1') {
      await invoke('desktop_lyrics_click_through', { enable: true }).catch(() => {});
    }
  }

  function hideWin() {
    const invoke = getInvoke();
    if (!invoke) return;
    invoke('desktop_lyrics_show', { show: false, x: null, y: null }).catch(() => {});
  }

  btn.addEventListener('click', async () => {
    if (enabled && localStorage.getItem(LS_LOCKED) === '1') {
      /* 已锁定穿透：第一次点击主界面按钮即解锁 */
      localStorage.setItem(LS_LOCKED, '0');
      const invoke = getInvoke();
      if (invoke) await invoke('desktop_lyrics_click_through', { enable: false }).catch(() => {});
      refreshBtn();
      return;
    }
    enabled = !enabled;
    localStorage.setItem(LS_ENABLED, enabled ? '1' : '0');
    refreshBtn();
    if (enabled) { showWin(); push(true); } else { hideWin(); }
  });

  /* 歌词窗口里点了 ✕：同步主界面按钮状态 */
  window.addEventListener('storage', (e) => {
    if (e.key === LS_CLOSED && e.newValue) {
      enabled = false;
      localStorage.setItem(LS_ENABLED, '0');
      refreshBtn();
    }
    /* ★ 歌词窗口侧锁定状态变化时同步按钮提示（按钮即解锁入口） */
    if (e.key === LS_LOCKED) {
      refreshBtn();
    }
    /* ★ 歌词窗口拖动/移动后写入 aria_dtk_pos：
       合并进 settings 档(interface.desktopLyricsPosition)并同步后端 user_config.json，
       保证重启后位置不丢 */
    if (e.key === LS_POS && e.newValue) {
      try {
        const pos = JSON.parse(e.newValue);
        if (Array.isArray(pos) && pos.length === 2) persistPosToSettings(pos);
      } catch (_e) {}
    }
  });

  /* 计算每个词的填充比例数组（逐字逐词高亮） */
  function calcFills(cur, nx, tms) {
    if (!cur || !Array.isArray(cur.words) || cur.words.length === 0) return null;
    const fills = new Array(cur.words.length);
    const curStart = typeof cur.start === 'number' ? cur.start : 0;
    const nxStart = nx && typeof nx.start === 'number' ? nx.start : (curStart + (typeof cur.duration === 'number' ? cur.duration : 5000));
    const lineDur = Math.max(1, nxStart - curStart);
    for (let i = 0; i < cur.words.length; i++) {
      const w = cur.words[i];
      const ws = typeof w.start === 'number' ? w.start : curStart;
      const we = typeof w.end === 'number' ? w.end : (ws + Math.floor(lineDur / cur.words.length));
      const dur = Math.max(1, we - ws);
      const raw = (tms - ws) / dur;
      fills[i] = Math.max(0, Math.min(1, raw));
    }
    return fills;
  }

  function currentPayload() {
    const pl = globalThis.playlist || [];
    const idx = typeof globalThis.currentTrackIndex === 'number' ? globalThis.currentTrackIndex : 0;
    const tr = pl[idx] || {};
    const lyr = globalThis.lyrics;
    const i = globalThis.activeLineIndex;
    let l1 = '', l2 = '', words1 = null, words2 = null, trans1 = '', fills = null;
    let curStart = null, nextStart = null;
    const tms = (typeof globalThis.currentTime === 'number' ? globalThis.currentTime : 0) + (globalThis.lyricOffset || 0);

    if (Array.isArray(lyr) && lyr.length && typeof i === 'number' && i >= 0 && i < lyr.length) {
      const cur = lyr[i] || {};
      const nx = lyr[i + 1] || null;
      l1 = String(cur.original || cur.text || '').trim();
      words1 = Array.isArray(cur.words) && cur.words.length ? cur.words.map(w => ({ text: w.text, start: w.start, end: w.end })) : null;
      l2 = nx ? String(nx.original || nx.text || '').trim() : '';
      words2 = nx && Array.isArray(nx.words) && nx.words.length ? nx.words.map(w => ({ text: w.text, start: w.start, end: w.end })) : null;
      trans1 = String(cur.translation || '').trim();
      fills = calcFills(cur, nx, tms);
      curStart = typeof cur.start === 'number' ? cur.start : null;
      nextStart = nx && typeof nx.start === 'number' ? nx.start : null;
    }
    return JSON.stringify({
      title: tr.title || '',
      artist: tr.artist || tr.singer || '',
      l1, l2, words1, words2, trans1, fills,
      /* ★ 供桌面歌词窗口做本地 rAF 插值：tms=当前音频时间(ms)，
         curStart/nextStart=上下行起始时间，用于行内逐字推进计算 */
      tms, curStart, nextStart,
      playing: !!(audio && !audio.paused && !(globalThis.isBuffering)),
      /* ★ 主题色跟随：主界面当前主题色随推送带上，桌面歌词按此给逐字高亮上色 */
      themeColor: (typeof document !== 'undefined' && document.documentElement)
        ? getComputedStyle(document.documentElement).getPropertyValue('--theme-color').trim() || '#ffcc33'
        : '#ffcc33',
      /* ★ 字体跟随：主界面字体设置变量 → 桌面歌词窗口 */
      fontFamily: (typeof document !== 'undefined' && document.documentElement)
        ? (getComputedStyle(document.documentElement).getPropertyValue('--app-font-family').trim() || undefined)
        : undefined,
      /* ★ 歌词样式跟随（与主界面歌词一致）：
         - lyricFontFamily：主界面歌词行实测 font-family（含多语言字体解析结果）
         - lyricFontSize：主界面原文行实测 font-size，桌面歌词以此替换固定 30px
         （描边/粗体桌面歌词保留自身设计，不与主界面同步） */
      lyricFontFamily: (function () {
        try {
          const el = document.querySelector('.player-container:not(.preview-player) .lrc-original')
                  || document.querySelector('.lrc-original');
          return el ? getComputedStyle(el).fontFamily : undefined;
        } catch (_e) { return undefined; }
      })(),
      /* ★ 字号跟随：主界面原文行字号 → --fs-main（歌词/翻译/标题全部随之缩放）
         ★ 词云/PV/隧道/浮空/全景等视觉模式下不加前缀——它们的 .lrc-original 是超大排版字号，
           直接送到桌面歌词窗口会导致"无端放大很多倍"；并对任意来源字号做 16~72px 钳制 */
      lyricFontSize: (function () {
        try {
          if (typeof document !== 'undefined' && document.querySelector('.player-container')) {
            const cls = document.querySelector('.player-container').className;
            if (/(?:view-wordcloud|view-pv|view-tunnel|view-dimension|view-polyphony|view-letterpress|view-neon)/.test(cls)) return undefined;
          }
          const el = document.querySelector('.player-container:not(.preview-player) .lrc-original')
                  || document.querySelector('.lrc-original');
          const fs = el ? parseFloat(getComputedStyle(el).fontSize) : 0;
          if (!fs || !isFinite(fs)) return undefined;
          return `${Math.min(72, Math.max(16, Math.round(fs)))}px`;
        } catch (_e) { return undefined; }
      })(),
      /* ★ 情感词颜色：AI 情感词 {word: color}，桌面歌词可按词着色（最多 120 条防泡大） */
      emColors: buildEmColorMap()
    });
    function buildEmColorMap() {
      const map = {};
      try {
        const ws = (typeof globalThis !== 'undefined' && Array.isArray(globalThis.aiEmotionWords)) ? globalThis.aiEmotionWords : [];
        const max = Math.min(ws.length, 120);
        for (let i = 0; i < max; i++) {
          const w = ws[i];
          if (w && w.word && w.color) map[String(w.word).trim()] = w.color;
        }
      } catch (e) {}
      return map;
    }
  }

  let last = null;
  function push(force) {
    try {
      const p = currentPayload();
      if (force || p !== last) {
        last = p;
        localStorage.setItem(LS_STATE, p);
      }
    } catch (_e) {}
  }

  setInterval(() => { if (enabled) push(false); }, 120);

  /* ---- 启动恢复 ---- */
  refreshBtn();
  if (enabled) {
    /* ★ 注入可能晚到：$invoke 动态解析 + 重试，确保启动时自动恢复也能生效 */
    let itry = 0;
    (function tryLaunch() {
      if (!getInvoke()) {
        if (++itry > 40) return; /* 4s 仍未注入则放弃，等用户点按钮时再触发 */
        setTimeout(tryLaunch, 100);
        return;
      }
      showWin().then(() => push(true));
    })();
  }
})();

/* ==================== 设置 → 界面 → 桌面歌词（字号/字体/情感词） ====================
   写共享 localStorage（aria_dtk_*）→ 歌词窗口 storage 事件实时生效；
   同时落 appSettings.interface.desktopLyrics + saveSettings 持久化。 */
(function initDtkSettingsRows() {
    const root = document.querySelector('[data-section="interface"]');
    if (!root) return;
    const dls = appSettings.interface.desktopLyrics ||
        (appSettings.interface.desktopLyrics = { fontSize: 34, fontFamily: 'default', emotionWords: true });

    const persist = () => {
        try {
            localStorage.setItem('aria_dtk_fontsize', String(dls.fontSize || 34));
            if (dls.fontFamily && dls.fontFamily !== 'default') {
                localStorage.setItem('aria_dtk_fontfamily', dls.fontFamily);
            } else {
                localStorage.removeItem('aria_dtk_fontfamily');
            }
            localStorage.setItem('aria_dtk_emwords', dls.emotionWords === false ? '0' : '1');
            saveSettings();
        } catch (e) { /* ignore */ }
    };

    /* 字号滑杆 */
    const slider = root.querySelector('[data-var="dlFontSize"]');
    if (slider) {
        slider.value = String(dls.fontSize || 34);
        const valEl = root.querySelector('[data-val="dlFontSize"]');
        if (valEl) valEl.textContent = (dls.fontSize || 34) + 'px';
        slider.addEventListener('input', () => {
            dls.fontSize = parseInt(slider.value, 10) || 34;
            if (valEl) valEl.textContent = slider.value + 'px';
            persist();
        });
    }

    /* 字体下拉（含防重绑定，见 220:513 的 _ariaToggleBound 约定） */
    const dd = root.querySelector('.setting-dropdown[data-var="dlFontFamily"]');
    if (dd) {
        const trigger = dd.querySelector('.setting-dropdown-trigger');
        const items = [...dd.querySelectorAll('.setting-dropdown-item')];
        const saved = dls.fontFamily || 'default';
        const sel = items.find(x => x.dataset.value === saved);
        if (sel && trigger) {
            items.forEach(x => x.classList.remove('selected'));
            sel.classList.add('selected');
            trigger.textContent = sel.textContent;
        }
        if (trigger && !trigger._dtkBound) {
            trigger._dtkBound = true;
            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                dd.classList.toggle('open');
            });
        }
        items.forEach(it => it.addEventListener('click', () => {
            dls.fontFamily = it.dataset.value;
            items.forEach(x => x.classList.remove('selected'));
            it.classList.add('selected');
            if (trigger) trigger.textContent = it.textContent;
            dd.classList.remove('open');
            persist();
        }));
    }

    /* 情感词开关 */
    const tg = root.querySelector('[data-var="dlEmotionWords"]');
    if (tg) {
        tg.classList.toggle('on', dls.emotionWords !== false);
        tg.addEventListener('click', () => {
            dls.emotionWords = !(dls.emotionWords !== false);
            tg.classList.toggle('on', dls.emotionWords !== false);
            persist();
        });
    }
})();
