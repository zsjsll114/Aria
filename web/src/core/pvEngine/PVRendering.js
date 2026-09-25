/**
 * PVRendering.js
 * 负责 2D/3D 海报文字排版渲染与 Cadenza 风格逐字光束扫描生命周期流转：
 * 1. 日系海报 4 大构图模版支持 (Pillar-Wings, Twin-Pillars, Vertical-Cascade, Hero-Cross)
 * 2. 逐字推进动态延伸虚线框 (Progressive Kinetic Target Box: 唱到几个字就延伸几个字宽度/高度)
 * 3. 超界长句视野自动平滑跟焦 (Auto-tracking Panning: 镜头紧随当前唱响字符前沿平滑滑动，绝不被边缘截断)
 * 4. 情感词播放中动态形变呼吸 (Kinetic Growth: 随演唱进度动态扩张)
 * 5. Cadenza 同款字素三态生命周期 (waiting 绝对无发光无阴影 -> active 光束扫描 -> passed 优雅微光)
 * 6. 实时计算当前活跃词块中心坐标与当前活跃子句翻译
 */

import { buildBurstParticle } from './particleSpec.js';
import { wordBurstCount, wordLeadMs, wordBurstEnvelope, buildStarTrail, WORD_TAIL_MS } from './wordFxSpec.js';
import { logCatch } from '../../services/log.js';

/* 是否含 CJK/假名/谚文/CJK 标点（竖排保持直立的字符群）；
   纯拉丁/数字/西文标点的词块在竖排流中走 sideways 整词侧躺（上游 §6） */
function hasIdeograph(s) {
  return /[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/.test(String(s || ''));
}

export class PVRendering {
  constructor(stageLayer) {
    this.stageLayer = stageLayer;
    this.currentPosterEl = null;
    this.currentNode = null;
    this.chars = []; // 展平的字符节点列表
    this.blocks = [];
    this.lines = []; // 场景内的句子列表
    this._wcCacheEl = null; // 世界坐标缓存：当前活跃字符元素
    this._wcCacheCenter = null; // 世界坐标缓存：对应中心点（避免每帧 getBoundingClientRect）
    /* ★ diorama resolveReadHeadTruck 缓存：当前行首尾字世界距（行宽）/ 行中心，
       仅当活跃行变化时计算一次，逐字期间复用 */
    this._truckLine = null;
    this._truckCache = null;
  }

  /**
   * 切换至新的 3D/2D 海报场景节点
   * @param {Object} node 海报场景节点
   * @param {string} themeColor 主题色彩
   */
  transitionToNode(node, themeColor = '#ffcc33') {
    if (!node || !this.stageLayer) return;

    /* ★ P3.5 handoff（上游参考项目 对齐）：依据「旧景锚点 → 新景锚点」的位移主轴向，推导
       场景重叠滑出方向。dir ∈ right/left/up/down/center（center=位移过小→退回纯渐隐）。
       世界位移小的景不强行滑出，避免微位移抖动的廉价感。 */
    const prev = this.currentNode;
    let hoDir = 'center';
    if (prev && prev.pos && node.pos) {
      const dx = node.pos.x - prev.pos.x;
      const dy = node.pos.y - prev.pos.y;
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      if (ax >= 32 || ay >= 32) {
        hoDir = ax >= ay ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'down' : 'up');
      }
    }
    const isHandoff = hoDir !== 'center';

    this.currentNode = node;

    // 1. 旧海报消散 —— 纯渐隐(上浮) 不变；handoff 时改走「重叠滑出」：
    //    原地短暂交叠 → 沿场景衔接的反向滑出，尾段才渐隐（新景全程叠加在上方）
    if (this.currentPosterEl) {
      const oldPoster = this.currentPosterEl;
      oldPoster.classList.remove(
        'pv-phrase-enter', 'pv-phrase-enter-handoff',
        'phv-right', 'phv-left', 'phv-up', 'phv-down'
      );
      if (isHandoff) {
        oldPoster.classList.add('pv-phrase-handoff-out', `phv-${hoDir}`);
        /* 交棒层次：新景置顶滑入，旧景尾随滑出，二者在中段重叠 */
        this.stageLayer.appendChild(oldPoster);
      } else {
        oldPoster.classList.add('pv-phrase-exit-fade');
        /* ★ 修复：将旧海报重新挂载到舞台最上层，避免被同步进场的新海报遮挡导致渐隐不可见 */
        this.stageLayer.appendChild(oldPoster);
      }
      /* ★ 移除时机必须对齐动画实际时长：handoff-out 最长 1.1s（shot×0.3 钳 0.4~1.1s），
         写死 560ms 会在动画中段硬删 → 「行直接消失」。按 --pv-handoff-dur 计算，尾留 150ms 余量 */
      try {
        const durStr = window.getComputedStyle(oldPoster).getPropertyValue('--pv-handoff-dur') || '0.5s';
        const durMs = (parseFloat(durStr) || 0.5) * 1000;
        setTimeout(() => {
          if (oldPoster && oldPoster.parentNode) {
            oldPoster.remove();
          }
        }, Math.max(640, durMs + 150));
      } catch (e) {
        setTimeout(() => {
          if (oldPoster && oldPoster.parentNode) oldPoster.remove();
        }, 560);
      }
    }

    // 2. 创建新海报容器
    const poster = document.createElement('div');
    const isRtl = /[\u0590-\u05ff\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb1d-\ufbff\ufb50-\ufdff\ufe70-\ufeff]/.test(node.text || (node.lines && node.lines.map(l => l.original || l.text || '').join(' ')) || '');
    /* handoff：新景走「重叠滑入」动画（带方向类）；位移过小则沿用原 pop-in */
    poster.className = `pv-poster-container ${isHandoff ? 'pv-phrase-enter-handoff phv-' + hoDir : 'pv-phrase-enter'} pv-archetype-${node.archetype || 'auto'}${isRtl ? ' pv-is-rtl' : ''}`;
    poster.style.setProperty('--pv-emotion-color', node.themeColor || themeColor);

    /* ★ 参考实现 tempera shot profile → 布局 CSS 变量：
       region(排版区域/对齐/字号缩放) + enter(入场向量, em) + handoff 时长 */
    const prof = node.region || { cx: 0.5, cy: 0.5, w: 0.92, h: 0.5, align: 'center', rotation: 0, fontScale: 1 };
    poster.style.setProperty('--pv-region-cx', prof.cx);
    poster.style.setProperty('--pv-region-cy', prof.cy);
    poster.style.setProperty('--pv-region-w', prof.w);
    poster.style.setProperty('--pv-region-h', prof.h);
    poster.style.setProperty('--pv-scene-font-scale', prof.fontScale != null ? prof.fontScale : 1);
    poster.classList.toggle('pv-region-left', prof.align === 'left');
    poster.classList.toggle('pv-region-right', prof.align === 'right');
    /* 旋转走独立 rotate 属性（不覆盖内联 transform 的 world 定位）；弧度→度、幅度收敛 ±8° */
    if (prof.rotation) {
      const deg = Math.max(-8, Math.min(8, prof.rotation * 180 / Math.PI));
      poster.style.rotate = `${deg.toFixed(2)}deg`;
    }
    const ent = node.enter || { x: 0, y: 1.2 };
    poster.style.setProperty('--pv-enter-x', `${ent.x}em`);
    poster.style.setProperty('--pv-enter-y', `${ent.y}em`);
    if (node.handoff) {
      poster.style.setProperty('--pv-handoff-dur', `${node.handoff}s`);
    }

    // ★ 居中基准：poster 中心 = 容器中心 + node.pos（world 坐标语义为“相对容器中心”，
    //   translate(-50%,-50%) 中和自身尺寸；与摄像机 setTarget(activeBlockCenter) 对齐）
    poster.style.transform = `translate(-50%, -50%) translate3d(${node.pos.x}px, ${node.pos.y}px, 0)`;

    // 3. 构建多行错落海报集群容器
    const linesContainer = document.createElement('div');
    linesContainer.className = `pv-poster-lines pv-layout-${node.archetype || 'default'}`;
    /* ★ 参考实现 tempera 入场方式变体：mood=loud→swing（旋转回弹）/ quiet→stamp（原地印章）/
       neutral→默认 pop-in。mood 由 shotProfiles 按场景 kind 确定性决策，无随机 */
    const enterVariant = (node.mood === 'loud') ? 'pv-enter-swing'
      : (node.mood === 'quiet') ? 'pv-enter-stamp' : '';
    if (enterVariant) linesContainer.classList.add(enterVariant);

    this.chars = [];
    this.blocks = [];
    this.lines = node.lines || [{
      lineIndex: 0,
      start: node.start,
      end: node.end,
      isVerticalLine: false,
      blocks: node.blocks || [],
      translation: node.translation,
      romaji: node.romaji
    }];

    // 遍历场景内的每一行歌词
    this.lines.forEach((lineData, lIdx) => {
      const lineEl = document.createElement('div');
      const dirClass = lineData.isVerticalLine ? 'pv-line-vertical' : 'pv-line-horizontal';
      lineEl.className = `pv-poster-line pv-line-${lIdx} ${dirClass}`;
      /* ★ 参考实现 sonnet 式行间错落（用户反馈「没有高级感」——行与行死板居中堆叠
         是直接原因之一）：确定性交替微偏移 ±10/18/26px，非随机散点；横排行与
         竖排列都适用。CSS 端用 position:relative + left（不影响 wrap 布局）。 */
      const lineShift = (lIdx % 2 === 0 ? -1 : 1) * (10 + (lIdx % 3) * 8);
      lineEl.style.setProperty('--pv-line-shift', `${lineShift}px`);
      lineEl.dataset.lineIndex = lIdx;
      lineEl.dataset.start = lineData.start;
      lineEl.dataset.end = lineData.end;

      /* ★ 上游参考项目 renderHints：短行/微行挂降级类（快进揭示、不触发完整光束），供 CSS 微调 */
      const hints = lineData.renderHints;
      if (hints) {
        if (hints.timingClass === 'micro' || hints.timingClass === 'short') lineEl.classList.add(`pv-hint-${hints.timingClass}`);
        if (hints.wordRevealMode === 'instant') lineEl.classList.add('pv-reveal-instant');
        else if (hints.wordRevealMode === 'fast') lineEl.classList.add('pv-reveal-fast');
      }
      lineData.lineEl = lineEl;

      const lineBlocks = lineData.blocks || [];

      // 遍历当前行内的每个词块
      lineBlocks.forEach((b, bIdx) => {
        const blockEl = document.createElement('div');
        
        // 类名组织：字阶 + 横排/竖排 + 词块类型
        const scaleClass = `pv-scale-${b.scale || 'minor'}`;
        const isBlockVert = Boolean(lineData.isVerticalLine || b.isVertical);
        const blockDirClass = isBlockVert ? 'pv-vertical-block' : 'pv-horizontal-block';
        blockEl.className = `pv-word-block ${scaleClass} ${blockDirClass}`;
        /* ★ 上游 §6（拉丁整词不拆字）：竖排流中的纯拉丁词块整词侧躺（sideways）——
           单词横过来逐字母点亮，不再 w/o/r/d 直立堆叠失去词形；
           含 CJK/假名/谚文/CJK 标点的词块保持 upright 直立竖排不变 */
        if (isBlockVert && !hasIdeograph(b.text)) blockEl.classList.add('pv-latin-sideways');
        blockEl.dataset.start = b.start;
        blockEl.dataset.end = b.end;

        // 情感词专属样式
        if (b.isEmotion && b.emotionColor) {
          blockEl.style.setProperty('--pv-block-color', b.emotionColor);
          blockEl.classList.add('pv-block-emotion');
        }

        // 科技瞄准逐字动态延伸虚线框 (仅在唱响时动态浮现并逐字拉长)
        let boxEl = null;
        if (b.isEmotion || b.scale === 'hero') {
          boxEl = document.createElement('div');
          boxEl.className = `pv-word-target-box ${b.isEmotion ? 'pv-emotion-target-box' : ''}`;
          boxEl.innerHTML = `
            <span class="pv-tb-c tl"></span>
            <span class="pv-tb-c tr"></span>
            <span class="pv-tb-c bl"></span>
            <span class="pv-tb-c br"></span>
            <span class="pv-tb-bar-v left"></span>
            <span class="pv-tb-bar-v right"></span>
            <span class="pv-tb-crosshair"></span>
          `;
          blockEl.appendChild(boxEl);
        }

        // 拆解生成单字符 (Char) 节点
        const blockCharSpans = [];
        (b.chars || []).forEach((ch) => {
          const charSpan = document.createElement('span');
          charSpan.className = 'pv-char waiting'; // 初始为 waiting 状态 (无发光无阴影)
          /* ★ 上游参考项目 renderHints：instant 揭示行（极短行）全行瞬时上屏，不做光束扫描 */
          if (hints && hints.wordRevealMode === 'instant') charSpan.classList.add('pv-char-instant');
          /* ★ 英文空格可视化：空格字符渲染 &nbsp;（inline 折叠会吞宽），确保词间留白 */
          charSpan.textContent = (ch.char === ' ') ? '\u00A0' : ch.char;
          charSpan.dataset.start = ch.start;
          charSpan.dataset.end = ch.end;

          if (b.isEmotion && b.emotionColor) {
            charSpan.style.setProperty('--pv-char-color', b.emotionColor);
            charSpan.classList.add('pv-char-emotion');
          }

          blockEl.appendChild(charSpan);
          blockCharSpans.push(charSpan);

          this.chars.push({
            el: charSpan,
            start: ch.start,
            end: ch.end,
            block: b,
            blockEl,
            lineIndex: lIdx,
            lineData
          });
        });

        lineEl.appendChild(blockEl);

        // ★ 横排西文单词之间插入显式留白节点（中日文连续词块不插入空格）
        if (!isBlockVert && b.hasSpaceAfter && bIdx < lineBlocks.length - 1) {
          const spaceSpan = document.createElement('span');
          spaceSpan.className = 'pv-word-space';
          spaceSpan.innerHTML = '&nbsp;';
          lineEl.appendChild(spaceSpan);
        }

        this.blocks.push({
          block: b,
          blockEl,
          boxEl,
          charSpans: blockCharSpans,
          start: b.start,
          end: b.end,
          isEmotion: b.isEmotion,
          isVertical: isBlockVert,
          lineIndex: lIdx,
          /* 词级特效状态：lead = 提前起势量（唱到之前就爆），fxFired 防重复发射 */
          lead: wordLeadMs(Math.random),
          fxFired: false,
          scale: b.scale || 'support'
        });
      });

      // 括号副词标签 (如 (Chorus))
      if (lineData.bracketText) {
        const bracketEl = document.createElement('div');
        bracketEl.className = 'pv-bracket-text';
        bracketEl.textContent = lineData.bracketText;
        lineEl.appendChild(bracketEl);
      }

      /* ★ 行首/尾字符锚（diorama resolveReadHeadTruck 用）：行宽=首尾字世界距。
         在 transition 阶段 DOM 布局完成后惰性计算（无 rect/无 transform 干扰，
         世界坐标由 poster 局部原点推导，见 _calculateElementWorldCenter） */
      lineData._firstSpan = null;
      lineData._lastSpan = null;

      linesContainer.appendChild(lineEl);
    });

    poster.appendChild(linesContainer);
    /* 插入顺序分两套：
       - handoff：新海报 append 到最顶层 → 从衔接方向滑入并罩住旧海报，形成交棒重叠；
       - 纯渐隐：新海报必须插到旧海报【之前】，否则 append 会把新海报放到最顶层，
         完全盖住正在上浮渐隐的旧海报（用户反馈"切句有的没有渐隐"） */
    if (this.currentPosterEl && this.currentPosterEl.parentNode === this.stageLayer) {
      if (isHandoff) {
        this.stageLayer.appendChild(poster);
      } else {
        this.stageLayer.insertBefore(poster, this.currentPosterEl);
      }
    } else {
      this.stageLayer.appendChild(poster);
    }
    this.currentPosterEl = poster;
  }

  /**
   * 演唱进度 0..1：按「已唱完的字符数 + 当前字符内部比例」单调推进。
   *
   * 这是背景笔触揭示层的**唯一驱动量**——它必须是 f(播放头) 而不是 f(墙钟)，
   * 否则暂停时背景还在画、seek 之后和音频对不上，就退回「屏保」而不是「伴奏」。
   * 不假设 chars 已按时间排序（跨行拼接时顺序不保证），所以整趟扫过去。
   * @param {number} currentTimeMs
   * @returns {number}
   */
  sungProgress(currentTimeMs = 0) {
    const chars = this.chars;
    if (!chars || chars.length === 0) return 0;
    let done = 0;
    let activeFrac = 0;
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      if (currentTimeMs > c.end) done++;
      else if (currentTimeMs >= c.start && activeFrac === 0) {
        activeFrac = (currentTimeMs - c.start) / Math.max(1, c.end - c.start);
      }
    }
    const v = (done + activeFrac) / chars.length;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /**
   * 逐帧时钟驱动：Cadenza 风格光束扫描推进、逐字动态延伸虚线框与超界视野平滑跟焦
   * @param {number} currentTimeMs 当前毫秒数
   * @returns {Object} { activeBlockCenter, activeLineData }
   */
  updateTime(currentTimeMs = 0) {
    if (!this.chars || this.chars.length === 0 || !this.currentNode) {
      return { activeBlockCenter: null, activeLineData: null };
    }

    let activeBlockCenter = null;
    let latestActiveCharTime = -1;
    let latestActiveCharEl = null;
    let activeLineData = null;

    // 严格实时唤醒 (绝不提前显示未播放字符)
    const LOOKAHEAD_MS = 0;

    /* ===== 词级特效发射器（提前起势 + 拖尾） =====
       判定式是 `now >= start - lead`，所以粒子在**唱到这个字之前** 200~380ms 就炸开，
       这是上游 guide 窗口的核心（sonnetGuides.ts:22-29）：观感上像「被音乐推出去」，
       而不是「跟着字幕补一帧」。seek 回退时把 fired 复位，重听一遍还会再爆。 */
    if (this.blocks && this.blocks.length) {
      for (let i = 0; i < this.blocks.length; i++) {
        const w = this.blocks[i];
        if (!w) continue;
        const dueAt = w.start - (w.lead || 0);
        if (!w.fxFired && currentTimeMs >= dueAt) {
          /* 已经唱过去太久的词（例如刚 seek 进来落在句中）不补爆，避免满屏同时炸 */
          if (currentTimeMs - dueAt <= WORD_TAIL_MS) this._spawnWordFx(w);
          w.fxFired = true;
        } else if (w.fxFired && currentTimeMs < dueAt) {
          w.fxFired = false;
        }
      }
    }

    // 1. 字符状态更新与寻找最新活跃字符
    let latestPassedLineData = null;
    for (let i = 0; i < this.chars.length; i++) {
      const item = this.chars[i];
      const el = item.el;
      const start = item.start;
      const end = item.end;

      if (currentTimeMs >= start && currentTimeMs <= end) {
        // ★ 状态 2: active (正在唱响：光束扫描波 + 动态高亮)
        if (!el.classList.contains('active')) {
          el.classList.remove('waiting', 'passed', 'sung');
          el.classList.add('active');
          /* ★ 迸发从**字级改成词级**（见 _spawnWordFx）：旧实现每个字符唱响都炸 3~5 颗，
             一行十个字就是 30~50 颗，用户实测判定「杂、不如 folia」。上游根本不挂在
             glyph 上，而是挂在 segment（词）级 guide 上。 */
        }

        if (start >= latestActiveCharTime) {
          latestActiveCharTime = start;
          latestActiveCharEl = el;
          /* ★ 上游参考项目 renderHints：微行(<100ms)瞬时上屏、不夺镜头——极短行不值得
             驱动相机跟焦（否则 <0.1s 的"哦/啊"会把镜头拽走再拽回） */
          const lnHints = item.lineData && item.lineData.renderHints;
          if (!lnHints || lnHints.wordRevealMode !== 'instant') {
            /* ★ 性能：仅当活跃字符变化时才调用 getBoundingClientRect（读取布局），
               同一字符内复用缓存坐标，避免情感词唱响阶段每帧强制回流 */
            if (this._wcCacheEl !== el) {
              this._wcCacheEl = el;
              this._wcCacheCenter = this._calculateElementWorldCenter(el, this.currentNode.pos);
            }
            activeBlockCenter = this._wcCacheCenter;
            activeLineData = item.lineData;
          }
        }
      } else if (currentTimeMs > end) {
        // ★ 状态 3: passed (唱毕：保留优雅白色微光与空间微弱漂移残影)
        if (!el.classList.contains('passed')) {
          el.classList.remove('waiting', 'active');
          el.classList.add('passed', 'sung');
        }
        latestPassedLineData = item.lineData;
      } else {
        // ★ 状态 1: waiting (未唱：绝对无发光无阴影，半透明暗淡微灰)
        if (!el.classList.contains('waiting')) {
          el.classList.remove('active', 'passed', 'sung');
          el.classList.add('waiting');
        }
      }
    }

    // 翻译兜底：若当前处于间奏或两句之间，回退到最近唱过的句子或场景首句
    if (!activeLineData) {
      activeLineData = latestPassedLineData || (this.currentNode && this.currentNode.lines && this.currentNode.lines[0] ? this.currentNode.lines[0] : null);
    }

    // 2. 词块状态、情感词动态形变呼吸与【逐字推进动态延伸虚线框】
    for (let b = 0; b < this.blocks.length; b++) {
      const blk = this.blocks[b];
      const el = blk.blockEl;
      const boxEl = blk.boxEl;
      const start = blk.start;
      const end = blk.end;

      if (currentTimeMs >= start && currentTimeMs <= end) {
        // 词块处于活跃唱响态
        if (!el.classList.contains('active')) {
          el.classList.remove('waiting', 'passed');
          el.classList.add('active');
        }

        // ★ 情感词在唱响中呼吸膨胀形变
        if (blk.isEmotion && end > start) {
          const progress = Math.min(Math.max((currentTimeMs - start) / (end - start), 0), 1);
          const growth = 1.0 + Math.sin(progress * Math.PI) * 0.12;
          const scaleStr = blk.isVertical ? `scaleY(${growth.toFixed(3)}) scaleX(1.03)` : `scale(${growth.toFixed(3)})`;
          el.style.transform = scaleStr;
        }

        // ★★★ 核心特性：逐字推进动态改变虚线框的宽度/高度 ★★★
        if (boxEl && blk.charSpans && blk.charSpans.length > 0) {
          // 计算当前已唱到的最后一个字符索引
          let sungIdx = 0;
          for (let c = 0; c < blk.charSpans.length; c++) {
            const chSpan = blk.charSpans[c];
            const chStart = parseInt(chSpan.dataset.start);
            if (currentTimeMs >= chStart) {
              sungIdx = c;
            }
          }

          /* ★ 性能：虚线框几何仅在"唱到的字符"变化时读取一次布局，避免情感词每帧强制回流 */
          if (blk._drawIdx !== sungIdx) {
            blk._drawIdx = sungIdx;
            const firstChar = blk.charSpans[0];
            const curChar = blk.charSpans[sungIdx];

            if (firstChar && curChar) {
              if (!blk.isVertical) {
                // 横排：根据唱到的字数动态扩展宽度 (从第 1 个字延伸到当前字)
                const firstRect = firstChar.offsetLeft;
                const curEnd = curChar.offsetLeft + curChar.offsetWidth;
                const progressiveW = Math.max(curEnd - firstRect + 16, 32);
                boxEl.style.width = `${progressiveW}px`;
                boxEl.style.height = `calc(100% + 12px)`;
                boxEl.style.left = `${firstRect - 8}px`;
                boxEl.style.transform = `translateY(-50%)`;
              } else {
                // 竖排：根据唱到的字数动态拉长高度 (从第 1 个字延伸到当前字)
                const firstTop = firstChar.offsetTop;
                const curBottom = curChar.offsetTop + curChar.offsetHeight;
                const progressiveH = Math.max(curBottom - firstTop + 14, 32);
                boxEl.style.height = `${progressiveH}px`;
                boxEl.style.width = `calc(100% + 14px)`;
                boxEl.style.top = `${firstTop - 7}px`;
                boxEl.style.transform = `translateX(-50%)`;
              }
            }
          }
        }
      } else if (currentTimeMs > end) {
        if (!el.classList.contains('passed')) {
          el.classList.remove('waiting', 'active');
          el.classList.add('passed');
        }
        if (blk._drawIdx !== -1) blk._drawIdx = -1;
        if (blk.isEmotion && el.style.transform) {
          el.style.transform = '';
        }
        // 唱毕后恢复完整包裹
        if (boxEl) {
          boxEl.style.width = `calc(100% + 16px)`;
          boxEl.style.height = `calc(100% + 12px)`;
          boxEl.style.left = `50%`;
          boxEl.style.top = `50%`;
          boxEl.style.transform = `translate(-50%, -50%)`;
        }
      } else {
        if (!el.classList.contains('waiting')) {
          el.classList.remove('active', 'passed');
          el.classList.add('waiting');
        }
        if (blk._drawIdx !== -1) blk._drawIdx = -1;
        if (blk.isEmotion && el.style.transform) {
          el.style.transform = '';
        }
      }
    }

    // 如果当前正在间歇，匹配当前时间落在哪一行的区间内
    if (!activeLineData && this.lines) {
      for (let l = 0; l < this.lines.length; l++) {
        const line = this.lines[l];
        if (currentTimeMs >= line.start && currentTimeMs <= line.end) {
          activeLineData = line;
          break;
        }
      }
      if (!activeLineData && this.lines.length > 0) {
        activeLineData = this.lines[0];
      }
    }

    /* ★ 行级 renderEnd 淡出已移除（用户反馈：上一句不该提前消散，应等整个句组
       唱完随场景整体淡出）。多行场景共用一个 poster，行的生命周期 = 场景生命周期；
       行退出由 transitionToNode 的场景级 handoff/pv-phrase-exit-fade 统一处理。 */

    /* ★ diorama resolveReadHeadTruck 数据：当前活跃行的行宽/行中心（世界坐标）。
       activeLineData 变化时查一次首尾字锚并缓存，逐字期间复用，避免每帧两次 rect */
    let truckHint = null;
    if (activeLineData && activeBlockCenter && this.currentNode) {
      if (this._truckLine !== activeLineData) {
        this._truckLine = activeLineData;
        this._truckCache = null;
        const lineEl = activeLineData.lineEl;
        if (lineEl) {
          const spans = lineEl.querySelectorAll('.pv-char');
          if (spans.length >= 1) {
            const first = spans[0];
            const last = spans[spans.length - 1];
            const f = this._calculateElementWorldCenter(first, this.currentNode.pos);
            const l = this._calculateElementWorldCenter(last, this.currentNode.pos);
            if (f && l) {
              this._truckCache = {
                lineSpan: Math.abs(l.worldX - f.worldX),
                lineCenterX: (f.worldX + l.worldX) / 2
              };
            }
          }
        }
      }
      if (this._truckCache) {
        truckHint = { charX: activeBlockCenter.worldX, ...this._truckCache };
      }
    }

    return {
      activeBlockCenter,
      activeLineData,
      truckHint
    };
  }

  /**
   * ★ 逐字迸发粒子（参考实现 sonnet shapeBurst 对齐）：字符唱响(turn active)瞬间迸发 3~5 颗
   * 小几何体，沿随机方位角直线飞出 + 立方缓出 + 淡出 + 轻微缩小/小角度扫旋，寿命单向
   * 0.9~1.4s 渐消（不复用旧「无限公转轨道」——上游参考项目 是 burstProgress 0.3→1.0 一去不返的
   * 直线位移 + alpha 渐消）。形状随机 dot/square/cross/dia 四种（参考实现 sonnet 同款），
   * 颜色以行高亮色为主、掺 22% 白尘补层次；终态位移/旋转在生成期算好封进 CSS 变量。
   * 随机仅用于方位/距离/大小/时长/形态（纯装饰），不影响任何确定性布局/时序；
   * perf-minimal 或 prefers-reduced-motion 下不生成。
   * @private
   */
  /**
   * 词级特效：一蓬甩出去的尘 + （重点词才有的）星轨描边。
   *
   * 与旧 `_spawnCharParticles` 的三点差别，正是用户反馈「不如 folia」的那三处：
   *   1. 挂在**词**上而不是字上 —— 颗粒总量从「每字 3~5」降到「每词 3~6」；
   *   2. 由 `now >= start - lead` 触发，唱到之前就起势，不是唱到才补一帧；
   *   3. 距离/时长/大小乘上词级包络（wordBurstEnvelope），收尾缩到 0.6 而不是 0，
   *      所以是「甩出去消散」而不是「原地闪一下」。
   * 形状与颜色基准仍复用 particleSpec.buildBurstParticle，不另起一份事实源。
   * @param {Object} w this.blocks 里的一项
   * @private
   */
  _spawnWordFx(w) {
    const el = w && w.blockEl;
    if (!el || typeof document === 'undefined' || !el.isConnected) return;
    try {
      const body = document.body;
      /* 低配/极简/无显卡一律不发：粒子是「每次都在造新 DOM + 起合成层」的东西，
         在纯 CPU 设备上正是最贵的一类（AGENTS.md 约束 12 同一取向）。
         比旧的字级实现多挡了 perf-low —— 词级本来就比字级省，但省的不是关键。 */
      if (body && (body.classList.contains('perf-minimal') || body.classList.contains('perf-low')
        || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches))) {
        return;
      }
      const host = getComputedStyle(el).getPropertyValue('--pv-highlight-color') || '#ffcc33';
      const env = wordBurstEnvelope(w.scale);
      const count = wordBurstCount(w.scale, w.isEmotion);
      for (let i = 0; i < count; i++) {
        const spec = buildBurstParticle(Math.random, i, host);
        const p = document.createElement('span');
        p.className = `pv-char-burst-p pv-word-burst-p kind-${spec.kind}`;
        p.style.setProperty('--tx', `${(spec.tx * env.distMul).toFixed(2)}em`);
        p.style.setProperty('--ty', `${(spec.ty * env.distMul).toFixed(2)}em`);
        p.style.setProperty('--ps', `${(spec.size * env.sizeMul).toFixed(1)}px`);
        p.style.setProperty('--pc', spec.color);
        p.style.setProperty('--pg', `${(spec.size * env.sizeMul * 2.2).toFixed(1)}px`);
        p.style.setProperty('--pa', String(spec.alpha));
        p.style.setProperty('--bd', `${(spec.dur * env.durMul).toFixed(2)}s`);
        p.style.setProperty('--bl', `${spec.bl.toFixed(2)}s`);
        p.style.setProperty('--tr', `${spec.rotateDeg.toFixed(0)}deg`);
        el.appendChild(p);
        setTimeout(() => { if (p.parentNode) p.remove(); }, (spec.dur * env.durMul + spec.bl + 0.2) * 1000);
      }
      /* 星轨只给重点词（hero / 情感词）：每词都画一条就又把画面填满了，
         「特殊」必须是稀缺的，这是上游把 guide 挂在 segment 而非 glyph 上的同一取向 */
      if (w.scale === 'hero' || w.isEmotion) this._drawWordTrail(el, w);
    } catch (e) { logCatch('pvRender', e); }
  }

  /**
   * 词的「星轨」：一条三次贝塞尔从词外起笔、画到词位（上游 sonnetGuides.ts:48-66,160-183）。
   * 用 pathLength="1" + dashoffset 揭示，所以不测长度、不进每帧循环。
   * @private
   */
  _drawWordTrail(el, w) {
    const box = { w: el.offsetWidth || 60, h: el.offsetHeight || 40 };
    const trail = buildStarTrail(Math.random, box);
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'pv-word-trail');
    svg.setAttribute('viewBox', `0 0 ${box.w} ${box.h}`);
    svg.setAttribute('width', box.w);
    svg.setAttribute('height', box.h);
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', trail.d);
    path.setAttribute('pathLength', '1');
    path.style.setProperty('--td', `${trail.durMs}ms`);
    svg.appendChild(path);
    el.appendChild(svg);
    setTimeout(() => { if (svg.parentNode) svg.remove(); }, trail.durMs + 420);
  }

  /**
   * 精准计算指定 DOM 元素相对于舞台中心的 2D 世界坐标 (支持镜头自动平滑跟焦)
   * @private
   */
  _calculateElementWorldCenter(el, sentenceWorldPos) {
    if (!el || !this.currentPosterEl) return null;

    try {
      const posterRect = this.currentPosterEl.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();

      if (posterRect.width === 0 || elRect.width === 0) return null;

      // 元素中心相对于海报中心的局部偏移
      const localOffsetX = (elRect.left + elRect.width / 2) - (posterRect.left + posterRect.width / 2);
      const localOffsetY = (elRect.top + elRect.height / 2) - (posterRect.top + posterRect.height / 2);

      return {
        worldX: Math.round(sentenceWorldPos.x + localOffsetX),
        worldY: Math.round(sentenceWorldPos.y + localOffsetY)
      };
    } catch (e) {
      return null;
    }
  }

  clear() {
    if (this.currentPosterEl && this.currentPosterEl.parentNode) {
      this.currentPosterEl.remove();
    }
    this.currentPosterEl = null;
    this.currentNode = null;
    this.chars = [];
    this.blocks = [];
    this.lines = [];
    this._truckLine = null;
    this._truckCache = null;
  }
}
