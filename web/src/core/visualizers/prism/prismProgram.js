/* ============================================================
 * prismProgram.js — 「棱镜 · Prism」分镜编译与 36 种参数化切面几何引擎
 *
 * 纯逻辑模块（零 DOM 依赖，Node 单测可直接运行）：
 *   1. compilePrismProgram()：将歌词行切分为多镜头时间轴（Shot）
 *   2. buildPrismFacetGeometry()：按镜头类型（36 种）与视口宽高比生成多边形切面
 *   3. findActivePrismShot()：二分查找当前播放时刻的主镜头与转场重叠状态
 * ============================================================ */

import {
    PRISM_ENTER_STYLES,
    PRISM_LAYOUT_KINDS,
    PRISM_SHOT_FAMILIES,
    PRISM_SHOT_KINDS,
    PRISM_TRANSITION_KINDS,
} from './prismTypes.js';
import {
    hashPrismSeed,
    mixPrismSeed,
    pickPrismCandidate,
    prismHash01,
    prismRange,
} from './prismRandom.js';
import { buildGraphemes, clamp01, graphemeWeight, normalizeLine } from '../lyricRows.js';

const CJK_RE = /[\u2e80-\u9fff\uac00-\ud7af\u3040-\u30ff\uf900-\ufaff]/;
const BREAK_RE = /[\s，。！？、；：,.!?;:—…·"'“”‘’）)\]】》〉]/;
const LATIN_RE = /[A-Za-z0-9]/;

/**
 * 反向查找 shotKind 所属的家族名称
 * @param {string} kind
 * @returns {string}
 */
export function familyOfShotKind(kind) {
    for (const [family, list] of Object.entries(PRISM_SHOT_FAMILIES)) {
        if (list.includes(kind)) return family;
    }
    return 'split';
}

/**
 * 判断一行是否为间奏/无实词标记
 * @param {string} text
 * @returns {boolean}
 */
export function isInterludeText(text) {
    const t = String(text || '').trim();
    if (!t) return true;
    return /^(?:[♪♫♬♩\s….\-~—/\\]+|music|instrumental|interlude|间奏|纯音乐)$/i.test(t);
}

/**
 * 根据分镜速率（cutRate）把单行字素切分成 1~3 个分镜片段
 * @param {Array<{char:string,start:number,end:number}>} graphemes
 * @param {'phrase'|'line'|'fast'} cutRate
 * @returns {Array<{startIdx:number,endIdx:number}>}
 */
export function chunkLineGraphemes(graphemes, cutRate = 'phrase') {
    const n = Array.isArray(graphemes) ? graphemes.length : 0;
    if (n === 0) return [];
    if (cutRate === 'line' || n <= 5) {
        return [{ startIdx: 0, endIdx: n }];
    }

    const weights = graphemes.map(g => graphemeWeight(g.char));
    const prefix = new Array(n + 1).fill(0);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + weights[i];
    const totalW = prefix[n];
    const spanMs = Math.max(0, (graphemes[n - 1]?.end || 0) - (graphemes[0]?.start || 0));

    let chunks = 1;
    if (cutRate === 'fast') {
        if (totalW >= 18 && spanMs >= 3200) chunks = 3;
        else if (totalW >= 9 && spanMs >= 1600) chunks = 2;
    } else {
        if (totalW >= 24 && spanMs >= 4600) chunks = 3;
        else if (totalW >= 12 && spanMs >= 2400) chunks = 2;
    }

    if (chunks <= 1) return [{ startIdx: 0, endIdx: n }];

    const out = [];
    let from = 0;
    for (let c = 1; c < chunks; c++) {
        const target = (totalW * c) / chunks;
        const last = n - (chunks - c) * 2;
        if (last <= from + 1) break;
        let best = from + 2;
        let bestScore = Infinity;
        for (let k = from + 2; k <= last; k++) {
            let score = Math.abs(prefix[k] - target);
            const prevChar = graphemes[k - 1]?.char || '';
            const currChar = graphemes[k]?.char || '';
            if (LATIN_RE.test(prevChar) && LATIN_RE.test(currChar)) {
                score += 1000;
            } else if (BREAK_RE.test(prevChar) || BREAK_RE.test(currChar)) {
                score -= 1.2;
            }
            if (score < bestScore) {
                bestScore = score;
                best = k;
            }
        }
        out.push({ startIdx: from, endIdx: best });
        from = best;
    }
    out.push({ startIdx: from, endIdx: n });
    return out;
}

/**
 * 确定性洗牌：创建 36 种镜头的轮换池
 * @param {number} seed
 * @returns {string[]}
 */
function buildShuffledDeck(seed) {
    const deck = PRISM_SHOT_KINDS.slice();
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(prismHash01(seed, i, 313) * (i + 1)) % (i + 1);
        const tmp = deck[i];
        deck[i] = deck[j];
        deck[j] = tmp;
    }
    return deck;
}

/**
 * 选择适合当前字数与语种的排版流向
 * @param {string} text
 * @param {number} glyphCount
 * @param {number} shotSeed
 * @param {number} shotIndex
 * @param {string|null} prevLayout
 * @returns {string}
 */
function selectLayoutKind(text, glyphCount, shotSeed, shotIndex, prevLayout) {
    const hasCjk = CJK_RE.test(text);
    /** @type {string[]} */
    const pool = [];
    if (glyphCount <= 6) {
        pool.push('monumental-poster', 'diagonal-climb', 'arc-orbit');
        if (hasCjk) pool.push('vertical-triptych');
    } else if (glyphCount <= 14) {
        pool.push(
            'horizontal-cascade',
            'diagonal-climb',
            'stepped-columns',
            'split-antiphony',
            'arc-orbit',
            'scattered-constellation',
            'monumental-poster',
        );
        if (hasCjk) pool.push('vertical-triptych');
    } else {
        pool.push(
            'horizontal-cascade',
            'diagonal-climb',
            'stepped-columns',
            'split-antiphony',
            'scattered-constellation',
        );
    }
    return pickPrismCandidate(pool, shotSeed, shotIndex, prevLayout) || PRISM_LAYOUT_KINDS[0];
}

/**
 * 基于音乐与歌词结构的副歌行识别（彻底摒弃行号取模）：
 *   1. 优先采信 line.isChorus / line.section === 'chorus'
 *   2. 统计全曲重复出现的 Hook 句（归一化后出现 ≥2 次），并对连续复沓段落做 ±1 邻行聚类
 *   3. 若全曲无重复句（通谱歌/短片段），按单位时间字素密度（字重/时长）定位中高潮区能量最高的连续段落
 * @param {any[]} safeLines
 * @returns {Set<number>}
 */
function detectChorusLineSet(safeLines) {
    const chorusSet = new Set();
    const n = safeLines.length;
    if (n === 0) return chorusSet;

    for (let i = 0; i < n; i++) {
        const l = safeLines[i];
        if (l && (l.isChorus || l.section === 'chorus')) chorusSet.add(i);
    }
    if (chorusSet.size > 0) return chorusSet;

    /** @type {Map<string, number[]>} */
    const keyToIndices = new Map();
    const norms = new Array(n);
    for (let i = 0; i < n; i++) {
        const l = safeLines[i];
        if (!l) continue;
        const norm = normalizeLine(l, safeLines[i + 1]);
        norms[i] = norm;
        const clean = norm.text.replace(BREAK_RE, '').toLowerCase();
        if (clean.length < 3 || isInterludeText(norm.text)) continue;
        let list = keyToIndices.get(clean);
        if (!list) {
            list = [];
            keyToIndices.set(clean, list);
        }
        list.push(i);
    }

    for (const indices of keyToIndices.values()) {
        if (indices.length >= 2) {
            for (const idx of indices) {
                chorusSet.add(idx);
                if (idx + 1 < n && norms[idx + 1] && !isInterludeText(norms[idx + 1].text)) {
                    chorusSet.add(idx + 1);
                }
            }
        }
    }
    if (chorusSet.size > 0) return chorusSet;

    // 兜底：无复沓词句时，计算 30%~82% 区间内字素演唱密度最高的连续段落（3~4 行）
    if (n >= 6) {
        const lo = Math.max(1, Math.floor(n * 0.30));
        const hi = Math.min(n - 1, Math.ceil(n * 0.82));
        const winSize = Math.min(4, Math.max(2, hi - lo));
        const densities = new Array(n).fill(0);
        for (let i = 0; i < n; i++) {
            const norm = norms[i];
            if (!norm || !norm.text || isInterludeText(norm.text)) continue;
            const durSec = Math.max(0.8, (norm.end - norm.start) / 1000);
            let w = 0;
            for (const ch of norm.text) w += graphemeWeight(ch);
            densities[i] = w / durSec;
        }
        let bestStart = lo;
        let bestSum = -1;
        for (let s = lo; s <= Math.max(lo, hi - winSize + 1); s++) {
            let sum = 0;
            for (let k = 0; k < winSize && s + k < n; k++) sum += densities[s + k];
            if (sum > bestSum) {
                bestSum = sum;
                bestStart = s;
            }
        }
        for (let k = 0; k < winSize && bestStart + k < n; k++) {
            chorusSet.add(bestStart + k);
        }
    }
    return chorusSet;
}

/**
 * 将歌词数组编译为确定性的棱镜分镜序列（Shots）
 * @param {any[]} lines
 * @param {{ seed?: number|string, cutRate?: 'phrase'|'line'|'fast', title?: string, artist?: string }} [options]
 * @returns {{ seed: number, shots: any[], durationMs: number }}
 */
export function compilePrismProgram(lines = [], options = {}) {
    const rawSeed = options.seed !== undefined
        ? (typeof options.seed === 'number' ? options.seed : hashPrismSeed(String(options.seed)))
        : hashPrismSeed(`${options.title || ''}|${options.artist || ''}|${Array.isArray(lines) ? lines.length : 0}`);
    const baseSeed = (rawSeed >>> 0) || 2166136261;
    const cutRate = options.cutRate === 'line' || options.cutRate === 'fast' ? options.cutRate : 'phrase';
    const title = String(options.title || 'ARIA PRISM').trim() || 'ARIA PRISM';
    const artist = String(options.artist || '').trim();

    /** @type {Array<{ text: string, translation: string, romaji: string, start: number, end: number, graphemes: Array<{char:string,start:number,end:number}>, lineIndex: number, isChorus: boolean, isInterlude: boolean }>} */
    const rawChunks = [];
    const safeLines = Array.isArray(lines) ? lines : [];
    const chorusLineSet = detectChorusLineSet(safeLines);

    for (let i = 0; i < safeLines.length; i++) {
        const line = safeLines[i];
        if (!line) continue;
        const nextLine = safeLines[i + 1];
        const norm = normalizeLine(line, nextLine);
        const text = norm.text.trim();
        if (!text || isInterludeText(text)) continue;

        const graphemes = buildGraphemes(line, nextLine);
        if (graphemes.length === 0) continue;

        const ranges = chunkLineGraphemes(graphemes, cutRate);
        const isChorus = chorusLineSet.has(i);

        const rawTrans = line.translation || line.trans || '';
        const trans = rawTrans && String(rawTrans).trim() !== '//'
            ? String(rawTrans).trim()
            : '';
        const rawRoma = line.romaji || line.roma || '';
        const roma = rawRoma && String(rawRoma).trim() !== '//'
            ? String(rawRoma).trim()
            : '';

        for (let r = 0; r < ranges.length; r++) {
            const range = ranges[r];
            const subGraphemes = graphemes.slice(range.startIdx, range.endIdx);
            if (subGraphemes.length === 0) continue;
            const subText = subGraphemes.map(g => g.char).join('').trim();
            if (!subText) continue;
            const cStart = subGraphemes[0].start;
            const cEnd = Math.max(cStart + 280, subGraphemes[subGraphemes.length - 1].end);
            rawChunks.push({
                text: subText,
                translation: trans,
                romaji: roma,
                start: cStart,
                end: cEnd,
                graphemes: subGraphemes,
                lineIndex: i,
                isChorus,
                isInterlude: false,
            });
        }
    }

    if (rawChunks.length === 0) {
        const idleSeed = mixPrismSeed(baseSeed, 'idle-shot');
        const idleShot = {
            index: 0,
            seed: idleSeed,
            kind: 'diamond-aperture',
            family: 'aperture',
            layout: 'monumental-poster',
            enterStyle: 'refract-snap',
            transition: 'cross-dissolve',
            transitionDurationMs: 520,
            startTimeMs: 0,
            endTimeMs: 600000,
            lineIndex: -1,
            isChorus: false,
            isInterlude: true,
            text: title,
            subText: artist,
            translation: artist,
            romaji: '',
            graphemes: Array.from(title).map((ch, idx) => ({
                char: ch,
                start: idx * 120,
                end: idx * 120 + 400,
            })),
            flowAngleDeg: -14,
            cameraZoomStart: 0.96,
            cameraZoomEnd: 1.05,
            cameraDriftX: 0.02,
            cameraDriftY: -0.015,
            cameraRollStartDeg: -1.2,
            cameraRollEndDeg: 1.2,
            hudCode: 'PRM-00 // APERTURE',
        };
        return { seed: baseSeed, shots: [idleShot], durationMs: 600000 };
    }

    // 在超长前奏或超长间奏处插入呼吸镜头（sparse-zenith / eclipse-ring）
    /** @type {typeof rawChunks} */
    const timelineChunks = [];
    if (rawChunks[0].start >= 4500) {
        const endIntro = Math.max(1200, rawChunks[0].start - 200);
        timelineChunks.push({
            text: title,
            translation: artist,
            romaji: '',
            start: 0,
            end: endIntro,
            graphemes: Array.from(title).map((ch, idx) => ({
                char: ch,
                start: idx * 90,
                end: Math.min(endIntro, idx * 90 + 500),
            })),
            lineIndex: -1,
            isChorus: false,
            isInterlude: true,
        });
    }

    for (let i = 0; i < rawChunks.length; i++) {
        const cur = rawChunks[i];
        timelineChunks.push(cur);
        const next = rawChunks[i + 1];
        if (next && next.start - cur.end >= 6500) {
            const gapStart = cur.end + 350;
            const gapEnd = next.start - 200;
            if (gapEnd - gapStart >= 2200) {
                timelineChunks.push({
                    text: '◇  ◇  ◇',
                    translation: title,
                    romaji: artist,
                    start: gapStart,
                    end: gapEnd,
                    graphemes: [
                        { char: '◇', start: gapStart, end: gapStart + 600 },
                        { char: ' ', start: gapStart + 600, end: gapStart + 700 },
                        { char: '◇', start: gapStart + 700, end: gapStart + 1300 },
                        { char: ' ', start: gapStart + 1300, end: gapStart + 1400 },
                        { char: '◇', start: gapStart + 1400, end: gapStart + 2000 },
                    ],
                    lineIndex: cur.lineIndex,
                    isChorus: false,
                    isInterlude: true,
                });
            }
        }
    }

    // 9 大构图视觉锚区（左中海报 / 右中海报 / 高天际线 / 深潜舞台 / 左上斜切 / 右下斜切 / 右上平衡 / 左下阶梯 / 居中主轴）
    const PRISM_FOCAL_ZONES = [
        { id: 'left-poster', cx: 0.37, cy: 0.45, align: 'left', rot: -0.045 },
        { id: 'right-poster', cx: 0.63, cy: 0.46, align: 'right', rot: 0.045 },
        { id: 'high-horizon', cx: 0.50, cy: 0.34, align: 'center', rot: -0.015 },
        { id: 'deep-stage', cx: 0.50, cy: 0.56, align: 'center', rot: 0.015 },
        { id: 'upper-left', cx: 0.39, cy: 0.37, align: 'left', rot: -0.065 },
        { id: 'lower-right', cx: 0.61, cy: 0.54, align: 'right', rot: -0.055 },
        { id: 'upper-right', cx: 0.61, cy: 0.37, align: 'right', rot: 0.055 },
        { id: 'lower-left', cx: 0.39, cy: 0.54, align: 'left', rot: 0.050 },
        { id: 'center-axis', cx: 0.50, cy: 0.46, align: 'center', rot: 0 },
    ];
    const PRISM_DECOR_MOTIFS = [
        'astrolabe-rings',
        'reticle-cross',
        'parallel-rulers',
        'crystal-lattice',
        'diffraction-grating',
        'orbit-arcs',
        'corner-brackets',
        'diamond-grid',
    ];

    // Tempera 式连续流向角链：主轴偏纵向/斜向，相邻镜头顺流微转而不反向相撞
    const resolvePrismFlowAngle = (prevRad, seed) => {
        if (prevRad === null) {
            const sign = prismHash01(seed, 6, 71) > 0.5 ? 1 : -1;
            return sign * (Math.PI * 0.44) + (prismHash01(seed, 8, 79) - 0.5) * 0.42;
        }
        const homeAxis = (Math.sin(prevRad) >= 0 ? 1 : -1) * (Math.PI * 0.44);
        return prevRad + (homeAxis - prevRad) * 0.28 + (prismHash01(seed, 7, 73) - 0.5) * 0.48;
    };

    // 铺满时间轴（首尾衔接，不留黑场空洞）
    let deck = buildShuffledDeck(baseSeed);
    let deckEpoch = 1;
    let prevFamily = '';
    let prevFamily2 = '';
    let prevKind = '';
    /** @type {string[]} */
    const recentKinds = [];
    /** @type {number[]} */
    const recentZones = [];
    /** @type {string[]} */
    const recentMotifs = [];
    let prevLayout = null;
    let prevEnter = null;
    let prevTransition = null;
    let prevTransition2 = null;
    /** @type {number|null} */
    let prevFlowRad = null;

    const shots = [];

    for (let i = 0; i < timelineChunks.length; i++) {
        const chunk = timelineChunks[i];
        const nextChunk = timelineChunks[i + 1];
        const prevShot = shots[i - 1] || null;
        const shotSeed = mixPrismSeed(baseSeed, i * 131 + chunk.text.length * 17);

        const leadIn = i === 0 ? Math.min(chunk.start, 350) : 140;
        const rawStart = Math.max(0, chunk.start - leadIn);
        const startTimeMs = prevShot ? Math.max(prevShot.endTimeMs, rawStart) : 0;
        if (prevShot && startTimeMs > prevShot.endTimeMs) {
            prevShot.endTimeMs = startTimeMs;
        }

        let endTimeMs = nextChunk
            ? Math.max(startTimeMs + 320, Math.min(chunk.end + 900, nextChunk.start - 80))
            : Math.max(startTimeMs + 2400, chunk.end + 3200);
        if (endTimeMs <= startTimeMs + 200) {
            endTimeMs = startTimeMs + 420;
        }

        // 选择 shotKind：18 镜头滑动窗口防重样 + 禁止相邻同家族，36 种构图全曲均衡轮换
        if (deck.length === 0) {
            deck = buildShuffledDeck(mixPrismSeed(baseSeed, ++deckEpoch * 997));
        }

        let chosenKind;
        if (chunk.isInterlude) {
            const interludePool = ['sparse-zenith', 'eclipse-ring', 'diamond-aperture', 'anamorphic-band'];
            chosenKind = pickPrismCandidate(interludePool, shotSeed, i, prevKind) || 'sparse-zenith';
        } else {
            let pickIdx = -1;
            for (let k = 0; k < deck.length; k++) {
                const candidate = deck[k];
                const fam = familyOfShotKind(candidate);
                if (!recentKinds.includes(candidate) && fam !== prevFamily && fam !== prevFamily2) {
                    pickIdx = k;
                    break;
                }
            }
            if (pickIdx < 0) {
                for (let k = 0; k < deck.length; k++) {
                    const candidate = deck[k];
                    const fam = familyOfShotKind(candidate);
                    if (candidate !== prevKind && fam !== prevFamily) {
                        pickIdx = k;
                        break;
                    }
                }
            }
            if (pickIdx < 0) pickIdx = 0;
            chosenKind = deck.splice(pickIdx, 1)[0];
            recentKinds.push(chosenKind);
            if (recentKinds.length > 18) recentKinds.shift();
        }

        const family = familyOfShotKind(chosenKind);
        prevKind = chosenKind;
        prevFamily2 = prevFamily;
        prevFamily = family;

        // 选择视觉锚区（9 区轮转，连续 3 镜绝不落在同一区域）
        const zonePool = PRISM_FOCAL_ZONES.map((_, zIdx) => zIdx).filter(zIdx => !recentZones.includes(zIdx));
        const chosenZoneIdx = zonePool.length > 0
            ? zonePool[Math.floor(prismHash01(shotSeed, i, 251) * zonePool.length) % zonePool.length]
            : (i % PRISM_FOCAL_ZONES.length);
        recentZones.push(chosenZoneIdx);
        if (recentZones.length > 3) recentZones.shift();
        const focalZone = PRISM_FOCAL_ZONES[chosenZoneIdx];

        // 选择几何光学装饰母题（8 种母题轮转，连续 3 镜不重样）
        const motifPool = PRISM_DECOR_MOTIFS.filter(m => !recentMotifs.includes(m));
        const decorMotif = motifPool.length > 0
            ? motifPool[Math.floor(prismHash01(shotSeed, i, 263) * motifPool.length) % motifPool.length]
            : PRISM_DECOR_MOTIFS[i % PRISM_DECOR_MOTIFS.length];
        recentMotifs.push(decorMotif);
        if (recentMotifs.length > 3) recentMotifs.shift();

        // 从邻句提取不与当前屏文字重复的背景水印词（参考 Tempera buildDecorWatermark）
        const neighborChunk = timelineChunks[i + 1] || timelineChunks[i - 1] || chunk;
        const neighborClean = String(neighborChunk.text || '').replace(/\s+/g, ' ').trim();
        const neighborWords = neighborClean.split(/[\s，。！？、,.!?;:]+/).filter(w => w.length >= 1 && w !== chunk.text);
        const watermarkText = neighborWords.length > 0
            ? neighborWords[Math.floor(prismHash01(shotSeed, i, 271) * neighborWords.length) % neighborWords.length].slice(0, 6)
            : Array.from(chunk.text.replace(/\s+/g, '')).slice(0, 2).join('') || '◇';

        const layout = chunk.isInterlude
            ? 'monumental-poster'
            : selectLayoutKind(chunk.text, chunk.graphemes.length, shotSeed, i, prevLayout);
        prevLayout = layout;

        const enterStyle = pickPrismCandidate(PRISM_ENTER_STYLES, shotSeed, i + 7, prevEnter) || PRISM_ENTER_STYLES[0];
        prevEnter = enterStyle;

        let transitionPool = PRISM_TRANSITION_KINDS.filter(t => t !== prevTransition && t !== prevTransition2);
        if (transitionPool.length === 0) transitionPool = PRISM_TRANSITION_KINDS;
        if (i === 0 || chunk.isInterlude || (prevShot && prevShot.isInterlude)) {
            transitionPool = ['cross-dissolve', 'iris-refract'];
        } else if (chunk.isChorus && (!prevShot || !prevShot.isChorus)) {
            transitionPool = ['spectral-flash', 'iris-refract', 'prism-rotate'];
        }
        const transition = pickPrismCandidate(transitionPool, shotSeed, i + 19, prevTransition) || 'shear-slide';
        prevTransition2 = prevTransition;
        prevTransition = transition;

        const shotDur = Math.max(400, endTimeMs - startTimeMs);
        // Tempera 同款交棒时长：随镜头节奏自适应（480~940ms），前后镜头在同一流向上无缝推镜交接
        const transitionDurationMs = Math.round(Math.min(940, Math.max(480, shotDur * 0.34)));

        const flowAngleRad = resolvePrismFlowAngle(prevFlowRad, shotSeed);
        prevFlowRad = flowAngleRad;
        const flowAngleDeg = (flowAngleRad * 180) / Math.PI;
        const zoomIn = prismHash01(shotSeed, 2, 199) >= 0.32;
        const zoomSpan = chunk.isChorus ? 0.065 : 0.045;
        const cameraZoomStart = zoomIn ? 1.00 : 1.00 + zoomSpan;
        const cameraZoomEnd = zoomIn ? 1.00 + zoomSpan : 1.00;
        const driftMag = chunk.isChorus ? 0.032 : 0.024;
        const cameraDriftX = Math.cos(flowAngleRad) * driftMag;
        const cameraDriftY = Math.sin(flowAngleRad) * driftMag;
        const rollSpan = prismRange(shotSeed, 4, 0.7, 2.1, 229) * (prismHash01(shotSeed, 5, 241) > 0.5 ? 1 : -1);

        // 将 zoneIdx 编码进 geometry seed，使同一 kind 在不同出现位置拥有截然不同的焦点锚位与不对称切面
        const geoSeed = mixPrismSeed(shotSeed, chosenZoneIdx * 4099 + i * 53);
        const hudCode = `PRM-${String(i + 1).padStart(2, '0')} // ${family.toUpperCase()} · ${chosenKind.toUpperCase()}`;

        shots.push({
            index: i,
            seed: geoSeed,
            kind: chosenKind,
            family,
            layout,
            enterStyle,
            transition,
            transitionDurationMs,
            startTimeMs,
            endTimeMs,
            lineIndex: chunk.lineIndex,
            isChorus: chunk.isChorus,
            isInterlude: chunk.isInterlude,
            text: chunk.text,
            subText: chunk.translation || chunk.romaji || '',
            translation: chunk.translation,
            romaji: chunk.romaji,
            graphemes: chunk.graphemes,
            region: focalZone,
            decorMotif,
            watermarkText,
            flowAngleRad,
            flowAngleDeg,
            cameraZoomStart,
            cameraZoomEnd,
            cameraDriftX,
            cameraDriftY,
            cameraRollStartDeg: -rollSpan * 0.5,
            cameraRollEndDeg: rollSpan * 0.5,
            hudCode,
        });
    }

    const durationMs = shots.length > 0 ? shots[shots.length - 1].endTimeMs : 0;
    return { seed: baseSeed, shots, durationMs };
}

/**
 * 二分查找给定毫秒时间对应的当前分镜及转场叠化状态（O(log N)，100% 确定性 seek-safe）
 * @param {{ shots: any[] } | null | undefined} program
 * @param {number} timeMs
 * @returns {{ active: any|null, prev: any|null, activeProgress: number, transitionProgress: number }}
 */
export function findActivePrismShot(program, timeMs) {
    const shots = program && Array.isArray(program.shots) ? program.shots : [];
    if (shots.length === 0) {
        return { active: null, prev: null, activeProgress: 0, transitionProgress: 1 };
    }
    const t = Math.max(0, Number(timeMs) || 0);
    let lo = 0;
    let hi = shots.length - 1;
    let idx = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const s = shots[mid];
        if (t < s.startTimeMs) {
            hi = mid - 1;
        } else if (t >= s.endTimeMs && mid < shots.length - 1) {
            lo = mid + 1;
        } else {
            idx = mid;
            break;
        }
    }
    if (lo >= shots.length) idx = shots.length - 1;
    else if (hi < 0) idx = 0;

    const active = shots[idx];
    const prev = idx > 0 ? shots[idx - 1] : null;
    const dur = Math.max(1, active.endTimeMs - active.startTimeMs);
    const activeProgress = clamp01((t - active.startTimeMs) / dur);

    let transitionProgress = 1;
    if (prev && active.transitionDurationMs > 0) {
        const elapsed = t - active.startTimeMs;
        if (elapsed >= 0 && elapsed < active.transitionDurationMs) {
            transitionProgress = clamp01(elapsed / active.transitionDurationMs);
        }
    }
    return { active, prev, activeProgress, transitionProgress };
}

/* ==================== 多边形半平面切割与 36 种切面几何 ==================== */

function clipPolygonHalfPlane(poly, nx, ny, c) {
    const out = [];
    const n = poly.length;
    if (n === 0) return out;
    for (let i = 0; i < n; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % n];
        const da = a.x * nx + a.y * ny - c;
        const db = b.x * nx + b.y * ny - c;
        if (da <= 1e-6) out.push(a);
        if ((da <= 1e-6 && db > 1e-6) || (da > 1e-6 && db <= 1e-6)) {
            const t = da / (da - db);
            out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        }
    }
    return out;
}

function splitPolygonsByLine(polys, angleDeg, px, py) {
    const rad = (angleDeg * Math.PI) / 180;
    const nx = -Math.sin(rad);
    const ny = Math.cos(rad);
    const c = px * nx + py * ny;
    const out = [];
    for (const p of polys) {
        const left = clipPolygonHalfPlane(p, nx, ny, c);
        const right = clipPolygonHalfPlane(p, -nx, -ny, -c);
        if (left.length >= 3) out.push(left);
        if (right.length >= 3) out.push(right);
    }
    return out;
}

function polyCentroid(pts) {
    let sx = 0, sy = 0;
    const n = pts.length || 1;
    for (const p of pts) { sx += p.x; sy += p.y; }
    return { x: sx / n, y: sy / n };
}

function regularNGon(cx, cy, rx, ry, sides, rotDeg = 0) {
    const pts = [];
    const base = (rotDeg * Math.PI) / 180;
    for (let i = 0; i < sides; i++) {
        const a = base + (i * Math.PI * 2) / sides;
        pts.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
    }
    return pts;
}

function rotatedRect(cx, cy, w, h, rotDeg = 0) {
    const rad = (rotDeg * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const hw = w * 0.5, hh = h * 0.5;
    return [
        { x: cx + (-hw * cos - -hh * sin), y: cy + (-hw * sin + -hh * cos) },
        { x: cx + (hw * cos - -hh * sin), y: cy + (hw * sin + -hh * cos) },
        { x: cx + (hw * cos - hh * sin), y: cy + (hw * sin + hh * cos) },
        { x: cx + (-hw * cos - hh * sin), y: cy + (-hw * sin + hh * cos) },
    ];
}

/**
 * 为指定分镜生成归一化切面多边形几何（坐标空间：x ∈ [-pad, A+pad], y ∈ [-pad, 1+pad]，A = aspect）
 * @param {string} kind
 * @param {number} seed
 * @param {number} [aspect=1.6]
 * @returns {{ kind: string, family: string, aspect: number, focus: {x:number,y:number}, facets: Array<{points:Array<{x:number,y:number}>, tone:number, invert:boolean, useCover:boolean, shiftX:number, shiftY:number, sheenAngle:number}>, cutSegments: Array<{x1:number,y1:number,x2:number,y2:number}>, watermark: boolean }}
 */
export function buildPrismFacetGeometry(kind, seed = 1, aspect = 1.6) {
    const A = Math.max(0.5, Math.min(3.2, Number(aspect) || 1.6));
    const s = (seed >>> 0) || 1;
    const family = familyOfShotKind(kind);
    const pad = 0.14;
    const baseRect = [
        { x: -pad, y: -pad },
        { x: A + pad, y: -pad },
        { x: A + pad, y: 1 + pad },
        { x: -pad, y: 1 + pad },
    ];

    let focus = { x: A * 0.5, y: 0.48 };
    let watermark = kind === 'poster-refract' || kind === 'obsidian-pillar' || kind === 'anamorphic-band';
    /** @type {Array<{points:Array<{x:number,y:number}>, tone?:number, invert?:boolean}>} */
    const rawFacets = [];

    const jitter = (idx, amp = 0.04) => prismRange(s, idx, -amp, amp, 409);

    if (family === 'split') {
        let polys = [baseRect];
        if (kind === 'birefringent-slash') {
            const ang = -22 + jitter(1, 6);
            polys = splitPolygonsByLine(polys, ang, A * 0.48, 0.46);
            polys = splitPolygonsByLine(polys, ang, A * 0.54, 0.54);
        } else if (kind === 'fault-chevron') {
            polys = splitPolygonsByLine(polys, 26 + jitter(1, 5), A * 0.5, 0.48);
            polys = splitPolygonsByLine(polys, -26 + jitter(2, 5), A * 0.5, 0.48);
        } else if (kind === 'twin-wedge') {
            polys = splitPolygonsByLine(polys, 16 + jitter(1, 4), A * 0.42, 0.44);
            polys = splitPolygonsByLine(polys, -18 + jitter(2, 4), A * 0.58, 0.56);
        } else if (kind === 'stepped-shear') {
            const ang = -14 + jitter(1, 4);
            polys = splitPolygonsByLine(polys, ang, A * 0.35, 0.36);
            polys = splitPolygonsByLine(polys, ang, A * 0.52, 0.50);
            polys = splitPolygonsByLine(polys, ang, A * 0.68, 0.64);
        } else if (kind === 'crossed-blades') {
            polys = splitPolygonsByLine(polys, 34 + jitter(1, 5), A * 0.5, 0.49);
            polys = splitPolygonsByLine(polys, -38 + jitter(2, 5), A * 0.5, 0.49);
        } else {
            // offset-fault
            const ang = -32 + jitter(1, 5);
            polys = splitPolygonsByLine(polys, ang, A * 0.38, 0.45);
            polys = splitPolygonsByLine(polys, ang, A * 0.52, 0.52);
            focus = { x: A * 0.54, y: 0.48 };
        }
        polys.forEach((pts, i) => rawFacets.push({ points: pts, tone: i % 4, invert: i === 1 }));
    } else if (family === 'aperture') {
        rawFacets.push({ points: baseRect, tone: 0, invert: false });
        const cx = A * (0.5 + jitter(1, 0.04));
        const cy = 0.48 + jitter(2, 0.03);
        if (kind === 'diamond-aperture') {
            rawFacets.push({ points: regularNGon(cx, cy, A * 0.34, 0.38, 4, jitter(3, 8)), tone: 2, invert: false });
            rawFacets.push({ points: regularNGon(cx, cy, A * 0.22, 0.25, 4, jitter(3, 8)), tone: 4, invert: true });
        } else if (kind === 'hex-iris') {
            rawFacets.push({ points: regularNGon(cx, cy, A * 0.33, 0.36, 6, 15 + jitter(3, 6)), tone: 1, invert: false });
            rawFacets.push({ points: regularNGon(cx, cy, A * 0.20, 0.23, 6, -15 + jitter(4, 6)), tone: 4, invert: true });
        } else if (kind === 'revolving-monocle') {
            const ox = A * 0.44;
            rawFacets.push({ points: regularNGon(ox, cy, A * 0.30, 0.34, 7, 12), tone: 2, invert: false });
            rawFacets.push({ points: regularNGon(ox + A * 0.08, cy, A * 0.19, 0.22, 5, -20), tone: 4, invert: true });
            focus = { x: A * 0.48, y: cy };
        } else if (kind === 'octagonal-well') {
            rawFacets.push({ points: regularNGon(cx, cy, A * 0.36, 0.40, 8, 22.5), tone: 1, invert: false });
            rawFacets.push({ points: regularNGon(cx, cy, A * 0.26, 0.29, 8, 0), tone: 3, invert: false });
            rawFacets.push({ points: regularNGon(cx, cy, A * 0.16, 0.18, 8, 22.5), tone: 4, invert: true });
        } else if (kind === 'eclipse-ring') {
            rawFacets.push({ points: regularNGon(cx - A * 0.03, cy, A * 0.28, 0.32, 10, 0), tone: 4, invert: true });
            rawFacets.push({ points: regularNGon(cx + A * 0.03, cy, A * 0.21, 0.24, 10, 18), tone: 1, invert: false });
        } else {
            // double-loupe
            rawFacets.push({ points: regularNGon(A * 0.38, 0.45, A * 0.22, 0.26, 6, 10), tone: 4, invert: true });
            rawFacets.push({ points: regularNGon(A * 0.62, 0.53, A * 0.20, 0.24, 6, -14), tone: 2, invert: false });
        }
    }
    else if (family === 'shard') {
        rawFacets.push({ points: baseRect, tone: 0, invert: false });
        const cx = A * 0.5, cy = 0.48;
        if (kind === 'crystal-cluster') {
            for (let i = 0; i < 4; i++) {
                const ox = cx + prismRange(s, i + 10, -A * 0.22, A * 0.22);
                const oy = cy + prismRange(s, i + 20, -0.18, 0.18);
                const rx = A * prismRange(s, i + 30, 0.14, 0.24);
                const ry = prismRange(s, i + 40, 0.16, 0.28);
                const sides = 3 + ((i + (s & 1)) % 3);
                rawFacets.push({ points: regularNGon(ox, oy, rx, ry, sides, i * 37), tone: (i % 3) + 1, invert: i === 2 });
            }
        } else if (kind === 'shattered-crown' || kind === 'radial-burst') {
            const count = kind === 'radial-burst' ? 6 : 5;
            for (let i = 0; i < count; i++) {
                const a1 = (i * Math.PI * 2) / count + jitter(i, 0.12);
                const a2 = a1 + (Math.PI * 1.15) / count;
                const rOuter = A * prismRange(s, i + 15, 0.36, 0.52);
                rawFacets.push({
                    points: [
                        { x: cx + Math.cos(a1) * 0.04, y: cy + Math.sin(a1) * 0.04 },
                        { x: cx + Math.cos(a1) * rOuter, y: cy + Math.sin(a1) * rOuter * 0.85 },
                        { x: cx + Math.cos(a2) * rOuter, y: cy + Math.sin(a2) * rOuter * 0.85 },
                    ],
                    tone: (i % 3) + 1,
                    invert: i === 1,
                });
            }
        } else if (kind === 'ice-fracture') {
            let polys = [baseRect];
            polys = splitPolygonsByLine(polys, 28 + jitter(1, 8), A * 0.46, 0.44);
            polys = splitPolygonsByLine(polys, -42 + jitter(2, 8), A * 0.54, 0.52);
            polys = splitPolygonsByLine(polys, 8 + jitter(3, 6), A * 0.50, 0.48);
            rawFacets.length = 0;
            polys.forEach((pts, i) => rawFacets.push({ points: pts, tone: i % 4, invert: i === 2 }));
        } else if (kind === 'floating-polyhedra') {
            for (let i = 0; i < 5; i++) {
                const ox = A * (0.22 + i * 0.14 + jitter(i, 0.03));
                const oy = 0.30 + ((i * 37) % 3) * 0.16 + jitter(i + 8, 0.03);
                rawFacets.push({
                    points: regularNGon(ox, oy, A * 0.13, 0.17, 5 + (i % 2), i * 29),
                    tone: (i % 3) + 1,
                    invert: i === 2,
                });
            }
        } else {
            // prism-confetti
            for (let i = 0; i < 5; i++) {
                const ox = A * (0.24 + i * 0.13);
                const oy = 0.36 + (i % 2 === 0 ? -0.06 : 0.08);
                rawFacets.push({
                    points: rotatedRect(ox, oy, A * 0.18, 0.28, -22 + i * 6),
                    tone: (i % 3) + 1,
                    invert: i === 2,
                });
            }
        }
    } else if (family === 'corridor') {
        rawFacets.push({ points: baseRect, tone: 0, invert: false });
        if (kind === 'prism-corridor') {
            const il = A * 0.28, ir = A * 0.72, it = 0.24, ib = 0.74;
            rawFacets.push({ points: [{ x: 0, y: 0 }, { x: il, y: it }, { x: il, y: ib }, { x: 0, y: 1 }], tone: 1, invert: false });
            rawFacets.push({ points: [{ x: A, y: 0 }, { x: ir, y: it }, { x: ir, y: ib }, { x: A, y: 1 }], tone: 2, invert: false });
            rawFacets.push({ points: [{ x: il, y: it }, { x: ir, y: it }, { x: ir, y: ib }, { x: il, y: ib }], tone: 4, invert: true });
        } else if (kind === 'staircase-refraction') {
            for (let i = 0; i < 4; i++) {
                const cx = A * (0.26 + i * 0.16);
                const cy = 0.30 + i * 0.12;
                rawFacets.push({ points: rotatedRect(cx, cy, A * 0.34, 0.22, -12), tone: (i % 3) + 1, invert: i === 2 });
            }
        } else if (kind === 'kaleidoscope-hall') {
            const cx = A * 0.5, cy = 0.48;
            const d = regularNGon(cx, cy, A * 0.28, 0.32, 4, 0);
            rawFacets.push({ points: [{ x: 0, y: 0 }, { x: A, y: 0 }, d[3]], tone: 1, invert: false });
            rawFacets.push({ points: [{ x: A, y: 0 }, { x: A, y: 1 }, d[0]], tone: 2, invert: false });
            rawFacets.push({ points: [{ x: A, y: 1 }, { x: 0, y: 1 }, d[1]], tone: 1, invert: false });
            rawFacets.push({ points: [{ x: 0, y: 1 }, { x: 0, y: 0 }, d[2]], tone: 2, invert: false });
            rawFacets.push({ points: d, tone: 4, invert: true });
        } else if (kind === 'periscope-shaft') {
            rawFacets.push({ points: rotatedRect(A * 0.5, 0.22, A * 1.1, 0.24, -8), tone: 2, invert: false });
            rawFacets.push({ points: rotatedRect(A * 0.5, 0.78, A * 1.1, 0.24, -8), tone: 1, invert: false });
            rawFacets.push({ points: rotatedRect(A * 0.5, 0.49, A * 0.86, 0.20, -8), tone: 4, invert: true });
        } else if (kind === 'infinite-facets') {
            rawFacets.push({ points: rotatedRect(A * 0.5, 0.48, A * 0.76, 0.72, 5), tone: 1, invert: false });
            rawFacets.push({ points: rotatedRect(A * 0.5, 0.48, A * 0.56, 0.52, -6), tone: 2, invert: false });
            rawFacets.push({ points: rotatedRect(A * 0.5, 0.48, A * 0.38, 0.34, 7), tone: 4, invert: true });
        } else {
            // tilted-gallery
            for (let i = 0; i < 4; i++) {
                rawFacets.push({
                    points: rotatedRect(A * (0.20 + i * 0.20), 0.48, A * 0.16, 0.84, 14),
                    tone: (i % 3) + 1,
                    invert: i === 1,
                });
            }
        }
    } else if (family === 'monolith') {
        rawFacets.push({ points: baseRect, tone: 0, invert: false });
        if (kind === 'obsidian-pillar') {
            rawFacets.push({ points: rotatedRect(A * 0.5, 0.48, A * 0.28, 0.92, -6 + jitter(1, 4)), tone: 4, invert: true });
            rawFacets.push({ points: rotatedRect(A * 0.5, 0.48, A * 0.46, 0.22, 12), tone: 2, invert: false });
        } else if (kind === 'suspended-obelisk') {
            const ox = A * 0.46;
            rawFacets.push({ points: rotatedRect(A * 0.5, 0.50, A * 0.88, 0.18, -10), tone: 2, invert: false });
            rawFacets.push({
                points: [
                    { x: ox, y: 0.10 },
                    { x: ox + A * 0.14, y: 0.24 },
                    { x: ox + A * 0.11, y: 0.86 },
                    { x: ox - A * 0.11, y: 0.86 },
                    { x: ox - A * 0.14, y: 0.24 },
                ],
                tone: 4,
                invert: true,
            });
        } else if (kind === 'cantilever-glass') {
            rawFacets.push({
                points: [{ x: -pad, y: 0.12 }, { x: A * 0.78, y: 0.36 }, { x: -pad, y: 0.86 }],
                tone: 4,
                invert: true,
            });
            rawFacets.push({
                points: [{ x: A + pad, y: 0.22 }, { x: A * 0.32, y: 0.64 }, { x: A + pad, y: 0.92 }],
                tone: 2,
                invert: false,
            });
            focus = { x: A * 0.52, y: 0.48 };
        } else if (kind === 'triptych-panes') {
            rawFacets.push({ points: rotatedRect(A * 0.24, 0.48, A * 0.22, 0.78, -4), tone: 1, invert: false });
            rawFacets.push({ points: rotatedRect(A * 0.50, 0.48, A * 0.24, 0.84, -4), tone: 4, invert: true });
            rawFacets.push({ points: rotatedRect(A * 0.76, 0.48, A * 0.22, 0.78, -4), tone: 2, invert: false });
        } else if (kind === 'horizon-prism') {
            rawFacets.push({
                points: [{ x: -pad, y: 0.30 }, { x: A + pad, y: 0.22 }, { x: A + pad, y: 0.68 }, { x: -pad, y: 0.60 }],
                tone: 4,
                invert: true,
            });
            rawFacets.push({
                points: [{ x: A * 0.14, y: 0.16 }, { x: A * 0.86, y: 0.48 }, { x: A * 0.14, y: 0.82 }],
                tone: 2,
                invert: false,
            });
        } else {
            // diagonal-beam
            rawFacets.push({ points: rotatedRect(A * 0.5, 0.48, A * 1.25, 0.26, -32), tone: 4, invert: true });
            rawFacets.push({ points: rotatedRect(A * 0.5, 0.48, A * 0.95, 0.14, 28), tone: 2, invert: false });
        }
    } else {
        // cinema family
        rawFacets.push({ points: baseRect, tone: 0, invert: false });
        if (kind === 'anamorphic-band') {
            rawFacets.push({ points: rotatedRect(A * 0.5, 0.48, A * 1.2, 0.34, -4), tone: 2, invert: false });
            rawFacets.push({ points: rotatedRect(A * 0.5, 0.48, A * 0.78, 0.20, -4), tone: 4, invert: true });
        } else if (kind === 'letterbox-prism') {
            rawFacets.push({ points: [{ x: -pad, y: -pad }, { x: A + pad, y: -pad }, { x: A + pad, y: 0.22 }, { x: -pad, y: 0.28 }], tone: 1, invert: false });
            rawFacets.push({ points: [{ x: -pad, y: 0.72 }, { x: A + pad, y: 0.78 }, { x: A + pad, y: 1 + pad }, { x: -pad, y: 1 + pad }], tone: 1, invert: false });
            rawFacets.push({ points: rotatedRect(A * 0.5, 0.49, A * 0.54, 0.28, -12), tone: 4, invert: true });
        } else if (kind === 'corner-triad') {
            rawFacets.push({ points: [{ x: -pad, y: -pad }, { x: A * 0.45, y: -pad }, { x: -pad, y: 0.52 }], tone: 2, invert: false });
            rawFacets.push({ points: [{ x: A + pad, y: -pad }, { x: A + pad, y: 0.58 }, { x: A * 0.56, y: -pad }], tone: 1, invert: false });
            rawFacets.push({ points: [{ x: A * 0.28, y: 0.34 }, { x: A * 0.76, y: 0.42 }, { x: A * 0.46, y: 0.76 }], tone: 4, invert: true });
            focus = { x: A * 0.48, y: 0.50 };
        } else if (kind === 'sparse-zenith') {
            rawFacets.push({ points: rotatedRect(A * 0.5, 0.48, A * 0.92, 0.14, -18), tone: 4, invert: true });
            focus = { x: A * 0.5, y: 0.48 };
        } else if (kind === 'poster-refract') {
            let polys = [baseRect];
            polys = splitPolygonsByLine(polys, -24, A * 0.46, 0.48);
            rawFacets.length = 0;
            polys.forEach((pts, i) => rawFacets.push({ points: pts, tone: i === 0 ? 1 : 3, invert: false }));
            rawFacets.push({ points: rotatedRect(A * 0.52, 0.48, A * 0.44, 0.30, -24), tone: 4, invert: true });
            watermark = true;
        } else {
            // spectral-frame
            rawFacets.push({ points: rotatedRect(A * 0.5, 0.48, A * 0.80, 0.74, 2), tone: 2, invert: false });
            rawFacets.push({ points: rotatedRect(A * 0.5, 0.48, A * 0.64, 0.56, -3), tone: 1, invert: false });
            rawFacets.push({ points: rotatedRect(A * 0.5, 0.48, A * 0.42, 0.32, 4), tone: 4, invert: true });
        }
    }

    // 确定性镜像翻转 + 构图锚点偏移 + 整体微旋角，彻底消除镜头居中同质化
    const flipX = prismHash01(s, 91, 503) > 0.5;
    const flipY = (family === 'split' || family === 'shard' || family === 'corridor') && prismHash01(s, 92, 521) > 0.55;
    const anchorDX = prismRange(s, 88, -A * 0.13, A * 0.13, 487);
    const anchorDY = prismRange(s, 89, -0.10, 0.09, 491);
    const tiltRad = (prismRange(s, 90, -15, 15, 499) * Math.PI) / 180;
    const cosT = Math.cos(tiltRad);
    const sinT = Math.sin(tiltRad);
    const isPartition = family === 'split' || kind === 'ice-fracture' || kind === 'poster-refract';

    if (flipX) focus.x = A - focus.x;
    if (flipY) focus.y = 1 - focus.y;
    focus.x = Math.max(A * 0.30, Math.min(A * 0.70, focus.x + anchorDX));
    focus.y = Math.max(0.32, Math.min(0.58, focus.y + anchorDY));

    let invertUsed = false;
    let coverUsed = false;
    const facets = rawFacets.map((rf, idx) => {
        const isBaseGround = !isPartition && idx === 0;
        const pts = rf.points.map(p => {
            let px = flipX ? A - p.x : p.x;
            let py = flipY ? 1 - p.y : p.y;
            if (!isBaseGround && !isPartition) {
                const rx = px - A * 0.5;
                const ry = py - 0.48;
                px = focus.x + (rx * cosT - ry * sinT);
                py = focus.y + (rx * sinT + ry * cosT);
            }
            return { x: px, y: py };
        });
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of pts) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
        const c = polyCentroid(pts);
        const dx = c.x - focus.x;
        const dy = c.y - focus.y;
        const len = Math.hypot(dx, dy) || 1;
        const shiftMag = idx === 0 ? 0 : (0.42 + (idx % 3) * 0.36);
        const isInvert = Boolean(rf.invert) && !invertUsed;
        if (isInvert) invertUsed = true;
        const useCover = !isInvert && idx > 0 && !coverUsed && (rf.tone === 2 || idx === 1);
        if (useCover) coverUsed = true;
        const lensDelta = idx === 0 ? 0 : (isInvert ? 0.042 : ((idx % 2 === 1 ? 1 : -1) * 0.026));

        return {
            points: pts,
            centroid: c,
            bbox: { minX, minY, maxX, maxY },
            tone: typeof rf.tone === 'number' ? rf.tone : (idx % 4),
            invert: isInvert,
            useCover,
            isBaseGround,
            shiftX: (dx / len) * shiftMag,
            shiftY: (dy / len) * shiftMag,
            enterDX: isBaseGround ? 0 : (dx / len) * 0.075 * A,
            enterDY: isBaseGround ? 0 : (dy / len) * 0.075,
            delayFraction: isBaseGround ? 0 : Math.min(0.26, (idx - 1) * 0.06),
            spanFraction: isBaseGround ? 0.35 : 0.42 + (idx % 3) * 0.08,
            lensDelta,
            phase: prismRange(s, idx + 70, 0, Math.PI * 2, 619),
            sheenAngle: prismRange(s, idx + 50, -65, 65, 607),
        };
    });

    // 提取切面棱边线段用于光谱色散描边（排除最外层出血框四条外边）
    const cutSegments = [];
    const eps = 1e-3;
    for (let i = 0; i < facets.length; i++) {
        if (facets[i].isBaseGround) continue;
        const pts = facets[i].points;
        for (let j = 0; j < pts.length; j++) {
            const p1 = pts[j];
            const p2 = pts[(j + 1) % pts.length];
            const onLeft = Math.abs(p1.x + pad) < eps && Math.abs(p2.x + pad) < eps;
            const onRight = Math.abs(p1.x - (A + pad)) < eps && Math.abs(p2.x - (A + pad)) < eps;
            const onTop = Math.abs(p1.y + pad) < eps && Math.abs(p2.y + pad) < eps;
            const onBottom = Math.abs(p1.y - (1 + pad)) < eps && Math.abs(p2.y - (1 + pad)) < eps;
            if (!onLeft && !onRight && !onTop && !onBottom) {
                cutSegments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, facetIndex: i });
            }
        }
    }

    // 牛顿分光束（入射白光顶点 + 折射彩虹扇角）与 3D 视差晶尘微粒
    const fromLeft = prismHash01(s, 101, 641) > 0.45;
    const rayApex = {
        x: focus.x + prismRange(s, 102, -A * 0.14, A * 0.14, 647),
        y: focus.y + prismRange(s, 103, -0.10, 0.10, 653),
    };
    const rayOrigin = {
        x: fromLeft ? -0.08 : A + 0.08,
        y: prismRange(s, 104, 0.08, 0.42, 659),
    };
    const rayBaseAngle = fromLeft
        ? prismRange(s, 105, -0.12, 0.34, 661)
        : prismRange(s, 105, Math.PI - 0.34, Math.PI + 0.12, 661);

    const dustMotes = [];
    for (let m = 0; m < 14; m++) {
        dustMotes.push({
            x: prismRange(s, m + 120, 0.06 * A, 0.94 * A, 673),
            y: prismRange(s, m + 140, 0.08, 0.92, 677),
            r: prismRange(s, m + 160, 1.4, 4.2, 683),
            depth: prismRange(s, m + 180, 0.35, 1.35, 691),
            phase: prismRange(s, m + 200, 0, Math.PI * 2, 701),
            hueIdx: m % 3,
        });
    }

    return {
        kind: PRISM_SHOT_KINDS.includes(kind) ? kind : 'diamond-aperture',
        family,
        isPartition,
        aspect: A,
        focus,
        facets,
        cutSegments,
        watermark: watermark || true,
        rayOrigin,
        rayApex,
        rayBaseAngle,
        dustMotes,
    };
}
