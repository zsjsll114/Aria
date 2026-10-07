/* ============================================================
 * services/mvSync.js — MV 音画偏移检测（2026-10-04 用户需求）
 *
 * 用户原话：「自动匹配的 MV 有时候音画不同步，我想把 MV 里的音频和正在播放的
 *   音频对齐，算个偏移量来纠正画面，避免音画不同步。」
 *
 * 做法（已用真实素材实测，见 scratch/probe_mv_avsync.mjs）：
 *   把 MV 音轨与歌曲音轨都解成 8kHz 单声道 → 取 20ms 跳的**短时能量包络** →
 *   归一化互相关 → 峰值所在 lag 就是恒定偏移。
 *   实测「成都 / 赵雷」：网易 MV(364.27s) vs 网易歌曲(328.36s)
 *     → lag = **+41.28s**，r = **0.9217**（次峰 0.787，尖峰明确）
 *     开销：素材 26MB（song 5.3MB + MV 20.7MB）、解码 1.3s、相关 **82ms**。
 *
 * ★ 为什么用「能量包络」而不是原始波形：
 *   MV 与歌曲多半不是同一份编码（码率 / 容器 / 母带处理都不同），原始波形的
 *   互相关会被相位与频响差抹平；包络只保留「什么时候有声音、多大声」，对编码
 *   差异免疫，恰好对「前奏 / 间奏 / 尾奏错位」这种真正要修的问题最敏感。
 *
 * ★ lag 的符号约定（别弄反）：
 *   envMv[i] ≈ envSong[i - d] ⇒ MV 在 t 时刻的内容 = 歌曲在 (t - d) 时刻的内容。
 *   d > 0 表示 MV 多了 d 秒前奏 ⇒ 播放时要 **video.currentTime = audio.currentTime + d**。
 *
 * ★ 本模块一律不抛异常：任何一步失败都回 null，调用方保持 offset = 0 正常播放
 *   （用户明确允许："如果开销太大或者搞不定就放弃同步正常播放"）。
 * ============================================================ */
import { proxyFetch } from './musicApi.js';
import { logInfo, logWarn, logCatch } from './log.js';

/** 包络采样率相关常量：8kHz 采样 + 20ms 跳 = 50 帧/秒 */
export const SYNC_SR = 8000;
export const HOP_SEC = 0.02;
export const HOP = Math.round(SYNC_SR * HOP_SEC);       /* 160 */
export const HOP_FPS = 1 / HOP_SEC;                     /* 50 */

/** 判据阈值（按实测留足余量：真匹配 r≈0.92，噪声区通常 < 0.4）
 *  ★ 2026-10-04 收紧：MIN_R 0.55→0.65、峰值间距 0.03→0.05。
 *  0.55 那档太容易放进「碰巧长得像」的错配；而一次错配的偏移会把画面推到
 *  未缓冲的位置、并引发 seek 风暴（见 101 的 seek 预算与观察窗），
 *  代价远高于"少数歌不纠正"。宁可漏，不可错。 */
const MIN_R = 0.65;              /* 绝对相关下限 */
const MIN_PEAK_GAP = 0.05;       /* 主峰要比次峰高出的量，防"平台期"误判 */
const MAX_OFFSET_SEC = 120;      /* 超过两分钟的前奏不再纠正（多半是配错了 MV） */
const DEAD_ZONE_SEC = 0.35;      /* 与运行时纠偏阈值同量级：小于它当 0 处理 */
/* ★ 2026-10-04 从 2 秒收到 0.35 秒（用户报「感觉还是音画不同步…歌曲和 MV 的歌词
   总是差了一句左右的时间」，≈3~4 秒）。
   原来那道闸的理由是「时长几乎相等 ⇒ 同一份母带 ⇒ 偏移必然是 0」，但**官方 MV
   常常是重新剪辑版**：前奏多几秒、尾奏剪几秒，总时长几乎相等而内容整体错位 ——
   恰好就是"差一句歌词"的样子，却被这道闸一刀切掉了。
   ★ 敢放宽的前提是成本降下来了：分析不再整支下载，只取文件头 ANALYZE_MAX_BYTES
   （实测三家 CDN 都是 faststart、moov 在前，前 12MB 足以解出包络；
   见 scratch/probe_mv_audio_range.mjs）。 */
const MIN_DUR_DELTA_SEC = 0.35;
/* 分析用的一次性下载上限。只取文件头就够 —— 偏移是恒定值，包络取前一两百秒即可：
   实测 12MB → QQ 整支(9.8MB) / 酷狗 ~160s / 网易 ~48s（1080p 码率高）。
   这是"敢把时长闸门放宽到 0.35s"的成本前提。 */
export const ANALYZE_MAX_BYTES = 12 * 1024 * 1024;

/* ============================================================
 * 纯函数区（导出以便单测）
 * ============================================================ */

/** 短时 RMS 包络。pcm 为 [-1,1] 的 Float32Array。 */
export function envelopeOf(pcm, hop = HOP) {
    if (!pcm || !pcm.length || hop <= 0) return new Float32Array(0);
    const n = Math.floor(pcm.length / hop);
    const e = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        let s = 0;
        const b = i * hop;
        for (let k = 0; k < hop; k++) { const v = pcm[b + k]; s += v * v; }
        e[i] = Math.sqrt(s / hop);
    }
    return e;
}

/**
 * 在偏移 d（包络帧）上做**归一化**互相关。
 * 归一化是必须的：不做的话「重叠越长分数越高」，短前奏的错配反而会赢。
 */
export function correlateAt(eMv, eSong, d) {
    const lo = Math.max(0, d);
    const hi = Math.min(eMv.length, eSong.length + d);
    const n = hi - lo;
    if (n <= 0) return { r: 0, n: 0 };
    let sa = 0, sb = 0;
    for (let i = lo; i < hi; i++) { sa += eMv[i]; sb += eSong[i - d]; }
    const ma = sa / n, mb = sb / n;
    let ca = 0, cb = 0, cab = 0;
    for (let i = lo; i < hi; i++) {
        const x = eMv[i] - ma, y = eSong[i - d] - mb;
        ca += x * x; cb += y * y; cab += x * y;
    }
    return { r: (ca > 0 && cb > 0) ? cab / Math.sqrt(ca * cb) : 0, n };
}

/** 粗搜：stride 帧一个点。返回按 r 降序的 [{d, r}]。 */
export function scanLags(eMv, eSong, opts = {}) {
    const maxLag = opts.maxLagFrames != null ? opts.maxLagFrames : Math.round(MAX_OFFSET_SEC * HOP_FPS);
    const stride = opts.stride || 4;
    /* 最少要有 20s 重叠才算数（重叠太短的相关分数没有统计意义）；
       但素材本身不长时按 60% 自适应，否则短素材会被这条保护规则整个筛空。 */
    const shortSide = Math.min(eMv.length, eSong.length);
    const minOverlap = opts.minOverlapFrames != null
        ? opts.minOverlapFrames
        : Math.min(Math.round(20 * HOP_FPS), Math.floor(shortSide * 0.6));
    const out = [];
    for (let d = -maxLag; d <= maxLag; d += stride) {
        const c = correlateAt(eMv, eSong, d);
        if (c.n < minOverlap) continue;
        out.push({ d, r: c.r });
    }
    out.sort((a, b) => b.r - a.r);
    return out;
}

/** 细搜：在主峰附近按 1 帧（20ms）分辨率收敛，消除 stride 造成的量化误差。 */
export function refineLag(eMv, eSong, d0, span = 4) {
    let best = { d: d0, r: -1 };
    for (let d = d0 - span; d <= d0 + span; d++) {
        const c = correlateAt(eMv, eSong, d);
        if (c.n <= 0) continue;
        if (c.r > best.r) best = { d, r: c.r };
    }
    return best;
}

/**
 * 把「扫描结果」判成一个可用偏移（秒）。不可信就回 0。
 * @param {{d:number,r:number}[]} ranked 降序候选
 * @returns {{ok:boolean, offsetSec:number, r:number, reason?:string}}
 */
export function judgeOffset(ranked) {
    if (!ranked || !ranked.length) return { ok: false, offsetSec: 0, r: 0, reason: 'no-candidate' };
    const best = ranked[0];
    if (!(best.r > MIN_R)) return { ok: false, offsetSec: 0, r: best.r, reason: 'weak' };
    /* 次峰必须与主峰拉开距离：平台期说明这段音频区分度太低（例如整段都是淡入的
       环境音），此时"最佳 lag"只是噪声，纠正反而会把画面推错。 */
    const second = ranked.find(x => Math.abs(x.d - best.d) > 2);
    if (second && best.r - second.r < MIN_PEAK_GAP) {
        return { ok: false, offsetSec: 0, r: best.r, reason: 'flat' };
    }
    const offsetSec = best.d / HOP_FPS;
    if (Math.abs(offsetSec) > MAX_OFFSET_SEC) {
        return { ok: false, offsetSec: 0, r: best.r, reason: 'out-of-range' };
    }
    /* 与运行时纠偏阈值同量级的小偏移不值得动画面（省掉一次无意义的 seek） */
    if (Math.abs(offsetSec) <= DEAD_ZONE_SEC) return { ok: true, offsetSec: 0, r: best.r, reason: 'dead-zone' };
    return { ok: true, offsetSec: +offsetSec.toFixed(3), r: +best.r.toFixed(4) };
}

/** 两条音轨的包络 → 偏移（秒）。纯计算，无 IO。 */
export function detectOffsetFromPcm(mvPcm, songPcm) {
    const eMv = envelopeOf(mvPcm);
    const eSong = envelopeOf(songPcm);
    if (eMv.length < HOP_FPS * 20 || eSong.length < HOP_FPS * 20) {
        return { ok: false, offsetSec: 0, r: 0, reason: 'too-short' };
    }
    const ranked = scanLags(eMv, eSong);
    if (!ranked.length) return { ok: false, offsetSec: 0, r: 0, reason: 'no-overlap' };
    const fine = refineLag(eMv, eSong, ranked[0].d, 4);
    ranked[0] = fine;                       /* 用细化后的主峰参与判定 */
    return judgeOffset(ranked);
}

/**
 * 值不值得跑一次分析（前置过滤）。纯函数。
 *
 * ★ 为什么加这道门（2026-10-04 用户报「MV 播不了了」之后补的）：
 *   偏移检测要把 MV 整支再下载一遍（1080p 可能上百 MB），和正在播放的 MV 抢
 *   带宽与解码 CPU。而**绝大多数**自动匹配的 MV 和歌曲是同一份母带 —— 这种情况下
 *   MV 与歌曲的时长几乎相等，偏移必然是 0，跑一次纯粹是白付代价。
 *   真正需要纠正的是「MV 多了一段前奏/尾奏」这类，**时长必然对不上**。
 *   所以用 |Δ时长| 当闸门：小于 2 秒直接认定无需纠正，一个字节都不下。
 *
 * @returns {{analyze:boolean, reason:string}}
 */
export function shouldAnalyzeOffset(mvDurSec, songDurSec) {
    if (!(mvDurSec > 0) || !(songDurSec > 0)) return { analyze: false, reason: 'no-duration' };
    if (mvDurSec > 900) return { analyze: false, reason: 'too-long' };
    if (Math.abs(mvDurSec - songDurSec) < MIN_DUR_DELTA_SEC) {
        return { analyze: false, reason: 'same-length' };
    }
    return { analyze: true, reason: '' };
}

/**
 * seek 预算（滑动窗口限流）。纯状态机，可单测。
 *
 * ★ 存在的理由：应用偏移后，`syncMvTime` 会把画面推到**尚未缓冲**的位置。
 *   seek 要等 CDN 回一段新数据，而 `timeupdate` 每 ~250ms 就再算一次新目标、
 *   再发一次 seek —— 后一次会把前一次打断，于是 seek 永远完不成、画面永远出不来。
 *   偏移为 0 时不会发 seek，所以此前一直没暴露。给 seek 上预算：窗口内超了就
 *   认定"这个偏移在这台机器上跑不动"，由调用方回退到 0。
 */
export function makeSeekBudget(maxSeeks = 8, windowMs = 10000) {
    let stamps = [];
    return {
        allow(now) {
            stamps = stamps.filter(t => now - t < windowMs);
            if (stamps.length >= maxSeeks) return false;
            stamps.push(now);
            return true;
        },
        count() { return stamps.length; },
        reset() { stamps = []; },
    };
}

/**
 * 「应用了偏移之后，画面到底有没有正常出来」的观察窗判定。纯函数。
 *
 * ★ 存在的理由：算出来的偏移在**这首歌这支 MV 上是否成立**，只有真播一遍才知道。
 *   宁可误判成"失败"退回 0（最多是不同步），也不能让用户看到一块永不刷新的画面。
 *   观察窗内三条必须同时成立：① 不再处于 seeking（seek 真的完成了）；
 *   ② 拿到了可显示帧（readyState >= 2）；③ 播放位置真的在往前走。
 * @param {{readyState:number, seeking:boolean, advancedSec:number, elapsedMs:number}} s
 */
export function judgeAppliedOffset(s) {
    const elapsed = (s && s.elapsedMs) || 0;
    /* 观察窗 3s：正常人眼对"画面卡住"的容忍也就一两秒。窗口里只要还卡着，
       就宁可退回 0（最多是不同步）—— 用户已经为一块死画面报过一次障了。 */
    if (elapsed < 3000) return { ok: true, pending: true };
    if (s.seeking) return { ok: false, reason: 'stuck-seeking' };
    if (!(s.readyState >= 2)) return { ok: false, reason: 'no-frame' };
    if (!(s.advancedSec > 0.3)) return { ok: false, reason: 'frozen' };
    return { ok: true };
}

/* ============================================================
 * IO 区
 * ============================================================ */

/**
 * 带超时的 fetch → ArrayBuffer。失败回 null。
 *
 * ★ 2026-10-04：改为**优先直连 + Range 只取文件头**，代理降为兜底。
 *   原先一律走 `proxyFetch`（理由：MV 直链跨源且当时认为没有 CORS 头）—— 那会
 *   整支下载（1080p 上百 MB），所以偏移检测只能挂在"时长差 ≥2s"的粗闸门后面。
 *   后来实测三家 MV CDN **都带 `Access-Control-Allow-Origin: *`**（画质增强那边
 *   的结论），直连就成立；再叠上 Range，单次成本从 20MB+ 降到 ~12MB 以内，
 *   而且代理链本身也不透传 Range 头，只能直连才拿得到这个好处。
 *   歌曲音频（/api/audio/stream）本来就是同源，直连没有任何问题。
 *
 * @param {number} maxBytes >0 时用 Range 只取前这么多字节（0 = 不限）
 */
async function fetchBuffer(url, timeoutMs, maxBytes = 0) {
    if (!url) return null;
    const headers = maxBytes > 0 ? { Range: `bytes=0-${maxBytes - 1}` } : undefined;
    /* ① 直连（带 Range） */
    try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        try {
            const res = await fetch(url, { signal: ctl.signal, headers });
            if (res && res.ok) {
                const ab = await res.arrayBuffer();
                if (ab && ab.byteLength > 1024) return ab;
            }
        } finally { clearTimeout(timer); }
    } catch (e) { logCatch('mvSync', e); }
    /* ② 回落到本机代理（不带 Range，全量）—— 只给"直连被 CORS 拒"的那几个源兜底。
       能走到这里说明直连不行，那就只能接受全量下载。 */
    try {
        const res = await proxyFetch(url, { timeout: timeoutMs });
        if (!res || !res.ok) return null;
        const ab = await res.arrayBuffer();
        return ab && ab.byteLength > 1024 ? ab : null;
    } catch (e) {
        logCatch('mvSync', e);
        return null;
    }
}

/** 解码成 8kHz 单声道。用 OfflineAudioContext 强制降采样：5 分钟歌 ≈ 9.6MB Float32。 */
async function decode8k(ab) {
    const AC = (typeof OfflineAudioContext !== 'undefined') ? OfflineAudioContext
        : (typeof globalThis !== 'undefined' ? globalThis.webkitOfflineAudioContext : undefined);
    if (!AC) return null;
    const ctx = new AC(1, 1, SYNC_SR);
    const buf = await ctx.decodeAudioData(ab);
    return buf.getChannelData(0);
}

/**
 * 检测「MV 音轨相对歌曲音轨」的恒定偏移。
 *
 * @param {{mvUrl:string, songUrl:string, timeoutMs?:number, mvDurSec?:number, songDurSec?:number}} p
 *   mvUrl   MV 直链（跨源 → 必须经本机 /proxy?url= 取，顺带也避开 CORS）
 *   songUrl 歌曲音频地址（在线曲是 /api/audio/stream，本就同源，直接 fetch）
 * @returns {Promise<{ok:boolean, offsetSec:number, r:number, ms?:object, reason?:string}>}
 */
export async function detectMvOffset(p) {
    const t0 = Date.now();
    const timeoutMs = p.timeoutMs || 60000;
    if (!p.mvUrl || !p.songUrl) return { ok: false, offsetSec: 0, r: 0, reason: 'no-url' };
    /* 时长兜底：太长（演唱会全场之类）收益低、内存高，直接不做 */
    if (p.mvDurSec && p.mvDurSec > 900) return { ok: false, offsetSec: 0, r: 0, reason: 'too-long' };

    const mvAb = await fetchBuffer(p.mvUrl, timeoutMs, ANALYZE_MAX_BYTES);
    if (!mvAb) return { ok: false, offsetSec: 0, r: 0, reason: 'mv-fetch' };
    const songAb = await fetchBuffer(p.songUrl, timeoutMs, ANALYZE_MAX_BYTES);
    if (!songAb) return { ok: false, offsetSec: 0, r: 0, reason: 'song-fetch' };
    /* ★ 字节数必须**在解码前**记下来：`decodeAudioData` 会 detach 传入的 ArrayBuffer，
       之后 byteLength 恒为 0 —— 日志里的"素材 0MB"就是这么来的（功能正常，只有这行数字假）。 */
    const mvBytes = mvAb.byteLength;
    const songBytes = songAb.byteLength;

    let mvPcm, songPcm;
    try {
        mvPcm = await decode8k(mvAb);
        songPcm = await decode8k(songAb);
    } catch (e) {
        logCatch('mvSync', e);
        return { ok: false, offsetSec: 0, r: 0, reason: 'decode' };
    }
    if (!mvPcm || !songPcm) return { ok: false, offsetSec: 0, r: 0, reason: 'decode' };

    const r = detectOffsetFromPcm(mvPcm, songPcm);
    const ms = { total: Date.now() - t0, mvBytes, songBytes };
    if (r.ok) {
        logInfo('mvSync', `[MV Sync] 偏移 ${r.offsetSec}s (r=${r.r})，素材 ${Math.round((ms.mvBytes + ms.songBytes) / 1048576)}MB / ${ms.total}ms`);
    } else {
        logWarn('mvSync', `[MV Sync] 未判定偏移(${r.reason}) r=${r.r}，按 0 处理`);
    }
    return { ...r, ms };
}

/* ============================================================
 * 偏移缓存（localStorage）
 * ------------------------------------------------------------
 * 同一支 MV 同一首歌的偏移是**稳定事实**，算一次就该一直用：
 * 每次播放都重下 20MB+ 的 MV 是不可接受的。缓存按 `mvKey|songKey` 存，
 * 与 101 的 songKeyOf / mvKeyOf 同构（调用方拼好传进来，避免两处各写一份规则）。
 *
 * ★ 键名从 v1 升到 v2（2026-10-04）：v1 是用 MIN_R=0.55 那档宽松判据算出来的，
 * 里面可能混着错配的偏移；错配会把画面推到未缓冲位置并引发 seek 风暴（=「MV 播不了」）。
 * 换代 = 旧结果全部作废重算，比逐个校验便宜得多。
 * ============================================================ */
const OFFSET_KEY = 'aria_mv_offset_v2';
const OFFSET_MAX_ENTRIES = 300;

function readAll() {
    try {
        const o = JSON.parse(localStorage.getItem(OFFSET_KEY) || '{}');
        return (o && typeof o === 'object') ? o : {};
    } catch { return {}; }
}

export function readOffsetCache(key) {
    if (!key) return null;
    const v = readAll()[key];
    return (typeof v === 'number' && isFinite(v)) ? v : null;
}

export function writeOffsetCache(key, offsetSec) {
    if (!key || typeof offsetSec !== 'number' || !isFinite(offsetSec)) return;
    try {
        const o = readAll();
        o[key] = offsetSec;
        const keys = Object.keys(o);
        if (keys.length > OFFSET_MAX_ENTRIES) {
            /* 简易裁剪：对象键无序，这里只保证不会无限增长 */
            keys.slice(0, keys.length - OFFSET_MAX_ENTRIES).forEach(k => { delete o[k]; });
        }
        localStorage.setItem(OFFSET_KEY, JSON.stringify(o));
    } catch (e) { logCatch('mvSync', e); }
}
