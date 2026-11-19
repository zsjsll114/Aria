/* ============================================================
 * FocalCutVisualizer.js — 「镜幕 · FocalCut」宽银幕电影导演监看台 × 光学光缝动态排版
 *
 * 核心视觉语言：
 *   1. 2.39:1 变形宽银幕画幅：封面浸染曜石暗房 ↔ 银盐画廊暖纸（仅乐段切换，零频闪）
 *      + 追踪当前演唱行的横向变形光缝（Anamorphic Light Slit）与实时 SMPTE 镜头遥测；
 *   2. 双层裁切光学扫字（零锯齿描边）：底字磨砂墨层 + `clip-path` 像素锐利高光层左向右推进，
 *      当前行焦平面抬升，非当前行退入光学景深（Rack Focus）；
 *   3. 电影运动控制云台：6 种有意识运镜（24mm 宽景 / 50mm 拉焦 / 35mm 滑轨 /
 *      50mm 建筑斜拍 / 85mm 情感特写 / 62:38 反色双镜滑幕分屏）；
 *   4. 底部译文脱离世界画布，始终在安全区稳态居中。
 * ============================================================ */

import { VisualizerBase } from './VisualizerBase.js';
import { mvBackdropAlpha, onMvBackdropChange } from './mvBackdrop.js';
import { extractCoverColors, buildFocalCutTheme } from './focalcut/focalcutPalette.js';
import { compileFocalCutWalls, WORLD_W, WORLD_H } from './focalcut/focalcutLayout.js';
import { FocalCutDirector } from './focalcut/focalcutCamera.js';
import { esc } from '../../utils/formatters.js';
import { logCatch } from '../../services/log.js';

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

function formatTimecode(ms) {
  const safe = Math.max(0, Number(ms) || 0);
  const totalSec = Math.floor(safe / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  const ff = String(Math.floor((safe % 1000) / 41.667)).padStart(2, '0');
  return `${mm}:${ss}:${ff}`;
}

export class FocalCutVisualizer extends VisualizerBase {
  constructor(container, options = {}) {
    super(container, options);
    this.director = new FocalCutDirector();
    this.walls = [];
    this.lineToWall = new Map();
    this.activeWallId = -1;
    this.activePolarity = 'dark';
    this.coverColors = { primaryHex: '#E8BE6A', secondaryHex: '#68AEE8' };
    this._unitRefs = [];
    this._lineRefs = [];
    this._lastTransKey = '';
    this._lastTcBucket = -1;
    this._lastLensText = '';
    this._lastSceneText = '';
    this._slitYNorm = 0.5;
    this._perfLow = false;
    this._unsubBackdrop = null;
  }

  getModeId() { return 'focalcut'; }

  onInit() {
    this.viewContainer.classList.add('fc-stage');
    this.viewContainer.innerHTML = `
      <div class="fc-wall-backdrop" aria-hidden="true"></div>
      <div class="fc-wash fc-wash-a" aria-hidden="true"></div>
      <div class="fc-wash fc-wash-b" aria-hidden="true"></div>
      <div class="fc-watermark" aria-hidden="true"><span class="fc-watermark-glyph"></span></div>
      <div class="fc-anamorphic-slit" aria-hidden="true">
        <div class="fc-slit-halo"></div>
        <div class="fc-slit-core"></div>
      </div>
      <div class="fc-cinema-frame" aria-hidden="true">
        <div class="fc-bar fc-bar-top"></div>
        <div class="fc-bar fc-bar-bot"></div>
        <i class="fc-corner fc-c-tl"></i><i class="fc-corner fc-c-tr"></i>
        <i class="fc-corner fc-c-bl"></i><i class="fc-corner fc-c-br"></i>
        <div class="fc-telemetry fc-telemetry-top">
          <span class="fc-rec-dot"></span>
          <span class="fc-tc">00:00:00</span>
          <span class="fc-sep">·</span>
          <span class="fc-lens">24mm ANAMORPHIC</span>
          <span class="fc-sep">·</span>
          <span class="fc-fstop">f/2.0</span>
        </div>
        <div class="fc-telemetry fc-telemetry-bot">
          <span class="fc-scene-tag">SCENE 01 · VERSE</span>
        </div>
      </div>
      <div class="fc-viewports">
        <div class="fc-viewport fc-viewport-main">
          <div class="fc-cam-rig fc-cam-main">
            <div class="fc-world fc-world-main"></div>
          </div>
        </div>
        <div class="fc-viewport fc-viewport-sub">
          <div class="fc-split-divider" aria-hidden="true"></div>
          <div class="fc-cam-rig fc-cam-sub">
            <div class="fc-world fc-world-sub"></div>
          </div>
          <div class="fc-hud-sub" aria-hidden="true">CAM B · MACRO 1.8×</div>
        </div>
      </div>
      <div class="fc-shutter" aria-hidden="true"></div>
      <div class="fc-subtitles" aria-hidden="true">
        <div class="fc-trans"></div>
        <div class="fc-romaji"></div>
      </div>`;

    this._mainVp = this.viewContainer.querySelector('.fc-viewport-main');
    this._subVp = this.viewContainer.querySelector('.fc-viewport-sub');
    this._mainRig = this.viewContainer.querySelector('.fc-cam-main');
    this._subRig = this.viewContainer.querySelector('.fc-cam-sub');
    this._mainWorld = this.viewContainer.querySelector('.fc-world-main');
    this._subWorld = this.viewContainer.querySelector('.fc-world-sub');
    this._hudSub = this.viewContainer.querySelector('.fc-hud-sub');
    this._tcEl = this.viewContainer.querySelector('.fc-tc');
    this._lensEl = this.viewContainer.querySelector('.fc-lens');
    this._fstopEl = this.viewContainer.querySelector('.fc-fstop');
    this._sceneEl = this.viewContainer.querySelector('.fc-scene-tag');
    this._shutter = this.viewContainer.querySelector('.fc-shutter');
    this._washA = this.viewContainer.querySelector('.fc-wash-a');
    this._washB = this.viewContainer.querySelector('.fc-wash-b');
    this._slitEl = this.viewContainer.querySelector('.fc-anamorphic-slit');
    this._watermarkEl = this.viewContainer.querySelector('.fc-watermark');
    this._watermarkGlyphEl = this.viewContainer.querySelector('.fc-watermark-glyph');
    this._transEl = this.viewContainer.querySelector('.fc-trans');
    this._romaEl = this.viewContainer.querySelector('.fc-romaji');

    this._syncBackdropAlpha();
    if (!this._unsubBackdrop) {
      this._unsubBackdrop = onMvBackdropChange(() => this._syncBackdropAlpha());
    }
    this._refreshCoverColors();
    this._applyTheme('dark');
  }

  _syncBackdropAlpha() {
    if (!this.viewContainer) return;
    const alpha = mvBackdropAlpha(this.container);
    this.viewContainer.style.setProperty('--fc-wall-alpha', alpha.toFixed(3));
  }

  _refreshCoverColors() {
    const fallback = (this.settings && (this.settings.highlightColor || this.settings.themeColor)) || this.themeColor || '#E8BE6A';
    this.coverColors = extractCoverColors(fallback);
  }

  _applyTheme(polarity) {
    if (!this.viewContainer) return;
    const pref = (this.settings && this.settings.focalcutPolarity) || 'auto';
    const eff = pref === 'light' ? 'light' : (pref === 'dark' ? 'dark' : polarity);
    this.activePolarity = eff;
    const theme = buildFocalCutTheme(eff, this.coverColors);
    const inv = theme.inv;
    const st = this.viewContainer.style;
    const userHl = (this.settings && this.settings.highlightColor) || '';

    st.setProperty('--fc-bg', theme.wallBg);
    st.setProperty('--fc-surface', theme.wallSurface);
    st.setProperty('--fc-edge', theme.wallEdge);
    st.setProperty('--fc-grid', theme.gridLine);
    st.setProperty('--fc-crosshair', theme.crosshair);
    st.setProperty('--fc-unlit', theme.unlitText);
    st.setProperty('--fc-lit', theme.litText);
    st.setProperty('--fc-past', theme.pastText);
    st.setProperty('--fc-accent', userHl || theme.accent);
    st.setProperty('--fc-accent-ink', theme.accentInk);
    st.setProperty('--fc-secondary', theme.secondary);
    st.setProperty('--fc-beam', theme.beamColor);
    st.setProperty('--fc-slit', userHl || theme.slitColor);
    st.setProperty('--fc-shutter-bg', theme.shutterBg);

    /* 副视口反色令牌（暗底 ↔ 银盐暖纸实时对照） */
    st.setProperty('--fc-inv-bg', inv.wallBg);
    st.setProperty('--fc-inv-surface', inv.wallSurface);
    st.setProperty('--fc-inv-lit', inv.litText);
    st.setProperty('--fc-inv-unlit', inv.unlitText);
    st.setProperty('--fc-inv-past', inv.pastText);
    st.setProperty('--fc-inv-accent', inv.accent);
    st.setProperty('--fc-inv-crosshair', inv.crosshair);
    st.setProperty('--fc-inv-grid', inv.gridLine);

    this.viewContainer.classList.toggle('is-light-wall', eff === 'light');
  }

  onApplySettings(settings = {}) {
    if (!this.viewContainer) return;
    const fs = parseFloat(settings.fontSize);
    if (fs > 0) {
      const scale = fs >= 8 ? fs / 56 : fs;
      this.viewContainer.style.setProperty('--fc-font-scale', clamp(scale, 0.55, 1.75).toFixed(3));
    }
    this.viewContainer.classList.toggle('hide-guides', settings.focalcutGuides === false);
    this.viewContainer.classList.toggle('fc-no-rack', settings.focalcutRackFocus === false);
    this._showTranslation = settings.showTranslation !== false;
    this._showRomaji = settings.showRomaji !== false;
    if (settings.highlightColor) {
      this.viewContainer.style.setProperty('--fc-accent', settings.highlightColor);
      this.viewContainer.style.setProperty('--fc-slit', settings.highlightColor);
    }
    if (settings.focalcutPolarity) {
      const wall = this.walls[this.activeWallId];
      this._applyTheme(wall ? wall.polarity : 'dark');
    }
    if (this._transEl) this._transEl.style.display = (this._showTranslation && this._transEl.textContent) ? '' : 'none';
    if (this._romaEl) this._romaEl.style.display = (this._showRomaji && this._romaEl.textContent) ? '' : 'none';
  }

  setPerfConfig(cfg = {}) {
    const v = cfg.vfx || {};
    this._perfLow = (v.renderScale && v.renderScale < 0.75) || (cfg.dimension && cfg.dimension.fps && cfg.dimension.fps <= 24);
    if (this.viewContainer) {
      this.viewContainer.classList.toggle('fc-perf-lite', !!this._perfLow);
    }
  }

  onLyricsLoaded() {
    this._refreshCoverColors();
    this.director.reset();
    this.activeWallId = -1;
    this._lastTransKey = '';
    this._lastLensText = '';
    this._lastSceneText = '';
    if (!this.lines || !this.lines.length) {
      this.walls = [];
      this.lineToWall = new Map();
      if (this._mainWorld) this._mainWorld.innerHTML = '';
      if (this._subWorld) this._subWorld.innerHTML = '';
      return;
    }
    const compiled = compileFocalCutWalls(this.lines, this.aiData);
    this.walls = compiled.walls || [];
    this.lineToWall = compiled.lineToWall || new Map();
    if (this.walls.length > 0) {
      this._mountWall(this.walls[0], false);
    }
  }

  _triggerShutter() {
    if (!this._shutter || this._perfLow) return;
    this._shutter.classList.remove('is-sweeping');
    void this._shutter.offsetWidth;
    this._shutter.classList.add('is-sweeping');
  }

  /* 渲染整面电影展墙到主/副两个世界画布，建立毫秒同频字元索引 */
  _mountWall(wall, animateShutter = true) {
    if (!wall || !this._mainWorld || !this._subWorld) return;
    const prevPol = this.activePolarity;
    this._applyTheme(wall.polarity);
    if (animateShutter && (this.activeWallId >= 0 || prevPol !== this.activePolarity)) {
      this._triggerShutter();
    }
    this.activeWallId = wall.id;
    this._unitRefs = [];
    this._lineRefs = [];

    if (this._watermarkGlyphEl) {
      this._watermarkGlyphEl.textContent = wall.watermarkGlyph || '';
    }
    const sceneLabel = `SCENE ${String(wall.id + 1).padStart(2, '0')} · ${String(wall.kind || 'verse').toUpperCase()}`;
    if (this._sceneEl && sceneLabel !== this._lastSceneText) {
      this._lastSceneText = sceneLabel;
      this._sceneEl.textContent = sceneLabel;
    }

    const buildWorldHtml = () => {
      const b = wall.bounds;
      const bTop = WORLD_H / 2 + b.minY - 38;
      const bH = b.h + 76;
      const axisX = wall.archetype === 'gallery-right'
        ? (WORLD_W / 2 + b.maxX + 42)
        : (wall.archetype === 'cinema-center' ? (WORLD_W / 2 + b.minX - 54) : (WORLD_W / 2 + b.minX - 42));

      const guides = `
        <div class="fc-world-grid"></div>
        <div class="fc-axis-rail" style="left:${axisX.toFixed(1)}px;top:${bTop.toFixed(1)}px;height:${bH.toFixed(1)}px;"></div>
        <div class="fc-horizon-rule" style="top:${(WORLD_H / 2 + b.cy).toFixed(1)}px;"></div>`;

      let linesHtml = '';
      for (const ln of wall.lines) {
        const lx = WORLD_W / 2 + ln.leftX;
        const ly = WORLD_H / 2 + ln.wy;
        const cls = `fc-line ${ln.isFocal ? 'is-focal' : 'is-support'} fc-align-${ln.align}`;
        let unitsHtml = '';
        let inEmoGroup = false;
        const closeEmo = () => { if (inEmoGroup) { unitsHtml += '</span>'; inEmoGroup = false; } };

        for (const u of ln.units) {
          if (u.isSpace) {
            closeEmo();
            unitsHtml += `<span class="fc-unit fc-space" data-u="${ln.lineIndex}_${u.ui}">\u00A0</span>`;
          } else {
            if (u.isEmotion && !inEmoGroup) {
              unitsHtml += '<span class="fc-emo-word">';
              inEmoGroup = true;
            } else if (!u.isEmotion && inEmoGroup) {
              closeEmo();
            }
            const uCls = `fc-unit fc-char is-unlit${u.isEmotion ? ' is-emotion' : ''}`;
            const safeTxt = esc(u.text);
            unitsHtml += `<span class="${uCls}" data-u="${ln.lineIndex}_${u.ui}" data-text="${safeTxt}">${safeTxt}</span>`;
          }
        }
        closeEmo();
        linesHtml += `<div class="${cls}" data-line="${ln.lineIndex}" style="left:${lx.toFixed(1)}px;top:${ly.toFixed(1)}px;font-size:${ln.fontSize.toFixed(1)}px;font-weight:${ln.weight};">${unitsHtml}</div>`;
      }
      return guides + linesHtml;
    };

    const html = buildWorldHtml();
    this._mainWorld.innerHTML = html;
    this._subWorld.innerHTML = html;

    const mainUnits = new Map();
    const subUnits = new Map();
    for (const el of this._mainWorld.querySelectorAll('.fc-unit[data-u]')) {
      mainUnits.set(el.dataset.u, el);
    }
    for (const el of this._subWorld.querySelectorAll('.fc-unit[data-u]')) {
      subUnits.set(el.dataset.u, el);
    }

    for (const ln of wall.lines) {
      const mLine = this._mainWorld.querySelector(`.fc-line[data-line="${ln.lineIndex}"]`);
      const sLine = this._subWorld.querySelector(`.fc-line[data-line="${ln.lineIndex}"]`);
      this._lineRefs.push({ lineIndex: ln.lineIndex, start: ln.start, end: ln.end, mLine, sLine });
      for (const u of ln.units) {
        if (u.isSpace) continue;
        const key = `${ln.lineIndex}_${u.ui}`;
        const mEl = mainUnits.get(key);
        const sEl = subUnits.get(key);
        if (mEl) {
          this._unitRefs.push({
            mEl,
            sEl,
            lineIndex: ln.lineIndex,
            start: u.start,
            end: u.end,
            isEmotion: u.isEmotion,
            lastState: '',
            lastPct: -1,
          });
        }
      }
    }
  }

  _applyCameraToRig(rigEl, cam, vpW, vpH, rackPx, useHeightBase = false) {
    if (!rigEl || !cam) return;
    const baseScale = useHeightBase
      ? ((vpH || 720) / WORLD_H)
      : Math.min((vpW || 1280) / WORLD_W, (vpH || 720) / WORLD_H);
    const effZoom = clamp((cam.zoom || 1) * baseScale * 1.12, 0.32, 4.5);
    const tx = -cam.x * effZoom;
    const ty = -cam.y * effZoom;
    const rx = Math.abs(cam.rotX || 0) > 0.04 ? ` rotateX(${cam.rotX.toFixed(2)}deg)` : '';
    const ry = Math.abs(cam.rotY || 0) > 0.04 ? ` rotateY(${cam.rotY.toFixed(2)}deg)` : '';
    const rz = Math.abs(cam.rotZ || 0) > 0.04 ? ` rotateZ(${cam.rotZ.toFixed(2)}deg)` : '';
    rigEl.style.transform = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0px)${rx}${ry}${rz} scale(${effZoom.toFixed(4)})`;
    rigEl.style.filter = (rackPx > 0.12 && !this._perfLow) ? `blur(${rackPx.toFixed(2)}px)` : '';
  }

  onUpdate(timeMs, _timeSec, activeIdx) {
    if (!this.walls.length || !this.viewContainer) return;

    const lineIdx = activeIdx >= 0 ? activeIdx : 0;
    const wallIdx = this.lineToWall.has(lineIdx) ? this.lineToWall.get(lineIdx) : 0;
    const wall = this.walls[wallIdx] || this.walls[0];
    if (!wall) return;

    if (wall.id !== this.activeWallId) {
      this._mountWall(wall, true);
    }

    const activeLine = wall.lines.find(l => l.lineIndex === lineIdx) || wall.lines[0];
    let activeUnit = null;
    if (activeLine && activeLine.units.length) {
      for (const u of activeLine.units) {
        if (u.isSpace) continue;
        if (timeMs >= u.start && timeMs <= u.end) { activeUnit = u; break; }
        if (timeMs >= u.start) activeUnit = u;
      }
      if (!activeUnit) activeUnit = activeLine.units.find(u => !u.isSpace) || activeLine.units[0];
    }

    /* 1. 连续时间轴三态推进（主/副视口毫秒锁相） */
    for (const lr of this._lineRefs) {
      const isCur = lr.lineIndex === lineIdx;
      const isPast = timeMs > lr.end;
      if (lr.mLine) {
        lr.mLine.classList.toggle('is-current', isCur);
        lr.mLine.classList.toggle('is-past-line', !isCur && isPast);
      }
      if (lr.sLine) {
        lr.sLine.classList.toggle('is-current', isCur);
        lr.sLine.classList.toggle('is-past-line', !isCur && isPast);
      }
    }

    for (const ref of this._unitRefs) {
      let state = 'unlit';
      let pct = 0;
      if (timeMs >= ref.end) {
        state = 'past';
        pct = 100;
      } else if (timeMs >= ref.start) {
        state = 'active';
        pct = Math.round(clamp((timeMs - ref.start) / Math.max(1, ref.end - ref.start), 0, 1) * 100);
      }
      if (state !== ref.lastState) {
        ref.lastState = state;
        const setCls = (el) => {
          if (!el) return;
          el.classList.toggle('is-unlit', state === 'unlit');
          el.classList.toggle('is-active', state === 'active');
          el.classList.toggle('is-past', state === 'past');
        };
        setCls(ref.mEl);
        setCls(ref.sEl);
      }
      if (pct !== ref.lastPct) {
        ref.lastPct = pct;
        const pStr = `${pct}%`;
        if (ref.mEl) ref.mEl.style.setProperty('--fc-p', pStr);
        if (ref.sEl) ref.sEl.style.setProperty('--fc-p', pStr);
      }
    }

    /* 2. 电影云台平滑推进 */
    const vw = this.viewContainer.clientWidth || 1280;
    const vh = this.viewContainer.clientHeight || 720;
    const nowPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const camState = this.director.step({
      wall,
      activeLine,
      activeUnit,
      timeMs,
      nowPerf,
      vw,
      vh,
      settings: this.settings,
    });

    const isSplit = !!(camState.splitActive && !this._perfLow && vw >= 540);
    this.viewContainer.classList.toggle('is-split', isSplit);
    const rackEnabled = !(this.settings && this.settings.focalcutRackFocus === false);
    const rackPx = rackEnabled ? camState.rackProgress * 1.1 : 0;

    if (camState.wallChanged && camState.polarity && camState.polarity !== this.activePolarity) {
      const pref = (this.settings && this.settings.focalcutPolarity) || 'auto';
      if (pref === 'auto') {
        this._applyTheme(camState.polarity);
      }
    }

    /* 3. 变形光缝对齐当前演唱行 + 远景视差氛围层 */
    const mainW = isSplit ? vw * 0.62 : vw;
    const baseScale = Math.min(mainW / WORLD_W, vh / WORLD_H);
    const effZoom = clamp((camState.primary.zoom || 1) * baseScale * 1.12, 0.32, 4.5);

    if (!this._perfLow) {
      const pCam = camState.primary;
      const flare = clamp(camState.flareEnergy || 0, 0, 1.25);

      if (this._slitEl && activeLine) {
        const lineScreenY = vh * 0.5 + (activeLine.wy - pCam.y) * effZoom;
        const targetNorm = clamp(lineScreenY / Math.max(1, vh), 0.22, 0.72);
        this._slitYNorm += (targetNorm - this._slitYNorm) * 0.14;
        const slitOp = clamp(0.46 + flare * 0.38 + (activeUnit && activeUnit.isEmotion ? 0.18 : 0), 0.35, 1.0);
        this._slitEl.style.top = `${(this._slitYNorm * 100).toFixed(2)}%`;
        this._slitEl.style.opacity = slitOp.toFixed(3);
      }

      if (this._washA) {
        const ox = -pCam.x * 0.10 + Math.sin(timeMs * 0.00055) * 32;
        const oy = -pCam.y * 0.10 + Math.cos(timeMs * 0.00042) * 24;
        const os = 1 + flare * 0.14;
        this._washA.style.transform = `translate3d(${ox.toFixed(1)}px, ${oy.toFixed(1)}px, 0) scale(${os.toFixed(3)})`;
      }
      if (this._washB) {
        const ox = pCam.x * 0.08 + Math.cos(timeMs * 0.00048) * 38;
        const oy = pCam.y * 0.08 + Math.sin(timeMs * 0.00036) * 28;
        const os = 1 + flare * 0.10;
        this._washB.style.transform = `translate3d(${ox.toFixed(1)}px, ${oy.toFixed(1)}px, 0) scale(${os.toFixed(3)})`;
      }
      if (this._watermarkEl) {
        const wx = -pCam.x * 0.09;
        const wy = -pCam.y * 0.08;
        this._watermarkEl.style.transform = `translate3d(${wx.toFixed(1)}px, ${wy.toFixed(1)}px, 0)`;
      }
    }

    this._applyCameraToRig(this._mainRig, camState.primary, mainW, vh, rackPx, false);
    if (isSplit) {
      this._applyCameraToRig(this._subRig, camState.secondary, vw * 0.38, vh, rackPx * 0.45, true);
    }

    /* 4. 实时 SMPTE 电影时间码与镜头遥测 */
    const tcBucket = Math.floor(Math.max(0, timeMs) / 80);
    if (this._tcEl && tcBucket !== this._lastTcBucket) {
      this._lastTcBucket = tcBucket;
      this._tcEl.textContent = formatTimecode(timeMs);
    }
    if (camState.lensLabel && camState.lensLabel !== this._lastLensText) {
      this._lastLensText = camState.lensLabel;
      if (this._lensEl) this._lensEl.textContent = camState.lensLabel;
      if (this._fstopEl) this._fstopEl.textContent = camState.fstop || 'f/1.4';
    }
    if (this._hudSub && isSplit) {
      this._hudSub.textContent = `CAM B · MACRO ${camState.secondary.zoom.toFixed(1)}×`;
    }

    /* 5. 底部独立稳态译文 */
    if (activeLine) {
      const tKey = `${activeLine.lineIndex}|${activeLine.translation}|${activeLine.romaji}`;
      if (tKey !== this._lastTransKey) {
        this._lastTransKey = tKey;
        if (this._transEl) {
          this._transEl.textContent = activeLine.translation || '';
          this._transEl.style.display = (this._showTranslation !== false && activeLine.translation) ? '' : 'none';
        }
        if (this._romaEl) {
          this._romaEl.textContent = activeLine.romaji || '';
          this._romaEl.style.display = (this._showRomaji !== false && activeLine.romaji) ? '' : 'none';
        }
      }
    }
  }

  /** 海报抓帧前将当前墙/目标行定格到电影级清晰构图 */
  stageForPoster(targetLineIndex) {
    if (!this.viewContainer || !this.walls.length) return null;
    const prevIdx = this.activeLineIndex;
    const idx = (Number.isInteger(targetLineIndex) && targetLineIndex >= 0 && targetLineIndex < this.lines.length)
      ? targetLineIndex
      : Math.max(0, prevIdx);
    const wallIdx = this.lineToWall.has(idx) ? this.lineToWall.get(idx) : 0;
    const wall = this.walls[wallIdx] || this.walls[0];
    if (!wall) return null;

    this._mountWall(wall, false);
    const savedSplit = this.viewContainer.classList.contains('is-split');
    this.viewContainer.classList.remove('is-split');

    const activeLine = wall.lines.find(l => l.lineIndex === idx) || wall.lines[0];
    for (const lr of this._lineRefs) {
      const isCur = lr.lineIndex === idx;
      if (lr.mLine) {
        lr.mLine.classList.toggle('is-current', isCur);
        lr.mLine.classList.toggle('is-past-line', false);
      }
    }
    for (const ref of this._unitRefs) {
      if (!ref.mEl) continue;
      const onCur = ref.lineIndex === idx;
      ref.mEl.classList.toggle('is-unlit', !onCur);
      ref.mEl.classList.toggle('is-active', false);
      ref.mEl.classList.toggle('is-past', onCur);
      ref.mEl.style.setProperty('--fc-p', onCur ? '100%' : '0%');
    }

    const vw = this.viewContainer.clientWidth || 1280;
    const vh = this.viewContainer.clientHeight || 720;
    const wideZoom = this.director._wideZoomForWall(wall, vw, vh);
    this._applyCameraToRig(this._mainRig, {
      x: wall.bounds ? wall.bounds.cx : 0,
      y: activeLine ? (activeLine.wy * 0.45 + (wall.bounds ? wall.bounds.cy : -48) * 0.55) : -48,
      zoom: wideZoom * 1.04,
      rotX: 0, rotY: 0, rotZ: 0,
    }, vw, vh, 0);

    if (this._slitEl) {
      this._slitEl.style.top = '48%';
      this._slitEl.style.opacity = '0.72';
    }

    return () => {
      if (savedSplit) this.viewContainer.classList.add('is-split');
      try {
        const audioEl = typeof document !== 'undefined' ? document.getElementById('audioPlayer') : null;
        this.update(audioEl ? Number(audioEl.currentTime) || 0 : 0);
      } catch (_e) { logCatch('FocalCutVisualizer', _e); }
    };
  }

  start() {
    super.start();
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (this.director) {
      this.director._lastStepPerf = now;
      this.director._cutElapsedAt = now - 1000;
    }
  }

  destroy() {
    if (typeof this._unsubBackdrop === 'function') {
      try { this._unsubBackdrop(); } catch { /* 卸载清理忽略 */ }
      this._unsubBackdrop = null;
    }
    super.destroy();
  }
}
