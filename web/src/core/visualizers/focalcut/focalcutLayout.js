/* ============================================================
 * focalcutLayout.js — 「镜幕 · FocalCut」电影感宽银幕建筑排版引擎
 *
 * 将歌词按乐段编译为多行统一的 1920×1080 世界画布展墙：
 *   - 均衡强势的编辑级字号层级（76~112px），避免当前演唱行落入过小副行；
 *   - 四种克制而富有张力的电影构图原型：左轴齐排 / 巨幕居中 / 右轴画廊 / 诗意阶梯；
 *   - 精确计算每字/每词世界坐标 (wx, wy, ww, wh)，供电影云台平滑跟拍、光缝对齐与双镜分屏；
 *   - 识别 AI 情感关键词并标定整词区间，供特写拉焦与高光轨触发。
 * ============================================================ */

import { buildSceneGroups } from '../../lyricSceneGrouper.js';

export const WORLD_W = 1920;
export const WORLD_H = 1080;

const CJK_RE = /[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const WALL_ARCHETYPES = ['editorial-left', 'cinema-center', 'staggered-step', 'gallery-right'];

function isCjk(ch) {
  return CJK_RE.test(ch);
}

function charWidthRatio(ch) {
  if (ch === ' ') return 0.34;
  if (isCjk(ch)) return 1.04;
  if (/[.,'’!?:;|()[\]"-]/.test(ch)) return 0.36;
  if (/[MW@#%&]/.test(ch)) return 0.80;
  if (/[ilIjtfr]/.test(ch)) return 0.36;
  return 0.62;
}

/* 将一句歌词拆分为渲染单元（CJK 单字 / 拉丁整词 / 空格），保留精确词界时间戳 */
function buildLineUnits(line) {
  const text = String(line.original || line.text || '').trim();
  const lineStart = line.start !== undefined ? Number(line.start) : (Number(line.time) || 0);
  const rawEnd = line.end !== undefined ? Number(line.end) : lineStart + (Number(line.duration) || 4200);
  const lineEnd = Math.max(lineStart + 240, rawEnd);
  const units = [];

  const splitRaw = (str, ws, we) => {
    const tokens = [];
    let buf = '';
    const flush = () => {
      if (buf) {
        tokens.push({ t: buf, isSpace: false, w: Array.from(buf).reduce((s, c) => s + charWidthRatio(c), 0) });
        buf = '';
      }
    };
    for (const ch of Array.from(String(str || ''))) {
      if (isCjk(ch)) {
        flush();
        tokens.push({ t: ch, isSpace: false, w: charWidthRatio(ch) });
      } else if (ch === ' ') {
        flush();
        tokens.push({ t: ' ', isSpace: true, w: 0.34 });
      } else {
        buf += ch;
      }
    }
    flush();

    const totalW = tokens.reduce((s, x) => s + x.w, 0) || 1;
    let acc = 0;
    for (const tk of tokens) {
      const s = ws + (we - ws) * (acc / totalW);
      const e = ws + (we - ws) * ((acc + tk.w) / totalW);
      acc += tk.w;
      units.push({ text: tk.t, isSpace: tk.isSpace, widthRatio: tk.w, start: s, end: e });
    }
  };

  const words = Array.isArray(line.words) ? line.words.filter(w => w && w.text) : [];
  if (words.length > 0) {
    let cursor = 0;
    let prevEnd = -1;
    for (const w of words) {
      const wtxt = String(w.text).trim();
      const ws = typeof w.start === 'number' ? w.start : lineStart;
      const we = typeof w.end === 'number' ? w.end : ws + 220;
      if (wtxt && cursor < text.length) {
        const idx = text.indexOf(wtxt, cursor);
        if (idx >= 0) {
          const gap = text.slice(cursor, idx);
          if (gap && !/\S/.test(gap) && prevEnd >= 0 && units.length) {
            const gs = Math.min(prevEnd, ws);
            const ge = Math.max(prevEnd, ws);
            units.push({ text: ' ', isSpace: true, widthRatio: 0.34, start: gs, end: Math.max(ge, gs + 60) });
          }
          cursor = idx + wtxt.length;
        }
      }
      if (wtxt) splitRaw(wtxt, ws, Math.max(we, ws + 40));
      prevEnd = Math.max(we, ws + 40);
    }
  } else {
    splitRaw(text, lineStart, lineEnd);
  }

  for (let i = 0; i < units.length; i++) {
    if (units[i].end <= units[i].start) units[i].end = units[i].start + 60;
    if (i > 0 && units[i].start < units[i - 1].end) units[i].start = units[i - 1].end;
  }

  return { text, lineStart, lineEnd, units };
}

function extractEmotionList(aiData) {
  if (!aiData || !Array.isArray(aiData.emotion_words)) return [];
  return aiData.emotion_words
    .map(w => (typeof w === 'string' ? w : (w && w.word) || ''))
    .filter(w => w && w.length >= 2);
}

function pickWatermarkGlyph(lineItems, wallIndex) {
  const focal = lineItems.find(l => l.isFocal) || lineItems[0];
  if (focal && focal.units) {
    const emoChars = focal.units.filter(u => !u.isSpace && u.isEmotion).map(u => u.text);
    if (emoChars.length > 0) return emoChars.slice(0, 2).join('');
    const nonSpace = focal.units.filter(u => !u.isSpace && /[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7afA-Za-z]/.test(u.text));
    if (nonSpace.length > 0) {
      const mid = nonSpace[Math.floor(nonSpace.length * 0.4)];
      return mid.text.slice(0, 2);
    }
  }
  return String(wallIndex + 1).padStart(2, '0');
}

/**
 * 将全曲歌词编译为若干「电影展墙 Wall」
 * @param {Array} lines
 * @param {Object} aiData
 */
export function compileFocalCutWalls(lines = [], aiData = {}) {
  if (!Array.isArray(lines) || !lines.length) return { walls: [], lineToWall: new Map() };

  const groups = buildSceneGroups(lines, { maxLines: 3, maxSpanSec: 11 }) || [];
  const emoList = extractEmotionList(aiData);

  const walls = [];
  const lineToWall = new Map();

  groups.forEach((grp, wi) => {
    const kind = grp.kind || 'verse';
    const isChorus = kind === 'chorus' || (kind === 'lift' && wi > 0);
    const polarity = (wi === 0) ? 'dark' : (isChorus ? 'light' : 'dark');
    const archetype = isChorus
      ? (wi % 2 === 0 ? 'cinema-center' : 'staggered-step')
      : WALL_ARCHETYPES[wi % WALL_ARCHETYPES.length];

    const lineItems = [];
    const lineIndices = [];
    for (const ln of grp.lines) {
      const idx = lines.indexOf(ln);
      if (idx >= 0) lineIndices.push(idx);
    }

    const count = grp.lines.length;
    /* 选定焦点行（优先含 AI 情感词，否则居中行），焦点行只微幅抬升，确保每行都具有电影主角分量 */
    let focalRow = Math.floor((count - 1) / 2);
    grp.lines.forEach((ln, ri) => {
      const txt = String(ln.original || ln.text || '');
      if (emoList.some(ew => txt.includes(ew))) focalRow = ri;
    });

    /* 宽银幕留白节奏：留出上方电影遮幅 + 下方译文与底栏呼吸空间 */
    const rowPitch = count <= 2 ? 156 : (count === 3 ? 138 : 118);
    const totalSpan = (count - 1) * rowPitch;
    const yCenterOffset = -56;

    grp.lines.forEach((ln, ri) => {
      const idx = lines.indexOf(ln);
      const { text, lineStart, lineEnd, units } = buildLineUnits(ln);
      const isFocal = ri === focalRow;
      const charCount = units.reduce((s, u) => s + (u.isSpace ? 0.34 : u.widthRatio), 0) || 1;

      /* 所有行均具备电影级视觉体量（84~106px），焦点行适度加强，绝不出现过小副行 */
      const basePx = isFocal ? (isChorus ? 108 : 100) : (isChorus ? 88 : 82);
      const maxRowW = isFocal ? 1420 : 1320;
      const estW = charCount * basePx * 1.05;
      const fitPx = estW > maxRowW ? Math.max(46, basePx * (maxRowW / estW)) : basePx;
      const rowW = charCount * fitPx * 1.05;

      let align;
      let startX;
      if (archetype === 'cinema-center') {
        align = 'center';
        startX = -rowW / 2;
      } else if (archetype === 'gallery-right') {
        align = 'right';
        const indent = (ri % 2 === 1 && !isFocal) ? 56 : 0;
        startX = (580 - indent) - rowW;
      } else if (archetype === 'staggered-step') {
        align = 'center';
        const stepRatio = count <= 1 ? 0 : ((ri / (count - 1)) - 0.5);
        const shift = stepRatio * 240;
        const maxShift = Math.max(0, 680 - rowW / 2);
        const clampedShift = Math.max(-maxShift, Math.min(maxShift, shift));
        startX = clampedShift - rowW / 2;
      } else {
        align = 'left';
        const indent = (ri % 2 === 1 && !isFocal) ? 62 : 0;
        startX = -580 + indent;
      }

      /* 防止单行超出安全画幅边界 [-740, +740] */
      if (startX < -740) startX = -740;
      if (startX + rowW > 740) startX = Math.max(-740, 740 - rowW);

      const wy = yCenterOffset - totalSpan / 2 + ri * rowPitch;

      /* 情感词命中范围 */
      const fullStr = units.map(u => u.text).join('');
      const emoHits = [];
      for (const ew of emoList) {
        let from = 0;
        while (emoHits.length < 200) {
          const hitAt = fullStr.indexOf(ew, from);
          if (hitAt < 0) break;
          emoHits.push([hitAt, hitAt + ew.length]);
          from = hitAt + ew.length;
        }
      }

      let cursorX = startX;
      let strOff = 0;
      const positionedUnits = units.map((u, ui) => {
        const uw = u.widthRatio * fitPx * 1.05;
        const cx = cursorX + uw / 2;
        cursorX += uw;
        const hitEmo = !u.isSpace && emoHits.some(([a, b]) => strOff < b && (strOff + u.text.length) > a);
        strOff += u.text.length;
        return {
          ...u,
          ui,
          wx: cx,
          wy,
          ww: uw,
          wh: fitPx * 1.24,
          isEmotion: hitEmo,
        };
      });

      const lineCenterX = startX + rowW / 2;
      const item = {
        lineIndex: idx,
        rowIndex: ri,
        text,
        translation: String(ln.trans || ln.translation || ''),
        romaji: String(ln.romaji || ''),
        start: lineStart,
        end: lineEnd,
        isFocal,
        align,
        fontSize: fitPx,
        weight: isFocal ? 900 : 800,
        wx: lineCenterX,
        wy,
        leftX: startX,
        width: rowW,
        height: fitPx * 1.28,
        units: positionedUnits,
      };
      lineItems.push(item);
      if (idx >= 0) lineToWall.set(idx, wi);
    });

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const li of lineItems) {
      minX = Math.min(minX, li.leftX);
      maxX = Math.max(maxX, li.leftX + li.width);
      minY = Math.min(minY, li.wy - li.height * 0.58);
      maxY = Math.max(maxY, li.wy + li.height * 0.58);
    }
    if (!Number.isFinite(minX)) { minX = -480; maxX = 480; minY = -200; maxY = 200; }

    walls.push({
      id: wi,
      kind,
      polarity,
      archetype,
      watermarkGlyph: pickWatermarkGlyph(lineItems, wi),
      lineIndices,
      lines: lineItems,
      bounds: {
        minX, maxX, minY, maxY,
        cx: (minX + maxX) / 2,
        cy: (minY + maxY) / 2,
        w: Math.max(360, maxX - minX),
        h: Math.max(180, maxY - minY),
      },
      start: lineItems[0] ? lineItems[0].start : 0,
      end: lineItems[lineItems.length - 1] ? lineItems[lineItems.length - 1].end : 5000,
    });
  });

  return { walls, lineToWall };
}
