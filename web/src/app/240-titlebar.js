/* ============================================================
 * 240-titlebar.js — Aria 自定义标题栏（Tauri 桌面端 + 浏览器端通用）
 * 1. 透明无图标，纯 CSS 圆角窗口
 * 2. 品牌字 "Aria" 跟随全局字体设置 (--app-font-family)
 * 3. 品牌整体单一文字颜色随背景主导色亮度自动黑/白（非逐字）
 * 4. 三大金刚键为 SVG，默认透明，hover 时才出现方形半透明底，关闭键 hover 红
 * 5. 拖动/双击最大化仅 Tauri 环境生效；浏览器环境只负责颜色跟随
 * ============================================================ */
import { logCatch } from '../services/log.js';
import { pickInk, relativeLuminance } from '../utils/colorUtils.js'; // 感知亮度：全仓唯一一份实现
(function () {
  if (typeof document === 'undefined') return;

  const tb = document.getElementById('appTitlebar');
  if (!tb) return;
  /* ★ 标题栏只应在 Tauri 桌面端显示（浏览器隐藏）。
     旧逻辑无条件 `tb.style.display=''` + 加 aria-desktop —— 结果网页版也出现三大金刚键。
     现在改为：head 里的内联脚本已按 `window.__TAURI__` 尽早加过 aria-desktop（首帧即可见，
     无滞后）；这里仅在确认为 Tauri 环境时补一次，浏览器环境保持 CSS 默认隐藏。 */
  const markDesktop = () => {
    tb.style.display = '';
    if (document.documentElement) document.documentElement.classList.add('aria-desktop');
    if (document.body) document.body.classList.add('aria-desktop');
  };
  const IS_TAURI_NOW = !!(window.__TAURI__ && window.__TAURI__.core);
  if (IS_TAURI_NOW) markDesktop();

  /* ★★ 颜色跟随：浏览器 / Tauri 都需要，放在最顶层 IIFE 里保证两端都启动 */
  const INK_LIGHT = 'rgba(255,255,255,0.92)';
  const INK_DARK = 'rgba(20,20,24,0.92)';

  /* CSS filter: brightness(b) 是对**编码后**的 sRGB 通道做线性乘法（规范如此），
     所以先按编码值乘，再交给 relativeLuminance 去 gamma——顺序反了就白算。 */
  function readFilterBrightness(el, fallback) {
    try {
      const f = el ? getComputedStyle(el).filter : '';
      const m = f && /brightness\(\s*([\d.]+)/.exec(f);
      if (m) { const v = Number(m[1]); if (Number.isFinite(v)) return v; }
    } catch (e) { logCatch('titlebar', e); }
    return fallback;
  }

  /** 叠在 .blur-background 之上的 .color-overlay 的 rgba（拿不到返回 null） */
  function readOverlayTint(el) {
    try {
      const bg = el ? getComputedStyle(el).backgroundColor : '';
      const m = bg && /rgba?\(([^)]+)\)/.exec(bg);
      if (!m) return null;
      const parts = m[1].split(',').map(s => Number(s.trim()));
      if (parts.length < 3 || parts.some(n => !Number.isFinite(n))) return null;
      const a = parts.length >= 4 ? parts[3] : 1;
      return a > 0 ? { r: parts[0], g: parts[1], b: parts[2], a } : null;
    } catch (e) { logCatch('titlebar', e); return null; }
  }

  /** 背景层当前有没有参与合成。
   *  ★ 读 .visible 类而不是 computed opacity：两层都有 `transition: opacity .8s/.5s`，
   *    交叉淡入中途读到的是 0.0x，会把背景算成纯黑→判成亮墨，而且淡入完成时
   *    没有任何属性变更再触发观察器，就永久停在错的那一边（实测假失败就是这么来的）。 */
  function layerAlpha(el) {
    if (!el) return 0;
    try {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
      return el.classList.contains('visible') ? 1 : 0;
    } catch (e) { logCatch('titlebar', e); return 0; }
  }

  /**
   * 标题栏底下那一层**实际合成出来**的颜色的相对亮度（0~1，非线性）；拿不到封面主色返回 null。
   * 自下而上：body::before 的不透明 #000 地板 → .blur-background（封面色 × brightness）
   * → .color-overlay（未压暗的封面色，alpha 由 JS 写进 backgroundColor）。
   * ★ 刻意去读这两层的计算样式，而不是把各视觉模式的 brightness 抄第二份表：
   *   view-letterpress/neon/tunnel/dimension/pv/flyin/wordcloud 全用 !important 把自己的
   *   亮度钉死（viewmode.css:369 钉 .12、:730 钉 .1），抄表必漏——旧版就漏了 flyin/wordcloud，
   *   而且设置页里拖 blur/brightness 滑块立刻不同步。读样式则天然跟着级联走。
   * ★ 每层都要乘它自己的 opacity：双层交叉淡入中途 <1，不乘会在切歌瞬间判错亮暗。
   */
  function backdropLuminance() {
    const d = window.dominantColor;
    if (!d || !Number.isFinite(Number(d.r)) || !Number.isFinite(Number(d.g)) || !Number.isFinite(Number(d.b))) return null;
    /* body::before 是不透明 #000 地板（见 base.css 里那段注释），所以从 0 起算 */
    let r = 0, g = 0, b = 0;
    const blur = document.querySelector('.blur-background.visible')
      || document.getElementById('blurBackground')
      || document.querySelector('.blur-background');
    if (blur) {
      let s = null;
      try { s = (window.appSettings && window.appSettings.background) || null; } catch (e) { logCatch('titlebar', e); }
      const dim = readFilterBrightness(blur, s && Number.isFinite(Number(s.brightness)) ? Number(s.brightness) : 0.35);
      const a = layerAlpha(blur);
      r += Number(d.r) * dim * a; g += Number(d.g) * dim * a; b += Number(d.b) * dim * a;
    }
    const ov = document.querySelector('.color-overlay');
    const tint = readOverlayTint(ov);
    if (tint) {
      const a = tint.a * layerAlpha(ov);
      r = r * (1 - a) + tint.r * a;
      g = g * (1 - a) + tint.g * a;
      b = b * (1 - a) + tint.b * a;
    }
    return relativeLuminance(r, g, b);
  }

  function updateBrandColor() {
    const root = document.documentElement;
    /* 拿不到封面主色（首帧、CORS 污染的封面）时保持浅色——界面底色本来就是深的 */
    const L = backdropLuminance();
    let light = true;
    if (L !== null) {
      light = pickInk(L, updateBrandColor._lastLight !== false).light;
    }
    /* ★ 深色舞台的视觉模式不随封面主色翻转：它们的舞台底色恒为深色。
       名单与 283-readability.js 的 SELF_DARK_STAGES 对齐（旧版漏了 flyin/wordcloud）。 */
    const pc = document.querySelector('.player-container:not(.preview-player)');
    const pcCls = (pc && pc.className) || '';
    if (/view-(letterpress|neon|tunnel|dimension|pv|flyin|wordcloud)\b/.test(pcCls)) light = true;

    /* ★ 只在真的换边时写变量；值不变就跳过（CSS 自定义属性重复写同值会触发全树 style recalc） */
    if (updateBrandColor._lastLight === light) return;
    updateBrandColor._lastLight = light;
    /* 三件套一起换：前景墨、hover 底、logo 底。
       hover 原先在 CSS 里写死 rgba(255,255,255,.15)——亮墨（深背景）没问题，
       暗墨（浅背景）时白色 hover 等于没有，按钮点了看不见。 */
    root.style.setProperty('--titlebar-fg', light ? INK_LIGHT : INK_DARK);
    root.style.setProperty('--titlebar-hover-bg', light ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)');
    root.style.setProperty('--titlebar-veil-bg', light ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)');
  }
  updateBrandColor._lastLight = null;
  updateBrandColor();
  /* ★ 性能（2026-09-23）：原 setInterval(700ms) 常驻轮询（含 querySelector）改事件驱动——
     dominantColor 赋值点（100-cover-background）与 .player-container 视觉模式类切换
     （previewEngine.setMode 各路径）都会触发重算；类切换用单元素 attribute 观察器，
     开销仅在切模式瞬间，恒定状态零开销。 */
  globalThis.__updateBrandColor = updateBrandColor;
  try {
    /* 同一份 120ms 合并的 debounce 复用给两类信号：
       ① .player-container 的 class（视觉模式切换）；
       ② 背景层的 style（applyBackgroundSettings 改 blur/brightness、换封面写
          backgroundImage、applyColorOverlay 改 rgba）——这些都不经过 ①，
          不观察就还是会在设置里拖完滑块后标题栏停在旧墨色。 */
    let _bcTimer = null;
    const schedule = () => {
      if (_bcTimer) return;
      _bcTimer = setTimeout(() => { _bcTimer = null; updateBrandColor(); }, 120);
    };
    if (typeof MutationObserver !== 'undefined') {
      const pcEl = document.querySelector('.player-container:not(.preview-player)')
        || document.querySelector('.player-container');
      if (pcEl) new MutationObserver(schedule).observe(pcEl, { attributes: true, attributeFilter: ['class'] });
      const bg = document.getElementById('blurBackground');
      const bg2 = document.getElementById('blurBackground2');
      const ov = document.getElementById('colorOverlay');
      const styleObs = new MutationObserver(schedule);
      [bg, bg2, ov].forEach(el => {
        if (el) styleObs.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
      });
    }
  } catch (e) { logCatch('titlebar', e); }

  /* ========== Tauri 桌面端专属：拖动 / 最小化 / 最大化 / 关闭 ========== */
  function initDesktop() {
    const IS_TAURI = !!(window.__TAURI__ && window.__TAURI__.core);
    if (!IS_TAURI) return;
    try {
      if (typeof window.__TAURI__.window.getCurrentWindow !== 'function') return;
    } catch (e) { return; }

    let appWindow = null;
    try { appWindow = window.__TAURI__.window.getCurrentWindow(); } catch (e) { appWindow = null; }
    if (!appWindow) return;

    tb.style.display = '';

    const btnMin = document.getElementById('tbMinimize');
    const btnMax = document.getElementById('tbMaximize');
    const btnClose = document.getElementById('tbClose');

    const ICON_MAX = '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1.8" y="1.8" width="8.4" height="8.4" rx="1.2"></rect></svg>';
    const ICON_RESTORE = '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M4.2 4.2V3.4c0-.7.5-1.2 1.2-1.2h3.2c.7 0 1.2.5 1.2 1.2v3.2c0 .7-.5 1.2-1.2 1.2H8.6"></path><rect x="2.2" y="4.6" width="5.4" height="5.4" rx="1"></rect></svg>';

    if (btnMin) btnMin.addEventListener('click', () => { try { appWindow.minimize(); } catch (e) { logCatch('titlebar', e); } });
    if (btnMax) btnMax.addEventListener('click', () => { try { appWindow.toggleMaximize(); } catch (e) { logCatch('titlebar', e); } });
    if (btnClose) btnClose.addEventListener('click', () => { try { appWindow.close(); } catch (e) { logCatch('titlebar', e); } });

    // 最大化/还原图标切换
    if (btnMax) {
      const syncMax = () => {
        try {
          appWindow.isMaximized().then((m) => { btnMax.innerHTML = m ? ICON_RESTORE : ICON_MAX; }).catch((e) => logCatch('titlebar', e));
        } catch (e) { logCatch('titlebar', e); }
      };
      syncMax();
      try { appWindow.onResized(syncMax); } catch (e) { logCatch('titlebar', e); }
    }

    /* 手动拖动：mousedown 即调用 startDragging（权限 core:window:allow-start-dragging）。
       双击最大化用 e.detail===2 在 mousedown 阶段判定——startDragging 进入系统移动循环后
       会吞掉后续 dblclick 事件，不能依赖 dblclick 监听。 */
    tb.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest('.tb-btn')) return; // 按钮区不参与拖动
      try {
        if (e.detail >= 2) {
          appWindow.toggleMaximize();
        } else {
          appWindow.startDragging();
        }
      } catch (err) { logCatch('titlebar', err); }
    });
  }

  /* 轮询等待 Tauri 全局对象注入（最长约 6 秒）；超时则视为浏览器环境 */
  let tries = 0;
  (function waitTauri() {
    if (window.__TAURI__ && window.__TAURI__.core) {
      markDesktop();   /* 注入晚于本脚本时兜底补标（head 内联脚本通常已先行完成） */
      initDesktop();
      return;
    }
    if (++tries > 60) return;
    setTimeout(waitTauri, 100);
  })();
})();
