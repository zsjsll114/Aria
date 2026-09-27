/* ============================================================
 * core/abLoop.js — 单句 / A-B 循环的边界计算（纯函数，无 DOM）
 *
 * 拆出来的理由：循环的坑全在边界上（行尾取不到、end<=start 会死循环、
 * 拖到区间外该不该拽回来），这些都能脱离浏览器判定；而 audio.currentTime
 * 的读写时机必须在浏览器里实测。所以这里放判据，接线在 294-ab-loop.js。
 * ============================================================ */

/** 一行的起点（毫秒）。歌词行统一用 start；缺失时返回 null 而不是 0，
 *  否则"没有时间的行"会被当成第 0 毫秒，循环会锁死在开头。 */
export function lineStartMs(line) {
    if (!line) return null;
    const v = Number(line.start);
    return Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * 第 index 行的循环区间。
 * 行尾优先取下一行的起点（这是"唱完这句就回头"的自然定义）；
 * 拿不到下一行时用行自带 duration/end 兜底；都没有就给默认 6 秒，
 * 因为最后一行没有下界时不循环比循环到歌曲结尾更符合"单句循环"的直觉。
 * @returns {{start:number,end:number}|null}
 */
export function lineRangeMs(lyrics, index, opts = {}) {
    const fallbackMs = Number.isFinite(opts.fallbackMs) ? opts.fallbackMs : 6000;
    if (!Array.isArray(lyrics) || !lyrics.length) return null;
    /* ★ null / undefined / '' 必须显式挡掉：Number(null) === 0 是合法的，
       不挡的话"拿不到行号"会静默变成"循环第 0 行"——用户点不到却一直在循环开头。 */
    if (index === null || index === undefined || index === '') return null;
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= lyrics.length) return null;
    const start = lineStartMs(lyrics[i]);
    if (start === null) return null;
    for (let j = i + 1; j < lyrics.length; j++) {
        const next = lineStartMs(lyrics[j]);
        if (next !== null && next > start) return { start, end: next };
    }
    const self = lyrics[i];
    const ownEnd = Number(self.end);
    if (Number.isFinite(ownEnd) && ownEnd > start) return { start, end: ownEnd };
    const dur = Number(self.duration);
    if (Number.isFinite(dur) && dur > 0) {
        const end = start + dur * (dur > 600 ? 1 : 1000);   /* duration 可能已是毫秒，也可能是秒 */
        return { start, end };
    }
    return { start, end: start + fallbackMs };
}

/**
 * 该不该回头重播。
 * ★ 必须有 TAIL_SKEW 上界：audio 在接近曲尾时会因缓冲不足而"跳着走"，
 *   currentMs 可能一次跨过 end 好几秒。只判 `>= end` 会把用户拖回区间，
 *   但如果 currentMs 已经远超区间（用户手动 seek 到很后面），
 *   再拽回来就成了"进度条打不过用户"。所以只在 [end, end+skew) 内回头。
 */
export const TAIL_SKEW_MS = 1500;

export function shouldRewind(currentMs, startMs, endMs, skewMs = TAIL_SKEW_MS) {
    if (!Number.isFinite(currentMs) || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
    if (endMs <= startMs) return false;                      /* 退化区间：绝不循环，否则会死锁 */
    if (currentMs < endMs) return false;
    return currentMs < endMs + (Number.isFinite(skewMs) ? skewMs : TAIL_SKEW_MS);
}

/** 用户手动 seek 之后循环要不要取消：落在区间外就取消，
 *  否则用户永远拖不出去（"进度条打不过循环"是最容易被当成 bug 的观感）。 */
export function seekCancelsLoop(currentMs, startMs, endMs) {
    if (!Number.isFinite(currentMs)) return false;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return true;
    return currentMs < startMs || currentMs >= endMs;
}
