import { DimensionVisualizer } from './DimensionVisualizer.js';
import { LetterpressVisualizer } from './LetterpressVisualizer.js';
import { NeonVisualizer } from './NeonVisualizer.js';

/**
 * VisualizerManager.js
 * 歌词视觉引擎统一调度中心 (Visualizer Manager)
 */
export class VisualizerManager {
  constructor() {
    this.registry = new Map();
    this.activeInstance = null;
    this.currentMode = null;
    this.container = null;
    this.lines = [];
    this.aiData = {};
    this.settings = {};

    this._registerBuiltins();
  }

  _registerBuiltins() {
    this.register('dimension', DimensionVisualizer);
        this.register('letterpress', LetterpressVisualizer);
    this.register('neon', NeonVisualizer);
  }

  register(modeId, visualizerClass) {
    this.registry.set(modeId, visualizerClass);
  }

  has(modeId) {
    return this.registry.has(modeId);
  }

  /**
   * 切换到目标视觉模式
   * @param {string} modeId 模式标识
   * @param {HTMLElement} container 挂载容器
   */
  switchMode(modeId, container) {
    if (this.activeInstance) {
      this.activeInstance.destroy();
      this.activeInstance = null;
    }

    this.currentMode = modeId;
    this.container = container || this.container;

    if (!this.registry.has(modeId)) {
      return null;
    }

    const VisualizerCls = this.registry.get(modeId);
    this.activeInstance = new VisualizerCls(this.container);
    this.activeInstance.init(this.container);

    if (this.perfProfile) {
      if (typeof this.activeInstance.setPerfConfig === 'function') {
        this.activeInstance.setPerfConfig({
          dimension: this.perfDimension,
          polyphony: this.perfPolyphony,
          vfx: this.perfVfx,
        });
      }
    }

    if (this.lines && this.lines.length > 0) {
      this.activeInstance.setLyrics(this.lines, this.aiData);
    }
    if (this.settings) {
      this.activeInstance.applySettings(this.settings);
    }
    this.activeInstance.start();

    return this.activeInstance;
  }

  setLyrics(lines = [], aiData = {}) {
    this.lines = lines;
    this.aiData = aiData;
    if (this.activeInstance) {
      this.activeInstance.setLyrics(lines, aiData);
    }
  }

  update(currentTimeSec = 0) {
    if (this.activeInstance) {
      this.activeInstance.update(currentTimeSec);
    }
  }

  applySettings(settings = {}) {
    this.settings = Object.assign({}, this.settings, settings);
    if (this.activeInstance) {
      this.activeInstance.applySettings(settings);
    }
  }

  /**
   * ★ 性能分档下发：VisualizerManager 管理的模式（浮空/和鸣）原本完全未消费
   * 性能分档，导致低性能/无 GPU 设备上粒子、阴影、发光等尺寸固定拖垮帧率。
   * 这里把档位参数缓存给后续创建的实例，并即时应用到当前实例。
   */
  applyPerformanceProfile(profile = {}) {
    this.perfProfile = profile;
    this.perfTunnel = profile.tunnel || null;
    this.perfDimension = profile.dimension || null;
    this.perfPolyphony = profile.polyphony || null;
    this.perfVfx = profile.vfx || null;
    if (this.activeInstance) {
      if (typeof this.activeInstance.setPerfConfig === 'function') {
        this.activeInstance.setPerfConfig({
          dimension: this.perfDimension,
          polyphony: this.perfPolyphony,
          vfx: this.perfVfx,
        });
      }
    }
  }

  /** 供外部引擎读取当前生效的视觉效果矩阵（含设置项手动覆盖），
      词云/飞入等非本管理器模式也统一从这里取 */
  getVfx() {
    if (typeof window !== 'undefined' && typeof window.getPerfVfx === 'function') {
      return window.getPerfVfx();
    }
    return this.perfVfx || {};
  }

  handleResize() {
    if (this.activeInstance) {
      this.activeInstance.handleResize();
    }
  }

  destroy() {
    if (this.activeInstance) {
      this.activeInstance.destroy();
      this.activeInstance = null;
    }
    this.currentMode = null;
  }
}
