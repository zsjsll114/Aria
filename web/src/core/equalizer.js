/* ============================================================
 * core/equalizer.js — 10 段均衡器的音频图 / 增益状态 / 持久化
 * （core 层接管第 4 个模块，2026-09-25）
 *
 * 来历：本文件原先是「没接线的目标架构快照」，缺活实现的两块关键能力：
 *   · 用户自定义预设（localStorage aria_eq_custom + 分享码导入的预设都走 getCustomEqs），
 *     快照的 applyEqPreset 只查内置 EQ_PRESETS —— 接上就是「自定义预设全部失效」；
 *   · 输出链上的 DynamicsCompressor 响度归一化与 Analyser 挂载（快照没有）。
 * 所以接管动作是从 app/90-eq.js 的活实现**重新抽取**，逻辑逐行照搬。
 *
 * 边界：本模块只管「音频图 + 增益状态 + 持久化」，DOM 部分（频段滑块、预设按钮、
 * 拖拽时的数值文本）留在 app/90-eq.js —— 特别注意 onEqBandChange 只刷新高亮、
 * 不重建滑块，否则拖动过程中会被自己重渲染打断。该行为通过 onBandChanged 回调保留。
 *
 * 状态：eqGains / eqActivePreset / eqInited / eqInitFailed / audioCtx / eqSourceNode /
 * eqFilterNodes 存在 infrastructure/state.js，仍与 globalThis 同名键双向打通
 * （180-boot-config、258-rankings 的分享码导入导出按裸标识符读写）。
 * ============================================================ */
import { state } from '../infrastructure/state.js';
import { EQ_BANDS, EQ_PRESETS, EQ_STORAGE_KEY } from '../config/constants.js';
import { logWarn, logError, logCatch } from '../services/log.js';

const CUSTOM_EQ_KEY = 'aria_eq_custom';

let _audio = null;
let _onPlayError = null;   /* CORS 回退后恢复播放失败时回调（活实现是 handleAudioPlayError） */
let _onChanged = null;     /* 预设高亮需要刷新（不重建滑块） */
let _onBandChanged = null; /* 单个频段数值文本刷新 */
let _onPresetApplied = null; /* 换预设后需要整面板重建（频段 + 高亮） */

/**
 * 注入依赖。三个刷新回调对应活实现里三种不同的重渲染范围，别合并：
 * 拖滑块时若重建滑块，拖拽会被自己的重渲染打断。
 * @param {{audio: HTMLAudioElement, onPlayError?: Function, onChanged?: Function,
 *          onBandChanged?: (idx:number)=>void, onPresetApplied?: Function}} deps
 */
export function initEqualizer(deps) {
    _audio = deps.audio || null;
    _onPlayError = deps.onPlayError || null;
    _onChanged = deps.onChanged || null;
    _onBandChanged = deps.onBandChanged || null;
    _onPresetApplied = deps.onPresetApplied || null;
}

/* 关闭并清理旧的 Web Audio 上下文，防止内存泄漏 */
export function cleanupEqAudioGraph() {
    if (state.eqFilterNodes.length > 0) {
        state.eqFilterNodes.forEach((node) => {
            try { node.disconnect(); } catch (e) { logCatch('eq', e); }
        });
        state.eqFilterNodes = [];
    }
    if (state.eqSourceNode) {
        try { state.eqSourceNode.disconnect(); } catch (e) { logCatch('eq', e); }
        state.eqSourceNode = null;
    }
    if (state.audioCtx) {
        try { state.audioCtx.close(); } catch (e) { logCatch('eq', e); }
        state.audioCtx = null;
    }
    state.eqInited = false;
}

/* 懒初始化 Web Audio 图：source → filter[0..9] → compressor → destination
   跨域音频需先设置 crossOrigin 并重新加载测试，失败则回退 */
export async function initEqAudioGraph() {
    if (state.eqInited) return true;
    if (state.eqInitFailed) return false;
    if (!_audio) return false;

    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { logWarn('eq', '不支持 Web Audio API'); return false; }

    const currentSrc = _audio.src;
    if (!currentSrc) return false;

    const savedTime = _audio.currentTime;
    const wasPlaying = !_audio.paused;
    const isBlob = currentSrc.startsWith('blob:');

    /* 跨域音频需要 crossOrigin='anonymous' 才能通过 Web Audio 输出，先重载测试，失败则回退 */
    if (!isBlob) {
        _audio.crossOrigin = 'anonymous';
        const reloadOk = await new Promise((resolve) => {
            const onCanPlay = () => {
                _audio.removeEventListener('canplay', onCanPlay);
                _audio.removeEventListener('error', onError);
                resolve(true);
            };
            const onError = () => {
                _audio.removeEventListener('canplay', onCanPlay);
                _audio.removeEventListener('error', onError);
                resolve(false);
            };
            _audio.addEventListener('canplay', onCanPlay);
            _audio.addEventListener('error', onError);
            _audio.src = currentSrc;
            _audio.load();
            setTimeout(() => resolve(false), 4000);
        });

        if (!reloadOk) {
            /* CORS 不支持，回退：移除 crossOrigin，重新加载 */
            _audio.crossOrigin = null;
            await new Promise((resolve) => {
                const onRestore = () => {
                    _audio.removeEventListener('canplay', onRestore);
                    resolve();
                };
                _audio.addEventListener('canplay', onRestore);
                _audio.src = currentSrc;
                _audio.load();
                setTimeout(resolve, 3000);
            });
            _audio.currentTime = savedTime;
            if (wasPlaying) _audio.play().catch(() => { if (_onPlayError) _onPlayError(); });
            state.eqInitFailed = true;
            return false;
        }
    }

    try {
        state.audioCtx = new AC();
        state.eqSourceNode = state.audioCtx.createMediaElementSource(_audio);
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
        /* ★ 响度归一化：EQ 输出前插一个温和的 DynamicsCompressor，
           压低过响峰值、抬升总体响度，使不同歌曲（尤其不同音源）听感更一致 */
        try {
            window.playerLoudnessComp = state.audioCtx.createDynamicsCompressor();
            window.playerLoudnessComp.threshold.value = -22;
            window.playerLoudnessComp.knee.value = 8;
            window.playerLoudnessComp.ratio.value = 3.2;
            window.playerLoudnessComp.attack.value = 0.008;
            window.playerLoudnessComp.release.value = 0.18;
            node.connect(window.playerLoudnessComp);
            node = window.playerLoudnessComp;
        } catch (ce) { /* 不支持则跳过 */ }
        node.connect(state.audioCtx.destination);
        try {
            window.playerAudioAnalyser = state.audioCtx.createAnalyser();
            window.playerAudioAnalyser.fftSize = 128;
            window.playerAudioAnalyser.smoothingTimeConstant = 0.8;
            node.connect(window.playerAudioAnalyser);
        } catch (ae) { logCatch('eq', ae); }
        state.eqInited = true;

        if (state.audioCtx.state === 'suspended') {
            await state.audioCtx.resume();
        }

        /* 恢复播放状态 */
        _audio.currentTime = savedTime;
        if (wasPlaying) _audio.play().catch(() => { if (_onPlayError) _onPlayError(); });

        return true;
    } catch (err) {
        logError('eq', '初始化均衡器失败:', err);
        state.eqInitFailed = true;
        return false;
    }
}

/* 保存 / 加载设置 */
export function saveEqSettings() {
    try {
        localStorage.setItem(EQ_STORAGE_KEY, JSON.stringify({
            gains: state.eqGains,
            preset: state.eqActivePreset,
        }));
    } catch (e) { logCatch('eq', e); }
}

export function loadEqSettings() {
    try {
        const raw = localStorage.getItem(EQ_STORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (Array.isArray(data.gains) && data.gains.length === 10) {
            state.eqGains = data.gains;
            state.eqActivePreset = data.preset || '自定义';
        }
    } catch (e) { logCatch('eq', e); }
}

/** 用户自定义预设表（分享码导入的预设也落在这里） */
export function getCustomEqs() {
    try { return JSON.parse(localStorage.getItem(CUSTOM_EQ_KEY) || '{}'); } catch (e) { return {}; }
}

export function saveEqPreset(name) {
    if (!name) return;
    const customs = getCustomEqs();
    customs[name] = { gains: (state.eqGains || []).slice(), preset: state.eqActivePreset || '自定义' };
    try { localStorage.setItem(CUSTOM_EQ_KEY, JSON.stringify(customs)); } catch (e) { logCatch('eq', e); }
    state.eqActivePreset = name;
    saveEqSettings();
    if (_onChanged) _onChanged();
}

/* 应用增益值到滤波器节点 */
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

/* 应用预设（内置 EQ_PRESETS + 用户自定义预设） */
export function applyEqPreset(name) {
    const preset = EQ_PRESETS[name] || getCustomEqs()[name];
    if (!preset) return false;
    state.eqActivePreset = name;
    applyEqGains(Array.isArray(preset) ? preset : (preset.gains || []));
    if (_onPresetApplied) _onPresetApplied();
    return true;
}

/* 单个频段改变：只刷新值文本与预设高亮，不重建滑块（否则拖拽会被自己的重渲染打断） */
export function setEqBand(idx, val) {
    state.eqGains[idx] = parseInt(val);
    state.eqActivePreset = '自定义';
    if (state.eqInited && state.eqFilterNodes[idx]) {
        state.eqFilterNodes[idx].gain.setValueAtTime(state.eqGains[idx], state.audioCtx.currentTime);
    }
    saveEqSettings();
    if (_onBandChanged) _onBandChanged(idx);
    if (_onChanged) _onChanged();
}
