/**
 * lyricSceneGrouper.js — 歌词「分句/分组器」（对齐 参考实现 sonnetProgram 的段落/镜头划分）
 *
 * 哪几句可以"在一起"，由 4 条规则决定：
 * 1. 时间间隙：行间间隙 ≥ 自适应阈值（中位数×2.5，钳制 1.25~3.5s）→ 新段落
 * 2. 段落标记：歌词自带的段落标记（(Chorus)/(副歌)/(主歌)/(间奏)... 或 flag 字段）变化 → 新段落
 * 3. 超大段落：> 6 行 或 总时长 > 18s → 在行间间隙最大处拆开
 * 4. 段内镜组：≤ maxLines 行 且 组内跨度 ≤ maxSpanSec → 同一镜/场景（上游参考项目 ≤4 行 ≤6s）
 * 段落类型 classify：chorus / break / outro / breath / lift / verse，供上层排版微调节奏。
 */

const clampVal = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 行开始时间（ms）：兼容 start / time 字段 */
export const lineStartOf = (line) => {
  if (!line) return 0;
  if (line.start !== undefined) return Number(line.start) || 0;
  if (line.time !== undefined) return Number(line.time) || 0;
  return 0;
};

/** 行结束时间（ms）：end 优先，否则 start + duration，兜底 3s */
export const lineEndOf = (line) => {
  if (!line) return 3000;
  if (line.end !== undefined) return Math.max(Number(line.end) || 0, lineStartOf(line));
  const s = lineStartOf(line);
  const dur = line.duration !== undefined ? Number(line.duration) : 3000;
  return s + Math.max(dur, 200);
};

/** 视觉尾端：不越过下一行开始（上游参考项目 renderEndTime），重叠行至少等于自身结束 */
const renderEndOf = (line, index, lines) => {
  const e = lineEndOf(line);
  const next = lines[index + 1];
  if (!next) return e;
  const ns = lineStartOf(next);
  return ns > e ? e : Math.max(e, ns);
};

/** 提取行内段落标记：[(Chorus)] / (副歌) / (间奏) 等，或歌词对象自带 flag */
const tagOf = (line) => {
  if (!line) return '';
  if (line.flag && String(line.flag).trim()) return String(line.flag).trim().toLowerCase();
  if (line.songPart && String(line.songPart).trim()) return String(line.songPart).trim().toLowerCase();
  const text = String(line.original || line.text || '');
  const m = text.match(/[\(（\[]\s*([^\)）\]]+)\s*[\)）\]]/);
  if (m) {
    const t = m[1].trim().toLowerCase();
    return /chorus|副歌|hook|间奏|bridge|break|主歌|verse|前奏|intro|尾声|outro|尾奏/i.test(t) ? t : '';
  }
  return '';
};

const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

/** 行间间隙（s），重叠行按 0 */
const gapSecondsOf = (prev, next) => Math.max(0, (lineStartOf(next) - lineEndOf(prev)) / 1000);

/** 自适应段落间隙阈值（s）：median(正间隙)×2.5，钳制 1.25~3.5 */
export function resolveGapThreshold(lines) {
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const g = gapSecondsOf(lines[i - 1], lines[i]);
    if (g > 0) gaps.push(g);
  }
  return clampVal(median(gaps) * 2.5, 1.25, 3.5);
}

/** 段落类型（上游参考项目 classifyParagraph）：chorus/break/outro/breath/lift/verse */
export function classifyScene(lines, index, total) {
  const tags = lines.map(tagOf).join(' ');
  if (/chorus|副歌|hook|chorus/i.test(tags)) return 'chorus';
  if (/bridge|break|间奏|ブリッジ|衔接/i.test(tags)) return 'break';
  if (index === total - 1) return 'outro';
  const start = lineStartOf(lines[0]);
  const end = lineEndOf(lines[lines.length - 1]);
  const duration = (end - start) / 1000;
  const joined = lines.map(l => String(l.original || l.text || '')).join('');
  const punctCount = (joined.match(/[!?！？…]/g) || []).length;
  /* ★ 语言归一化字密度（用户反馈：英文歌在活字/PV 大多白纸——lift 判据按
     「去空格字符数」算密度，英文行字符数天然是中文的 3~5 倍，几乎全部误判成
     lift（白亮纸）→ 纸色/构图分布失真。改为等效视觉单元：CJK 每字 1 单元、
     拉丁/西文连续串（词）计 1 单元——一个英文词 ≈ 一个汉字的信息量，
     中英歌的 kind 分布从此一致，纸色变化对英文歌恢复正常。 */
  const cjkCount = (joined.match(/[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const latinWords = (joined.match(/[A-Za-z0-9\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff]+/g) || []).length;
  const unitCount = cjkCount + latinWords;
  if (duration <= 3.5 || unitCount <= 6) return 'breath';
  if (punctCount >= 2 || unitCount / Math.max(duration, 1) > 2.5) return 'lift';
  return 'verse';
}

/** 超大段落拆分：>8 行 或 总跨度 >18s → 在行间最大间隙处切
 *  ★ 原 >6 行即拆：PV 用户反馈句子被切太碎、上游参考项目 长句更连贯，放宽到 8 行 */
function splitOversizedDraft(lines) {
  const output = [];
  let remaining = lines;
  let guard = 0;
  while (remaining.length > 8 || (remaining.length > 1 && (lineEndOf(remaining[remaining.length - 1]) - lineStartOf(remaining[0])) > 18000)) {
    if (guard++ > 1000) break;
    const candidates = [];
    for (let i = 2; i < remaining.length - 1; i++) {
      candidates.push({ index: i, gap: gapSecondsOf(remaining[i - 1], remaining[i]) });
    }
    candidates.sort((a, b) => b.gap - a.gap);
    const raw = candidates.length ? candidates[0].index : Math.min(4, remaining.length - 1);
    const splitIndex = Math.max(1, raw);
    output.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex);
  }
  output.push(remaining);
  return output;
}

/**
 * ★ 主入口：把歌词行划为「镜组/场景」列表
 * @param {Array} lines 歌词行对象（start/end 或 time/duration + original/text）
 * @param {Object} [opts]
 * @param {number} [opts.maxLines=4] 每组最多行数（上游参考项目 4；蒙德里安传 2 快节奏）
 * @param {number} [opts.maxSpanSec=6.5] 每组时间跨度上限（秒）
 * @returns {Array<{lines:Array, kind:string, start:number, end:number, boundary:string}>}
 */
export function buildSceneGroups(lines = [], opts = {}) {
  if (!Array.isArray(lines) || lines.length === 0) return [];
  /* ★ maxLines 上限放开到 8：PV 用户反馈句子切太碎、上游参考项目 长句更连贯 */
  const maxLines = Math.max(1, Math.min(8, opts.maxLines || 4));
  const maxSpanMs = Math.max(2000, (opts.maxSpanSec != null ? opts.maxSpanSec : 6.5) * 1000);
  const thresholdSec = (opts.gapThresholdSec != null) ? opts.gapThresholdSec : resolveGapThreshold(lines);

  // 1. 段落 draft：间隙阈值 / 段落标记变化 → 边界
  const drafts = [];
  let current = [];
  lines.forEach((line, i) => {
    const prev = lines[i - 1];
    const gapSec = prev ? gapSecondsOf(prev, line) : 0;
    const tag = tagOf(line);
    const prevTag = prev ? tagOf(prev) : '';
    const markBoundary = tag && prevTag && tag !== prevTag;
    const timeBoundary = prev && gapSec >= thresholdSec;
    if (current.length > 0 && (markBoundary || timeBoundary)) {
      drafts.push(...splitOversizedDraft(current));
      current = [];
    }
    current.push(line);
  });
  if (current.length > 0) drafts.push(...splitOversizedDraft(current));

  // 2. 段内镜组：≤maxLines 行且跨度 ≤maxSpanMs
  const scenes = [];
  drafts.forEach((draft) => {
    let group = [];
    let groupStart = 0;
    draft.forEach((line, i) => {
      if (group.length === 0) {
        group = [line];
        groupStart = lineStartOf(line);
        return;
      }
      const spanMs = renderEndOf(line, i, draft) - groupStart;
      if (group.length < maxLines && spanMs <= maxSpanMs) {
        group.push(line);
      } else {
        scenes.push(group);
        group = [line];
        groupStart = lineStartOf(line);
      }
    });
    if (group.length > 0) scenes.push(group);
  });

  // 3. 附 kind 与时间信息
  return scenes.map((group, index) => ({
    lines: group,
    kind: classifyScene(group, index, scenes.length),
    start: lineStartOf(group[0]),
    end: lineEndOf(group[group.length - 1]),
    boundary: 'mixed'
  }));
}