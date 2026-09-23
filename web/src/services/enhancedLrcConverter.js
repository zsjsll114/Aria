/**
 * enhancedLrcConverter.js — 增强型 LRC (Enhanced LRC / E-LRC) 双向编解码转换器
 * 
 * 规范格式：
 * [ti:歌名]
 * [ar:歌手]
 * [al:专辑]
 * [00:15.30]<00:15.30>故事<00:15.80>的小黄花<00:16.40> <00:16.70>从出生<00:17.10>那年<00:17.50>就飘着
 * [00:15.30](tr)The little yellow flower of the story has been floating since the year I was born
 * [00:15.30](ro)gushi de xiao huang hua...
 */

/**
 * 毫秒转标准 [mm:ss.xx] 格式字符串
 */
export function formatTimestamp(ms) {
    if (ms < 0 || isNaN(ms)) ms = 0;
    const totalSec = ms / 1000;
    const minutes = Math.floor(totalSec / 60);
    const seconds = Math.floor(totalSec % 60);
    const hundredths = Math.floor((totalSec % 1) * 100);

    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');
    const xx = String(hundredths).padStart(2, '0');

    return `[${mm}:${ss}.${xx}]`;
}

/**
 * 毫秒转音节打点 <mm:ss.xx> 格式字符串
 */
export function formatWordTimestamp(ms) {
    if (ms < 0 || isNaN(ms)) ms = 0;
    const totalSec = ms / 1000;
    const minutes = Math.floor(totalSec / 60);
    const seconds = Math.floor(totalSec % 60);
    const hundredths = Math.floor((totalSec % 1) * 100);

    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');
    const xx = String(hundredths).padStart(2, '0');

    return `<${mm}:${ss}.${xx}>`;
}

/**
 * 将解析好的多源歌词对象（含 YRC / KRC / QRC 逐字数据）转换为标准增强型 LRC 文本
 * @param {Array<Object>} lines - 歌词行数组 [{ start, end, original, words: [{text, start, end}], translation, romaji }]
 * @param {Object} metadata - { title, artist, album, duration }
 * @returns {string} 增强型 LRC 文本
 */
export function convertToEnhancedLrc(lines, metadata = {}) {
    if (!Array.isArray(lines) || lines.length === 0) {
        return '';
    }

    const output = [];

    // 1. 写入元数据标签
    if (metadata.title) output.push(`[ti:${metadata.title}]`);
    if (metadata.artist) output.push(`[ar:${metadata.artist}]`);
    if (metadata.album) output.push(`[al:${metadata.album}]`);
    if (metadata.duration) {
        const durSec = typeof metadata.duration === 'number' ? metadata.duration : 0;
        const durMm = String(Math.floor(durSec / 60)).padStart(2, '0');
        const durSs = String(Math.floor(durSec % 60)).padStart(2, '0');
        output.push(`[length:${durMm}:${durSs}]`);
    }
    output.push(`[by:LyricsPlayer Enhanced LRC Generator]`);
    output.push('');

    // 2. 逐行写入歌词与打点
    for (const line of lines) {
        const startMs = line.start !== undefined ? line.start : (line.time !== undefined ? line.time : 0);
        const lineTag = formatTimestamp(startMs);

        if (Array.isArray(line.words) && line.words.length > 0) {
            // 逐字增强型行
            let wordTaggedLine = lineTag;
            for (const w of line.words) {
                const wStart = w.start !== undefined ? w.start : startMs;
                wordTaggedLine += `${formatWordTimestamp(wStart)}${w.text || ''}`;
            }
            output.push(wordTaggedLine);
        } else {
            // 标准逐行
            const text = line.original || line.text || '';
            output.push(`${lineTag}${text}`);
        }

        // 附带双语翻译
        if (line.translation && line.translation.trim()) {
            output.push(`${lineTag}(tr)${line.translation.trim()}`);
        }

        // 附带罗马音/注音
        if (line.romaji && line.romaji.trim()) {
            output.push(`${lineTag}(ro)${line.romaji.trim()}`);
        }
    }

    return output.join('\n');
}

/**
 * 解析增强型 LRC 或标准 LRC 文本为播放器标准数据结构
 * @param {string} lrcText 
 * @returns {{ lines: Array<Object>, metadata: Object, hasWordLevel: boolean }}
 */
export function parseEnhancedLrc(lrcText) {
    if (!lrcText || typeof lrcText !== 'string') {
        return { lines: [], metadata: {}, hasWordLevel: false };
    }

    const lines = lrcText.split(/\r?\n/);
    const metadata = {};
    const parsedLines = [];
    const translationMap = new Map(); // timestamp -> text
    const romajiMap = new Map();      // timestamp -> text

    let hasWordLevel = false;

    // 解析时间戳正则 [mm:ss.xx]
    const timeTagRegex = /\[(\d{2,}):(\d{2})(?:\.(\d{2,3}))?\]/g;
    // 解析逐字时间戳 <mm:ss.xx>
    const wordTagRegex = /<(\d{2,}):(\d{2})(?:\.(\d{2,3}))?>/g;

    function timeToMs(m, s, msStr) {
        const min = parseInt(m, 10);
        const sec = parseInt(s, 10);
        let ms = 0;
        if (msStr) {
            if (msStr.length === 2) ms = parseInt(msStr, 10) * 10;
            else if (msStr.length === 3) ms = parseInt(msStr, 10);
        }
        return min * 60000 + sec * 1000 + ms;
    }

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        // 解析元数据 [ti:xxx]
        const metaMatch = line.match(/^\[([a-zA-Z]+):(.*)\]$/);
        if (metaMatch) {
            const key = metaMatch[1].toLowerCase();
            const val = metaMatch[2].trim();
            if (['ti', 'title'].includes(key)) metadata.title = val;
            else if (['ar', 'artist'].includes(key)) metadata.artist = val;
            else if (['al', 'album'].includes(key)) metadata.album = val;
            continue;
        }

        // 匹配所有时间标签
        const timestamps = [];
        let match;
        timeTagRegex.lastIndex = 0;
        while ((match = timeTagRegex.exec(line)) !== null) {
            timestamps.push({
                ms: timeToMs(match[1], match[2], match[3]),
                raw: match[0]
            });
        }

        if (timestamps.length === 0) continue;

        // 提取正文内容（去掉开头的 [mm:ss.xx]）
        const textContent = line.replace(/\[\d{2,}:\d{2}(?:\.\d{2,3})?\]/g, '').trim();

        // 检查是否为翻译行 [mm:ss.xx](tr)...
        if (textContent.startsWith('(tr)')) {
            const trText = textContent.slice(4).trim();
            for (const t of timestamps) translationMap.set(t.ms, trText);
            continue;
        }

        // 检查是否为罗马音行 [mm:ss.xx](ro)...
        if (textContent.startsWith('(ro)')) {
            const roText = textContent.slice(4).trim();
            for (const t of timestamps) romajiMap.set(t.ms, roText);
            continue;
        }

        // 检查是否包含逐字打点 <mm:ss.xx>word
        if (textContent.includes('<') && textContent.includes('>')) {
            hasWordLevel = true;
            const words = [];
            let pureText = '';

            // 切分逐字时间戳与文本
            const parts = textContent.split(/(<\d{2,}:\d{2}(?:\.\d{2,3})?>)/g).filter(Boolean);
            let currentWordStart = timestamps[0].ms;

            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                const tagMatch = part.match(/^<(\d{2,}):(\d{2})(?:\.(\d{2,3}))?>$/);
                if (tagMatch) {
                    currentWordStart = timeToMs(tagMatch[1], tagMatch[2], tagMatch[3]);
                } else if (part) {
                    pureText += part;
                    words.push({
                        text: part,
                        start: currentWordStart,
                        end: currentWordStart + 300 // 默认估算
                    });
                }
            }

            // 修正每个字的结束时间为其下一个字的开始时间
            for (let w = 0; w < words.length - 1; w++) {
                words[w].end = words[w + 1].start;
            }

            for (const t of timestamps) {
                parsedLines.push({
                    start: t.ms,
                    end: t.ms + 3500,
                    original: pureText,
                    words: words.length > 0 ? words : undefined
                });
            }
        } else {
            // 普通逐行
            for (const t of timestamps) {
                parsedLines.push({
                    start: t.ms,
                    end: t.ms + 3500,
                    original: textContent
                });
            }
        }
    }

    // 排序
    parsedLines.sort((a, b) => a.start - b.start);

    // 补齐行结束时间、翻译与罗马音
    for (let i = 0; i < parsedLines.length; i++) {
        const item = parsedLines[i];
        if (i < parsedLines.length - 1) {
            item.end = parsedLines[i + 1].start;
        }
        item.duration = item.end - item.start;

        if (translationMap.has(item.start)) {
            item.translation = translationMap.get(item.start);
        } else if (translationMap.size > 0) {
            let closestTime = -1;
            let minDiff = Infinity;
            for (const [t, text] of translationMap.entries()) {
                const diff = Math.abs(item.start - t);
                if (diff < minDiff && diff <= 1500) {
                    minDiff = diff;
                    closestTime = t;
                }
            }
            if (closestTime !== -1) {
                item.translation = translationMap.get(closestTime);
            }
        }

        if (romajiMap.has(item.start)) {
            item.romaji = romajiMap.get(item.start);
        } else if (romajiMap.size > 0) {
            let closestTime = -1;
            let minDiff = Infinity;
            for (const [t, text] of romajiMap.entries()) {
                const diff = Math.abs(item.start - t);
                if (diff < minDiff && diff <= 1500) {
                    minDiff = diff;
                    closestTime = t;
                }
            }
            if (closestTime !== -1) {
                item.romaji = romajiMap.get(closestTime);
            }
        }
    }

    return {
        lines: parsedLines,
        metadata,
        hasWordLevel
    };
}
