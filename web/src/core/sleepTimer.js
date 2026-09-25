/* ============================================================
 * core/sleepTimer.js — 睡眠定时器（倒计时 + 最后 60 秒音量斜坡 + 到点暂停）
 *
 * 分层约定与 fadeController 一致：core 不 import app/*、不碰 DOM，audio 元素经
 * initSleepTimer 注入；音量读写用 volumePercentToGain(全局 volume 0~100)。
 *
 * 为什么不用 fadeController.fadeOutVolume 做这 60 秒淡出：
 *   1) 它在 appSettings.playback.fadeInOut 关闭时直接跳到 0（默认就是关的）；
 *   2) 它的 rAF/timeout 句柄与 crossfade 共享，切歌时 applyVolumeOnSongChange 的
 *      fadeInVolume 会双向取消在途淡出，把音量顶回目标值。
 * 所以这里自己走「墙钟时间 → 增益线性」的斜坡：每一刻的音量都是 (剩余/60s) 的
 * 纯函数，rAF 被后台节流时由 1s 看门狗补帧，永不与 crossfade 抢句柄。
 * 切歌保护见 sleepFadeOwnsVolume()（135-crossfade 的 applyVolumeOnSongChange 接线）。
 * ============================================================ */
import { volumePercentToGain } from '../utils/volumeCurve.js';
import { logCatch, logWarn } from '../services/log.js';

export const SLEEP_PRESET_MINUTES = [15, 30, 60, 90];
export const SLEEP_FADE_MS = 60000;
export const SLEEP_MIN_MINUTES = 1;
export const SLEEP_MAX_MINUTES = 600;

let _audio = null;
let _endAt = 0;           /* 墙钟 ms；0 = 未设定 */
let _minutes = 0;
let _fading = false;
let _tickTimer = null;    /* 1s：剩余时间广播 / 进入淡出窗 / 到期兜底 */
let _fadeRafId = null;    /* 淡出期逐帧斜坡（前台平滑） */
let _fadeWatchdogId = null; /* rAF 被节流的后台时的 1s 补帧 + 到期检测 */
const _listeners = new Set();

function clamp01(v) {
    return Math.max(0, Math.min(1, v));
}

/* 分片求值顺序不保证：音量基准一律探测式读全局（globalBridge 把它做成 state 的读写视图） */
function volumePercent() {
    const v = (typeof globalThis !== 'undefined' && typeof globalThis.volume === 'number') ? globalThis.volume : 80;
    return Math.max(0, Math.min(100, v));
}

function baseGain() {
    return volumePercentToGain(volumePercent());
}

function setAudioVolume(gain) {
    if (!_audio) return;
    try {
        _audio.volume = clamp01(gain);
    } catch (e) { logCatch('sleepTimer', e); }
}

function clearTick() {
    if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
}

function clearFadeHandles() {
    if (_fadeRafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(_fadeRafId);
    _fadeRafId = null;
    if (_fadeWatchdogId) { clearInterval(_fadeWatchdogId); _fadeWatchdogId = null; }
}

function emit(fired) {
    const snap = {
        active: _endAt > 0,
        fading: _fading,
        minutes: _minutes,
        remainingMs: getSleepRemainingMs(),
        fired: !!fired,
    };
    _listeners.forEach(fn => {
        try { fn(snap); } catch (e) { logCatch('sleepTimer', e); }
    });
}

/** 墙钟 → 增益的纯函数步进：任何触发源（rAF/看门狗/tick）重复调用都收敛到同一值 */
function applyRampStep() {
    const remaining = _endAt - Date.now();
    const frac = clamp01(remaining / SLEEP_FADE_MS);
    setAudioVolume(baseGain() * frac);
    return remaining;
}

function fadeFrame() {
    _fadeRafId = null;
    if (_endAt <= 0) return;
    try {
        const remaining = applyRampStep();
        if (remaining <= 0) { fire(); return; }
        /* 重设成了更长的定时：退出淡出窗，音量交还常规链路 */
        if (remaining > SLEEP_FADE_MS) { stopFadeAndRestore(); return; }
        if (typeof requestAnimationFrame === 'function') _fadeRafId = requestAnimationFrame(fadeFrame);
    } catch (e) { logCatch('sleepTimer', e); }
}

function startFade() {
    if (_fading) return;
    _fading = true;
    if (typeof requestAnimationFrame === 'function') _fadeRafId = requestAnimationFrame(fadeFrame);
    /* 后台标签页 rAF 可能完全停摆：1s 看门狗补帧斜坡并负责到期停机（墙钟基准，不漂移） */
    _fadeWatchdogId = setInterval(() => {
        try {
            if (_endAt <= 0) { clearFadeHandles(); return; }
            const remaining = applyRampStep();
            if (remaining <= 0) fire();
            else if (remaining > SLEEP_FADE_MS) stopFadeAndRestore();
        } catch (e) { logCatch('sleepTimer', e); }
    }, 1000);
}

function stopFadeAndRestore() {
    const wasFading = _fading;
    _fading = false;
    clearFadeHandles();
    if (wasFading) setAudioVolume(baseGain());
}

function tick() {
    try {
        if (_endAt <= 0) { clearTick(); return; }
        const remaining = _endAt - Date.now();
        if (remaining <= 0) { fire(); return; }
        if (remaining <= SLEEP_FADE_MS) startFade();
        emit(false);
    } catch (e) { logCatch('sleepTimer', e); }
}

/** 到点：只暂停当前播放，绝不触碰 playlist/currentTrackIndex（用户醒来还能原地续听） */
function fire() {
    clearTick();
    const wasFading = _fading;
    _fading = false;
    clearFadeHandles();
    _endAt = 0;
    try {
        if (_audio && !_audio.paused) _audio.pause();
    } catch (e) { logCatch('sleepTimer', e); }
    /* 立即归还音量：70-audio-engine 的 play 处理器有「volume===0 时淡回」保护，
       停在 0 会让下一次手动播放混入无关的淡入链路 */
    if (wasFading) setAudioVolume(baseGain());
    emit(true);
    logWarn('sleepTimer', '定时到达，已暂停播放（队列保留）');
}

/** 注入 audio 元素（#audioPlayer）。必须在 startSleepTimer 前调用一次。 */
export function initSleepTimer(audio) {
    _audio = audio || null;
}

/**
 * 开始/重设定时的唯一入口（重复调用 = 覆盖旧定时）。
 * @param {number} minutes 1~600 分钟
 * @returns {boolean} 参数非法时 false，调用方可直接提示
 */
export function startSleepTimer(minutes) {
    const m = Math.round(Number(minutes));
    if (!Number.isFinite(m) || m < SLEEP_MIN_MINUTES || m > SLEEP_MAX_MINUTES) return false;
    stopFadeAndRestore();
    clearTick();
    _minutes = m;
    _endAt = Date.now() + m * 60000;
    _tickTimer = setInterval(tick, 1000);
    if (_endAt - Date.now() <= SLEEP_FADE_MS) startFade();
    emit(false);
    return true;
}

/**
 * 取消定时。
 * @returns {boolean} 此前是否存在定时
 */
export function cancelSleepTimer() {
    if (_endAt <= 0) return false;
    clearTick();
    stopFadeAndRestore();
    _endAt = 0;
    _minutes = 0;
    emit(false);
    return true;
}

export function isSleepActive() { return _endAt > 0; }
export function isSleepFading() { return _fading; }
export function getSleepMinutes() { return _minutes; }
export function getSleepRemainingMs() { return _endAt > 0 ? Math.max(0, _endAt - Date.now()) : 0; }

/**
 * 切歌保护钩子（接线到 135-crossfade.applyVolumeOnSongChange 的函数开头）：
 * 返回 true 表示淡出斜坡正在接管音量，调用方必须直接 return，
 * 否则 fadeInVolume/音量恢复会把淡到一半的音量顶回满值。
 */
export function sleepFadeOwnsVolume() { return _fading; }

/** 淡出中途切到了新歌：立刻按新歌曲的基准音量补写一次斜坡值，不等下个 tick（消除 1s 响度跳变） */
export function sleepTimerSongChanged() {
    if (_fading) applyRampStep();
}

/**
 * 订阅状态变化（启动时设定档位变化也会广播一次）。
 * @param {(snap:{active:boolean,fading:boolean,minutes:number,remainingMs:number,fired:boolean})=>void} listener
 * @returns {() => void} 取消订阅
 */
export function onSleepTimerChange(listener) {
    if (typeof listener !== 'function') return () => {};
    _listeners.add(listener);
    return () => { _listeners.delete(listener); };
}
