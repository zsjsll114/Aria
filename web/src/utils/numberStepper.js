/* ============================================================
 * utils/numberStepper.js — 数字输入框的自定义 ± 步进器
 *
 * 为什么不用原生 `<input type=number>` 的上下箭头：那是 UA 影子节点，
 * 只有 `-webkit-appearance:none` 能关掉，关掉之后又不能自己画一个——
 * 所以步进按钮必须是真实 DOM，配合 .num-stepper 这套壳层样式。
 *
 * 机制而非逐处补丁：任何 `input[type=number]` 只要外层套 .num-stepper、
 * 按钮带 data-num-step，就自动生效（委托在 document 上，新增输入框不必再写 JS）。
 * ============================================================ */
import { logCatch } from '../services/log.js';

const TAG = 'numberStepper';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 一次 ±：按 min/max/step 收口，并补发 input+change 让既有监听照常收到 */
export function stepNumberInput(input, direction) {
    if (!input || input.type !== 'number') return;
    const step = Number(input.step) || 1;
    const lo = input.min === '' ? -Infinity : Number(input.min);
    const hi = input.max === '' ? Infinity : Number(input.max);
    const cur = input.value === '' ? NaN : Number(input.value);
    /* 空框或脏值时从 0 起步（再被 clamp 进 [min,max]），而不是 NaN±1 写回一个 NaN */
    const base = Number.isFinite(cur) ? cur : 0;
    /* 乘 1e6 再取整：0.1 这类 step 直接相加会漂出 0.30000000000000004 */
    const next = clamp(Math.round((base + step * Number(direction)) * 1e6) / 1e6, lo, hi);
    input.value = String(next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

let _bound = false;

/** 在 document 上装一次全局委托（幂等） */
export function bindNumberSteppers() {
    if (_bound || typeof document === 'undefined') return;
    _bound = true;
    document.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('[data-num-step]') : null;
        if (!btn) return;
        try {
            const host = btn.closest('.num-stepper');
            const input = host && host.querySelector('input[type="number"]');
            if (!input) return;
            e.preventDefault();
            stepNumberInput(input, Number(btn.dataset.numStep) > 0 ? 1 : -1);
        } catch (err) {
            logCatch(TAG, err);
        }
    });
}

if (typeof document !== 'undefined') bindNumberSteppers();
