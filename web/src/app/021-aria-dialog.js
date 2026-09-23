/* ============================================================
 * 021-aria-dialog.js — 毛玻璃 alert / confirm（替代浏览器原生弹窗）
 * 设计规范对齐 gp-modal（search-modal 毛玻璃系）：半透明深底 + backdrop blur，
 * 圆角卡片 + 主题色按钮。零依赖，可在任意分片调用：
 *   window.showGlassAlert({ title, desc, okText })              → 自动关闭
 *   window.showGlassConfirm({ title, desc, okText, cancelText, danger }) → Promise<boolean>
 * ============================================================ */

(function () {
  if (typeof window === 'undefined') return;

  if (!document.getElementById('aria-dialog-style')) {
    const st = document.createElement('style');
    st.id = 'aria-dialog-style';
    st.textContent = `
      .aria-dialog-overlay {
        position: fixed; inset: 0; z-index: 2400;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0, 0, 0, 0.45);
        backdrop-filter: saturate(180%) blur(40px);
        -webkit-backdrop-filter: saturate(180%) blur(40px);
      }
      .aria-dialog {
        width: min(420px, calc(100vw - 64px));
        /* ★ 对齐 search-modal 毛玻璃规范（此前 rgba(28,30,40,.72) 深实底，用户反馈"黑黑的"） */
        background: rgba(255, 255, 255, 0.12);
        backdrop-filter: saturate(200%) blur(60px);
        -webkit-backdrop-filter: saturate(200%) blur(60px);
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 24px;
        padding: 24px 22px 20px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.15);
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
        background: rgba(var(--theme-color-rgb, 255, 204, 51), 0.22);
        border-color: rgba(var(--theme-color-rgb, 255, 204, 51), 0.55);
      }
      .aria-dialog-btn.primary:hover { background: rgba(var(--theme-color-rgb, 255, 204, 51), 0.34); }
      .aria-dialog-btn.danger { background: rgba(255, 82, 82, 0.18); border-color: rgba(255, 82, 82, 0.6); }
      .aria-dialog-btn.danger:hover { background: rgba(255, 82, 82, 0.3); }
    `;
    document.head.appendChild(st);
  }

  function openDialog({ title, desc, okText = '确定', cancelText, danger = false, escClose = true }) {
    const overlay = document.createElement('div');
    overlay.className = 'aria-dialog-overlay';
    overlay.innerHTML = `
      <div class="aria-dialog">
        ${title ? `<div class="aria-dialog-title"></div>` : ''}
        <div class="aria-dialog-desc"></div>
        <div class="aria-dialog-actions"></div>
      </div>`;
    if (title) overlay.querySelector('.aria-dialog-title').textContent = title;
    overlay.querySelector('.aria-dialog-desc').textContent = desc || '';
    const actions = overlay.querySelector('.aria-dialog-actions');
    if (cancelText !== undefined) {
      const cancel = document.createElement('button');
      cancel.className = 'aria-dialog-btn';
      cancel.textContent = cancelText;
      actions.appendChild(cancel);
      cancel.addEventListener('click', () => close(false));
    }
    const ok = document.createElement('button');
    ok.className = 'aria-dialog-btn primary' + (danger ? ' danger' : '');
    ok.textContent = okText;
    actions.appendChild(ok);

    let settled = false;
    function close(result) {
      if (settled) return;
      settled = true;
      overlay.remove();
      if (onDone) onDone(result);
      if (overlay._escHandler) document.removeEventListener('keydown', overlay._escHandler, true);
    }
    let onDone = null;
    ok.addEventListener('click', () => close(true));
    if (escClose) {
      overlay._escHandler = (e) => { if (e.key === 'Escape') close(false); };
      document.addEventListener('keydown', overlay._escHandler, true);
    }
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    document.body.appendChild(overlay);
    return {
      close,
      then(fn) { onDone = fn; return this; },
    };
  }

  window.showGlassAlert = function (opts = {}) {
    openDialog({ title: opts.title, desc: opts.desc, okText: opts.okText || '确定', cancelText: undefined, danger: opts.danger });
  };

  window.showGlassConfirm = function (opts = {}) {
    return new Promise((resolve) => {
      openDialog({
        title: opts.title,
        desc: opts.desc,
        okText: opts.okText || '确定',
        cancelText: opts.cancelText !== undefined ? opts.cancelText : '取消',
        danger: opts.danger,
        escClose: true,
      }).then(resolve);
    });
  };
})();