/* ============================================================
 * 298-native-output.js — 「WASAPI 独占输出」开关与原生引擎接管（原生输出线 Phase 2b）
 *
 * 一句话：设置 → 音效 → 输出 → 打开「WASAPI 独占输出」，把播放整体交给
 * Rust 侧 `aria-audio` 引擎（WASAPI 独占直通声卡），关掉就回到 WebView2 的
 * `<audio>` 元素。
 *
 * ── 五个不显然的决定 ──────────────────────────────────────────
 *
 * 1. **开关必须先做「端到端体检」，不能只看格式协商。**
 *    本机实测存在这种组合：驱动说支持、`Initialize` 返回 S_OK、`Write` 也不报错，
 *    但端点**永远不消费缓冲**——声音一个字节都没有。只看 `IsFormatSupported`
 *    会给一个乐观的错答案，所以走 `native_audio_check_exclusive`（真开一次、
 *    启动、确认端点消费）。失败时开关**拒绝打开**并把引擎给的原因原样贴出来，
 *    而不是先打开再说。体检最长约 600ms，所以走 async 命令 + spawn_blocking。
 *
 * 2. **顶替的是「活跃 deck」，不是「audio 变量」。**
 *    30 个分片读的是 20-lyrics-render 的 `audio` live binding，但**常驻监听**
 *    （play/pause/ended/timeupdate…）是挂在元素实例上的。只改绑定不改监听，
 *    表现是「界面正常但按钮全没反应」。所以统一走 20 的 `setActiveAudio()`
 *    → `dualDeck.replaceActiveDeck()` 成对搬运。这是本文件唯一的重型操作。
 *
 * 3. **切换时要把正在播的那首歌搬过去。** 用户在播放中途打开开关，不该从头开始：
 *    记下 src / 位置 / 是否在播，换完 deck 后重载并 seek 回原位。
 *
 * 4. **Automix 必须显式让位，不能静默出错。**
 *    原生引擎目前只有一条 deck（Phase 2d 才做交叉混音），Automix 的
 *    `swapRoles()` 会把影子 HTML 元素顶成活跃 deck → 声音从原生引擎切回浏览器，
 *    而界面毫无提示。所以用 `Aria.__nativeOutputActive` 让 automix 的
 *    isEnabled 返回 false（96-automix 里一行判断），**不改用户偏好**——
 *    关掉原生输出后 Automix 自动恢复。
 *    ★ 变速（playbackRate）**不再是缺口**（2026-10-05 起）：引擎在「解码 → ring」
 *    之间按 rate 做分数重采样，设置经 `rateProvider` 下发，独占模式下真的会变速，
 *    所以原来那句「原生独占模式暂不支持变速」的提示已撤除。
 *
 * 5. **偏好存 localStorage，不进 user_config.json。** 与输出设备（core/audioOutput）
 *    同一条理由：独占模式是本机专属的（同一台机器上换个声卡就完全不同），
 *    塞进会被导出/导入的配置属于数据污染；`aria_eq_custom` 已有先例。
 * ============================================================ */
import { state } from '../infrastructure/state.js';
import { volumePercentToGain } from '../utils/volumeCurve.js';
import { translatePhrase } from '../core/i18n.js';
import { getActiveAudio } from '../core/dualDeck.js';
import { isNativeDeck, createNativeDeck } from '../core/nativeDeck.js';
import * as bridge from '../core/nativeBridge.js';
import { crossfaderPhase, abortCrossfade } from '../core/automix/crossfader.js';
import { setActiveAudio } from './20-lyrics-render.js';
import { showSettingsHint } from './220-shortcuts-viewmode.js';
import { logInfo, logWarn, logCatch } from '../services/log.js';

const TAG = 'nativeOutput';

/** 开关偏好（'1' = 用户希望用独占）。★ 不进 user_config.json，理由见文件头 5 */
const EXCLUSIVE_KEY = 'aria_native_audio_exclusive';
/** 原生模式下的设备偏好。**与 Chromium 的 aria_audio_output_device 分开存**：
 *  两边的 id 命名空间不同（WebView2 deviceId vs WASAPI 端点 id），
 *  混在一个键里会让网页版下拉读到无法识别的 id。 */
const DEVICE_KEY = 'aria_native_audio_device';

/**
 * 体检用的采样率。
 *
 * 为什么是 44.1k 而不是「当前歌曲的采样率」：这里查的是**通路**能不能出声
 * （见文件头 1），而真正的采样率在每次加载时由引擎按源文件协商
 * （`open_exclusive` 用源速率，独占模式不做重采样）。用最常见的 44.1k
 * 就能代表这条路通不通；拿某首歌的速率反而会让体检结果随歌变化。
 */
const CHECK_RATE = 44100;

const Aria = (typeof globalThis !== 'undefined' && globalThis.Aria) || null;

/* ---- 会话内状态 ---- */
let _active = false;      /* 原生引擎是否正在接管播放 */
let _busy = false;        /* 切换中：防连点把设备开两遍 */
let _deck = null;         /* 当前原生 deck */
let _htmlDeck = null;     /* 被顶替下来的 HTML 元素（关掉开关时还原用） */
let _fallbackDone = false;/* 「加载失败自动回退浏览器播放」只做一次，避免抖动循环 */

/* ============================ 偏好读写 ============================ */

function readPref(key) {
    try {
        const ls = globalThis.localStorage;
        return ls ? (ls.getItem(key) || '') : '';
    } catch (e) {
        logCatch(TAG, e);
        return '';
    }
}

function writePref(key, val) {
    try {
        const ls = globalThis.localStorage;
        if (!ls) return false;
        if (!val) ls.removeItem(key);
        else ls.setItem(key, val);
        return true;
    } catch (e) {
        logCatch(TAG, e);
        return false;
    }
}

const exclusiveWanted = () => readPref(EXCLUSIVE_KEY) === '1';
const readDevice = () => readPref(DEVICE_KEY) || '';

/** 当前音量（百分比）。走 globalThis 读是因为它是 10-config-state 的状态键，会随
 *  全局桥双写；直接读 state.volume 亦可，但要注意它存的是百分比而非增益。 */
function currentVolumePercent() {
    const v = typeof globalThis !== 'undefined' ? globalThis.volume : undefined;
    if (Number.isFinite(v)) return v;
    return Number.isFinite(state.volume) ? state.volume : 80;
}

/* ============================ deck 装配 ============================ */

/** 引擎的 EQ 是跨曲目偏好，交给 deck 在轮询里比对下发（见 nativeDeck 的 eqProvider 注释） */
function eqProvider() {
    return {
        enabled: !!state.eqInited,
        gainsDb: Array.isArray(state.eqGains) ? state.eqGains.slice() : [],
    };
}

/**
 * 空间处理（空间音频 + 虚拟声场）也是跨曲目偏好，且**独占下只能靠这条路生效**
 * ——WASAPI 独占时 Web Audio 图整条不生效，声音由 Rust 链产出（方案 §2.3），
 * 所以必须把设置经 IPC 下发到 `dsp/spatial.rs`。与 eqProvider 同构（轮询里比快照）。
 */
function spatialProvider() {
    const a = (globalThis.appSettings && globalThis.appSettings.audio) || {};
    return {
        spatialEnabled: !!a.spatialAudio,
        spatialLevel: a.spatialStrength || 'light',
        ir: a.spatialIr || 'near',
        stageEnabled: !!a.virtualStage,
        stageLevel: a.stageStrength || 'light',
    };
}

/**
 * 播放速率（变速 / 练习模式）。★ 独占路径的音频是 **Rust 自己解码**的，
 * `<audio>.playbackRate` 到不了那里，所以必须经 IPC 下发（引擎在「解码 → ring」
 * 之间做分数重采样，见 engine.rs::spawn_decode）。
 * ★ 取的是**活跃 deck 自己的** `playbackRate` 而不是 `globalThis.currentPlaybackRate`：
 *   `applyPlaybackRate()`、切歌时的重设、以及 tempoBoost 的"临时提速"**全都是给元素
 *   赋 playbackRate**，读 deck 才能把它们一网打尽；读全局会漏掉 tempoBoost。
 * @returns {number}
 */
function rateProvider() {
    if (_deck) {
        const r = Number(_deck.playbackRate);
        if (Number.isFinite(r) && r > 0) return r;
    }
    const g = Number(globalThis.currentPlaybackRate);
    return Number.isFinite(g) && g > 0 ? g : 1;
}

/**
 * 把「正在播的那首」从一个元素搬到另一个元素。
 * 位置用插值后的 currentTime 取（暂停后再取会丢最后一次外推，最多差半帧）。
 */
function migratePlayback(from, to) {
    if (!from || !to) return;
    const src = from.currentSrc || from.src || '';
    if (!src) return;
    const pos = Number(from.currentTime) || 0;
    const wasPlaying = !from.paused;
    try {
        from.pause();
    } catch (e) {
        logCatch(TAG, e);
    }
    const onReady = () => {
        try {
            if (pos > 0.25) to.currentTime = pos;
            if (wasPlaying) to.play().catch((e) => logCatch(TAG, e));
        } catch (e) {
            logCatch(TAG, e);
        }
    };
    to.addEventListener('canplay', onReady, { once: true });
    to.src = src;   /* deck 的 src setter 自带 load()（见 nativeDeck 注释） */
    to.load();
}

/**
 * 引擎侧报错 → 一次性回退到浏览器播放。
 *
 * 为什么需要：体检只证明「这个设备在这个采样率上能出声」。某首歌的采样率
 * 设备恰好不支持时（独占模式不做重采样，这是比特完美的代价），错误会在
 * **加载那一刻**才出现。此时把用户永久停在「没声音」上是最糟的结果。
 * 只回退一次：反复回退会让界面在两个引擎之间抖动。
 */
function onDeckError() {
    if (!_active || _fallbackDone) return;
    _fallbackDone = true;
    const reason = (_deck && _deck.error && _deck.error.message) || '';
    logWarn(TAG, 'native playback failed, falling back:', reason);
    /* ★ 回退要等切换流程收尾：enableExclusive 执行期间 _busy 为真，
       disableExclusive 会被自己的 busy 守卫挡回来 —— 那样用户就停在
       「原生 deck 已经坏了、也没回到浏览器播放」的中间态，且不会有任何提示。
       加载错误的到达通常晚于 enable 返回，所以这里几乎不会真的等。 */
    let tries = 0;
    const attempt = () => {
        if (!_active) return;
        if (_busy && tries < 40) {
            tries += 1;
            setTimeout(attempt, 120);
            return;
        }
        void disableExclusive({ quiet: true, keepPref: false }).then(() => {
            showSettingsHint(translatePhrase('原生输出初始化失败，已回到浏览器播放'));
        });
    };
    attempt();
}

/* ============================ 开关本体 ============================ */

/**
 * 打开独占输出。返回是否真的打开了。
 * @param {{quiet?:boolean}} [opts] quiet = 自动恢复路径（不弹提示，失败也不惊动用户）
 */
async function enableExclusive(opts) {
    const quiet = !!(opts && opts.quiet);
    if (_active) return true;
    if (_busy) return false;
    _busy = true;
    try {
        const res = await bridge.probe();
        if (!res.available) {
            if (!quiet) {
                showSettingsHint(res.reason === bridge.UNAVAILABLE.NO_SHELL
                    ? translatePhrase('当前环境不支持原生输出')
                    : translatePhrase('原生输出不可用') + '：' + (res.detail || ''));
            }
            return false;
        }

        const device = readDevice();
        /* ★ 端到端体检（见文件头 1）。失败就把引擎给的原因贴出来——
           那条消息里有「接受了 N 帧但一帧都没消费」这类能直接定位问题的信息。 */
        try {
            const fmt = await bridge.checkExclusive(device, CHECK_RATE);
            logInfo(TAG, `exclusive ok: ${fmt.sampleRate} Hz / ${fmt.format}`);
        } catch (e) {
            const msg = String((e && e.message) || e || '');
            logWarn(TAG, 'exclusive check failed:', msg);
            if (!quiet) showSettingsHint(translatePhrase('独占模式在本机不可用') + '：' + msg);
            return false;
        }

        /* 让 automix 先收手：交叉进行到一半时把 deck 换掉会留下两条半死不活的曲线 */
        try {
            if (crossfaderPhase() !== 'IDLE') abortCrossfade('native-exclusive-enabled');
        } catch (e) {
            logCatch(TAG, e);
        }

        await bridge.setOutput(device, true);

        _htmlDeck = getActiveAudio();
        if (!_htmlDeck || isNativeDeck(_htmlDeck)) {
            logWarn(TAG, 'no HTML deck to replace');
            return false;
        }
        const deck = createNativeDeck({ api: bridge, eqProvider, spatialProvider, rateProvider });
        deck.addEventListener('error', onDeckError);
        _active = true;
        _deck = deck;
        if (!setActiveAudio(deck)) {
            /* 顶替失败 = 常驻监听没搬过去，播放链路会半瘫。宁可不开。 */
            _active = false;
            _deck = null;
            deck.dispose();
            logWarn(TAG, 'deck replacement failed');
            if (!quiet) showSettingsHint(translatePhrase('原生输出初始化失败，已回到浏览器播放'));
            return false;
        }
        deck.volume = volumePercentToGain(currentVolumePercent());
        /* ★ 把当前速率带过去：deck 是新对象、`_rate` 默认 1，不带的话
           "1.5× 播到一半打开独占"会突然掉回原速（且 deck 的位置外推也跟着错）。 */
        deck.playbackRate = rateProvider();
        migratePlayback(_htmlDeck, deck);
        writePref(EXCLUSIVE_KEY, '1');
        logInfo(TAG, 'native exclusive output enabled');
        notifyOutputUI();
        if (!quiet) {
            showSettingsHint(translatePhrase('已启用 WASAPI 独占输出'));
            warnUnsupportedFeatures();
        }
        return true;
    } catch (e) {
        logCatch(TAG, e);
        if (!quiet) showSettingsHint(translatePhrase('原生输出初始化失败，已回到浏览器播放'));
        return false;
    } finally {
        _busy = false;
    }
}

/**
 * 关掉独占输出，回到 WebView2 的 `<audio>`。
 * @param {{quiet?:boolean, keepPref?:boolean}} [opts]
 *   keepPref=false 用于「失败回退」：此时要清掉偏好，否则下次启动会再撞一次
 */
async function disableExclusive(opts) {
    const quiet = !!(opts && opts.quiet);
    const keepPref = !opts || opts.keepPref !== false;
    if (!_active) return true;
    if (_busy) return false;
    _busy = true;
    const deck = _deck;
    const html = _htmlDeck;
    /* ★ 先取值再拆：dispose() 之后 currentTime 只剩最后一次快照的锚点 */
    const src = (deck && (deck.currentSrc || deck.src)) || '';
    const pos = deck ? Number(deck.currentTime) || 0 : 0;
    const wasPlaying = deck ? !deck.paused : false;
    const gain = deck ? deck.volume : NaN;
    try {
        _active = false;
        _deck = null;
        if (html) setActiveAudio(html);
        if (deck) deck.dispose();
        /* ★ 交还设备，而不是「改成共享模式就算了」：引擎会一直持有打开过的端点，
           而 WASAPI 独占要求端点空闲——不交还的话用户第二次打开开关必然失败
           （AUDCLNT_E_DEVICE_IN_USE）。顺带把设备真正让出来给别的程序。 */
        bridge.releaseOutput().catch((e) => logCatch(TAG, e));
        if (html && src) {
            if (Number.isFinite(gain)) html.volume = gain;
            html.removeAttribute('src');
            html.src = src;
            html.load();
            html.addEventListener('canplay', () => {
                try {
                    if (pos > 0.25) html.currentTime = pos;
                    if (wasPlaying) html.play().catch((e) => logCatch(TAG, e));
                } catch (e) {
                    logCatch(TAG, e);
                }
            }, { once: true });
        }
        if (keepPref) writePref(EXCLUSIVE_KEY, '0');
        else writePref(EXCLUSIVE_KEY, '');
        _fallbackDone = false;
        logInfo(TAG, 'native exclusive output disabled');
        notifyOutputUI();
        if (!quiet) showSettingsHint(translatePhrase('已停用 WASAPI 独占输出，回到系统混音'));
        return true;
    } catch (e) {
        logCatch(TAG, e);
        return false;
    } finally {
        _busy = false;
    }
}

/** 开启原生模式时的能力缺口提示（见文件头 4） */
function warnUnsupportedFeatures() {
    try {
        const cfg = globalThis.appSettings && globalThis.appSettings.playback;
        if (cfg && cfg.automix && cfg.automix.enabled) {
            setTimeout(() => showSettingsHint(translatePhrase('原生独占模式下 Automix 暂不可用，已临时让位')), 2600);
        }
    } catch (e) {
        logCatch(TAG, e);
    }
}

/* ============================ 设备列表（供 296 使用） ============================ */

/**
 * 原生模式下的设备项，形状与 `core/audioOutput.normalizeOutputDevices` 一致
 * （`{id,label,slot,isDefault}`），这样 296 的下拉渲染一行都不用改。
 * 首项恒为「系统默认」（id 空串 = 引擎用默认端点）。
 */
async function listNativeDevices() {
    const head = { id: '', label: '', slot: 0, isDefault: true };
    try {
        const list = await bridge.devices();
        if (!Array.isArray(list)) return [head];
        const out = [head];
        let slot = 0;
        for (const d of list) {
            if (!d || typeof d.id !== 'string' || !d.id) continue;
            /* 引擎把默认端点也列出来（isDefault=true）。它和首项是同一台设备，
               再列一次会让下拉里出现两个「系统默认」。 */
            if (d.isDefault) continue;
            slot += 1;
            out.push({ id: d.id, label: typeof d.name === 'string' ? d.name.trim() : '', slot, isDefault: false });
        }
        return out;
    } catch (e) {
        logCatch(TAG, e);
        return [head];
    }
}

/**
 * 原生模式下切换输出设备。
 * 引擎的 `set_output` 是「投命令即返回」，设备打不开时**不会**在这里报错，
 * 而是稍后经 snapshot 的 last_error 冒出来（onDeckError 兜底）。所以这里恒返回
 * true：让 296 不要回滚选中项——声音没切过去这件事由后面的错误提示负责说清，
 * 比「下拉回弹但没有任何解释」更好。
 */
async function selectNativeDevice(id) {
    if (!_active) return false;
    writePref(DEVICE_KEY, id || '');
    try {
        await bridge.setOutput(id || null, true);
        logInfo(TAG, `native output device -> ${id || 'default'}`);
        return true;
    } catch (e) {
        logCatch(TAG, e);
        return true;
    }
}

/* ============================ UI ============================ */

function syncToggle() {
    const btn = typeof document !== 'undefined' ? document.getElementById('setNativeExclusive') : null;
    if (!btn) return;
    btn.classList.toggle('on', _active);
    btn.disabled = _busy;
}

function showRow(visible) {
    const row = typeof document !== 'undefined' ? document.getElementById('rowNativeExclusive') : null;
    if (!row) return;
    row.style.display = visible ? '' : 'none';
}

function bindToggleClick() {
    const btn = typeof document !== 'undefined' ? document.getElementById('setNativeExclusive') : null;
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (_busy) return;
        const want = !_active;
        /* ★ 先把 class 交给 syncToggle 统一管：无论成功失败，UI 只反映**真实**状态
           （不能乐观地把开关拨过去——打开了却不出声是最坏的一种撒谎）。 */
        void (want ? enableExclusive({}) : disableExclusive({})).then((ok) => {
            syncToggle();
            if (!ok && want) logWarn(TAG, 'enable rejected');
        });
    });
}

/** 面板重开 / 语言切换时由 220 调用 */
function refresh() {
    syncToggle();
}

/** 让 296 的输出设备下拉改道/改回（列表来源与写入目标都变了） */
function notifyOutputUI() {
    if (!Aria) return;
    try {
        if (typeof Aria.__audioOutputRefresh === 'function') Aria.__audioOutputRefresh();
    } catch (e) {
        logCatch(TAG, e);
    }
    /* ★ P1 时这里还会刷新「虚拟声场 × 独占置灰」；P2 起该置灰已解除
       （独占路径由 Rust 侧承担，见 dsp/spatial.rs + native_audio_set_spatial），
       所以钩子与注册一并删除。 */
}

/* ============================ 启动 ============================ */

try {
    bindToggleClick();
    void (async () => {
        const res = await bridge.probe();
        showRow(!!res.available);
        syncToggle();
        if (!res.available) return;
        /* 偏好为开 → 自动恢复。**必须先过体检**：否则一台「驱动不消费缓冲」的
           机器会在每次启动时静默哑掉，而且用户根本想不到是这里。 */
        if (exclusiveWanted()) {
            const ok = await enableExclusive({ quiet: true });
            syncToggle();
            if (!ok) {
                /* 体检没过：清掉偏好，让下次启动不再撞同一堵墙；
                   同时留一条提示说明为什么。 */
                writePref(EXCLUSIVE_KEY, '0');
                showSettingsHint(translatePhrase('独占模式在本机不可用，已保持系统默认输出'));
            }
        }
    })().catch((e) => logCatch(TAG, e));
} catch (e) {
    logCatch(TAG, e);
}

if (Aria) {
    /* automix 的启用判据（96-automix）读它：原生接管期间一律返回 false。
       ★ 用函数而不是布尔快照，是为了让 96 侧不需要在任何时刻重新读一次。 */
    Aria.set('__nativeOutputActive', () => _active);
    Aria.set('__nativeOutputRefresh', refresh);
    /* 296 的设备下拉在原生模式下走这套（列表/选择都换成引擎的）。
       savedDevice 也一并暴露：设备 id 的存储键在本文件里（见 DEVICE_KEY），
       让 296 自己去摸 localStorage 就等于把同一个键抄了两份。 */
    Aria.set('__nativeOutputBackend', {
        active: () => _active,
        devices: () => listNativeDevices(),
        select: (id) => selectNativeDevice(id),
        savedDevice: () => readDevice(),
    });
}

export { enableExclusive, disableExclusive, listNativeDevices, selectNativeDevice };
export const __test = { readPref, writePref, exclusiveWanted, currentVolumePercent };
