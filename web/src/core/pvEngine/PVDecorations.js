/**
 * PVDecorations.js
 * 1. 远景 3D 巨型连笔空心描边大字 (0.28x 慢视差慢移)
 * 2. folia 式全屏图形场（shapeField.js：icon + 基础几何 + 上浮粒子，
 *    对齐上游 GeometricBackground：极淡 0.11~0.19、极慢漂移旋转、歌曲级持久）
 */
import { buildShapeFieldHTML } from '../shapeField.js';

export class PVDecorations {
  constructor(layer) {
    this.layer = layer;
    this.currentOutlineContainer = null;
    this.shapeFieldEl = null;       /* 图形场：歌曲级持久，不随 shot 重建 */
    this.shapeSeed = null;          /* 当前图形场种子（歌曲标识） */
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
  }

  clear() {
    if (this.currentOutlineContainer) this.currentOutlineContainer.innerHTML = '';
    if (this.shapeFieldEl) this.shapeFieldEl.innerHTML = '';
  }
}
