/**
 * VisualizerBase.js
 * 歌词视觉渲染器基类 (Visualizer Base Class)
 * 提供标准化生命周期接口与通用工具函数
 */
export class VisualizerBase {
  /**
   * @param {HTMLElement} container 挂载容器
   * @param {Object} [options] 配置项
   */
  constructor(container, options = {}) {
    this.container = container || null;
    this.options = options;
    this.viewContainer = null;
    this.lines = [];
    this.activeLineIndex = -1;
    this.aiData = {};
    this.settings = {};
    this.themeColor = '#ffcc33';
    this.isRunning = false;
    this.rafId = null;
  }

  /**
   * 初始化 DOM 结构
   * @param {HTMLElement} [container]
   */
  init(container) {
    if (container) this.container = container;
    if (!this.container) return this;

    // 创建或复用根视口
    let view = this.container.querySelector(`.visualizer-stage-${this.getModeId()}`);
    if (!view) {
      view = document.createElement('div');
      view.className = `visualizer-stage visualizer-stage-${this.getModeId()}`;
      this.container.appendChild(view);
    }
    this.viewContainer = view;
    this.viewContainer.innerHTML = '';
    this.viewContainer.style.display = 'block';

    this.onInit();
    this.handleResize();

    return this;
  }

  /**
   * 模式唯一标识 (子类必须实现)
   * @returns {string}
   */
  getModeId() {
    return 'base';
  }

  /**
   * 子类自定义初始化生命周期
   */
  onInit() {}

  /**
   * 装载歌词与情绪数据
   * @param {Array} lines 标准歌词行数组
   * @param {Object} [aiData] AI 情绪分析数据
   */
  setLyrics(lines = [], aiData = {}) {
    this.lines = Array.isArray(lines) ? lines : [];
    this.aiData = aiData || {};
    this.activeLineIndex = -1;
    this.themeColor = aiData.accent_color || this.settings.themeColor || '#ffcc33';
    /* ★ RTL 检测（阿拉伯/希伯来语系歌词）：容器挂 vis-rtl 类，由 CSS 把各视图
       版心 direction 翻为 rtl——逐字点亮元素按字符串序创建，bidi 重排后视觉上
       自然「从右往左」点亮，无需改各视图的高亮推进逻辑（PV 同款思路）。
       检测范围与 PVRendering 的 pv-is-rtl 一致。 */
    this.isRtlLyrics = this.lines.some(l =>
      /[\u0590-\u05ff\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb1d-\ufbff\ufb50-\ufdff\ufe70-\ufeff]/.test(
        String(l.original || l.text || '')));
    if (this.viewContainer) {
      this.viewContainer.classList.toggle('vis-rtl', this.isRtlLyrics);
    }
    this.onLyricsLoaded();
  }

  /**
   * 子类歌词装载完成回调
   */
  onLyricsLoaded() {}

  /**
   * 逐帧时钟推进
   * @param {number} currentTimeSec 当前播放秒数
   */
  update(currentTimeSec = 0) {
    if (!this.lines || this.lines.length === 0) return;
    const timeMs = currentTimeSec * 1000;

    // 二分或线性查找当前歌词行
    let activeIdx = -1;
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];
      const start = line.start !== undefined ? line.start : line.time || 0;
      const end = line.end !== undefined ? line.end : (start + (line.duration || 5000));
      if (timeMs >= start && timeMs < end) {
        activeIdx = i;
        break;
      }
      if (timeMs >= start) {
        activeIdx = i;
      }
    }
    if (activeIdx === -1 && this.lines.length > 0 && timeMs >= (this.lines[0].start || 0)) {
      activeIdx = 0;
    }

    const changed = activeIdx !== this.activeLineIndex;
    if (changed && activeIdx >= 0) {
      this.activeLineIndex = activeIdx;
      this.onLineChange(activeIdx, this.lines[activeIdx]);
    }

    this.onUpdate(timeMs, currentTimeSec, activeIdx);
  }

  /**
   * 歌词行切换回调
   * @param {number} lineIndex
   * @param {Object} lineData
   */
  onLineChange(lineIndex, lineData) {}

  /**
   * 逐帧更新回调 (子类实现)
   * @param {number} timeMs
   * @param {number} timeSec
   * @param {number} activeIndex
   */
  onUpdate(timeMs, timeSec, activeIndex) {}

  /**
   * 启动动画循环
   */
  start() {
    this.isRunning = true;
  }

  /**
   * 暂停动画循环
   */
  stop() {
    this.isRunning = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * 应用外观参数
   * @param {Object} settings
   */
  applySettings(settings = {}) {
    this.settings = Object.assign({}, this.settings, settings);
    if (this.viewContainer) {
      if (settings.themeColor) {
        this.themeColor = settings.themeColor;
        this.viewContainer.style.setProperty('--vis-theme-color', settings.themeColor);
      }
      if (settings.highlightColor) {
        this.viewContainer.style.setProperty('--vis-highlight-color', settings.highlightColor);
      }
      if (settings.fontSize) {
        this.viewContainer.style.setProperty('--vis-font-size', `${settings.fontSize}px`);
      }
      if (settings.fontFamily) {
        const resolved = (typeof window !== 'undefined' && typeof window.resolveFontFamily === 'function')
          ? window.resolveFontFamily(settings.fontFamily)
          : settings.fontFamily;
        this.viewContainer.style.setProperty('--vis-font-family', resolved);
      }
      if (settings.emotionGlow !== undefined) {
        this.viewContainer.style.setProperty('--emotion-glow', `${parseFloat(settings.emotionGlow) || 10}px`);
      }
    }
    this.onApplySettings(settings);
  }

  /**
   * 子类自定义参数应用
   */
  onApplySettings(settings) {}

  /**
   * 视口尺寸变化响应
   */
  handleResize() {
    if (!this.viewContainer) return;
    const rect = this.viewContainer.getBoundingClientRect();
    this.width = rect.width || window.innerWidth || 800;
    this.height = rect.height || window.innerHeight || 600;
    this.onResize(this.width, this.height);
  }

  onResize(width, height) {}

  /**
   * 销毁与资源释放
   */
  destroy() {
    this.stop();
    if (this.viewContainer && this.viewContainer.parentNode) {
      this.viewContainer.parentNode.removeChild(this.viewContainer);
    }
    this.viewContainer = null;
    this.lines = [];
  }
}
