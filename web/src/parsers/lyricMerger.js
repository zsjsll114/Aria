import { parseYrc, parseNeteaseYrc } from './yrcParser.js';
import { parseLrc, cleanQQMusicMetadata } from './lrcParser.js';
import { parseRoma } from './romaParser.js';
import { parseKrc } from '../services/krcParser.js';


/* ==================== 歌词行有效性守卫（v1） ====================
 * 真实事故：中文歌配上了"另一首中文歌"的翻译轨（源站把同语言歌词当翻译下发），
 * 且正轨里混着「出品：昌禾文化」「[该版本已获词曲正式授权]」这类制作信息行。
 * 两道守卫在 mergeLyrics 里生效，所有视觉模式与桌面歌词共用。 */
const KANA_RE = /[\u3040-\u30ff\u31f0-\u31ff]/;   /* 日文假名（有假名 = 日文行） */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

function cjkRatio(text) {
    const t = String(text || '').replace(/\s+/g, '');
    if (!t.length) return 0;
    let cjk = 0;
    for (const ch of t) if (CJK_RE.test(ch)) cjk += 1;
    return cjk / t.length;
}

/* 中文主导行：含较多汉字且无假名。日文歌（含假名）不在此列，日→中翻译不受影响 */
function isChineseLine(text) {
    const t = String(text || '');
    return !KANA_RE.test(t) && cjkRatio(t) > 0.55;
}

/* 制作信息/版权行：字段冒号开头（出品：xx / 作词：xx）、方括号授权声明、
   整句版权套话。保守匹配，宁可漏掉也不误伤正常歌词。 */
function isJunkCreditLine(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (/^[[(【]/.test(t) && /(授权|版权|著作权|许可)/.test(t)) return true;
    if (/^(出品|制作|制作人|监制|作词|作曲|编曲|填词|谱曲|混音|母带|录音|发行|和声|配唱|吉他|贝斯|鼓|键盘|弦乐|统筹|文案|翻译|OP|SP)\s*[:：]/.test(t)) return true;
    if (t.length < 40 && /(未经[^。]{0,12}授权|不得转发|保留所有权利|版权所有)/.test(t)) return true;
    return false;
}

export function mergeLyrics(originals, translations = [], romaji = []) {
    const merged = [];
    const hasTranslations = translations && translations.length > 0;
    const hasRomaji = romaji && romaji.length > 0;

    /* ★ 单调 1:1 对齐（替代旧"每行找 3s 内最近"）：
       旧算法的缺陷——没有翻译的行会捡到**下一行**的翻译（距离 <3s 就配），
       表现为"这句本来没有翻译，却显示后面几句的译文"。
       新算法：按时间序遍历翻译轨，每条翻译只分配给与它最接近、且尚未配对的那一行
       （行差 ≤3s 才配，配过即推进指针）。原行与翻译轨各自保序，一一对应。 */
    function monotonicAlign(rows, tracks, rowTime, trackTime, maxDiff = 3000) {
        const map = new Map();
        if (!rows.length || !tracks.length) return map;
        const T = tracks.slice().sort((a, b) => (trackTime(a) || 0) - (trackTime(b) || 0));
        const R = rows.slice().sort((a, b) => (rowTime(a) || 0) - (rowTime(b) || 0));
        let ri = 0;
        for (const t of T) {
            const tt = trackTime(t) || 0;
            let best = -1, bestDiff = Infinity;
            for (let j = ri; j < R.length; j++) {
                const rt = rowTime(R[j]) || 0;
                if (rt > tt + maxDiff) break;           // 行已晚于翻译窗口，后面更远
                const d = Math.abs(rt - tt);
                if (d < bestDiff) { bestDiff = d; best = j; }
            }
            if (best >= 0 && bestDiff <= maxDiff) {
                map.set(R[best], t);
                ri = best + 1;                          // 该行已消费，指针只前进
            }
        }
        return map;
    }

    const transMap = hasTranslations
        ? monotonicAlign(originals, translations, o => o.start, t => t.time)
        : new Map();
    const romaMap = hasRomaji
        ? monotonicAlign(originals, romaji, o => o.start, r => r.start)
        : new Map();
    for (const original of originals) {
        const origText = String(original.original || original.text || '').trim();
        /* 守卫 1：制作信息/版权行不进歌词（它们的"翻译"通常是另一首歌的词） */
        if (isJunkCreditLine(origText)) continue;
        const mergedLine = { ...original, translation: "", romaji: "", romajiWords: [] };
        if (hasTranslations && transMap.has(original)) {
            mergedLine.translation = transMap.get(original).text || '';
        }
        /* 守卫 2：同文字系统翻译无效——中文原行配中文"翻译" = 源站错发（往往是另一首歌），
           直接丢弃该行翻译。日文行（含假名）配中文翻译是正常日→中，不受影响。 */
        if (mergedLine.translation) {
            const tText = String(mergedLine.translation).trim();
            if (!tText ||
                tText === origText ||
                isJunkCreditLine(tText) ||
                (isChineseLine(origText) && isChineseLine(tText))) {
                mergedLine.translation = "";
            }
        }
        if (hasRomaji && romaMap.has(original)) {
            const romaLine = romaMap.get(original);
            mergedLine.romajiWords = (romaLine && romaLine.words) || [];
            mergedLine.romaji = (romaLine && romaLine.original) || "";
        }
        merged.push(mergedLine);
    }
    return merged;
}

export function detectAndParseLyrics(data) {
    if (!data) return { format: 'empty', originals: [], translations: [], romaji: [] };

    /* 兼容直接传入纯文本字符串 */
    if (typeof data === 'string') {
        const text = data.trim();
        if (text.startsWith('[') && text.includes(',')) {
            data = { yrc: text };
        } else {
            data = { lrc: text };
        }
    }

    // 酷狗 KRC 已预先解析列表直通
    if (data.parsedList && Array.isArray(data.parsedList) && data.parsedList.length > 0) {
        return {
            format: 'kugou_krc',
            originals: data.parsedList,
            translations: data.translations || [],
            romaji: data.romaji || []
        };
    }

    // 酷狗原始 KRC 文本解析
    if (data.krc && typeof data.krc === 'string' && data.krc.trim()) {
        const krcParsed = parseKrc(data.krc);
        if (krcParsed && krcParsed.length > 0) {
            return {
                format: 'kugou_krc',
                originals: krcParsed,
                translations: [],
                romaji: []
            };
        }
    }

    let format = 'unknown';
    let originals = [];
    let translations = [];
    let romaji = [];
    const yrcTrim = data.yrc ? data.yrc.trim() : '';
    const isYrc = yrcTrim && (yrcTrim.match(/^\[\d+,\d+\]/) || yrcTrim.includes('(') || yrcTrim.match(/^\[ti:/) || yrcTrim.match(/^\[ar:/) || yrcTrim.match(/^\{/));

    if (isYrc) {
        /* 区分QQ（2参数 (a,b) 文本在标记之间）与网易云（3参数 (a,b,0) 文本在标记之后） */
        const isNeteaseYrc = /\(\d+,\d+,\d+\)/.test(yrcTrim);
        if (isNeteaseYrc) {
            format = 'netease_yrc';
            originals = parseNeteaseYrc(data.yrc);
            if (originals.length === 0) originals = parseYrc(data.yrc);
        } else {
            format = 'qq_yrc';
            originals = parseYrc(data.yrc);
            if (originals.length === 0) originals = parseNeteaseYrc(data.yrc);
        }
        /* 如果按 YRC 解析依然为空，可能其实是普通 LRC 文本，自动回退到 parseLrc */
        if (originals.length === 0) {
            originals = parseLrc(data.yrc).map((item, index, arr) => ({
                start: item.time,
                end: index < arr.length - 1 ? arr[index + 1].time : item.time + 5000,
                original: item.text,
                words: []
            }));
            if (originals.length > 0) format = 'lrc';
        }
        if (data.trans) {
            let transText = cleanQQMusicMetadata(data.trans);
            translations = parseLrc(transText).filter(item => item.text.trim() !== '//');
        }
        if (data.roma && data.roma.match(/^\[\d+,\d+\]/)) {
            romaji = parseRoma(data.roma);
        } else if (data.roma) {
            romaji = parseLrc(cleanQQMusicMetadata(data.roma)).map((item, index, arr) => ({
                start: item.time,
                end: index < arr.length - 1 ? arr[index + 1].time : item.time + 5000,
                original: item.text,
                words: []
            }));
        }
    } else if (data.lrc) {
        let lrcText = data.lrc;
        format = 'lrc';
        if (data.trans) {
            translations = parseLrc(cleanQQMusicMetadata(data.trans)).filter(item => item.text.trim() !== '//');
        }
        if (data.roma) {
            romaji = parseLrc(cleanQQMusicMetadata(data.roma)).map((item, index, arr) => ({
                start: item.time,
                end: index < arr.length - 1 ? arr[index + 1].time : item.time + 5000,
                original: item.text,
                words: []
            }));
        }
        originals = parseLrc(lrcText).map((item, index, arr) => ({
            start: item.time,
            end: index < arr.length - 1 ? arr[index + 1].time : item.time + 5000,
            original: item.text,
            words: []
        }));
        /* 如果 LRC 解析为空，尝试作为 YRC 解析 */
        if (originals.length === 0) {
            originals = parseYrc(lrcText);
            if (originals.length === 0) originals = parseNeteaseYrc(lrcText);
        }
    }

    /* 绝对兜底：如果前面全部为空但存在任何文本字段 */
    if (originals.length === 0 && (data.lrc || data.yrc || data.krc)) {
        const rawFallback = data.lrc || data.yrc || data.krc;
        originals = parseLrc(rawFallback).map((item, index, arr) => ({
            start: item.time,
            end: index < arr.length - 1 ? arr[index + 1].time : item.time + 5000,
            original: item.text,
            words: []
        }));
    }
    return { format, originals, translations, romaji };
}
