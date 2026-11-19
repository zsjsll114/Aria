/* ============================================================
 * core/progressPreview.js — 播放进度条悬停时间预览与百分比计算
 *
 * 为主进度条 (#progressTrack) 与底部浮层进度条 (#bottomProgressTrack)
 * 提供统一的坐标归一化、边界夹紧与轻量时间戳浮层，避免两处重复实现。
 * ============================================================ */
import { formatTime } from '../utils/formatters.js';

/**
 * 将指针横坐标映射为进度条 [0, 1] 比例。
 * @param {number} clientX
 * @param {{ left: number, width: number } | null | undefined} rect
 * @returns {number}
 */
export function calcProgressPercent(clientX, rect) {
    if (!rect || !Number.isFinite(rect.width) || rect.width <= 0 || !Number.isFinite(clientX)) {
        return 0;
    }
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
}

/**
 * 根据指针位置与总时长（ms）计算目标时间点（ms）。
 * @param {number} clientX
 * @param {{ left: number, width: number } | null | undefined} rect
 * @param {number} durationMs
 * @returns {number}
 */
export function calcPreviewTimestampMs(clientX, rect, durationMs) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
    return calcProgressPercent(clientX, rect) * durationMs;
}

/**
 * 计算悬浮提示在视口内的安全水平坐标，避免靠近左右边缘时被裁剪。
 * @param {number} clientX
 * @param {number} viewportWidth
 * @param {number} [margin=32]
 * @returns {number}
 */
export function calcTooltipLeft(clientX, viewportWidth, margin = 32) {
    const x = Number.isFinite(clientX) ? clientX : 0;
    if (!Number.isFinite(viewportWidth) || viewportWidth <= margin * 2) return x;
    return Math.min(viewportWidth - margin, Math.max(margin, x));
}

/** @type {HTMLElement | null} */
let _progressTip = null;
/** @type {HTMLElement | null} */
let _activeHoverTrack = null;

function ensureProgressTip() {
    if (typeof document === 'undefined' || !document.body) return null;
    if (_progressTip && document.body.contains(_progressTip)) return _progressTip;
    const tip = document.createElement('div');
    tip.id = 'progressTimeTip';
    tip.setAttribute('role', 'status');
    tip.setAttribute('aria-hidden', 'true');
    tip.style.cssText = [
        'position:fixed;z-index:2147483645;pointer-events:none;white-space:nowrap;',
        'background:rgba(0,0,0,0.86);color:#fff;font-size:11px;font-weight:600;line-height:1;',
        'font-family:"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;',
        'font-variant-numeric:tabular-nums;',
        'padding:6px 10px;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,0.35);',
        'border:1px solid rgba(255,255,255,0.12);opacity:0;visibility:hidden;',
        'transition:opacity 0.14s ease,visibility 0.14s ease;transform:translate(-50%,-100%);',
    ].join('');
    document.body.appendChild(tip);
    _progressTip = tip;
    return tip;
}

/**
 * 在指定进度条上方显示目标时间预览。
 * @param {HTMLElement | null} trackEl
 * @param {number} clientX
 * @param {number} durationMs
 */
export function showProgressTimeTip(trackEl, clientX, durationMs) {
    if (!trackEl || !Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(clientX)) {
        hideProgressTimeTip();
        return;
    }
    const tip = ensureProgressTip();
    if (!tip) return;
    const rect = trackEl.getBoundingClientRect();
    if (!rect || rect.width <= 0) {
        hideProgressTimeTip();
        return;
    }
    const targetMs = calcPreviewTimestampMs(clientX, rect, durationMs);
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1920;
    const left = calcTooltipLeft(clientX, vw, 32);
    tip.textContent = formatTime(targetMs);
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(28, rect.top - 10)}px`;
    tip.style.opacity = '1';
    tip.style.visibility = 'visible';
}

/** 隐藏进度时间预览浮层。 */
export function hideProgressTimeTip() {
    _activeHoverTrack = null;
    if (_progressTip) {
        _progressTip.style.opacity = '0';
        _progressTip.style.visibility = 'hidden';
    }
}

/**
 * 为进度条绑定鼠标悬停时间预览。
 * @param {HTMLElement | null | undefined} trackEl
 * @param {() => number} getDurationMs
 * @param {() => boolean} [shouldSuppress]
 */
export function bindProgressHoverTip(trackEl, getDurationMs, shouldSuppress) {
    if (!trackEl || typeof trackEl.addEventListener !== 'function') return;
    trackEl.addEventListener('mousemove', (e) => {
        if (shouldSuppress && shouldSuppress()) {
            hideProgressTimeTip();
            return;
        }
        const dur = Number(getDurationMs ? getDurationMs() : 0);
        if (!Number.isFinite(dur) || dur <= 0) {
            hideProgressTimeTip();
            return;
        }
        _activeHoverTrack = trackEl;
        showProgressTimeTip(trackEl, e.clientX, dur);
    });
    trackEl.addEventListener('mouseleave', () => {
        if (_activeHoverTrack === trackEl) hideProgressTimeTip();
    });
}
