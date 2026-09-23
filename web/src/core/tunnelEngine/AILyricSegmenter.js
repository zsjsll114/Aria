/**
 * AILyricSegmenter.js — AI 驱动歌词句意分段器
 *
 * 核心职责：
 * 1. 将歌词按句意划分为「页」(4-7 词/页)
 * 2. 每页内部按词组划分换行
 * 3. 每页分配对齐方式 (left/center/right) 与背景主题
 * 4. 支持 AI 返回的 line_analyses 数据，也支持纯规则降级
 *
 * 与 TunnelDirector 集成点：
 * - TunnelDirector._refineBlocks() 调用 segmentBlocks()
 * - AI 返回的 line_analyses 包含 page_index / line_breaks / alignment 字段
 */

/* ========== 对齐方式池（跨页连贯：同组内 75% 概率沿用，只在句组边界切换） ========== */
const ALIGNMENT_POOL = ['center', 'left', 'center', 'right'];
const COHERENCE = 0.75;  // 75% 概率沿用前一页的对齐，确保视觉连贯

/* ========== 每页目标词数范围 ========== */
const MIN_WORDS_PER_PAGE = 4;
const MAX_WORDS_PER_PAGE = 7;

/**
 * 根据 AI 分析数据对歌词进行句意分页
 *
 * @param {Array} blocks 词块数组（来自 PVLyricLayout 分词）
 * @param {Object} aiData AI 数据（可选）
 * @param {number} shotIndex 当前 shot 索引
 * @returns {{ pages: Array, alignment: string, pageIndex: number }}
 */
export function segmentBlocksByAI(blocks, aiData, shotIndex, lineIndex = null) {
  if (!blocks || !blocks.length) {
    return { pages: [], alignment: 'center', pageIndex: shotIndex || 0 };
  }

  // AI line_analyses 可用时，使用 AI 分段结果
  let lineAnalyses = (aiData && aiData.line_analyses) || [];
  if (Array.isArray(lineAnalyses) && lineAnalyses.length > 0) {
    // ★ 关键：必须先按 line_index 过滤到「当前行」，否则多行共享 0..N-1 词索引时
    //   会把其它行的分页误判为当前行，导致蒙德里安分页错乱。
    if (lineIndex != null) {
      lineAnalyses = lineAnalyses.filter(a => a && Number(a.line_index) === Number(lineIndex));
    }
    if (Array.isArray(lineAnalyses) && lineAnalyses.length > 0) {
      const pageResult = _applyAIPageAssignment(blocks, lineAnalyses, shotIndex);
      if (pageResult && pageResult.pages.length > 0) {
        return pageResult;
      }
    }
  }

  // 降级：规则驱动分页
  return _ruleBasedSegment(blocks, shotIndex);
}

/**
 * 应用 AI 返回的 page_index / line_breaks 数据
 *
 * AI line_analyses 格式：
 * [{
 *   line_index: 行索引,
 *   emotion: 'sorrow'|'love'|'anger'|'hope'|'betray'|'neutral',
 *   energy: 0.0-1.0,
 *   keywords: ['词1', '词2'],
 *   page_index: 0,              // 可选：AI 指定的页序号
 *   group_indices: [0, 1, 2],   // 可选：该页包含的词块索引
 *   alignment: 'left'|'center'|'right',  // 可选：该页对齐方式
 *   line_breaks: [2, 5],        // 可选：页内换行位置
 *   bg_theme: '暗夜紫'|...      // 可选：背景主题偏好
 * }]
 */
function _applyAIPageAssignment(blocks, lineAnalyses, shotIndex) {
  const result = { pages: [], alignment: 'center', pageIndex: shotIndex || 0 };
  const totalBlocks = blocks.length;

  // 收集 AI 对当前 shot 的分段信息
  const shotGroups = [];

  for (let bi = 0; bi < totalBlocks; bi++) {
    const block = blocks[bi];
    let assigned = false;

    // 查找包含此词块的 AI 分组
    for (let ai = 0; ai < lineAnalyses.length; ai++) {
      const analysis = lineAnalyses[ai];
      if (!analysis || !analysis.group_indices) continue;

      if (Array.isArray(analysis.group_indices) && analysis.group_indices.includes(bi)) {
        const groupKey = `ai_${ai}`;
        let group = shotGroups.find(g => g.key === groupKey);
        if (!group) {
          group = {
            key: groupKey,
            indices: [],
            alignment: analysis.alignment || ALIGNMENT_POOL[shotIndex % ALIGNMENT_POOL.length],
            lineBreaks: analysis.line_breaks || [],
            bgTheme: analysis.bg_theme || null,
            emotion: analysis.emotion || 'neutral',
            energy: analysis.energy || 0.5
          };
          shotGroups.push(group);
        }
        group.indices.push(bi);
        assigned = true;
        break;
      }
    }

    // 对于未被 AI 分配的词块，按顺序归入最近的分组
    if (!assigned) {
      const lastGroup = shotGroups[shotGroups.length - 1];
      if (lastGroup) {
        lastGroup.indices.push(bi);
      } else {
        const firstGroup = {
          key: 'ai_default_0',
          indices: [bi],
          alignment: ALIGNMENT_POOL[shotIndex % ALIGNMENT_POOL.length],
          lineBreaks: [],
          bgTheme: null,
          emotion: 'neutral',
          energy: 0.5
        };
        shotGroups.push(firstGroup);
      }
    }
  }

  // 按词块索引排序分组，保持原始顺序
  shotGroups.sort((a, b) => Math.min(...a.indices) - Math.min(...b.indices));

  // 从分组生成页（每页 4-7 词）
  result.pages = _buildPagesFromGroups(blocks, shotGroups);

  // ★ 跨页连贯对齐：多页时第一页的对齐方式引导后续页面
  if (result.pages.length > 1) {
    const leadAlign = result.pages[0].alignment;
    for (let i = 1; i < result.pages.length; i++) {
      const r = ((shotIndex * 31 + i * 17) % 100) / 100;
      if (r < COHERENCE) {
        result.pages[i].alignment = leadAlign;  // 沿用：75%
      }
    }
  }

  // 应用第一页的对齐方式
  if (result.pages.length > 0 && result.pages[0].alignment) {
    result.alignment = result.pages[0].alignment;
  }

  return result;
}

/**
 * 规则驱动分段（AI 不可用时降级）
 *
 * 策略：
 * 1. 优先按情感词+结构助词分段（句号、感叹号、换行等）
 * 2. 每页控制在 4-7 词
 * 3. 确保语义连贯（避免在短语中间断开）
 * 4. 跨页对齐连贯：同一段落内尽量共用对齐
 */
function _ruleBasedSegment(blocks, shotIndex) {
  const result = { pages: [], alignment: 'center', pageIndex: shotIndex || 0 };
  if (!blocks || blocks.length === 0) return result;

  const total = blocks.length;

  // 按语义断点标记索引
  const breakScores = _computeBreakScores(blocks);

  // 使用贪心分页：从 breakScores 中选择最佳断点
  const pages = [];
  let start = 0;

  while (start < total) {
    let end = Math.min(start + MIN_WORDS_PER_PAGE, total);
    const searchEnd = Math.min(start + MAX_WORDS_PER_PAGE, total);
    let bestBreak = -1;
    let bestScore = -1;

    for (let i = start + MIN_WORDS_PER_PAGE; i <= searchEnd && i < total; i++) {
      const score = breakScores[i] || 0;
      if (score > bestScore && (i - start) >= MIN_WORDS_PER_PAGE) {
        bestScore = score;
        bestBreak = i;
      }
    }

    if (bestBreak > 0 && (bestBreak - start) <= MAX_WORDS_PER_PAGE) {
      end = bestBreak;
    } else if (searchEnd - start > MAX_WORDS_PER_PAGE) {
      end = start + MAX_WORDS_PER_PAGE;
    } else {
      end = searchEnd;
    }

    pages.push({
      startIdx: start,
      endIdx: end - 1,
      blocks: blocks.slice(start, end),
      alignment: ALIGNMENT_POOL[(shotIndex + pages.length) % ALIGNMENT_POOL.length],
      lineBreaks: _computeLineBreaks(blocks.slice(start, end)),
      wordCount: end - start
    });

    start = end;
  }

  // ★ 跨页连贯对齐：第一页定基调，后续页 75% 概率保持
  if (pages.length > 1) {
    const leadAlign = pages[0].alignment;
    for (let i = 1; i < pages.length; i++) {
      const r = ((shotIndex * 13 + i * 23) % 100) / 100;
      if (r < COHERENCE) {
        pages[i].alignment = leadAlign;
      }
    }
  }

  result.pages = pages;
  if (pages.length > 0) {
    result.alignment = pages[0].alignment;
  }

  return result;
}

/**
 * 计算每个位置的断点分数
 */
function _computeBreakScores(blocks) {
  const scores = new Array(blocks.length).fill(0);

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const text = (b.text || '').trim();

    if (/[。！？!?…]+/.test(text)) scores[i] += 10;
    if (/[、,，;；]+/.test(text)) scores[i] += 3;
    if (b.isEmotion && /[。！？!?]+/.test(text)) scores[i] += 5;

    const len = Array.from(text).length;
    if (len >= 4) scores[i] += 2;
    if (len >= 6) scores[i] += 3;
    if (b.isEmotion) scores[i] += 2;
  }

  for (let i = 1; i < blocks.length - 1; i++) {
    if (scores[i] > 0 && scores[i + 1] > 0) {
      scores[i] += 1;
      scores[i + 1] += 1;
    }
  }

  return scores;
}

/**
 * 计算页内换行位置
 */
function _computeLineBreaks(pageBlocks) {
  const breaks = [];
  if (!pageBlocks || pageBlocks.length === 0) return breaks;

  let wordsInLine = 0;
  for (let i = 0; i < pageBlocks.length; i++) {
    const b = pageBlocks[i];
    const text = (b.text || '').trim();

    wordsInLine++;

    if (/[。！？!?…,，;；]+/.test(text) && wordsInLine >= 2) {
      breaks.push(i);
      wordsInLine = 0;
      continue;
    }

    if (wordsInLine >= 4 && i < pageBlocks.length - 1) {
      breaks.push(i);
      wordsInLine = 0;
    }
  }

  return breaks;
}

/**
 * 将分组构建为页结构
 */
function _buildPagesFromGroups(blocks, groups) {
  const pages = [];
  for (const group of groups) {
    const sortedIndices = [...group.indices].sort((a, b) => a - b);
    const groupBlocks = sortedIndices.map(i => blocks[i]).filter(Boolean);

    if (groupBlocks.length === 0) continue;

    if (groupBlocks.length > MAX_WORDS_PER_PAGE) {
      let start = 0;
      while (start < groupBlocks.length) {
        const chunk = groupBlocks.slice(start, start + MAX_WORDS_PER_PAGE);
        pages.push({
          startIdx: sortedIndices[start],
          endIdx: sortedIndices[Math.min(start + MAX_WORDS_PER_PAGE, sortedIndices.length) - 1],
          blocks: chunk,
          alignment: group.alignment,
          lineBreaks: _computeLineBreaks(chunk),
          wordCount: chunk.length,
          bgTheme: group.bgTheme,
          emotion: group.emotion,
          energy: group.energy
        });
        start += MAX_WORDS_PER_PAGE;
      }
    } else {
      pages.push({
        startIdx: sortedIndices[0],
        endIdx: sortedIndices[sortedIndices.length - 1],
        blocks: groupBlocks,
        alignment: group.alignment,
        lineBreaks: group.lineBreaks || _computeLineBreaks(groupBlocks),
        wordCount: groupBlocks.length,
        bgTheme: group.bgTheme,
        emotion: group.emotion,
        energy: group.energy
      });
    }
  }
  return pages;
}

/**
 * 多页分词：将一组 blocks 按语义拆分为多个子页
 *
 * @param {Array} blocks 完整词块数组
 * @param {Object} aiData AI 数据
 * @param {number} shotIndex shot 索引
 * @returns {Array<{ blocks: Array, alignment: string, lineBreaks: Array, bgTheme: string, emotion: string }>}
 */
export function multiPageSegment(blocks, aiData, shotIndex, lineIndex = null) {
  const result = segmentBlocksByAI(blocks, aiData, shotIndex, lineIndex);
  return result.pages.map((page, idx) => ({
    blocks: page.blocks,
    alignment: page.alignment,
    lineBreaks: page.lineBreaks,
    bgTheme: page.bgTheme || null,
    emotion: page.emotion || 'neutral',
    energy: page.energy || 0.5,
    pageIndex: idx,
    wordCount: page.wordCount
  }));
}

/* ★ 旧的 AI 分段提示词已并入 aiAnalyzer.buildSystemPrompt（唯一权威版本），此处移除避免重复版本 */
