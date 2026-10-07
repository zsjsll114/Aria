import { DimensionVisualizer } from './DimensionVisualizer.js';
import { LetterpressVisualizer } from './LetterpressVisualizer.js';
import { JizuraVisualizer } from './jizura/JizuraVisualizer.js';
import { logCatch } from '../../services/log.js';


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
    /* ★ 字面 · Jizura（2026-10-06）：JIZURA 引擎移植（MIT © 2026 hakoniwa）。
       注册在这里 = 自动获得容器/生命周期/歌词下发/每帧时钟/性能档/后台节流/设置分发
       （见 JizuraVisualizer 头注释），以及 220 的 switchView 通用分支。 */
    this.register('jizura', JizuraVisualizer);

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
   * ★ 性能分档下发：VisualizerManager 管理的模式（浮空/活字/霓虹）原本完全未消费
   * 性能分档，导致低性能/无 GPU 设备上粒子、阴影、发光等尺寸固定拖垮帧率。
   * 这里把档位参数缓存给后续创建的实例，并即时应用到当前实例。
   */
  applyPerformanceProfile(profile = {}) {
    this.perfProfile = profile;
    this.perfTunnel = profile.tunnel || null;
    this.perfDimension = profile.dimension || null;
    this.perfVfx = profile.vfx || null;
    if (this.activeInstance) {
      if (typeof this.activeInstance.setPerfConfig === 'function') {
        this.activeInstance.setPerfConfig({
          dimension: this.perfDimension,
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

  /**
   * 暂停当前视觉实例的动画循环（保留实例与 DOM，可被 start() 唤醒）。
   * ★ 2026-10-03：此前本类**没有** stop/start。settings 面板预览引擎里
   *   `previewEngine.stop()` 一直在调 `this.visManager.stop()` —— 那是 TypeError，
   *   被 logCatch 吞掉，于是「诗镜(verse)/维度」这类走 VisualizerManager 的预览实例
   *   在关闭设置后依旧满帧渲染（隐藏 overlay 后面），持续吃 GPU/帧预算，
   *   表现为「打开外观设置后英文逐字歌词概率性变卡」。
   */
  stop() {
    if (this.activeInstance && typeof this.activeInstance.stop === 'function') {
      try { this.activeInstance.stop(); } catch (e) { logCatch('visManager', e); }
    }
  }

  /** 唤醒当前视觉实例（与 stop() 配对，用于重新打开设置页/切回外观 Tab） */
  start() {
    if (this.activeInstance && typeof this.activeInstance.start === 'function') {
      try { this.activeInstance.start(); } catch (e) { logCatch('visManager', e); }
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
