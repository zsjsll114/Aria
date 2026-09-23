/**
 * core/fadeController.js — 音量淡入淡出控制
 * 使用 requestAnimationFrame 实现平滑音量过渡
 * 淡出→切歌→淡入 的完整流程
 */
import { state } from '../infrastructure/state.js';
import { dom } from '../infrastructure/dom.js';

/**
 * 淡出当前音量到 0
 * @param {number} duration - 淡出时长（ms）
 * @param {Function} callback - 淡出完成回调
 */
export function fadeOutVolume(duration, callback) {
    const audio = dom.audio;

    /* 取消之前的淡出动画 */
    if (state.fadeOutVolumeRafId) {
        cancelAnimationFrame(state.fadeOutVolumeRafId);
        state.fadeOutVolumeRafId = null;
    }
    /* 取消正在进行的淡入动画，避免两者竞争 */
    if (state.fadeInVolumeRafId) {
        cancelAnimationFrame(state.fadeInVolumeRafId);
        state.fadeInVolumeRafId = null;
    }
    if (state.fadeOutVolumeTimeoutId) { clearTimeout(state.fadeOutVolumeTimeoutId); state.fadeOutVolumeTimeoutId = null; }

    if (!state.appSettings.playback.fadeInOut) { if (callback) callback(); return; }

    const startVol = audio.volume;
    const startTime = performance.now();

    function step(now) {
        const t = Math.min(1, (now - startTime) / duration);
        audio.volume = startVol * (1 - t);
        if (t < 1) {
            state.fadeOutVolumeRafId = requestAnimationFrame(step);
        } else {
            state.fadeOutVolumeRafId = null;
            if (state.fadeOutVolumeTimeoutId) { clearTimeout(state.fadeOutVolumeTimeoutId); state.fadeOutVolumeTimeoutId = null; }
            if (callback) callback();
        }
    }
    state.fadeOutVolumeRafId = requestAnimationFrame(step);

    /* setTimeout 兜底：确保即使 RAF 未触发，回调也能执行 */
    state.fadeOutVolumeTimeoutId = setTimeout(() => {
        state.fadeOutVolumeTimeoutId = null;
        if (state.fadeOutVolumeRafId) {
            cancelAnimationFrame(state.fadeOutVolumeRafId);
            state.fadeOutVolumeRafId = null;
            audio.volume = 0;
            if (callback) callback();
        }
    }, duration + 100);
}

/**
 * 淡入音量到目标值
 * @param {number} targetVol - 目标音量（0-1）
 * @param {number} duration - 淡入时长（ms）
 */
export function fadeInVolume(targetVol, duration) {
    const audio = dom.audio;

    /* 取消之前的淡入动画 */
    if (state.fadeInVolumeRafId) {
        cancelAnimationFrame(state.fadeInVolumeRafId);
        state.fadeInVolumeRafId = null;
    }
    /* 取消正在进行的淡出动画，避免竞争导致音量卡在 0 */
    if (state.fadeOutVolumeRafId) {
        cancelAnimationFrame(state.fadeOutVolumeRafId);
        state.fadeOutVolumeRafId = null;
    }
    if (state.fadeOutVolumeTimeoutId) { clearTimeout(state.fadeOutVolumeTimeoutId); state.fadeOutVolumeTimeoutId = null; }
    if (state.fadeInVolumeTimeoutId) { clearTimeout(state.fadeInVolumeTimeoutId); state.fadeInVolumeTimeoutId = null; }

    if (!state.appSettings.playback.fadeInOut) {
        audio.volume = targetVol;
        return;
    }

    /* 如果目标音量大于0，不要从0开始，而是从当前音量平滑过渡 */
    const startVol = audio.volume > 0 ? audio.volume : 0;
    const startTime = performance.now();

    function step(now) {
        const t = Math.min(1, (now - startTime) / duration);
        audio.volume = startVol + (targetVol - startVol) * t;
        if (t < 1) {
            state.fadeInVolumeRafId = requestAnimationFrame(step);
        } else {
            audio.volume = targetVol;
            state.fadeInVolumeRafId = null;
            if (state.fadeInVolumeTimeoutId) { clearTimeout(state.fadeInVolumeTimeoutId); state.fadeInVolumeTimeoutId = null; }
        }
    }
    state.fadeInVolumeRafId = requestAnimationFrame(step);

    /* setTimeout 兜底：确保即使 RAF 未触发（如标签页后台），音量也能恢复到目标值 */
    state.fadeInVolumeTimeoutId = setTimeout(() => {
        state.fadeInVolumeTimeoutId = null;
        if (state.fadeInVolumeRafId) {
            cancelAnimationFrame(state.fadeInVolumeRafId);
            state.fadeInVolumeRafId = null;
            audio.volume = targetVol;
        }
    }, duration + 100);
}

/** 取消所有正在进行的淡入淡出动画 */
export function cancelAllFades() {
    if (state.fadeOutVolumeRafId) { cancelAnimationFrame(state.fadeOutVolumeRafId); state.fadeOutVolumeRafId = null; }
    if (state.fadeInVolumeRafId) { cancelAnimationFrame(state.fadeInVolumeRafId); state.fadeInVolumeRafId = null; }
    if (state.fadeOutVolumeTimeoutId) { clearTimeout(state.fadeOutVolumeTimeoutId); state.fadeOutVolumeTimeoutId = null; }
    if (state.fadeInVolumeTimeoutId) { clearTimeout(state.fadeInVolumeTimeoutId); state.fadeInVolumeTimeoutId = null; }
}
