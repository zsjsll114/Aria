/**
 * sonnetProgram.js — folia sonnet 时间轴编译（sonnetProgram.ts 的 JS 移植）
 *
 * 歌词行 → 「段落 paragraph → 镜头 shot → 逐字 cue」三级确定性时间轴。
 * seek 安全：整个 program 是 lines+seed 的纯函数。
 * 上游：chthollyphile/folia-major src/components/visualizer/sonnet/sonnetProgram.ts
 */

import { hashSonnetSeed } from './sonnetRandom.js';
import { buildSonnetSemanticSegments } from './sonnetSemantic.js';

export const SONNET_SHOT_KINDS = [
    'editorial-column',
    'type-impact',
    'fragment-collage',
    'tracking-ribbon',
    'mask-reveal',
    'poster-blocks',
    'quiet-tableau',
];

/* ★ 2026-10-02（用户实测「大背景图形（花/六棱柱/石墨烯）比以前少，快没了」）：
   大型几何 MG 只在 type-impact / fragment-collage 两类镜头绘制（sonnetShotMgFull
   的 kind 分支），7 类均选时命中仅 2/7。选择池按 2:1 加权两类大图镜头，
   chooseWithoutRepeat 仍防连续重复。 */
const SONNET_SHOT_KIND_POOL = [
    'editorial-column',
    'type-impact', 'type-impact',
    'fragment-collage', 'fragment-collage',
    'tracking-ribbon',
    'mask-reveal',
    'poster-blocks',
    'quiet-tableau',
];

export const SONNET_TRANSITION_KINDS = ['fast-blur', 'mono-glitch', 'camera-pull'];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const median = (values) => {
    if (values.length === 0) return 0.5;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? ((sorted[middle - 1] ?? sorted[middle]) + sorted[middle]) / 2
        : sorted[middle];
};

/** 行视觉尾端：不越过下一行开始（folia renderHints.getLineRenderEndTime 等价） */
function getLineRenderEndTime(line, nextLine) {
    const wordEnds = Array.isArray(line.words) && line.words.length
        ? Math.max(...line.words.map(w => w.end || w.start || line.start))
        : line.start + 4;
    const stdEnd = Math.max(line.start, wordEnds);
    const nextStart = nextLine ? nextLine.start : Number.POSITIVE_INFINITY;
    return nextStart > stdEnd ? stdEnd : Math.max(stdEnd, nextStart);
}

export const resolveSonnetParagraphGapThreshold = (lines) => {
    const gaps = lines.slice(1).map((line, index) => {
        const prevEnd = getLineRenderEndTime(lines[index], line);
        return line.start - Math.min(prevEnd, line.start);
    }).filter(gap => gap > 0);
    return clamp(median(gaps) * 2.5, 1.25, 3.5);
};

const metadataChanged = (previous, next) => (
    (previous.blockIndex !== undefined && next.blockIndex !== undefined
        && previous.blockIndex !== next.blockIndex)
    || (previous.songPart !== undefined && next.songPart !== undefined
        && previous.songPart !== next.songPart)
);

const splitOversizedDraft = (draft) => {
    const output = [];
    let remaining = draft.lines;
    let boundary = draft.boundary;
    let loopGuard = 0;
    while (remaining.length > 6
        || (remaining.length > 1
            && (remaining[remaining.length - 1].renderEndTime - remaining[0].line.start) > 18)) {
        if (loopGuard++ > 1000) break;
        /* ★ 2026-10-02 拆分时长下限（用户水印取证「49 行挤 21s → 段落碎成 23 段、
           每段 1-2 镜、每 0.86s 硬切 → 构图秒级乱跳」）：拆分点必须让前段时长 ≥6s
           （无最大 gap 候选时按 ≥6s 的最近行界切），杜绝 1-2 行的碎片段落。 */
        const candidates = remaining.slice(2, -1).map((line, offset) => ({
            splitIndex: offset + 2,
            gap: line.line.start - remaining[offset + 1].renderEndTime,
            segDur: remaining[offset + 1].renderEndTime - remaining[0].line.start,
        }));
        const validCandidates = candidates.filter(c => !Number.isNaN(c.gap) && c.segDur >= 6.0);
        const rawSplitIndex = validCandidates.sort((a, b) => b.gap - a.gap)[0]?.splitIndex
            ?? (() => {
                const idx = remaining.findIndex((l, i) => i >= 2
                    && (l.line.start - remaining[0].line.start) >= 6.0);
                return idx > 0 ? idx : Math.min(4, remaining.length - 1);
            })();
        const splitIndex = Math.max(2, rawSplitIndex);
        output.push({ lines: remaining.slice(0, splitIndex), boundary });
        remaining = remaining.slice(splitIndex);
        boundary = output[output.length - 1].lines.length >= 6 ? 'line-cap' : 'duration-cap';
    }
    /* ★ 2026-10-03 防空段落（「verse 有时没有歌词」的一条真实路径）：remaining 为空时
       仍无条件 push 会产出一个 lines 为空、无 shot 的段落——时间轴一旦落在它上面
       （queryParagraphAtTime 按 startTime 命中），激活场景无任何字形 = 空画面。
       空 draft 直接丢弃。 */
    if (remaining.length > 0) output.push({ lines: remaining, boundary });
    return output;
};

const classifyParagraph = (lines, index, total) => {
    if (lines.some(item => item.line.isChorus || /chorus|副歌/i.test(item.line.songPart ?? ''))) return 'chorus';
    if (lines.some(item => /bridge|break|間奏|ブリッジ/i.test(item.line.songPart ?? ''))) return 'break';
    if (index === total - 1) return 'outro';
    const duration = lines[lines.length - 1].renderEndTime - lines[0].line.start;
    const segmentCount = lines.reduce((sum, line) => sum + line.segments.filter(s => s.isWordLike).length, 0);
    const punctuationCount = lines.reduce((sum, line) => sum + ((line.line.original || '').match(/[!?！？…]/g)?.length ?? 0), 0);
    if (duration <= 3.5 || segmentCount <= 3) return 'breath';
    if (punctuationCount >= 2 || segmentCount / Math.max(duration, 1) > 2.5) return 'lift';
    return 'verse';
};

const chooseWithoutRepeat = (choices, seed, previous) => {
    const start = hashSonnetSeed(seed) % choices.length;
    for (let offset = 0; offset < choices.length; offset += 1) {
        const candidate = choices[(start + offset) % choices.length];
        if (candidate !== previous) return candidate;
    }
    return choices[start];
};

const buildCues = (lines) => {
    const segments = lines.flatMap(line => line.segments).filter(segment => segment.text.length > 0);
    return segments.map((segment, index) => ({
        at: segment.startTime,
        duration: Math.max(0.08, segment.endTime - segment.startTime),
        kind: index === segments.length - 1 ? 'accent' : 'enter',
        segmentStart: index,
        segmentEnd: index + 1,
    }));
};

const groupShotLines = (lines) => {
    const groups = [];
    let currentGroup = [];
    let groupStartTime = 0;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (currentGroup.length === 0) {
            currentGroup.push(line);
            groupStartTime = line.line.start;
        } else {
            const durationSoFar = line.renderEndTime - groupStartTime;
            // 组镜 ≤4 行、总跨度 ≤6s，背景 MG 才能复用
            // ★ 2026-10-02 组最短时长下限（用户水印取证「lines=49 挤在 21s → 每 1.6s
            //   硬切一镜 → 构图随机跳/甩出画面」）：行间隔过密时常规上限会造出 <2s 的
            //   碎片镜——每镜机位/缩放随机，碎片镜=画面每秒乱跳。组龄 <2.5s（且 <8 行）
            //   时强制续组，宁可超 6s 上限也不产出碎片镜。
            const groupAge = line.line.start - groupStartTime;
            /* ★ 2026-10-02 上限 8→5（用户实测「有的歌词重叠」）：布局函数按 ≤4 块设计，
               续组到 6-8 行时排布会挤在一起重叠。5 行是上下限的折中（碎片场景仍能
               把 <2.5s 的残组并住，又不会挤爆布局）。 */
            const tooShortToCut = groupAge < 2.5 && currentGroup.length < 5;
            if (!tooShortToCut && (currentGroup.length >= 4 || durationSoFar > 6.0)) {
                groups.push(currentGroup);
                currentGroup = [line];
                groupStartTime = line.line.start;
            } else {
                currentGroup.push(line);
            }
        }
    }
    if (currentGroup.length > 0) groups.push(currentGroup);
    return groups;
};

const buildShots = (lines, kind, paragraphIndex, seed, previousKind) => {
    let lastKind = previousKind;
    /* ★ 2026-10-02 碎片镜合并（组最短时长的段落边界兜底）：段落末尾的残组可能
       只有 1-2 行（<1s）——每镜机位/缩放随机，碎片镜=画面秒级乱跳。时长 <2.5s
       的镜并入前一镜（cue/行索引/时间窗全部带走，机位沿用前一镜）。 */
    const mergeShortShots = (shots) => {
        const merged = [];
        for (const shot of shots) {
            const prev = merged[merged.length - 1];
            /* ★ 2026-10-02 合并后行数上限 6（同组上限收紧，防布局重叠）：超上限的
               短镜宁可保留为独立短镜（会有一次快切），也不挤爆布局。 */
            const mergedLineCount = prev ? prev.lineIndices.length + shot.lineIndices.length : 0;
            if (prev && shot.endTime - shot.startTime < 2.5 && mergedLineCount <= 6) {
                prev.endTime = shot.endTime;
                prev.lineIndices.push(...shot.lineIndices);
                if (Array.isArray(shot.cues)) prev.cues.push(...shot.cues);
            } else {
                merged.push(shot);
            }
        }
        return merged;
    };
    return mergeShortShots(groupShotLines(lines).map((group, shotIndex) => {
        const signature = group.map(item => item.line.original || '').join('|');
        let shotKind = chooseWithoutRepeat(SONNET_SHOT_KIND_POOL, `${seed}:${paragraphIndex}:${shotIndex}:${signature}`, lastKind);
        const wordCount = group.reduce((sum, item) => sum + item.segments.filter(s => s.isWordLike).length, 0);
        // 段落语义微调：breath 首镜安静定格；chorus 绝不定格
        if (kind === 'breath' && shotIndex === 0 && wordCount <= 2) shotKind = 'quiet-tableau';
        if (kind === 'chorus' && shotKind === 'quiet-tableau') shotKind = 'type-impact';
        lastKind = shotKind;
        const random = hashSonnetSeed(`${seed}:${paragraphIndex}:${shotIndex}:camera`);
        const zoomRandom = ((random >>> 16) & 255) / 255;
        // 中近景偏好：构图优先型（poster/tableau）更远，其余更亲
        const zoomBase = shotKind === 'poster-blocks' ? 1.02 : shotKind === 'quiet-tableau' ? 1.12 : 1.22;
        const zoomSpan = shotKind === 'poster-blocks' ? 0.16 : shotKind === 'quiet-tableau' ? 0.2 : 0.26;
        return {
            id: `p${paragraphIndex}-s${shotIndex}`,
            kind: shotKind,
            startTime: group[0].line.start,
            endTime: group[group.length - 1].renderEndTime,
            /* ★ 段内索引（不是全局行号）：_ensureScene 用它索引 paragraph.lines
               （段内数组）——存全局行号在非首段会越界（黑屏根因，09-28 实测） */
            lineIndices: group.map(item => lines.indexOf(item)),
            cues: buildCues(group),
            camera: {
                /* ★ 2026-10-02 恢复 folia 原生随机摆位（用户「运镜不像 folia」）：
                   场景尺寸根因已修，不再需要靠收敛来压偏移——上游原值回归。 */
                x: ((random & 255) / 255 - 0.5) * 0.18,
                y: (((random >>> 8) & 255) / 255 - 0.5) * 0.14,
                zoom: zoomBase + zoomRandom * zoomSpan,
                rotation: (((random >>> 24) & 255) / 255 - 0.5) * 0.08,
            },
        };
    }));
};

/**
 * 时间单位归一（2026-09-29）：Aria 歌词行时间契约是**毫秒**（parseLrc `min*60000+sec*1000+ms`、
 * yrc 毫秒、57 高亮用 currentTimeMs），而 sonnet 链全按 folia 的**秒**制设计。
 * 此前直接编译真实数据：行 start=12340 被当成 12340s，镜头永远 fallback 首镜、
 * glyph 入场时间在几千秒外（visible=false / alpha=0.16 暗淡偏移态）——
 * 实测观感就是「只有图形没有歌词」。启发式：任一行/词 start ≥1000 判毫秒整体 ÷1000
 * （秒制不存在 start≥1000s 的行；毫秒制歌头 1s 内首行的极端案例可忽略）。
 */
const normalizeTimeUnit = (lines) => {
    if (!Array.isArray(lines)) return lines;
    let maxStart = 0;
    for (const line of lines) {
        if (typeof line?.start === 'number') maxStart = Math.max(maxStart, line.start);
        if (Array.isArray(line?.words)) {
            for (const word of line.words) {
                if (typeof word?.start === 'number') maxStart = Math.max(maxStart, word.start);
            }
        }
    }
    if (maxStart < 1000) return lines;
    const k = 0.001;
    return lines.map(line => ({
        ...line,
        start: (line.start || 0) * k,
        ...(line.end !== undefined ? { end: line.end * k } : {}),
        words: Array.isArray(line.words)
            ? line.words.map(w => ({
                ...w,
                start: (w.start || 0) * k,
                ...(w.end !== undefined ? { end: w.end * k } : {}),
            }))
            : line.words,
    }));
};

/**
 * 编译 sonnet 节目。Aria 行：{start, original, words:[{text,start,end}], isChorus?}
 * @param {Array<Object>} lines 时间单位毫秒或秒（自动归一到秒）
 * @param {string|number} seed
 */
export const compileSonnetProgram = (rawLines, seed = 'sonnet') => {
    const lines = normalizeTimeUnit(rawLines);
    const compiled = lines.map((line, sourceIndex) => {
        const nextLine = lines[sourceIndex + 1] || null;
        return {
            sourceIndex,
            line,
            renderEndTime: Math.max(
                line.start,
                Math.min(getLineRenderEndTime(line, nextLine), nextLine ? nextLine.start : Number.POSITIVE_INFINITY),
            ),
            segments: buildSonnetSemanticSegments(line),
        };
    });
    const paragraphGapThreshold = resolveSonnetParagraphGapThreshold(lines);
    const drafts = [];
    let current = { lines: [], boundary: 'song-start' };

    compiled.forEach((line, index) => {
        const previous = compiled[index - 1];
        const gap = previous ? line.line.start - previous.renderEndTime : 0;
        const boundary = previous && metadataChanged(previous.line, line.line)
            ? 'metadata'
            : previous && gap >= paragraphGapThreshold
                ? 'time-gap'
                : null;
        if (boundary && current.lines.length > 0) {
            drafts.push(...splitOversizedDraft(current));
            current = { lines: [], boundary };
        }
        current.lines.push(line);
    });
    if (current.lines.length > 0) drafts.push(...splitOversizedDraft(current));

    const resolvedSeed = String(seed);
    let previousShot = null;
    let previousTransition = null;
    const paragraphs = drafts.map((draft, index) => {
        const kind = classifyParagraph(draft.lines, index, drafts.length);
        const shots = buildShots(draft.lines, kind, index, resolvedSeed, previousShot);
        previousShot = shots.length ? shots[shots.length - 1].kind : previousShot;
        const next = drafts[index + 1];
        const endTime = draft.lines[draft.lines.length - 1].renderEndTime;
        const gap = next ? next.lines[0].line.start - endTime : 0;
        const transitionKind = next
            ? chooseWithoutRepeat([...SONNET_TRANSITION_KINDS], `${resolvedSeed}:${index}:transition`, previousTransition)
            : null;
        if (transitionKind) previousTransition = transitionKind;
        const transitionDuration = next ? Math.min(0.3, Math.max(0.16, gap > 0 ? gap * 0.5 : 0.2)) : 0;
        const transitionEndTime = next ? next.lines[0].line.start : endTime;
        return {
            id: `sonnet-p${index}`,
            kind,
            boundary: draft.boundary,
            startTime: draft.lines[0].line.start,
            endTime,
            lines: draft.lines,
            shots,
            transitionOut: transitionKind ? {
                kind: transitionKind,
                startTime: Math.max(draft.lines[0].line.start, transitionEndTime - transitionDuration),
                endTime: transitionEndTime,
            } : null,
        };
    });

    return { version: 1, seed: resolvedSeed, paragraphGapThreshold, paragraphs };
};

export const findSonnetParagraphIndexAtTime = (program, time) => {
    for (let index = program.paragraphs.length - 1; index >= 0; index -= 1) {
        if (time >= program.paragraphs[index].startTime) return index;
    }
    return 0;
};
