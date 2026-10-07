/* ============================================================
 * 101-mv-background.js — MV 动态背景（搜索结果里点 MV 卡片 → 铺满整窗循环播放）
 *
 * 形态：一个 <video id="mvBgVideo"> 常驻在 .blur-background 之上（见 base.css 的
 *   .mv-background 段）、.color-overlay 与 .player-container 之下 —— 所以歌词、
 *   PV 引擎、控件全部照旧可见可点，MV 只是"换了个底"。
 *
 * 三条硬规则（都是踩过的坑，别拆）：
 *   1. **必须静音 + loop**：它只是背景，不能和播放器的音频抢输出。
 *   2. **filter 只写在 video 上**（blur + brightness），压暗/模糊滑杆直接改它；
 *      video 本身按 112% 铺开并留 6% 余量，否则 blur 会把画面外的透明像素卷进来，
 *      四边出现一圈黑边。
 *   3. **极端性能模式不启用**：perf-minimal / 软件渲染（无显卡虚拟机）下播视频会
 *      直接把 CPU 打满，而它恰恰是"背景"——收益远小于代价，直接拒绝并说明原因。
 *
 * 地址过期：三条 MV 链的直链都带时间戳签名（网易 wsTime / 酷狗 dis_t），
 *   所以 **只在内存里记住当前 MV 的描述符，绝不持久化 URL**；重新点一次即可换新链。
 * ============================================================ */
import { saveSettings } from './180-boot-config.js';
import { fetchMvUrl, resolveMvForSong } from '../services/mvApi.js';
import { songIdentityKey } from '../services/playSource.js';
import { detectMvOffset, readOffsetCache, writeOffsetCache,
    makeSeekBudget, judgeAppliedOffset, shouldAnalyzeOffset } from '../services/mvSync.js';
import { startMvUpscale, stopMvUpscale, disposeMvUpscale, mvUpscaleActive,
    mvUpscaleAvailable, resetMvUpscaleGuard, notifyMvUpscaleResize } from './103-mv-upscale.js';
import { broadcastMvBackdrop } from '../core/visualizers/mvBackdrop.js';
import { logInfo, logWarn, logCatch } from '../services/log.js';

let _video = null;
let _current = null;     /* { source, mvId, vid, hash, name, singer, cover, url } */
let _loadSeq = 0;        /* 竞态序号：连点多张 MV 卡片时只认最后一次 */

/**
 * `body.mv-bg-on` 的**唯一写入点**（同时也是唯一广播点）。
 *
 * 这个 class 语义是「MV 开关开着 **且** 当前确实铺上了 MV」，各全景模式
 * （tempera / tunnel）靠它决定要不要把自己的舞台底压薄让 MV 透出来 ——
 * 但它们那些"底"是绘在 Pixi 画布里 / 烘焙进内联色值的，CSS 够不着，
 * 只能靠广播事件通知引擎重新取因子（见 core/visualizers/mvBackdrop.js）。
 * 漏掉广播 ⇒ 用户开关 MV 后要等下一次换歌才生效。
 */
function setMvBgOn(on) {
    if (typeof document === 'undefined' || !document.body) return;
    document.body.classList.toggle('mv-bg-on', !!on);
    broadcastMvBackdrop();
}
/* ★ 2026-10-03：这支 MV 刚刚确实播不出来（https/http 都失败）→ 记下来，
   30s 内不让**自动跟随**再拉一次。没有它就会形成「失败 → 跟随重设 src → 再失败」
   的循环，观感正是用户报的「闪了下又回退封面」。用户手动点卡片不受此限制。 */
const MV_FAIL_COOLDOWN = 30000;
let _lastFail = { key: '', at: 0 };
/* 因为不走 CORS 而放弃画质增强的 MV 身份键（CDN 没给 ACAO 的那些）。 */
let _noCorsFor = '';
function mvKeyOf(mv) { return mv ? `${mv.source}:${mv.mvId}` : ''; }
function isRecentlyFailed(key) {
    return !!key && _lastFail.key === key && (Date.now() - _lastFail.at) < MV_FAIL_COOLDOWN;
}
/* ★ 2026-10-04：MV 加载失败有**两种形态** ——
   ① 触发 `error` 事件（TLS 被拒、容器/编码不支持）→ 由 onVideoError 处理；
   ② **连接挂起**：既不 error 也不出帧，`<video>` 永远停在 readyState 0，
      只剩 poster（=MV 封面，看着跟歌曲封面一样）。**用户报的「mv 不播放 只显示
      封面」正是这一种**（酷狗 CDN 的 443 证书不匹配，Chromium 侧可能挂在握手）。
   只挂 error 事件是抓不到 ② 的，所以每次设 src 都配一个超时守卫。 */
const MV_LOAD_TIMEOUT = 5000;
let _loadTimer = 0;
let _lastFailure = { reason: '', name: '', at: 0 };

/** 失败收口：记失败（喂给 30s 冷却）+ 收起 MV 层（回落到封面背景）。 */
function failMv(reason) {
    const v = videoEl();
    if (_current) _lastFail = { key: mvKeyOf(_current), at: Date.now() };
    _lastFailure = { reason, name: (_current && _current.name) || '', at: Date.now() };
    if (!v) return;
    try { v.pause(); } catch (e) { logCatch('mvBackground', e); }
    v.classList.remove('visible');
    setMvBgOn(false);
}

/** 按音频状态决定要不要让 video 播（回落 / 重试路径共用）。 */
function retryPlay(v) {
    const a = audioEl();
    if (a && a.paused) {
        try { v.pause(); } catch (e) { logCatch('mvBackground', e); }
        return;
    }
    const p = v.play();
    if (p && typeof p.catch === 'function') p.catch(e => logCatch('mvBackground', e));
}

/** 给「刚设上的 src」挂一次超时守卫。到点还没元数据 → 先换协议，仍不行就放弃。 */
function armLoadTimeout() {
    if (typeof clearTimeout === 'function') clearTimeout(_loadTimer);
    if (typeof setTimeout !== 'function') return;
    _loadTimer = setTimeout(() => {
        const v = videoEl();
        if (!v || !_current) return;
        if (v.readyState >= 1) return;               /* 已拿到元数据 = 正常，守卫交班 */
        const cur = v.getAttribute('src') || '';
        if (cur.startsWith('https://') && v.dataset.mvHttpFallback !== '1') {
            logWarn('mvBackground', '[MV] https 首包超时，回落 http 重试');
            v.dataset.mvHttpFallback = '1';
            v.src = cur.replace(/^https:\/\//, 'http://');
            retryPlay(v);
            armLoadTimeout();
            return;
        }
        logWarn('mvBackground', `[MV] 加载超时，放弃: ${_current.name || ''}`);
        failMv('timeout');
    }, MV_LOAD_TIMEOUT);
}

/** 等「至少拿到元数据」/ 失败 / 超时。给调用方一个如实的结果（而不是"设了就成功"）。 */
function waitPlayable(v, ms) {
    if (v.readyState >= 1) return Promise.resolve('ready');
    return new Promise((resolve) => {
        let done = false;
        const onMeta = () => fin('ready');
        /* ★ 一次 error 常是"中转状态"：CORS 回退、http 重试都会先摘 src 再重设，
           浏览器在这中间就派发一次 error。立刻判死会把"马上就好"报成失败
           （实测酷狗 http 直链的首帧探测就会这样）→ 等一会儿再看 readyState。 */
        const onErr = () => setTimeout(() => fin(v.readyState >= 1 ? 'ready' : 'error'), 1500);
        const t = setTimeout(() => fin(v.readyState >= 1 ? 'ready' : 'timeout'), ms);
        function fin(r) {
            if (done) return;
            done = true;
            clearTimeout(t);
            v.removeEventListener('loadedmetadata', onMeta);
            v.removeEventListener('error', onErr);
            resolve(r);
        }
        v.addEventListener('loadedmetadata', onMeta);
        v.addEventListener('error', onErr);
    });
}
/* ★ 2026-10-03 三修：用户**手动点过 MV 卡片**之后，这首歌内不许自动跟随再接管。
   用户原话：「一首歌有mv 点了之后正确切换到mv封面了 但随即又切回了歌曲封面」。
   机制：跟随挂钩挂在 <audio> 的 loadedmetadata / play 上，一开始播放就跑
   syncMvBackgroundToSong → 按**这首歌自己的 source** 重新解析 MV；用户点的那支
   是从**搜索页当前音源**搜出来的（两者常常不是同一个平台，例如搜索源=酷狗而
   当前歌曲=QQ 解析池），解析结果往往是 null → 走 clearMvBackground() → MV 被清掉、
   露出下面的模糊封面 ⇒ 观感就是"随即又切回歌曲封面"。
   静止（暂停）时没有 play 事件、跟随不跑，所以"暂停时点 MV 就没事"。
   ⇒ 手动选择要**锁住当前这首歌**；换歌（key 变化）即解锁，恢复正常跟随。 */
let _manual = { active: false, songKey: '' };
/** 歌曲身份键（与 syncMvBackgroundToSong 的缓存键同一构造，勿各写一份）。
 *  ★ 2026-10-04：实现收到 services/playSource.js 的 songIdentityKey —— 此前这里
 *  写的是 `song.id || song.song`，而 175 主路径的对象**没有 `song` 字段**（只有 title），
 *  一旦 id 缺失键就塌缩成 `${src}::`，同平台所有缺 id 的歌共用一把键：切歌不换画面、
 *  手动点过一次后整批歌不再自动铺。详见 songIdentityKey 的注释与
 *  scratch/probe_mv_follow_event.mjs 的实测。 */
function songKeyOf(song) {
    return songIdentityKey(song, (typeof currentSource !== 'undefined' ? currentSource : ''));
}
/** 当前播放的歌曲对象（分片间靠 globalThis 共享，取不到就返回 null） */
function songOf() {
    return (typeof currentSongData !== 'undefined') ? currentSongData : null;
}

/* 元素惰性获取（101 在 index.js 里排得早，DOM 虽已就绪，但重挂载后引用会失效） */
function videoEl() {
    if (_video && _video.isConnected) return _video;
    _video = (typeof document !== 'undefined') ? document.getElementById('mvBgVideo') : null;
    if (_video) {
        _video.addEventListener('error', onVideoError);
        /* ★ 2026-10-03 起 MV 跟随歌曲进度（不再循环）：html 上的 loop 属性是
           "背景视频自己转"时代的遗留，这里兜底摘掉（用户机器上的 index.html
           未必跟着更新）。视频比音频短 → 在末帧定格，比跳回开头造成的音画错位好。 */
        _video.loop = false;
        /* ★ 2026-10-03 三修：preload 必须是 auto（html 里也从 none 改掉了）。
           `preload="none"` 时只赋 src 不会拉任何数据 → 暂停点 MV 时元素停在
           HAVE_NOTHING，**没有任何可显示的帧**（只剩 poster=歌曲封面），
           用户看到的就是「不播放、只显示封面」，而且 syncMvTime 因
           readyState<1 直接 return ⇒「切换进度也不换画面」。
           这个元素只用来铺 MV 背景，一次只有一支，预载是划算的；
           清掉 MV 时 src 会被摘掉，不会白拉。 */
        _video.preload = 'auto';
        /* 新 src 的元数据就绪 → 立刻对齐一次进度（否则切歌后 MV 从 0 秒开始） */
        _video.addEventListener('loadedmetadata', () => { syncMvTime(true); });
    }
    return _video;
}

/* 音频元素（播放器本体）。MV 跟随进度要读它的 currentTime / paused / playbackRate */
let _audio = null;
function audioEl() {
    if (_audio && _audio.isConnected) return _audio;
    _audio = (typeof document !== 'undefined') ? document.getElementById('audioPlayer') : null;
    return _audio;
}

function bgSettings() {
    const b = (typeof appSettings !== 'undefined' && appSettings && appSettings.background) || {};
    const dim = Number(b.mvDim);
    const blur = Number(b.mvBlur);
    return {
        /* 缺省视为**开**：点 MV 卡片是一次明确动作，默认关掉会让人以为功能坏了 */
        enabled: b.mvBg !== false,
        dim: Number.isFinite(dim) ? Math.max(0, Math.min(0.9, dim)) : 0.45,
        blur: Number.isFinite(blur) ? Math.max(0, Math.min(30, blur)) : 8,
        /* 画质增强（Anime4K 超分 + 去压缩伪影）。缺省视为**开** —— MV 源普遍是
           768x432 级别的低码率，全屏铺开后模糊/噪点肉眼可见，这正是它的用武之地。
           极端性能模式下由 applyMvBgSettings 自动跳过。 */
        upscale: b.mvUpscale !== false,
    };
}

function isExtremePerfMode() {
    if (typeof document === 'undefined') return false;
    const body = document.body;
    const root = document.documentElement;
    if (!body || !root) return false;
    return body.classList.contains('perf-minimal')
        || root.classList.contains('is-software-renderer')
        || Boolean(typeof window !== 'undefined' && window.__isSoftwareRenderer);
}

/** 落盘「用户明确要 MV」这个动作：开关关着时顺手打开。返回是否本次自动打开。 */
function autoEnableMvBg() {
    if (typeof appSettings === 'undefined' || !appSettings || !appSettings.background
        || appSettings.background.mvBg !== false) return false;
    appSettings.background.mvBg = true;
    try { saveSettings(); } catch (e) { logCatch('mvBackground', e); }
    return true;
}

/** 把当前设置（开关 / 压暗 / 模糊）落到 DOM 上。设置面板改动后必须调它。 */
export function applyMvBgSettings() {
    const v = videoEl();
    if (!v) return;
    const s = bgSettings();
    /* brightness 下限 0.1：全黑就没必要继续解码视频了，但也不能因为滑杆到底
       就让画面"闪白"——这里是压暗，只往下走。 */
    const filterCss = `blur(${s.blur}px) brightness(${Math.max(0.1, 1 - s.dim)})`;
    v.style.filter = filterCss;
    const cv = (typeof document !== 'undefined') ? document.getElementById('mvBgCanvas') : null;
    /* canvas 与 video 共用 .mv-background，压暗/模糊必须同样作用在它上面，
       否则开了画质增强后压暗滑杆就失效了。 */
    if (cv) cv.style.filter = filterCss;

    const on = s.enabled && !!_current && !!v.getAttribute('src')
        && !isRecentlyFailed(mvKeyOf(_current));
    setMvBgOn(on);

    /* ★ 画质增强（Anime4K）起停。失败/太慢会自己降级并广播事件回来重跑本函数，
       那时 mvUpscaleActive() 变 false，video 就恢复可见 —— 用户至少能看。 */
    const wantUp = on && s.upscale && mvUpscaleAvailable();
    if (wantUp) startMvUpscale();
    else stopMvUpscale();
    const upOn = on && mvUpscaleActive();
    /* 上行生效时 video 只当"解码源"：把画面交给 canvas，自己不再参与合成
       （visibility 不影响解码，texImage2D 取的仍是它的解码帧）。 */
    v.style.visibility = upOn ? 'hidden' : '';
    v.classList.toggle('visible', on && !upOn);

    if (on) {
        /* ★ 2026-10-03：MV 层是"歌曲的第二个视图"，播放状态必须跟着音频走 ——
           用户暂停 / 拖进度时 MV 要一起停、一起跳（这是"跟随进度"的另一半）。
           旧实现无条件 play()，于是暂停状态下 MV 自顾自播，切回来就音画不同步。 */
        const a = audioEl();
        if (a && a.paused) {
            try { v.pause(); } catch (e) { logCatch('mvBackground', e); }
            /* ★ 暂停态也要有画面：不调一次 load()，`preload` 若还是 none
               （老 index.html）就永远不会取流 → 只剩 poster。 */
            if (v.readyState === 0) { try { v.load(); } catch (e) { logCatch('mvBackground', e); } }
        } else {
            /* play() 可能因"用户手势未发生"被拒（本链路一定有点击，正常不会），
               失败只留痕，不往上抛——背景没播起来不该打断搜索页。 */
            const p = v.play();
            if (p && typeof p.catch === 'function') p.catch(e => logCatch('mvBackground', e));
        }
        syncMvTime(true);
    } else {
        try { v.pause(); } catch (e) { logCatch('mvBackground', e); }
    }
}

/* 上行渲染层自己降级时（渲染连续失败 / 单帧持续超预算）通知回来重跑设置 ——
   它不该直接改 video 的可见状态（那会绕过本函数这个"唯一真值"）。 */
if (typeof document !== 'undefined') {
    document.addEventListener('aria:mv-upscale-off', () => {
        try { applyMvBgSettings(); } catch (e) { logCatch('mvBackground', e); }
    });
    window.addEventListener('resize', () => { notifyMvUpscaleResize(); });
}

/* ============================================================
   MV 跟随歌曲进度（2026-10-03 用户需求）
   ------------------------------------------------------------
   用户原话：「既然 mv 都是一首歌的 id 对应一个 mvid 了，那是不是 mv 可以跟随歌曲
   进度来播放，而不是一直循环，避免用户暂停、切换进度导致音画不同步」。
   于是 MV 层从"独立的循环视频"改成"歌曲的第二个视图"：
     · play → MV 播；pause → MV 停；
     · seek（拖进度条 / 点歌词跳转）→ MV 跳到同一位置；
     · 倍速 → 同步 playbackRate，否则漂移会持续累积；
     · 播完不循环（视频比音频短就在末帧定格）。
   ★ 纠偏用**阈值**而不是每帧 seek：背景 MV 与歌曲本来就不是同一份介质
   （MV 常带几秒前奏/尾奏），逐帧对齐既追不准，又会给 CDN 打出大量 Range 请求。
   ============================================================ */

const MV_TIME_DRIFT = 0.35;   /* 秒：偏差超过它才纠正 */

/* ★ 2026-10-04 补：seek 预算。应用偏移后画面要跳到**尚未缓冲**的位置，
   seek 得等 CDN 回一段新数据；而 timeupdate 每 ~250ms 就再算一次新目标、
   再发一次 seek，后一次会把前一次打断 —— seek 永远完不成、画面永远出不来。
   偏移为 0 时压根不发 seek，所以这个坑此前一直没暴露（用户报的
   「MV 播不了了」就是这么来的）。窗口内超预算 = 这个偏移在这台机器上跑不动，
   回退到 0 —— 最多是不同步，绝不能黑屏。 */
const _seekBudget = makeSeekBudget(8, 10000);
function nowMs() { return Date.now(); }

/** 让 MV 的播放位置对齐音频。force=true 无条件对齐（seek 完 / 新元数据到位）。
 *  ★ 2026-10-04：加了 `_current.offset` —— 自动匹配的 MV 常常比歌曲多一段前奏
 *    （实测「成都」的 MV 比歌曲长 36s、音轨偏移 +41.28s），此时"MV 与歌曲同位置"
 *    这个前提根本不成立，无论怎么纠偏画面都是错的。offset 由 mvSync 用两轨的
 *    能量包络互相关算出来（见本文件下方"音画偏移检测"段）。没有它时恒为 0，
 *    行为与之前完全一致。 */
function syncMvTime(force) {
    const v = videoEl();
    const a = audioEl();
    if (!v || !a || !_current || !v.getAttribute('src')) return;
    if (v.readyState < 1) return;                        /* 元数据还没到，seek 会被忽略 */
    const dur = Number(v.duration);
    if (!isFinite(dur) || dur <= 0) return;
    const off = Number(_current.offset) || 0;
    const target = Math.max(0, Math.min(dur - 0.25, (Number(a.currentTime) || 0) + off));
    if (!force && Math.abs(v.currentTime - target) <= MV_TIME_DRIFT) return;
    /* ★ 上一次 seek 还没落地就别再发新的（见 _seekBudget 注释） */
    if (v.seeking) return;
    if (off && !_seekBudget.allow(nowMs())) {
        logWarn('mvBackground', '[MV] seek 过于频繁，判定该偏移在本机跑不动 → 回退正常播放');
        _current.offset = 0;
        _seekBudget.reset();
        return;
    }
    try { v.currentTime = target; } catch (e) { logCatch('mvBackground', e); }
}

/** 音频的播放状态 → MV 的镜像（只挂一次）。 */
function bindMvTimeSync() {
    const a = audioEl();
    if (!a || a.dataset.mvTimeBound === '1') return;
    a.dataset.mvTimeBound = '1';
    videoEl();   /* 确保 MV 元素（含 loop 摘除 / 元数据回调）已就绪 */
    const mirror = () => {
        if (!_current) return;
        const v = videoEl();
        if (!v || !v.getAttribute('src')) return;
        const rate = Number(a.playbackRate) || 1;
        if (v.playbackRate !== rate) {
            try { v.playbackRate = rate; } catch (e) { logCatch('mvBackground', e); }
        }
        if (a.paused) {
            try { v.pause(); } catch (e) { logCatch('mvBackground', e); }
        } else {
            const p = v.play();
            if (p && typeof p.catch === 'function') p.catch(e => logCatch('mvBackground', e));
            syncMvTime(false);
        }
    };
    a.addEventListener('play', mirror);
    a.addEventListener('pause', mirror);
    a.addEventListener('ratechange', mirror);
    /* seek：一次大跳必须立刻跟上（timeupdate 只有 ~4Hz，赶不上） */
    a.addEventListener('seeking', () => syncMvTime(true));
    a.addEventListener('seeked', () => syncMvTime(true));
    /* timeupdate ≈4Hz：只做阈值纠偏，兜住解码时钟的缓慢漂移；
       顺带跑一次「偏移观察窗」（应用了非零偏移后必须确认画面真的出来了） */
    a.addEventListener('timeupdate', () => { syncMvTime(false); checkOffsetWatch(); });
}

/* ============================================================
   MV 音画偏移检测（2026-10-04 用户需求）
   ------------------------------------------------------------
   用户原话：「自动匹配的 MV 有时候音画不同步，我想把 MV 里的音频和正在播放的
   音频对齐，算个偏移量来纠正画面，避免音画不同步。」
   根因：自动匹配的 MV 常常带一段前奏/尾奏（实测「成都」的网易 MV 比歌曲长 36s，
   音轨恒定偏移 **+41.28s**），于是 "video.currentTime = audio.currentTime" 这个
   前提本身就是错的 —— 再怎么纠偏画面都对不上。
   算法在 services/mvSync.js（8kHz 能量包络 + 归一化互相关，实测 r=0.92）。
   本节只负责**调度**，三条边界都是"宁可不算，也不能拖累播放"：
     · 每个 (MV, 歌曲) 组合只算一次 —— 结果进 localStorage，重复播放零成本；
     · 必须铺上并播了几秒才开跑 —— 用户快速切歌/来回点就不该付这 20MB 素材；
     · 极端性能模式 / 超长视频 / 任何失败 → 静默放弃，offset 保持 0 正常播放
       （用户原话："如果开销太大或者搞不定就放弃同步正常播放"）。
   ============================================================ */
const MV_OFFSET_DELAY = 15000;    /* 铺上后等这么久再开跑：躲开起播抖动、快速切歌，
                                     也让 MV 先缓冲出余量（否则等于跟自己的播放抢带宽） */
const MV_BUFFER_AHEAD_SEC = 15;   /* 要求已缓冲到当前位置前方这么多秒才开跑 */
let _offsetTimer = 0;
let _offsetJob = '';              /* 正在算的 key，防重入 */
/* 本会话已尝试过的 key → **上次尝试的时间戳**。
   ★ 2026-10-04 从 Set 改成 Map：原来一旦 add 就本会话永不重试，而 add 是在
   **发起检测之前**做的 —— 一次网络抖动/超时就让这首歌"永远不同步"，
   用户换个时间再听也不会重算。现在失败后 OFFSET_RETRY_MS 内不重复试，
   过了窗口再给一次机会；而判定完成的组合会写进 offset 缓存，
   下次直接由 applyCachedOffset 命中，不会再走到这里。 */
const _offsetTried = new Map();
const OFFSET_RETRY_MS = 30 * 60 * 1000;

/* ★ 总开关：设置页的「音画偏移矫正」（缺省开，见 config/defaults.js 的 mvSync），
   外加兼容旧的应急闸 localStorage `aria_mv_sync='off'` —— 用户明确说过
   "如果开销太大或者搞不定就放弃同步正常播放"，留一个一句话能关的后门。 */
const MV_SYNC_PREF_KEY = 'aria_mv_sync';
function mvSyncEnabled() {
    const b = (typeof appSettings !== 'undefined' && appSettings && appSettings.background) || {};
    if (b.mvSync === false) return false;
    try { return localStorage.getItem(MV_SYNC_PREF_KEY) !== 'off'; } catch { return true; }
}

/** 偏移缓存键：MV 身份 + 歌曲身份。两者任一变化都算新组合。 */
function offsetKeyOf() {
    if (!_current) return '';
    return `${mvKeyOf(_current)}|${songKeyOf(songOf())}`;
}

/* ============================================================
   偏移"观察窗"：算出来的偏移在**这首歌这支 MV 上是否成立**，只有真播一遍才知道。
   ------------------------------------------------------------
   用户报「MV 播不了了」之后补的。风险来源：把画面 seek 到未缓冲的位置后，
   若 CDN 迟迟不给数据，画面就会一直不出来。宁可误判成失败退回 0（最多是
   不同步），也绝不能让用户盯着一块永不刷新的画面。
   窗口内三条必须同时成立：不处于 seeking / 拿到可显示帧 / 位置真的在走。
   不成立 → offset 归 0 + 把这条缓存改写成 0（下次直接 0，不再重算）。
   ============================================================ */
let _offsetWatch = null;   /* { started, t0, seq } */

function armOffsetWatch() {
    if (!mvSyncEnabled()) return;
    const v = videoEl();
    _offsetWatch = {
        started: nowMs(),
        t0: v ? (Number(v.currentTime) || 0) : 0,
        seq: _loadSeq,
    };
}

function clearOffsetWatch() { _offsetWatch = null; }

function checkOffsetWatch() {
    if (!_offsetWatch) return;
    const v = videoEl();
    const a = audioEl();
    if (!v || !a || !_current || _offsetWatch.seq !== _loadSeq) { _offsetWatch = null; return; }
    const verdict = judgeAppliedOffset({
        readyState: v.readyState,
        seeking: v.seeking,
        advancedSec: (Number(v.currentTime) || 0) - _offsetWatch.t0,
        elapsedMs: nowMs() - _offsetWatch.started,
    });
    if (verdict.pending) return;
    _offsetWatch = null;
    if (verdict.ok) return;                      /* 画面正常，收工 */
    const badKey = offsetKeyOf();
    logWarn('mvBackground', `[MV] 偏移应用后画面异常(${verdict.reason}) → 回退正常播放`);
    if (badKey) writeOffsetCache(badKey, 0);      /* 记住"这条不能用"，别再让用户看一次 */
    if (badKey) _offsetTried.set(badKey, Date.now());
    if (_current) _current.offset = 0;
    _seekBudget.reset();
    syncMvTime(true);
}

/** 读缓存并立刻生效（命中时零网络请求）。 */
function applyCachedOffset() {
    const k = offsetKeyOf();
    if (!k || !_current || !mvSyncEnabled()) return false;
    const v = readOffsetCache(k);
    if (v === null) return false;
    _current.offset = v;
    syncMvTime(true);
    /* ★ 只给**真偏移**上观察窗：0 不会 seek，没什么可观察的 */
    if (v) armOffsetWatch(); else clearOffsetWatch();
    return true;
}

function scheduleOffsetDetect() {
    if (typeof setTimeout !== 'function') return;
    if (!mvSyncEnabled()) return;
    if (typeof clearTimeout === 'function') clearTimeout(_offsetTimer);
    _offsetTimer = setTimeout(() => { runOffsetDetect(); }, MV_OFFSET_DELAY);
}

/** 当前在 MV 里已经缓冲到「播放位置前方多少秒」（缓冲不足就别抢带宽）。 */
function bufferedAheadSec(v) {
    try {
        const t = Number(v.currentTime) || 0;
        for (let i = 0; i < v.buffered.length; i++) {
            if (v.buffered.start(i) - 0.5 <= t && t <= v.buffered.end(i) + 0.5) {
                return v.buffered.end(i) - t;
            }
        }
    } catch (e) { logCatch('mvBackground', e); }
    return 0;
}

/** MV 的**实际输出层**是否可见。
 *  ★ 开了画质增强时画面在 canvas 上、video 被摘掉 `.visible`（它退成解码源）——
 *  "看 video 的 class"只在一半的情况下成立。判"MV 还在不在"必须两个都看。 */
function mvLayerVisible() {
    const v = videoEl();
    if (v && v.classList.contains('visible')) return true;
    const cv = (typeof document !== 'undefined') ? document.getElementById('mvBgCanvas') : null;
    return !!(cv && cv.classList.contains('visible'));
}

/** 有没有必要跑这次检测（全部是"不懂就别跑"的前置条件）。 */
function needsOffsetDetect(v, a) {
    if (!mvSyncEnabled()) return false;
    if (!v || !a || !_current || !v.getAttribute('src')) return false;
    /* ★ 2026-10-04：这里原本写的是 `if (!v.classList.contains('visible')) return false`，
       而画质增强生效时 video 恰恰**没有** .visible（画面由 canvas 提供）⇒ 偏移检测
       永远不会跑。日志表现是「[MV] 画质增强已启用」之后**一条 [MV Sync] 都没有**。
       这正是用户报的「感觉还是音画不同步」的最终原因 —— 上一轮修 waitReady 的可见性
       判定时漏了这一处（同一个坑踩了两次）。 */
    if (!mvLayerVisible()) return false;                     /* 期间被清掉了 */
    if (isExtremePerfMode()) return false;
    if (typeof document !== 'undefined' && document.hidden) return false;
    if (v.readyState < 3) return false;                      /* 还在起播/卡顿中 */
    if (bufferedAheadSec(v) < MV_BUFFER_AHEAD_SEC) return false;  /* 缓冲余量不足，别抢带宽 */
    if (v.seeking) return false;
    /* ★ 时长闸门：MV 与歌曲时长几乎相等 ⇒ 没有前奏/尾奏问题 ⇒ 偏移必然是 0，
       一个字节都不用下（这一条把绝大多数歌挡在门外，是成本上的关键一刀）。 */
    if (!shouldAnalyzeOffset(Number(v.duration) || 0, Number(a.duration) || 0).analyze) return false;
    const songUrl = a.currentSrc || a.src || '';
    /* 本地文件没有"MV 前奏"这个问题，也不该为它多下 20MB */
    if (!/^https?:/i.test(songUrl)) return false;
    if (!_current.url) return false;
    return true;
}

async function runOffsetDetect() {
    const v = videoEl();
    const a = audioEl();
    if (!needsOffsetDetect(v, a)) {
        /* ★ 没跑成也要留一句可查的原因。用户报「还是不同步」时，第一件事就是分辨
           「压根没跑」与「跑了但判不出偏移」—— 前者是闸门/时机问题，后者是算法问题，
           修法完全不同，光看现象分不出来（此前这两种情况日志里都是**一片空白**）。
           ★ 本轮的真实教训：`mv-hidden`（画质增强把 video 摘成解码源）就属于
           「压根没跑」，而且整整一个版本都没被任何日志暴露出来。 */
        if (v && a && _current && mvSyncEnabled()) {
            const why = [];
            if (!mvLayerVisible()) why.push('mv-hidden');
            if (typeof document !== 'undefined' && document.hidden) why.push('page-hidden');
            if (v.readyState < 3) why.push('video-not-ready');
            if (bufferedAheadSec(v) < MV_BUFFER_AHEAD_SEC) why.push('buffer-low');
            if (v.seeking) why.push('seeking');
            if (isExtremePerfMode()) why.push('perf-mode');
            const d = shouldAnalyzeOffset(Number(v.duration) || 0, Number(a.duration) || 0);
            if (!d.analyze) why.push(d.reason);
            const songUrl = a.currentSrc || a.src || '';
            if (!/^https?:/i.test(songUrl)) why.push('no-song-url');
            if (!_current.url) why.push('no-mv-url');
            logInfo('mvBackground', `[MV] 跳过音画偏移矫正（${why.join('+') || '前置条件不满足'}）`);
        }
        return;
    }
    const key = offsetKeyOf();
    if (!key) return;
    if (applyCachedOffset()) return;
    /* 短期防重试（见 _offsetTried 的说明）：窗口内不重复算，过了窗口再给一次机会 */
    const lastTry = _offsetTried.get(key) || 0;
    if (_offsetJob || (Date.now() - lastTry < OFFSET_RETRY_MS)) return;
    _offsetTried.set(key, Date.now());
    _offsetJob = key;
    const seq = _loadSeq;
    try {
        const res = await detectMvOffset({
            mvUrl: _current.url,
            songUrl: a.currentSrc || a.src || '',
            mvDurSec: Number(v.duration) || 0,
            songDurSec: Number(a.duration) || 0,
        });
        /* 期间换了歌 / 清了 MV → 结果作废（已写缓存的仍可用，下次直接命中） */
        if (seq !== _loadSeq || !_current) return;
        if (!res || !res.ok || !res.offsetSec) return;
        _current.offset = res.offsetSec;
        writeOffsetCache(key, res.offsetSec);
        _seekBudget.reset();
        syncMvTime(true);
        armOffsetWatch();
        logInfo('mvBackground', `[MV] 音画偏移已纠正: +${res.offsetSec.toFixed(2)}s`);
    } catch (e) {
        logCatch('mvBackground', e);
    } finally {
        _offsetJob = '';
    }
}

/**
 * 把一张 MV 铺成动态背景。取址失败/极端性能模式不会抛异常，而是回一个带 reason 的结果，
 * 由调用方（搜索页）决定提示文案。
 * @param {{source:string,mvId:string,vid?:string,hash?:string,name?:string,singer?:string,cover?:string}} mv
 * @param {{force?:boolean, waitReady?:boolean}} [opts]
 *   force=true   绕过「刚失败过」的冷却（用户手动点卡片时用）
 *   waitReady=true 等真的拿到视频元数据才回话（搜索页点卡片用，好给如实文案）
 * @returns {Promise<{ok:boolean, reason?:string, name?:string}>}
 */
export async function setMvBackground(mv, opts) {
    const v = videoEl();
    if (!v || !mv) return { ok: false, reason: 'no-element' };
    if (isExtremePerfMode()) {
        logWarn('mvBackground', '[MV] 极端性能模式下跳过 MV 背景');
        return { ok: false, reason: 'perf' };
    }

    /* ★ 2026-10-03：刚失败过的同一支 MV，自动跟随不要再拉（见 MV_FAIL_COOLDOWN）。
       用户手动点卡片（opts.force）跳过这个冷却 —— 他明确想看，可能 CDN 已经恢复。 */
    if (!(opts && opts.force) && isRecentlyFailed(mvKeyOf(mv))) {
        logWarn('mvBackground', `[MV] 跳过冷却中的失败 MV: ${mv.name || mv.mvId}`);
        return { ok: false, reason: 'failed-recent' };
    }

    /* ★ 2026-10-03：同一支 MV 已经铺着就直接复用，**绝不重设 src**。
       跟随挂钩同时挂在 <audio> 的 loadedmetadata 与 play 上（从暂停恢复也会触发），
       而给 <video>.src 赋**同一个值**仍会重启资源选择算法 → 画面黑一下重新起播。
       实测观感就是用户报的「闪了下又回退封面」。
       ★ 但要求 v.error 为空：真播放失败时不能复用，要让下面的赋值重新走一次加载
       （媒体加载算法会把 error 清空），否则用户永远卡在失败状态。 */
    const same = _current && _current.source === mv.source
        && String(_current.mvId) === String(mv.mvId)
        && !!v.getAttribute('src') && !v.error;
    if (same) {
        if (!_current.cover && mv.cover) _current.cover = mv.cover;
        /* 手动点同一支也要续上锁（例如用户先点了别的、又点回来） */
        if (opts && opts.force) _manual = { active: true, songKey: songKeyOf(songOf()) };
        const autoEnabled = autoEnableMvBg();
        applyMvBgSettings();
        return { ok: true, name: _current.name || '', autoEnabled, reused: true };
    }

    const seq = ++_loadSeq;
    const url = await fetchMvUrl(mv);
    if (seq !== _loadSeq) return { ok: false, reason: 'stale' };  /* 期间又点了别的 MV */
    if (!url) {
        logWarn('mvBackground', `[MV] 取址失败: ${mv.name || mv.mvId}`);
        return { ok: false, reason: 'url' };
    }

    _current = {
        source: mv.source, mvId: mv.mvId, vid: mv.vid || '', hash: mv.hash || '',
        name: mv.name || '', singer: mv.singer || '', cover: mv.cover || '', url,
        /* ★ 2026-10-04：MV 音轨相对歌曲音轨的恒定偏移（秒）。见"音画偏移检测"段。 */
        offset: 0,
    };
    /* 这首歌 + 这支 MV 以前算过 → 立刻套用（零网络请求） */
    clearOffsetWatch();
    _seekBudget.reset();
    applyCachedOffset();
    v.poster = mv.cover || '';
    v.removeAttribute('data-mv-http-fallback');
    delete v.dataset.mvRetried;   /* 新一支 = 重试机会重置 */
    /* ★ 画质增强要求 video 走 CORS 模式（否则 WebGL 的 texImage2D 会因跨源
       抛 SecurityError）。实测酷狗/网易/QQ 的 MV CDN 都带 ACAO:*，所以正常能成；
       万一某支被拒（onVideoError 会摘掉 crossOrigin 重试），就记在 _noCorsFor 上，
       同一支不再重试 —— 代价只是这一支没有画质增强。
       ★ crossOrigin 必须在赋 src **之前**设置，之后再改不会生效。 */
    if (bgSettings().upscale && mvKeyOf(mv) !== _noCorsFor && mvUpscaleAvailable()) {
        v.crossOrigin = 'anonymous';
    } else {
        v.removeAttribute('crossorigin');
    }
    v.src = url;
    /* 真正开始重新加载 = 上一次的失败记录作废（否则 applyMvBgSettings 会因冷却期
       把刚铺上的这一支又藏起来）。若这次仍失败，onVideoError 会重新记上。 */
    _lastFail = { key: '', at: 0 };
    /* ★ 2026-10-04：挂超时守卫。error 事件抓不到「既不 error 也不出帧」的挂起形态
       （酷狗 https 证书不匹配在 Chromium 里就可能这样），那种情况只会显示 poster。 */
    armLoadTimeout();
    /* 手动点卡片 → 锁住当前这首歌，别让自动跟随再把它换掉/清掉（见 _manual 注释） */
    if (opts && opts.force) _manual = { active: true, songKey: songKeyOf(songOf()) };

    /* 开关关着时点 MV 卡片 = 明确表达了"我要看 MV 背景"，顺手打开并落盘 */
    const autoEnabled = autoEnableMvBg();
    applyMvBgSettings();
    /* 音画偏移检测：铺上并播几秒之后再开跑（见"音画偏移检测"段） */
    scheduleOffsetDetect();
    logInfo('mvBackground', `[MV] 动态背景已切换: ${mv.name || mv.mvId} (${mv.source})`);
    /* ★ opts.waitReady：等真的拿到元数据再回话。不然调用方只能报"已设为动态背景"，
       而用户那边其实只看到一个封面 —— 2026-10-04 用户报障的正是这个错位。 */
    if (opts && opts.waitReady) {
        const st = await waitPlayable(v, MV_LOAD_TIMEOUT + 2000);
        if (seq !== _loadSeq) return { ok: false, reason: 'stale' };
        if (st !== 'ready') {
            return { ok: false, reason: st === 'timeout' ? 'timeout' : 'load-error', name: mv.name || '' };
        }
        /* ★ 2026-10-04：判"到底有没有铺上"要看**实际输出层**。开了画质增强时
           画面在 canvas 上，video 反而被摘掉 visible（退成解码源）—— 只看 video
           的 class 会把成功判成失败（用户会看到"这支 MV 暂时取不到播放地址"）。 */
        const cvEl = (typeof document !== 'undefined') ? document.getElementById('mvBgCanvas') : null;
        const shown = v.classList.contains('visible') || !!(cvEl && cvEl.classList.contains('visible'));
        if (!shown) {
            return { ok: false, reason: _lastFailure.reason || 'load-error', name: mv.name || '' };
        }
    }
    return { ok: true, name: mv.name || '', autoEnabled };
}

/** 关掉 MV 背景（回到模糊封面背景）。不清 appSettings：下次点卡片仍按设置走。 */
export function clearMvBackground() {
    _loadSeq++;
    if (typeof clearTimeout === 'function') {
        clearTimeout(_loadTimer);
        clearTimeout(_offsetTimer);   /* 顺便取消还没开跑的偏移检测 */
    }
    _offsetJob = '';
    _offsetWatch = null;
    _seekBudget.reset();
    _current = null;
    /* 手动锁一并解除：这是"用户主动关掉"的路径，以后该跟随时还得能跟随 */
    _manual = { active: false, songKey: '' };
    /* 画质增强层一起收掉：留着 WebGL 上下文空转会一直占着显存与 GPU 时间 */
    disposeMvUpscale();
    const v = videoEl();
    if (v) {
        try { v.pause(); } catch (e) { logCatch('mvBackground', e); }
        v.removeAttribute('src');
        v.removeAttribute('data-mv-http-fallback');
        try { v.load(); } catch (e) { logCatch('mvBackground', e); }
        v.classList.remove('visible');
        v.style.visibility = '';
    }
    setMvBgOn(false);
}

/** 当前是否有 MV 正铺在背景上（设置开关 + 已选 MV + 元素有 src 三者同时成立） */
export function isMvBackgroundOn() {
    const v = videoEl();
    return !!(v && _current && v.classList.contains('visible'));
}

/** 当前 MV 描述符（供 UI 显示"正在用作背景"的选中态） */
export function getCurrentMv() {
    return _current;
}

/* ============================================================
   跟随播放：播放哪首歌就铺哪首歌的 MV（2026-10-03 用户需求）
   ------------------------------------------------------------
   合起来的语义（用户原话）：MV 动态背景开着时，
     · 播放一首歌 → 自动铺这首歌的 MV（如果有）；
     · 点 MV 卡片 → 立刻替换正在播的那支；
     · 切下一首 → 换成下一首的 MV；
     · 这首歌没有 MV → 清掉 MV 层，回落专辑封面背景（原有模糊背景照常）。
   ★ 只在「MV 动态背景」开关打开时才会走这条路 —— 关着时一次网络请求都不发。
   ★ 例外：用户**手动点过 MV 卡片**后，这首歌内不再自动接管（`_manual` 锁，见其注释）。
   ============================================================ */

let _followSeq = 0;      /* 跟随序号：连切歌时只认最后一次 */
/* ★ 解析结果缓存（key = source:id:mvVid）。<audio> 的 loadedmetadata 与 play
   会各触发一次跟随（"从暂停恢复"也算一次），没这个缓存每恢复一次播放就去
   搜一遍网易/酷狗的歌→MV。
   ★ 「没有 MV」这个**否定结果只缓存 8 秒**（2026-10-03 修）：命中 MV 是稳定事实，
   可以一直缓存；但 null 可能只是这一次搜索超时/限流，若永久缓存，用户会看到
   「这首歌明明有 MV 却一直没铺上」，而且再切回来也不重试。8 秒足够吃掉
   loadedmetadata + play 这对连发的重复请求，又不至于把一次瞬时失败锁死。
   是否重新加载由 setMvBackground 的复用判断独立决定 —— 所以播放失败后仍会重试。 */
const MV_NULL_CACHE_MS = 8000;
let _followCache = { key: '', mv: null, at: 0 };

/**
 * 解析"这首歌自己的 MV"。找不到返回 null。不碰 DOM。
 *
 * ★ 2026-10-04 大改：此前这里只有一条路 ——「拿歌名+歌手当关键词搜一次，再按歌名挑」，
 *   而搜索层（searchMvs → finalizeMvs）是**只按歌手筛**的，于是两个方向都翻车
 *   （召回差时整排丢空 / 歌手对得上时放进同歌手别的歌）。且歌曲对象自带的 MV id
 *   （网易 song.mv、QQ song.vid、酷狗 mvhash）只有 QQ 那条真正走了。
 *   现在整个匹配逻辑收口到 mvApi 的 `resolveMvForSong`（vendor → 本平台搜索 → 跨源），
 *   这里只做字段搬运，避免两处各写一份判据。
 *
 * @param {{source?,song?,title?,name?,singer?,artist?,cover?,mvId?,mvVid?,vid?,mvHash?}} song
 * @returns {Promise<Object|null>} mvApi 形状的 MV 描述符
 */
async function resolveSongMv(song) {
    if (!song) return null;
    const src = song.source || (typeof currentSource !== 'undefined' ? currentSource : '');
    if (!src) return null;
    try {
        const mv = await resolveMvForSong(src, {
            title: song.song || song.title || song.name || '',
            singer: song.singer || song.artist || '',
            cover: song.cover || '',
            mvId: song.mvId || '',
            mvVid: song.mvVid || song.vid || '',
            mvHash: song.mvHash || '',
            /* ★ QQ 的 songmid：没有 mvVid 时（歌单/最近播放/排行榜/歌手页进来的歌都
               拿不到 mvVid），mvApi 靠它去做歌曲搜索反查这首歌自己的 vid —— 见
               qqVidBySongSearch。对网易/酷狗无副作用（它们走 vendor/nvhash 或本平台搜索）。 */
            mid: song.mid || '',
        });
        if (mv) logInfo('mvBackground', `[MV] 匹配到 ${mv.name || mv.mvId}（${mv.via || '?'}·${mv.source}）`);
        return mv;
    } catch (e) {
        logCatch('mvBackground', e);
        return null;
    }
}

/**
 * 让 MV 背景跟随当前播放的歌曲。开关关着时直接返回、不发任何请求。
 * @param {Object} song 一般直接传 globalThis.currentSongData
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function syncMvBackgroundToSong(song) {
    if (!bgSettings().enabled) return { ok: false, reason: 'off' };
    const key = songKeyOf(song);
    /* ★ 用户手动选过背景 → 这首歌内不再自动接管（见 _manual 注释）。
       换歌（key 变了）才解锁并恢复正常跟随。
       ★ 手动点卡片时若还没有歌曲身份（key 为空，例如刚打开就点了 MV 卡片），
       就"认下"之后第一首拿到身份的歌曲，而不是立刻解锁让跟随把它清掉。 */
    if (_manual.active) {
        if (_manual.songKey && _manual.songKey === key) return { ok: true, reason: 'manual' };
        if (_manual.songKey) {
            /* 身份不同 = 换歌 → 解锁，恢复正常跟随 */
            _manual = { active: false, songKey: '' };
        } else {
            /* 手动点卡片时还没有歌曲身份（例如刚打开就点了 MV 卡片）→ 认下之后
               第一首拿到身份的歌曲，而不是立刻解锁让跟随把它清掉。
               ★ 只在 key 非空时认领：认下一把空键会把整批身份不明的歌一起锁死，
               那正是「点过一次 MV 之后再也不自动匹配」的成因之一（见 songKeyOf）。 */
            if (key) _manual.songKey = key;
            return { ok: true, reason: 'manual' };
        }
    }
    const seq = ++_followSeq;
    let mv = null;
    /* 同一首歌的重复触发直接吃缓存（见 _followCache 注释）：命中 MV 永久有效，
       未命中只认 8 秒。key 为空（拿不到歌曲身份）时不缓存，宁可多解析一次。 */
    const fresh = key && _followCache.key === key
        && (!!_followCache.mv || (Date.now() - _followCache.at) < MV_NULL_CACHE_MS);
    if (fresh) {
        mv = _followCache.mv;
    } else {
        try { mv = await resolveSongMv(song); } catch (e) { logCatch('mvBackground', e); }
        if (seq !== _followSeq) return { ok: false, reason: 'stale' };   /* 期间又切歌了 */
        if (key) _followCache = { key, mv, at: Date.now() };
    }
    if (seq !== _followSeq) return { ok: false, reason: 'stale' };
    if (mv) return setMvBackground(mv);
    /* 这首歌没有 MV（或解析失败）→ 回到封面背景。不报错、不打扰：这是常态而非故障。 */
    if (_current) logInfo('mvBackground', '[MV] 当前歌曲没有 MV，回落封面背景');
    clearMvBackground();
    return { ok: false, reason: 'no-mv' };
}

/* ★ https 直链失败回落 http（2026-10-03）：本机页面是 http://localhost:8001，
   http 直链本就能播；升 https 是为了兼容手机遥控那种 https 页面。万一某条 CDN
   的 https 端点不通（酷狗 kgv 系换协议不一定通），就把 http 那版再试一次。
   只回落一次，避免 error → 换 src → error 的无限循环。 */
function onVideoError() {
    const v = videoEl();
    if (!v || !_current) return;
    const cur = v.getAttribute('src') || '';
    /* ★ 2026-10-04：CORS 回退。为了让 WebGL 能对 MV 取帧，video 带了
       crossOrigin="anonymous"；个别 CDN 若不回 ACAO，浏览器会**直接判加载失败**。
       这与"这条链本身坏了"性质不同 —— 摘掉 crossOrigin 重来一次就能正常播，
       代价只是这一支没有画质增强。同一支只试一次（记 _noCorsFor），避免反复重载。 */
    if (v.crossOrigin === 'anonymous') {
        _noCorsFor = mvKeyOf(_current);
        v.removeAttribute('crossorigin');
        logWarn('mvBackground', '[MV] 跨源取样被拒，去掉 crossOrigin 重试（本支不做画质增强）');
        stopMvUpscale();
        if (cur) {
            v.src = cur;
            retryPlay(v);
            armLoadTimeout();
        }
        return;
    }
    if (v.dataset.mvHttpFallback === '1' || !cur.startsWith('https://')) {
        /* ★ 2026-10-04：一次 error ≠ 这支 MV 坏了。实测酷狗 http 直链的首帧
           探测偶尔会被 CDN 拒一次，浏览器随后重试即好；以前这里一遇 http 就判死，
           于是「地址明明能用却报取不到播放地址」。给一次重试机会（换 src 时清标记），
           第二次仍失败才真判死 —— 不会形成死循环。 */
        if (cur && v.dataset.mvRetried !== '1') {
            v.dataset.mvRetried = '1';
            logWarn('mvBackground', '[MV] 首次加载失败，重试一次');
            setTimeout(() => {
                const vv = videoEl();
                if (!vv || !_current) return;
                vv.src = cur;
                retryPlay(vv);
                armLoadTimeout();
            }, 350);
            return;
        }
        logWarn('mvBackground', `[MV] 视频加载失败: ${_current.name} ${cur.slice(0, 80)}`);
        /* ★ 2026-10-03：彻底失败 → 记住并**收起 MV 层**（回落到专辑封面背景）。
           留着 visible 只会是一块透明玻璃板压在封面上，浏览器还会继续空转解码；
           收起后视觉与「本来就是封面背景」完全一致。 */
        clearTimeout(_loadTimer);
        failMv('load-error');
        return;
    }
    v.dataset.mvHttpFallback = '1';
    const httpUrl = cur.replace(/^https:\/\//, 'http://');
    logWarn('mvBackground', '[MV] https 直链不可用，回落 http 重试');
    v.src = httpUrl;
    retryPlay(v);
    armLoadTimeout();
}

/* 窗口不可见时暂停解码（背景视频是纯 GPU/带宽开销，藏起来就该停） */
if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        const v = videoEl();
        if (!v || !_current) return;
        if (document.hidden) {
            try { v.pause(); } catch (e) { logCatch('mvBackground', e); }
        } else if (isMvBackgroundOn()) {
            /* 回来时别直接 play()：音频可能仍是暂停态（跟随进度要求两者一致），
               交给 applyMvBgSettings 按 audio.paused 决定播还是停。 */
            applyMvBgSettings();
        }
    });
}

/* ★ 曲目切换的自动跟随挂钩（2026-10-03）。
   为什么挂在 <audio> 的 loadedmetadata 上、而不是去逐个改十几处 currentSongData 赋值：
   它是**所有播放路径共有的**「新音源已就绪」信号（在线取链、本地文件、搜索页点播
   都会各自 audio.src = …; audio.load()），一处挂钩即全覆盖，也不会漏掉将来新增的路径。
   ★ 用 loadedmetadata 而不是 play：自动播放策略可能把 play 挂起，但元数据一定先到位；
   ★ 再补一个 'play' 兜底：用户手动恢复播放时（如从暂停中切歌）也能对齐一次。
   两个事件都可能连续触发，syncMvBackgroundToSong 内部靠加载序号去重，不会重复拉流。 */
if (typeof document !== 'undefined') {
    const bindFollow = () => {
        const a = document.getElementById('audioPlayer');
        if (!a || a.dataset.mvFollowBound === '1') return;
        a.dataset.mvFollowBound = '1';
        const sync = () => {
            const song = (typeof currentSongData !== 'undefined') ? currentSongData : null;
            if (!song) return;
            /* 没开开关 → 一次请求都不发（syncMvBackgroundToSong 内部已判，这里提前挡掉省一次调用） */
            if (!bgSettings().enabled) return;
            syncMvBackgroundToSong(song);
        };
        a.addEventListener('loadedmetadata', sync);
        a.addEventListener('play', sync);
        /* ★ 同一处收口：把「MV 跟随进度」（play/pause/seek/倍速）也挂上 */
        bindMvTimeSync();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindFollow, { once: true });
    else bindFollow();
}

/** 把当前这支 MV 已应用的偏移收回 0（设置页关掉「音画偏移矫正」时调用）。
 *  只清 offset 不够 —— 画面还停在偏移位置上，必须让它重新对齐一次。 */
export function resetMvOffset() {
    if (_current) _current.offset = 0;
    clearOffsetWatch();
    _seekBudget.reset();
    syncMvTime(true);
}

if (typeof Aria !== 'undefined') {
    Aria.setMvBackground = setMvBackground;
    Aria.clearMvBackground = clearMvBackground;
    Aria.isMvBackgroundOn = isMvBackgroundOn;
    Aria.getCurrentMv = getCurrentMv;
    Aria.applyMvBgSettings = applyMvBgSettings;
    Aria.syncMvBackgroundToSong = syncMvBackgroundToSong;
    Aria.resetMvOffset = resetMvOffset;
    /* 画质增强层的开关与降级复位（设置面板用；都走 Aria 命名空间惰性调用，
       分片之间不加静态依赖 —— 与 openArtist / applyMvBgSettings 同一套装配方式） */
    Aria.disposeMvUpscale = disposeMvUpscale;
    Aria.resetMvUpscaleGuard = resetMvUpscaleGuard;
    /* ★ 音画偏移同步的应急闸：Aria.setMvSyncEnabled(false) 立刻把 offset 归 0
       并彻底停掉检测（落盘，重启也保持）。用户若觉得 MV 播放被它影响，一句话关掉。 */
    Aria.setMvSyncEnabled = (on) => {
        try { localStorage.setItem(MV_SYNC_PREF_KEY, on ? 'on' : 'off'); } catch (e) { logCatch('mvBackground', e); }
        if (!on) {
            if (typeof clearTimeout === 'function') clearTimeout(_offsetTimer);
            _offsetWatch = null;
            _offsetJob = '';
            _seekBudget.reset();
            if (_current) { _current.offset = 0; syncMvTime(true); }
            logInfo('mvBackground', '[MV] 音画偏移同步已关闭');
        } else {
            scheduleOffsetDetect();
            logInfo('mvBackground', '[MV] 音画偏移同步已开启');
        }
        return mvSyncEnabled();
    };
    Aria.isMvSyncEnabled = mvSyncEnabled;
}
