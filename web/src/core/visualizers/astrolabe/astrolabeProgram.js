/**
 * web/src/core/visualizers/astrolabe/astrolabeProgram.js
 * 「画册 · Folio」（mode: astrolabe）—— 54 镜多拓扑歌词时间轴编译器（含 22 镜防重复滑动窗 + 连续流向链）
 */

import {
    ASTROLABE_FAMILIES,
    ASTROLABE_SHOT_KINDS,
    ASTROLABE_TYPO_TOPOLOGIES,
    ASTROLABE_FOCAL_ZONES,
    ASTROLABE_DECOR_MOTIFS,
    ASTROLABE_ENTER_STYLES,
    ASTROLABE_TRANSITIONS,
} from './astrolabeProfiles.js';
import { hashAstrolabeSeed, astrolabeHash01 } from './astrolabeCompositions.js';

export {
    ASTROLABE_FAMILIES,
    ASTROLABE_SHOT_KINDS,
    ASTROLABE_TYPO_TOPOLOGIES,
    ASTROLABE_FOCAL_ZONES,
    ASTROLABE_DECOR_MOTIFS,
    ASTROLABE_ENTER_STYLES,
    ASTROLABE_TRANSITIONS,
};

const INTERLUDE_GAP_MS = 4500;

function isInterludeText(text = '') {
    const t = String(text || '').trim();
    if (!t) return true;
    return /^(?:[♪♫♬♩…·•\-—~～\s]+|music|instrumental|interlude|间奏|纯音乐|伴奏)$/i.test(t);
}

/**
 * 将单行歌词归一化为逐字/逐词时间片数组
 */
export function normalizeLineGraphemes(line, nextLineTimeSec = 0) {
    const rawTime = Number(line?.time ?? line?.start ?? 0) || 0;
    const lineStartMs = Math.max(0, Math.round(rawTime > 1000 ? rawTime : rawTime * 1000));
    const rawNext = Number(nextLineTimeSec) || 0;
    const nextMs = rawNext > 1000 ? rawNext : rawNext * 1000;
    const rawEndMs = nextMs > lineStartMs ? Math.round(nextMs) : lineStartMs + 3600;
    const lineEndMs = Math.max(lineStartMs + 400, rawEndMs);
    const text = String(line?.original ?? line?.text ?? '').trim();

    if (Array.isArray(line?.words) && line.words.length > 0) {
        const out = [];
        for (let i = 0; i < line.words.length; i++) {
            const w = line.words[i];
            const wText = String(w?.word ?? w?.text ?? '');
            if (!wText) continue;
            const rawWStart = typeof w.start === 'number' ? w.start : (typeof w.startTime === 'number' ? w.startTime : lineStartMs / 1000);
            const start = Math.round(rawWStart < 600 && lineStartMs > 1000 ? rawWStart * 1000 : (rawWStart < 600 ? rawWStart * 1000 : rawWStart));
            const rawWEnd = typeof w.end === 'number' ? w.end : (typeof w.endTime === 'number' ? w.endTime : 0);
            const dur = Math.round(
                typeof w.duration === 'number'
                    ? (w.duration < 30 ? w.duration * 1000 : w.duration)
                    : 260,
            );
            const end = Math.max(
                start + 80,
                rawWEnd > 0 ? Math.round(rawWEnd < 600 ? rawWEnd * 1000 : rawWEnd) : start + dur,
            );
            const chars = Array.from(wText);
            const cSpan = (end - start) / Math.max(1, chars.length);
            for (let c = 0; c < chars.length; c++) {
                out.push({
                    char: chars[c],
                    start: Math.round(start + c * cSpan),
                    end: Math.round(start + (c + 1) * cSpan),
                    wordIndex: i,
                });
            }
        }
        if (out.length > 0) return out;
    }

    const chars = Array.from(text || '·');
    const span = Math.max(240, lineEndMs - lineStartMs);
    const step = span / Math.max(1, chars.length);
    return chars.map((ch, idx) => ({
        char: ch,
        start: Math.round(lineStartMs + idx * step),
        end: Math.round(lineStartMs + (idx + 1) * step),
        wordIndex: idx,
    }));
}

/**
 * 按分镜切分频率（line / phrase / fast）把一行拆为 1..3 个紧凑短句分镜
 */
export function chunkAstrolabeGraphemes(graphemes, cutRate = 'phrase') {
    if (!Array.isArray(graphemes) || graphemes.length === 0) return [];
    if (cutRate === 'line') return [graphemes];

    const nonSpace = graphemes.filter(g => g.char.trim().length > 0).length;
    const minTrigger = cutRate === 'fast' ? 6 : 10;
    if (nonSpace < minTrigger) return [graphemes];

    const targetChunks = cutRate === 'fast'
        ? (nonSpace >= 14 ? 3 : 2)
        : (nonSpace >= 18 ? 3 : 2);

    // 识别拉丁/数字等连续词字符（排除 CJK 汉字与日韩假名），避免切分把英文单词腰斩成两个无法命中的碎片
    const isLatinWordChar = (ch) => typeof ch === 'string'
        && /^(?!.*[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af])[\p{L}\p{N}'\u2019]$/u.test(ch);
    const cutsLatinWordAt = (idx) => idx > 0
        && idx < graphemes.length
        && isLatinWordChar(graphemes[idx - 1].char)
        && isLatinWordChar(graphemes[idx].char);

    const chunks = [];
    let startIdx = 0;
    for (let c = 1; c < targetChunks; c++) {
        const ideal = Math.round((graphemes.length * c) / targetChunks);
        let splitAt = ideal;
        let snapped = false;
        for (let d = 0; d <= 8; d++) {
            const r = ideal + d;
            const l = ideal - d;
            if (
                r < graphemes.length - 2
                && /[\s,，。！!？?、；;：:\-/]/.test(graphemes[r].char)
                && !cutsLatinWordAt(r + 1)
            ) {
                splitAt = r + 1;
                snapped = true;
                break;
            }
            if (
                l > startIdx + 2
                && /[\s,，。！!？?、；;：:\-/]/.test(graphemes[l].char)
                && !cutsLatinWordAt(l + 1)
            ) {
                splitAt = l + 1;
                snapped = true;
                break;
            }
        }
        // 未找到标点/空格断句时，若 ideal 落在英文单词内部，向两侧吸附到最近的非单词内部边界
        if (!snapped && cutsLatinWordAt(splitAt)) {
            for (let d = 1; d <= 14; d++) {
                const r = ideal + d;
                const l = ideal - d;
                if (l > startIdx + 1 && !cutsLatinWordAt(l)) {
                    splitAt = l;
                    break;
                }
                if (r < graphemes.length - 1 && !cutsLatinWordAt(r)) {
                    splitAt = r;
                    break;
                }
            }
        }
        if (splitAt > startIdx + 1 && splitAt < graphemes.length - 1) {
            chunks.push(graphemes.slice(startIdx, splitAt));
            startIdx = splitAt;
        }
    }
    if (startIdx < graphemes.length) {
        chunks.push(graphemes.slice(startIdx));
    }
    return chunks.length > 0 ? chunks : [graphemes];
}

function resolveFlowAngleDeg(seed, shotIndex, prevDeg) {
    const candidateAngles = [-26, -18, -11, 11, 18, 26, -32, 32];
    const base = candidateAngles[Math.floor(astrolabeHash01(seed, shotIndex, 71) * candidateAngles.length) % candidateAngles.length];
    if (typeof prevDeg !== 'number') return base;
    if (Math.abs(base - prevDeg) > 42) {
        return prevDeg > 0 ? Math.abs(base) : -Math.abs(base);
    }
    return base;
}

/**
 * 归一化整行歌词并做全曲重复度/相邻词干相似度分析，在编译期精准识别副歌（Chorus）与章节号（sectionIndex）
 * 1. 精确归一化重复 ≥2 次的行（或与其它行 Bigram 相似度 ≥0.65）记为重复句；
 * 2. 相邻或隔 1 行连续命中重复句时扩张为完整副歌段；
 * 3. 若测试数据或自由诗全曲无重复句，则仅在歌曲黄金分割峰值窗（42%~58% 与 78%~88%）点亮副歌，占比严格控制在 15%~30%，绝不泛滥。
 */
export function detectChorusLineFlags(lines = []) {
    const n = lines.length;
    const flags = new Array(n).fill(false);
    const sections = new Array(n).fill(0);
    if (n === 0) return { flags, sections };

    const normTexts = lines.map(l => {
        const raw = String(l?.original ?? l?.text ?? '').trim();
        if (isInterludeText(raw)) return '';
        return raw.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    });

    const freq = new Map();
    for (let i = 0; i < n; i++) {
        const s = normTexts[i];
        if (s.length >= 3) {
            freq.set(s, (freq.get(s) || 0) + 1);
        }
    }

    const bigramsOf = (str) => {
        const set = new Set();
        for (let i = 0; i < str.length - 1; i++) {
            set.add(str.slice(i, i + 2));
        }
        return set;
    };
    const bgSets = normTexts.map(s => (s.length >= 4 ? bigramsOf(s) : null));

    let repeatedCount = 0;
    for (let i = 0; i < n; i++) {
        const s = normTexts[i];
        if (!s) continue;
        if ((freq.get(s) || 0) >= 2) {
            flags[i] = true;
            repeatedCount++;
            continue;
        }
        const bA = bgSets[i];
        if (!bA || bA.size === 0) continue;
        for (let j = 0; j < n; j++) {
            if (Math.abs(i - j) <= 2 || !bgSets[j]) continue;
            const bB = bgSets[j];
            let inter = 0;
            for (const g of bA) {
                if (bB.has(g)) inter++;
            }
            const dice = (2 * inter) / (bA.size + bB.size);
            if (dice >= 0.65) {
                flags[i] = true;
                repeatedCount++;
                break;
            }
        }
    }

    // 填补副歌段内部孤立的 1 行断档（如副歌 4 句里第 3 句词不同，但第 1/2/4 句重复）
    // 同时防止循环吟唱或模板化测试歌词导致副歌泛滥（若命中率 > 55%，则回退到黄金分割高潮窗）
    if (repeatedCount > 0 && repeatedCount <= Math.floor(n * 0.55)) {
        const smoothed = flags.slice();
        for (let i = 1; i < n - 1; i++) {
            if (!smoothed[i] && normTexts[i] && flags[i - 1] && flags[i + 1]) {
                smoothed[i] = true;
            }
        }
        for (let i = 0; i < n; i++) flags[i] = smoothed[i];
    } else {
        // 无重复句或全曲模板句占比过高时：仅在全曲黄金分割高潮窗（38%~54% 与 76%~88%）标记副歌，总占比约 ~25%
        for (let i = 0; i < n; i++) {
            flags[i] = false;
            if (!normTexts[i]) continue;
            const pos = i / Math.max(1, n - 1);
            if ((pos >= 0.38 && pos <= 0.54) || (pos >= 0.76 && pos <= 0.88)) {
                flags[i] = true;
            }
        }
    }

    // 根据间奏、时间跨度或副歌进出边界划分音乐章节 sectionIndex（供画册翻页极性呼吸联动）
    let curSec = 0;
    for (let i = 0; i < n; i++) {
        if (i > 0) {
            const tCur = Number(lines[i]?.time ?? lines[i]?.start ?? 0) || 0;
            const tPrev = Number(lines[i - 1]?.time ?? lines[i - 1]?.start ?? 0) || 0;
            const gapSec = (tCur > 1000 ? tCur / 1000 : tCur) - (tPrev > 1000 ? tPrev / 1000 : tPrev);
            if (flags[i] !== flags[i - 1] || !normTexts[i] || gapSec >= 6.5 || (i % 4 === 0 && !flags[i])) {
                curSec++;
            }
        }
        sections[i] = curSec;
    }

    return { flags, sections, isChorusByLine: flags };
}

/**
 * 编译整首歌的 54 镜天体平面构成时间轴
 * @param {Array<object>} lines
 * @param {object} [opts]
 */
export function compileAstrolabeProgram(lines = [], opts = {}) {
    const cutRate = opts.cutRate || 'phrase';
    const seedStr = String(opts.seed || (lines[0]?.original ?? lines[0]?.text ?? 'aria-astrolabe'));
    const masterSeed = hashAstrolabeSeed(`${seedStr}:${lines.length}:${cutRate}`);
    const { flags: chorusFlags, sections: lineSections } = detectChorusLineFlags(lines);

    const rawSegments = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const curSec = Number(line?.time ?? line?.start ?? 0) || 0;
        const nextSec = i + 1 < lines.length
            ? (Number(lines[i + 1]?.time ?? lines[i + 1]?.start ?? 0) || 0)
            : curSec + 4.2;
        const startMs = Math.max(0, Math.round(curSec > 1000 ? curSec : curSec * 1000));
        const endMs = Math.max(startMs + 420, Math.round(nextSec > 1000 ? nextSec : nextSec * 1000));
        const text = String(line?.original ?? line?.text ?? '').trim();

        if (i === 0 && startMs >= INTERLUDE_GAP_MS) {
            rawSegments.push({
                isInterlude: true,
                isChorusLine: false,
                sectionIndex: 0,
                lineIndex: -1,
                text: '◇',
                translation: '',
                romaji: '',
                startTimeMs: 0,
                endTimeMs: startMs,
                graphemes: [{ char: '◇', start: 0, end: startMs, wordIndex: 0 }],
            });
        }

        if (isInterludeText(text)) {
            rawSegments.push({
                isInterlude: true,
                isChorusLine: false,
                sectionIndex: lineSections[i] || 0,
                lineIndex: i,
                text: '◇',
                translation: '',
                romaji: '',
                startTimeMs: startMs,
                endTimeMs: endMs,
                graphemes: [{ char: '◇', start: startMs, end: endMs, wordIndex: 0 }],
            });
            continue;
        }

        const allGraphemes = normalizeLineGraphemes(line, nextSec);
        const chunks = chunkAstrolabeGraphemes(allGraphemes, cutRate);
        for (let c = 0; c < chunks.length; c++) {
            const grp = chunks[c];
            const cStart = c === 0 ? startMs : grp[0].start;
            const cEnd = c === chunks.length - 1 ? endMs : chunks[c + 1][0].start;
            const cText = grp.map(g => g.char).join('').trim() || text;
            rawSegments.push({
                isInterlude: false,
                isChorusLine: Boolean(chorusFlags[i]),
                sectionIndex: lineSections[i] || 0,
                lineIndex: i,
                chunkIndex: c,
                chunkCount: chunks.length,
                text: cText,
                fullLineText: text,
                translation: String(line?.translation || line?.trans || '').trim(),
                romaji: String(line?.romaji || line?.roma || '').trim(),
                startTimeMs: cStart,
                endTimeMs: Math.max(cStart + 260, cEnd),
                graphemes: grp,
            });
        }
    }

    // 22 镜防重复滑动窗口（比 Prism 的 18 镜更长，确保 54 种构图充分轮转）
    const recentKinds = [];
    const recentFamilies = [];
    let prevZoneId = '';
    let prevTopology = '';
    let prevMotif = '';
    let prevFlowDeg = undefined;

    const shots = [];
    for (let idx = 0; idx < rawSegments.length; idx++) {
        const seg = rawSegments[idx];
        const duration = Math.max(260, seg.endTimeMs - seg.startTimeMs);
        const isChorus = !seg.isInterlude && Boolean(seg.isChorusLine);
        const prevWasChorus = idx > 0 ? Boolean(shots[idx - 1]?.isChorus) : false;
        const isChorusEntry = isChorus && !prevWasChorus;

        // 1. 挑选分镜家族（相邻不重复；副歌倾向非圆与圆兼备的高张力家族，杜绝圆占满全曲）
        let familyPool = ASTROLABE_FAMILIES.filter(f => f !== recentFamilies[recentFamilies.length - 1]);
        if (isChorus && (isChorusEntry || astrolabeHash01(masterSeed, idx, 9) < 0.42)) {
            const chorusPreferred = familyPool.filter(
                f => f === 'zenith' || f === 'solstice' || f === 'meridian' || f === 'constellation' || f === 'eclipse'
            );
            if (chorusPreferred.length > 0) {
                familyPool = chorusPreferred;
            }
        }
        const family = familyPool[
            (idx * 4 + Math.floor(astrolabeHash01(masterSeed, idx, 13) * familyPool.length)) % familyPool.length
        ];
        recentFamilies.push(family);
        if (recentFamilies.length > 4) recentFamilies.shift();

        // 2. 在该家族 6 镜及全 54 镜池中排除最近 22 镜已出现的 shotKind
        const famIdx = ASTROLABE_FAMILIES.indexOf(family);
        const famKinds = ASTROLABE_SHOT_KINDS.slice(famIdx * 6, famIdx * 6 + 6);
        let kindCandidates = famKinds.filter(k => !recentKinds.includes(k));
        if (kindCandidates.length === 0) {
            kindCandidates = ASTROLABE_SHOT_KINDS.filter(k => !recentKinds.includes(k));
        }
        if (kindCandidates.length === 0) {
            kindCandidates = famKinds;
        }
        const shotKind = kindCandidates[
            (idx * 3 + Math.floor(astrolabeHash01(masterSeed, idx, 19) * kindCandidates.length)) % kindCandidates.length
        ];
        recentKinds.push(shotKind);
        if (recentKinds.length > 22) recentKinds.shift();

        // 3. 挑选 12 宫非对称焦点锚区（严格相邻不重）
        const zonePool = ASTROLABE_FOCAL_ZONES.filter(z => z.id !== prevZoneId);
        const region = zonePool[(idx * 5 + Math.floor(astrolabeHash01(masterSeed, idx, 29) * zonePool.length)) % zonePool.length];
        prevZoneId = region.id;

        // 4. 挑选 8 种瑞士海报排版拓扑（严格相邻不重）
        const topoPool = ASTROLABE_TYPO_TOPOLOGIES.filter(t => t !== prevTopology);
        const topology = topoPool[(idx * 3 + Math.floor(astrolabeHash01(masterSeed, idx, 37) * topoPool.length)) % topoPool.length];
        prevTopology = topology;

        // 5. 挑选 10 种版画与构成主义装饰母题（严格相邻不重）
        const motifPool = ASTROLABE_DECOR_MOTIFS.filter(m => m !== prevMotif);
        const decorMotif = motifPool[(idx * 7 + Math.floor(astrolabeHash01(masterSeed, idx, 43) * motifPool.length)) % motifPool.length];
        prevMotif = decorMotif;

        // 6. 连续流向角与入场/转场参数（chorus-imprint 仅在副歌段首或副歌高潮点触发，绝不泛滥）
        const flowAngleDeg = resolveFlowAngleDeg(masterSeed, idx, prevFlowDeg);
        prevFlowDeg = flowAngleDeg;
        const flowAngleRad = (flowAngleDeg * Math.PI) / 180;
        const enterStyle = ASTROLABE_ENTER_STYLES[(idx + Math.floor(astrolabeHash01(masterSeed, idx, 53) * 5)) % ASTROLABE_ENTER_STYLES.length];
        const transition = isChorusEntry
            ? 'chorus-imprint'
            : ASTROLABE_TRANSITIONS[(idx + Math.floor(astrolabeHash01(masterSeed, idx, 61) * 4)) % 4];

        // 7. 抽取相邻分镜的实词作为版画底纹大字（Editorial Watermark）
        const neighborSeg = rawSegments[idx + 1] || rawSegments[idx - 1] || seg;
        const wmRaw = String(neighborSeg.text || '').replace(/[^\p{L}\p{N}]/gu, '');
        const watermarkText = wmRaw.slice(0, 4) || '◇';

        // 8. 疏密呼吸层级（densityTier: 'sparse' | 'balanced' | 'dense'）与网格对字锚定模式（gridLockMode）
        //    - 杜绝 54 张同密度海报连播：极简留白镜（sparse，1块面+1基准线+无水印）与满版高潮镜（dense）交替呼吸
        const prevDensity = idx > 0 ? shots[idx - 1]?.densityTier : '';
        const prev2Density = idx > 1 ? shots[idx - 2]?.densityTier : '';
        const hDensity = astrolabeHash01(masterSeed, idx, 71);
        let densityTier = 'balanced';
        if (seg.isInterlude || (!isChorus && prevWasChorus) || (!isChorus && prevDensity !== 'sparse' && (idx % 3 === 1 || hDensity < 0.32))) {
            densityTier = 'sparse';
        } else if (isChorusEntry || (isChorus && !(prevDensity === 'dense' && prev2Density === 'dense')) || (!isChorus && prevDensity === 'sparse' && hDensity > 0.64)) {
            densityTier = 'dense';
        }
        const gridLockModes = ['word-split', 'baseline-lock', 'stem-lock'];
        const gridLockMode = gridLockModes[(idx * 2 + Math.floor(astrolabeHash01(masterSeed, idx, 79) * 3)) % 3];

        const handoffMs = Math.min(540, Math.max(260, Math.round(duration * 0.32)));

        shots.push({
            index: idx,
            seed: (masterSeed ^ Math.imul(idx + 1, 2654435761)) >>> 0,
            shotKind,
            family,
            topology,
            region,
            decorMotif,
            enterStyle,
            transition,
            densityTier,
            gridLockMode,
            isInterlude: seg.isInterlude,
            isChorus,
            isChorusEntry,
            sectionIndex: seg.sectionIndex || 0,
            lineIndex: seg.lineIndex,
            text: seg.text,
            watermarkText,
            translation: seg.translation,
            romaji: seg.romaji,
            startTimeMs: seg.startTimeMs,
            endTimeMs: seg.endTimeMs,
            handoffMs,
            flowAngleDeg,
            flowAngleRad,
            cameraZoomStart: isChorusEntry ? 1.055 : (isChorus ? 1.032 : 1.016),
            cameraZoomEnd: 1.0,
            cameraDriftX: Math.cos(flowAngleRad) * 0.032,
            cameraDriftY: Math.sin(flowAngleRad) * 0.028,
            cameraRollStartDeg: (idx % 2 === 0 ? -0.9 : 0.9),
            cameraRollEndDeg: (idx % 2 === 0 ? 0.45 : -0.45),
            graphemes: seg.graphemes,
        });
    }

    // 为同属一条歌词行的连续分镜挂上整行 graphemes 引用与切片偏移，避免跨块拆词丢失情感词配色
    for (let i = 0; i < shots.length; ) {
        const first = shots[i];
        if (
            !first
            || first.isInterlude
            || !Number.isInteger(first.lineIndex)
            || first.lineIndex < 0
            || !Array.isArray(first.graphemes)
            || first.graphemes.length === 0
        ) {
            i++;
            continue;
        }
        let j = i + 1;
        while (
            j < shots.length
            && shots[j]
            && !shots[j].isInterlude
            && shots[j].lineIndex === first.lineIndex
            && Array.isArray(shots[j].graphemes)
            && shots[j].graphemes.length > 0
        ) {
            j++;
        }
        const lineGraphemes = [];
        for (let k = i; k < j; k++) {
            shots[k].lineGraphemeOffset = lineGraphemes.length;
            shots[k].lineGraphemes = lineGraphemes;
            for (const g of shots[k].graphemes) {
                lineGraphemes.push(g);
            }
        }
        i = j;
    }

    const totalDurationMs = shots.length > 0 ? shots[shots.length - 1].endTimeMs : 0;
    return {
        seed: masterSeed,
        cutRate,
        totalDurationMs,
        shots,
    };
}

/**
 * 二分查找当前时刻激活的分镜与交棒过渡进度
 * @param {object} program
 * @param {number} timeMs
 */
export function findActiveAstrolabeShot(program, timeMs = 0) {
    const shots = program?.shots;
    if (!Array.isArray(shots) || shots.length === 0) {
        return { active: null, prev: null, activeProgress: 0, transitionProgress: 1 };
    }
    const t = Math.max(0, Number(timeMs) || 0);
    let lo = 0;
    let hi = shots.length - 1;
    let found = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const s = shots[mid];
        if (t < s.startTimeMs) {
            hi = mid - 1;
        } else if (t >= s.endTimeMs && mid < shots.length - 1) {
            lo = mid + 1;
        } else {
            found = mid;
            break;
        }
    }
    if (lo >= shots.length) found = shots.length - 1;
    const active = shots[found];
    const dur = Math.max(1, active.endTimeMs - active.startTimeMs);
    const elapsed = Math.max(0, t - active.startTimeMs);
    const activeProgress = Math.max(0, Math.min(1, elapsed / dur));
    const prev = found > 0 ? shots[found - 1] : null;
    const handoffMs = active.handoffMs || 420;
    const transitionProgress = prev ? Math.max(0, Math.min(1, elapsed / handoffMs)) : 1;

    return {
        active,
        prev,
        activeProgress,
        transitionProgress,
    };
}
