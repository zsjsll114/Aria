/**
 * PVDecorations.js
 * 1. 远景 3D 巨型连笔空心描边大字 (0.28x 慢视差慢移)
 * 2. folia 式图形场（shapeField.js：icon + 基础几何 + 上浮粒子，
 *    对齐上游 GeometricBackground：极淡 0.11~0.19、极慢漂移旋转、歌曲级持久）
 * 3. 长弧笔触层（PVArcField.js：3 条 ≥130° 的长弧，揭示量 = 演唱进度）
 *
 * ★ 2026-09-25 回退记录：这里曾换成 core/sonnetField.js 的四层纯描边场，
 *   用户实测三条判定全部成立——
 *   ① 只有 1px 描边、没有实心块，读起来像施工图纸，不如原来；
 *   ② 生长挂在挂载时的一条 1.5s CSS 动画上，不跟演唱进度走，是屏保不是伴奏；
 *   ③ 生成器爱出短碎段（放射 12 根 / 刻度 22 格 / 弦线 8 条），线条不连续、画面很杂。
 *   商籁真正的观感是「少数几条长而连续的弧线，跟着字一笔挥过去」，两样都没搬对。
 *   已退回图形场作默认底并删掉 sonnetField.js（不接线的模块就是约束 10 的影子层陷阱）；
 *   第 3 层是按那三条重做的部分：只当点缀、由播放头驱动、每条弧一笔挥成。
 */
import { buildShapeFieldHTML } from '../shapeField.js';
import { buildArcFieldHTML } from './PVArcField.js';

export class PVDecorations {
  constructor(layer) {
    this.layer = layer;
    this.currentOutlineContainer = null;
    this.shapeFieldEl = null;       /* 图形场：歌曲级持久，不随 shot 重建 */
    this.shapeSeed = null;          /* 当前图形场种子（歌曲标识） */
    this.arcFieldEl = null;         /* 长弧笔触层：由演唱进度驱动揭示 */
    this.arcSeed = null;
    this._arcP = -1;                /* 上一次写进 CSS 的进度，避免重复触发样式失效 */
  }

  /**
   * 逐帧喂给笔触层的演唱进度（0..1，来自 PVRendering.sungProgress）。
   * 只写一个 CSS 变量，dashoffset 由浏览器按每条弧自己的时间窗算——
   * JS 不逐帧遍历元素，也不碰 getBoundingClientRect。
   * @param {number} p
   */
  setProgress(p) {
    if (!this.arcFieldEl || !(p >= 0)) return;
    if (Math.abs(p - this._arcP) < 0.004) return;
    this._arcP = p;
    this.arcFieldEl.style.setProperty('--p', p.toFixed(4));
  }

  /**
   * 为当前活动场景渲染远景巨型描边文字，并确保图形场存在
   * @param {Object} node 当前排版场景节点
   * @param {string} themeColor 主题强调色
   * @param {number|string} [seed] 歌曲级稳定种子（换歌才重建图形场）
   */
  renderForNode(node, themeColor = '#ffcc33', seed = null) {
    if (!this.layer || !node) return;

    // 1. 渲染远景 3D 巨型连笔空心描边字 (260~360px)
    if (!this.currentOutlineContainer) {
      this.currentOutlineContainer = document.createElement('div');
      this.currentOutlineContainer.className = 'pv-outline-container';
      this.layer.appendChild(this.currentOutlineContainer);
    }
    this.currentOutlineContainer.innerHTML = '';

    const bgWords = node.backgroundWords || [];
    bgWords.forEach((word, idx) => {
      if (!word) return;
      const wordEl = document.createElement('div');
      wordEl.className = 'pv-giant-outline-word';
      wordEl.textContent = word;

      // 错落坐标：基于场景中心，并在 3D 深度上略微倾斜
      const offsetX = (idx === 0) ? (node.pos.x - 120) : (node.pos.x + 180);
      const offsetY = (idx === 0) ? (node.pos.y - 80) : (node.pos.y + 110);
      const rot = (idx === 0) ? -2.5 : 2.0;

      wordEl.style.transform = `translate3d(${offsetX}px, ${offsetY}px, -120px) rotate(${rot}deg)`;
      wordEl.style.webkitTextStroke = `1.8px ${themeColor}`;
      wordEl.style.setProperty('--pv-stroke-color', themeColor);

      this.currentOutlineContainer.appendChild(wordEl);
    });

    // 2. folia 式图形场：seed 不变则只跟随主题色，不重建 DOM——
    //    换 shot 重建会让图形位置跳变；CSS transform 动画自动循环无需干预
    if (!this.shapeFieldEl) {
      this.shapeFieldEl = document.createElement('div');
      this.shapeFieldEl.className = 'pv-shape-field';
      this.layer.appendChild(this.shapeFieldEl);
    }
    const effSeed = (seed === null || seed === undefined) ? themeColor : seed;
    if (this.shapeSeed !== effSeed) {
      this.shapeSeed = effSeed;
      this.shapeFieldEl.innerHTML = buildShapeFieldHTML(effSeed);
    }
    this.shapeFieldEl.style.color = themeColor;

    // 3. 长弧笔触层：叠在图形场之上，揭示量 = 演唱进度（见 setProgress）
    if (!this.arcFieldEl) {
      this.arcFieldEl = document.createElement('div');
      this.arcFieldEl.className = 'pv-arc-field';
      this.layer.appendChild(this.arcFieldEl);
    }
    if (this.arcSeed !== effSeed) {
      this.arcSeed = effSeed;
      this._arcP = -1;
      this.arcFieldEl.innerHTML = buildArcFieldHTML(effSeed).html;
    }
    this.arcFieldEl.style.color = themeColor;
  }

  clear() {
    if (this.currentOutlineContainer) this.currentOutlineContainer.innerHTML = '';
    if (this.shapeFieldEl) this.shapeFieldEl.innerHTML = '';
    if (this.arcFieldEl) this.arcFieldEl.innerHTML = '';
    this.arcSeed = null;
    this._arcP = -1;
  }
}
