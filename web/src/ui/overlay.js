/* ============================================================
 * ui/overlay.js — Aria 浮层契约内核（P3-a）
 *
 * 为什么要有这个文件（P3 调研实测）：
 *   · 全仓 36 个浮层，只有 1 个共享工厂（021）；258 又把 showGlassPrompt
 *     同名覆盖了一遍 —— 因为 258 的版本不返回 Promise，200-settings-panel.js
 *     的 `await window.showGlassPrompt(...)` 拿到的是一个 DOM 元素，
 *     applyAutoEqText 收到 "[object HTMLDivElement]"，AutoEQ 导入静默失效。
 *   · ESC 处理散在 24 个分片各自 addEventListener('keydown')；
 *   · role="dialog" 覆盖率 4/36，焦点陷阱 0 处，焦点归还 0 处；
 *   · z-index 是各写各的魔数（2400 / 2100 / 10001）。
 * 本模块把"打开/关闭一个模态"的行为契约收成一份实现，供所有浮层复用。
 *
 * ★ 公开契约（外观 mod 与其它分片可依赖；改名 = 破坏兼容）
 *   类名  .aria-modal-backdrop   全屏容器（遮罩 + 居中）
 *   类名  .aria-modal-shell      内部面板（键盘导航锚点 / 焦点查询范围）
 *   令牌  --aria-z-modal         对话框层级（容器整体 z-index）
 *   API   openOverlay(el, opts) → handle { el, shell, close(result) }
 *         closeOverlay(el, result)
 *         topOverlay() / overlayDepth() / isOverlayOpen(el)
 *
 * ★ 故意不做「背景滚动锁」——别照其它项目抄。
 *   本项目 base.css 的 `html, body { width:100%; height:100%; overflow:hidden }`
 *   让主窗根本不滚，滚动都发生在各浮层内部的列表容器里
 *   （.search-results-list / .settings-body / .playlist-drawer-body…）。
 *   锁 body 会是一条永不生效的死规则。将来若某个浮层自身需要锁，
 *   请锁它自己的滚动容器，而不是往这里加一个全局锁。
 * ============================================================ */

import { logCatch } from '../services/log.js';

/** 打开中的浮层栈；栈顶优先接收 ESC */
const stack = [];

/** 可聚焦元素选择器（键盘陷阱用） */
const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'textarea:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(', ');

function readZToken(name, fallback) {
    if (typeof document === 'undefined') return fallback;
    try {
        const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return v || fallback;
    } catch (e) {
        logCatch('overlay', e);
        return fallback;
    }
}

function focusableIn(root) {
    if (!root || typeof getComputedStyle !== 'function') return [];
    return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => {
        if (el.hasAttribute('hidden')) return false;
        if (el.getAttribute('aria-hidden') === 'true') return false;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden';
    });
}

export function overlayDepth() {
    return stack.length;
}

export function topOverlay() {
    return stack.length ? stack[stack.length - 1] : null;
}

export function isOverlayOpen(el) {
    return stack.some((e) => e.el === el);
}

/* Tab 焦点陷阱：只在 shell 内部循环，不让焦点跑到背后的页面上 */
function trapTab(e, shell) {
    const list = focusableIn(shell);
    if (list.length === 0) {
        e.preventDefault();
        return;
    }
    const first = list[0];
    const last = list[list.length - 1];
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const inside = active && shell.contains(active);
    if (e.shiftKey) {
        if (!inside || active === first) { e.preventDefault(); last.focus(); }
    } else if (!inside || active === last) {
        e.preventDefault();
        first.focus();
    }
}

/**
 * 打开一个模态浮层。
 * @param {HTMLElement} el 全屏容器（遮罩）
 * @param {object} [opts]
 * @param {string} [opts.shell='.aria-modal-shell'] 面板选择器
 * @param {string} [opts.labelledBy] 作为标题的元素选择器（会挂 aria-labelledby）
 * @param {string} [opts.label] 无标题时的 aria-label
 * @param {boolean} [opts.escClose=true]
 * @param {boolean} [opts.backdropClose=true]
 * @param {*} [opts.cancelResult=null] ESC / 点遮罩触发关闭时传给 onClose 的结果
 * @param {boolean} [opts.removeOnClose=true] 关闭时是否从 DOM 移除
 * @param {Function} [opts.onClose] 唯一结算点，只调用一次
 * @returns {{el:HTMLElement, shell:HTMLElement, close:Function}|null}
 */
export function openOverlay(el, opts = {}) {
    if (!el || typeof document === 'undefined') return null;
    const existing = stack.find((e) => e.el === el);
    if (existing) return existing.handle;

    const shell = (opts.shell && el.querySelector(opts.shell)) || opts.shellEl || el;
    const entry = {
        el,
        shell,
        opts,
        prevFocus: document.activeElement,
        escClose: opts.escClose !== false,
        backdropClose: opts.backdropClose !== false,
        cancelResult: opts.cancelResult === undefined ? null : opts.cancelResult,
        onClose: typeof opts.onClose === 'function' ? opts.onClose : null,
        settled: false,
        handle: null,
    };

    el.classList.add('aria-modal-backdrop');
    shell.classList.add('aria-modal-shell');
    /* 层级：容器整体取「对话框档」（默认 --aria-z-modal = 12000）。
       必须排在 panel 档（.settings-overlay / .ctx-menu = 10000）之上——
       旧实现写死 2400/2100，从设置面板里弹出的对话框会被面板整个盖住，
       用户以为"点了没反应"。shell 不再单独设 z（同容器内无比较意义）。 */
    el.style.zIndex = readZToken(opts.zToken || '--aria-z-modal', '12000');

    /* ★ 可访问性：所有模态一律带 dialog 语义（此前 4/36） */
    if (!shell.hasAttribute('role')) shell.setAttribute('role', 'dialog');
    if (!shell.hasAttribute('aria-modal')) shell.setAttribute('aria-modal', 'true');
    if (opts.labelledBy) {
        const t = el.querySelector(opts.labelledBy);
        if (t) {
            if (!t.id) t.id = 'aria-modal-title-' + (stack.length + 1) + '-' + Date.now().toString(36);
            shell.setAttribute('aria-labelledby', t.id);
        }
    } else if (opts.label) {
        shell.setAttribute('aria-label', opts.label);
    }

    entry.onKeydown = (e) => {
        /* 只响应最顶层：嵌套浮层时 ESC 关的是最上面那个 */
        if (topOverlay() !== entry) return;
        if (e.key === 'Escape' && entry.escClose) {
            e.preventDefault();
            e.stopPropagation();
            entry.handle.close(entry.cancelResult);
            return;
        }
        if (e.key === 'Tab') trapTab(e, shell);
    };
    entry.onBackdropClick = (e) => {
        if (topOverlay() !== entry) return;
        if (entry.backdropClose && e.target === el) entry.handle.close(entry.cancelResult);
    };

    entry.handle = { el, shell, close: (result) => closeOverlay(el, result) };
    stack.push(entry);

    document.addEventListener('keydown', entry.onKeydown, true);
    el.addEventListener('click', entry.onBackdropClick);

    /* 焦点移入：优先 [data-autofocus]，其次第一个可聚焦元素，最后 shell 自身 */
    requestAnimationFrame(() => {
        if (!isOverlayOpen(el)) return;
        const first = shell.querySelector('[data-autofocus]') || focusableIn(shell)[0];
        if (first && typeof first.focus === 'function') {
            first.focus();
            if (opts.selectOnFocus && typeof first.select === 'function') first.select();
        } else {
            shell.setAttribute('tabindex', '-1');
            shell.focus();
        }
    });

    return entry.handle;
}

/**
 * 关闭浮层。幂等：重复调用只生效一次。
 * onClose 是唯一结算点（Promise 的 resolve 都挂在它上面）。
 */
export function closeOverlay(el, result) {
    const idx = stack.findIndex((e) => e.el === el);
    if (idx < 0) return false;
    const entry = stack[idx];
    if (entry.settled) return false;
    entry.settled = true;
    stack.splice(idx, 1);

    document.removeEventListener('keydown', entry.onKeydown, true);
    el.removeEventListener('click', entry.onBackdropClick);
    el.classList.remove('aria-modal-backdrop');
    if (entry.opts.removeOnClose !== false && el.parentNode) el.parentNode.removeChild(el);

    /* 焦点归还：回到打开前的元素（若它还在文档里还能聚焦） */
    const back = entry.prevFocus;
    if (back && typeof back.focus === 'function' && document.contains(back)) {
        try {
            back.focus();
        } catch (e) {
            /* 元素可能已不可聚焦（被禁用/移除中），归还失败无需打扰用户 */
            logCatch('overlay', e);
        }
    }

    if (entry.onClose) entry.onClose(result === undefined ? null : result);
    return true;
}
