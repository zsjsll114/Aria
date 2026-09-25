/* ============================================================
 * core/stallDetector.js — 音频卡死检测（core 层接管第 1 个模块）
 *
 * 来历：本文件原先是一份「没接线的目标架构快照」，与 app/70-audio-engine.js 里的
 * 活实现同名并存但已经落后：活版本多了后台节流保护（document.hidden 两处）、
 * stalled 确认窗口从 3s 改成 6s、waiting 里加了 bufferedEnd 续播诊断。
 * 2026-09-25 决定由 core 层接管，动作是**从活代码重新抽取**（不是接线旧快照），
 * 所以以下逻辑逐行来自 app/70-audio-engine.js，行为保持不变。
 *
 * 日志 tag 仍用 'audioEngine'（不是本模块名）：这样迁移前后的控制台输出完全一致，
 * 排查时按老关键字过滤不会漏。这是刻意为之，别"顺手改成 stallDetector"。
 *
 * 状态：stallTimer / stallLastTime / stallCheckGeneration / isBuffering 存在
 * infrastructure/state.js，经 infrastructure/globalBridge.js 与 globalThis 同名键
 * 双向打通，因此 app/250-desktop-lyrics.js 等仍按裸标识符读的地方不需要改动。
 *
 * 依赖注入：audio 元素由调用方传入，不读 infrastructure/dom.js —— dom.audio 要等
 * initDom()（DOMContentLoaded）才有值，而卡死监听必须在分片模块体就挂上。
 * ============================================================ */
import { state } from '../infrastructure/state.js';
import { logWarn } from '../services/log.js';

const STALL_CHECK_MS = 8000;
const STALLED_CONFIRM_MS = 6000;

let _audio = null;
let _onStall = null;

const isDocHidden = () => (typeof document !== 'undefined' && document.hidden);

/** 启动卡死检测（8 秒内 currentTime 未前进即判定卡死） */
export function startStallCheck() {
    stopStallCheck();
    if (!_audio) return;
    state.stallCheckGeneration++;
    const gen = state.stallCheckGeneration;
    state.stallLastTime = _audio.currentTime;
    const check = () => {
        if (gen !== state.stallCheckGeneration) return; /* 已过期 */
        if (_audio.paused || state.isBuffering || isDocHidden()) {
            state.stallTimer = setTimeout(check, STALL_CHECK_MS);
            return;
        }
        if (Math.abs(_audio.currentTime - state.stallLastTime) < 0.1) {
            logWarn('audioEngine', '检测到音频卡死（currentTime 8秒未前进），自动停止');
            if (_onStall) _onStall();
            return;
        }
        state.stallLastTime = _audio.currentTime;
        state.stallTimer = setTimeout(check, STALL_CHECK_MS);
    };
    state.stallTimer = setTimeout(check, STALL_CHECK_MS);
}

/** 停止卡死检测（代际号自增让在途的 check 回调作废） */
export function stopStallCheck() {
    state.stallCheckGeneration++;
    if (state.stallTimer) { clearTimeout(state.stallTimer); state.stallTimer = null; }
}

/** 供上层（如淡出/错误恢复）显式设置缓冲态 */
export function setBuffering(buffering) {
    state.isBuffering = buffering;
}

/**
 * 挂载 stalled / waiting / playing 三个监听。
 * @param {HTMLAudioElement} audio
 * @param {Function} onStall 判定卡死/播放失败时的回调（活实现里是 handleAudioPlayError）
 */
export function initStallDetector(audio, onStall) {
    _audio = audio;
    _onStall = onStall;
    if (!audio) return;

    /* 网络停滞：浏览器停止下载数据（常见于网络不稳定） */
    audio.addEventListener('stalled', () => {
        if (isDocHidden()) {
            return; /* 后台节流保护：不触发误判 */
        }
        logWarn('audioEngine', '音频网络停滞 (stalled)，尝试等待恢复');
        /* 6秒后检查是否恢复，如果没有则判定为播放失败 */
        setTimeout(() => {
            if (isDocHidden()) return;
            if (!audio.paused && audio.currentTime === state.stallLastTime && audio.readyState < 3) {
                logWarn('audioEngine', '网络停滞后未恢复，停止播放');
                if (_onStall) _onStall();
            }
        }, STALLED_CONFIRM_MS);
    });

    /* 缓冲开始：暂停卡死检测 */
    audio.addEventListener('waiting', () => {
        state.isBuffering = true;
        if (state.stallTimer) { clearTimeout(state.stallTimer); state.stallTimer = null; }
        /* 续播诊断：暂停几秒后恢复出现"卡一下"时，控制台会看到这条日志，
           据此区分 网络层重缓冲(readyState 低/bufferedEnd 追不上) 与 解码层异常 */
        if (audio.currentTime > 0.5 && audio.buffered && audio.buffered.length > 0) {
            logWarn('audioEngine', `[waiting] 中途重缓冲 t=${audio.currentTime.toFixed(1)}s ` +
                `bufferedEnd=${audio.buffered.end(audio.buffered.length - 1).toFixed(1)}s ` +
                `readyState=${audio.readyState}`);
        }
    });

    /* 缓冲结束恢复播放：重新启动卡死检测 */
    audio.addEventListener('playing', () => {
        state.isBuffering = false;
        startStallCheck();
    });
}
