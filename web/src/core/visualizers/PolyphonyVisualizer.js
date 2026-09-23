import { VisualizerBase } from './VisualizerBase.js';

/**
 * PolyphonyVisualizer.js
 * 和鸣模式 (Polyphony / Dialogue Visualizer)
 * 核心特征：多声部气泡对话流、歌手音轨徽章、主唱/伴唱分栏与声波律动
 */
export class PolyphonyVisualizer extends VisualizerBase {
  getModeId() {
    return 'polyphony';
  }

  onInit() {
    this.viewContainer.classList.add('vis-polyphony-view');

    // 1. 对话气泡流舞台
    this.stage = document.createElement('div');
    this.stage.className = 'vis-polyphony-stage';
    this.viewContainer.appendChild(this.stage);

    // 2. 底部翻译
    this.transEl = document.createElement('div');
    this.transEl.className = 'vis-polyphony-trans';
    this.viewContainer.appendChild(this.transEl);
  }

  onLyricsLoaded() {
    this._renderBubbles();
    if (this.lines.length > 0) {
      this.onLineChange(0, this.lines[0]);
    }
  }

  applySettings(settings = {}) {
    super.applySettings(settings);
    if (settings.highlightColor && this.viewContainer) {
      this.viewContainer.style.setProperty('--vis-highlight-color', settings.highlightColor);
    }
    if (settings.emotionGlow !== undefined && this.viewContainer) {
      this.viewContainer.style.setProperty('--emotion-glow', `${parseFloat(settings.emotionGlow) || 10}px`);
    }
  }

  /**
   * ★ 性能分档消费：低性能/无 GPU 设备上
   * 1) 情感词发光强度降级（text-shadow glow 是每帧合成开销，minimal 直接归零）；
   * 2) 远端气泡仅保留布局占位（visibility:hidden 不参与绘制，避免整页气泡全量合成）。
   * @param {Object} cfg { polyphony: { maxBubbles, glow }, vfx: { polyGlow } }
   */
  setPerfConfig(cfg = {}) {
    const p = cfg.polyphony || {};
    const v = cfg.vfx || {};
    this._perf = {
      maxBubbles: p.maxBubbles || 0,
      glow: (v.polyGlow !== undefined ? v.polyGlow : p.glow) ?? 10,
    };
    if (this.viewContainer && this.viewContainer.style) {
      this.viewContainer.style.setProperty('--emotion-glow', `${this._perf.glow}px`);
    }
  }

  /** 距离当前行超出 maxBubbles 窗口的气泡隐藏绘制（保留空间），低档生效 */
  _applyBubbleWindow(lineIndex) {
    if (!this.lineEls || !this._perf) return;
    const maxB = this._perf.maxBubbles || 0;
    if (maxB <= 0) return;
    const half = Math.max(2, Math.floor(maxB / 2));
    this.lineEls.forEach((el, idx) => {
      if (el && el.style) {
        const hide = Math.abs(idx - lineIndex) > half;
        el.style.visibility = hide ? 'hidden' : '';
      }
    });
  }

  _renderBubbles() {
    if (!this.stage) return;
    this.stage.innerHTML = '';
    this.lineEls = [];

    const rawEmotionWords = (this.aiData && this.aiData.emotion_words) || 
                            (typeof window !== 'undefined' && window.aiEmotionWords) || [];
    const emotionMap = new Map();
    rawEmotionWords.forEach(ew => {
      if (typeof ew === 'string' && ew.trim()) {
        emotionMap.set(ew.trim().toLowerCase(), '#ff2a6d');
      } else if (ew && typeof ew === 'object' && ew.word) {
        emotionMap.set(ew.word.trim().toLowerCase(), ew.color || '#ff2a6d');
      }
    });

    const avatarSvgs = [
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>'
    ];

    this.lines.forEach((line, idx) => {
      const isRight = idx % 2 === 1;
      const bubbleCard = document.createElement('div');
      bubbleCard.className = `vis-polyphony-bubble ${isRight ? 'align-right' : 'align-left'}`;
      bubbleCard.dataset.index = idx;

      // 声部头像与标签
      const avatarEl = document.createElement('div');
      avatarEl.className = 'vis-polyphony-avatar';
      avatarEl.innerHTML = avatarSvgs[idx % avatarSvgs.length];
      bubbleCard.appendChild(avatarEl);

      // 气泡内容体
      const bodyEl = document.createElement('div');
      bodyEl.className = 'vis-polyphony-body';

      // 歌手标签
      const speakerTag = document.createElement('div');
      speakerTag.className = 'vis-polyphony-speaker';
      speakerTag.textContent = isRight ? 'VOCAL II' : 'VOCAL I';
      bodyEl.appendChild(speakerTag);

      const wordsContainer = document.createElement('div');
      wordsContainer.className = 'vis-polyphony-words';

      const lineStart = line.start !== undefined ? line.start : (line.time || 0);
      const lineEnd = line.end !== undefined ? line.end : (lineStart + 3000);
      const lineDur = Math.max(500, lineEnd - lineStart);

      const words = line.words || [];
      if (words.length > 0) {
        words.forEach(w => {
          const span = document.createElement('span');
          span.className = 'vis-polyphony-word';
          span.textContent = w.text;
          span.dataset.start = w.start;
          span.dataset.end = w.end;

          const cleanW = (w.text || '').trim().toLowerCase();
          for (const [ew, col] of emotionMap.entries()) {
            if (cleanW === ew || (cleanW.length >= 2 && ew.length >= 2 && (cleanW.includes(ew) || ew.includes(cleanW)))) {
              span.classList.add('vis-word-emotion');
              span.style.setProperty('--emotion-color', col);
              break;
            }
          }

          wordsContainer.appendChild(span);
        });
      } else {
        const text = line.original || line.text || '';
        const chars = Array.from(text);
        const charDur = lineDur / Math.max(1, chars.length);
        chars.forEach((ch, cIdx) => {
          const span = document.createElement('span');
          span.className = 'vis-polyphony-word';
          span.textContent = ch;
          span.dataset.start = lineStart + cIdx * charDur;
          span.dataset.end = lineStart + (cIdx + 1) * charDur;
          wordsContainer.appendChild(span);
        });

        // 字符级情感词匹配
        if (text && emotionMap.size > 0) {
          const spans = Array.from(wordsContainer.children);
          for (const [ew, col] of emotionMap.entries()) {
            const lowerText = text.toLowerCase();
            let from = 0;
            let mIdx;
            while ((mIdx = lowerText.indexOf(ew, from)) !== -1) {
              const to = mIdx + Array.from(ew).length;
              for (let i = mIdx; i < to && i < spans.length; i++) {
                spans[i].classList.add('vis-word-emotion');
                spans[i].style.setProperty('--emotion-color', col);
              }
              from = mIdx + 1;
            }
          }
        }
      }
      bodyEl.appendChild(wordsContainer);
      bubbleCard.appendChild(bodyEl);

      this.stage.appendChild(bubbleCard);
      this.lineEls.push(bubbleCard);
    });
  }

  onLineChange(lineIndex, lineData) {
    if (!this.lineEls) return;

    this._applyBubbleWindow(lineIndex);

    this.lineEls.forEach((el, idx) => {
      const dist = idx - lineIndex;
      el.classList.remove('active', 'prev', 'next', 'far');
      if (dist === 0) {
        el.classList.add('active');
      } else if (dist === -1) {
        el.classList.add('prev');
      } else if (dist === 1) {
        el.classList.add('next');
      } else {
        el.classList.add('far');
      }
    });

    const activeEl = this.lineEls[lineIndex];
    if (activeEl && this.stage) {
      const stageH = this.stage.clientHeight || 400;
      const targetY = stageH / 2 - (activeEl.offsetTop + activeEl.clientHeight / 2);
      this.stage.style.transform = `translateY(${targetY}px)`;
    }

    if (this.transEl && lineData) {
      const tr = (lineData.translation && lineData.translation.trim() !== '//') ? lineData.translation.trim() : '';
      const ro = (lineData.romaji && lineData.romaji.trim() !== '//') ? lineData.romaji.trim() : '';
      if (tr || ro) {
        this.transEl.innerHTML = `
          ${tr ? `<div class="vis-polyphony-trans-text">${tr}</div>` : ''}
          ${ro ? `<div class="vis-polyphony-roma-text">${ro}</div>` : ''}
        `;
        this.transEl.style.display = 'block';
        this.transEl.style.opacity = '1';
      } else {
        this.transEl.innerHTML = '';
        this.transEl.style.display = 'none';
        this.transEl.style.opacity = '0';
      }
    }
  }

  onUpdate(timeMs) {
    if (!this.lineEls || this.activeLineIndex < 0) return;
    const activeEl = this.lineEls[this.activeLineIndex];
    if (!activeEl) return;

    const wordSpans = activeEl.querySelectorAll('.vis-polyphony-word');
    wordSpans.forEach(span => {
      const s = parseInt(span.dataset.start);
      const e = parseInt(span.dataset.end);
      if (timeMs >= s && timeMs < e) {
        span.classList.add('singing');
        span.classList.remove('sung');
      } else if (timeMs >= e) {
        span.classList.remove('singing');
        span.classList.add('sung');
      } else {
        span.classList.remove('singing', 'sung');
      }
    });
  }
}
