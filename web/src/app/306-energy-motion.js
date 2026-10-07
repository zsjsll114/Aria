/* ============================================================
 * 306-energy-motion.js — 音频能量驱动的视觉微动效（需求 19）
 *
 * 低频强 → 封面轻微放大（**硬上限 +2%**，见 core/energyMotion.js）→ 光晕增强 → 再回弹。
 * 刻意**不新增频谱模式**：它只是给现有画面加一层几乎察觉不到的呼吸。
 *
 * ── 能量从哪来（这是本项最需要说清楚的一点）────────────────────
 * 需求原文写的是"Rust 后端 FFT 提取低频能量"。Rust 侧目前**没有任何能量出口**
 * （`native_audio.rs` 的快照 DTO 里只有 playing/position/rate/volume/buffered_frames
 * /underruns/decoding，无能量字段；也没有 fft 依赖）。所以本条按**前端可实现**的方案做，
 * 并留好 Rust 侧的插口：
 *   · 来源 A（默认，已在用）：`window.playerAudioAnalyser` —— core/equalizer.js 建音频图时
 *     挂在链路末端的那颗 AnalyserNode（fftSize=128）。它是全库唯一现成的实时频谱出口
 *     （DimensionAudio 也在读它）。
 *   · 来源 B（预留）：`Aria.energyMotion.push(level)` —— 将来 Rust 侧出 FFT 后，
 *     一行调用即可接上，本分片不用改。
 *
 * ★ 因此有一条**必须知道的边界**：走原生 WASAPI 独占输出时音频不过 WebAudio 图，
 *   来源 A 没有数据 → 效果静默不生效（不是坏了）。这正是"要不要 Rust 侧出能量"的
 *   唯一真实动机，也是将来接来源 B 的原因。
 *
 * ── 为什么用 `scale` 而不是 `transform: scale()` ────────────────
 *   `.song-cover` 已经有 `transform: scale(1.04)` 的悬停效果与交叉淡入的
 *   `transition: transform ...`。用 transform 会把那条悬停变换**顶掉**；
 *   而 `scale` 是独立的 CSS 属性，与 transform 相乘叠加，互不干扰。
 *
 * ── 低成本保证 ────────────────────────────────────────────────
 *   ① 值量化到 0.01 才写 CSS 变量（避免每帧都触发样式重算）；
 *   ② 低配/极简档、软件渲染、`prefers-reduced-motion` 下**整层不生效**；
 *   ③ 暂停时目标能量直接给 0（不会挂着最后一次的高值让封面一直涨着）。
 * ============================================================ */
import { createEnergyMotion, lowEnergyFromFreqData } from '../core/energyMotion.js';
import { getActiveAudio } from '../core/dualDeck.js';
import { logCatch } from '../services/log.js';

const TAG = 'energyMotion';
const STYLE_ID = 'aria-energy-motion-style';

const motion = createEnergyMotion();

let _freq = null;
let _raf = 0;
let _pushed = null;
let _doneLevel = -1;
let _doneScale = -1;
let _gateAt = 0;
let _blocked = false;
let _manualOff = false;

/** 用户开关（缺省开；显式 false 才关） */
function isEnabled() {
    if (_manualOff) return false;
    try {
        const s = (typeof globalThis !== 'undefined') ? globalThis.appSettings : null;
        const iface = s && s.interface;
        return !iface || iface.energyMotion !== false;
    } catch { return true; }
}

/** 低配/软件渲染/减少动效 → 整层不生效（每秒复核一次，性能档是可运行的） */
function refreshGate(now) {
    if (now - _gateAt < 1000) return _blocked;
    _gateAt = now;
    try {
        const body = typeof document !== 'undefined' ? document.body : null;
        const root = typeof document !== 'undefined' ? document.documentElement : null;
        const lowPerf = !!body && (body.classList.contains('perf-low') || body.classList.contains('perf-minimal'));
        const soft = !!root && (root.classList.contains('is-software-renderer') || Boolean(globalThis.__isSoftwareRenderer));
        const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        _blocked = lowPerf || soft || reduce;
    } catch { _blocked = false; }
    return _blocked;
}

function injectStyle() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    /* 只在 html#ariaRoot.is-energy-motion 下生效 —— 这个类由本分片按"开关 + 性能门"加，
       所以低配/减少动效设备上连规则匹配都进不去，不存在"忘了降级"的口子。
       放大倍率走 --aria-energy-scale（1.00~1.02），光晕强度走 --aria-energy（0~1）。 */
    style.textContent = `
html#ariaRoot.is-energy-motion .player-container .cover-area .song-cover,
html#ariaRoot.is-energy-motion .player-container .bottom-song-cover {
    scale: var(--aria-energy-scale, 1);
}
html#ariaRoot.is-energy-motion .player-container .cover-area {
    filter: drop-shadow(0 0 calc(2px + 14px * var(--aria-energy, 0)) rgba(var(--aria-accent-rgb), calc(0.06 + 0.22 * var(--aria-energy, 0))));
}
`;
    (document.head || document.documentElement).appendChild(style);
}

function setClass(on) {
    try {
        const root = document.documentElement;
        if (!root) return;
        root.classList.toggle('is-energy-motion', !!on);
    } catch (e) { logCatch(TAG, e); }
}

function writeVars(level, scale) {
    const l = Math.round(level * 100) / 100;
    const s = Math.round(scale * 10000) / 10000;
    if (l === _doneLevel && s === _doneScale) return;
    _doneLevel = l;
    _doneScale = s;
    try {
        document.documentElement.style.setProperty('--aria-energy', String(l));
        document.documentElement.style.setProperty('--aria-energy-scale', String(s));
    } catch (e) { logCatch(TAG, e); }
}

/** 取这一帧的原始低频能量（0~1）。返回 null 表示"当前没有能量来源"。 */
function readRaw() {
    /* 来源 B：外部推送（Rust FFT 接上来时走这条，优先级最高） */
    if (_pushed !== null && _pushed !== undefined) {
        const v = _pushed;
        _pushed = null;
        return v;
    }
    /* 暂停/停止时不消费频谱（否则会挂着最后一帧的高能量） */
    try {
        const a = getActiveAudio();
        if (a && a.paused) return 0;
    } catch (e) { logCatch(TAG, e); }
    /* 来源 A：现有音频图的 AnalyserNode */
    try {
        const an = (typeof window !== 'undefined') ? window.playerAudioAnalyser : null;
        if (!an) return null;
        if (!_freq || _freq.length !== an.frequencyBinCount) _freq = new Uint8Array(an.frequencyBinCount);
        an.getByteFrequencyData(_freq);
        return lowEnergyFromFreqData(_freq);
    } catch (e) {
        logCatch(TAG, e);
        return null;
    }
}

function frame(now) {
    _raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(frame) : 0;
    try {
        const on = isEnabled() && !refreshGate(now);
        setClass(on);
        if (!on) {
            motion.reset();
            writeVars(0, 1);
            return;
        }
        const raw = readRaw();
        /* 没有来源就当作安静：包络自然回落到 0，而不是冻在最后的值上 */
        const st = motion.update(raw === null ? 0 : raw, now);
        writeVars(st.level, st.scale);
    } catch (e) {
        logCatch(TAG, e);
    }
}

/* ---------------- 对外接口 ---------------- */

/** 供 Rust 侧 / 其它模块推送能量（0~1）。留这个口子，将来接 FFT 不必改本文件。 */
function pushEnergy(level) {
    const n = Number(level);
    if (!Number.isFinite(n)) return;
    _pushed = n < 0 ? 0 : (n > 1 ? 1 : n);
}

/** 手动开关（暂无设置项；供控制台/探针与将来接 UI 用） */
function setEnabled(on) {
    _manualOff = (on === false);
    if (_manualOff) { motion.reset(); writeVars(0, 1); setClass(false); }
}

function getState() {
    return {
        level: motion.level,
        scale: _doneScale,
        enabled: isEnabled(),
        blocked: _blocked,
        source: (typeof window !== 'undefined' && window.playerAudioAnalyser) ? 'analyser' : (typeof window !== 'undefined' ? 'none' : 'none'),
    };
}

if (typeof document !== 'undefined') {
    injectStyle();
    /* 首帧起循环。rAF 在后台标签页会被浏览器自动降频/暂停，不需要额外处理。 */
    if (typeof requestAnimationFrame === 'function') {
        _raf = requestAnimationFrame(frame);
    }
}

if (typeof window !== 'undefined') {
    window.Aria = window.Aria || {};
    window.Aria.energyMotion = { push: pushEnergy, setEnabled, state: getState };
}

export { pushEnergy, setEnabled, getState };
