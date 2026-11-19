/* ============================================================
 * focalcutCamera.js — 「镜幕 · FocalCut」电影运动控制导播台
 *
 * 六种电影级克制运镜语言（临界阻尼平滑追踪 + 安全取景框约束 + 段落极性稳定）：
 *   1. wide    — 24mm 宽银幕全景（完整呈现展墙构图，微幅缓推呼吸）
 *   2. rack    — 50mm 焦点拉移（同行组切行时平滑居中并触发光学拉焦）
 *   3. track   — 35mm 横移滑轨（沿当前句顺滑引导演唱字，绝不漂出画外）
 *   4. oblique — 50mm 建筑斜拍（克制 2.5D 透视仰侧角 ±9°，立体而不歪斜）
 *   5. closeup — 85mm 情感特写（1.34~1.56x 聚焦情感词与高潮短语，保留语义完整）
 *   6. split   — 62/38 双镜分屏（左宽画幅 2.5D 建筑景 + 右反色银盐微距同步跟焦）
 *
 * 极性纪律：仅在换墙/乐段切换（主歌 ↔ 副歌）时变更明暗极性，绝不在句内频闪。
 * ============================================================ */

const CUT_COOLDOWN_MS = {
  calm: 2400,
  normal: 1550,
  intense: 950,
};

const SHOT_META = {
  wide:    { lens: '24mm ANAMORPHIC', fstop: 'f/2.0' },
  rack:    { lens: '50mm RACK FOCUS', fstop: 'f/1.4' },
  track:   { lens: '35mm DOLLY',      fstop: 'f/1.8' },
  oblique: { lens: '50mm OBLIQUE',    fstop: 'f/1.4' },
  closeup: { lens: '85mm PORTRAIT',   fstop: 'f/1.2' },
  split:   { lens: 'DUAL LENS 62/38', fstop: 'f/1.4' },
};

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

function hashUnit(seed) {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export class FocalCutDirector {
  constructor() {
    this.cutMode = 'wide';
    this.splitActive = false;
    this.cutIndex = 0;
    this.consecutiveTight = 0;
    this.lastCutAtPerf = 0;
    this.lastCutAudioMs = -99999;
    this.lastLineIdx = -1;
    this.lastUnitUi = -1;
    this.lastWallId = -1;
    this._bassAvg = 0;
    this._freqBuf = null;

    this.primary = { x: 0, y: -48, zoom: 1.0, rotX: 0, rotY: 0, rotZ: 0 };
    this.secondary = { x: 0, y: -48, zoom: 1.75, rotX: 0, rotY: 0, rotZ: 0 };
    this._renderPrimary = { ...this.primary };
    this._renderSecondary = { ...this.secondary };
    this._cutElapsedAt = 0;
    this._lastStepPerf = 0;
    this._bassLevel = 0;
    this._flareEnergy = 0;
    this._autoPolarity = 'dark';
    this._obliqueSign = 1;
  }

  reset() {
    this.cutMode = 'wide';
    this.splitActive = false;
    this.cutIndex = 0;
    this.consecutiveTight = 0;
    this.lastCutAtPerf = 0;
    this.lastCutAudioMs = -99999;
    this.lastLineIdx = -1;
    this.lastUnitUi = -1;
    this.lastWallId = -1;
    this.primary = { x: 0, y: -48, zoom: 1.0, rotX: 0, rotY: 0, rotZ: 0 };
    this.secondary = { x: 0, y: -48, zoom: 1.75, rotX: 0, rotY: 0, rotZ: 0 };
    this._renderPrimary = { ...this.primary };
    this._renderSecondary = { ...this.secondary };
    this._cutElapsedAt = 0;
    this._lastStepPerf = 0;
    this._bassLevel = 0;
    this._flareEnergy = 0;
    this._autoPolarity = 'dark';
    this._obliqueSign = 1;
  }

  /* 采样音频低频能量（用于光缝呼吸与重拍触发） */
  _sampleAudioBass() {
    try {
      const analyser = typeof window !== 'undefined' ? window.audioAnalyser : null;
      if (!analyser || typeof analyser.getByteFrequencyData !== 'function') return false;
      const len = analyser.frequencyBinCount || 0;
      if (!len) return false;
      if (!this._freqBuf || this._freqBuf.length !== len) {
        this._freqBuf = new Uint8Array(len);
      }
      analyser.getByteFrequencyData(this._freqBuf);
      const bins = Math.min(10, len);
      let sum = 0;
      for (let i = 0; i < bins; i++) sum += this._freqBuf[i];
      const bass = sum / bins / 255;
      this._bassLevel = this._bassLevel * 0.65 + bass * 0.35;
      if (this._bassAvg <= 0.001) {
        this._bassAvg = bass;
        return false;
      }
      const spike = bass > 0.32 && bass > this._bassAvg * 1.42;
      this._bassAvg = this._bassAvg * 0.88 + bass * 0.12;
      return spike;
    } catch {
      return false;
    }
  }

  /* 计算当前墙面安全适配全景倍率（保证宽银幕上下遮幅与底部字幕区留白） */
  _wideZoomForWall(wall, vw, vh) {
    if (!wall || !wall.bounds) return 1.0;
    const bw = Math.max(520, wall.bounds.w + 220);
    const bh = Math.max(300, wall.bounds.h + 240);
    const wNorm = 1920 / bw;
    const hNorm = 1080 / bh;
    const aspectBonus = (vw && vh && vw / vh < 1.35) ? 0.92 : 1.0;
    return clamp(Math.min(wNorm, hNorm) * 0.86 * aspectBonus, 0.82, 1.14);
  }

  /* 将相机焦点安全约束在当前句可读区间内，避免词句漂出画面 */
  _safeLineFocusX(activeLine, activeUnit, pullRatio) {
    if (!activeLine) return 0;
    const ux = activeUnit ? activeUnit.wx : activeLine.wx;
    const raw = activeLine.wx * (1 - pullRatio) + ux * pullRatio;
    const halfSpan = Math.max(0, activeLine.width * 0.34);
    return clamp(raw, activeLine.wx - halfSpan, activeLine.wx + halfSpan);
  }

  /**
   * 推进电影导播机位
   */
  step({ wall, activeLine, activeUnit, timeMs, nowPerf, vw, vh, settings = {} }) {
    const cutRate = settings.focalcutCutRate || 'normal';
    const allowSplit = settings.focalcutSplitLens !== false;
    const camGain = clamp(Number(settings.focalcutCamera ?? 0.9), 0.15, 1.4);
    const cooldown = CUT_COOLDOWN_MS[cutRate] || CUT_COOLDOWN_MS.normal;

    const wallChanged = !!wall && wall.id !== this.lastWallId;
    const lineChanged = !!activeLine && activeLine.lineIndex !== this.lastLineIdx;
    const unitChanged = !!activeUnit && activeUnit.ui !== this.lastUnitUi;
    const isEmoHit = !!(unitChanged && activeUnit && activeUnit.isEmotion);
    const seekJump = Math.abs(timeMs - this.lastCutAudioMs) > 2500;
    const sinceCutPerf = nowPerf - this.lastCutAtPerf;
    const beatHit = sinceCutPerf >= cooldown * 1.15 && this._sampleAudioBass();

    let shouldCut = false;
    let reason = 'hold';
    if (wallChanged || seekJump) {
      shouldCut = true;
      reason = (!wallChanged && isEmoHit) ? 'emotion' : 'wall';
    } else if (isEmoHit && sinceCutPerf >= cooldown * 0.65) {
      shouldCut = true;
      reason = 'emotion';
    } else if (lineChanged && sinceCutPerf >= cooldown * 0.72) {
      shouldCut = true;
      reason = 'line';
    } else if (beatHit && cutRate === 'intense') {
      shouldCut = true;
      reason = 'beat';
    }

    if (activeLine) this.lastLineIdx = activeLine.lineIndex;
    if (activeUnit) this.lastUnitUi = activeUnit.ui;
    if (wall) this.lastWallId = wall.id;

    const wideZoom = this._wideZoomForWall(wall, vw, vh);
    let cutTriggered = false;

    if (shouldCut && wall) {
      cutTriggered = true;
      this.cutIndex++;
      this.lastCutAtPerf = nowPerf;
      this.lastCutAudioMs = timeMs;
      this._cutElapsedAt = nowPerf;

      const u = activeUnit || (activeLine && activeLine.units[0]) || { wx: 0, wy: -48, isEmotion: false };
      const l = activeLine || { wx: 0, wy: -48, width: 420 };
      const r = hashUnit(this.cutIndex * 19 + (wall.id + 1) * 37);
      const isChorus = wall.kind === 'chorus' || wall.kind === 'lift';

      let nextMode;
      if (wallChanged) {
        /* 换墙首镜：副歌在允许分屏且奇数墙时切入 62/38 双镜，其余稳重开宽银幕全景或建筑斜拍 */
        if (isChorus && allowSplit && (wall.id % 2 === 1)) {
          nextMode = 'split';
        } else {
          nextMode = (wall.id % 3 === 2) ? 'oblique' : 'wide';
        }
      } else if (this.consecutiveTight >= 2) {
        nextMode = 'wide';
      } else if (reason === 'emotion') {
        nextMode = (allowSplit && (isChorus || this.cutIndex % 2 === 0)) ? 'split' : 'closeup';
      } else if (reason === 'line') {
        const lineStep = this.cutIndex % 4;
        if (lineStep === 0) nextMode = 'rack';
        else if (lineStep === 1) nextMode = 'oblique';
        else if (lineStep === 2) nextMode = 'track';
        else nextMode = (allowSplit && isChorus) ? 'split' : 'wide';
      } else if (r < 0.35) {
        nextMode = 'oblique';
      } else if (r < 0.68) {
        nextMode = 'track';
      } else {
        nextMode = 'closeup';
      }

      if (nextMode === 'closeup') this.consecutiveTight++;
      else this.consecutiveTight = 0;

      this.cutMode = nextMode;
      this.splitActive = (nextMode === 'split' && allowSplit);
      this._obliqueSign = (this.cutIndex % 2 === 0) ? 1 : -1;
      this._flareEnergy = (reason === 'emotion' || nextMode === 'closeup' || nextMode === 'split') ? 1.0 : 0.55;

      /* 极性只随乐段换墙切换，杜绝句内频闪 */
      if (wallChanged || this.cutIndex === 1) {
        this._autoPolarity = wall.polarity || 'dark';
      }

      const cxWall = wall.bounds ? wall.bounds.cx : 0;
      const cyWall = wall.bounds ? wall.bounds.cy : -48;

      if (nextMode === 'closeup') {
        this.primary = {
          x: this._safeLineFocusX(l, u, 0.52),
          y: l.wy,
          zoom: clamp(1.32 + 0.18 * camGain, 1.24, 1.56),
          rotX: 2.2 * camGain,
          rotY: -this._obliqueSign * 5.2 * camGain,
          rotZ: 0,
        };
      } else if (nextMode === 'oblique') {
        this.primary = {
          x: cxWall * 0.72 + l.wx * 0.28,
          y: cyWall * 0.45 + l.wy * 0.55,
          zoom: clamp(wideZoom * (0.96 + 0.05 * camGain), 0.86, 1.12),
          rotX: this._obliqueSign * 2.8 * camGain,
          rotY: -this._obliqueSign * 6.8 * camGain,
          rotZ: this._obliqueSign * 0.8 * camGain,
        };
      } else if (nextMode === 'track') {
        this.primary = {
          x: this._safeLineFocusX(l, u, 0.42),
          y: l.wy * 0.80 + cyWall * 0.20,
          zoom: clamp(wideZoom * (1.14 + 0.08 * camGain), 1.02, 1.30),
          rotX: 0,
          rotY: -this._obliqueSign * 3.2 * camGain,
          rotZ: 0,
        };
      } else if (nextMode === 'rack') {
        this.primary = {
          x: l.wx * 0.72 + cxWall * 0.28,
          y: l.wy * 0.82 + cyWall * 0.18,
          zoom: clamp(wideZoom * 1.12, 0.98, 1.26),
          rotX: 0,
          rotY: 0,
          rotZ: 0,
        };
      } else if (nextMode === 'split') {
        this.primary = {
          x: cxWall * 0.70 + l.wx * 0.30,
          y: cyWall * 0.55 + l.wy * 0.45,
          zoom: clamp(wideZoom * 1.04, 0.90, 1.22),
          rotX: 2.8 * camGain,
          rotY: -7.5 * camGain,
          rotZ: -0.9 * camGain,
        };
        this.secondary = {
          x: u.wx,
          y: u.wy,
          zoom: clamp(1.68 + 0.24 * camGain, 1.56, 2.02),
          rotX: 0,
          rotY: 0,
          rotZ: 0,
        };
      } else {
        this.primary = {
          x: cxWall,
          y: cyWall,
          zoom: wideZoom,
          rotX: 0,
          rotY: 0,
          rotZ: 0,
        };
      }
    }

    const dt = this._lastStepPerf > 0 ? clamp((nowPerf - this._lastStepPerf) / 1000, 0.001, 0.06) : 0.016;
    this._lastStepPerf = nowPerf;
    this._flareEnergy = Math.max(0, this._flareEnergy - dt * 1.25);

    /* 持续平滑追踪当前演唱字（有界，绝不飘出画面） */
    if (activeLine && activeUnit) {
      if (this.cutMode === 'track' || this.cutMode === 'closeup') {
        const pull = this.cutMode === 'closeup' ? 0.55 : 0.42;
        const desiredX = this._safeLineFocusX(activeLine, activeUnit, pull);
        this.primary.x += (desiredX - this.primary.x) * (1 - Math.exp(-dt * 4.5));
        this.primary.y += (activeLine.wy - this.primary.y) * (1 - Math.exp(-dt * 5.0));
      } else if (this.cutMode === 'rack' || this.cutMode === 'oblique') {
        const desiredY = activeLine.wy * 0.72 + (wall && wall.bounds ? wall.bounds.cy : -48) * 0.28;
        this.primary.y += (desiredY - this.primary.y) * (1 - Math.exp(-dt * 3.8));
      }
      if (this.splitActive) {
        this.secondary.x += (activeUnit.wx - this.secondary.x) * (1 - Math.exp(-dt * 9.0));
        this.secondary.y += (activeUnit.wy - this.secondary.y) * (1 - Math.exp(-dt * 9.0));
      }
    }

    /* 有界电影推镜呼吸（最大 +4.5%，配合微幅竖向浮动） */
    const secSinceCut = clamp((nowPerf - this._cutElapsedAt) / 1000, 0, 8);
    const dollyBreath = (1 - Math.exp(-secSinceCut * 0.42)) * 0.042 * camGain;
    const microFloatY = Math.sin(timeMs * 0.00085) * 3.2 * camGain;

    const targetPrimary = {
      x: this.primary.x,
      y: this.primary.y + microFloatY,
      zoom: this.primary.zoom + dollyBreath,
      rotX: this.primary.rotX,
      rotY: this.primary.rotY,
      rotZ: this.primary.rotZ,
    };

    const springSpeed = secSinceCut < 0.35 ? 10.5 : 7.2;
    const alpha = seekJump ? 1 : (1 - Math.exp(-dt * springSpeed));
    for (const k of ['x', 'y', 'zoom', 'rotX', 'rotY', 'rotZ']) {
      this._renderPrimary[k] += (targetPrimary[k] - this._renderPrimary[k]) * alpha;
      this._renderSecondary[k] += (this.secondary[k] - this._renderSecondary[k]) * alpha;
    }

    /* 光学拉焦呼吸：切镜时 140ms 极轻柔和收焦，不糊主字 */
    const rackAge = nowPerf - this._cutElapsedAt;
    const rackProgress = rackAge < 140 ? Math.pow(1 - rackAge / 140, 1.8) : 0;

    const meta = SHOT_META[this.cutMode] || SHOT_META.wide;
    return {
      cutTriggered,
      wallChanged,
      mode: this.cutMode,
      lensLabel: meta.lens,
      fstop: meta.fstop,
      polarity: this._autoPolarity,
      bassEnergy: this._bassLevel,
      flareEnergy: clamp(this._flareEnergy + this._bassLevel * 0.45, 0, 1.25),
      splitActive: this.splitActive,
      rackProgress,
      primary: { ...this._renderPrimary },
      secondary: { ...this._renderSecondary },
    };
  }
}
