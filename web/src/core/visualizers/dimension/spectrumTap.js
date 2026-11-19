/* ============================================================
 * spectrumTap.js — 穿行模式的非侵入式实时频谱
 *
 * 优先级：
 *   ① window.playerAudioAnalyser —— core/equalizer 建图时挂在链路末端的
 *      AnalyserNode（只要用户开过 EQ/空间音效就存在），零成本复用；
 *   ② HTMLMediaElement.captureStream() —— 新建一个只接 Analyser、
 *      末端接 0 增益的独立 AudioContext。它**不捕获元素、不改音频输出**，
 *      所以不会影响均衡器后续建图，也不会像 ensureAudioGraph 那样
 *      给没开音效的用户挂上响度压缩器。
 *
 * ③ 留一个"全零"兜底钩子：跨域限制会让 captureStream 出静音。调用方
 *   （DimensionAudio）在连续静音时会调 ensureAudioGraph 做一次重载建图，
 *   成功后 playerAudioAnalyser 成为来源 ①。
 *
 * 只在穿行模式里用；其它视觉器已有自己的音频链路，不要顺手扩散。
 * ============================================================ */

import { logCatch } from '../../../services/log.js';

/** @typedef {{ el: HTMLAudioElement|null, ctx: AudioContext|null, source: MediaStreamAudioSourceNode|null,
 *              stream: MediaStream|null, analyser: AnalyserNode|null, sink: GainNode|null }} TapState */

/** @type {TapState} */
const _tap = { el: null, ctx: null, source: null, stream: null, analyser: null, sink: null };
let _failed = false;
/* 失败按「元素 + 当前 src」记忆：否则 captureStream 返回空流时，每帧都会
   新建再关闭一个 AudioContext（穿行模式 60fps 下足以拖垮页面）。 */
let _failedEl = null;
let _failedSrc = '';

function releaseTap() {
    try {
        if (_tap.stream) {
            for (const track of _tap.stream.getTracks()) track.stop();
        }
    } catch (e) { logCatch('spectrumTap', e); }
    try {
        if (_tap.source) _tap.source.disconnect();
        if (_tap.analyser) _tap.analyser.disconnect();
        if (_tap.sink) _tap.sink.disconnect();
    } catch (e) { logCatch('spectrumTap', e); }
    try {
        if (_tap.ctx && _tap.ctx.state !== 'closed') _tap.ctx.close().catch((e) => logCatch('spectrumTap', e));
    } catch (e) { logCatch('spectrumTap', e); }
    _tap.el = null;
    _tap.ctx = null;
    _tap.source = null;
    _tap.stream = null;
    _tap.analyser = null;
    _tap.sink = null;
}

/**
 * @param {HTMLAudioElement|null} audioEl
 * @returns {AnalyserNode|null}
 */
function buildTap(audioEl) {
    if (!audioEl || typeof audioEl.captureStream !== 'function') return null;
    /* 没解码到可播放状态时 captureStream 往往是空流，等它 ready 再试 */
    if (Number(audioEl.readyState) < 2) return null;
    const src = String(audioEl.currentSrc || audioEl.src || '');
    if (_failedEl === audioEl && _failedSrc === src) return null;
    if (_tap.el === audioEl && _tap.analyser && _tap.ctx && _tap.ctx.state !== 'closed') {
        return _tap.analyser;
    }
    releaseTap();
    try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        const ctx = new AC();
        const stream = audioEl.captureStream();
        if (!stream || stream.getTracks().length === 0) {
            _failedEl = audioEl;
            _failedSrc = src;
            ctx.close().catch((e) => logCatch('spectrumTap', e));
            return null;
        }
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.72;
        const sink = ctx.createGain();
        sink.gain.value = 0;
        source.connect(analyser);
        analyser.connect(sink);
        sink.connect(ctx.destination);
        _tap.el = audioEl;
        _tap.ctx = ctx;
        _tap.source = source;
        _tap.stream = stream;
        _tap.analyser = analyser;
        _tap.sink = sink;
        return analyser;
    } catch (e) {
        logCatch('spectrumTap', e);
        _failed = true;
        return null;
    }
}

/**
 * 取这一帧可用的 AnalyserNode。
 * @param {HTMLAudioElement|null} audioEl
 * @returns {AnalyserNode|null}
 */
export function getLiveAnalyser(audioEl) {
    if (typeof window === 'undefined') return null;
    const shared = window.playerAudioAnalyser;
    if (shared && typeof shared.getByteFrequencyData === 'function') {
        /* 均衡器图建好后优先用共享 analyser，把独立 tap 关掉，避免两份采集 */
        if (_tap.analyser) releaseTap();
        return shared;
    }
    if (_failed) return null;
    const analyser = buildTap(audioEl);
    if (analyser && _tap.ctx && _tap.ctx.state === 'suspended') {
        _tap.ctx.resume().catch((e) => logCatch('spectrumTap', e));
    }
    return analyser;
}

/** 释放 tap（切换音频元素或退出模式时；EQ 建图成功后也应释放，避免两份采集）。 */
export function releaseSpectrumTap() {
    releaseTap();
}

/** @returns {{source:'analyser'|'tap'|'none', failed:boolean}} */
export function spectrumTapState() {
    if (typeof window !== 'undefined' && window.playerAudioAnalyser) {
        return { source: 'analyser', failed: _failed };
    }
    if (_tap.analyser) return { source: 'tap', failed: _failed };
    return { source: 'none', failed: _failed };
}
