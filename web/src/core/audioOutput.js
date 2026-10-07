/* ============================================================
 * core/audioOutput.js — 音频输出设备选择（原生输出线 Phase 1）
 *
 * 一句话：决定「声音出到哪个设备」的全部判断在这里，DOM 在 app/296。
 *
 * 四个不显然的决定：
 *  1. **sinkId 打在 AudioContext 上，不是 <audio> 上。** Chromium 里元素一旦被
 *     createMediaElementSource 收进 Web Audio 图，元素自身输出即被静音（声音只从
 *     图里出来），此时 HTMLMediaElement.setSinkId() 不生效 —— Chromium 自己的
 *     WPT 用例 setSinkId-with-MediaElementAudioSourceNode 对 Chrome 的期望就是
 *     FAIL。本项目的 EQ 图正是这个形状（source → deckGain → mixBus → 10 段滤波
 *     → compressor → destination，见 core/equalizer.js），所以只要 EQ 图存在，
 *     唯一有效入口是 AudioContext.setSinkId()（Chrome 110+，本机 WebView2 154 满足）。
 *  2. **目标必须现算，不能缓存。** EQ 图是**懒创建**的（只在用户打开均衡器面板时
 *     才 initEqAudioGraph，见 app/90-eq.js openEqPanel），于是「从未开过均衡器」与
 *     「开过」两种状态下有效目标分别是 <audio> 和 AudioContext。启动时缓存一个目标，
 *     用户一开均衡器就静默失效了 → resolveSinkTarget() 每次调用现算。
 *  3. **偏好存 localStorage，不进 user_config.json。** deviceId 是本机专属的：同一个
 *     id 换台机器毫无意义（甚至指向别的硬件），塞进会被导出/导入的配置属于数据污染。
 *     项目已有先例 —— aria_eq_custom 同样走 localStorage。
 *  4. **读不到设备标签是规范行为，不是故障。** 未授权时 enumerateDevices() 只回默认
 *     设备且 label 为空串。这里给编号槽位交给 UI 兜底文案，**不去索取权限** —— 要权限
 *     就得走 selectAudioOutput() 弹窗，而 WebView2 没有内置权限 UI，索取会卡在无处显示
 *     的提示上。真正的可行性结论只能靠真机实测（见 296 的失败回滚）。
 *
 * 与原生输出线后续阶段的关系：Phase 2/3 把 deck 换成 Rust 侧 cpal 输出后，
 * 「有效目标」会多出第三种（原生引擎）——届时仍在 resolveSinkTarget 收口，
 * 上层 296 不需要改。
 * ============================================================ */
import { logCatch } from '../services/log.js';

const TAG = 'audioOutput';

/** 本机偏好键。★ 故意不进 user_config.json —— 理由见文件头注释 3 */
export const OUTPUT_DEVICE_KEY = 'aria_audio_output_device';

/** 空串 = 系统默认输出。element 与 AudioContext 的 setSinkId 都认这个约定 */
export const SYSTEM_DEFAULT_ID = '';

/**
 * 把 enumerateDevices() 的原始结果归一化成下拉项。
 * 首项恒为「系统默认」；label 为空串时只给 slot 编号，文案与翻译留给 UI 层
 * （core 层不做翻译，与其它模块一致）。
 * @param {Array<{kind?:string,deviceId?:string,label?:string}>|null} devices
 * @returns {Array<{id:string,label:string,slot:number,isDefault:boolean}>}
 */
export function normalizeOutputDevices(devices) {
    const list = [{ id: SYSTEM_DEFAULT_ID, label: '', slot: 0, isDefault: true }];
    if (!Array.isArray(devices)) return list;
    let slot = 0;
    for (const d of devices) {
        if (!d || d.kind !== 'audiooutput') continue;
        const id = typeof d.deviceId === 'string' ? d.deviceId : '';
        /* 空 deviceId 等价于默认设备（未授权时 Chromium 就这么回），跳过免得出重复项 */
        if (!id) continue;
        if (list.some((it) => it.id === id)) continue;
        slot += 1;
        list.push({
            id,
            label: typeof d.label === 'string' ? d.label.trim() : '',
            slot,
            isDefault: false,
        });
    }
    return list;
}

/**
 * 已保存的偏好是否仍然有效。设备被拔掉/换机器后 id 会失效，此时必须回落默认 ——
 * 把失效 id 硬塞给 setSinkId 会抛 NotFoundError，表现为「一打开设置就报错」，
 * 比静默回落更糟。
 * @param {unknown} savedId
 * @param {Array<{id:string}>} list normalizeOutputDevices() 的结果
 * @returns {string} 有效 id，或 SYSTEM_DEFAULT_ID
 */
export function pickSavedDeviceId(savedId, list) {
    if (typeof savedId !== 'string' || !savedId) return SYSTEM_DEFAULT_ID;
    if (!Array.isArray(list)) return SYSTEM_DEFAULT_ID;
    return list.some((it) => it.id === savedId) ? savedId : SYSTEM_DEFAULT_ID;
}

/**
 * 现算 sink 目标（★ 不要缓存结果，理由见文件头注释 2）。
 * 优先 AudioContext：只要 EQ 图建过，元素自身输出已被静音，只有 ctx 有效。
 * @param {{setSinkId?:Function}|null} audioCtx
 * @param {{setSinkId?:Function}|null} element
 * @returns {{node:object, kind:'context'|'element'}|null}
 */
export function resolveSinkTarget(audioCtx, element) {
    if (audioCtx && typeof audioCtx.setSinkId === 'function') return { node: audioCtx, kind: 'context' };
    if (element && typeof element.setSinkId === 'function') return { node: element, kind: 'element' };
    return null;
}

/**
 * 错误归类 → 给 UI 挑文案用。不返回文案本身：core 层不做翻译，
 * 文案与 STATIC_PHRASE_MAP 的对应留在 app 层。
 * @param {unknown} e
 * @returns {'permission'|'notfound'|'abort'|'unknown'}
 */
export function describeSinkError(e) {
    const name = (e && e.name) || '';
    if (name === 'NotAllowedError') return 'permission';
    if (name === 'NotFoundError') return 'notfound';
    if (name === 'AbortError') return 'abort';
    return 'unknown';
}

/**
 * 读本机偏好。localStorage 不可用（隐私模式/被禁）时静默回落默认 ——
 * 这里回落是可接受语义，不是吞异常，但仍留痕方便排查。
 * @returns {string}
 */
export function readSavedDeviceId() {
    try {
        const ls = globalThis.localStorage;
        if (!ls) return SYSTEM_DEFAULT_ID;
        return ls.getItem(OUTPUT_DEVICE_KEY) || SYSTEM_DEFAULT_ID;
    } catch (e) {
        logCatch(TAG, e);
        return SYSTEM_DEFAULT_ID;
    }
}

/**
 * 写本机偏好。传 SYSTEM_DEFAULT_ID 等于清除该项（保持「无键 = 跟默认」，
 * 避免留一个空串键让后续读取逻辑要判两种空值）。
 * @param {string} id
 * @returns {boolean} 是否写入成功
 */
export function writeSavedDeviceId(id) {
    try {
        const ls = globalThis.localStorage;
        if (!ls) return false;
        if (!id) ls.removeItem(OUTPUT_DEVICE_KEY);
        else ls.setItem(OUTPUT_DEVICE_KEY, id);
        return true;
    } catch (e) {
        logCatch(TAG, e);
        return false;
    }
}
