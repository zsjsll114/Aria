/* ============================================================
 * services/playSource.js — 「这首歌到底走了哪个源」的记录与归类（todos #15）
 *
 * 背景：多源取链是一条很长的降级链（本机自建 → 本机解析池 → ygking/byfuns/vkeys
 * 公网 → 跨源同名歌 → 酷我兜底），AGENTS.md 约束 1 把它列为核心约定，但结果在 UI
 * 上完全不可见。「为什么这首歌只有 128k」因此只能翻控制台。
 *
 * 分工（刻意这么切，避免为采集信息去改 loadOnlineSong 的控制流）：
 *   - 本模块只记录**命中**（哪个渠道、什么音质、耗时）——在 175 各命中点一行 record 即可；
 *   - **失败原因**不重复埋点，直接读 services/log.js 的环形缓冲（那些分支本来就 logWarn 了）。
 *
 * 纯数据 + 归类，不碰 DOM；渲染在 app/275-play-source.js。
 * ============================================================ */
import { getLogs, lastLogSeq, logCatch } from './log.js';

/* 取链相关的日志 tag（复扫：grep -o "log\(Info\|Warn\|Error\)('...'" 175 + musicApi + selfhost-runtime） */
export const RESOLVE_LOG_TAGS = ['trackIndexOnline', 'trackIndex', 'musicApi', 'selfhost', 'selfhostRuntime'];

/* tier 决定徽标要不要打「兜底」标记：本机/官方接口是正常路径，公网与跨源是降级路径 */
const CHANNELS = {
    selfhostQQ:      { name: '本机自建 QQ 服务',   platform: 'QQ音乐',   tier: 'selfhost' },
    selfhostNetease: { name: '本机自建网易服务',   platform: '网易云',   tier: 'selfhost' },
    selfhostKugou:   { name: '本机自建酷狗服务',   platform: '酷狗音乐', tier: 'selfhost' },
    qqResolve:       { name: '本机解析池',         platform: 'QQ音乐',   tier: 'local' },
    kugou:           { name: '酷狗取链接口',       platform: '酷狗音乐', tier: 'api' },
    kuwo:            { name: '酷我官方取链',       platform: '酷我音乐', tier: 'api' },
    ygking:          { name: 'ygking 公网接口',    platform: 'QQ音乐',   tier: 'public' },
    vkeysPrefetch:   { name: 'vkeys 预取链接',     platform: 'QQ音乐',   tier: 'public' },
    vkeys:           { name: 'vkeys 公网接口',     platform: 'QQ音乐',   tier: 'public' },
    byfuns:          { name: 'byfuns 公网接口',    platform: '网易云',   tier: 'public' },
    neteaseOuter:    { name: '网易云外链',         platform: '网易云',   tier: 'public' },
    crossKugou:      { name: '跨源·酷狗同名歌',    platform: '酷狗音乐', tier: 'fallback' },
    crossNetease:    { name: '跨源·网易同名歌',    platform: '网易云',   tier: 'fallback' },
    crossKuwo:       { name: '跨源·酷我同名歌',    platform: '酷我音乐', tier: 'fallback' },
    direct:          { name: '歌曲自带直链',       platform: '',         tier: 'direct' },
    local:           { name: '本地文件',           platform: '本地',     tier: 'direct' },
    unknown:         { name: '未知渠道',           platform: '',         tier: 'unknown' },
};

/* 各平台音质档位名（QQ 用 master/atmos/flac/320/128，网易用 hires…standard，酷狗透传数值） */
const QUALITY_LABELS = {
    master: '母带',
    atmos: '臻品全景声',
    flac: '无损 FLAC',
    mflac: '无损 FLAC',
    hires: 'Hi-Res',
    lossless: '无损',
    exhigh: '极高 320k',
    higher: '较高 192k',
    standard: '标准 128k',
    '320': '320k',
    '128': '128k',
};

export function channelMeta(id) {
    return CHANNELS[id] || CHANNELS.unknown;
}

/* 解析池的 quality 字段其实是 provider 的档位标识，实测见过 'song_play_url'（API 字段名）。
   所以只认已知档位或纯数字 kbps，其余一律不当音质显示——宁可显示容器格式也不要编造。 */
const QUALITY_TOKEN_RE = /^(master|atmos|flac|mflac|hires|lossless|exhigh|higher|standard|\d{2,4})$/i;

export function qualityLabel(q) {
    if (q === null || q === undefined) return '';
    const s = String(q).trim();
    if (!s || !QUALITY_TOKEN_RE.test(s)) return '';
    return QUALITY_LABELS[s] || s;
}

let trace = null;
const listeners = new Set();

function notify() {
    /* 一个订阅者抛错不该让其余订阅者收不到更新，也不能冒泡进取链主链路 */
    for (const cb of listeners) {
        try { cb(trace); } catch (e) { logCatch('playSource', e); }
    }
}

/** 开始一次取链记录（切歌时调用） */
export function beginResolveTrace(songKey) {
    trace = {
        songKey: songKey || '',
        startedAt: Date.now(),
        sinceSeq: lastLogSeq(),
        hitTs: 0,
        hitSeq: 0,
        hit: null,
        failed: false,
    };
    notify();
    return trace;
}

/**
 * 记录一次命中。同一首歌多次命中（重试/换源）以最后一次为准，历史在日志缓冲里。
 * @param {string} channelId CHANNELS 的键
 * @param {string} url       最终采用的直链
 * @param {string} [quality] 渠道自身报出的音质档位（权威值，优先于 URL 猜测）
 * @param {Object} [extra]   渠道独有的结构化补充，目前只有解析池用：
 *                           { provider, ext, cached, tried:[{provider,ok,ms,quality,ext,err}] }
 *                           tried[] 即「每一级为什么失败」的权威答案，比抓日志行准
 */
export function recordResolveHit(channelId, url, quality, extra = {}) {
    if (!trace) beginResolveTrace('');
    trace.hit = {
        channelId,
        url: url || '',
        quality: quality || '',
        provider: extra.provider || '',
        ext: extra.ext || '',
        cached: !!extra.cached,
        tried: Array.isArray(extra.tried) ? extra.tried : [],
    };
    trace.hitTs = Date.now();
    /* 轨迹截在命中那一刻：之后再打的日志属于歌词/预加载，不是「本次取链」 */
    trace.hitSeq = lastLogSeq();
    trace.failed = false;
    notify();
    return trace;
}

/** 全链失败（UI 上角标要说明「没取到」而不是继续显示上一首的） */
export function markResolveFailed() {
    if (!trace) beginResolveTrace('');
    trace.failed = true;
    trace.hit = null;
    notify();
}

export function getResolveTrace() {
    return trace;
}

export function onResolveChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

/** 从直链反推平台（渠道没记到时的兜底归类） */
export function sniffPlatform(url) {
    if (!url) return '';
    if (url.startsWith('blob:') || url.startsWith('data:') || /^[a-z]:[\\/]/i.test(url) || url.startsWith('file:')) return '本地';
    if (/:3200\b/.test(url) || /stream\.qqmusic|qq\.com|y\.gtimg|qqmusic/.test(url)) return 'QQ音乐';
    if (/kugou|kg-test|ymdata|fsg\.kugou/.test(url)) return '酷狗音乐';
    if (/kuwo/.test(url)) return '酷我音乐';
    if (/163\.com|126\.net/.test(url)) return '网易云';
    return '';
}

/**
 * 从直链猜音质（仅当渠道没上报档位时用；命中记录的 quality 才是权威值）。
 * ★ 只匹配 pathname：QQ 直链的 vkey 是一串 hex，实测出现以「F320」结尾的 key，
 *   整串匹配会把 /?vkey=…F320…/ 当成 320k，角标于是 lied（真值是 m4a）。
 */
export function sniffQuality(url) {
    if (!url) return '';
    let path = '';
    let query = '';
    try {
        const u = new URL(String(url), 'http://aria.invalid/');
        path = u.pathname.toLowerCase();
        query = u.search.toLowerCase();
    } catch (_) {
        const i = String(url).indexOf('?');
        path = (i < 0 ? String(url) : String(url).slice(0, i)).toLowerCase();
        query = i < 0 ? '' : String(url).slice(i).toLowerCase();
    }
    const bitrate = query.match(/bitrate=(\d+)/);
    if (bitrate) return String(Math.round(Number(bitrate[1]) / 1000));
    if (/master|atmos|m500|ai00|br00/.test(path)) return 'master';
    if (/\.flac|f000|lossless|mflac/.test(path)) return 'flac';
    if (/hires|\.wav|\.ape/.test(path)) return 'hires';
    if (/_r00|320k/.test(path)) return '320';
    return '';
}

/** 音质描述：优先渠道上报档位，其次 URL 猜，最后退回容器名（宁可保守也不编造） */
function bestQuality(hit) {
    return qualityLabel(hit.quality) || qualityLabel(sniffQuality(hit.url))
        || (hit.ext ? String(hit.ext).toLowerCase() : '');
}

/**
 * 角标文案，如 `QQ音乐 · 无损 FLAC` / `网易云 · 128k · 兜底`。
 * @returns {{text:string, tier:string, fallback:boolean}|null}
 */
export function describeBadge() {
    if (!trace) return null;
    if (trace.failed) return { text: '取链失败', tier: 'failed', fallback: true };
    if (!trace.hit) return null;
    const meta = channelMeta(trace.hit.channelId);
    const platform = meta.platform || sniffPlatform(trace.hit.url);
    const quality = bestQuality(trace.hit);
    const parts = [platform, quality].filter(Boolean);
    const fallback = meta.tier === 'public' || meta.tier === 'fallback' || meta.tier === 'unknown';
    if (fallback) parts.push('兜底');
    return { text: parts.join(' · ') || '未知来源', tier: meta.tier, fallback };
}

/**
 * 详情面板数据：概要 + 本次取链走过的降级轨迹（读日志缓冲，不另埋点）。
 * @returns {{rows:Array<{k:string,v:string}>, logs:Array, hit:Object|null}}
 */
export function describeDetail() {
    if (!trace) return { rows: [], logs: [], hit: null };
    const meta = trace.hit ? channelMeta(trace.hit.channelId) : null;
    const rows = [];
    if (trace.hit) {
        rows.push({ k: '命中渠道', v: meta.name });
        if (trace.hit.provider) rows.push({ k: '实际接口', v: trace.hit.provider });
        /* 音质行只报真档位；容器另起一行，否则 ext 兜底会让两行重复显示同一个 m4a */
        rows.push({ k: '音质', v: qualityLabel(trace.hit.quality) || qualityLabel(sniffQuality(trace.hit.url)) || '未上报' });
        if (trace.hit.ext) rows.push({ k: '容器', v: trace.hit.ext });
        if (trace.hit.cached) rows.push({ k: '缓存', v: '命中 15 分钟解析缓存' });
        rows.push({ k: '耗时', v: `${trace.hitTs - trace.startedAt} ms` });
        rows.push({ k: '链接域名', v: hostOf(trace.hit.url) });
    } else {
        rows.push({ k: '结果', v: trace.failed ? '全部渠道失败' : '尚未取链' });
    }
    return {
        rows,
        logs: getLogs({
            tags: RESOLVE_LOG_TAGS,
            sinceSeq: trace.sinceSeq,
            untilSeq: trace.hit ? trace.hitSeq : Infinity,
            limit: 120,
        }).reverse(),
        hit: trace.hit,
    };
}

function hostOf(url) {
    try { return new URL(url, location.href).host; } catch (_) { return url ? url.slice(0, 40) : ''; }
}
