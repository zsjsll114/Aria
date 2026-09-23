/**
 * core/stallDetector.js — 音频卡死检测
 * 通过轮询 currentTime 变化检测音频是否卡顿
 * 卡死时调用回调让上层处理（暂停/重试等）
 */
import { state } from '../infrastructure/state.js';
import { dom } from '../infrastructure/dom.js';
import { logInfo, logWarn, logError } from '../services/log.js';

/**
 * 启动卡死检测
 * @param {Function} onStall - 检测到卡死时的回调
 */
export function startStallCheck(onStall) {
    stopStallCheck();
    state.stallCheckGeneration++;
    const gen = state.stallCheckGeneration;
    const audio = dom.audio;
    state.stallLastTime = audio.currentTime;

    const check = () => {
        if (gen !== state.stallCheckGeneration) return; /* 已过期 */
        if (audio.paused || state.isBuffering) {
            state.stallTimer = setTimeout(check, 8000);
            return;
        }
        if (Math.abs(audio.currentTime - state.stallLastTime) < 0.1) {
            logWarn('stallDetector', '检测到音频卡死（currentTime 8秒未前进），自动停止');
            if (onStall) onStall();
            return;
        }
        state.stallLastTime = audio.currentTime;
        state.stallTimer = setTimeout(check, 8000);
    };
    state.stallTimer = setTimeout(check, 8000);
}

/** 停止卡死检测 */
export function stopStallCheck() {
    state.stallCheckGeneration++;
    if (state.stallTimer) { clearTimeout(state.stallTimer); state.stallTimer = null; }
}

/**
 * 设置缓冲状态
 * @param {boolean} buffering - 是否正在缓冲
 */
export function setBuffering(buffering) {
    state.isBuffering = buffering;
}

/**
 * 初始化音频事件监听器（stalled / waiting / playing）
 * @param {Function} onStall - 卡死/停滞回调
 */
export function initStallEventListeners(onStall) {
    const audio = dom.audio;

    /* 网络停滞：浏览器停止下载数据 */
    audio.addEventListener('stalled', () => {
        logWarn('stallDetector', '音频网络停滞 (stalled)，可能即将停止');
        setTimeout(() => {
            if (!audio.paused && audio.currentTime === state.stallLastTime && audio.readyState < 3) {
                logWarn('stallDetector', '网络停滞后未恢复，停止播放');
                if (onStall) onStall();
            }
        }, 3000);
    });

    /* 缓冲开始：暂停卡死检测 */
    audio.addEventListener('waiting', () => {
        state.isBuffering = true;
        if (state.stallTimer) { clearTimeout(state.stallTimer); state.stallTimer = null; }
    });

    /* 缓冲结束恢复播放：重新启动卡死检测 */
    audio.addEventListener('playing', () => {
        state.isBuffering = false;
        startStallCheck(onStall);
    });
}
