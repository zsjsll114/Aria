/** parsers/romaParser.js — 罗马音解析 */
export function parseRoma(romaText) {
    if (!romaText) return [];
    /* 统一换行符 */
    const lines = romaText.replace(/\r\n/g, '\n').split('\n');
    const parsed = [];
    for (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        const words = [];
        const regex = /\((\d+),(\d+)\)/g;
        let match;
        let lastIndex = 0;
        while ((match = regex.exec(text)) !== null) {
            const wordStart = parseInt(match[1]);
            const wordDuration = parseInt(match[2]);
            if (match.index > lastIndex) {
                let wordText = text.substring(lastIndex, match.index).trim();
                if (wordText) {
                    words.push({ text: wordText, start: wordStart, end: wordStart + wordDuration });
                }
            }
            lastIndex = match.index + match[0].length;
        }
        if (lastIndex < text.length) {
            const remainingText = text.substring(lastIndex).trim();
            if (remainingText) {
                const lastWord = words.length > 0 ? words[words.length - 1] : null;
                words.push({ text: remainingText, start: lastWord ? lastWord.end : 0, end: lastWord ? lastWord.end + 100 : 100 });
            }
        }
        if (words.length > 0) {
            const originalText = words.map(w => w.text).join(' ');
            parsed.push({ start: words[0].start, duration: words[words.length - 1].end - words[0].start, end: words[words.length - 1].end, original: originalText, words });
        }
    }
    return parsed;
}
