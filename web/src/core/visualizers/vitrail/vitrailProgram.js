/**
 * web/src/core/visualizers/vitrail/vitrailProgram.js
 * 「琉璃龛 · Vitrail」（mode: vitrail）—— 确定性 3D 歌词分镜与情绪语义编译器
 *
 * 零 DOM 依赖，纯函数，可在 Node 下独立测试 Seek 确定性与边界条件。
 */

import {
    VITRAIL_MOVEMENTS,
    VITRAIL_PALETTES,
    hashVitrailString,
    clamp,
    smootherstep01,
    lerpVitrailPalette,
} from './vitrailProfiles.js';
import { ensureEmotionContrast } from '../../../utils/colorUtils.js';

const INTERLUDE_GAP_MS = 4500;
const HEX6_RE = /^#[0-9a-f]{6}$/i;
const HAS_CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const LATIN_WORD_CHAR_RE = /^(?!.*[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af])[\p{L}\p{N}'\u2019]$/u;
const LATIN_BOUNDARY_CHAR_RE = /^(?!.*[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af])[\p{L}\p{N}]$/u;
const LATIN_ADJACENT_RE = /[A-Za-z0-9\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u1E00-\u1EFF]/;
const LATIN_TAIL_PUNCT_RE = /['\u2018\u2019"\u201C\u201D)}\u00BB]$/;

export function isVitrailInterludeText(text = '') {
    const t = String(text || '').trim();
    if (!t) return true;
    return /^(?:[♪♫♬♩…·•\-—~～\s]+|music|instrumental|interlude|间奏|纯音乐|伴奏)$/i.test(t);
}

/**
 * 将单行歌词标准化为逐字时间数组 { char, start, end, wordIndex }（单位 ms）
 */
export function normalizeVitrailLineGraphemes(line, nextLineTimeSec = 0) {
    const rawTime = Number(line?.time ?? line?.start ?? 0) || 0;
    const lineStartMs = Math.max(0, Math.round(rawTime > 1000 ? rawTime : rawTime * 1000));
    const rawNext = Number(nextLineTimeSec) || 0;
    const nextMs = rawNext > 1000 ? rawNext : rawNext * 1000;
    const rawEndMs = nextMs > lineStartMs ? Math.round(nextMs) : lineStartMs + 3600;
    const lineEndMs = Math.max(lineStartMs + 420, rawEndMs);
    const text = String(line?.original ?? line?.text ?? '').trim();

    if (Array.isArray(line?.words) && line.words.length > 0) {
        const out = [];
        let cursor = 0;
        for (let i = 0; i < line.words.length; i++) {
            const w = line.words[i];
            const wText = String(w?.word ?? w?.text ?? '');
            if (!wText) continue;
            const rawWStart = typeof w.start === 'number'
                ? w.start
                : (typeof w.startTime === 'number' ? w.startTime : lineStartMs / 1000);
            const start = Math.round(
                rawWStart < 600 && lineStartMs > 1000
                    ? rawWStart * 1000
                    : (rawWStart < 600 ? rawWStart * 1000 : rawWStart),
            );
            const rawWEnd = typeof w.end === 'number'
                ? w.end
                : (typeof w.endTime === 'number' ? w.endTime : 0);
            const dur = Math.round(
                typeof w.duration === 'number'
                    ? (w.duration < 30 ? w.duration * 1000 : w.duration)
                    : 260,
            );
            const end = Math.max(
                start + 80,
                rawWEnd > 0 ? Math.round(rawWEnd < 600 ? rawWEnd * 1000 : rawWEnd) : start + dur,
            );

            // 若整行原文在当前词前带空白，且 wText 与上个字未携带空白，精确按原文补回词间空格
            if (text && cursor < text.length) {
                let spaceSkipped = false;
                while (cursor < text.length && /\s/.test(text[cursor])) {
                    spaceSkipped = true;
                    cursor++;
                }
                if (spaceSkipped && out.length > 0 && !/\s/.test(out[out.length - 1].char) && !/\s/.test(wText[0])) {
                    const prevEnd = out[out.length - 1].end;
                    out.push({ char: ' ', start: prevEnd, end: Math.max(prevEnd, start), wordIndex: i });
                }
                const trimmed = wText.trim();
                const matchIdx = trimmed ? text.indexOf(trimmed, cursor) : -1;
                if (matchIdx === cursor) {
                    cursor += trimmed.length;
                } else {
                    cursor += Array.from(trimmed).length;
                }
            } else if (!text && out.length > 0) {
                const prevCh = out[out.length - 1].char;
                const firstCh = wText[0];
                const tailStr = out.slice(-2).map((g) => g.char).join('');
                const prevIsLatin = LATIN_ADJACENT_RE.test(prevCh) || LATIN_TAIL_PUNCT_RE.test(tailStr);
                if (!/\s/.test(prevCh) && !/\s/.test(firstCh) && prevIsLatin && LATIN_ADJACENT_RE.test(firstCh)) {
                    const prevEnd = out[out.length - 1].end;
                    out.push({ char: ' ', start: prevEnd, end: Math.max(prevEnd, start), wordIndex: i });
                }
            }

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

function cutsLatinWordAt(graphemes, idx) {
    return idx > 0
        && idx < graphemes.length
        && LATIN_WORD_CHAR_RE.test(graphemes[idx - 1].char)
        && LATIN_WORD_CHAR_RE.test(graphemes[idx].char);
}

/**
 * 将长行切分为紧凑短语分镜（不腰斩英文/拉丁单词，并保持行级偏移量供情感词匹配）
 */
export function chunkVitrailGraphemes(graphemes, maxNonSpace = 16) {
    if (!Array.isArray(graphemes) || graphemes.length === 0) return [];
    const nonSpace = graphemes.filter((g) => g.char.trim().length > 0).length;
    if (nonSpace <= maxNonSpace) return [graphemes];

    const targetChunks = nonSpace >= maxNonSpace * 2 ? 3 : 2;
    const chunks = [];
    let startIdx = 0;

    for (let c = 1; c < targetChunks; c++) {
        const ideal = Math.round((graphemes.length * c) / targetChunks);
        let splitAt = ideal;
        let snapped = false;
        let bestScore = Infinity;
        for (let d = 0; d <= 10; d++) {
            const candidates = d === 0 ? [ideal] : [ideal - d, ideal + d];
            for (const pos of candidates) {
                if (pos <= startIdx + 2 || pos >= graphemes.length - 2 || cutsLatinWordAt(graphemes, pos)) continue;
                const isSpace = graphemes[pos].char.trim() === '';
                const isPunct = /[,，。、;；!！?？]/.test(graphemes[pos - 1].char);
                if (!isSpace && !isPunct) continue;

                // 避免在行尾遗留孤立短冠词/介词（如 "Moonlight orbits a / ..." -> 拆成 "Moonlight orbits / a ..."）
                let tailPenalty = 0;
                if (isSpace) {
                    let k = pos - 1;
                    let w = '';
                    while (k >= startIdx && LATIN_WORD_CHAR_RE.test(graphemes[k].char)) {
                        w = graphemes[k].char + w;
                        k--;
                    }
                    if (/^(a|an|the|in|on|of|to|by|at|or|as|is|my|so|no|if|and|for|but)$/i.test(w)) {
                        tailPenalty = 5.5;
                    } else if (w.length > 0 && w.length <= 2) {
                        tailPenalty = 3.0;
                    }
                }
                const score = d + tailPenalty + (isPunct ? -1.5 : 0);
                if (score < bestScore) {
                    bestScore = score;
                    splitAt = pos;
                    snapped = true;
                }
            }
        }
        if (!snapped) {
            for (let d = 0; d < graphemes.length; d++) {
                const r = ideal + d;
                const l = ideal - d;
                if (r > startIdx + 2 && r < graphemes.length - 2 && !cutsLatinWordAt(graphemes, r)) {
                    splitAt = r;
                    break;
                }
                if (l > startIdx + 2 && l < graphemes.length - 2 && !cutsLatinWordAt(graphemes, l)) {
                    splitAt = l;
                    break;
                }
            }
        }
        if (splitAt > startIdx && splitAt < graphemes.length && !cutsLatinWordAt(graphemes, splitAt)) {
            const slice = graphemes.slice(startIdx, splitAt).filter((g, i, arr) => {
                if (i === 0 && g.char.trim() === '') return false;
                if (i === arr.length - 1 && g.char.trim() === '') return false;
                return true;
            });
            if (slice.length > 0) chunks.push(slice);
            startIdx = splitAt;
        }
    }

    const tail = graphemes.slice(startIdx).filter((g, i, arr) => {
        if (i === 0 && g.char.trim() === '') return false;
        if (i === arr.length - 1 && g.char.trim() === '') return false;
        return true;
    });
    if (tail.length > 0) chunks.push(tail);
    return chunks.length > 0 ? chunks : [graphemes];
}

function normalizeEmotionColor(color) {
    if (typeof color !== 'string') return null;
    const c = color.trim();
    if (HEX6_RE.test(c)) return c;
    if (/^#[0-9a-f]{8}$/i.test(c)) return c.slice(0, 7);
    if (/^#[0-9a-f]{3}$/i.test(c)) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
    if (/^rgba?\(/i.test(c) || /^hsla?\(/i.test(c)) return c;
    return null;
}

/**
 * 生成情感词指纹，用于在切歌或 AI 返回更新时自动失效缓存
 */
export function vitrailEmotionStamp(aiData = null) {
    const g = typeof globalThis !== 'undefined' ? globalThis : null;
    if (g && g.appSettings && g.appSettings.lyrics && g.appSettings.lyrics.emotionWords === false) return 'off';
    const raw = (g && Array.isArray(g.aiEmotionWords) && g.aiEmotionWords.length > 0)
        ? g.aiEmotionWords
        : (aiData?.emotion_words || aiData?.emotionWords || null);
    if (!raw) return 'none';
    if (Array.isArray(raw)) {
        return raw.map((it) => (typeof it === 'string' ? it : `${it?.word || it?.text || ''}:${it?.color || ''}`)).join('|');
    }
    if (typeof raw === 'object') {
        return Object.entries(raw).map(([k, v]) => `${k}:${v || ''}`).join('|');
    }
    return 'none';
}

export function extractVitrailEmotionEntries(aiData = null) {
    const g = typeof globalThis !== 'undefined' ? globalThis : null;
    if (g && g.appSettings && g.appSettings.lyrics && g.appSettings.lyrics.emotionWords === false) return [];

    const aiWordsCleared = Boolean(g && Array.isArray(g.aiEmotionWords) && g.aiEmotionWords.length === 0);
    const hasItems = (raw) => raw && typeof raw === 'object' && (Array.isArray(raw) ? raw.length > 0 : Object.keys(raw).length > 0);
    const aiRaw = (
        aiData && typeof aiData === 'object' && !(g && g.currentAiTheme && g.currentAiTheme === aiData && aiWordsCleared)
    )
        ? (hasItems(aiData.emotion_words) ? aiData.emotion_words : (hasItems(aiData.emotionWords) ? aiData.emotionWords : null))
        : null;
    const raw = (g && hasItems(g.aiEmotionWords)) ? g.aiEmotionWords : aiRaw;
    if (!raw) return [];

    const entries = [];
    if (Array.isArray(raw)) {
        for (const item of raw) {
            if (!item) continue;
            if (typeof item === 'string') {
                const w = item.trim();
                if (w) entries.push({ word: w, color: '#f0b650' });
            } else {
                const w = String(item.word || item.text || '').trim();
                const c = item.color === null || item.color === undefined || String(item.color).trim() === ''
                    ? '#f0b650'
                    : normalizeEmotionColor(item.color);
                if (w && c) entries.push({ word: w, color: c });
            }
        }
    } else if (typeof raw === 'object') {
        for (const [word, color] of Object.entries(raw)) {
            const w = String(word || '').trim();
            const c = color === null || color === undefined || String(color).trim() === ''
                ? '#f0b650'
                : normalizeEmotionColor(color);
            if (w && c) entries.push({ word: w, color: c });
        }
    }
    entries.sort((a, b) => b.word.length - a.word.length);
    return entries;
}

/**
 * 计算单段短语内每个字的 AI 情感词高亮色（兼容完整行跨句、不误伤英文子串、兼顾亮暗底座对比度）
 */
export function resolveShotEmotionColors(shot, aiData = null, palette = null) {
    const entries = extractVitrailEmotionEntries(aiData);
    const n = shot?.graphemes?.length || 0;
    const result = new Array(n).fill(null);
    if (!entries.length || n === 0) return result;

    const fullChars = Array.isArray(shot.lineGraphemes) && shot.lineGraphemes.length > 0
        ? shot.lineGraphemes.map((g) => g.char)
        : shot.graphemes.map((g) => g.char);
    const offset = Number.isInteger(shot.lineGraphemeOffset) && shot.lineGraphemeOffset >= 0
        ? shot.lineGraphemeOffset
        : 0;
    const fullStr = fullChars.join('');
    const fullLower = fullStr.toLowerCase();
    const bgRef = palette?.isLight ? '#ded5c3' : '#12151c';

    for (const entry of entries) {
        const w = entry.word;
        const wLen = Array.from(w).length;
        const wLower = w.toLowerCase();
        const isCjk = HAS_CJK_RE.test(w);
        let fromIdx = 0;
        while (fromIdx < fullLower.length) {
            const idx = fullLower.indexOf(wLower, fromIdx);
            if (idx < 0) break;
            if (!isCjk) {
                const prev = idx > 0 ? fullStr[idx - 1] : '';
                const next = idx + w.length < fullStr.length ? fullStr[idx + w.length] : '';
                if ((prev && LATIN_BOUNDARY_CHAR_RE.test(prev)) || (next && LATIN_BOUNDARY_CHAR_RE.test(next))) {
                    fromIdx = idx + 1;
                    continue;
                }
            }
            const charStart = Array.from(fullStr.slice(0, idx)).length;
            const charEnd = charStart + wLen;
            const calibrated = HEX6_RE.test(entry.color)
                ? ensureEmotionContrast(entry.color, bgRef, palette?.isLight ? 4.2 : 4.8)
                : entry.color;

            for (let k = charStart; k < charEnd; k++) {
                const localIdx = k - offset;
                if (localIdx >= 0 && localIdx < n && !result[localIdx]) {
                    result[localIdx] = calibrated;
                }
            }
            fromIdx = idx + Math.max(1, w.length);
        }
    }
    return result;
}

/**
 * 将短语字数组按 3D 圣殿阅读带宽智能折行为 1..3 行（严格按词边界折行，防止单行溢出屏幕）
 */
export function wrapVitrailShotLines(graphemes = [], emotionColors = [], maxUnitsPerRow = 12.5) {
    if (!Array.isArray(graphemes) || graphemes.length === 0) return [];
    const charUnits = (ch) => {
        if (!ch || ch.trim() === '') return 0.42;
        if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) return 1.0;
        if (/[A-ZMW@]/.test(ch)) return 0.72;
        if (/[ilI1.,:;'!]/.test(ch)) return 0.36;
        return 0.56;
    };

    const totalUnits = graphemes.reduce((acc, g) => acc + charUnits(g.char), 0);
    if (totalUnits <= maxUnitsPerRow) {
        return [{
            items: graphemes.map((g, i) => ({ ...g, emotionColor: emotionColors[i] || null })),
            units: totalUnits,
        }];
    }

    const rowCount = Math.min(3, Math.max(2, Math.ceil(totalUnits / maxUnitsPerRow)));
    const targetPerRow = totalUnits / rowCount;
    const rows = [];
    let cur = [];
    let curUnits = 0;

    for (let i = 0; i < graphemes.length; i++) {
        const g = graphemes[i];
        const u = charUnits(g.char);
        const item = { ...g, emotionColor: emotionColors[i] || null };

        if (cur.length > 0 && rows.length < rowCount - 1) {
            const canBreakClean = g.char.trim() === '' || !cutsLatinWordAt(graphemes, i);
            if (canBreakClean && curUnits >= targetPerRow * 0.88) {
                rows.push({ items: trimSpaces(cur), units: curUnits });
                cur = g.char.trim() === '' ? [] : [item];
                curUnits = g.char.trim() === '' ? 0 : u;
                continue;
            }
        }
        cur.push(item);
        curUnits += u;
    }
    if (cur.length > 0) {
        const trimmed = trimSpaces(cur);
        if (trimmed.length > 0) {
            rows.push({
                items: trimmed,
                units: trimmed.reduce((acc, it) => acc + charUnits(it.char), 0),
            });
        }
    }
    return rows;
}

function trimSpaces(items) {
    let start = 0;
    let end = items.length;
    while (start < end && items[start].char.trim() === '') start++;
    while (end > start && items[end - 1].char.trim() === '') end--;
    return items.slice(start, end);
}

/**
 * 编译全曲确定性 3D 分镜表（Seek 完全幂等）
 */
export function compileVitrailProgram({
    lines = [],
    songProfile = null,
    songData = {},
} = {}) {
    const valid = Array.isArray(lines) ? lines : [];
    const shots = [];
    const chorusFlags = [];

    // 尝试通过歌词重复性或自带标记识别高潮句，避免高潮判断缺席
    const textFreq = new Map();
    for (const l of valid) {
        const t = String(l?.original ?? l?.text ?? '').trim().toLowerCase();
        if (t && t.length > 3 && !isVitrailInterludeText(t)) {
            textFreq.set(t, (textFreq.get(t) || 0) + 1);
        }
    }

    const baseSeed = songProfile?.seed || hashVitrailString(songData?.title || 'vitrail');

    for (let i = 0; i < valid.length; i++) {
        const line = valid[i];
        const nextLine = valid[i + 1];
        const nextTimeSec = nextLine ? (nextLine.time ?? nextLine.start ?? 0) : 0;
        const text = String(line?.original ?? line?.text ?? '').trim();

        if (!text || isVitrailInterludeText(text)) {
            const rawStart = Number(line?.time ?? line?.start ?? 0) || 0;
            const startMs = Math.max(0, Math.round(rawStart > 1000 ? rawStart : rawStart * 1000));
            const rawNext = Number(nextTimeSec) || 0;
            const nextMs = rawNext > 1000 ? rawNext : rawNext * 1000;
            const endMs = nextMs > startMs ? nextMs : startMs + 5000;
            shots.push({
                index: shots.length,
                kind: 'interlude',
                lineIndex: i,
                startSec: startMs / 1000,
                endSec: endMs / 1000,
                text: songData?.title ? `${songData.title}` : 'Interlude',
                subLabel: 'INSTRUMENTAL · 间奏',
                translation: '',
                romaji: '',
                movement: 'horizon',
                isChorus: false,
                songSeed: baseSeed,
                seed: (baseSeed + shots.length * 131) >>> 0,
                graphemes: [],
                lineGraphemes: [],
                lineGraphemeOffset: 0,
            });
            continue;
        }

        const lineGraphemes = normalizeVitrailLineGraphemes(line, nextTimeSec);
        const lineStartMs = lineGraphemes[0]?.start ?? 0;
        const rawEndMs = lineGraphemes[lineGraphemes.length - 1]?.end ?? (lineStartMs + 3200);
        const rawNext = Number(nextTimeSec) || 0;
        const nextMs = rawNext > 1000 ? rawNext : rawNext * 1000;
        const isChorus = Boolean(line?.isChorus || line?.chorus || (textFreq.get(text.toLowerCase()) || 0) >= 2);
        chorusFlags.push(isChorus);

        const chunks = chunkVitrailGraphemes(lineGraphemes, 17);
        // 将同一句拆分的短语锁定在同一连贯运镜段落中，并按两句一幕温和推进主旋律机位
        const mIdx = isChorus
            ? ((i + (baseSeed & 1)) % 3 === 0 ? 2 : 3)
            : ((Math.floor(i / 2) + (baseSeed & 3)) % VITRAIL_MOVEMENTS.length);

        for (let c = 0; c < chunks.length; c++) {
            const ch = chunks[c];
            const exactOffset = lineGraphemes.indexOf(ch[0]);
            const chStart = ch[0]?.start ?? lineStartMs;
            const chEnd = c < chunks.length - 1
                ? (chunks[c + 1][0]?.start ?? ch[ch.length - 1].end)
                : Math.max(ch[ch.length - 1]?.end ?? rawEndMs, nextMs > lineStartMs && (nextMs - (ch[ch.length - 1]?.end ?? rawEndMs)) < INTERLUDE_GAP_MS ? nextMs : (ch[ch.length - 1]?.end ?? rawEndMs) + 300);

            const shotIndex = shots.length;
            shots.push({
                index: shotIndex,
                kind: 'lyric',
                lineIndex: i,
                chunkIndex: c,
                totalChunks: chunks.length,
                startSec: chStart / 1000,
                endSec: Math.max(chStart / 1000 + 0.35, chEnd / 1000),
                text: ch.map((g) => g.char).join(''),
                translation: String(line?.translation || '').trim(),
                romaji: String(line?.romaji || '').trim(),
                movement: VITRAIL_MOVEMENTS[mIdx],
                isChorus,
                songSeed: baseSeed,
                seed: (baseSeed + shotIndex * 2654435761) >>> 0,
                graphemes: ch,
                lineGraphemes,
                lineGraphemeOffset: exactOffset >= 0 ? exactOffset : 0,
            });
        }

        // 若与下一句间隔超过 4.5s，自动插入静谧建筑间奏镜头
        const tailEndMs = shots[shots.length - 1].endSec * 1000;
        if (nextMs > tailEndMs + INTERLUDE_GAP_MS) {
            shots.push({
                index: shots.length,
                kind: 'interlude',
                lineIndex: i,
                startSec: tailEndMs / 1000,
                endSec: nextMs / 1000,
                text: songData?.title || 'Interlude',
                subLabel: 'SANCTUARY INTERLUDE · 间奏巡礼',
                translation: '',
                romaji: '',
                movement: 'horizon',
                isChorus: false,
                songSeed: baseSeed,
                seed: (baseSeed + shots.length * 997) >>> 0,
                graphemes: [],
                lineGraphemes: [],
                lineGraphemeOffset: 0,
            });
        }
    }

    // 结尾碑铭镜（Colophon）
    if (shots.length > 0) {
        const last = shots[shots.length - 1];
        shots.push({
            index: shots.length,
            kind: 'colophon',
            lineIndex: valid.length - 1,
            startSec: last.endSec + 1.2,
            endSec: last.endSec + 18.0,
            text: songData?.title || 'ARIA',
            subLabel: [songData?.artist, songData?.album].filter(Boolean).join(' — ') || 'FINALE',
            translation: '',
            romaji: '',
            movement: 'sanctuary',
            isChorus: false,
            songSeed: baseSeed,
            seed: (baseSeed + 77777) >>> 0,
            graphemes: [],
            lineGraphemes: [],
            lineGraphemeOffset: 0,
        });
    }

    const scenes = buildVitrailSceneChapters(shots, songProfile);

    return {
        shots,
        scenes,
        archetype: songProfile?.archetype || 'cathedral',
        songTitle: String(songData?.title || ''),
        songArtist: String(songData?.artist || ''),
    };
}

/**
 * 在整首歌时间轴上划分宏大建筑篇章（优先对齐副歌与间奏节点，避免高频闪切）
 */
function buildVitrailSceneChapters(shots, songProfile) {
    const fallbackArch = songProfile?.archetype || 'cathedral';
    const fallbackPalKey = songProfile?.palette?.key || 'amber';
    const rawSuite = (Array.isArray(songProfile?.suite) && songProfile.suite.length > 0)
        ? songProfile.suite
        : [{ archetype: fallbackArch, paletteKey: fallbackPalKey }];

    if (!Array.isArray(shots) || shots.length === 0) {
        return [{
            index: 0,
            startSec: 0,
            endSec: 60,
            archetype: rawSuite[0].archetype,
            paletteKey: rawSuite[0].paletteKey,
            firstShotIndex: 0,
            lastShotIndex: 0,
        }];
    }

    const endContentIdx = shots[shots.length - 1].kind === 'colophon'
        ? Math.max(0, shots.length - 2)
        : shots.length - 1;
    const firstStart = shots[0].startSec;
    const lastEnd = shots[endContentIdx].endSec;
    const totalSpan = Math.max(1, lastEnd - firstStart);

    let targetChapters = 1;
    if (rawSuite.length > 1 && shots.length >= 6) {
        if (totalSpan >= 120) targetChapters = Math.min(rawSuite.length, 4);
        else if (totalSpan >= 42) targetChapters = Math.min(rawSuite.length, 3);
        else targetChapters = Math.min(rawSuite.length, 2);
    }

    const cutIndices = [];
    if (targetChapters > 1) {
        const minChapterSpan = totalSpan >= 42 ? 16 : 6;
        const windowRadius = Math.max(8, totalSpan * 0.16);
        let lastCut = 0;
        let prevCutTime = firstStart;

        for (let c = 1; c < targetChapters; c++) {
            const idealTime = firstStart + (totalSpan * c) / targetChapters;
            let bestIdx = -1;
            let bestScore = -Infinity;

            for (let j = lastCut + 2; j <= endContentIdx - 2; j++) {
                const s = shots[j];
                if (s.startSec - prevCutTime < minChapterSpan) continue;
                if (lastEnd - s.startSec < Math.min(minChapterSpan * 0.7, 6)) continue;

                let score = -Math.abs(s.startSec - idealTime) * 0.18;
                if (Math.abs(s.startSec - idealTime) <= windowRadius) score += 2.0;
                if (s.kind === 'interlude') score += 3.5;
                else if (shots[j - 1]?.kind === 'interlude') score += 4.0;
                else if (s.isChorus && !shots[j - 1]?.isChorus && (s.chunkIndex || 0) === 0) score += 3.2;
                else if ((s.chunkIndex || 0) === 0) score += 1.2;
                else score -= 8.0;

                if (score > bestScore) {
                    bestScore = score;
                    bestIdx = j;
                }
            }

            if (bestIdx > lastCut + 1) {
                cutIndices.push(bestIdx);
                lastCut = bestIdx;
                prevCutTime = shots[bestIdx].startSec;
            }
        }
    }

    const totalChapters = cutIndices.length + 1;
    const scenes = [];
    for (let k = 0; k < totalChapters; k++) {
        const firstShotIndex = k === 0 ? 0 : cutIndices[k - 1];
        const lastShotIndex = k < cutIndices.length ? cutIndices[k] - 1 : shots.length - 1;
        const suiteEntry = rawSuite[k % rawSuite.length] || rawSuite[0];
        const startSec = k === 0 ? 0 : shots[firstShotIndex].startSec;
        const endSec = k < cutIndices.length
            ? shots[cutIndices[k]].startSec
            : shots[shots.length - 1].endSec + 120;
        const scene = {
            index: k,
            startSec,
            endSec,
            archetype: suiteEntry.archetype || fallbackArch,
            paletteKey: suiteEntry.paletteKey || fallbackPalKey,
            firstShotIndex,
            lastShotIndex,
        };
        scenes.push(scene);
        for (let i = firstShotIndex; i <= lastShotIndex; i++) {
            shots[i].sceneChapterIndex = k;
            shots[i].sceneArchetype = scene.archetype;
            shots[i].paletteKey = scene.paletteKey;
        }
    }

    return scenes;
}

/**
 * 确定性计算当前播放时间点所属的建筑场景、调色板及双场景无缝溶解进度 [0, 1]
 */
export function resolveVitrailSceneAtTime(
    program,
    timeSec = 0,
    songProfile = null,
    {
        archOverride = 'auto',
        presetOverride = 'auto',
        crossfadeSec = 2.4,
    } = {},
) {
    const presetForced = (presetOverride && presetOverride !== 'auto' && VITRAIL_PALETTES[presetOverride])
        ? presetOverride
        : null;
    const fallbackPal = VITRAIL_PALETTES[presetForced]
        || songProfile?.palette
        || VITRAIL_PALETTES.amber;
    const fallbackArch = (archOverride && archOverride !== 'auto')
        ? archOverride
        : (program?.archetype || songProfile?.archetype || 'cathedral');

    if (archOverride && archOverride !== 'auto') {
        return {
            chapterIndex: 0,
            fromArch: fallbackArch,
            toArch: fallbackArch,
            currentArch: fallbackArch,
            sceneMix: 1,
            inTransition: false,
            palA: fallbackPal,
            palB: fallbackPal,
            palette: fallbackPal,
        };
    }

    const scenes = program?.scenes;
    if (!Array.isArray(scenes) || scenes.length <= 1) {
        const s0 = Array.isArray(scenes) && scenes.length === 1 ? scenes[0] : null;
        const arch = s0?.archetype || fallbackArch;
        const palKey = presetForced || s0?.paletteKey || fallbackPal.key;
        const pal = VITRAIL_PALETTES[palKey] || fallbackPal;
        return {
            chapterIndex: 0,
            fromArch: arch,
            toArch: arch,
            currentArch: arch,
            sceneMix: 1,
            inTransition: false,
            palA: pal,
            palB: pal,
            palette: pal,
        };
    }

    const t = Math.max(0, Number(timeSec) || 0);
    const fadeDur = Math.max(0.4, Number(crossfadeSec) || 2.4);

    // 优先检查是否处于相邻篇章的平滑溶解窗口（提前 35% 渗入雾光，后 65% 完成显影）
    for (let i = 1; i < scenes.length; i++) {
        const prevScene = scenes[i - 1];
        const nextScene = scenes[i];
        const prevSpan = Math.max(0.5, nextScene.startSec - prevScene.startSec);
        const nextSpan = Math.max(0.5, nextScene.endSec - nextScene.startSec);
        const preWin = Math.min(fadeDur * 0.35, prevSpan * 0.25);
        const postWin = Math.min(fadeDur * 0.65, nextSpan * 0.45);
        const winStart = nextScene.startSec - preWin;
        const winEnd = nextScene.startSec + postWin;

        if (t >= winStart && t < winEnd) {
            const mix = smootherstep01((t - winStart) / Math.max(0.2, winEnd - winStart));
            const palA = VITRAIL_PALETTES[presetForced || prevScene.paletteKey] || fallbackPal;
            const palB = VITRAIL_PALETTES[presetForced || nextScene.paletteKey] || fallbackPal;
            return {
                chapterIndex: i,
                fromArch: prevScene.archetype,
                toArch: nextScene.archetype,
                currentArch: mix >= 0.5 ? nextScene.archetype : prevScene.archetype,
                sceneMix: mix,
                inTransition: true,
                palA,
                palB,
                palette: lerpVitrailPalette(palA, palB, mix),
            };
        }
    }

    // 处于单一稳定篇章内部
    let activeIdx = 0;
    for (let i = 1; i < scenes.length; i++) {
        if (t >= scenes[i].startSec) activeIdx = i;
        else break;
    }
    const active = scenes[activeIdx];
    const pal = VITRAIL_PALETTES[presetForced || active.paletteKey] || fallbackPal;
    return {
        chapterIndex: activeIdx,
        fromArch: active.archetype,
        toArch: active.archetype,
        currentArch: active.archetype,
        sceneMix: 1,
        inTransition: false,
        palA: pal,
        palB: pal,
        palette: pal,
    };
}

/**
 * O(log N) Seek 安全查找当前时间落入的分镜与前/后邻接镜
 */
export function findActiveVitrailShot(program, timeSec = 0) {
    const shots = program?.shots;
    if (!Array.isArray(shots) || shots.length === 0) {
        return { shot: null, prevShot: null, nextShot: null, nextNextShot: null, progress: 0 };
    }
    const t = Math.max(0, Number(timeSec) || 0);
    if (t < shots[0].startSec) {
        return {
            shot: shots[0],
            prevShot: null,
            nextShot: shots[1] || null,
            nextNextShot: shots[2] || null,
            progress: 0,
            isPreIntro: true,
        };
    }

    let lo = 0;
    let hi = shots.length - 1;
    let best = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (shots[mid].startSec <= t) {
            best = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    const shot = shots[best];
    const prevShot = shots[best - 1] || null;
    const nextShot = shots[best + 1] || null;
    const nextNextShot = shots[best + 2] || null;
    const dur = Math.max(0.25, shot.endSec - shot.startSec);
    const progress = clamp((t - shot.startSec) / dur, 0, 1);
    return { shot, prevShot, nextShot, nextNextShot, progress, isPreIntro: false };
}
