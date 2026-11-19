/**
 * DimensionAudio.js
 * 3D 浮空空间模式 — 真实频谱优先的音频能量分析器（非侵入式）
 *
 * 数据来源见 spectrumTap.js：
 *   window.playerAudioAnalyser（EQ 图末端）→ captureStream 独立 tap → 合成节拍兜底。
 * ★ 有 AnalyserNode 时**永远使用真实数据**，即使这一帧全是 0（安静段落），
 *   不再因为"能量太低"切回合成节拍——那正是用户看到的"粒子不跟真实频谱"。
 * ★ 合成节拍只在完全没有采集通道时使用，保证老环境/受限环境画面仍然活着。
 */
import { logCatch } from '../../../services/log.js';
import { getLiveAnalyser, releaseSpectrumTap } from './spectrumTap.js';

export class DimensionAudio {
    constructor() {
        this.freqData = new Uint8Array(64);
        this.bass = 0;
        this.mid = 0;
        this.treble = 0;
        this.overall = 0;
        this.peakEnergy = 0;

        this.lastTime = 0;
        this.simPhase = 0;
        /** @type {HTMLAudioElement|null} */
        this.audioElement = null;
    }

    /**
     * 连接音频（保持无害引用，不劫持媒体节点）
     * @param {HTMLAudioElement|null} audioElement
     */
    connect(audioElement) {
        this.audioElement = audioElement;
    }

    /**
     * 每帧更新频谱能量
     * @param {number} currentTime 当前音频秒数
     * @param {boolean} isPlaying 是否正在播放
     */
    update(currentTime = 0, isPlaying = true) {
        if (!isPlaying) {
            this.bass *= 0.85;
            this.mid *= 0.85;
            this.treble *= 0.85;
            this.overall *= 0.85;
            this.peakEnergy *= 0.85;
            const paused = this.freqData;
            for (let i = 0; i < paused.length; i++) {
                paused[i] = Math.round((paused[i] || 0) * 0.85);
            }
            return;
        }

        let rawBass = 0;
        let rawMid = 0;
        let rawTreble = 0;
        let rawOverall = 0;
        let gotRealData = false;

        const audioEl = this.audioElement
            || (typeof window !== 'undefined' ? (window.audio || document.querySelector('audio')) : null);
        const analyser = getLiveAnalyser(/** @type {HTMLAudioElement|null} */ (audioEl));
        if (analyser) {
            try {
                if (this.freqData.length !== analyser.frequencyBinCount) {
                    this.freqData = new Uint8Array(analyser.frequencyBinCount);
                }
                analyser.getByteFrequencyData(this.freqData);
                const len = this.freqData.length;
                let bassSum = 0, midSum = 0, trebleSum = 0, totalSum = 0;
                for (let i = 0; i < len; i++) {
                    const v = (this.freqData[i] || 0) / 255;
                    totalSum += v;
                    if (i < 4) bassSum += v;
                    else if (i < 20) midSum += v;
                    else trebleSum += v;
                }
                rawBass = bassSum / 4;
                rawMid = midSum / 16;
                rawTreble = trebleSum / Math.max(1, len - 20);
                rawOverall = totalSum / Math.max(1, len);
                gotRealData = true;

                /* 高频在音乐里天然弱：只对"画出来"的频段做感知提亮，
                   bass/mid/treble 的统计仍用未提亮的原始值。 */
                for (let i = 0; i < len; i++) {
                    const gain = 1 + (i / Math.max(1, len - 1)) * 0.9;
                    this.freqData[i] = Math.min(255, Math.round((this.freqData[i] || 0) * gain));
                }

            } catch (e) {
                logCatch('DimensionAudio', e);
                gotRealData = false;
            }
        }

        if (!gotRealData) {
            const dt = Math.max(0.016, Math.min(0.1, currentTime - this.lastTime));
            this.lastTime = currentTime;
            this.simPhase += dt * 3.8;

            const beatPulse = Math.pow((Math.sin(this.simPhase * 2.0) + 1) * 0.5, 3.5);
            const midWave = (Math.sin(this.simPhase * 4.2) + 1) * 0.5 * 0.7;
            const trebleWave = (Math.cos(this.simPhase * 7.5) + 1) * 0.5 * 0.5;

            rawBass = 0.3 + beatPulse * 0.7;
            rawMid = 0.25 + midWave * 0.6;
            rawTreble = 0.2 + trebleWave * 0.5;
            rawOverall = (rawBass + rawMid + rawTreble) / 3;

            for (let i = 0; i < this.freqData.length; i++) {
                const fPhase = this.simPhase * 2.5 + i * 0.4;
                const fVal = Math.max(0.1, Math.min(1.0, Math.sin(fPhase) * 0.5 + 0.5)) * (rawBass * 0.6 + rawMid * 0.4);
                this.freqData[i] = Math.round(fVal * 255);
            }
        }

        /* 平滑低通滤波（AnalyserNode 自己也平滑，这里只补一层防抖） */
        const smooth = 0.22;
        this.bass += (rawBass - this.bass) * smooth;
        this.mid += (rawMid - this.mid) * smooth;
        this.treble += (rawTreble - this.treble) * smooth;
        this.overall += (rawOverall - this.overall) * smooth;

        const diff = Math.max(0, rawBass - this.bass);
        this.peakEnergy = Math.min(1.0, this.peakEnergy * 0.85 + diff * 1.8);
    }

    destroy() {
        this.audioElement = null;
        releaseSpectrumTap();
    }
}
