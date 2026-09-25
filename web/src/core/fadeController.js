/* ============================================================
 * core/fadeController.js — 音量淡入淡出（core 层接管第 2 个模块，2026-09-25）
 *
 * 来历：本文件原先是「没接线的目标架构快照」，逻辑比 app/135-crossfade.js 的活实现少了一截：
 *   · 活实现双向取消（淡入会取消在途淡出，反之亦然），避免竞争把音量卡在 0；
 *   · 活实现除 rAF 外还挂一个 setTimeout 兜底（淡出 duration+100ms / 淡入 +50ms），
 *     因为标签页在后台时 rAF 被节流，没有兜底音量就永远回不来；
 *   · 淡入采用正弦缓动、时长上限 1000ms、起始音量压到 targetVol*0.35，
 *     对应「人耳对低音量对数不敏感，前 1~3 秒听不到声音」这个实测问题。
 * 所以接管动作是**从活实现重新抽取**，不是接线旧快照。以下逻辑逐行来自 135-crossfade.js。
 *
 * 依赖注入：audio 元素由 initFadeController 注入。core 不 import app/* 的模块（避免层级反向
 * 依赖，也顺手断掉 70-audio-engine → 135-crossfade 那条循环边）。
 * 状态：四个 rAF/timeout 句柄存在 infrastructure/state.js，本模块是它们唯一的读写方，
 * 因此这四个键已从 globalThis 桥接面（globalBridge.BRIDGED）里移除。
 * ============================================================ */
import { state } from '../infrastructure/state.js';
import { logWarn } from '../services/log.js';

let _audio = null;

/** 注入 audio 元素。必须在任何淡入淡出被调用前执行一次。 */
export function initFadeController(audio) {
    _audio = audio || null;
}

function clamp01(v) {
    return Math.max(0, Math.min(1, v));
}

/* 未注入元素时不静默失败：直接设到目标音量并留痕（淡变只是观感优化，不该因此卡住播放链路） */
function bypass(target, reason) {
    if (_audio) _audio.volume = clamp01(target);
    logWarn('fadeController', `未初始化 audio 元素，淡变已跳过（${reason}）`);
}

function cancelFadeTimers() {
    if (state.fadeOutVolumeRafId) { cancelAnimationFrame(state.fadeOutVolumeRafId); state.fadeOutVolumeRafId = null; }
    if (state.fadeInVolumeRafId) { cancelAnimationFrame(state.fadeInVolumeRafId); state.fadeInVolumeRafId = null; }
    if (state.fadeOutVolumeTimeoutId) { clearTimeout(state.fadeOutVolumeTimeoutId); state.fadeOutVolumeTimeoutId = null; }
    if (state.fadeInVolumeTimeoutId) { clearTimeout(state.fadeInVolumeTimeoutId); state.fadeInVolumeTimeoutId = null; }
}

/**
 * 淡出到 0，结束后回调。
 * @param {number} duration 毫秒
 * @param {Function} [callback]
 */
export function fadeOutVolume(duration, callback) {
    if (!_audio) { if (callback) callback(); return bypass(0, 'fadeOut'); }
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
    if (!state.appSettings || !state.appSettings.playback.fadeInOut) { if (callback) callback(); return; }
    const startVol = _audio.volume;
    const startTime = performance.now();
    function step(now) {
        const t = Math.min(1, (now - startTime) / duration);
        _audio.volume = clamp01(startVol * (1 - t));
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
            _audio.volume = 0;
            if (callback) callback();
        }
    }, duration + 100);
}

/**
 * 淡入到目标音量。
 * @param {number} targetVol 0~1 的实际音量（对数/增益换算由调用方负责）
 * @param {number} duration 毫秒
 */
export function fadeInVolume(targetVol, duration) {
    if (!_audio) return bypass(targetVol, 'fadeIn');
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
    if (!state.appSettings || !state.appSettings.playback.fadeInOut || !duration || duration <= 0) {
        _audio.volume = clamp01(targetVol);
        return;
    }
    /* 采用平滑正弦曲线并限制淡入上限，避免人耳对低音量的对数不敏感导致前1~3秒听不到声音 */
    const effectiveDuration = Math.min(duration, 1000);
    const startVol = Math.min(_audio.volume, targetVol * 0.35);
    const startTime = performance.now();
    function step(now) {
        const linearT = Math.min(1, (now - startTime) / effectiveDuration);
        const easeT = Math.sin(linearT * Math.PI / 2);
        _audio.volume = clamp01(startVol + (targetVol - startVol) * easeT);
        if (linearT < 1) {
            state.fadeInVolumeRafId = requestAnimationFrame(step);
        } else {
            _audio.volume = clamp01(targetVol);
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
            _audio.volume = clamp01(targetVol);
        }
    }, effectiveDuration + 50);
}

/** 放弃所有在途淡变（切歌/停止时调用，句柄全部归零） */
export function cancelAllFades() {
    cancelFadeTimers();
}
