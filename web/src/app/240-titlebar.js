/* ============================================================
 * 240-titlebar.js — Aria 自定义标题栏（Tauri 桌面端 + 浏览器端通用）
 * 1. 透明无图标，纯 CSS 圆角窗口
 * 2. 品牌字 "Aria" 跟随全局字体设置 (--app-font-family)
 * 3. 品牌整体单一文字颜色随背景主导色亮度自动黑/白（非逐字）
 * 4. 三大金刚键为 SVG，默认透明，hover 时才出现方形半透明底，关闭键 hover 红
 * 5. 拖动/双击最大化仅 Tauri 环境生效；浏览器环境只负责颜色跟随
 * ============================================================ */
import { logCatch } from '../services/log.js';
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
  function updateBrandColor() {
    const d = window.dominantColor;
    let light = true; // 默认浅色文字（白色）
    if (d && typeof d.r === 'number' && typeof d.g === 'number' && typeof d.b === 'number') {
      const L = (0.2126 * d.r + 0.7152 * d.g + 0.0722 * d.b) / 255;
      light = L < 0.48; // 背景偏暗→白字，偏亮→黑字
    }
    /* ★ 深色舞台的视觉模式（活字/霓虹/隧道/浮空/PV）不随封面主色翻转：
       它们的舞台底色恒为深色，标题栏必须保持浅色文字（用户反馈活字暗底下
       标题栏仍是深色文字、看不见） */
    const pcCls = (document.querySelector('.player-container') || {}).className || '';
    if (/view-(letterpress|neon|tunnel|dimension|pv)\b/.test(pcCls)) light = true;
    /* ★ 性能（2026-09-20）：CSS 自定义属性重复写同值会触发全树 style recalc——
       值不变时跳过写入（该函数被 700ms 定时器反复调用，恒定值 = 纯浪费） */
    const fg = light ? 'rgba(255,255,255,0.92)' : 'rgba(20,20,24,0.92)';
    if (fg !== updateBrandColor._last) {
      updateBrandColor._last = fg;
      document.documentElement.style.setProperty('--titlebar-fg', fg);
    }
  }
  updateBrandColor();
  /* ★ 性能（2026-09-23）：原 setInterval(700ms) 常驻轮询（含 querySelector）改事件驱动——
     dominantColor 赋值点（100-cover-background）与 .player-container 视觉模式类切换
     （previewEngine.setMode 各路径）都会触发重算；类切换用单元素 attribute 观察器，
     开销仅在切模式瞬间，恒定状态零开销。 */
  globalThis.__updateBrandColor = updateBrandColor;
  try {
    const pcEl = document.querySelector('.player-container');
    if (pcEl && typeof MutationObserver !== 'undefined') {
      let _bcTimer = null;
      new MutationObserver(() => {
        if (_bcTimer) return;
        _bcTimer = setTimeout(() => { _bcTimer = null; updateBrandColor(); }, 120);
      }).observe(pcEl, { attributes: true, attributeFilter: ['class'] });
    }
  } catch (e) { /* ignore */ }

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
