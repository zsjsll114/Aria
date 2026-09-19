import { logInfo, logWarn, logError } from './log.js';
/**
 * services/krcParser.js — 酷狗 KRC 歌词解密与逐字解析
 */

const KRC_XOR_KEY = [
    0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47,
    0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69
];

/* 供 KRC 导出方复用同一密钥 */
export { KRC_XOR_KEY };

/**
 * 解密 Base64 编码的 KRC 歌词数据
 * @param {string} base64Str - KRC 返回的 base64 字符串
 * @returns {Promise<string>} 解密并解压后的 UTF-8 歌词文本
 */
export async function decryptKrc(base64Str) {
    if (!base64Str) return '';
    try {
        // 1. Base64 转二进制
        const binStr = atob(base64Str);
        const rawBytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) {
            rawBytes[i] = binStr.charCodeAt(i);
        }

        // 2. 检查 magic header 'krc1' (4字节: 0x6b, 0x72, 0x63, 0x31)
        const payload = (rawBytes.length >= 4 &&
            rawBytes[0] === 0x6b && rawBytes[1] === 0x72 && rawBytes[2] === 0x63 && rawBytes[3] === 0x31)
            ? rawBytes.slice(4)
            : rawBytes;

        // 3. XOR 解密
        const decrypted = new Uint8Array(payload.length);
        for (let i = 0; i < payload.length; i++) {
            decrypted[i] = payload[i] ^ KRC_XOR_KEY[i % KRC_XOR_KEY.length];
        }

        // 4. 原生 Zlib Inflate 解压
        if (typeof DecompressionStream !== 'undefined') {
            try {
                const ds = new DecompressionStream('deflate');
                const writer = ds.writable.getWriter();
                writer.write(decrypted);
                writer.close();
                const response = new Response(ds.readable);
                return await response.text();
            } catch (e) {
                const dsRaw = new DecompressionStream('deflate-raw');
                const writer = dsRaw.writable.getWriter();
                writer.write(decrypted);
                writer.close();
                const response = new Response(dsRaw.readable);
                return await response.text();
            }
        }
        return '';
    } catch (err) {
        logError('krcParser', '[KRC Decrypt] 解密失败:', err);
        return '';
    }
}

/**
 * 解析 KRC 文本为播放器标准逐字歌词数组
 * KRC 语法: [lineStart, lineDuration]<relWordStart, wordDuration, 0>wordText...
 * @param {string} krcText
 * @returns {Array<{start: number, end: number, duration: number, original: string, words: Array}>}
 */
export function parseKrc(krcText) {
    if (!krcText) return [];
    const lines = krcText.replace(/\r\n/g, '\n').split('\n');
    const parsed = [];

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        // 过滤元数据标签: [ti:xxx], [ar:xxx], [al:xxx], [offset:xxx], [hash:xxx]
        if (/^\[(ti|ar|al|by|hash|offset|id|total|language):.*\]$/i.test(line)) {
            continue;
        }

        // 匹配行首时间戳: [lineStart, lineDuration]
        const lineMatch = line.match(/^\[(\d+),(\d+)\](.*)$/);
        if (!lineMatch) continue;

        const lineStart = parseInt(lineMatch[1], 10);
        const lineDuration = parseInt(lineMatch[2], 10);
        const lineContent = lineMatch[3];

        const words = [];
        // 匹配逐字时间戳: <relWordStart, wordDuration, 0>wordText
        const wordRegex = /<(\d+),(\d+),(\d+)>([^<]*)/g;
        let m;

        while ((m = wordRegex.exec(lineContent)) !== null) {
            const relStart = parseInt(m[1], 10);
            const wordDur = parseInt(m[2], 10);
            const rawText = m[4];

            if (rawText !== undefined) {
                const absStart = lineStart + relStart;
                const absEnd = absStart + wordDur;
                words.push({
                    text: rawText,
                    start: absStart,
                    end: absEnd,
                    duration: wordDur
                });
            }
        }

        const originalText = words.map(w => w.text).join('');
        if (originalText.trim() || words.length > 0) {
            parsed.push({
                start: lineStart,
                duration: lineDuration,
                end: lineStart + lineDuration,
                original: originalText,
                words: words,
                translation: '',
                romaji: ''
            });
        }
    }

    return parsed;
}
