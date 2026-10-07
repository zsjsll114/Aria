/* ============================================================
 * 96-automix.js — Automix 接线分片
 *
 * 把 core/automix 的 scheduler/crossfader 接到播放链上：
 *   · play 常驻监听 → notifyTrackStarted（A 起播即后台分析，IndexedDB 秒回）
 *   · timeupdate 常驻监听 → onTimeUpdate（ARM 窗口判定）
 *   · 在线下一曲 ARM 期即时解析：175 预载命中 → fetchPlayUrlForPreload
 *     解析链 → getStreamCachedAudioUrl 流代理包装（直链有时效，绝不用搜索期旧链）
 *   · 交叉完成 → applyTrackMetadataAfterSwap（135）元数据/UI 同步；
 *     在线曲再补歌词（fetchLyricWithFallback → renderLyrics）
 *
 * 全部常驻监听走 dualDeck 搬运表：swap 后监听自动跟新活跃元素，
 * timeupdate 驱动的是「新 A 的下一轮 ARM」。
 *
 * ★ 开关：appSettings.playback.automix.enabled，**默认关闭**——未开启时
 *   本分片所有入口短路（timeupdate 开销 ≈ 一次函数调用），行为零变化。
 * ============================================================ */
import { audio } from './20-lyrics-render.js';
import { computeStepTrack } from './95-track-loading.js';
import { applyTrackMetadataAfterSwap } from './135-crossfade.js';
import { getStreamCachedAudioUrl } from './180-boot-config.js';
import { fetchPlayUrlForPreload, getPreloadedOnlineUrl, loadLyricsAfterAutomixSwap } from './175-track-index-online.js';
import { platformKeyOf } from '../services/playSource.js';
import { intervalToSec } from '../services/musicApi.js';
import { registerAudioListener, getActiveAudio } from '../core/dualDeck.js';
import { initScheduler, notifyTrackStarted, onTimeUpdate as automixOnTimeUpdate } from '../core/automix/scheduler.js';
import { logInfo, logCatch } from '../services/log.js';

/* ★ 诊断锚点：确认前端确实加载了 automix 分片（此前"改了没效果"实为
   旧前端未重载）。控制台看到这行 = 新代码已生效。稳定后可移除。 */
logInfo('automix', '分片已加载（v3：起播预分析下一曲 + 60s 分析超时）');

function automixEnabled() {
    try {
        /* ★ 原生输出（WASAPI 独占）接管播放时必须让位：原生引擎目前只有一条 deck，
           双 deck 交叉无处安放（Automix Phase 2d 才补）。不让位的话 swapRoles 会把
           影子 HTML 元素顶成活跃 deck——声音在用户毫无察觉的情况下从原生引擎
           切回浏览器，而 UI 什么都不说。
           标由 app/298 挂；这里只是**运行期闸门**，不动用户偏好——
           关掉原生输出后 Automix 自动恢复。 */
        if (typeof Aria !== 'undefined' && Aria && typeof Aria.__nativeOutputActive === 'function'
            && Aria.__nativeOutputActive()) return false;
        const cfg = appSettings && appSettings.playback && appSettings.playback.automix;
        return !!(cfg && cfg.enabled);
    } catch { return false; }
}

/* 交叉进度 → 封面/背景过渡（Apple Music 式「随进度淡入淡出」）。
   用 sin(p·π) 做「先沉后升」的下沉量：p=0 不动、p=0.5（交接点）最深、p=1 复原。
   它正好与 setCoverImage 的 0.4s 交叉淡入接力——交接点封面最暗时新封面开始淡入，
   观感是渐变过去，而不是「啪一下换掉」。
   交叉结束（p=1）后再留 300ms 才摘 class，让最后一帧的下沉有余量落回 0。 */
let _vizClearTimer = null;
let _lastDip = -1;
function applyCrossfadeVisual(p) {
    try {
        if (typeof document === 'undefined' || !document.body) return;
        const clamped = Math.max(0, Math.min(1, p));
        if (_vizClearTimer) { clearTimeout(_vizClearTimer); _vizClearTimer = null; }
        document.body.classList.add('automix-crossing');
        const dip = Math.sin(clamped * Math.PI);
        /* 只在真正变化时写 CSS 变量：每帧 setProperty 会让样式重算空转 */
        if (Math.abs(dip - _lastDip) > 0.004) {
            _lastDip = dip;
            document.documentElement.style.setProperty('--automix-dip', dip.toFixed(4));
        }
        if (clamped >= 1) {
            _vizClearTimer = setTimeout(() => {
                _vizClearTimer = null;
                _lastDip = -1;
                if (document.body) document.body.classList.remove('automix-crossing');
                document.documentElement.style.removeProperty('--automix-dip');
            }, 300);
        }
    } catch (e) { logCatch('automix', e); }
}

initScheduler({
    isEnabled: automixEnabled,
    /* ★ 队列条目字段名不统一（title/song/name、artist/singer）——榜单 / 自建歌单 /
       历史播放的「播放全部」推进来的是原始接口对象，队列里就是 {song, singer} 形状。
       归一由 scheduler 统一做（core/automix/scheduler.js 的 _normTrack），所以传进去的
       条目、以及回调里拿到的 track，title/artist 一定已补全。 */
    getCurrentTrack: () => {
        try { return (playlist.length > 0 && playlist[currentTrackIndex]) || null; }
        catch { return null; }
    },
    getNextTrack: () => {
        try {
            const n = computeStepTrack(1);
            return (n && (n.kind === 'local' || n.kind === 'online'))
                ? { track: n.track, index: n.index } : null;
        } catch { return null; }
    },
    resolveTrackUrl: (track) => {
        try {
            const u = getStreamCachedAudioUrl(track.url, track.mid || track.id || track.title);
            if (u) return u;
            /* 在线曲 track.url 常为空/旧链——分析当前活跃元素正在播的地址
               （通知时它就是这首），保证 A 的后台分析不因 url 缺失而跳过 */
            const a = getActiveAudio();
            return (a && a.src) || '';
        } catch { return (track && track.url) || ''; }
    },
    /* ARM 期即时解析在线下一曲（直链时效敏感，绝不复用搜索期旧链）：
       175 的 nextSongPreload 命中优先（播放期间已预热、零网络），否则走完整解析链。
       ★ track 由 scheduler 归一过（title/artist 已补），可直接当 songName 用——
       songName 是 fetchPlayUrlForPreload 里「跨源同名歌兜底」的守卫条件，
       为空会让酷狗→网易→酷我整条退路失效（真机日志：解析链返回空 → 放弃本轮 ARM）。 */
    resolveOnlinePlayUrl: async (track) => {
        try {
            let raw = getPreloadedOnlineUrl(track);
            if (!raw) {
                raw = await fetchPlayUrlForPreload(String(track.id), track.mid || '',
                    platformKeyOf(track.source) || (track.mid ? 'tencent' : 'netease'),
                    track.title, intervalToSec(track.interval) || track.duration || 0, track.artist || '');
            }
            if (!raw) return '';
            return getStreamCachedAudioUrl(raw, track.id || track.title) || '';
        } catch { return ''; }
    },
    /* 运行时探测 Aria.abLoop（294 求值序在本分片之后，静态 import 会被 hoist
       提前求值 294——没必要冒险，AB 循环只在 ARM 判定里读一次状态） */
    isAbLoopActive: () => {
        try {
            const L = (typeof Aria !== 'undefined' && Aria.abLoop) || null;
            return !!(L && typeof L.state === 'function' && L.state().mode !== 'off');
        } catch { return false; }
    },
    onSwappedMeta: ({ plan, next }) => {
        if (!next) return;
        applyTrackMetadataAfterSwap(next.track, next.index);
        if (next.track.source || next.track.id) loadLyricsAfterAutomixSwap(next.track);
        logInfo('automix', `已交接：${next.track.title || next.index}（重叠 ${Math.round((plan && plan.overlapMs || 0) / 1000)}s）`);
    },
    /* 交叉进度 → 封面/背景的过渡动画（见 applyCrossfadeVisual） */
    onCrossfadeProgress: (p) => applyCrossfadeVisual(p),
});

/* A 起播 → 后台分析（automix 关闭时 notifyTrackStarted 自行短路） */
registerAudioListener('play', () => {
    try {
        if (!automixEnabled()) return;
        notifyTrackStarted(playlist[currentTrackIndex], true);
    } catch (e) { logCatch('automix', e); }
});

/* timeupdate → ARM 窗口判定（同上，关闭时一次函数调用） */
registerAudioListener('timeupdate', () => {
    try { automixOnTimeUpdate(); } catch (e) { logCatch('automix', e); }
});

void audio; /* audio 仅作求值顺序依赖：确保 20 分片（含 dualDeck init）先于本分片 */
