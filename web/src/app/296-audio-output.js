/* ============================================================
 * 296-audio-output.js — 「输出设备」下拉的 UI 接线（原生输出线 Phase 1）
 *
 * 一句话：设置 → 音效 → 输出，切声音出到哪个设备。
 * 全部判断在 core/audioOutput.js（纯逻辑，tests/js/test_audio_output.js 覆盖），
 * 本分片只做三件事：枚举、渲染、把 sinkId 打到当前有效目标上。
 *
 * 四个不显然的决定：
 *  1. **复用 .setting-dropdown 的类名与开合约定，并自己置 `_ariaToggleBound`。**
 *     220 的 initCustomDropdowns 见到「已有 trigger + 已绑标记」就直接返回 ——
 *     不重建、不重绑，所以我的动态选项不会被那套静态 DROPDOWN_OPTIONS 顶掉。
 *     这也是为什么本分片**不能**用 data-setting 走静态表：设备列表是运行时的。
 *  2. **每次曲目加载后重挂一次 sink。** Chromium 有一个 WontFix 的坑：元素在拿到
 *     src 之前 setSinkId，sinkId 属性报告新设备但声音仍走默认（issue 40206537）。
 *     所以监听 loadedmetadata 重挂 —— 且必须走 dualDeck 的 registerAudioListener
 *     （常驻监听；Automix swap 角色后会跟着搬到新 deck，用裸 addEventListener
 *     会在顶替后挂到已退休的元素上）。
 *  3. **失败必须回滚选中项。** 把下拉停在用户点的那一项而声音没变，是 UI 撒谎。
 *     回滚 + 提示原因，并把偏好清回默认。
 *  4. 设备标签是外部数据 → 全程 createElement + textContent，不拼 innerHTML
 *     （约束 8 的转义门禁在这里天然满足，不是绕过）。
 *  5. **原生输出模式下整条链改道引擎。** WASAPI 独占时声音根本不经过
 *     `<audio>`/AudioContext，`setSinkId` 打在哪都没用；而设备枚举也得换成
 *     WASAPI 端点（WebView2 的 deviceId 与端点 id 不是同一套命名空间）。
 *     判断与实现都在 app/298（`Aria.__nativeOutputBackend`），本分片只问一句
 *     「现在是谁在出声」，免得两处各存一份真相。
 * ============================================================ */
import { state } from '../infrastructure/state.js';
import { audio } from './20-lyrics-render.js';
import { getActiveAudio, registerAudioListener } from '../core/dualDeck.js';
import { logInfo, logWarn, logCatch } from '../services/log.js';
import { translatePhrase } from '../core/i18n.js';
import { showSettingsHint } from './220-shortcuts-viewmode.js';
import {
    SYSTEM_DEFAULT_ID,
    normalizeOutputDevices,
    pickSavedDeviceId,
    resolveSinkTarget,
    describeSinkError,
    readSavedDeviceId,
    writeSavedDeviceId,
} from '../core/audioOutput.js';

const TAG = 'audioOutput';
const DD_ID = 'dropdown-audioOutput';

let _list = normalizeOutputDevices(null);
let _currentId = SYSTEM_DEFAULT_ID;
let _docCloseBound = false;

/**
 * 原生输出后端（原生独占接管时由 app/298 挂上；网页版也挂着，但 active() 恒 false）。
 * @returns {{active:Function,devices:Function,select:Function,savedDevice:Function}|null}
 */
function nativeBackend() {
    const A = (typeof globalThis !== 'undefined' && globalThis.Aria) || null;
    const b = A && A.__nativeOutputBackend;
    return b && typeof b.active === 'function' ? b : null;
}

function nativeActive() {
    const b = nativeBackend();
    try {
        return !!(b && b.active());
    } catch (e) {
        logCatch(TAG, e);
        return false;
    }
}

/** 设备项显示文案：默认项走词表，无标签的设备给「输出设备 N」编号兜底 */
function labelOf(item) {
    if (!item || item.isDefault) return translatePhrase('系统默认');
    return item.label || (translatePhrase('输出设备') + ' ' + item.slot);
}

/** 建立（或取回）trigger + menu。幂等：220 只补不重建的前提就是这里已建好 */
function ensureShell(dd) {
    let trigger = dd.querySelector('.setting-dropdown-trigger');
    if (trigger) return trigger;

    trigger = document.createElement('div');
    trigger.className = 'setting-dropdown-trigger';
    /* ★ 告诉 220 的开合事件唯一挂载点「本 trigger 已自行绑定」，避免双 handler 互相抵消 */
    trigger._ariaToggleBound = true;
    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.setting-dropdown.open').forEach((d) => {
            if (d !== dd) d.classList.remove('open');
        });
        dd.classList.toggle('open');
    });

    const menu = document.createElement('div');
    menu.className = 'setting-dropdown-menu';

    dd.appendChild(trigger);
    dd.appendChild(menu);

    /* 点空白收起：220 的全局监听只在设置面板初始化时挂一次，本分片要在
       「面板还没被打开过」时也自洽，所以自备一个（同语义重复挂无害） */
    if (!_docCloseBound) {
        _docCloseBound = true;
        document.addEventListener('click', () => {
            document.querySelectorAll('.setting-dropdown.open').forEach((d) => d.classList.remove('open'));
        });
    }
    return trigger;
}

function renderMenu(menu) {
    menu.textContent = '';
    for (const item of _list) {
        const el = document.createElement('div');
        el.className = 'setting-dropdown-item' + (item.id === _currentId ? ' selected' : '');
        el.textContent = labelOf(item);
        el.dataset.value = item.id;
        el.addEventListener('click', () => { void selectDevice(item.id); });
        menu.appendChild(el);
    }
}

function syncUI() {
    const dd = document.getElementById(DD_ID);
    if (!dd) return;
    const trigger = ensureShell(dd);
    const menu = dd.querySelector('.setting-dropdown-menu');
    trigger.textContent = labelOf(_list.find((it) => it.id === _currentId) || _list[0]);
    if (menu) renderMenu(menu);
}

function hintForError(code) {
    if (code === 'permission') return translatePhrase('应用未被允许使用该输出设备');
    if (code === 'notfound') return translatePhrase('该输出设备已不可用');
    return translatePhrase('切换输出设备失败');
}

/* ★ 2026-10-06（需求 4「独占模式别卡死崩溃」）：把"切设备"包上硬超时。
   背景：`setSinkId` 与原生引擎的 `select` 都是"发出去等驱动回话"的调用，
   设备被拔掉/驱动挂住时可能**既不 resolve 也不 reject**。而调用点在 `_busy`
   保护里 —— promise 悬住 = 下拉从此点不动，且用户看到的是"点了没反应"，
   既卡又难查。超时后按失败处理，上层照常回滚选中项。 */
const SINK_TIMEOUT_MS = 4000;

/**
 * 给 promise 套一个超时，且**把三种结局分开返回**，不吞掉错误对象
 * （`NotAllowedError` 与超时给用户的提示完全不同）。
 * @returns {Promise<{value?:any, error?:any, timeout?:boolean}>}
 */
function withTimeout(promise, ms) {
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve({ timeout: true });
        }, ms);
        Promise.resolve(promise).then(
            (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ value }); } },
            (error) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ error }); } },
        );
    });
}

/**
 * 把 sinkId 打到当前有效目标（现算，见 core/audioOutput 注释 2）。
 * @param {string} id 目标设备 id，SYSTEM_DEFAULT_ID 表示系统默认
 * @param {{quiet?:boolean}} [opts] quiet = 不弹提示（用于开机/切歌时静默重挂）
 * @returns {Promise<boolean>}
 */
async function applySink(id, opts) {
    const quiet = !!(opts && opts.quiet);
    /* ★ 原生独占接管时 setSinkId 是无效动作（声音不经元素/Context 出去），
       改道引擎。返回引擎侧的结果，语义与下面一致：false = UI 要回滚。 */
    if (nativeActive()) {
        const b = nativeBackend();
        try {
            const r = await withTimeout(b.select(id), SINK_TIMEOUT_MS);
            if (r.timeout) {
                logWarn(TAG, `原生设备切换 ${SINK_TIMEOUT_MS}ms 未回应，按失败处理`);
                if (!quiet) showSettingsHint(translatePhrase('切换输出设备超时，已保持原设备'));
                return false;
            }
            const ok = !!r.value;
            if (!ok && !quiet) showSettingsHint(translatePhrase('切换输出设备失败'));
            return ok;
        } catch (e) {
            logCatch(TAG, e);
            if (!quiet) showSettingsHint(translatePhrase('切换输出设备失败'));
            return false;
        }
    }
    const target = resolveSinkTarget(state.audioCtx, audio);
    if (!target) {
        if (!quiet) showSettingsHint(translatePhrase('当前环境不支持选择输出设备'));
        logWarn(TAG, '无可用 sink 目标：AudioContext 与元素都没有 setSinkId');
        return false;
    }
    const r = await withTimeout(target.node.setSinkId(id || SYSTEM_DEFAULT_ID), SINK_TIMEOUT_MS);
    if (r.timeout) {
        logWarn(TAG, `setSinkId ${SINK_TIMEOUT_MS}ms 未回应（设备可能已被拔出），保持原设备`);
        if (!quiet) showSettingsHint(translatePhrase('切换输出设备超时，已保持原设备'));
        return false;
    }
    if (r.error) {
        logCatch(TAG, r.error);
        if (!quiet) showSettingsHint(hintForError(describeSinkError(r.error)));
        return false;
    }
    logInfo(TAG, `输出已切到 ${target.kind} / ${id || '默认'}`);
    return true;
}

/**
 * ★ 正在用的设备**消失了**（拔耳机 / 蓝牙断开）时的重路由（需求 4）。
 *
 * 为什么要"暂停 → 切回系统默认 → 继续播放"这一整套，而不是只调一次 setSinkId：
 * Chromium 里元素指向一个已消失的端点时，`setSinkId` 常常**报告成功但不出声**
 * （流的端点已经失效，只是属性变了）。暂停会强制释放那条流，再 play 才真正
 * 挂到新端点上。只在"设备确实丢了、且当时在播"时走这条——
 * 正常热插拔另一台设备时用户不该听到一次多余的停顿。
 */
async function reattachAfterDeviceLoss() {
    const a = getActiveAudio();
    const wasPlaying = !!(a && a.paused === false);
    try { if (wasPlaying && typeof a.pause === 'function') a.pause(); } catch (e) { logCatch(TAG, e); }
    const ok = await applySink(SYSTEM_DEFAULT_ID, { quiet: true });
    if (wasPlaying && typeof a.play === 'function') {
        try { await a.play(); } catch (e) { logCatch(TAG, e); }
    }
    logInfo(TAG, `原输出设备已不存在，已${ok ? '回落系统默认' : '尝试回落系统默认（未成功）'}并恢复播放`);
}

async function selectDevice(id) {
    const dd = document.getElementById(DD_ID);
    if (dd) dd.classList.remove('open');
    const prev = _currentId;
    const ok = await applySink(id, { quiet: false });
    if (!ok) {
        /* 回滚：UI 不能停在声音实际没切过去的那一项 */
        _currentId = prev;
        syncUI();
        return;
    }
    _currentId = id;
    /* 原生模式下设备 id 的存储属于 298（DEVICE_KEY），这里只维护 WebView2 那份，
       否则同一个「输出设备」会往两个键里写、读的时候只认其中一个。 */
    if (!nativeActive()) writeSavedDeviceId(id);
    syncUI();
    if (id !== SYSTEM_DEFAULT_ID) showSettingsHint(translatePhrase('输出设备已切换'));
}

/** 重新枚举设备并同步 UI；顺带静默重挂一次当前偏好 */
async function refresh() {
    /* ★ 原生独占：设备表来自 WASAPI 端点（见文件头 5），且不需要重挂 sink */
    if (nativeActive()) {
        const b = nativeBackend();
        try {
            const list = await b.devices();
            if (Array.isArray(list) && list.length) _list = list;
        } catch (e) {
            logCatch(TAG, e);
        }
        const saved = typeof b.savedDevice === 'function' ? b.savedDevice() : '';
        _currentId = _list.some((it) => it.id === saved) ? saved : SYSTEM_DEFAULT_ID;
        syncUI();
        return;
    }
    const md = globalThis.navigator && globalThis.navigator.mediaDevices;
    if (!md || typeof md.enumerateDevices !== 'function') {
        logWarn(TAG, '不支持 enumerateDevices，输出设备选择不可用');
        syncUI();
        return;
    }
    let devices = null;
    try {
        devices = await md.enumerateDevices();
    } catch (e) {
        logCatch(TAG, e);
    }
    _list = normalizeOutputDevices(devices);
    const saved = readSavedDeviceId();
    const valid = pickSavedDeviceId(saved, _list);
    /* 偏好里的设备没了（拔掉/换机器）→ 一并清掉：留着失效 id 下次也回不来 */
    if (valid !== saved) {
        writeSavedDeviceId(SYSTEM_DEFAULT_ID);
        logInfo(TAG, '保存的输出设备已不存在，回落系统默认');
    }
    _currentId = valid;
    syncUI();
    /* ★ 用户选中的设备**消失了**（拔掉/断连）→ 显式重路由（需求 4）。
       必须在这里做，而不是只把偏好清回默认：清偏好只改了记录，
       声音还挂在那个已经失效的端点上（表现是"界面显示默认设备，但没声音"）。 */
    const lostUsedDevice = (valid !== saved) && saved !== SYSTEM_DEFAULT_ID;
    if (lostUsedDevice) { await reattachAfterDeviceLoss(); return; }
    if (_currentId !== SYSTEM_DEFAULT_ID) await applySink(_currentId, { quiet: true });
}

/* 静态 DOM 在 deferred 模块执行时已解析到位，导入期即可绑定（与 295 同规矩） */
try {
    syncUI();
    void refresh();
} catch (e) {
    logCatch(TAG, e);
}

try {
    const md = globalThis.navigator && globalThis.navigator.mediaDevices;
    if (md && typeof md.addEventListener === 'function') {
        md.addEventListener('devicechange', () => { void refresh(); });
    }
} catch (e) {
    logCatch(TAG, e);
}

/* ★ 每次曲目加载后重挂：规避「拿到 src 前 setSinkId 不生效」的 Chromium 坑（文件头 2） */
registerAudioListener('loadedmetadata', () => {
    if (_currentId === SYSTEM_DEFAULT_ID) return;
    /* 原生独占下设备由引擎自己持有并跨曲目沿用（engine.rs 的 pending_output），
       换曲重发一次 set_output 只会把设备重开一遍，是纯浪费。 */
    if (nativeActive()) return;
    void applySink(_currentId, { quiet: true });
});

const A = (typeof globalThis !== 'undefined' && globalThis.Aria) || null;
if (A) {
    /* 设置面板重开 / 语言切换时由 220 的 refreshSettingsUI 调用 */
    A.set('__audioOutputRefresh', () => { void refresh(); });
    /* EQ 图建好或拆掉后由 core/equalizer.js 调用：有效 target 从 element 变成 ctx（或反向） */
    A.set('__audioOutputReapply', () => { void applySink(_currentId, { quiet: true }); });
}

export { refresh as refreshAudioOutput, applySink as applyAudioSink };
