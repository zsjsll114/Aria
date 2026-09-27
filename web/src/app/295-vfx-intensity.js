/* ============================================================
 * 295-vfx-intensity.js — 「动效强度」滑杆的 UI 接线（todos #6）
 *
 * 一句话：把「高/中/低/极简」四个按钮换成一根 0~100 的滑杆，并且**实时把这一档
 * 到底给了什么报出来**（背景模糊几 px、毛玻璃几 px、哪些特效开/关）。四档之所以难懂，
 * 不是因为档位数少，而是因为用户看不出「选中之后我会损失什么」。
 *
 * 三个不显然的决定：
 *  1. **数学不在这里**，全在 `core/vfxIntensity.js`（纯函数，tests/js/test_vfx_intensity.js 覆盖）。
 *     本分片只读 `appSettings.interface.vfxIntensity`、写、然后请 180 重新分发。
 *  2. **不写进 `perf_vfx_overrides_v1`**：滑杆值与手动微调各自存，读取时叠加，
 *     **手动微调在上**（见 180 的 getVfxOverrides）。若让滑杆去覆盖手调开关，
 *     用户拖一次滑杆就无声丢掉他调过的 4 个特效开关——那是数据丢失，不是「重置」。
 *     代价是「拉满但某个开关仍关着」需要解释，已写进行说明里。
 *  3. **不把这个热文件（220）变成自译文件**：i18n 门禁把「文件里出现 translatePhrase()」
 *     判成整份自译，要求它所有中文都登记；220 里有 6 条历史漏登。所以滑杆独立成分片，
 *     220 只留两个 `Aria.__syncVfxIntensity / __resetVfxIntensity` 钩子调用点。
 *
 * 「跟随等级」态（值为 null）刻意保留：默认必须是「不覆盖任何键」，
 * 否则启动时按滑杆写死一遍 vfx，自动检测出来的档位就被顶掉了。
 * ============================================================ */
import { applyPerformanceProfile, getPerformanceSettings, saveSettings } from './180-boot-config.js';
import { applyAllSettings } from './190-settings-fontsize.js';
import { showSettingsHint } from './220-shortcuts-viewmode.js';
import { logCatch } from '../services/log.js';
import { translatePhrase } from '../core/i18n.js';
import {
    clampIntensity,
    describeVfxIntensity,
    intensityForProfile,
} from '../core/vfxIntensity.js';

const TAG = 'vfxIntensity';

function currentProfile() {
    try {
        const saved = getPerformanceSettings();
        return (saved && saved.profile) ? saved.profile : 'medium';
    } catch (e) {
        logCatch(TAG, e);
        return 'medium';
    }
}

function savedIntensity() {
    const s = globalThis.appSettings;
    return clampIntensity(((s && s.interface) || {}).vfxIntensity);
}

/** 刷新滑杆位置 / 数值栏 / 说明行（档位切换与面板重开也要走这里，所以导出成 Aria 钩子） */
function syncIntensityUI() {
    const slider = document.getElementById('vfxIntensity');
    if (!slider) return;
    const n = savedIntensity();
    /* 跟随态把指针停在**等效位置**上，但数值栏明写「跟随 67」——
       只给一条猜不出含义的线，等于把四档的困惑原样搬过来。 */
    const shown = n === null ? (intensityForProfile(currentProfile()) ?? 100) : n;
    slider.value = String(shown);
    const span = document.querySelector('[data-val="vfxIntensity"]');
    if (span) span.textContent = n === null ? `${translatePhrase('跟随')} ${shown}` : String(n);
    const desc = document.getElementById('vfxIntensityDesc');
    if (desc) desc.textContent = describeVfxIntensity(n, currentProfile(), translatePhrase);
}

/** 清掉滑杆偏好（两个「恢复推荐/出厂配置」按钮必须调它，否则按钮撒了谎） */
function resetIntensity() {
    const s = globalThis.appSettings;
    if (!s || !s.interface) return;
    s.interface.vfxIntensity = null;
    try { saveSettings(); } catch (e) { logCatch(TAG, e); }
}

function applyIntensity(value) {
    const s = globalThis.appSettings;
    if (!s) return;
    if (!s.interface) s.interface = {};
    s.interface.vfxIntensity = value;
    try {
        saveSettings();
    } catch (e) {
        logCatch(TAG, e);
    }
    /* 重新分发：档位 vfx ⊕ 滑杆 ⊕ 手动微调（叠加发生在 180 的 getVfxOverrides 里） */
    try {
        applyPerformanceProfile(currentProfile());
    } catch (e) {
        logCatch(TAG, e);
    }
    try {
        applyAllSettings();
    } catch (e) {
        logCatch(TAG, e);
    }
    syncIntensityUI();
}

function bind() {
    const slider = document.getElementById('vfxIntensity');
    if (slider && !slider.dataset.vfxBound) {
        slider.dataset.vfxBound = '1';
        slider.addEventListener('input', (e) => {
            const v = clampIntensity(e.target.value);
            if (v === null) return;      // 脏值不写，保持上一次有效偏好
            applyIntensity(v);
        });
    }
    const follow = document.getElementById('vfxIntensityFollow');
    if (follow && !follow.dataset.vfxBound) {
        follow.dataset.vfxBound = '1';
        follow.addEventListener('click', () => {
            applyIntensity(null);
            showSettingsHint(translatePhrase('已改为跟随性能等级'));
        });
    }
    syncIntensityUI();
}

/* 静态 DOM，deferred 模块执行时已解析到位，直接在导入期绑定 + 首次同步 */
try {
    bind();
} catch (e) {
    logCatch(TAG, e);
}

const A = (typeof globalThis !== 'undefined' && globalThis.Aria) || null;
if (A) {
    A.set('__syncVfxIntensity', syncIntensityUI);
    A.set('__resetVfxIntensity', resetIntensity);
    A.set('__vfxIntensityApply', applyIntensity);
}

export { savedIntensity, syncIntensityUI, resetIntensity, applyIntensity };
