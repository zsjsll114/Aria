/**
 * core/equalizer.js — Web Audio API 10 段均衡器
 * 管理 source → filter[0..9] → destination 音频图
 */
import { state } from '../infrastructure/state.js';
import { dom } from '../infrastructure/dom.js';
import { EQ_BANDS, EQ_PRESETS, EQ_STORAGE_KEY } from '../config/constants.js';
import { logInfo, logWarn, logError } from '../services/log.js';

/** 关闭并清理旧的 Web Audio 上下文，防止内存泄漏 */
export function cleanupEqAudioGraph() {
    if (state.eqFilterNodes.length > 0) {
        state.eqFilterNodes.forEach(node => { try { node.disconnect(); } catch (e) {} });
        state.eqFilterNodes = [];
    }
    if (state.eqSourceNode) {
        try { state.eqSourceNode.disconnect(); } catch (e) {}
        state.eqSourceNode = null;
    }
    if (state.audioCtx) {
        try { state.audioCtx.close(); } catch (e) {}
        state.audioCtx = null;
    }
    state.eqInited = false;
}

/**
 * 懒初始化 Web Audio 图：source → filter[0..9] → destination
 * 跨域音频需先设置 crossOrigin 并重新加载测试，失败则回退
 * @param {Function} onError - 跨域加载失败时的回调
 * @returns {Promise<boolean>} 是否初始化成功
 */
export async function initEqAudioGraph(onError) {
    if (state.eqInited) return true;
    if (state.eqInitFailed) return false;

    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { logWarn('equalizer', '不支持 Web Audio API'); return false; }

    const audio = dom.audio;
    const currentSrc = audio.src;
    if (!currentSrc) return false;

    const savedTime = audio.currentTime;
    const wasPlaying = !audio.paused;
    const isBlob = currentSrc.startsWith('blob:');

    /* 跨域音频需要 crossOrigin='anonymous' 才能通过 Web Audio 输出 */
    if (!isBlob) {
        audio.crossOrigin = 'anonymous';
        const reloadOk = await new Promise(resolve => {
            const onCanPlay = () => {
                audio.removeEventListener('canplay', onCanPlay);
                audio.removeEventListener('error', onError);
                resolve(true);
            };
            const onErrorFn = () => {
                audio.removeEventListener('canplay', onCanPlay);
                audio.removeEventListener('error', onErrorFn);
                resolve(false);
            };
            audio.addEventListener('canplay', onCanPlay);
            audio.addEventListener('error', onErrorFn);
            audio.src = currentSrc;
            audio.load();
            setTimeout(() => resolve(false), 4000);
        });

        if (!reloadOk) {
            audio.crossOrigin = null;
            await new Promise(resolve => {
                const onRestore = () => {
                    audio.removeEventListener('canplay', onRestore);
                    resolve();
                };
                audio.addEventListener('canplay', onRestore);
                audio.src = currentSrc;
                audio.load();
                setTimeout(resolve, 3000);
            });
            audio.currentTime = savedTime;
            if (wasPlaying) audio.play().catch(() => onError && onError());
            state.eqInitFailed = true;
            return false;
        }
    }

    try {
        state.audioCtx = new AC();
        state.eqSourceNode = state.audioCtx.createMediaElementSource(audio);
        state.eqFilterNodes = EQ_BANDS.map((freq, i) => {
            const f = state.audioCtx.createBiquadFilter();
            if (i === 0) f.type = 'lowshelf';
            else if (i === EQ_BANDS.length - 1) f.type = 'highshelf';
            else f.type = 'peaking';
            f.frequency.value = freq;
            f.Q.value = 1.0;
            f.gain.value = state.eqGains[i];
            return f;
        });
        /* 串联 */
        let node = state.eqSourceNode;
        for (const f of state.eqFilterNodes) {
            node.connect(f);
            node = f;
        }
        node.connect(state.audioCtx.destination);
        state.eqInited = true;

        if (state.audioCtx.state === 'suspended') {
            await state.audioCtx.resume();
        }

        audio.currentTime = savedTime;
        if (wasPlaying) audio.play().catch(() => onError && onError());
        return true;
    } catch (err) {
        logError('equalizer', '初始化均衡器失败:', err);
        state.eqInitFailed = true;
        return false;
    }
}

/** 应用增益值到滤波器节点 */
export function applyEqGains(gains) {
    state.eqGains = gains.slice();
    if (state.eqInited) {
        gains.forEach((g, i) => {
            if (state.eqFilterNodes[i]) {
                state.eqFilterNodes[i].gain.setValueAtTime(g, state.audioCtx.currentTime);
            }
        });
    }
    saveEqSettings();
}

/** 保存 EQ 设置到 localStorage */
export function saveEqSettings() {
    try {
        localStorage.setItem(EQ_STORAGE_KEY, JSON.stringify({
            gains: state.eqGains,
            preset: state.eqActivePreset
        }));
    } catch (e) {}
}

/** 从 localStorage 加载 EQ 设置 */
export function loadEqSettings() {
    try {
        const raw = localStorage.getItem(EQ_STORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (Array.isArray(data.gains) && data.gains.length === 10) {
            state.eqGains = data.gains;
            state.eqActivePreset = data.preset || '自定义';
        }
    } catch (e) {}
}

/** 应用 EQ 预设 */
export function applyEqPreset(name) {
    const preset = EQ_PRESETS[name];
    if (!preset) return;
    state.eqActivePreset = name;
    applyEqGains(preset);
}

/** 设置单个频段增益 */
export function setEqBand(idx, value) {
    state.eqGains[idx] = value;
    state.eqActivePreset = '自定义';
    if (state.eqInited && state.eqFilterNodes[idx]) {
        state.eqFilterNodes[idx].gain.setValueAtTime(value, state.audioCtx.currentTime);
    }
    saveEqSettings();
}
