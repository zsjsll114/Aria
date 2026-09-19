/**
 * PVLyricLayout.js
 * PV 模式 2D/3D 海报长镜头流式排版计算核心：
 * 1. 全语言支持 4 大经典日系海报构图模版 (中文/日文/英文/西文全面支持长竖排与横竖交织排版)
 * 2. 支持整行长竖排大柱 (Full-Line Long Vertical Pillars, 4~12 字/词气势贯通)
 * 3. 智能多句长海报聚合 (4~6 句宏大排版，彻底解决字少局促问题)
 * 4. 中日文连续横排词块零空格紧密排版 (CJK Natural Flow)，西文自然保留单词间距
 * 5. 情感词优先锁定不拆分 + 真实 YRC 毫秒级时间轴
 */

import { wordSegmenter } from './WordSegmenter.js';
import { buildSceneGroups } from '../lyricSceneGrouper.js';
import { pickShotProfileV2, handoffDurationSec, hashShotSeed } from './shotProfiles.js';
import { annotateLyricLines, buildLineRenderHints, getLineRenderEndTime } from '../lyricRenderHints.js';

export class PVLyricLayout {
  constructor() {
    this.nodes = [];
  }

  /**
   * 将原始歌词处理成 3D/2D 海报流式排版场景节点
   * @param {Array} rawLyrics 原始歌词对象列表
   * @param {Object} aiData AI 情感分析数据 (情感词、配色等)
   * @param {number} [maxSceneLines] 每个场景最大行数（默认 5：同屏不堆行——
   *   行长者由 maxSpanSec=8 让句子在画面停留更久形成长句连贯观感；
   *   流光隧道显式传 2 获得快节奏分镜）
   * @returns {Array} 海报场景节点列表
   */
  process(rawLyrics = [], aiData = {}, maxSceneLines = 6) {
    if (!Array.isArray(rawLyrics) || rawLyrics.length === 0) {
      this.nodes = [];
      return [];
    }

    const defaultThemeColor = (aiData && aiData.accent_color) || (typeof window !== 'undefined' && window.coverPalette ? window.coverPalette.accent : null) || '#ffcc33';
    
    // 构建精准情感词映射表与情感词列表
    const emotionMap = new Map();
    const emotionWordsList = [];
    if (aiData && Array.isArray(aiData.emotion_words)) {
      aiData.emotion_words.forEach(item => {
        if (!item) return;
        if (typeof item === 'string') {
          const clean = item.trim().toLowerCase();
          if (clean) {
            emotionMap.set(clean, defaultThemeColor);
            emotionWordsList.push(clean);
          }
        } else if (typeof item === 'object' && item.word) {
          const clean = item.word.trim().toLowerCase();
          if (clean) {
            emotionMap.set(clean, item.color || defaultThemeColor);
            emotionWordsList.push(clean);
          }
        }
      });
    }

    // 1. 将歌词按短句智能聚合成宏大多句长海报场景（★ 上游参考项目 分句：自适应间隙阈值 +
    //    段落标记变化 + 组内行数/时长上限，见 lyricSceneGrouper.js）
    const sceneGroups = this._batchLyricsIntoScenes(rawLyrics, maxSceneLines);
    // ★ 上游参考项目 renderHints：场景内每行按原始时长标注 micro(<100ms)/short(<180ms)/normal，
    //   决定行进出场开销与词揭示节奏（见 lyricRenderHints.js）
    sceneGroups.forEach(g => {
      if (Array.isArray(g.lines)) g.lines = annotateLyricLines(g.lines);
    });

    const nodes = [];
    let lastWorldX = 0;
    let lastWorldY = 0;
    let prevShotKey = null;   /* ★ 跨场景传递：构图选取跳过上一页的 kind（上游参考项目 chooseWithoutRepeat） */

    /* ★ 上游参考项目 背景水印词池：全曲语义分词去重（≥2 字符），供各场景取"本镜没在排的
       词"做超大轮廓字——绝不与画面已有歌词重复。CJK 走 WordSegmenter 语义切分，
       否则"车票沾着雨滴"整行会被当一个词 */
    const songWordPool = [];
    {
      const seen = new Set();
      rawLyrics.forEach(line => {
        const t = String(line.original || line.text || '').replace(/[（\(\[][^）\)\]]+[）\)\]]/g, ' ').trim();
        if (!t) return;
        try {
          const st = (typeof line.start === 'number' ? line.start : (line.time || 0));
          const blocks = wordSegmenter._segmentFromPlainText(t, st, st + 3000, []);
          (blocks || []).forEach(b => {
            const w = (b.text || '').trim();
            if (w && w.length >= 2 && !seen.has(w)) {
              seen.add(w);
              songWordPool.push(w);
            }
          });
        } catch (e) {
          // 分词器异常时退化为标点切分
          t.split(/[\s\u3000,，。.．!！?？;；:：、·\-—…]+/).forEach(w => {
            if (w && w.length >= 2 && !seen.has(w)) {
              seen.add(w);
              songWordPool.push(w);
            }
          });
        }
      });
      /* 无词池（全曲单字/极短）时回退：整句前 8 字做轮廓字 */
      if (songWordPool.length === 0) {
        rawLyrics.forEach(line => {
          const t = String(line.original || line.text || '').trim();
          if (t) songWordPool.push(t.slice(0, 8));
        });
      }
    }

    for (let sIdx = 0; sIdx < sceneGroups.length; sIdx++) {
      const sceneLines = sceneGroups[sIdx].lines;
      const sceneKind = sceneGroups[sIdx].kind || 'verse';
      if (!sceneLines || sceneLines.length === 0) continue;

      const firstLine = sceneLines[0];
      const lastLine = sceneLines[sceneLines.length - 1];

      const sceneStart = firstLine.start !== undefined ? firstLine.start : (firstLine.time || 0);
      const sceneEnd = lastLine.end !== undefined ? lastLine.end : (sceneStart + (lastLine.duration || 3000));
      const sceneDuration = Math.max(sceneEnd - sceneStart, 1500);
      const nodeDurationMs = sceneDuration;

      /* ★★ 构图与方向一体决策（参考实现 sonnet/tempera 对齐，用户反馈「方向没规律」）：
         旧制 = 方向按 ARCHETYPES[sIdx%4] 轮换、构图按 mood 池序号轮换——两套独立
         周期互不相干，看起来随机。新制 = 方向是构图自身的属性（orientation 由
         region 宽高比派生），选取走「语义分池（kind→mood）→ 竖排长度闸门 →
         内容哈希定起点 → 跳过上一页」的单一决策链：
         - 同一首歌每次重播版式完全一致（seek/确定性安全）；
         - 相邻两页构图绝不重复；
         - 副歌/上扬只落 loud/neutral 池、呼吸/尾声偏 quiet——规律可感知。 */
      const seedText = sceneLines.map(l => String(l.original || l.text || '').trim()).join('\u241f');
      const allowVertical = sceneLines.every(l => {
        const t = String(l.original || l.text || '').replace(/[(（][^)）]*[)）]/g, '').trim();
        const hasSpaces = /\s/.test(t);
        return t.length <= (hasSpaces ? 45 : 24);
      });
      const shot = pickShotProfileV2(sIdx, sceneKind, {
        seedText,
        prevKey: prevShotKey,
        allowVertical,
        songSeed: String((rawLyrics[0] && (rawLyrics[0].original || rawLyrics[0].text)) || ''),
      });
      prevShotKey = shot.key;
      const pageIsVertical = shot.orientation === 'vertical';
      /* CSS 布局族映射：竖排页=列状排布（vertical-cascade 样式），横排页=wrap 错落
         （pillar-wings 样式）——pv-layout-* 容器类只管排布密度，行方向由 line 类控制 */
      const archetype = pageIsVertical ? 'vertical-cascade' : 'pillar-wings';
      /* ★ hero 竖柱特权（用户批准；参考实现 sonnet editorial 变体 4 的做法）：
         仅横排页、约 1/3 的页面（内容哈希决定，同一首歌重播一致）——该页的
         hero 词块转竖柱大字，support 词保持横排围着排。结构性混排：角色明确
         （只有 hero 竖），不是当初被投诉的无规律短词竖排。竖排页不启用
         （整页已竖，无对比意义）。 */
      const heroPillar = !pageIsVertical && (hashShotSeed('pillar:' + seedText) % 3 === 0);

      // 处理场景内每一行歌词
      const processedLines = [];
      const allSceneBlocks = [];
      let fullSceneText = '';
      const totalLinesInScene = sceneLines.length;

      for (let lIdx = 0; lIdx < totalLinesInScene; lIdx++) {
        const line = sceneLines[lIdx];
        const rawText = (line.original || line.text || '').trim();
        const lStart = line.start !== undefined ? line.start : (line.time || sceneStart);
        const lEnd = line.end !== undefined ? line.end : (lStart + (line.duration || 2500));
        const lDuration = Math.max(lEnd - lStart, 600);

        // 提取副歌括号标签 (如 (Chorus))
        let mainText = rawText;
        let bracketText = '';
        const bracketMatch = rawText.match(/[\(（]([^\)）]+)[\)）]/);
        if (bracketMatch) {
          bracketText = bracketMatch[0];
          mainText = rawText.replace(bracketMatch[0], '').trim();
          if (!mainText) {
            mainText = bracketText;
            bracketText = '';
          }
        }

        // 使用 WordSegmenter 进行分词与时间轴提取
        const rawBlocks = this._semanticTokenize(mainText, line.words, lStart, lEnd, lDuration, emotionWordsList);

        if (!mainText && rawBlocks.length > 0) {
          mainText = rawBlocks.map(b => b.text).join(' ');
        }

        // ★ 页级统一方向：本页所有行同向（整页竖排大柱 or 整页横排自然流），
        //    不再做行级/词块级混排特判——横竖混杂是页内不协调的根源
        const isVerticalLine = pageIsVertical;

        // 分配字阶、情感词匹配与词块竖排决策
        const lineBlocks = this._assignBlockStyles(
          rawBlocks,
          emotionMap,
          sIdx,
          defaultThemeColor,
          lIdx,
          totalLinesInScene,
          isVerticalLine,
          heroPillar
        );

        // 构建单字符时间轴 (优先保留 YRC 原生毫秒时间)
        this._buildCharacterTimings(lineBlocks);

        const trans = (line.translation || line.trans || line.t_original || '').trim();
        const validTrans = (trans && trans !== '//') ? trans : '';
        const roma = (line.romaji || line.roma || '').trim();
        const validRoma = (roma && roma !== '//') ? roma : '';

        // 标记该行内词块所属的行号
        lineBlocks.forEach(b => {
          b.lineIndex = lIdx;
          allSceneBlocks.push(b);
        });

        /* ★ 上游参考项目 renderHints：行内揭示节奏（micro 全行瞬时上屏/short 快进/normal 完整），
           renderEndTime 为可视化器保留该行在屏做 polish 的最晚时刻 */
        const hints = line.renderHints || buildLineRenderHints({ start: lStart, end: lEnd, words: line.words });
        const renderEndTime = getLineRenderEndTime({ ...line, start: lStart, end: lEnd });

        processedLines.push({
          lineIndex: lIdx,
          start: lStart,
          end: lEnd,
          duration: lDuration,
          text: mainText,
          bracketText,
          isVerticalLine,
          blocks: lineBlocks,
          translation: validTrans,
          romaji: validRoma,
          renderHints: hints,
          renderEndTime
        });

        fullSceneText += (fullSceneText ? ' ' : '') + mainText;
      }

      // 空间 3D 漫游锚点 (Diorama 长镜头)
      const angle = (sIdx * 1.62) % (Math.PI * 2);
      const radius = 130 + ((sIdx * 67) % 150);
      const targetWorldX = Math.round(Math.cos(angle) * radius);
      const targetWorldY = Math.round(Math.sin(angle) * (radius * 0.65));

      const sceneWorldX = Math.round(lastWorldX * 0.2 + targetWorldX * 0.8);
      const sceneWorldY = Math.round(lastWorldY * 0.2 + targetWorldY * 0.8);
      lastWorldX = sceneWorldX;
      lastWorldY = sceneWorldY;

      // 电影级 3D 景深与镜头俯仰
      const depthZ = ((sIdx % 3) === 0 ? 35 : ((sIdx % 3) === 1 ? -25 : 0));
      const pitch = ((sIdx % 4) === 0 ? 2.5 : ((sIdx % 4) === 2 ? -2.5 : 0));
      const roll = ((sIdx % 2 === 0) ? 1.2 : -1.2);
      const targetScale = (processedLines.length > 3 ? 0.90 : 1.0);

      const backgroundWords = this._extractBackgroundWords(allSceneBlocks, fullSceneText, songWordPool);

      /* ★ 场景级 renderHints 聚合：场景里最短的行决定场景揭示开销（任一 micro→instant）
         viewEnd = 最后一行 polish 完成时刻（不越过 场景 end 即为纯视觉辅助，不驱动切换） */
      let sceneRevealMode = 'normal';
      let sceneRenderEndTime = 0;
      if (processedLines.length > 0) {
        sceneRenderEndTime = Math.max(...processedLines.map(l => l.renderEndTime || l.end));
        if (processedLines.some(l => l.renderHints && l.renderHints.wordRevealMode === 'instant')) sceneRevealMode = 'instant';
        else if (processedLines.some(l => l.renderHints && l.renderHints.wordRevealMode === 'fast')) sceneRevealMode = 'fast';
      }

      nodes.push({
        index: sIdx,
        archetype,
        kind: sceneKind,
        /* ★ 参考实现 tempera shot profile（编排/运镜/字号缩放/入场方向） */
        shot: shot.key,
        mood: shot.mood,
        region: shot.region,
        enter: shot.enter,
        cam: shot.camera,
        fontScale: shot.region.fontScale,
        handoff: handoffDurationSec(nodeDurationMs),
        start: sceneStart,
        end: sceneEnd,
        duration: sceneDuration,
        text: fullSceneText,
        fullText: fullSceneText,
        lines: processedLines,
        blocks: allSceneBlocks,
        pos: { 
          x: sceneWorldX, 
          y: sceneWorldY, 
          z: depthZ, 
          pitch, 
          roll, 
          scale: targetScale 
        },
        backgroundWords,
        themeColor: defaultThemeColor,
        renderEndTime: sceneRenderEndTime,
        revealMode: sceneRevealMode
      });
    }

    this.nodes = nodes;
    return nodes;
  }

  /**
   * ★ 智能多句长篇海报聚合器（上游参考项目 对齐）
   * 由 lyricSceneGrouper 决定"哪几句在一起"：时间间隙自适应阈值（中位数×2.5，
   * 钳制 1.25~3.5s）、段落标记变化（(Chorus)/(副歌)/(间奏)...）、超大段落(>8行/>18s)
   * 在最大间隙处拆分；段内镜组限制 ≤maxSceneLines 行且跨度 ≤8s（词画面停留更久→长句连贯）。
   * @param {Array} rawLyrics 歌词
   * @param {number} maxSceneLines 每场景最大行数（默认 5；流光隧道传 2 快节奏）
   * @returns {Array<{lines:Array, kind:string}>} 场景分组
   * @private
   */
  _batchLyricsIntoScenes(rawLyrics, maxSceneLines = 5) {
    const maxLines = Math.max(1, Math.min(8, maxSceneLines || 5));
    /* ★ 每页停留时长（用户反馈「歌词还没唱多少就切页」）：跨度上限 8s → 11.5s、
       行数 5 → 6——构图池每幅都是设计过的版面，需要足够的停留时间被看清；
       分组仍受自适应间隙阈值约束（间隙大的地方照样切段，语义边界不受影响） */
    const groups = buildSceneGroups(rawLyrics, { maxLines, maxSpanSec: 11.5 });
    // 兼容旧调用方：每条场景至少带 lines（含已归一的 start/end/text）
    return groups.map(g => ({
      lines: g.lines.map(line => ({
        ...line,
        start: line.start !== undefined ? line.start : (line.time || 0),
        end: line.end !== undefined ? line.end : (line.start !== undefined ? line.start : (line.time || 0)) + (line.duration || 3000),
        text: (line.original || line.text || '').trim()
      })),
      kind: g.kind
    }));
  }

  /**
   * 根据当前时间毫秒数查找活跃场景节点
   */
  getActiveIndex(timeMs) {
    if (!this.nodes || this.nodes.length === 0) return -1;

    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      if (timeMs >= node.start && timeMs < node.end) {
        return i;
      }
    }

    for (let i = this.nodes.length - 1; i >= 0; i--) {
      if (timeMs >= this.nodes[i].start) {
        return i;
      }
    }

    return 0;
  }

  /**
   * 专业级多语言语义分词器调度 (对接 WordSegmenter)
   * @private
   */
  _semanticTokenize(text, yrcWords, lineStart, lineEnd, duration, emotionWords = []) {
    let blocks;
    if (Array.isArray(yrcWords) && yrcWords.length > 0) {
      blocks = wordSegmenter.segmentYrcWords(text, yrcWords, lineStart, lineEnd, emotionWords);
    } else {
      blocks = wordSegmenter._segmentFromPlainText(text, lineStart, lineEnd, emotionWords);
    }
    /* ★ sticky 标点/缩约合并（上游参考项目 布局单位对齐）：It|'|s → It's，标点并入前词 */
    blocks = wordSegmenter.stickyMergeBlocks(blocks);
    /* ★ 中文「≥4 字语义段」聚合（用户反馈：1~2 字一块太散、日文更顺眼）：
       相邻 CJK 词块级联为 ≥4 字段，标点/情感词为断点，英文保持词界 */
    return wordSegmenter.collapseShortCjkBlocks(blocks, 4);
  }

  /**
   * 多情感词主次层级自适应字阶、精准 AI 情感词匹配与长竖排柱子决策 (全语言通用)
   * @private
   */
  _assignBlockStyles(blocks, emotionMap, sceneIndex, defaultThemeColor, lineInScene = 0, totalLinesInScene = 1, isVerticalLine = false, heroPillar = false) {
    if (!blocks || blocks.length === 0) return [];

    const totalBlocks = blocks.length;

    // 1. 精准情感词匹配与视觉评分
    const blockMetadata = blocks.map((b, idx) => {
      const clean = (b.text || '').trim().toLowerCase();
      let isEmotion = Boolean(b.isEmotion);
      let emotionColor = null;

      if (clean && emotionMap.has(clean)) {
        isEmotion = true;
        emotionColor = emotionMap.get(clean);
      } else {
        for (const [eWord, color] of emotionMap.entries()) {
          if (clean === eWord || (clean.length >= 2 && eWord.length >= 2 && (clean.includes(eWord) || eWord.includes(clean)))) {
            isEmotion = true;
            emotionColor = color;
            break;
          }
        }
      }

      if (isEmotion && !emotionColor) {
        emotionColor = defaultThemeColor;
      }

      let score = 0;
      if (isEmotion) score += 50;
      const len = clean.length;
      if (len >= 3 && len <= 10) score += 20;
      if (idx > 0 && idx < totalBlocks - 1) score += 10;

      const minorWords = new Set(['the', 'a', 'an', 'de', 'la', 'les', 'du', 'des', 'of', 'in', 'on', 'at', 'to', 'and', 'or', 'is', 'it', 'my', '的', '了', '着', '在', '是', '和', '有', '我', '你', '他', '她', '它', '这', '那', 'の', 'に', 'は', 'を', 'が', 'de', 'と']);
      if (minorWords.has(clean)) score -= 12;

      return {
        clean,
        isEmotion,
        emotionColor,
        score,
        idx
      };
    });

    // 2. 选举主视觉 Peak Hero 词
    const sortedByScore = [...blockMetadata].sort((a, b) => b.score - a.score);
    const heroIndices = new Set();
    if (sortedByScore[0]) {
      heroIndices.add(sortedByScore[0].idx);
    }
    if (totalBlocks >= 4 && sortedByScore[1] && sortedByScore[1].isEmotion) {
      if (Math.abs(sortedByScore[1].idx - sortedByScore[0].idx) >= 2) {
        heroIndices.add(sortedByScore[1].idx);
      }
    }

    // 3. 多情感词与普通词自适应字阶分配与长竖排大柱决策
    let emotionOrder = 0;
    return blocks.map((b, idx) => {
      const meta = blockMetadata[idx];
      let scale = 'minor';
      let isVertical = Boolean(isVerticalLine); // 若整行定义为竖排大柱，则词块竖向流转；横排行保持横向自然阅读流

      if (heroIndices.has(idx)) {
        scale = 'hero'; // ★ 巨型大字
        /* ★ hero 竖柱特权（上游参考项目 editorial 变体 4）：仅横排页 + heroPillar 变体时，
           hero 词块竖排大字、support 词横排围着排——结构性混排（角色明确）。
           CJK 逐字成柱；纯拉丁 hero 由渲染层 pv-latin-sideways 自动整词侧躺。 */
        if (heroPillar) isVertical = true;
      } else if (meta.isEmotion) {
        emotionOrder++;
        if (emotionOrder % 2 === 1) {
          scale = 'major'; // 次要情感词：中号字
        } else {
          scale = 'minor';
        }
      } else {
        if (meta.clean.length >= 4 && totalBlocks <= 4) {
          scale = 'major';
        } else {
          scale = 'minor';
        }
      }
      /* 方向只由页级 isVerticalLine 决定——词块不再自行竖排（横竖混排已移除） */

      const hasTargetBox = (scale === 'hero' || meta.isEmotion);

      return {
        ...b,
        scale,
        isVertical,
        isEmotion: meta.isEmotion,
        emotionColor: meta.emotionColor,
        hasTargetBox
      };
    });
  }

  /**
   * 为每个词块内的单字符生成独立的时间戳
   * @private
   */
  _buildCharacterTimings(blocks) {
    blocks.forEach(b => {
      if (Array.isArray(b.chars) && b.chars.length > 0) {
        return;
      }
      const rawChars = Array.from(b.text);
      const charCount = rawChars.length || 1;
      const blockDur = Math.max(b.end - b.start, 80);
      const timePerChar = blockDur / charCount;

      b.chars = rawChars.map((ch, ci) => {
        const cStart = Math.round(b.start + ci * timePerChar);
        const cEnd = Math.round((ci === charCount - 1) ? b.end : (cStart + timePerChar));
        return {
          char: ch,
          start: cStart,
          end: cEnd
        };
      });
    });
  }

  /**
   * ★ 提取背景巨型轮廓字（上游参考项目 水印对齐：优先取「本镜没在排」的全曲词；
   *   无可用词池时回退到本镜情感词/hero 词，绝不再重复已选词）
   * @param {Array} blocks 本场景全部词块
   * @param {string} mainText 本场景全文
   * @param {Array} [songWordPool] 全曲词池（去重 ≥2 字符）
   * @returns {Array<string>} 最多 2 个轮廓字
   * @private
   */
  _extractBackgroundWords(blocks, mainText, songWordPool) {
    if (!blocks || blocks.length === 0) return [mainText.slice(0, 5)];

    const onScreen = new Set(blocks.map(b => (b.text || '').trim().toLowerCase()).filter(Boolean));

    const chosen = [];
    if (Array.isArray(songWordPool) && songWordPool.length > 0) {
      // 词池里排除本场景已在屏上的词；按池内出现顺序（副歌等高频词自然靠后场景覆盖）
      for (let i = 0; i < songWordPool.length && chosen.length < 2; i++) {
        const w = songWordPool[i];
        if (!onScreen.has(w.toLowerCase())) chosen.push(w);
      }
    }

    if (chosen.length === 0) {
      // 兜底：本镜情感词/hero 词做轮廓字
      const candidateWords = [];
      blocks.forEach(b => {
        const clean = (b.text || '').trim();
        if (!clean) return;
        if (b.isEmotion || b.scale === 'hero') candidateWords.push(clean);
      });
      if (candidateWords.length === 0) {
        blocks.forEach(b => {
          const clean = (b.text || '').trim();
          if (clean.length >= 2) candidateWords.push(clean);
        });
      }
      if (candidateWords.length === 0) {
        candidateWords.push(mainText.slice(0, 5));
      }
      for (let i = 0; i < candidateWords.length && chosen.length < 2; i++) {
        if (!chosen.includes(candidateWords[i])) chosen.push(candidateWords[i]);
      }
    }

    return chosen.slice(0, 2);
  }
}
