/**
 * DimensionAudio.js
 * 3D 浮空空间模式 - 安全音频频谱与节奏分析器 (非侵入式，杜绝阻塞音频播放)
 */
import { logCatch } from '../../../services/log.js';

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
    }

    /**
     * 连接音频（非侵入式）
     */
    connect(audioElement) {
        // 保持无害引用，不劫持媒体节点
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
            return;
        }

        let rawBass = 0;
        let rawMid = 0;
        let rawTreble = 0;
        let rawOverall = 0;
        let gotRealData = false;

        // 尝试从全局已有的 Web Audio Analyser 读取数据
        if (typeof window !== 'undefined' && window.playerAudioAnalyser) {
            try {
                window.playerAudioAnalyser.getByteFrequencyData(this.freqData);
                let bassSum = 0, midSum = 0, trebleSum = 0, totalSum = 0;
                const len = this.freqData.length;
                for (let i = 0; i < len; i++) {
                    const v = this.freqData[i] / 255;
                    totalSum += v;
                    if (i < 4) bassSum += v;
                    else if (i < 20) midSum += v;
                    else trebleSum += v;
                }
                rawBass = bassSum / 4;
                rawMid = midSum / 16;
                rawTreble = trebleSum / (len - 20);
                rawOverall = totalSum / len;
                if (rawOverall > 0.02) gotRealData = true;
            } catch (e) { logCatch('DimensionAudio', e); }
        }

        // 高度拟真、平滑富有动感的节奏发生器（保证所有音源动效拉满）
        if (!gotRealData) {
            const dt = Math.max(0.016, Math.min(0.1, currentTime - this.lastTime));
            this.lastTime = currentTime;
            this.simPhase += dt * 3.8;

            // 低频强劲鼓点 (Bass Punch)
            const beatPulse = Math.pow((Math.sin(this.simPhase * 2.0) + 1) * 0.5, 3.5);
            // 中频旋律波 (Mid Melody)
            const midWave = (Math.sin(this.simPhase * 4.2) + 1) * 0.5 * 0.7;
            // 高频闪烁 (Treble Shimmer)
            const trebleWave = (Math.cos(this.simPhase * 7.5) + 1) * 0.5 * 0.5;

            rawBass = 0.3 + beatPulse * 0.7;
            rawMid = 0.25 + midWave * 0.6;
            rawTreble = 0.2 + trebleWave * 0.5;
            rawOverall = (rawBass + rawMid + rawTreble) / 3;

            // 填充合成频域数组以供音柱使用
            for (let i = 0; i < this.freqData.length; i++) {
                const fPhase = this.simPhase * 2.5 + i * 0.4;
                const fVal = Math.max(0.1, Math.min(1.0, Math.sin(fPhase) * 0.5 + 0.5)) * (rawBass * 0.6 + rawMid * 0.4);
                this.freqData[i] = Math.round(fVal * 255);
            }
        }

        // 平滑低通滤波
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
    }
}
