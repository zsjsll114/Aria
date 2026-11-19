/**
 * ui/settingsPrimitives.js — 设置面板唯一 UI 原语工厂
 *
 * 统一承载自定义下拉、开关、滑块、分段按钮组与密钥显隐输入控件，
 * 替代分散在 200/202/215/220/296 中的 5 套下拉实现与多份回显补丁。
 */
import { logCatch } from '../services/log.js';

const TAG = 'settingsUI';
let _docCloseBound = false;
/** @type {WeakSet<Element>} */
const _toggleBound = new WeakSet();
/** @type {WeakSet<Element>} */
const _primitiveBound = new WeakSet();
/** @type {WeakSet<Element>} */
const _secretBound = new WeakSet();

/**
 * 关闭除 exceptDd 外全部处于打开态的设置下拉菜单
 * @param {HTMLElement|null} [exceptDd]
 */
export function closeAllDropdowns(exceptDd = null) {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('.setting-dropdown.open').forEach((d) => {
        if (d !== exceptDd) d.classList.remove('open');
    });
}

/**
 * 幂等绑定全局点击空白与 Escape 键关闭下拉菜单。
 * 无论 220 设置面板初始化或 296 音频输出先行渲染，均共享同一套全局监听。
 */
export function ensureDropdownDocClose() {
    if (_docCloseBound || typeof document === 'undefined') return;
    _docCloseBound = true;
    document.addEventListener('click', () => closeAllDropdowns(null));
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeAllDropdowns(null);
    });
}

/**
 * 幂等绑定下拉触发器的开合事件（标记 `_ariaToggleBound` 防止重复正反抵消）。
 * @param {HTMLElement} dd
 * @param {HTMLElement|null} trigger
 * @returns {HTMLElement|null}
 */
export function bindDropdownToggle(dd, trigger) {
    if (!dd || !trigger) return trigger || null;
    ensureDropdownDocClose();
    if (!_toggleBound.has(trigger)) {
        _toggleBound.add(trigger);
        if (!trigger.hasAttribute('tabindex')) trigger.tabIndex = 0;
        if (!trigger.hasAttribute('role')) trigger.setAttribute('role', 'button');
        const toggleOpen = (/** @type {Event} */ e) => {
            e.stopPropagation();
            const willOpen = !dd.classList.contains('open');
            closeAllDropdowns(dd);
            dd.classList.toggle('open', willOpen);
            trigger.setAttribute('aria-expanded', String(willOpen));
        };
        trigger.addEventListener('click', toggleOpen);
        trigger.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleOpen(e);
            }
        });
    }
    return trigger;
}

/**
 * 确保下拉容器具备 `.setting-dropdown-trigger` 与 `.setting-dropdown-menu` 壳层并绑定开合。
 * @param {HTMLElement} dd
 * @returns {{ trigger: HTMLElement, menu: HTMLElement }|null}
 */
export function ensureDropdownShell(dd) {
    if (!dd || typeof document === 'undefined') return null;
    let trigger = /** @type {HTMLElement|null} */ (dd.querySelector('.setting-dropdown-trigger'));
    if (!trigger) {
        trigger = document.createElement('div');
        trigger.className = 'setting-dropdown-trigger';
        dd.appendChild(trigger);
    }
    bindDropdownToggle(dd, trigger);

    let menu = /** @type {HTMLElement|null} */ (dd.querySelector('.setting-dropdown-menu'));
    if (!menu) {
        menu = document.createElement('div');
        menu.className = 'setting-dropdown-menu';
        dd.appendChild(menu);
    }
    return { trigger, menu };
}

/**
 * 向指定 `.setting-dropdown` 渲染或增量更新选项列表。
 * 全程采用 `createElement` + `textContent`，杜绝非转义 HTML 拼串。
 * @param {HTMLElement} dd
 * @param {Array<{value:string, label:string, [k:string]:any}>} options
 * @param {string|number} currentVal
 * @param {object} [opts]
 * @param {(opt:any, info:{dd:HTMLElement, trigger:HTMLElement, menu:HTMLElement, item:HTMLElement})=>void} [opts.onSelect]
 * @param {(opt:any, item:HTMLElement)=>void} [opts.decorateItem]
 * @param {(opt:any, trigger:HTMLElement)=>void} [opts.decorateTrigger]
 * @param {string} [opts.placeholder]
 * @param {boolean} [opts.fallbackFirst=true]
 */
export function mountDropdown(dd, options, currentVal, opts = {}) {
    const shell = ensureDropdownShell(dd);
    if (!shell) return null;
    const { trigger, menu } = shell;
    const fallbackFirst = opts.fallbackFirst !== false;
    const valStr = currentVal == null ? '' : String(currentVal);

    menu.textContent = '';
    let matchedOpt = null;
    options.forEach((opt) => {
        const optVal = String(opt.value);
        const isSel = optVal === valStr;
        if (isSel) matchedOpt = opt;

        const item = document.createElement('div');
        item.className = 'setting-dropdown-item' + (isSel ? ' selected' : '');
        item.textContent = opt.label;
        item.dataset.value = optVal;
        if (typeof opts.decorateItem === 'function') {
            try { opts.decorateItem(opt, item); } catch (e) { logCatch(TAG, e); }
        }
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.querySelectorAll('.setting-dropdown-item').forEach((n) => n.classList.remove('selected'));
            item.classList.add('selected');
            trigger.textContent = opt.label;
            trigger.dataset.value = optVal;
            if (typeof opts.decorateTrigger === 'function') {
                try { opts.decorateTrigger(opt, trigger); } catch (err) { logCatch(TAG, err); }
            }
            dd.classList.remove('open');
            trigger.setAttribute('aria-expanded', 'false');
            if (typeof opts.onSelect === 'function') {
                opts.onSelect(opt, { dd, trigger, menu, item });
            }
        });
        menu.appendChild(item);
    });

    const activeOpt = matchedOpt || (fallbackFirst ? options[0] : null);
    trigger.textContent = activeOpt ? activeOpt.label : (opts.placeholder ?? '');
    trigger.dataset.value = activeOpt ? String(activeOpt.value) : '';
    if (typeof opts.decorateTrigger === 'function') {
        try { opts.decorateTrigger(activeOpt, trigger); } catch (e) { logCatch(TAG, e); }
    }
    return shell;
}

/**
 * 仅同步已有 `.setting-dropdown` 选中态与 trigger 文案（不重建项 DOM）。
 * @param {HTMLElement} dd
 * @param {*} currentVal
 * @param {Array<{value:string, label:string}>|null} [options]
 * @param {{ fallbackFirst?: boolean }} [opts]
 * @returns {boolean} 是否命中有效选项
 */
export function syncDropdownSelection(dd, currentVal, options = null, opts = {}) {
    if (!dd) return false;
    const trigger = /** @type {HTMLElement|null} */ (dd.querySelector('.setting-dropdown-trigger'));
    const items = /** @type {HTMLElement[]} */ (Array.from(dd.querySelectorAll('.setting-dropdown-item')));
    const valStr = currentVal == null ? '' : String(currentVal);

    let hitItem = items.find((i) => String(i.dataset.value) === valStr) || null;
    if (!hitItem && opts.fallbackFirst && items.length > 0) hitItem = items[0] || null;

    if (items.length > 0) {
        items.forEach((i) => i.classList.toggle('selected', i === hitItem));
        if (trigger && hitItem) {
            trigger.textContent = hitItem.textContent;
            trigger.dataset.value = hitItem.dataset.value || '';
            return true;
        }
        return false;
    }

    if (Array.isArray(options) && trigger) {
        const hitOpt = options.find((o) => String(o.value) === valStr) || (opts.fallbackFirst ? options[0] : null);
        if (hitOpt) {
            trigger.textContent = hitOpt.label;
            trigger.dataset.value = String(hitOpt.value);
            return true;
        }
    }
    return false;
}

/**
 * 同步 `.setting-toggle` 状态。
 * @param {HTMLElement|null} btn
 * @param {boolean} on
 */
export function syncToggle(btn, on) {
    if (!btn) return;
    btn.classList.toggle('on', !!on);
}

/**
 * 幂等绑定 `.setting-toggle` 点击切换（带防重标记）。
 * @param {HTMLElement|null} btn
 * @param {boolean} initial
 * @param {(next:boolean, btn:HTMLElement)=>void} onChange
 */
export function mountToggle(btn, initial, onChange) {
    if (!btn) return;
    syncToggle(btn, initial);
    if (_primitiveBound.has(btn)) return;
    _primitiveBound.add(btn);
    btn.addEventListener('click', () => {
        btn.classList.toggle('on');
        const next = btn.classList.contains('on');
        if (typeof onChange === 'function') onChange(next, btn);
    });
}

/**
 * 同步滑块与其数值显示标签。
 * @param {HTMLInputElement|null} input
 * @param {HTMLElement|null} valEl
 * @param {number|string} value
 * @param {(v:number|string)=>string} [format]
 */
export function syncSlider(input, valEl, value, format) {
    if (input && value !== undefined && value !== null) {
        input.value = String(value);
    }
    if (valEl && value !== undefined && value !== null) {
        valEl.textContent = typeof format === 'function' ? format(value) : String(value);
    }
}

/**
 * 幂等绑定滑块事件与即时显示。
 * @param {HTMLInputElement|null} input
 * @param {HTMLElement|null} valEl
 * @param {number|string} initial
 * @param {object} [opts]
 * @param {(v:string)=>any} [opts.parse]
 * @param {(v:any)=>string} [opts.format]
 * @param {(v:any, raw:string)=>void} [opts.onInput]
 */
export function mountSlider(input, valEl, initial, opts = {}) {
    if (!input) return;
    const parse = opts.parse || ((s) => s);
    const format = opts.format || ((v) => String(v));
    if (initial !== undefined && initial !== null) {
        syncSlider(input, valEl, initial, format);
    }
    if (_primitiveBound.has(input)) return;
    _primitiveBound.add(input);
    input.addEventListener('input', () => {
        const parsed = parse(input.value);
        if (valEl) valEl.textContent = format(parsed);
        if (typeof opts.onInput === 'function') opts.onInput(parsed, input.value);
    });
}

/**
 * 同步分段按钮组激活状态。
 * @param {HTMLElement|null} group
 * @param {*} value
 * @param {{ fallbackFirst?: boolean }} [opts]
 */
export function syncSegmented(group, value, opts = {}) {
    if (!group) return;
    const btns = /** @type {HTMLElement[]} */ (Array.from(group.querySelectorAll('.setting-btn')));
    const valStr = String(value);
    let matched = false;
    btns.forEach((b) => {
        const ok = String(b.dataset.val) === valStr;
        b.classList.toggle('active', ok);
        if (ok) matched = true;
    });
    if (!matched && opts.fallbackFirst && btns.length > 0) {
        btns[0]?.classList.add('active');
    }
}

/**
 * 幂等绑定分段按钮组。
 * @param {HTMLElement|null} group
 * @param {*} initial
 * @param {(val:string, btn:HTMLElement)=>void} onChange
 */
export function mountSegmented(group, initial, onChange) {
    if (!group) return;
    syncSegmented(group, initial);
    const btns = /** @type {HTMLElement[]} */ (Array.from(group.querySelectorAll('.setting-btn')));
    btns.forEach((btn) => {
        if (_primitiveBound.has(btn)) return;
        _primitiveBound.add(btn);
        btn.addEventListener('click', () => {
            btns.forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            if (typeof onChange === 'function') onChange(btn.dataset.val ?? '', btn);
        });
    });
}

const EYE_OPEN_PATHS = [
    { tag: 'path', d: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' },
    { tag: 'circle', cx: '12', cy: '12', r: '3' },
];
const EYE_CLOSED_PATHS = [
    { tag: 'path', d: 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24' },
    { tag: 'line', x1: '1', y1: '1', x2: '23', y2: '23' },
];

/**
 * @param {SVGElement} svgEl
 * @param {boolean} showText
 */
function renderEyeSvg(svgEl, showText) {
    if (!svgEl || typeof document === 'undefined') return;
    const ns = 'http://www.w3.org/2000/svg';
    const specs = showText ? EYE_CLOSED_PATHS : EYE_OPEN_PATHS;
    svgEl.textContent = '';
    specs.forEach((spec) => {
        const node = document.createElementNS(ns, spec.tag);
        for (const [k, v] of Object.entries(spec)) {
            if (k !== 'tag') node.setAttribute(k, v);
        }
        svgEl.appendChild(node);
    });
}

/**
 * 幂等绑定密码/密钥明密文切换按钮。
 * @param {HTMLInputElement|null} inputEl
 * @param {HTMLElement|null} toggleBtn
 * @param {SVGElement|null} [eyeSvg]
 */
export function mountSecretInput(inputEl, toggleBtn, eyeSvg) {
    if (!inputEl || !toggleBtn || _secretBound.has(toggleBtn)) return;
    _secretBound.add(toggleBtn);
    const svg = eyeSvg || toggleBtn.querySelector('svg');
    toggleBtn.addEventListener('click', () => {
        const showText = inputEl.type === 'password';
        inputEl.type = showText ? 'text' : 'password';
        if (svg) renderEyeSvg(svg, showText);
    });
}
