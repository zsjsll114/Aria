/** parsers/lrcParser.js — LRC 歌词解析 */
export function cleanQQMusicMetadata(lrcText) {
    if (!lrcText) return lrcText;
    const lines = lrcText.split('\n');
    const cleanedLines = [];
    for (const line of lines) {
        /* 过滤元数据标签行 */
        if (/^\[(ti|ar|al|by|offset|kana):/i.test(line)) continue;
        /* 过滤翻译中的版权声明和 // 纯占位符 */
        if (/享有本翻译作品的著作权/.test(line)) continue;
        if (/^\[\d+:\d+\.\d+\]\/\/\s*$/.test(line)) continue;
        cleanedLines.push(line);
    }
    return cleanedLines.join('\n');
}

export function parseLrc(lrcText) {
    if (!lrcText || typeof lrcText !== 'string') return [];
    const lines = lrcText.replace(/\r\n/g, '\n').split('\n');
    const parsed = [];
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        /* 兼容 [00:12.34], [00:12.345], [00:12:34], [00:12] 等各类时间戳格式，支持同行多个时间标签 */
        const tagRegex = /\[(\d{1,2}):(\d{1,2})(?:[\.:](\d{1,3}))?\]/g;
        let match;
        const timeTags = [];
        let lastTagEnd = 0;
        while ((match = tagRegex.exec(line)) !== null) {
            const min = parseInt(match[1]);
            const sec = parseInt(match[2]);
            const msStr = match[3];
            let ms = 0;
            if (msStr) {
                const parsedMs = parseInt(msStr);
                ms = msStr.length === 1 ? parsedMs * 100 : (msStr.length === 2 ? parsedMs * 10 : parsedMs);
            }
            const time = min * 60000 + sec * 1000 + ms;
            timeTags.push(time);
            lastTagEnd = tagRegex.lastIndex;
        }
        if (timeTags.length > 0) {
            const text = line.substring(lastTagEnd).trim();
            for (const time of timeTags) {
                parsed.push({ time, text });
            }
        }
    }
    parsed.sort((a, b) => a.time - b.time);
    return parsed;
}
