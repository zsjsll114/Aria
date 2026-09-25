/* ============================================================
 * 290-vfx-recipe.js — 视觉配方：保存 / 命名 / 分享码（todos #9）
 *
 * 形态：右上角一个入口按钮 + 一套自建的毛玻璃面板（列表 / 新建 / 重命名 / 覆盖 /
 * 删除 / 应用 / 复制分享码 / 导入分享码），并在「设置 → 视觉模式」底部自挂一个
 * 说明组，把「哪些进配方、哪些绝不进」写在用户看得见的地方。
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
    BUILTIN_FONTS, CODE_PREFIX, ERROR_TEXT, FORBIDDEN_KEYS, MAX_PRESETS, MODE_FIELDS_BY_MODE,
    RECIPE_GROUPS, SCHEMA_VERSION, VIEW_MODES,
    applyRecipeToSettings, canonicalJSON, collectRecipe, decodeRecipe, encodeRecipe,
    newPresetId, normalizePresetList, removePreset, renamePreset, sanitizeRecipeName,
    summarizeRecipe, upsertPreset,
} from '../core/vfxRecipe.js';

const TAG = 'vfxRecipe';
const BTN_ID = 'vfxRecipeBtn';
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
        d.addEventListener('keydown', onPanelKeydown);
    }
    renderPanel();
    /* 先入 DOM 再加 .visible：否则 opacity 没有起始值，motion.css 那套入场不跑 */
    requestAnimationFrame(() => panel.classList.add('visible'));
    syncButton();
}

function closePanel() {
    if (!panel) return;
    panel.classList.remove('visible');
    draft = { shareCode: '', shareTitle: '', importErrors: [], importText: '' };
    syncButton();
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

function includedNoteHTML() {
    return RECIPE_GROUPS.map(g => {
        const tail = g.key === 'modeSettings' ? '（' + Object.keys(MODE_FIELDS_BY_MODE).length + ' 个模式各自一套）' : '';
        return noteItemHTML(g.label, g.desc + tail);
    }).join('');
}

function forbiddenNoteHTML() {
    return FORBIDDEN_KEYS.map(f => noteItemHTML(f.key, f.reason)).join('');
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
    panel.innerHTML = `
    <div class="vfx-recipe-modal" role="dialog" aria-modal="true" aria-labelledby="vfxRecipeTitleText">
        <div class="vr-head">
            <span class="vr-title setting-label" id="vfxRecipeTitleText">视觉配方</span>
            <button type="button" class="vr-close" data-act="close" title="关闭">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                    <line x1="6" y1="6" x2="18" y2="18"></line><line x1="18" y1="6" x2="6" y2="18"></line>
                </svg>
            </button>
        </div>
        <div class="vr-scroll">
            <div class="vr-toolbar">
                <button type="button" class="setting-btn primary" data-act="create">把当前外观存为配方</button>
                <button type="button" class="setting-btn" data-act="share-current">复制当前分享码</button>
                <span class="vr-count">${list.length} / ${MAX_PRESETS}</span>
            </div>
            <div class="vr-list-wrap">${list.length
                ? list.map(p => presetRowHTML(p, active)).join('')
                : '<div class="empty-hint">还没有配方。调好一套观感后点上面第一个按钮。</div>'}</div>
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
            ${draft.shareCode ? `
            <div class="vr-block">
                <div class="vr-block-title setting-label">${esc(draft.shareTitle)}</div>
                <textarea class="vr-input vr-textarea" id="vrShareBox" readonly spellcheck="false">${esc(draft.shareCode)}</textarea>
                <div class="vr-toolbar">
                    <button type="button" class="setting-btn primary" data-act="copy-share">复制</button>
                    <button type="button" class="setting-btn" data-act="clear-share">收起</button>
                </div>
            </div>` : ''}
            <details class="vr-details">
                <summary class="setting-label">配方包含哪些设置、绝不包含哪些</summary>
                <div class="vr-block-title setting-label">会带走</div>
                <ul class="vr-list">${includedNoteHTML()}</ul>
                <div class="vr-block-title setting-label">绝不带走（敏感或本机专属）</div>
                <ul class="vr-list vr-list-forbid">${forbiddenNoteHTML()}</ul>
                <div class="setting-desc vr-note">${esc('字体只支持内置的 ' + BUILTIN_FONTS.join(' / ') + '；自定义字体文件与整条 CSS 字体栈不进分享码，导入后会保留你机器上原有的字体设置。')}</div>
            </details>
        </div>
    </div>`;
}

function handlePanelInput(e) {
    if (!e || !e.target) return;
    if (e.target.id === 'vrImportBox') draft.importText = String(e.target.value || '');
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
        case 'create': promptCreate(); break;
        case 'share-current': showShare('当前外观', captureCurrent()); break;
        case 'share': sharePreset(id); break;
        case 'apply': applyPreset(id); break;
        case 'overwrite': overwritePreset(id); break;
        case 'rename': promptRename(id); break;
        case 'delete': confirmDelete(id); break;
        case 'import': doImport(); break;
        case 'copy-share': copyText(draft.shareCode); break;
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

function promptCreate() {
    askText('保存为视觉配方', '给这套观感起个名字', '', (raw) => {
        const name = sanitizeRecipeName(raw);
        if (!name) { showToast('名字不能为空'); return; }
        const res = upsertPreset(readPresets(), { id: newPresetId(), name, recipe: captureCurrent() });
        if (res.action === 'rejected') {
            showToast(res.reason === 'too-many' ? '配方数量已达上限' : '保存失败：配方内容不合法');
            return;
        }
        writePresets(res.list);
        showToast('已保存配方「' + name + '」');
        renderPanel();
    });
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
    const run = () => {
        const r = applyRecipe(res.recipe);
        if (!r.ok) { showToast('导入失败：配方不合法'); renderPanel(); return; }
        const name = sanitizeRecipeName(IMPORTED_PREFIX + ' ' + new Date().toLocaleDateString());
        const up = upsertPreset(readPresets(), { id: newPresetId(), name, recipe: res.recipe });
        if (up.action !== 'rejected') writePresets(up.list);
        showToast('已导入并应用，同时存为配方「' + name + '」');
        renderPanel();
    };
    if (confirmGlass('分享码校验通过', '将覆盖 ' + summarizeRecipe(res.recipe).total
        + ' 项视觉参数（' + groupStatLine(res.recipe) + '），并自动存为一条新配方。', '导入并应用', run)) {
        return;
    }
    run();
}

/* ==================== 入口按钮 / 设置组（自建自挂） ==================== */

const BTN_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M12 3a9 9 0 1 0 0 18h1.5a2.5 2.5 0 0 0 0-5H13a2 2 0 0 1 0-4h2a5 5 0 0 0 5-5v-1z"></path>'
    + '<circle cx="8" cy="9.5" r="1.1" fill="currentColor" stroke="none"></circle>'
    + '<circle cx="12" cy="7" r="1.1" fill="currentColor" stroke="none"></circle>'
    + '<circle cx="16" cy="9.5" r="1.1" fill="currentColor" stroke="none"></circle></svg>';

function syncButton() {
    const btn = byId(BTN_ID);
    if (!btn) return;
    btn.classList.toggle('on', isPanelOpen());
    btn.setAttribute('aria-pressed', isPanelOpen() ? 'true' : 'false');
}

function ensureButton() {
    const d = doc();
    if (!d) return;
    if (byId(BTN_ID)) return;
    const host = q('.top-action-buttons');
    /* 顶栏不在（手机版双页/别的宿主页）就只丢入口，不影响设置页那条路 */
    if (!host) return;
    const btn = d.createElement('button');
    btn.type = 'button';
    btn.id = BTN_ID;
    btn.className = 'icon-action-btn';
    btn.setAttribute('data-tooltip', '视觉配方');
    btn.setAttribute('aria-label', '视觉配方');
    btn.innerHTML = BTN_ICON;
    /* 排在「切换样式」之后：两个都是改观感的入口，摆一起才找得到 */
    const anchor = byId('openViewModeBtn');
    host.insertBefore(btn, anchor && anchor.nextSibling ? anchor.nextSibling : null);
    btn.addEventListener('click', () => { if (isPanelOpen()) closePanel(); else openPanel(); });
}

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
    const host = q('[data-section="appearance"]') || q('#settingsBody');
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
        ensureButton();
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
