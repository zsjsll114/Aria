/* ============================================================
 * 290-vfx-recipe.js — 视觉配方：命名 / 分享码（todos #9）
 *
 * 形态：右上角一个入口按钮 + 一套自建的毛玻璃面板（列表 / 重命名 / 覆盖 /
 * 删除 / 应用 / 分享码 / 导入分享码 / 导入导出外观 mod 文件）。
 * 2026-09-26 按用户要求精简：顶部「存为配方/复制当前分享码」两按钮移除，
 * 「当前外观」分享码常显（行内分享码草稿临时顶替，收起即回），底部
 * 「配方包含哪些设置」说明区移除。创建配方只剩「导入分享码」一条路，
 * 已有配方用「覆盖」更新。
 * 本分片不新增 index.html 的 DOM，也不改任何既有分片：按钮与设置组都是自建自挂
 * （和 282/283 同一套路），所以「只 import 分片」的中间状态下功能也是完整的。
 *
 * 编解码 / 白名单 / 校验全在 core/vfxRecipe.js（纯逻辑，tests/js/test_vfx_recipe.js 覆盖）。
 * 本分片只负责三件事：列 UI、读写 appSettings、把新值**重绘**出来。
 *
 * 四个容易踩的点：
 *  1. 重绘不能图省事调 applyAllSettings —— 它顺带把 volume 拉回 initialVolume、
 *     把 playMode/倍速 拉回默认值。用户点「应用配方」结果音量跳了，这是事故。
 *     所以只调 applyInterfaceSettings + applyModeSettings 这两个纯观感的口。
 *  2. 换视觉模式没有导出函数可用（220 的 switchView 关在 IIFE 里）。走的是
 *     「点 .view-mode-card」这条和人手点完全相同的路——它会把 220 的引擎装配、
 *     localStorage 记忆、设置面板分段选中一起带上，比自己补一遍安全得多。
 *  3. 分享码导回来的预设名是**外部数据**，面板每次重渲染都要 esc()（约束 8）。
 *     校验不过就整份拒（core 保证「非法值不落进 appSettings 半个字节」），
 *     并把逐条原因显示出来——只报「导入失败」等于没报。
 *  4. 面板里所有需要被 i18n 扫到的静态中文，元素都得带 core/i18n.js 白名单里的
 *     类名（.setting-label / .setting-desc / .settings-group-title / .setting-btn /
 *     .empty-hint）且**不能有子元素**——_scanI18n 对 children>0 且不含 svg 的节点
 *     是直接 return 的。所以列表项把「键名」和「说明」拆成两个兄弟节点写。
 *
 * 存储：appSettings.interface.vfxRecipes。刻意不新增顶层键——180 的 loadSettings()
 * 是按固定键白名单整体重建 appSettings 的，只有 interface / shortcuts 全量展开，
 * 挂到别处会被静默丢弃（AGENTS 约束 11）。
 * ============================================================ */
import { esc } from '../utils/formatters.js';
import { logCatch, logWarn } from '../services/log.js';
import { state } from '../infrastructure/state.js';
import { saveSettings } from './180-boot-config.js';
import {
    applyBackgroundSettings, applyHighlightColor, applyInterfaceSettings, applyLyricBlurLevel,
    applyLyricFontSize, applyModeSettings,
} from './190-settings-fontsize.js';
import { renderLyrics } from './20-lyrics-render.js';
import { showToast } from './155-random-toast-match.js';
import {
    CODE_PREFIX, ERROR_TEXT, MAX_PRESETS, RECIPE_GROUPS, SCHEMA_VERSION, VIEW_MODES,
    applyRecipeToSettings, canonicalJSON, collectRecipe, decodeRecipe, encodeRecipe,
    newPresetId, normalizePresetList, parseThemeMod, removePreset, renamePreset,
    sanitizeRecipeName, serializeThemeMod, summarizeRecipe, upsertPreset,
} from '../core/vfxRecipe.js';

const TAG = 'vfxRecipe';
const OVERLAY_ID = 'vfxRecipeOverlay';
const SETTINGS_GROUP_ID = 'vfxRecipeSettingsGroup';
const STYLE_ID = 'vfxRecipeStyles';
const PREF_KEY = 'vfxRecipes';
/* 导入成功后自动落库的配方名前缀（用户可能导入完就忘了它是哪来的） */
const IMPORTED_PREFIX = '导入的配方';

function doc() { return typeof document !== 'undefined' ? document : null; }
function q(sel) { const d = doc(); return d && d.querySelector ? d.querySelector(sel) : null; }
function byId(id) { const d = doc(); return d && d.getElementById ? d.getElementById(id) : null; }

function settings() {
    try {
        return state.appSettings || (typeof globalThis !== 'undefined' && globalThis.appSettings) || null;
    } catch (e) { logCatch(TAG, e); return null; }
}

function currentMode() {
    try {
        const m = (typeof globalThis !== 'undefined' && globalThis.currentViewMode) || null;
        return VIEW_MODES.indexOf(m) >= 0 ? m : 'cover';
    } catch (e) { logCatch(TAG, e); return 'cover'; }
}

/* ==================== 清单读写 ==================== */

function readPresets() {
    try {
        const s = settings();
        const bucket = s && s.interface && s.interface[PREF_KEY];
        return normalizePresetList(bucket && bucket.items);
    } catch (e) {
        logCatch(TAG, e);
        return [];
    }
}

function writePresets(list) {
    try {
        const s = settings();
        if (!s || !s.interface) return false;
        s.interface[PREF_KEY] = { items: Array.isArray(list) ? list : [] };
        saveSettings();
        return true;
    } catch (e) {
        logCatch(TAG, e);
        return false;
    }
}

/* ==================== 采集 / 应用 ==================== */

/** 当前所有视觉参数 → 配方对象 */
function captureCurrent() {
    return collectRecipe(settings(), currentMode());
}

function hasAnyKey(modeSettingsObj, key) {
    if (!modeSettingsObj || typeof modeSettingsObj !== 'object') return false;
    return Object.keys(modeSettingsObj).some(m => !!m && Object.prototype.hasOwnProperty.call(modeSettingsObj[m] || {}, key));
}

/**
 * 把配方落到界面：写 appSettings → 存盘 → 换模式 → 重绘观感。
 * @param {Object} recipe 已通过校验的配方
 * @returns {{ok:boolean, counts?:Object, reason?:string}}
 */
function applyRecipe(recipe) {
    const s = settings();
    if (!s) return { ok: false, reason: 'not-ready' };
    const res = applyRecipeToSettings(s, recipe);
    if (!res.ok) return { ok: false, reason: 'invalid' };
    try {
        saveSettings();
    } catch (e) { logCatch(TAG, e); }

    /* 换模式放在重绘之前：220 的 switchView 末尾自己会 applyModeSettings(新模式) */
    const want = res.mode;
    let switched = false;
    if (want && want !== currentMode()) switched = switchModeViaCard(want);
    if (want && !switched) logWarn(TAG, '未能切到模式 ' + want + '（样式卡不存在），其余参数已生效');

    try { applyInterfaceSettings(); } catch (e) { logCatch(TAG, e); }
    try { applyModeSettings(currentMode()); } catch (e) { logCatch(TAG, e); }

    /* 翻译/罗马音是渲染期决定的：modeSettings 与 lyrics 已被配方同时改成新值，
       applyModeSettings 里的 needRender 判定因此恒为 false，必须自己补一次重渲染，
       否则要等下一首歌才看得到变化。 */
    const flat = (recipe && recipe.lyrics) || {};
    const needsRerender = flat.showTranslation !== undefined || flat.showRomaji !== undefined
        || hasAnyKey(recipe && recipe.modeSettings, 'showTranslation')
        || hasAnyKey(recipe && recipe.modeSettings, 'showRomaji');
    if (needsRerender) {
        try { if (Array.isArray(state.lyrics) && state.lyrics.length) renderLyrics(state.lyrics); } catch (e) { logCatch(TAG, e); }
    }
    return { ok: true, counts: res.counts };
}

/** 走「人手点样式卡」的同一条路切模式（220 的 switchView 未导出，也不该导） */
function switchModeViaCard(mode) {
    const d = doc();
    if (!d) return false;
    /* data-mode 值经 core 校验只会是 [a-z] 开头的标识符，这里再洗一遍纯属兜底 */
    const safe = String(mode).replace(/[^A-Za-z0-9_-]/g, '');
    const card = d.querySelector('.view-mode-card[data-mode="' + safe + '"]');
    if (!card || typeof card.click !== 'function') return false;
    try {
        card.click();
        return true;
    } catch (e) {
        logCatch(TAG, e);
        return false;
    }
}

/* ==================== 分享码 ==================== */

function encodeForShare(recipe) {
    try {
        return { ok: true, code: encodeRecipe(recipe) };
    } catch (e) {
        return { ok: false, errors: (e && e.errors) || [{ path: '$', code: 'unknown' }] };
    }
}

function copyText(text) {
    const done = (ok) => showToast(ok ? '分享码已复制到剪贴板' : '复制失败，请手动选中复制');
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => done(true), () => fallbackCopy(text, done));
            return;
        }
    } catch (e) { logCatch(TAG, e); }
    fallbackCopy(text, done);
}

/** 没有 Clipboard API（或权限被拒）时靠一个临时 textarea + execCommand 兜底 */
function fallbackCopy(text, done) {
    const d = doc();
    if (!d || !d.body) { done(false); return; }
    let ta = null;
    try {
        ta = d.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-2000px;left:0;opacity:0;';
        d.body.appendChild(ta);
        ta.select();
        const ok = typeof d.execCommand === 'function' && d.execCommand('copy');
        done(!!ok);
    } catch (e) {
        logCatch(TAG, e);
        done(false);
    } finally {
        try { if (ta) ta.remove(); } catch (e) { logCatch(TAG, e); }
    }
}

/* ==================== 弹层 ==================== */

let panel = null;
/** 面板内的一次性状态：分享码框 / 导入错误与回填文本，重渲染前先写在这里 */
let draft = { shareCode: '', shareTitle: '', importErrors: [], importText: '' };

function openPanel() {
    const d = doc();
    if (!d) return;
    if (!panel) {
        panel = d.createElement('div');
        panel.className = 'search-overlay vfx-recipe-overlay';
        panel.id = OVERLAY_ID;
        d.body.appendChild(panel);
        panel.addEventListener('click', (e) => {
            if (e.target === panel) { closePanel(); return; }
            handlePanelClick(e);
        });
        panel.addEventListener('input', handlePanelInput);
        /* 文件选择走 change 事件：type=file 在部分浏览器不发 input */
        panel.addEventListener('change', handlePanelChange);
        d.addEventListener('keydown', onPanelKeydown);
    }
    renderPanel();
    /* 先入 DOM 再加 .visible：否则 opacity 没有起始值，motion.css 那套入场不跑 */
    requestAnimationFrame(() => panel.classList.add('visible'));
}

function closePanel() {
    if (!panel) return;
    panel.classList.remove('visible');
    draft = { shareCode: '', shareTitle: '', importErrors: [], importText: '' };
}

function isPanelOpen() { return !!panel && panel.classList.contains('visible'); }

function onPanelKeydown(e) {
    if (e.key === 'Escape' && isPanelOpen()) { e.preventDefault(); closePanel(); }
}

/** 「歌词排版 9 · 背景 6 · 各模式版式偏好 24」——列表与确认弹窗共用 */
function groupStatLine(recipe) {
    const sum = summarizeRecipe(recipe);
    const bits = [];
    for (const g of RECIPE_GROUPS) {
        if (sum.groups[g.key] > 0) bits.push(g.label + ' ' + sum.groups[g.key]);
    }
    return bits.length ? bits.join(' · ') : '（空）';
}

/** 两份配方是否等价（键序无关）。只用于「当前」角标，不参与任何写入判定 */
function sameRecipe(a, b) {
    try { return canonicalJSON(a || {}) === canonicalJSON(b || {}); } catch (e) { logCatch(TAG, e); return false; }
}

function presetRowHTML(p, activeRecipe) {
    return `<div class="vr-row" data-id="${esc(p.id)}">
        <div class="vr-row-main">
            <div class="vr-name">${esc(p.name)}</div>
            <div class="vr-meta">${esc(groupStatLine(p.recipe))}</div>
        </div>
        <div class="vr-row-actions">
            ${sameRecipe(p.recipe, activeRecipe) ? '<span class="vr-tag">当前</span>' : ''}
            <button type="button" class="setting-btn primary" data-act="apply">应用</button>
            <button type="button" class="setting-btn" data-act="share">分享码</button>
            <button type="button" class="setting-btn" data-act="overwrite">覆盖</button>
            <button type="button" class="setting-btn" data-act="rename">重命名</button>
            <button type="button" class="setting-btn vr-danger" data-act="delete">删除</button>
        </div>
    </div>`;
}

/* 静态中文要落在「无子元素 + 类名在 i18n 白名单」的节点上，所以键名与说明拆两个兄弟 */
function noteItemHTML(key, text) {
    return `<li class="vr-li"><code class="vr-li-key">${esc(key)}</code><span class="setting-desc">${esc(text)}</span></li>`;
}

function importResultHTML() {
    if (!draft.importErrors.length) return '';
    const rows = draft.importErrors.slice(0, 12).map(err => {
        const text = ERROR_TEXT[err.code] || '无法解析';
        const expect = err.expect ? '（应为 ' + err.expect + '）' : '';
        return `<li class="vr-li"><code class="vr-li-key">${esc(err.path || '?')}</code><span class="setting-desc">${esc(text + expect)}</span></li>`;
    }).join('');
    const more = draft.importErrors.length > 12
        ? '<li class="vr-li"><span class="setting-desc">另有 ' + (draft.importErrors.length - 12) + ' 条未列出</span></li>' : '';
    return `<div class="vr-result vr-result-bad">
        <div class="setting-label">导入被拒绝，原有设置一个字节都没改</div>
        <ul class="vr-list">${rows}${more}</ul>
    </div>`;
}

function renderPanel() {
    const d = doc();
    if (!d || !panel) return;
    const list = readPresets();
    const active = captureCurrent();
    const codeHint = CODE_PREFIX + SCHEMA_VERSION + '.';
    /* 「当前外观」分享码常显（2026-09-26 用户要求）：没有行内草稿时始终展示
       当前外观的分享码；行内「分享码」产生的草稿临时顶替显示，「收起」后回到当前外观。 */
    let shareTitle = '当前外观';
    let shareCode = '';
    if (draft.shareCode) {
        shareTitle = draft.shareTitle;
        shareCode = draft.shareCode;
    } else {
        const enc = encodeForShare(active);
        if (enc.ok) shareCode = enc.code;
    }
    panel.innerHTML = `
    <div class="vfx-recipe-modal" role="dialog" aria-modal="true" aria-labelledby="vfxRecipeTitleText">
        <div class="vr-head">
            <span class="vr-title setting-label" id="vfxRecipeTitleText">视觉配方</span>
            <span class="vr-count">${list.length} / ${MAX_PRESETS}</span>
            <button type="button" class="vr-close" data-act="close" title="关闭">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                    <line x1="6" y1="6" x2="18" y2="18"></line><line x1="18" y1="6" x2="6" y2="18"></line>
                </svg>
            </button>
        </div>
        <div class="vr-scroll">
            <div class="vr-list-wrap">${list.length
                ? list.map(p => presetRowHTML(p, active)).join('')
                : '<div class="empty-hint">还没有配方，可粘贴分享码导入创建。</div>'}</div>
            <div class="vr-block">
                <div class="vr-block-title setting-label">导入分享码</div>
                <textarea class="vr-input vr-textarea" id="vrImportBox" spellcheck="false"
                    placeholder="${esc('粘贴以 ' + codeHint + ' 开头的分享码')}">${esc(draft.importText)}</textarea>
                <div class="vr-toolbar">
                    <button type="button" class="setting-btn" data-act="import">校验并导入</button>
                </div>
                ${importResultHTML()}
                <div class="setting-desc vr-note">导入前会逐条校验版本、校验和与每个参数的取值范围；有任何一项不合格就整份拒绝，不会只导入一半。</div>
            </div>
            <div class="vr-block">
                <div class="vr-block-title setting-label">外观 mod 文件</div>
                <div class="vr-toolbar">
                    <button type="button" class="setting-btn primary" data-act="pick-mod">选择 mod 文件…</button>
                    <button type="button" class="setting-btn" data-act="export-mod">导出当前外观</button>
                </div>
                <input type="file" class="vr-file" id="vrModFile" accept=".json,application/json" hidden>
                <div class="setting-desc vr-note">mod 文件是一段带名字的配方（.aria-theme.json），与分享码走同一套白名单校验，任何一项不合格就整份拒绝；文件内容只按数据读，不会被当作代码执行。</div>
            </div>
            <div class="vr-block">
                <div class="vr-block-title setting-label">${esc(shareTitle)}</div>
                <textarea class="vr-input vr-textarea" id="vrShareBox" readonly spellcheck="false">${esc(shareCode)}</textarea>
                <div class="vr-toolbar">
                    <button type="button" class="setting-btn primary" data-act="copy-share">复制</button>
                    ${draft.shareCode ? '<button type="button" class="setting-btn" data-act="clear-share">收起</button>' : ''}
                </div>
            </div>
        </div>
    </div>`;
}

function handlePanelInput(e) {
    if (!e || !e.target) return;
    if (e.target.id === 'vrImportBox') draft.importText = String(e.target.value || '');
}

function handlePanelChange(e) {
    if (!e || !e.target || e.target.id !== 'vrModFile') return;
    const file = e.target.files && e.target.files[0];
    /* 先清空 value：否则连续选同一个文件不会再触发 change（用户改完文件重选会"没反应"） */
    e.target.value = '';
    if (!file) return;
    /* doImportModFile 内部已 catch 读取失败；这里再兜一层，避免未处理拒绝 */
    Promise.resolve(doImportModFile(file)).catch((err) => {
        logCatch(TAG, err);
        showToast('导入 mod 文件失败');
    });
}

function handlePanelClick(e) {
    const btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn || !panel || !panel.contains(btn)) return;
    const row = btn.closest('.vr-row');
    const id = row ? row.getAttribute('data-id') : '';
    try {
        runAction(btn.getAttribute('data-act'), id);
    } catch (err) { logCatch(TAG, err); }
}

function runAction(act, id) {
    switch (act) {
        case 'close': closePanel(); break;
        case 'share': sharePreset(id); break;
        case 'apply': applyPreset(id); break;
        case 'overwrite': overwritePreset(id); break;
        case 'rename': promptRename(id); break;
        case 'delete': confirmDelete(id); break;
        case 'import': doImport(); break;
        case 'pick-mod': { const f = byId('vrModFile'); if (f) f.click(); break; }
        case 'export-mod': doExportMod(); break;
        /* 复制的是区块里实际显示的那串（当前外观常显码 或 行内分享码草稿） */
        case 'copy-share': copyText((byId('vrShareBox') || {}).value || ''); break;
        case 'clear-share': draft.shareCode = ''; draft.shareTitle = ''; renderPanel(); break;
        /* 点进了行内但不是动作按钮（比如选文本复制）：什么都不做 */
        default: break;
    }
}

function presetById(id) {
    return readPresets().find(p => p.id === id) || null;
}

function askText(title, placeholder, value, cb) {
    if (typeof window === 'undefined' || typeof window.showGlassPrompt !== 'function') {
        showToast('输入弹窗未就绪');
        return;
    }
    window.showGlassPrompt({ title, placeholder, value: value || '', onSubmit: cb });
}

function promptRename(id) {
    const p = presetById(id);
    if (!p) { renderPanel(); return; }
    askText('重命名配方', '新名字', p.name, (raw) => {
        const name = sanitizeRecipeName(raw);
        if (!name) { showToast('名字不能为空'); return; }
        const res = renamePreset(readPresets(), id, name);
        if (res.action === 'rejected') {
            showToast(res.reason === 'duplicate-name' ? '已经有同名配方了' : '重命名失败');
            return;
        }
        writePresets(res.list);
        showToast('已重命名为「' + name + '」');
        renderPanel();
    });
}

function overwritePreset(id) {
    const p = presetById(id);
    if (!p) { renderPanel(); return; }
    const next = readPresets().map(x => (x.id === id ? { ...x, recipe: captureCurrent(), updatedAt: Date.now() } : x));
    if (!writePresets(next)) { showToast('保存失败'); return; }
    showToast('已用当前外观覆盖「' + p.name + '」');
    renderPanel();
}

function confirmDelete(id) {
    const p = presetById(id);
    if (!p) { renderPanel(); return; }
    const run = () => {
        writePresets(removePreset(readPresets(), id).list);
        showToast('已删除「' + p.name + '」');
        renderPanel();
    };
    confirmGlass('删除配方', '「' + p.name + '」将被删除，无法恢复。', '删除', run);
}

function applyPreset(id) {
    const p = presetById(id);
    if (!p) { renderPanel(); return; }
    const run = () => {
        const res = applyRecipe(p.recipe);
        if (!res.ok) { showToast(res.reason === 'invalid' ? '配方不合法，已拒绝应用' : '设置未就绪'); return; }
        showToast('已应用配方「' + p.name + '」');
        renderPanel();
    };
    confirmGlass('应用配方「' + p.name + '」',
        '会覆盖当前 ' + summarizeRecipe(p.recipe).total + ' 项视觉参数（' + groupStatLine(p.recipe) + '）。',
        '应用', run);
}

/**
 * 二次确认。021 的毛玻璃确认框在（bootApp 之前就已 import 完）就走它；
 * 万一拿不到就直接放行——确认 UI 缺席不该把功能本身卡死，且配方应用是可撤销的操作
 * （再点一次原配方或用「把当前外观存为配方」留底），不是危险动作。
 * ⚠ 021 返回的是自制的 **thenable**（`{ close, then(fn) }`），不是真 Promise：
 *    只能 `.then(cb)`，链 `.catch()` 会直接 TypeError（实测会把整个动作吃掉）。
 */
function confirmGlass(title, desc, okText, onOk, danger) {
    const api = (typeof window !== 'undefined') ? window.showGlassConfirm : null;
    if (typeof api !== 'function') { onOk(); return; }
    try {
        const dlg = api({ title, desc, okText, danger: !!danger });
        if (dlg && typeof dlg.then === 'function') { dlg.then(ok => { if (ok) onOk(); }); return; }
        logWarn(TAG, 'showGlassConfirm 返回值不可 then，跳过确认直接执行');
    } catch (e) { logCatch(TAG, e); }
    onOk();
}

function sharePreset(id) {
    const p = presetById(id);
    if (!p) { renderPanel(); return; }
    showShare('配方「' + p.name + '」的分享码', p.recipe);
}

function showShare(title, recipe) {
    const res = encodeForShare(recipe);
    if (!res.ok) {
        draft.importErrors = res.errors;
        showToast('这份配方不合法，生成不了分享码');
        renderPanel();
        return;
    }
    draft.shareCode = res.code;
    draft.shareTitle = title;
    draft.importErrors = [];
    renderPanel();
    const box = byId('vrShareBox');
    if (box) { try { box.select(); } catch (e) { logCatch(TAG, e); } }
}

/**
 * 玻璃确认框（Promise 形态）。没有对话框 API 时直接判 true —— 宁可执行也不静默失败。
 *
 * ★ 与既有的 confirmGlass 的区别：那个是「回调 + 返回 undefined」的混合形态，
 *   调用点写成 `if (confirmGlass(...)) return; run();` —— 在 API 缺失那一路会
 *   onOk() 与 run() **双跑**（onOk 立即执行，返回 undefined 又不会 return）。
 *   导入是不可撤销的覆盖动作，这里统一成 Promise，消除该歧义；
 *   既有 confirmGlass 的三个调用点行为不变，留着不动以免扩大改动面。
 */
function confirmGlassAsk(title, desc, okText, danger) {
    const api = (typeof window !== 'undefined') ? window.showGlassConfirm : null;
    if (typeof api !== 'function') return Promise.resolve(true);
    try {
        const dlg = api({ title, desc, okText, danger: !!danger });
        if (dlg && typeof dlg.then === 'function') {
            return dlg.then(v => v === true, (e) => { logCatch(TAG, e); return false; });
        }
        logWarn(TAG, 'showGlassConfirm 返回值不可 then，按已确认处理');
    } catch (e) { logCatch(TAG, e); return Promise.resolve(false); }
    return Promise.resolve(true);
}

/** 触发一次文本文件下载（导出 mod 用），不依赖任何库 */
function downloadText(filename, text) {
    const d = doc();
    if (!d) return false;
    try {
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = d.createElement('a');
        a.href = url;
        a.download = filename;
        d.body.appendChild(a);
        a.click();
        d.body.removeChild(a);
        /* 立刻 revoke 会让部分浏览器来不及取数据、下载被截断，延后释放 */
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { logCatch(TAG, e); } }, 4000);
        return true;
    } catch (e) { logCatch(TAG, e); return false; }
}

/** 导入成功后统一落库 + 提示（分享码与 mod 文件两条入口共用）。
 *  nameHint 来自 mod 文件的 name 字段（外部数据）——它只经 showToast（textContent）
 *  与 sanitizeRecipeName → esc() 的上屏路径，不会进 innerHTML 裸拼。 */
function runImport(recipe, nameHint, note) {
    const r = applyRecipe(recipe);
    if (!r.ok) { showToast('导入失败：配方不合法'); renderPanel(); return; }
    const name = sanitizeRecipeName(nameHint || (IMPORTED_PREFIX + ' ' + new Date().toLocaleDateString()));
    const up = upsertPreset(readPresets(), { id: newPresetId(), name, recipe });
    if (up.action !== 'rejected') writePresets(up.list);
    showToast('已导入并应用，同时存为配方「' + name + '」' + (note || ''));
    renderPanel();
}

function doImport() {
    const box = byId('vrImportBox');
    const text = box ? String(box.value || '') : draft.importText;
    draft.importText = text;
    if (!text.trim()) { showToast('先粘贴一段分享码'); return; }
    const res = decodeRecipe(text);
    if (!res.ok) {
        draft.importErrors = res.errors;
        renderPanel();
        showToast('分享码被拒绝，详见面板里的逐条原因');
        return;
    }
    draft.importErrors = [];
    confirmGlassAsk('分享码校验通过', '将覆盖 ' + summarizeRecipe(res.recipe).total
        + ' 项视觉参数（' + groupStatLine(res.recipe) + '），并自动存为一条新配方。', '导入并应用').then((ok) => {
        if (ok) runImport(res.recipe, '');
    });
}

/** 导入一个 .aria-theme.json 外观 mod 文件 */
function doImportModFile(file) {
    if (!file) return Promise.resolve();
    return file.text().then((text) => {
        const res = parseThemeMod(text);
        if (!res.ok) {
            draft.importErrors = res.errors;
            renderPanel();
            showToast('mod 文件被拒绝，详见面板里的逐条原因');
            return;
        }
        draft.importErrors = [];
        const meta = res.meta || {};
        const who = meta.author ? '　— ' + meta.author : '';
        const head = meta.name ? '「' + meta.name + '」' : '这份 mod';
        const desc = head + who + '：将覆盖 ' + summarizeRecipe(res.recipe).total
            + ' 项视觉参数（' + groupStatLine(res.recipe) + '），并自动存为一条新配方。';
        return confirmGlassAsk('mod 文件校验通过', desc, '导入并应用').then((ok) => {
            if (!ok) return;
            runImport(res.recipe, meta.name, meta.description ? '（' + meta.description + '）' : '');
        });
    }, (err) => {
        logCatch(TAG, err);
        showToast('读取 mod 文件失败');
    });
}

/** 把当前外观导出成 .aria-theme.json mod 文件 */
function doExportMod() {
    const recipe = captureCurrent();
    const stamp = new Date().toISOString().slice(0, 10);
    const total = summarizeRecipe(recipe).total;
    let text = '';
    try {
        /* ★ 用带插值的整句而不是字符串拼接：i18n 复扫把「有 {占位符} 的句子」
           归到动态桶（只提示人复核），拼接出来的碎片却要逐条进词表 ——
           而且碎片翻译成英文后拼起来是病句。 */
        text = serializeThemeMod(recipe, {
            name: `Aria 外观 ${stamp}`,
            description: `由 Aria 导出的当前外观，共 ${total} 项视觉参数`,
        });
    } catch (e) {
        logCatch(TAG, e);
        showToast('当前外观不合法，导出失败');
        return;
    }
    if (downloadText('aria-theme-' + stamp + '.aria-theme.json', text)) {
        showToast(`已导出 mod 文件（${total} 项视觉参数）`);
    } else {
        showToast('导出失败：无法创建下载');
    }
}

/* ==================== 入口按钮 / 设置组（自建自挂） ==================== */

function ensureStylesheet() {
    const d = doc();
    if (!d || !d.head) return;
    try {
        const links = Array.from(d.querySelectorAll('link[rel="stylesheet"]'));
        for (const l of links) if (l.href && l.href.indexOf('/styles/vfx-recipe.css') >= 0) return;
        if (byId(STYLE_ID)) return;
        const link = d.createElement('link');
        link.rel = 'stylesheet';
        link.id = STYLE_ID;
        link.href = new URL('../styles/vfx-recipe.css', import.meta.url).href;
        d.head.appendChild(link);
    } catch (e) { logCatch(TAG, e); }
}

/** 设置 → 视觉模式 底部自挂一个说明组（正解是写进 index.html，这条兜底保证不改也能用） */
function mountSettingsGroup() {
    const d = doc();
    if (!d || byId(SETTINGS_GROUP_ID)) return;
    /* 挂「数据」页而不是「视觉模式」：配方本质是保存/导出/导入一组预设，与
       数据备份迁移同类；挂在视觉模式里会把该页右侧撑出一整片空白（2026-09-26 用户反馈）。
       数据页不存在时才退回原处，最后兜底 settingsBody。 */
    const host = q('[data-section="data"]') || q('[data-section="appearance"]') || q('#settingsBody');
    if (!host) return;
    try {
        const group = d.createElement('div');
        group.className = 'settings-group';
        group.id = SETTINGS_GROUP_ID;
        group.innerHTML = `
            <div class="settings-group-title">视觉配方</div>
            <div class="setting-row">
                <div>
                    <div class="setting-label">保存 / 分享当前所有视觉参数</div>
                    <div class="setting-desc">把模式、字号、模糊、摇摆、高亮色与各模式的版式偏好存成命名预设，或复制成一段分享码发给朋友。API Key、登录态、本地路径、语言与快捷键都不在内。</div>
                </div>
                <div class="setting-control"><button type="button" class="setting-btn" id="vrOpenFromSettings">管理配方</button></div>
            </div>`;
        host.appendChild(group);
        byId('vrOpenFromSettings')?.addEventListener('click', openPanel);
    } catch (e) { logCatch(TAG, e); }
}

/* ==================== 启动 ==================== */

/**
 * 设置面板的节内容是按需重建的（200 每次进 appearance 都会 buildAppearanceControls），
 * 兜底做法与 282 一致：盯 #settingsOverlay 的 class，面板一开就确认说明组还在。
 * 正解仍是在 index.html 里静态写进 [data-section="appearance"]（接线清单第 3 条）。
 */
function watchSettingsPanel() {
    const d = doc();
    const overlay = d && d.getElementById ? d.getElementById('settingsOverlay') : null;
    if (!overlay || typeof MutationObserver === 'undefined') return;
    try {
        new MutationObserver(() => {
            if (overlay.classList.contains('visible')) mountSettingsGroup();
        }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
    } catch (e) { logCatch(TAG, e); }
}

function boot() {
    try {
        ensureStylesheet();
        mountSettingsGroup();
        watchSettingsPanel();
        /* 语言切换后把开着的panel重画一遍：静态中文靠 i18n observer 扫，
           但错误清单/分享码标题这些本模块自己拼的串得重出一次 */
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('aria:languagechange', () => {
                try { if (isPanelOpen()) renderPanel(); } catch (e) { logCatch(TAG, e); }
            });
        }
    } catch (e) { logCatch(TAG, e); }
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
}

export {
    applyRecipe,
    captureCurrent,
    closePanel,
    isPanelOpen,
    openPanel,
    readPresets,
    writePresets,
};
