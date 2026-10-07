/* ============================================================
 * 021-aria-dialog.js — 毛玻璃 alert / confirm / prompt / pick（P3-a 重写）
 *
 * 四个变体现在共用一份实现，行为契约（ESC / 点遮罩 / 焦点陷阱 / 焦点归还 /
 * dialog 语义 / 层级）全部来自 ui/overlay.js，本文件只管"面板里放什么"。
 *
 *   window.showGlassAlert({ title, desc, okText, danger })                → Promise<true>
 *   window.showGlassConfirm({ title, desc, okText, cancelText, danger })  → Promise<boolean>
 *   window.showGlassPrompt({ title, desc, placeholder, value, multiline,
 *                            rows, maxLength, okText, cancelText, onSubmit }) → Promise<string|null>
 *   window.showGlassPick({ title, items, emptyText, onPick })             → Promise<number|null>
 *
 * ★ 为什么 prompt / pick 同时支持 Promise 与回调（onSubmit / onPick）
 *   此前 showGlassPrompt 在 021 与 258 各定义一次，258 后加载**同名覆盖**，
 *   而两版语义不同（021 返回 Promise、258 返回 DOM 元素）。于是
 *   200-settings-panel.js 的 `await window.showGlassPrompt(...)` 拿到一个
 *   HTMLDivElement，applyAutoEqText 收到 "[object HTMLDivElement]" ——
 *   AutoEQ 导入静默失效（不报错，只提示"未识别到任何滤波器"）。
 *   P3-a 把实现收敛到本文件，并让两种调用形态都成立：既修好 AutoEQ，
 *   也不必去改那 5 个既有调用点。
 *
 * ★ 视觉对齐（2026-10-05 用户决策）：毛玻璃统一取搜索页配方
 *   saturate(180%) blur(40px)。原实现在遮罩上用 180%/40、在面板上用
 *   200%/60，属"抄错配方"那类分裂。
 * ============================================================ */

import { openOverlay, closeOverlay } from '../ui/overlay.js';

(function () {
  if (typeof window === 'undefined') return;

  if (!document.getElementById('aria-dialog-style')) {
    const st = document.createElement('style');
    st.id = 'aria-dialog-style';
    st.textContent = `
      /* 层级不在这里写：由 ui/overlay.js 按 --aria-z-modal 注入行内 z-index
         （写死 2400 会让从设置面板弹出的对话框被 .settings-overlay(10000) 盖住）。 */
      .aria-dialog-overlay {
        position: fixed; inset: 0;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0, 0, 0, 0.45);
        backdrop-filter: saturate(180%) blur(40px);
        -webkit-backdrop-filter: saturate(180%) blur(40px);
      }
      .aria-dialog {
        width: min(420px, calc(100vw - 64px));
        /* ★ 2026-10-06：由「对齐 180%/40 的规范」升级为**直接消费令牌** ——
           这个值本来就是 P1 选定的基准配方，接线后外观 mod 的圆角/模糊覆盖
           也能作用到对话框（此前它是写死的，mod 改不动它）。 */
        background: var(--aria-glass-bg);
        backdrop-filter: saturate(var(--aria-glass-saturate)) blur(var(--aria-glass-blur));
        -webkit-backdrop-filter: saturate(var(--aria-glass-saturate)) blur(var(--aria-glass-blur));
        border: 1px solid var(--aria-glass-border);
        border-radius: var(--aria-radius-lg);
        padding: 24px 22px 20px;
        box-shadow: var(--aria-glass-shadow);
        animation: aria-dialog-pop 0.22s cubic-bezier(0.22, 1, 0.36, 1);
      }
      @keyframes aria-dialog-pop { from { opacity: 0; transform: scale(0.94) translateY(6px); } to { opacity: 1; transform: none; } }
      .aria-dialog-title { font-size: 15px; font-weight: 600; color: #fff; margin-bottom: 10px; }
      .aria-dialog-desc {
        font-size: 13px; line-height: 1.7; color: rgba(255, 255, 255, 0.72);
        white-space: pre-wrap; word-break: break-word;
      }
      .aria-dialog-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
      .aria-dialog-btn {
        border: 1px solid rgba(255, 255, 255, 0.16);
        background: rgba(255, 255, 255, 0.08);
        color: #fff; border-radius: 10px; padding: 7px 18px; font-size: 13px;
        cursor: pointer; transition: background 0.18s ease, border-color 0.18s ease;
      }
      .aria-dialog-btn:hover { background: rgba(255, 255, 255, 0.16); border-color: rgba(255, 255, 255, 0.28); }
      .aria-dialog-btn.primary {
        background: rgba(var(--aria-accent-rgb, 232, 190, 106), 0.22);
        border-color: rgba(var(--aria-accent-rgb, 232, 190, 106), 0.55);
      }
      .aria-dialog-btn.primary:hover { background: rgba(var(--aria-accent-rgb, 232, 190, 106), 0.34); }
      .aria-dialog-btn.danger { background: rgba(255, 82, 82, 0.18); border-color: rgba(255, 82, 82, 0.6); }
      .aria-dialog-btn.danger:hover { background: rgba(255, 82, 82, 0.3); }
      .aria-dialog-btn:focus-visible { outline: 2px solid var(--aria-accent, #E8BE6A); outline-offset: 2px; }
      /* 输入框模态：AutoEQ 粘贴 / 备份路径 / 自然语言描述 / EQ 分享码共用 */
      .aria-dialog-input {
        width: 100%; box-sizing: border-box; margin-top: 14px;
        background: rgba(0, 0, 0, 0.28); color: #fff;
        border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 12px;
        padding: 10px 12px; font-size: 13px; line-height: 1.6;
        font-family: ui-monospace, "Cascadia Mono", Consolas, "Microsoft YaHei", monospace;
        outline: none; resize: vertical;
      }
      .aria-dialog-input:focus { border-color: rgba(var(--aria-accent-rgb, 232, 190, 106), 0.6); }
      .aria-dialog-input::placeholder { color: rgba(255, 255, 255, 0.38); }
      /* 列表选择模态（原 258 的 .gp-pick-* 迁入，随同名覆盖一起收编） */
      .aria-dialog-list { margin-top: 10px; max-height: 300px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
      .aria-dialog-pick-item {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        width: 100%; text-align: left; border: none;
        background: rgba(255, 255, 255, 0.06); color: rgba(255, 255, 255, 0.9);
        padding: 10px 12px; border-radius: 10px; font-size: 13px;
        cursor: pointer; transition: background 0.16s ease;
      }
      .aria-dialog-pick-item:hover { background: rgba(255, 255, 255, 0.12); }
      .aria-dialog-pick-meta { font-size: 11px; color: rgba(255, 255, 255, 0.5); flex-shrink: 0; }
      .aria-dialog-empty { padding: 18px; color: rgba(255, 255, 255, 0.5); font-size: 13px; }
    `;
    document.head.appendChild(st);
  }

  const DEFAULT_OK = '确定';
  const DEFAULT_CANCEL = '取消';

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }

  function btn(cls, text) {
    const b = h('button', cls, text);
    b.type = 'button';
    return b;
  }

  /* 统一外壳：遮罩 + .aria-dialog 面板 + 一排操作按钮。
     四个变体只有 bodyNodes 与按钮不同。 */
  function mount(opts, bodyNodes) {
    const overlay = h('div', 'aria-dialog-overlay');
    const shell = h('div', 'aria-dialog');
    if (opts.title) shell.appendChild(h('div', 'aria-dialog-title', opts.title));
    if (opts.desc) shell.appendChild(h('div', 'aria-dialog-desc', opts.desc));
    bodyNodes.forEach((n) => { if (n) shell.appendChild(n); });
    const actions = h('div', 'aria-dialog-actions');
    shell.appendChild(actions);
    overlay.appendChild(shell);
    document.body.appendChild(overlay);
    return { overlay, shell, actions };
  }

  /* 挂到浮层契约上：ESC / 点遮罩 / 焦点陷阱与归还 / dialog 语义 / 层级全由
     ui/overlay.js 负责；settle 是唯一结算点（Promise 的 resolve 挂在它上面）。 */
  function present(opts, bodyNodes, settle) {
    const { overlay, shell, actions } = mount(opts, bodyNodes);
    openOverlay(overlay, {
      shell: '.aria-dialog',
      labelledBy: opts.title ? '.aria-dialog-title' : null,
      label: opts.title ? null : opts.label,
      escClose: opts.escClose !== false,
      backdropClose: opts.backdropClose !== false,
      cancelResult: opts.cancelResult === undefined ? null : opts.cancelResult,
      selectOnFocus: opts.selectOnFocus === true,
      onClose: settle,
    });
    return { overlay, shell, actions };
  }

  window.showGlassAlert = function (opts = {}) {
    return new Promise((resolve) => {
      const { overlay, actions } = present({ ...opts, cancelResult: null }, [], () => resolve(true));
      const ok = btn('aria-dialog-btn primary' + (opts.danger ? ' danger' : ''), opts.okText || DEFAULT_OK);
      ok.addEventListener('click', () => closeOverlay(overlay, true));
      actions.appendChild(ok);
    });
  };

  window.showGlassConfirm = function (opts = {}) {
    return new Promise((resolve) => {
      const { overlay, actions } = present({ ...opts, cancelResult: false }, [],
        (r) => resolve(r === true));
      const cancel = btn('aria-dialog-btn', opts.cancelText !== undefined ? opts.cancelText : DEFAULT_CANCEL);
      cancel.addEventListener('click', () => closeOverlay(overlay, false));
      const ok = btn('aria-dialog-btn primary' + (opts.danger ? ' danger' : ''), opts.okText || DEFAULT_OK);
      ok.addEventListener('click', () => closeOverlay(overlay, true));
      actions.appendChild(cancel);
      actions.appendChild(ok);
    });
  };

  window.showGlassPrompt = function (opts = {}) {
    return new Promise((resolve) => {
      const multiline = !!opts.multiline;
      const input = multiline ? h('textarea', 'aria-dialog-input') : h('input', 'aria-dialog-input');
      if (multiline) input.rows = opts.rows || 8;
      else input.type = 'text';
      input.placeholder = opts.placeholder || '';
      input.value = opts.value || '';
      if (opts.maxLength) input.maxLength = opts.maxLength;
      /* 告诉浮层内核：打开后聚焦它并全选（与旧实现 ta.focus()+ta.select() 一致） */
      input.setAttribute('data-autofocus', '');

      const { overlay, actions } = present({ ...opts, cancelResult: null, selectOnFocus: true }, [input],
        (val) => {
          /* ★ 双 API 的唯一结算点：
             · Promise 一律结算（取消/ESC 得 null）—— 200-settings-panel 的
               `const text = await ...; if (text == null) return;` 依赖这个语义；
             · onSubmit 只在**确有输入动作**时回调，取消不回调 —— 与 258 旧实现一致，
               调用点都按这个语义写的（290 的 cb 会把 null 当成"名字不能为空"报错，
               取消时回调就会冒出误提示）。 */
          resolve(val);
          if (val !== null && typeof opts.onSubmit === 'function') opts.onSubmit(val);
        });

      const finish = (val) => closeOverlay(overlay, val);
      const cancel = btn('aria-dialog-btn', opts.cancelText !== undefined ? opts.cancelText : DEFAULT_CANCEL);
      cancel.addEventListener('click', () => finish(null));
      const ok = btn('aria-dialog-btn primary', opts.okText || DEFAULT_OK);
      ok.addEventListener('click', () => finish(input.value));
      actions.appendChild(cancel);
      actions.appendChild(ok);

      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        /* 单行：Enter 直接确认；多行：Ctrl/Cmd+Enter 确认，裸 Enter 留给换行 */
        if (!multiline || e.ctrlKey || e.metaKey) {
          e.preventDefault();
          finish(input.value);
        }
      });
    });
  };

  window.showGlassPick = function (opts = {}) {
    const items = opts.items || [];
    return new Promise((resolve) => {
      const list = h('div', 'aria-dialog-list');
      if (items.length === 0) {
        list.appendChild(h('div', 'aria-dialog-empty', opts.emptyText || '没有可选项'));
      }
      const { overlay, actions } = present({ ...opts, cancelResult: null }, [list], (idx) => {
        resolve(idx);
        /* 取消/ESC 传 null，只有真的选中才回调（与旧 258 实现一致） */
        if (typeof idx === 'number' && typeof opts.onPick === 'function') opts.onPick(idx);
      });
      items.forEach((it, i) => {
        const b = btn('aria-dialog-pick-item', it.name);
        if (it.meta) b.appendChild(h('span', 'aria-dialog-pick-meta', it.meta));
        b.addEventListener('click', () => closeOverlay(overlay, i));
        list.appendChild(b);
      });
      const cancel = btn('aria-dialog-btn', opts.cancelText !== undefined ? opts.cancelText : DEFAULT_CANCEL);
      cancel.addEventListener('click', () => closeOverlay(overlay, null));
      actions.appendChild(cancel);
    });
  };
})();
