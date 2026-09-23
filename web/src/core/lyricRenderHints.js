/**
 * lyricRenderHints.js — 歌词行渲染提示（对齐 上游参考项目 utils/lyrics/renderHints.ts）
 *
 * 按行原始时长把每行分成 micro(<0.10s) / short(<0.18s) / normal 三档，
 * 派生：
 * - lineTransitionMode（none/fast/normal）：行进出场动画开销
 * - wordRevealMode（instant/fast/normal）：行内词揭示节奏
 * - renderEndTime：可视化器可把该行保留在屏上进行 polish 的最晚时刻
 *   （重叠行会被下一行提前截断，但它不是独立时间线）
 *
 * 本模块纯计算：无 DOM、无 Math.random，决定同一输入永远同一输出。
 */

const MICRO_LINE_DURATION_THRESHOLD_MS = 100;
const SHORT_LINE_DURATION_THRESHOLD_MS = 180;
const MICRO_LINE_RENDER_FLOOR_MS = 67;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 行内最后一个词的结束时间（无字词时退回行尾） */
const lastWordEndMs = (line) => {
  const ws = line.words;
  const last = ws && ws.length > 0 ? ws[ws.length - 1] : null;
  return (last && typeof last.end === 'number') ? last.end
    : ((last && typeof last.endTime === 'number') ? last.endTime
      : (typeof line.end === 'number' ? line.end : (typeof line.endTime === 'number' ? line.endTime : line.start)));
};

/**
 * 行进出场/保留的三段时间（normal 档公式）
 * @param {number} rawDurationMs
 * @param {string} mode 'none'|'fast'|'normal'
 * @param {string} reveal 'normal'|'fast'|'instant'
 */
export function getLineTransitionTiming(rawDurationMs, mode, reveal) {
  if (mode === 'none') return { enterDuration: 0, exitDuration: 0, linePassHold: 0 };
  if (mode === 'fast') {
    return {
      enterDuration: clamp(rawDurationMs * 0.45, 45, 60),
      exitDuration: clamp(rawDurationMs * 0.22, 30, 40),
      linePassHold: reveal === 'instant' ? 0 : 30,
    };
  }
  return {
    enterDuration: clamp(Math.max(rawDurationMs, 120) * 0.34, 220, 420),
    exitDuration: clamp(Math.max(rawDurationMs, 120) * 0.18, 180, 320),
    linePassHold: reveal === 'instant' ? 0 : 60,
  };
}

const getTimingClass = (rawDurationMs) => {
  if (rawDurationMs < MICRO_LINE_DURATION_THRESHOLD_MS) return 'micro';
  if (rawDurationMs < SHORT_LINE_DURATION_THRESHOLD_MS) return 'short';
  return 'normal';
};

const timingClassToTransitionMode = (cls) => (cls === 'micro' ? 'none' : cls === 'short' ? 'fast' : 'normal');
const timingClassToRevealMode = (cls) => (cls === 'micro' ? 'instant' : cls === 'short' ? 'fast' : 'normal');

const buildRenderEndTime = (line, rawDurationMs, transitionMode, revealMode) => {
  if (transitionMode === 'none') {
    return Math.max(line.end, line.start + MICRO_LINE_RENDER_FLOOR_MS);
  }
  const tt = getLineTransitionTiming(rawDurationMs, transitionMode, revealMode);
  const linePassStart = Math.max(lastWordEndMs(line), line.start) + tt.linePassHold;
  const exitStart = transitionMode === 'fast'
    ? Math.max(line.start + tt.enterDuration + 10, linePassStart, line.end - tt.exitDuration)
    : Math.max(linePassStart, line.end - tt.exitDuration);
  return Math.max(line.end, exitStart + tt.exitDuration);
};

/**
 * ★ 主入口：构建一行的渲染提示
 * @param {Object} line { start, end, words? }（ms；兼容 startTime/endTime 字段）
 * @returns {Object} { rawDuration, timingClass, renderEndTime, lineTransitionMode, wordRevealMode }
 */
export function buildLineRenderHints(line) {
  const start = (typeof line.start === 'number' ? line.start : line.startTime) || 0;
  const end = typeof line.end === 'number' ? line.end : (typeof line.endTime === 'number' ? line.endTime : start);
  const rawDuration = Math.max(end - start, 0);
  const timingClass = getTimingClass(rawDuration);
  const lineTransitionMode = timingClassToTransitionMode(timingClass);
  const wordRevealMode = timingClassToRevealMode(timingClass);
  return {
    rawDuration,
    timingClass,
    renderEndTime: buildRenderEndTime({ ...line, start, end }, rawDuration, lineTransitionMode, wordRevealMode),
    lineTransitionMode,
    wordRevealMode,
  };
}

/** 整批标注（幂等：已带 renderHints 且一致则原样返回，标记 changed） */
export function annotateLyricLines(lines = []) {
  let changed = false;
  const next = lines.map((line) => {
    if (!line) return line;
    const expected = buildLineRenderHints(line);
    const cur = line.renderHints;
    const ok = cur && cur.rawDuration === expected.rawDuration && cur.timingClass === expected.timingClass
      && cur.renderEndTime === expected.renderEndTime
      && cur.lineTransitionMode === expected.lineTransitionMode && cur.wordRevealMode === expected.wordRevealMode;
    if (ok) return line;
    changed = true;
    return { ...line, renderHints: expected };
  });
  if (!changed) return lines;
  return next;
}

/** 取一行渲染提示（缺省即现场构建） */
export function getLineRenderHints(line) {
  if (!line) return null;
  return line.renderHints || buildLineRenderHints(line);
}

/** 该行可视化器最晚可保留在屏上的时刻 */
export function getLineRenderEndTime(line) {
  return getLineRenderHints(line)?.renderEndTime ?? (typeof line.end === 'number' ? line.end : line.endTime);
}