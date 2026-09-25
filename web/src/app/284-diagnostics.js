/* ============================================================
 * 284-diagnostics.js — 应用内诊断页（todos #21）
 *
 * 一页解决「低性能设备（虚拟机/无独显）到底卡在哪」。之所以值得做，是因为
 * AGENTS 约束 12 写得很清楚：这类设备的真实帧率**在开发机上测不出来**
 * （DevTools 的 CPU 降频只慢 JS 主线程，blur 的代价在合成器软件光栅化），
 * 没有这一页就只能靠猜。有了它，一张截图 / 一段纯文本即可定位。
 *
 * 数据全部来自既有观测点，本分片只做渲染，不产生任何判断分支：
 *   180-boot-config     detectHardware / getPerformanceSettings / getPerfVfx / getVfxOverrides
 *   core/frameProbe     各引擎实时帧时（中位 / p95 / 最大 / 样本数）+ 在跑的 rAF 循环数
 *   services/log        日志环形缓冲尾部
 *   services/playSource 取链命中 + 逐源尝试 + 降级轨迹（todos #15）
 *   selfhost-runtime    /api/selfhost/status（本机 vendor 副进程存活与登录态）
 *   core/globalRegistry 全局键登记表（只读快照 listGlobals）
 *   PerformanceNavigationTiming / ResourceTiming 启动耗时分解
 *
 * ★ 不用 auditGlobals()：它会为每个未定义键/多写键打一条日志，等于打开一次面板
 *   就把 globalRegistry 的噪音灌进环形缓冲，把「本次取链轨迹」挤出去。
 * ★ 每段都带作用域标记（浏览器环境 / 本机自建 vendor / 渠道决定）——用户拿开发机
 *   的帧率当 VM 结论、拿公网上游失联当「软件坏了」，是这一页最先要防的误读。
 * ★ 纯展示：不写状态、不改档位、不发有副作用的请求（status 是只读 GET）。
 * ★ 文案：整页由 JS 渲染，词表是 core/i18n.js 的 STATIC_PHRASE_MAP（全库唯一一份），
 *   渲染前逐条走 translatePhrase()。本分片曾自带一张私有 PHRASE_EN，2026-09-26 已
 *   整体迁进词表并删除 —— 新加中文文案时**只登记 STATIC_PHRASE_MAP**，别再建表。
 * ============================================================ */
import { esc } from '../utils/formatters.js';
import { getLanguage, translatePhrase } from '../core/i18n.js';
import { getLogs, logCatch, logWarn } from '../services/log.js';
import { channelMeta, describeBadge, describeDetail, getResolveTrace, RESOLVE_LOG_TAGS } from '../services/playSource.js';
import { listGlobals } from '../core/globalRegistry.js';
import { allStats as probeAllStats, probeInfo, running as probeRunning } from '../core/frameProbe.js';
import { detectHardware, getPerformanceSettings, getPerfVfx, getVfxOverrides } from './180-boot-config.js';
import { fetchStatus, selfhostEnabled } from './selfhost-runtime.js';
import { PERFORMANCE_PROFILES } from '../config/performance.js';

/* 文案查询：全库唯一词表在 core/i18n.js 的 STATIC_PHRASE_MAP，本分片**不再自带表**。
   原来这里是一张私有 PHRASE_EN（182 条），绕开了词表 → 复扫看不见、同义词各说各话。
   translatePhrase() 非英文模式原样返回，所以 tx() 只是个别名，读起来顺一点。 */
const tx = translatePhrase;

/* 三个 vendor 副进程端口：/api/selfhost/status 不带 port 字段，按 AGENTS 固定端口表补 */
const VENDOR_PORTS = { kugou: 3100, qq: 3200, netease: 3201 };
const VENDOR_NAMES = { kugou: '酷狗 KuGouMusicApi', qq: 'QQ qq-music-api-node', netease: '网易云 NeteaseCloudMusicApi' };
const VFX_KEYS = ['renderScale', 'coverBlur', 'glassBlur', 'lyricBlur', 'textBlur', 'pvBloom', 'flyinGlow', 'wcParticles', 'tunnelParticles', 'dimParticles'];
const VFX_LABELS = {
    renderScale: '渲染缩放 renderScale', coverBlur: '封面模糊 coverBlur', glassBlur: '玻璃模糊 glassBlur',
    lyricBlur: '歌词模糊 lyricBlur', textBlur: '文字光晕 textBlur', pvBloom: 'PV 泛光 pvBloom',
    flyinGlow: '飞入辉光 flyinGlow', wcParticles: '词云粒子 wcParticles',
    tunnelParticles: '隧道粒子 tunnelParticles', dimParticles: '景深粒子 dimParticles',
};
const TIER_NAMES = {
    selfhost: '本机自建', local: '本机解析', api: '平台官方接口', public: '公网上游',
    fallback: '跨源兜底', direct: '直链/本地', unknown: '未知', failed: '失败',
};
/* 段落到作用域徽标的映射：让「浏览器环境 / 本机服务 / 公网」在一页里不会混为一谈 */
const SCOPE_BY_SECTION = {
    verdict: '浏览器环境', env: '浏览器环境', gpu: '浏览器环境', perf: '浏览器环境',
    frames: '浏览器环境', boot: '浏览器环境', seg: '浏览器环境', globals: '浏览器环境',
    vendor: '本机自建 vendor', resolve: '渠道决定',
};
const SCOPE_CLASS = { '浏览器环境': 'browser', '本机 Python 服务': 'local', '本机自建 vendor': 'vendor', '渠道决定': 'mixed' };

const OK = 'ok';
const WARN = 'warn';
const BAD = 'bad';
const DIM = 'dim';

/* ========== 小工具 ========== */
function onOff(v) { return v ? tx('开') : tx('关'); }
function yesNo(v) { return v ? tx('是') : tx('否'); }
function ms(v) { return (typeof v === 'number' && isFinite(v)) ? `${v.toFixed(1)} ms` : '—'; }
function bytes(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    if (n <= 0) return '0 KB';
    if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024).toFixed(0)} KB`;
}
function stamp(ts) {
    if (!ts) return '—';
    try { return new Date(ts).toLocaleString(); } catch (e) { logCatch('diagnostics', e); return String(ts); }
}
/* 资源名可能是带签名参数的直链：只留 host + 路径尾两段，query 一律丢掉 */
function shortUrl(u) {
    const s = String(u || '');
    const clean = s.split('#')[0];
    const host = (/[a-z]+:\/\/([^/]+)/i.exec(clean) || [])[1] || '';
    const parts = clean.replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0].split('/').filter(Boolean);
    const tail = parts.slice(-2).join('/');
    return [host, tail].filter(Boolean).join(' /') || s.slice(0, 40);
}
/* 日志正文里可能粘着播放直链（QQ 的 vkey 是签名参数）。诊断文本是要贴到 issue 上的，
   所以整段输出前统一遮参：保留 host+path 与参数名（诊断价值），丢掉参数值。 */
function redactUrl(u) {
    const i = u.indexOf('?');
    if (i < 0) return u;
    const keys = u.slice(i + 1).split('#')[0].split('&')
        .map(kv => kv.split('=')[0]).filter(Boolean);
    return u.slice(0, i) + (keys.length ? `?${keys.join('&')}=…` : '');
}
function redact(s) {
    return String(s == null ? '' : s).replace(/https?:\/\/[^\s"'）)、,;]+/g, redactUrl);
}
function readGlobal(key) {
    return (typeof globalThis !== 'undefined' && globalThis[key] !== undefined) ? globalThis[key] : null;
}
/* row 的 key 一律过词表：面板里所有标签都是本文件写死的中文原文 */
function row(k, v, tone = '') {
    return { k: k ? tx(k) : '', v: (v === null || v === undefined || v === '') ? '—' : String(v), tone };
}
function section(id, title, rows, hint = '') {
    const scopeZh = SCOPE_BY_SECTION[id] || '浏览器环境';
    return {
        id,
        title: tx(title),
        scope: tx(scopeZh),
        scopeClass: SCOPE_CLASS[scopeZh] || 'browser',
        rows: rows.filter(Boolean),
        hint: hint ? tx(hint) : '',
    };
}

/* ========== 采集 ========== */
async function collectHardware() {
    const saved = getPerformanceSettings() || {};
    let hw = saved.hardware || null;
    let fresh = false;
    if (!hw || !hw.gpuRaw) {
        /* 用户设过手动档时快照里没有 hardware（那条分支不落盘检测值）。
           补一次只读探测：detectHardware 除挂 is-software-renderer 标记外不改档位。 */
        try { hw = await detectHardware(); fresh = true; } catch (e) { logCatch('diagnostics', e); }
    }
    return { hw, saved, fresh };
}

function sectionEnvironment() {
    const rows = [];
    const nav = readGlobal('navigator') || {};
    const de = (typeof document !== 'undefined') ? document : null;
    const perf = (typeof performance !== 'undefined') ? performance : null;
    const mem = perf && perf.memory;
    const isTauri = !!(typeof globalThis !== 'undefined' && globalThis.__TAURI__);
    rows.push(row('外壳', isTauri ? tx('桌面壳（Tauri）') : tx('纯浏览器'), DIM));
    rows.push(row('页面地址', (typeof location !== 'undefined') ? location.origin : '—', DIM));
    rows.push(row('浏览器 UA', nav.userAgent || '—', DIM));
    rows.push(row('平台', [nav.platform, nav.vendor].filter(Boolean).join(' · ') || '—', DIM));
    rows.push(row('界面语言', getLanguage(), DIM));
    rows.push(row('网络', nav.onLine === false ? tx('离线') : tx('在线'), nav.onLine === false ? BAD : OK));
    rows.push(row('CPU 逻辑核', nav.hardwareConcurrency || tx('未知（浏览器未提供）'), DIM));
    rows.push(row('设备内存', nav.deviceMemory ? `${nav.deviceMemory} GB` : tx('未知（浏览器未提供）'), DIM));
    if (mem && mem.usedJSHeapSize) rows.push(row('JS 堆', `${bytes(mem.usedJSHeapSize)} / ${bytes(mem.jsHeapSizeLimit)}`, DIM));
    const screen = (typeof window !== 'undefined' && window.screen) || null;
    rows.push(row('屏幕', screen ? `${screen.width}×${screen.height}` : '—', DIM));
    rows.push(row('视口', de ? `${de.documentElement.clientWidth}×${de.documentElement.clientHeight}` : '—', DIM));
    rows.push(row('像素比', (typeof window !== 'undefined') ? String(window.devicePixelRatio || 1) : '—', DIM));
    rows.push(row('标签页可见', de ? (de.hidden ? tx('否') : tx('是')) : '—', de && de.hidden ? WARN : DIM));
    const viewMode = readGlobal('currentViewMode');
    if (viewMode) rows.push(row('当前视觉模式', viewMode, DIM));
    return section('env', '运行环境', rows);
}

function sectionGpu(hw, fresh) {
    const rows = [];
    const de = (typeof document !== 'undefined') ? document : null;
    const marked = !!(de && de.documentElement && de.documentElement.classList.contains('is-software-renderer'));
    const winFlag = !!(typeof window !== 'undefined' && window.__isSoftwareRenderer);
    rows.push(row('WebGL renderer 原文', (hw && hw.gpuRaw) || tx('未获取'), DIM));
    rows.push(row('清洗后显卡名', (hw && hw.gpu) || '—'));
    rows.push(row('是否有 WebGL', hw ? yesNo(hw.hasWebgl) : '—', hw && hw.hasWebgl ? OK : BAD));
    rows.push(row('软件渲染标记', `window.__isSoftwareRenderer=${winFlag ? 'true' : 'false'} · html class is-software-renderer: ${marked ? tx('有') : tx('无')}`,
        (marked || winFlag) ? WARN : OK));
    rows.push(row('低端/集显判定', hw ? yesNo(hw.isLowPower) : '—', hw && hw.isLowPower ? WARN : OK));
    rows.push(row('显卡分级', (hw && hw.gpuTier) || '—', DIM));
    rows.push(row('硬件评分', (hw && typeof hw.performanceScore === 'number') ? hw.performanceScore : '—', DIM));
    rows.push(row('硬件推荐档位', (hw && hw.recommendedProfile) || '—', DIM));
    rows.push(row('内存/核', hw ? `${hw.memory} GB / ${hw.cpuCores} 核` : '—', DIM));
    rows.push(row('探测时间', fresh ? tx('本次新探测') : tx('本次读取启动快照（未重新探测）'), DIM));
    return section('gpu', '显卡与渲染后端', rows);
}

function sectionPerf(saved) {
    const rows = [];
    const name = saved.profile || '';
    const prof = PERFORMANCE_PROFILES[name] || null;
    rows.push(row('当前档位', name ? `${name}${prof ? ` (${prof.name})` : ''}` : tx('未获取'), name ? OK : BAD));
    rows.push(row('是否手动设定', saved.manuallyConfigured ? `${tx('是')} — ${tx('手动档时自动检测会被跳过')}` : tx('否')));
    if (saved.testFps || saved.stressFps || saved.effectiveFps) {
        rows.push(row('检测出的 FPS', `${Math.round(saved.testFps || 0)} / ${Math.round(saved.stressFps || 0)} / ${Math.round(saved.effectiveFps || 0)}`, DIM));
    }
    rows.push(row('探测时间', stamp(saved.detectedAt || saved.configuredAt), DIM));
    const de = (typeof document !== 'undefined') ? document : null;
    const bodyCls = (de && de.body) ? Array.from(de.body.classList).filter(c => c.indexOf('perf-') === 0).join(' ') : '';
    rows.push(row('body 性能 class', bodyCls || tx('无'), DIM));

    const vfx = getPerfVfx() || {};
    const overrides = getVfxOverrides() || {};
    const oKeys = Object.keys(overrides);
    rows.push(row('视觉开销手动覆盖',
        oKeys.length ? oKeys.map(k => `${k}=${String(overrides[k])}`).join(', ') : tx('无（全部按档位矩阵）'),
        oKeys.length ? WARN : DIM));
    const baseline = (prof && prof.vfx) || {};
    for (const k of VFX_KEYS) {
        if (!(k in vfx)) continue;
        const overridden = k in overrides;
        const changed = baseline[k] !== undefined && baseline[k] !== vfx[k];
        rows.push(row(VFX_LABELS[k] || k, `${String(vfx[k])}${(overridden && changed) ? ` (${baseline[k]} → ${tx('手动覆盖')})` : ''}`, overridden ? WARN : DIM));
    }
    const st = readGlobal('appSettings') || {};
    const bg = st.background || {};
    const ly = st.lyrics || {};
    const itf = st.interface || {};
    rows.push(row('已生效设置（appSettings）', [
        `dynamicBg=${onOff(bg.dynamicBg)}`, `blur=${bg.blur}`, `blurLevel=${ly.blurLevel}`,
        `glass=${itf.glassStrength}`, `compact=${onOff(itf.compactMode)}`,
    ].join(' · '), DIM));
    return section('perf', '性能档位与 vfx 实际值', rows);
}

function sectionFrames() {
    const rows = [];
    const info = probeInfo();
    const run = probeRunning();
    rows.push(row('在跑的 rAF 循环', `${run.total} ${tx('个，其中引擎')} ${run.engines}`, run.engines ? OK : DIM));
    rows.push(row('已登记源', `${info.registered} · ${tx('空闲')}: ${run.idle.length ? run.idle.join(', ') : '—'}`, DIM));
    rows.push(row('每源保留帧数', `${info.ringCap} ${tx('帧')} · >${info.gapMs}ms ${tx('记为挂起')}`, DIM));
    for (const s of probeAllStats()) {
        /* 源 label 由埋点方（各引擎）写死中文，这里同样过词表 */
        const label = tx(s.label);
        if (!s.samples) {
            rows.push(row(label, tx('无样本'), s.running ? WARN : DIM));
            continue;
        }
        const tone = s.medianMs > 34 ? BAD : (s.medianMs > 21 ? WARN : OK);
        rows.push(row(label, [
            `${tx('中位')} ${ms(s.medianMs)}`,
            `p95 ${ms(s.p95Ms)}`,
            `${tx('最大')} ${ms(s.maxMs)}`,
            `≈${s.fps.toFixed(1)} fps`,
            `${tx('样本')} ${s.samples}/${s.frames}`,
            s.gaps ? `${tx('挂起')} ${s.gaps}` : '',
            s.running ? tx('运行中') : tx('未运行'),
        ].filter(Boolean).join(' · '), tone));
    }
    return section('frames', '帧时（实时采样）', rows,
        '引擎帧时需要在各引擎的 rAF 回调里加一行 frameProbe.frame(名称) 埋点；未埋点时只有内置心跳。');
}

function sectionBoot() {
    const rows = [];
    if (typeof performance === 'undefined' || !performance.getEntriesByType) {
        return section('boot', '启动耗时分解', [row('—', tx('浏览器资源计时缓冲已满或未开放'), WARN)]);
    }
    const nav = performance.getEntriesByType('navigation')[0] || null;
    const diff = (a, b) => (typeof a === 'number' && typeof b === 'number' && b >= a && b > 0) ? `${Math.round(b - a)} ms` : '—';
    if (nav) {
        rows.push(row('导航类型', nav.type || '—', DIM));
        rows.push(row('协议', nav.nextHopProtocol || '—', DIM));
        rows.push(row('DNS 解析', diff(nav.domainLookupStart, nav.domainLookupEnd)));
        rows.push(row('TCP 连接', diff(nav.connectStart, nav.connectEnd)));
        if (nav.secureConnectionStart > 0) rows.push(row('TLS', diff(nav.secureConnectionStart, nav.connectEnd)));
        rows.push(row('首字节 TTFB', diff(nav.fetchStart, nav.responseStart)));
        rows.push(row('DOM 完成', diff(nav.fetchStart, nav.domContentLoadedEventEnd)));
        rows.push(row('load 事件结束', nav.loadEventEnd > 0 ? diff(nav.fetchStart, nav.loadEventEnd) : tx('未完成')));
        rows.push(row('文档传输', bytes(nav.transferSize), DIM));
    }
    const res = performance.getEntriesByType('resource') || [];
    let totalTx = 0;
    let jsTx = 0;
    let jsCount = 0;
    for (const r of res) {
        totalTx += r.transferSize || 0;
        if (r.initiatorType === 'script' || /\.js(\?|$)/i.test(r.name)) { jsTx += r.transferSize || 0; jsCount++; }
    }
    rows.push(row('资源请求数', String(res.length), DIM));
    rows.push(row('资源总传输', bytes(totalTx), DIM));
    rows.push(row('脚本请求', `${jsCount} · ${bytes(jsTx)}`, jsTx > 8 * 1024 * 1024 ? WARN : DIM));
    const top = res.slice().sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0)).slice(0, 5);
    top.forEach((r, i) => {
        if (!r.transferSize) return;
        rows.push(row(`${tx('最大资源')} ${i + 1}`, `${shortUrl(r.name)} — ${bytes(r.transferSize)} · ${Math.round(r.duration)} ms`,
            r.transferSize > 3 * 1024 * 1024 ? WARN : DIM));
    });
    if (!nav && !res.length) rows.push(row('', tx('浏览器资源计时缓冲已满或未开放'), WARN));
    return section('boot', '启动耗时分解', rows);
}

function sectionSegLibs() {
    const rows = [];
    const w = (typeof window !== 'undefined') ? window : null;
    const has = (k) => !!(w && w[k]);
    rows.push(row('中文 segmentit', has('Segmentit') ? tx('已就位') : tx('未加载'), has('Segmentit') ? OK : WARN));
    rows.push(row('日文 kuromoji', has('kuromoji') ? tx('已就位') : tx('未加载'), has('kuromoji') ? OK : DIM));
    rows.push(row('延迟加载器', has('__ensureSegLibs') ? 'window.__ensureSegLibs ✓' : `window.__ensureSegLibs ✗ ${tx('未获取')}`,
        has('__ensureSegLibs') ? OK : BAD));
    let injected = [];
    try {
        injected = Array.from((typeof document !== 'undefined' && document.scripts) || [])
            .map(s => s.src || '').filter(src => /segmentit|kuromoji/.test(src));
    } catch (e) { logCatch('diagnostics', e); }
    rows.push(row('已注入脚本', injected.length ? injected.map(shortUrl).join(', ') : tx('未加载'), injected.length ? OK : DIM));
    let dictCount = 0;
    let dictTx = 0;
    try {
        const res = (typeof performance !== 'undefined' && performance.getEntriesByType) ? performance.getEntriesByType('resource') : [];
        for (const r of res) {
            if (/kuromoji[/-]dict[/.]/.test(r.name)) { dictCount++; dictTx += r.transferSize || 0; }
        }
    } catch (e) { logCatch('diagnostics', e); }
    rows.push(row('日文词典分片', dictCount ? `${dictCount} · ${bytes(dictTx)}` : tx('未加载'), dictCount ? WARN : OK));
    const hasIntl = (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function');
    rows.push(row('Intl.Segmenter 兜底', hasIntl ? tx('可用') : tx('不可用'), hasIntl ? OK : WARN));
    return section('seg', '分词库加载状态', rows,
        '日文词典未下载属正常：只有真的出现日文歌词才拉（约 17MB）。');
}

async function collectVendor() {
    const rows = [];
    let st = null;
    let err = '';
    try {
        st = await fetchStatus(true);
    } catch (e) {
        /* fetchStatus 自身已把失败归一成 null，这里只兜住意外（如 localStorage 抛错） */
        err = (e && e.message) || String(e);
        logCatch('diagnostics', e);
    }
    const ok = !!st;
    rows.push(row('主服务 :8001', ok ? tx('正常返回') : `${tx('无响应（未启动 / 绿色版路径异常）')}${err ? ` — ${err}` : ''}`, ok ? OK : BAD));
    rows.push(row('配置后端标记', `${String(readGlobal('_isLocalBackendAvailable'))} (null=尚未确认)`,
        readGlobal('_isLocalBackendAvailable') === false ? WARN : DIM));
    for (const key of ['qq', 'kugou', 'netease']) {
        const s = ok ? (st[key] || null) : null;
        const bits = [
            `${tx('副进程')} ${s ? (s.alive ? tx('在线') : tx('离线')) : '—'}`,
            `${tx('登录态')} ${s ? (s.loggedIn ? tx('已登录') : tx('未登录')) : '—'}`,
            `${tx('平台开关')} ${selfhostEnabled(key) ? tx('已启用') : tx('未启用')}`,
        ];
        if (s && s.hasSource === false) bits.push(tx('源码缺失（未跑 scripts/setup-vendors.bat）'));
        if (s && s.uid) bits.push(`uid ${s.uid}`);
        bits.push(`:${VENDOR_PORTS[key]}`);
        rows.push(row(VENDOR_NAMES[key], bits.join(' · '), (s && s.alive && s.loggedIn) ? OK : (s && s.alive ? WARN : BAD)));
    }
    return { section: section('vendor', '本机服务与 vendor', rows,
        '公网上游（vkeys/ygking/byfuns）不主动探测：它们失联时是整体超时，探测会把面板卡住数秒。看下一段的实际渠道即可。'), ok };
}

function sectionResolve() {
    const rows = [];
    const csd = readGlobal('currentSongData') || {};
    const title = csd.title || csd.name || '';
    const artist = csd.artist || csd.singer || '';
    rows.push(row('当前歌曲', title ? `${title}${artist ? ` — ${artist}` : ''}` : tx('未在播放'), DIM));
    const badge = describeBadge();
    rows.push(row('角标', badge ? badge.text : tx('无取链记录'), badge ? (badge.fallback ? WARN : OK) : DIM));
    const trace = getResolveTrace();
    if (trace && trace.hit) {
        const meta = channelMeta(trace.hit.channelId);
        rows.push(row('命中渠道层级', `${meta.name} · ${tx(TIER_NAMES[meta.tier] || '未知')}`,
            (meta.tier === 'public' || meta.tier === 'fallback' || meta.tier === 'unknown') ? WARN : OK));
    }
    const detail = describeDetail();
    for (const r of detail.rows) rows.push(row(r.k, redact(r.v), DIM));
    if (!detail.rows.length) rows.push(row('', tx('无取链记录'), DIM));
    const tried = (detail.hit && Array.isArray(detail.hit.tried)) ? detail.hit.tried : [];
    tried.forEach((step, i) => {
        rows.push(row('逐源尝试', `#${i + 1} ${step.provider || '?'} · ${step.quality || step.ext || '—'} · ${step.ok ? tx('成功') : tx('失败')}${step.err ? ` · ${redact(step.err)}` : ''}`,
            step.ok ? OK : WARN));
    });
    const logs = detail.logs || [];
    for (const l of logs.slice(-15)) {
        rows.push(row('本次取链日志', `[${l.tag}] ${redact(l.msg)}`, l.level === 'info' ? DIM : WARN));
    }
    if (!logs.length) rows.push(row('本次取链日志', tx('无日志（第一级就命中）'), DIM));
    const tail = getLogs({ limit: 300 })
        .filter(l => l.level !== 'info' && !RESOLVE_LOG_TAGS.includes(l.tag))
        .slice(0, 30);
    for (const l of tail) {
        rows.push(row('其它模块告警', `${String(stamp(l.ts)).split(' ').pop()} [${l.tag}] ${redact(l.msg)}`,
            l.level === 'error' ? BAD : WARN));
    }
    if (!tail.length) rows.push(row('其它模块告警', tx('暂无告警'), OK));
    return section('resolve', '取链详情（最近一次）', rows,
        '直链是临时签名地址：本页只输出域名与路径尾段，不输出完整链接与参数。');
}

function sectionGlobals() {
    const rows = [];
    let snapshot = {};
    try { snapshot = listGlobals() || {}; } catch (e) { logCatch('diagnostics', e); }
    const keys = Object.keys(snapshot);
    const missing = keys.filter(k => !snapshot[k] || snapshot[k].defined === false);
    const multi = keys.filter(k => snapshot[k] && Array.isArray(snapshot[k].writers) && snapshot[k].writers.length > 1);
    rows.push(row('登记键', String(keys.length), DIM));
    rows.push(row('未定义键', String(missing.length), missing.length ? WARN : OK));
    if (missing.length) rows.push(row('未定义键名', missing.slice(0, 24).join(', '), WARN));
    rows.push(row('多写键', `${multi.length}${multi.length ? ` — ${multi.slice(0, 12).join(', ')}` : ''}`, multi.length ? DIM : OK));
    return section('globals', '全局状态登记表', rows,
        '只读 listGlobals()，未跑 auditGlobals()（后者会灌日志缓冲，挤掉取链轨迹）');
}

function sectionVerdict(hw, saved, frameStats, vendorOk) {
    const rows = [];
    const de = (typeof document !== 'undefined') ? document : null;
    const marked = !!(de && de.documentElement && de.documentElement.classList.contains('is-software-renderer'));
    const soft = marked || !!(hw && hw.isSoftwareRenderer);
    rows.push(row('软件渲染（纯 CPU）已识别', yesNo(soft), soft ? WARN : OK));
    rows.push(row('性能档位', saved.profile || tx('未获取'), saved.profile ? OK : BAD));
    const g = frameStats.find(f => f.builtin) || null;
    rows.push(row('页面帧时中位', (g && g.samples) ? `${ms(g.medianMs)} ≈ ${g.fps.toFixed(1)} fps` : tx('无样本'),
        (!g || !g.samples) ? DIM : (g.medianMs > 34 ? BAD : (g.medianMs > 21 ? WARN : OK))));
    rows.push(row('本机主服务未响应', yesNo(!vendorOk), vendorOk ? OK : BAD));
    const nav = readGlobal('navigator') || {};
    if (nav.onLine === false) rows.push(row('网络', tx('离线'), BAD));
    return section('verdict', '结论摘要', rows,
        '本页只反映「当前这台设备 + 这次运行」的数据。开发机的帧率不代表虚拟机/无独显设备；换设备请重新打开本页。');
}

async function collectSections() {
    const { hw, saved, fresh } = await collectHardware();
    const frameStats = probeAllStats();
    const vendor = await collectVendor();
    return [
        sectionVerdict(hw, saved, frameStats, vendor.ok),
        sectionEnvironment(),
        sectionGpu(hw, fresh),
        sectionPerf(saved),
        sectionFrames(),
        sectionBoot(),
        sectionSegLibs(),
        vendor.section,
        sectionResolve(),
        sectionGlobals(),
    ];
}

/* ========== 渲染 ========== */
const TONES = new Set([OK, WARN, BAD]);

function renderSections(sections) {
    let html = '';
    for (const s of sections) {
        html += '<div class="diag-section">';
        html += `<div class="diag-section-head"><span class="diag-section-title">${esc(s.title)}</span>`
            + `<span class="diag-scope scope-${esc(s.scopeClass)}">${esc(s.scope)}</span></div>`;
        if (s.hint) html += `<div class="diag-hint">${esc(s.hint)}</div>`;
        html += '<div class="diag-rows">';
        for (const r of s.rows) {
            const tone = TONES.has(r.tone) ? ` t-${esc(r.tone)}` : '';
            html += `<div class="diag-row${tone}">`
                + `<span class="diag-k">${esc(r.k)}</span>`
                + `<span class="diag-v">${esc(r.v)}</span></div>`;
        }
        html += '</div></div>';
    }
    return html;
}

function sectionsToText(sections) {
    const lines = [`Aria diagnostics · ${stamp(Date.now())}`];
    for (const s of sections) {
        lines.push('');
        lines.push(`## ${s.title}  [${s.scope}]`);
        if (s.hint) lines.push(`! ${s.hint}`);
        let w = 4;
        for (const r of s.rows) w = Math.max(w, Array.from(String(r.k)).length);
        for (const r of s.rows) {
            const k = String(r.k);
            lines.push(`  ${k}${' '.repeat(Math.max(1, w - Array.from(k).length + 2))}${r.v}`);
        }
    }
    lines.push('');
    return lines.join('\n');
}

/* ========== 面板开合 ========== */
const OVERLAY_ID = 'diagnosticsOverlay';
let currentText = '';
let renderToken = 0;

function bodyEl() { return (typeof document !== 'undefined') ? document.getElementById('diagBody') : null; }
function overlayEl() { return (typeof document !== 'undefined') ? document.getElementById(OVERLAY_ID) : null; }

async function refresh() {
    const body = bodyEl();
    if (!body) return;
    const token = ++renderToken;
    body.innerHTML = `<div class="diag-loading">${esc(tx('采集中…'))}</div>`;
    try {
        const sections = await collectSections();
        if (token !== renderToken) return;
        currentText = sectionsToText(sections);
        body.innerHTML = renderSections(sections);
        body.scrollTop = 0;
    } catch (e) {
        logWarn('diagnostics', '诊断页采集失败:', e);
        if (token !== renderToken) return;
        const msg = (e && e.message) || String(e);
        currentText = `Aria diagnostics failed: ${msg}`;
        body.innerHTML = `<div class="diag-loading t-bad">${esc(tx('采集失败'))}: ${esc(msg)}</div>`;
    }
}

export async function showDiagnosticsModal() {
    const overlay = overlayEl();
    if (!overlay) {
        logWarn('diagnostics', '缺少 #diagnosticsOverlay 骨架，诊断页无法打开（见接线清单）');
        return;
    }
    applyStaticLabels();
    overlay.classList.add('visible');
    await refresh();
}

function hide() {
    const overlay = overlayEl();
    if (overlay) overlay.classList.remove('visible');
}

/* 面板与菜单里的静态文案由 JS 上语言（本分片自带词表，不依赖 i18n 的 DOM 扫描根）。
   关闭按钮里是 svg 图标，只能改 title，不能改 textContent。 */
function applyStaticLabels() {
    if (typeof document === 'undefined') return;
    const set = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };
    set('diagTitle', tx('应用诊断'));
    set('diagRefreshLabel', tx('刷新'));
    set('diagCopyLabel', tx('复制诊断文本'));
    set('moreDiagnosticsLabel', tx('应用诊断'));
    const closeBtn = document.getElementById('diagCloseBtn');
    if (closeBtn) closeBtn.title = tx('关闭');
    /* 这两个按钮里是 svg 图标，只能改 title。原先写死 `isEn ? 英文 : 中文` 的三元，
       等于又在本分片里私藏了一份对照表；现在与正文同走 STATIC_PHRASE_MAP。 */
    const refreshBtn = document.getElementById('diagRefreshBtn');
    if (refreshBtn) refreshBtn.title = tx('重新采集数据');
    const copyBtn = document.getElementById('diagCopyBtn');
    if (copyBtn) copyBtn.title = tx('复制为纯文本，便于粘贴到 issue');
}

/* 剪贴板：localhost/Tauri webview 是安全上下文走 async clipboard；
   局域网 http 访问不是安全上下文 → 回退 execCommand（临时 textarea，不污染页面） */
async function copyToClipboard(text) {
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (e) {
        logCatch('diagnostics', e);
    }
    try {
        if (typeof document === 'undefined' || !document.body) return false;
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    } catch (e) {
        logCatch('diagnostics', e);
        return false;
    }
}

function flashBtn(id, zh) {
    const el = (typeof document !== 'undefined') ? document.getElementById(id) : null;
    if (!el) return;
    const old = el.textContent;
    el.textContent = tx(zh);
    setTimeout(() => { el.textContent = old; }, 1400);
}

function onEsc(e) {
    if (e.key !== 'Escape') return;
    const overlay = overlayEl();
    if (overlay && overlay.classList.contains('visible')) hide();
}

export function initDiagnosticsUI() {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    applyStaticLabels();
    document.getElementById('moreDiagnosticsItem')?.addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('moreSubmenu')?.classList.remove('open');
        try { showDiagnosticsModal(); } catch (err) { logCatch('diagnostics', err); }
    });
    document.getElementById('diagCloseBtn')?.addEventListener('click', hide);
    document.getElementById('diagRefreshBtn')?.addEventListener('click', () => {
        try { refresh(); } catch (e) { logCatch('diagnostics', e); }
    });
    document.getElementById('diagCopyBtn')?.addEventListener('click', async () => {
        let ok = false;
        if (currentText) {
            try {
                ok = await copyToClipboard(currentText);
            } catch (e) {
                logCatch('diagnostics', e);
            }
        }
        flashBtn('diagCopyLabel', ok ? '已复制' : '复制失败');
    });
    overlayEl()?.addEventListener('click', (e) => { if (e.target === e.currentTarget) hide(); });
    window.addEventListener('keydown', onEsc);
    /* 语言切换：静态文案换语言，面板开着就连带重采（帧时/日志都是新数据） */
    window.addEventListener('aria:languagechange', () => {
        applyStaticLabels();
        const overlay = overlayEl();
        if (overlay && overlay.classList.contains('visible')) refresh();
    });
}

initDiagnosticsUI();

/* DevTools 探针：与 275 的 Aria.playSource 同一模式，VM 上不开面板也能取文本 */
if (typeof window !== 'undefined' && window.Aria) {
    window.Aria.diagnostics = { show: showDiagnosticsModal, refresh, getText: () => currentText, frames: probeAllStats };
}
