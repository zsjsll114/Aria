/* ============================================================
 * ⚠ 封存：未接线模块（从入口 web/src/app/index.js 静态不可达）
 *
 * 证据：scripts/audits/module-reachability.mjs 复扫（2026-09-25）——没有任何存活模块 import 本文件，
 *       运行期不会加载；在这里改东西不会生效。
 * 活实现：app/70-audio-engine.js（audio 元素与播放控制）、app/40-playback-state.js（isPlaying 等状态键）、app/65-playback-position.js（进度）
 * 为什么还留着：docs/模块化重构方案.md 阶段 2-4 把本层列为目标架构，是否删除属产品决定；
 *       现按「原地冻结」处理，配套门禁见 eslint.config.mjs 的 no-restricted-imports。
 * state 双写已由 infrastructure/globalBridge.js 收口（state 是唯一存储，globalThis 同名键是视图），
 * 所以接线不再会读到初始值；但仍须逐模块从活实现重新抽取——见 core/stallDetector.js 等已接管模块的
 * 头注释：旧快照普遍缺活实现后来补的修复，直接接线等于退回旧行为。
 *
 * ★ 2026-09-25 判定：本模块**不做接管**，与前 4 个（stallDetector / fadeController /
 *   shortcutManager / equalizer）不同——那 4 个都能沿一条清晰边界从单个分片抽出，
 *   而它是四个分片关注点的门面：getDuration→56-playback-misc、
 *   togglePlayPause/handleAudioPlayError/initAudioEvents→70-audio-engine、
 *   waitForAudioReady/updatePlaybackPosition→65-playback-position、
 *   nextTrack/prevTrack→95-track-loading，另外还重复定义了 PLAY_ICON_PATH / PAUSE_ICON_PATH
 *   （活的那份由 65 导出）。"接管"它等于重写播放主链路，而主链路活路径目前无测试覆盖，
 *   不适合做机械抽取。要真推进，需要先给播放/切歌/进度补上行为测试再动。
 * ============================================================ */

/**
 * core/audioPlayer.js — 音频播放核心控制
 * 封装 Audio 元素操作、播放/暂停、曲目加载、代际控制、进度更新
 */
import { state, setState } from '../infrastructure/state.js';
import { dom, getBlurBgLayers } from '../infrastructure/dom.js';
import { eventBus, EVENTS } from '../infrastructure/eventBus.js';
import { fadeOutVolume, fadeInVolume } from './fadeController.js';
import { startStallCheck, stopStallCheck, initStallEventListeners } from './stallDetector.js';
import { getPlayUrl } from '../services/musicApi.js';
import { formatTime } from '../utils/formatters.js';
import { logInfo, logWarn, logError } from '../services/log.js';

const PLAY_ICON_PATH = '<path d="M10.345 23.287c.415 0 .763-.15 1.22-.407l12.742-7.404c.838-.481 1.178-.855 1.178-1.46 0-.599-.34-.972-1.178-1.462L11.565 5.158c-.457-.265-.805-.407-1.22-.407-.789 0-1.345.606-1.345 1.57V21.71c0 .971.556 1.577 1.345 1.577z" fill-rule="nonzero"></path>';
const PAUSE_ICON_PATH = '<path d="M13.293 22.772c.955 0 1.436-.481 1.436-1.436V6.677c0-.98-.481-1.427-1.436-1.427h-2.457c-.954 0-1.436.473-1.436 1.427v14.66c-.008.954.473 1.435 1.436 1.435h2.457zm7.87 0c.954 0 1.427-.481 1.427-1.436V6.677c0-.98-.473-1.427-1.428-1.427h-2.465c-.955 0-1.428.473-1.428 1.427v14.66c0 .954.473 1.435 1.428 1.435h2.465z" fill-rule="nonzero"></path>';

/** 获取音频时长（ms） */
export function getDuration() {
    if (dom.audio.duration && !isNaN(dom.audio.duration)) {
        return dom.audio.duration * 1000;
    }
    return 0;
}

/** 播放/暂停切换 */
export function togglePlayPause() {
    const audio = dom.audio;
    if (!audio.src) return;
    if (audio.paused) {
        if (audio.volume === 0 && state.volume > 0) {
            audio.volume = state.volume / 100;
        }
        audio.play().catch(e => { logError('audioPlayer', '播放失败:', e); handleAudioPlayError(); });
    } else {
        audio.pause();
    }
}

/** 处理音频播放错误/卡死 */
export function handleAudioPlayError() {
    const audio = dom.audio;
    audio.pause();
    state.isPlaying = false;
    state.isBuffering = false;
    if (dom.playIcon) dom.playIcon.innerHTML = PLAY_ICON_PATH;
    getBlurBgLayers().forEach(l => l.classList.add('paused'));
    stopStallCheck();
    if (audio.volume === 0 && state.volume > 0) {
        audio.volume = state.volume / 100;
    }
    eventBus.emit(EVENTS.PLAYBACK_ERROR, { error: 'playback_error' });
}

/** 等待音频就绪 */
export function waitForAudioReady(timeoutMs = 8000) {
    const audio = dom.audio;
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const cleanup = () => {
            audio.removeEventListener('canplay', onReady);
            audio.removeEventListener('loadeddata', onReady);
            audio.removeEventListener('error', onErr);
            if (timer) { clearTimeout(timer); timer = null; }
        };
        const onReady = () => { if (settled) return; settled = true; cleanup(); resolve(); };
        const onErr = () => { if (settled) return; settled = true; cleanup(); reject(new Error('audio_load_error')); };
        audio.addEventListener('canplay', onReady, { once: true });
        audio.addEventListener('loadeddata', onReady, { once: true });
        audio.addEventListener('error', onErr, { once: true });
        timer = setTimeout(() => {
            if (!settled) {
                settled = true; cleanup();
                if (audio.readyState >= 2 && !audio.error) resolve();
                else reject(new Error('audio_load_timeout'));
            }
        }, timeoutMs);
    });
}

/** 更新进度条位置 */
export function updatePlaybackPosition() {
    const duration = getDuration();
    const percent = duration > 0 ? (state.currentTime / duration) * 100 : 0;
    const formattedTime = formatTime(state.currentTime);
    if (Math.abs(percent - state.lastPercent) > 0.1) {
        if (dom.progressEl) dom.progressEl.style.width = `${percent}%`;
        state.lastPercent = percent;
    }
    if (formattedTime !== state.lastFormattedTime) {
        if (dom.currentTimeEl) dom.currentTimeEl.textContent = formattedTime;
        state.lastFormattedTime = formattedTime;
    }
}

/**
 * 初始化音频事件监听器
 * @param {Object} callbacks - 回调函数集合
 */
export function initAudioEvents(callbacks) {
    const audio = dom.audio;

    audio.addEventListener('play', () => {
        state.isPlaying = true;
        if (dom.playIcon) dom.playIcon.innerHTML = PAUSE_ICON_PATH;
        getBlurBgLayers().forEach(l => l.classList.remove('paused'));
        if (audio.volume === 0 && state.volume > 0) {
            if (state.appSettings.playback.fadeInOut) {
                fadeInVolume(state.volume / 100, state.appSettings.playback.fadeDuration);
            } else {
                audio.volume = state.volume / 100;
            }
        }
        startStallCheck(handleAudioPlayError);
        eventBus.emit(EVENTS.PLAY);
    });

    audio.addEventListener('pause', () => {
        state.isPlaying = false;
        if (dom.playIcon) dom.playIcon.innerHTML = PLAY_ICON_PATH;
        getBlurBgLayers().forEach(l => l.classList.add('paused'));
        stopStallCheck();
        eventBus.emit(EVENTS.PAUSE);
    });

    audio.addEventListener('ended', () => {
        eventBus.emit(EVENTS.ENDED);
    });

    audio.addEventListener('error', () => {
        if (audio.src && audio.error) {
            logError('audioPlayer', '音频错误:', audio.error.code, audio.error.message);
            handleAudioPlayError();
        }
    });

    audio.addEventListener('timeupdate', () => {
        state.currentTime = audio.currentTime * 1000;
        updatePlaybackPosition();
    });

    audio.addEventListener('loadedmetadata', () => {
        if (dom.totalTimeEl) dom.totalTimeEl.textContent = formatTime(getDuration());
    });

    initStallEventListeners(handleAudioPlayError);
}

/**
 * 下一曲
 * @param {Function} loadTrack - 加载曲目的函数
 */
export function nextTrack(loadTrack) {
    if (state.playlist.length === 0) return;
    if (state.playMode === 'loop') {
        loadTrack(state.currentTrackIndex);
        return;
    }
    if (state.playMode === 'random') {
        if (state.playlist.length > 1) {
            const oldIdx = state.currentTrackIndex;
            do { state.currentTrackIndex = Math.floor(Math.random() * state.playlist.length); }
            while (state.currentTrackIndex === oldIdx);
        }
    } else {
        state.currentTrackIndex = (state.currentTrackIndex + 1) % state.playlist.length;
    }
    loadTrack(state.currentTrackIndex);
}

/**
 * 上一曲
 * @param {Function} loadTrack - 加载曲目的函数
 */
export function prevTrack(loadTrack) {
    const audio = dom.audio;
    if (state.playlist.length === 0) { return; }
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    if (state.playMode === 'loop') { loadTrack(state.currentTrackIndex); return; }
    if (state.playMode === 'random') {
        if (state.playlist.length > 1) {
            const oldIdx = state.currentTrackIndex;
            do { state.currentTrackIndex = Math.floor(Math.random() * state.playlist.length); }
            while (state.currentTrackIndex === oldIdx);
        }
    } else {
        state.currentTrackIndex = (state.currentTrackIndex - 1 + state.playlist.length) % state.playlist.length;
    }
    loadTrack(state.currentTrackIndex);
}
