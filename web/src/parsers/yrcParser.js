/* ★ 行首/行尾空白清理：YRC 数据常在第一词前带一个前导空格、末词后带尾随空格
   （该空格本意是词间距，但行首/行尾处属于残留）。若不清除：
   渲染"逐字歌词"时首词会拆出一个空字符(空格) → 视觉上"少了第一个字"；
   英文行则表现为"第一个词缺失"。只清理边界，保留词与词之间的内嵌空格。 */
function trimLineBoundaryWords(words) {
    if (!words || words.length === 0) return;
    while (words.length && !words[0].text.replace(/^\s+/, '')) {
        words.shift();
    }
    if (words.length) words[0].text = words[0].text.replace(/^\s+/, '');
    while (words.length && !words[words.length - 1].text.replace(/\s+$/, '')) {
        words.pop();
    }
    if (words.length) words[words.length - 1].text = words[words.length - 1].text.replace(/\s+$/, '');
}

export function parseYrc(yrcText) {
    if (!yrcText) return [];
    /* 统一换行符，避免 \r\n 导致解析问题 */
    const lines = yrcText.replace(/\r\n/g, '\n').split('\n');
    const parsed = [];
    for (const line of lines) {
        const lineMatch = line.match(/^\[(\d+),(\d+)\](.*)$/);
        if (!lineMatch) continue;
        const start = parseInt(lineMatch[1]);
        const duration = parseInt(lineMatch[2]);
        const body = lineMatch[3];
        const words = [];
        /* ★ QQ YRC 存在两种排布，必须按行自动识别：
           A. 文本在标记前：`编(6750,375)曲(7125,375)` —— 词文本位于「上一标记结束 ~ 本标记开始」之间，
              每个词自带其后跟随的 (start,dur)。vkeys/QQ 官方数据即此格式。
           B. 文本在标记后：`(0,160)晴(160,160)` —— 词文本位于「本标记结束 ~ 下一标记开始」之间。
           旧实现固定按 B 解析：A 类数据中首词(位于行首、首个标记之前)会被整段丢弃 ——
              这正是"每行歌词缺失第一个字/第一个词"的根因，且行内逐字时间轴整体错位一格。 */
        const markerRe = /\((\d+),(\d+)(?:,\d+)?\)/g;
        const markers = [];
        let m;
        while ((m = markerRe.exec(body)) !== null) {
            markers.push({ s: parseInt(m[1]), d: parseInt(m[2]), from: m.index, to: m.index + m[0].length });
        }
        if (markers.length === 0) {
            /* 无逐字标记的普通行，作为整体保留，确保不会丢句 */
            const plainText = body.trim();
            if (plainText) {
                parsed.push({ start, duration, end: start + duration, original: plainText, words: [] });
            }
            continue;
        }
        /* 首个标记之前存在非空文本 → A（文本在标记前）；否则 → B（文本在标记后） */
        const textBefore = body.slice(0, markers[0].from).replace(/\s+/g, ' ').trim().length > 0;
        for (let k = 0; k < markers.length; k++) {
            const mk = markers[k];
            const seg = textBefore
                ? body.slice(k === 0 ? 0 : markers[k - 1].to, mk.from)   /* A：文本在前 */
                : body.slice(mk.to, k + 1 < markers.length ? markers[k + 1].from : body.length); /* B：文本在后 */
            const cleanWordText = seg.replace(/\s+/g, ' ');
            if (cleanWordText.trim() || cleanWordText === ' ') {
                words.push({ text: cleanWordText, start: mk.s, end: mk.s + mk.d });
            }
        }
        if (textBefore) {
            /* A 格式：最后一个标记之后的残留文本（少见）并入末词，避免丢字 */
            const tail = body.slice(markers[markers.length - 1].to).replace(/\s+/g, ' ');
            if (tail.trim() && words.length) {
                words[words.length - 1].text += tail;
            } else if (tail.trim()) {
                const last = markers[markers.length - 1];
                words.push({ text: tail, start: last.s, end: last.s + last.d });
            }
        }
        if (words.length > 0) {
            /* 空格已保留在词内，动态拼接生成 original 文本 */
            trimLineBoundaryWords(words);
            const fullText = words.map(w => w.text).join('').trim();
            if (fullText) {
                parsed.push({ start, duration, end: start + duration, original: fullText, words });
            }
        } else if (body.trim()) {
            /* 无逐字标记的普通行，作为整体保留，确保不会丢句 */
            const plainText = body.trim();
            parsed.push({ start, duration, end: start + duration, original: plainText, words: [] });
        }
    }
    return parsed;
}

if (typeof window !== 'undefined') {
    window.parseYrc = parseYrc;
}

export function parseNeteaseYrc(yrcText) {
    if (!yrcText) return [];
    const lines = yrcText.replace(/\r\n/g, '\n').split('\n');
    const parsed = [];
    for (const line of lines) {
        const lineMatch = line.match(/^\[(\d+),(\d+)\](.*)$/);
        if (!lineMatch) continue;
        const start = parseInt(lineMatch[1]);
        const duration = parseInt(lineMatch[2]);
        const text = lineMatch[3];
        const words = [];
        const wordRegex = /\((\d+),(\d+),(\d+)\)([^()]+)/g;
        let match;
        while ((match = wordRegex.exec(text)) !== null) {
            const wordStart = parseInt(match[1]);
            const wordDuration = parseInt(match[2]);
            const rawWordText = match[4];
            /* 折叠空白但保留单个空格：修复英文逐字歌词单词间距丢失 */
            const cleanWordText = (rawWordText || '').replace(/\s+/g, ' ');
            if (cleanWordText.trim()) {
                words.push({ text: cleanWordText, start: wordStart, end: wordStart + wordDuration });
            }
        }
        if (words.length > 0) {
            /* 空格已保留在词文本内，直接拼接（替代旧的 hasLatin 空格补偿） */
            trimLineBoundaryWords(words);
            const fullText = words.map(w => w.text).join('');
            parsed.push({ start, duration, end: start + duration, original: fullText, words });
        }
    }
    return parsed;
}
