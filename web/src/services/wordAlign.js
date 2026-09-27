/* ============================================================
 * services/wordAlign.js — 频谱逐字对齐编排（解码 / 缓存 / 回填）
 *
 * 把只有行级时间戳的歌词对齐成真实逐字。分工：
 *   core/wordAligner.js  —— 纯算法（包络 + DP），可在 Node 单测；
 *   本文件               —— WebAudio 解码、IndexedDB 缓存、把结果贴回歌词数组。
 *
 * 为什么放在前端做：后端有「Python 纯标准库」硬约束（PyInstaller 绿色包，用户机器
 * 没有 Python/Node），而 stable-whisper 那类强制对齐要拖 torch + 模型（GB 级）。
 * WebAudio 已能解本工程实际用到的 FLAC（core/chorusDetector.js 早就在这么干）。
 * 代价是只能定位能量起始、认不出音素，精度低于强制对齐。
 *
 * 缓存键必须同时含「歌曲身份」和「歌词签名」：
 *   · 播放直链是短时签名的（QQ 的 vkey 几分钟失效），不能当键；
 *   · 同一首歌换歌词源（170-switchLyricSource）时文本可能一样、行级时间戳不一样，
 *     只按歌曲键会把上一份歌词的对齐结果贴到这一份上。
 * ============================================================ */

import { buildOnsetEnvelope, alignLine, maxDeviationFromEvenSplit } from '../core/wordAligner.js';
import { tokenizeForKaraoke, isSyntheticWordLine, hasRealWordTiming, SYNTHESIZED } from '../parsers/wordTiming.js';
import { songKeyOf } from './lyricIndex.js';
import { wordTimingCacheGet, wordTimingCacheSet } from './aiCache.js';
import { logInfo, logCatch } from './log.js';

/* 解码上限：超长音频（现场版/白噪音助眠）不值得为对齐整段拉进内存 */
const MAX_DECODE_SEC = 20 * 60;
/* 降采样目标：包络只要 16k 就够，省一半以上内存 */
const TARGET_SR = 16000;
/* 每处理这么多行让出一帧，避免长时间占住主线程把界面卡住 */
const YIELD_EVERY_LINES = 6;

const nextTick = () => new Promise(r => setTimeout(r, 0));

/** FNV-1a 32 位；只要稳定、快，不需要密码学强度 */
function hash32(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h >>> 0).toString(36);
}

/**
 * 歌词签名：文本 + 行级时间戳一起进哈希。
 * 时间戳必须参与——换源后文本相同但行起点不同，对齐结果也就不同。
 */
export function lyricSignature(lines) {
    if (!Array.isArray(lines) || !lines.length) return 'empty';
    const acc = lines.map(l => `${Math.round(Number(l.start) || 0)}|${String(l.text != null ? l.text : (l.original || ''))}`).join('\u0001');
    return `${lines.length}:${hash32(acc)}`;
}

/** 缓存键 = 歌曲身份 + 歌词签名 */
export function wordAlignKey(song, lines) {
    let base = 'unknown';
    try { base = songKeyOf(song || {}) || 'unknown'; } catch (e) { logCatch('wordAlign', e); }
    return `${base}#${lyricSignature(lines)}`;
}

/** 有没有需要对齐的行（即存在被摊平出来的合成逐字） */
export function needsAlign(lines) {
    return Array.isArray(lines) && lines.some(l => isSyntheticWordLine(l));
}

/**
 * 把逐行对齐结果贴回歌词。
 *
 * ★ 一律**保留** wordTiming=synthesized 标记。原因实测过：拿本地那首有真逐字的歌对拍，
 *   频谱对齐相对真值的平均误差 547ms、±100ms 命中仅 36%，只比均分基线好 11%——
 *   它是「更聪明的猜测」，不是真实节拍。若清掉标记，realWordsOf 会认它是真货，
 *   于是 547ms 级的误差被写进用户下载的 .lrc、并被当成节奏喂给 AI 打 ★/◆ 权重
 *   （AGENTS 约束 17 的护栏正是为了挡这件事）。
 *   渲染侧不受影响：buildWordsInto 只看 words 存不存在，照样逐字动。
 * @param {Array<Object>} lines
 * @param {Array<Array<{text,start,end}>|null>} wordsByLine 与 lines 等长，null 表示该行没结果
 * @returns {Array<Object>} 新数组，不改入参
 */
export function applyAlignment(lines, wordsByLine) {
    if (!Array.isArray(lines)) return lines;
    return lines.map((line, i) => {
        const words = wordsByLine && wordsByLine[i];
        if (!Array.isArray(words) || !words.length) return line;
        const tokens = tokenizeForKaraoke(String(line.text != null ? line.text : (line.original || '')));
        const dev = maxDeviationFromEvenSplit(words, tokens, Number(line.start) || 0, Number(line.end) || 0);
        /* 标记仍是 synthesized；dev 只作为诊断量随行带出，便于以后换更好的对齐器时比较 */
        return Object.assign({}, line, { words, wordTiming: SYNTHESIZED, wordAlignDeviationMs: dev });
    });
}

/**
 * 箱式平均降采样（等效一个廉价低通）。
 *
 * ★ 不能用点采样 `src[floor(i*ratio)]`：包络走的是预加重（一阶差分），能量集中在高频，
 *   而 44.1k→16k 的点采样会把 6k/10k+ 的分量混叠到语音频段去，实测把真词起点处的
 *   包络提升从 49% 打到 6.8%——等于把对齐信号自己抹掉了。
 * @param {Float32Array} src
 * @param {number} ratio 原采样率 / 目标采样率
 * @returns {Float32Array}
 */
export function decimateBox(src, ratio) {
    if (!src || !src.length || !(ratio > 0)) return new Float32Array(0);
    if (ratio <= 1) return src;
    const n = Math.floor(src.length / ratio);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const a = Math.floor(i * ratio);
        const b = Math.max(a + 1, Math.floor((i + 1) * ratio));
        let acc = 0, cnt = 0;
        for (let j = a; j < b && j < src.length; j++) { acc += src[j]; cnt++; }
        out[i] = cnt ? acc / cnt : 0;
    }
    return out;
}

/**
 * 解码音频并生成 onset 包络。
 * @param {string} audioUrl 同源地址（在线播放走 /api/audio/stream 代理，本地走静态服务）
 * @param {{isStale?: () => boolean, onProgress?: (p:number)=>void}} [opts]
 * @returns {Promise<{values:Float32Array,hopMs:number}|null>} 失败/被作废返回 null
 */
export async function decodeOnsetEnvelope(audioUrl, opts = {}) {
    if (!audioUrl || typeof fetch !== 'function') return null;
    if (typeof window === 'undefined' || !window.AudioContext && !window.webkitAudioContext) return null;
    const isStale = typeof opts.isStale === 'function' ? opts.isStale : () => false;
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let ctx = null;
    try {
        const resp = await fetch(audioUrl, ctl ? { signal: ctl.signal } : undefined);
        if (!resp.ok) { logInfo('wordAlign', `音频取回失败 ${resp.status}`); return null; }
        const buf = await resp.arrayBuffer();
        if (isStale()) return null;
        const AC = window.AudioContext || window.webkitAudioContext;
        ctx = new AC();
        const decoded = await ctx.decodeAudioData(buf);
        const sr = decoded.sampleRate;
        const ch = decoded.getChannelData(0);
        /* 先按时长上限截断（现场版/助眠白噪音不值得整段拉进内存），再降采样 */
        const srcLen = Math.min(ch.length, Math.floor(Math.min(decoded.duration, MAX_DECODE_SEC) * sr));
        let src = ch.subarray(0, srcLen);
        if (sr > TARGET_SR * 1.2) src = decimateBox(src, sr / TARGET_SR);
        const env = buildOnsetEnvelope(src, Math.min(sr, TARGET_SR));
        if (typeof opts.onProgress === 'function') opts.onProgress(1);
        return env;
    } catch (e) {
        logCatch('wordAlign', e);
        return null;
    } finally {
        if (ctx && typeof ctx.close === 'function') { try { await ctx.close(); } catch (e) { logCatch('wordAlign', e); } }
    }
}

/**
 * 对整份歌词逐行对齐（纯计算，不碰网络）。
 * 每若干行让出一帧，避免几分钟的歌把主线程占死。
 */
export async function alignAllLines(lines, envelope, opts = {}) {
    const isStale = typeof opts.isStale === 'function' ? opts.isStale : () => false;
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        if (isStale()) return null;
        const line = lines[i];
        const start = Number(line.start) || 0;
        const end = Number(line.end) || 0;
        const text = String(line.text != null ? line.text : (line.original || ''));
        if (!text.trim() || end <= start) { out.push(null); continue; }
        const tokens = tokenizeForKaraoke(text);
        if (!tokens.length) { out.push(null); continue; }
        let words = null;
        try { words = alignLine({ tokens, envelope, lineStartMs: start, lineEndMs: end }); } catch (e) { logCatch('wordAlign', e); }
        out.push(words && words.length === tokens.length ? words : null);
        if (i % YIELD_EVERY_LINES === YIELD_EVERY_LINES - 1) await nextTick();
    }
    return out;
}

/**
 * 主入口：拿缓存或现算一份逐字对齐结果，回填进歌词。
 * @param {Object} p
 * @param {Array<Object>} p.lines 已经过 ensureWordTiming 的歌词（合成行带 SYNTHESIZED 标记）
 * @param {string} p.audioUrl
 * @param {Object} [p.song] 用于缓存键（currentSongData 形状）
 * @param {() => boolean} [p.isStale] 切歌/换源后作废本次结果
 * @returns {Promise<{lines: Array<Object>, fromCache: boolean, aligned: number}|null>}
 */
export async function alignLyrics({ lines, audioUrl, song, isStale }) {
    if (!needsAlign(lines)) return null;
    if (hasRealWordTiming(lines) && !needsAlign(lines)) return null;
    const key = wordAlignKey(song, lines);

    const cached = await wordTimingCacheGet(key);
    if (cached && Array.isArray(cached.wordsByLine)) {
        if (typeof isStale === 'function' && isStale()) return null;
        return { lines: applyAlignment(lines, cached.wordsByLine), fromCache: true, aligned: cached.wordsByLine.filter(Boolean).length };
    }

    const envelope = await decodeOnsetEnvelope(audioUrl, { isStale });
    if (!envelope || !envelope.values.length) return null;
    if (typeof isStale === 'function' && isStale()) return null;

    const wordsByLine = await alignAllLines(lines, envelope, { isStale });
    if (!wordsByLine) return null;

    /* 只缓存有意义的结果：整份都没给出信息时不写，省得把退化结果钉死在缓存里 */
    const useful = wordsByLine.filter(Boolean).length;
    if (useful > 0) await wordTimingCacheSet(key, { wordsByLine, useful, hopMs: envelope.hopMs });
    return { lines: applyAlignment(lines, wordsByLine), fromCache: false, aligned: useful };
}
