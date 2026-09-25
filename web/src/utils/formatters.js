/** utils/formatters.js — 纯函数工具 */
export function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const seconds = (totalSeconds % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
}

export function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/`/g, '&#96;')
        .replace(/\//g, '&#x2F;')
        .replace(/\\/g, '&#x5C;')
        .replace(/\n/g, '&#10;')
        .replace(/\r/g, '&#13;');
}

/* 模板插值用的短名：HTML 文本/属性值一律走 esc()（aria/no-unescaped-html 认它）。
   与 escapeHtml 同一实现，别在分片里再写本地副本。 */
export const esc = escapeHtml;

export function processTextForLatin(text) {
    if (!text) return '';
    const latinRegex = /([a-zA-Z0-9\s\p{P}\p{S}]+)/gu;
    return text.replace(latinRegex, '<span class="word-latin">$1</span>');
}

export function splitLongLine(text, maxChars = 20) {
    if (!text || text.length <= maxChars) return [text];
    const words = text.split(/\s+/);
    const result = [];
    let current = '';
    for (const w of words) {
        if ((current + ' ' + w).trim().length <= maxChars) {
            current = (current + ' ' + w).trim();
        } else {
            if (current) result.push(current);
            current = w;
        }
    }
    if (current) result.push(current);
    return result.length > 0 ? result : [text];
}
