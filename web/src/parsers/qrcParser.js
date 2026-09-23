/** parsers/qrcParser.js — QRC 逐字歌词解析（纯函数，零依赖，可 Node 单测）
 * 供 app/232-nowplaying-follow.js 的 WS 歌词接入使用：
 * 网易/QQ 系歌词服务的逐字（karaoke）歌词字段为 QRC 格式——
 *   ① JSON 行式：{"t": 毫秒, "c": [{"tx": 文本, ...}, ...]}（每行一条，newline 分隔）
 *   ② XML 式：<QrcInfos>...<LyricLine LyricTime="毫秒"><Text>文本</Text></LyricLine>...
 * 正常 LRC（[mm:ss] 文本）不走这里，由 lrcParser.parseLrc 处理。
 */

/* QRC-JSON 行解析：lrc 字段为「每行一条 JSON」的逐字歌词（kthri/now-playing 实测格式）。
   元数据行（{"t":..,"type":1,"txt":..} 无 c 数组）与空 c 行（间奏）自动跳过。
   返回 [{start: 毫秒, text, original}]，不足 2 行视为无可解析歌词返回 null。 */
export function parseQrcLyric(text) {
    if (!text || typeof text !== 'string') return null;
    const lines = text.split('\n');
    const out = [];
    for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('{') || !line.includes('"t"')) continue;
        try {
            const o = JSON.parse(line);
            if (typeof o.t === 'number' && Array.isArray(o.c)) {
                const txt = o.c.map(x => (x && typeof x.tx === 'string' ? x.tx : '')).join('').trim();
                if (txt) out.push({ start: o.t, text: txt, original: txt }); /* start 单位 ms */
            }
        } catch (_e) { /* 单行解析失败跳过 */ }
    }
    return out.length >= 2 ? out : null;
}

/* QRC-XML 行解析：逐字歌词（karaokeLyric）格式为
   <QrcInfos>...<LyricLine LyricTime="毫秒"><Text>文本</Text></LyricLine>... */
export function parseQrcXml(text) {
    if (!text || typeof text !== 'string') return null;
    const out = [];
    const re = /<LyricLine\b[^>]*LyricTime="?(\d+)"?[^>]*>(?:<Text[^>]*>([\s\S]*?)<\/Text>)?/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const t = parseInt(m[1], 10);
        const txt = (m[2] || '').replace(/<[^>]+>/g, '').trim();
        if (isFinite(t) && txt) out.push({ start: t, text: txt, original: txt });
    }
    return out.length >= 2 ? out : null;
}