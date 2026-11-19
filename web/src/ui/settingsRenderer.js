/* ============================================================
 * ui/settingsRenderer.js — 设置面板声明式渲染器与视觉工坊控制器
 *
 * 职责：
 *  1. 由 SETTINGS_NAV + SETTINGS_SECTIONS_SCHEMA + appearanceSchema +
 *     settingsRegistry 唯一事实源同步构建 #settingsBody 全量 13 节 DOM，
 *     彻底移除 index.html 内 1300+ 行静态配置重复 HTML。
 *  2. 「视觉模式 / appearance」渲染为「视觉工坊」：顶部单行模式胶囊条
 *     （前/后切 + 「全部 13 种模式 ▾」4 家族宫格浮层），内部保持
 *     #lyricStyleControls .appearance-mode-btn[data-mode="..."] 兼容。
 *  3. 各模式参数按 核心参数 / 进阶与后期处理 / 独立背景与字体覆写 三层展开，
 *     并在覆写层呈现「跟随全局 / 已覆写」实时状态与一键恢复按钮。
 * ============================================================ */

import { esc } from '../utils/formatters.js';
import { logCatch } from '../services/log.js';
import { SETTINGS_NAV } from '../config/settingsNav.js';
import { SETTINGS_SECTIONS_SCHEMA } from '../config/settingsSchema.js';
import {
  APPEARANCE_FAMILIES,
  APPEARANCE_MODES,
  APPEARANCE_MODE_MAP,
  APPEARANCE_TIER_META,
  APPEARANCE_SECTIONS,
} from '../config/appearanceSchema.js';
import {
  getGroupsForTab,
  getHooksForTab,
} from '../core/settingsRegistry.js';

const TAG = 'settingsRenderer';

/** @type {Set<string>} 已执行过 onMount 生命周期的组/钩子 key（保证幂等） */
const _mountedKeys = new Set();

/** @param {string} zh */
function tx(zh) {
  try {
    const g = /** @type {any} */ (globalThis);
    if (g.AriaI18n && typeof g.AriaI18n.translatePhrase === 'function') {
      return g.AriaI18n.translatePhrase(zh);
    }
  } catch (e) {
    logCatch(TAG, e);
  }
  return zh;
}

function isEnLang() {
  try {
    const g = /** @type {any} */ (globalThis);
    return Boolean(g.AriaI18n && typeof g.AriaI18n.getLanguage === 'function' && g.AriaI18n.getLanguage() === 'en-US');
  } catch (e) {
    logCatch(TAG, e);
    return false;
  }
}

function getFamilyMap() {
  /** @type {Record<string, any>} */
  const map = {};
  for (const f of APPEARANCE_FAMILIES) map[f.id] = f;
  return map;
}

/**
 * 渲染单个 Schema 控件
 * @param {any} c
 * @returns {string}
 */
function renderControl(c) {
  if (!c) return '';
  if (c.kind === 'slider') {
    const vAttr = c.var ? ` data-var="${esc(c.var)}"` : '';
    const min = c.min !== undefined ? ` min="${esc(c.min)}"` : '';
    const max = c.max !== undefined ? ` max="${esc(c.max)}"` : '';
    const step = c.step !== undefined ? ` step="${esc(c.step)}"` : '';
    const val = c.value !== undefined ? ` value="${esc(c.value)}"` : '';
    return `<input type="range" class="setting-slider"${vAttr}${min}${max}${step}${val}>`;
  }
  if (c.kind === 'color') {
    const vAttr = c.var ? ` data-var="${esc(c.var)}"` : '';
    const palAttr = c.palette ? ` data-palette="${esc(c.palette)}"` : '';
    const actAttr = c.active ? ` data-active="${esc(c.active)}"` : '';
    return `<div class="setting-color-row"${vAttr}${palAttr}${actAttr}></div>`;
  }
  if (c.kind === 'segment') {
    const cls = c.cls ? esc(c.cls) : 'setting-btn-group';
    const btns = (c.buttons || []).map((/** @type {any} */ b) => {
      const activeCls = b.active ? ' active' : '';
      const vAttr = b.var ? ` data-var="${esc(b.var)}"` : '';
      const valAttr = b.val !== undefined ? ` data-val="${esc(b.val)}"` : '';
      const alignAttr = b.align !== undefined ? ` data-align="${esc(b.align)}"` : '';
      return `<button type="button" class="setting-btn${activeCls}"${vAttr}${valAttr}${alignAttr}>${esc(b.text || '')}</button>`;
    }).join('');
    return `<div class="${cls}">${btns}</div>`;
  }
  if (c.kind === 'toggle') {
    const activeCls = c.active ? ' on' : '';
    const vAttr = c.var ? ` data-var="${esc(c.var)}"` : '';
    return `<button type="button" class="setting-toggle${activeCls}"${vAttr}></button>`;
  }
  if (c.kind === 'dropdown') {
    const cls = c.cls ? esc(c.cls) : 'setting-dropdown';
    const vAttr = c.var ? ` data-var="${esc(c.var)}"` : '';
    const opts = (c.options || []);
    const selectedOpt = opts.find((/** @type {any} */ o) => o.selected) || opts[0];
    const trigText = c.triggerText || (selectedOpt ? selectedOpt.text : '');
    const itemsHtml = opts.map((/** @type {any} */ o) => {
      const selCls = o.selected ? ' selected' : '';
      return `<div class="setting-dropdown-item${selCls}" data-value="${esc(o.value ?? '')}">${esc(o.text ?? '')}</div>`;
    }).join('');
    return `<div class="${cls}"${vAttr}><div class="setting-dropdown-trigger">${esc(trigText)}</div><div class="setting-dropdown-menu">${itemsHtml}</div></div>`;
  }
  if (c.kind === 'button') {
    const cls = c.cls ? esc(c.cls) : 'setting-btn';
    return `<button type="button" class="${cls}">${esc(c.text || '')}</button>`;
  }
  return '';
}

/** @param {any} row */
function renderRow(row) {
  const descHtml = row.desc ? `<div class="setting-desc">${esc(row.desc)}</div>` : '';
  const ctrlsHtml = (row.controls || []).map(renderControl).join('');
  const valSpanHtml = row.valSpan
    ? `<span class="setting-value" data-val="${esc(row.valSpan.var || '')}">${esc(row.valSpan.text || '')}</span>`
    : '';
  return `<div class="setting-row"><div><div class="setting-label">${esc(row.label || '')}</div>${descHtml}</div><div class="setting-control">${ctrlsHtml}${valSpanHtml}</div></div>`;
}

/**
 * @param {string} modeId
 * @param {'core'|'advanced'|'override'} tierKey
 * @param {any[]} [rows]
 */
function renderModeTier(modeId, tierKey, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const metaMap = /** @type {Record<string, { label: string, labelEn?: string }>} */ (APPEARANCE_TIER_META);
  const meta = metaMap[tierKey] || { label: tierKey, labelEn: tierKey };
  const en = isEnLang();
  const titleText = en ? (meta.labelEn || meta.label) : meta.label;
  const rowsHtml = rows.map(renderRow).join('');

  if (tierKey === 'core') {
    return `<div class="settings-group ws-tier ws-tier--core"><div class="settings-group-title">${esc(titleText)}</div>${rowsHtml}</div>`;
  }
  if (tierKey === 'advanced') {
    return `<details class="settings-group ws-tier ws-tier--advanced"><summary class="ws-tier-summary settings-group-title"><span>${esc(titleText)}</span><span class="ws-tier-count">${rows.length} 项</span></summary><div class="ws-tier-body">${rowsHtml}</div></details>`;
  }
  if (tierKey === 'override') {
    return `<details class="settings-group ws-tier ws-tier--override" data-ws-override-mode="${esc(modeId)}"><summary class="ws-tier-summary settings-group-title"><span>${esc(titleText)}</span><span class="ws-override-badge" data-ws-override-badge="${esc(modeId)}">跟随全局</span></summary><div class="ws-tier-body"><div class="ws-override-bar"><span class="ws-override-note">未改动的项自动跟随「背景」与「字体」全局默认</span><button type="button" class="setting-btn ws-override-reset-btn" data-ws-reset-override="${esc(modeId)}">恢复跟随全局</button></div>${rowsHtml}</div></details>`;
  }
  return '';
}

/** @param {string} initialMode */
function renderWorkshopHeader(initialMode) {
  const en = isEnLang();
  const famMap = getFamilyMap();
  const curMeta = APPEARANCE_MODE_MAP[initialMode] || APPEARANCE_MODES[0];
  const curFam = curMeta ? famMap[curMeta.family] : APPEARANCE_FAMILIES[0];
  const curFamLabel = curFam ? (en ? (curFam.labelEn || curFam.label) : curFam.label) : '';
  const curModeLabel = curMeta ? (en ? (curMeta.labelEn || curMeta.label) : curMeta.label) : initialMode;

  const familiesHtml = APPEARANCE_FAMILIES.map((fam) => {
    const famTitle = en ? (fam.labelEn || fam.label) : fam.label;
    const cardsHtml = fam.modes.map((mId) => {
      const m = /** @type {any} */ (APPEARANCE_MODE_MAP[mId]) || { id: mId, label: mId, desc: '' };
      const actCls = mId === initialMode ? ' active' : '';
      const mLabel = en ? (m.labelEn || m.label) : m.label;
      const mDesc = en ? (m.descEn || m.desc || '') : (m.desc || '');
      return `<button type="button" class="appearance-mode-btn ws-mode-card${actCls}" data-mode="${esc(mId)}" title="${esc(mDesc)}"><span class="ws-card-title">${esc(mLabel)}</span><span class="ws-card-desc">${esc(mDesc)}</span></button>`;
    }).join('');
    return `<div class="ws-family-group" data-family="${esc(fam.id)}"><div class="ws-family-header">${esc(famTitle)}</div><div class="ws-family-grid">${cardsHtml}</div></div>`;
  }).join('');

  return `<div class="ws-header">
    <div class="ws-mode-bar">
      <div class="ws-mode-stepper">
        <button type="button" class="ws-mode-nav-btn" data-ws-step="-1" title="上一个视觉模式" aria-label="上一个视觉模式">‹</button>
        <button type="button" class="ws-mode-trigger" id="wsModeTrigger" aria-expanded="false" aria-controls="wsModePopover">
          <span class="ws-mode-family-tag" id="wsModeFamilyTag">${esc(curFamLabel)}</span>
          <span class="ws-mode-name" id="wsModeName">${esc(curModeLabel)}</span>
          <span class="ws-mode-count">全部 14 种模式 ▾</span>
        </button>
        <button type="button" class="ws-mode-nav-btn" data-ws-step="1" title="下一个视觉模式" aria-label="下一个视觉模式">›</button>
      </div>
      <div class="vr-settings-slot" id="vrSettingsSlot"></div>
    </div>
    <div class="ws-mode-popover" id="wsModePopover" hidden>
      ${familiesHtml}
    </div>
  </div>`;
}

/** @param {string} initialMode */
function renderAppearanceSectionHtml(initialMode) {
  const secMap = /** @type {Record<string, any>} */ (APPEARANCE_SECTIONS);
  const modeSectionsHtml = APPEARANCE_MODES.map((m) => {
    const sec = secMap[m.id] || {};
    const activeCls = m.id === initialMode ? ' active' : '';
    const inner = renderModeTier(m.id, 'core', sec.core)
      + renderModeTier(m.id, 'advanced', sec.advanced)
      + renderModeTier(m.id, 'override', sec.override);
    return `<div class="appearance-section${activeCls}" data-mode-section="${esc(m.id)}">${inner}</div>`;
  }).join('');

  return `<div class="appearance-panel active" id="appearancePanel">
    <div class="appearance-preview">
      <div id="lyricPreviewContainer"></div>
    </div>
    <div class="appearance-controls" id="lyricStyleControls">
      ${renderWorkshopHeader(initialMode)}
      <div class="ws-sections-host" id="wsSectionsHost">
        ${modeSectionsHtml}
      </div>
      <div class="settings-group ws-global-theme-group">
        <div class="settings-group-title">全局主题色</div>
        <div class="setting-row">
          <div>
            <div class="setting-label">主题强调色</div>
            <div class="setting-desc">主色调（影响按钮、高亮等）</div>
          </div>
          <div class="setting-control">
            <div class="setting-color-row" id="setAppearanceThemeColor" data-var="themeColor" data-scope="global" data-palette="accent"></div>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

/** 构造所有合法 tab 列表（依 SETTINGS_NAV 唯一事实源） */
export function listSchemaTabs() {
  /** @type {string[]} */
  const tabs = [];
  for (const g of SETTINGS_NAV) {
    for (const it of g.items) tabs.push(it.tab);
  }
  return tabs;
}

/**
 * 判断某个视觉模式的独立覆写字段是否偏离全局默认值
 * @param {string} modeId
 * @returns {boolean}
 */
export function isModeOverridden(modeId) {
  const sec = /** @type {Record<string, any>} */ (APPEARANCE_SECTIONS)[modeId];
  if (!sec || !Array.isArray(sec.override) || sec.override.length === 0) return false;
  const g = /** @type {any} */ (globalThis);
  const s = g.appSettings;
  if (!s || !s.modeSettings) return false;
  const ms = s.modeSettings[modeId] || {};
  const bg = s.background || {};

  for (const row of sec.override) {
    for (const c of (row.controls || [])) {
      const v = c.var;
      if (!v) continue;
      if (v === 'fontFamily') {
        if (ms.fontFamily && ms.fontFamily !== 'default' && ms.fontFamily !== 'inherit') return true;
      } else if (v === 'bgBlur') {
        if (ms.bgBlur !== undefined && Number(ms.bgBlur) !== Number(bg.blur ?? 60)) return true;
      } else if (v === 'bgBrightness') {
        if (ms.bgBrightness !== undefined && Math.abs(Number(ms.bgBrightness) - Number(bg.brightness ?? 0.35)) > 0.005) return true;
      } else if (v === 'swayEnabled') {
        if (ms.swayEnabled !== undefined && Boolean(ms.swayEnabled) !== Boolean(bg.swayEnabled ?? true)) return true;
      } else if (v === 'swayAmp') {
        if (ms.swayAmp !== undefined && Number(ms.swayAmp) !== Number(bg.swayAmp ?? 12)) return true;
      } else if (v === 'swayDuration') {
        if (ms.swayDuration !== undefined && Number(ms.swayDuration) !== Number(bg.swayDuration ?? 16)) return true;
      }
    }
  }
  return false;
}

/**
 * 同步某模式（或当前激活模式）的「跟随全局 / 已覆写」状态徽章
 * @param {string} [modeId]
 */
export function syncModeOverrideBadges(modeId) {
  if (typeof document === 'undefined') return;
  const controls = document.getElementById('lyricStyleControls');
  if (!controls) return;
  const target = modeId
    ? [modeId]
    : Array.from(controls.querySelectorAll('[data-ws-override-mode]')).map((el) => el.getAttribute('data-ws-override-mode') || '').filter(Boolean);

  for (const m of target) {
    const overridden = isModeOverridden(m);
    const badge = controls.querySelector(`[data-ws-override-badge="${CSS.escape(m)}"]`);
    if (badge) {
      badge.textContent = tx(overridden ? '已覆写' : '跟随全局');
      badge.classList.toggle('is-overridden', overridden);
    }
    const resetBtn = /** @type {HTMLButtonElement|null} */ (
      controls.querySelector(`[data-ws-reset-override="${CSS.escape(m)}"]`)
    );
    if (resetBtn) {
      resetBtn.disabled = !overridden;
    }
  }
}

/**
 * 同步工坊顶部模式胶囊与家族徽标，并关掉弹出窗
 * @param {string} modeId
 */
export function syncWorkshopHeader(modeId) {
  if (typeof document === 'undefined') return;
  const controls = document.getElementById('lyricStyleControls');
  if (!controls) return;
  const en = isEnLang();
  const famMap = getFamilyMap();
  const meta = APPEARANCE_MODE_MAP[modeId] || APPEARANCE_MODES[0];
  const fam = meta ? famMap[meta.family] : null;
  const famTag = controls.querySelector('#wsModeFamilyTag');
  const nameEl = controls.querySelector('#wsModeName');
  if (famTag) famTag.textContent = fam ? (en ? (fam.labelEn || fam.label) : fam.label) : '';
  if (nameEl) nameEl.textContent = meta ? (en ? (meta.labelEn || meta.label) : meta.label) : modeId;

  controls.querySelectorAll('.appearance-mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-mode') === modeId);
  });
  syncModeOverrideBadges(modeId);
}

/**
 * 挂载视觉工坊顶栏交互（单行前/后切、浮层开合、Esc / 外点关闭）
 * @param {HTMLElement} controlsEl #lyricStyleControls
 * @param {(modeId: string) => void} onSelectMode
 */
export function bindWorkshopCapsule(controlsEl, onSelectMode) {
  if (!controlsEl || controlsEl.dataset.wsBound === '1') return;
  controlsEl.dataset.wsBound = '1';

  const trigger = controlsEl.querySelector('#wsModeTrigger');
  const popover = controlsEl.querySelector('#wsModePopover');
  const closePopover = () => {
    if (!popover) return;
    popover.setAttribute('hidden', '');
    trigger?.setAttribute('aria-expanded', 'false');
  };
  const togglePopover = () => {
    if (!popover) return;
    const isHidden = popover.hasAttribute('hidden');
    if (isHidden) {
      popover.removeAttribute('hidden');
      trigger?.setAttribute('aria-expanded', 'true');
    } else {
      closePopover();
    }
  };

  trigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePopover();
  });

  controlsEl.querySelectorAll('[data-ws-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const step = Number(btn.getAttribute('data-ws-step')) || 1;
      const firstMode = APPEARANCE_MODES[0]?.id || 'cover';
      const activeBtn = controlsEl.querySelector('.appearance-mode-btn.active');
      const curMode = activeBtn?.getAttribute('data-mode') || firstMode;
      const ids = APPEARANCE_MODES.map((m) => m.id);
      const idx = Math.max(0, ids.indexOf(curMode));
      const nextMode = ids[(idx + step + ids.length) % ids.length] || firstMode;
      closePopover();
      onSelectMode(nextMode);
    });
  });

  controlsEl.querySelectorAll('.appearance-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      closePopover();
    });
  });

  document.addEventListener('click', (e) => {
    if (!popover || popover.hasAttribute('hidden')) return;
    if (trigger?.contains(/** @type {Node} */ (e.target))) return;
    if (popover.contains(/** @type {Node} */ (e.target))) return;
    closePopover();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popover && !popover.hasAttribute('hidden')) {
      closePopover();
    }
  });
}

/**
 * @param {string} tab
 * @param {HTMLElement} secEl
 */
function mountRegisteredGroups(tab, secEl) {
  const groups = getGroupsForTab(tab);
  for (const g of groups) {
    const key = `group:${tab}:${g.id}`;
    if (!secEl.querySelector(`[data-registry-group="${CSS.escape(g.id)}"]`) && typeof g.render === 'function') {
      const target = (tab === 'appearance' && g.id === 'vfx-recipe')
        ? (secEl.querySelector('#vrSettingsSlot') || secEl)
        : secEl;
      const wrapper = document.createElement('div');
      wrapper.dataset.registryGroup = g.id;
      if (target === secEl) wrapper.className = 'settings-registry-slot';
      target.appendChild(wrapper);
      try {
        const ret = g.render(wrapper, secEl);
        if (typeof ret === 'string') wrapper.innerHTML = ret;
        if (wrapper.childElementCount === 0 && !wrapper.textContent) {
          wrapper.remove();
        }
      } catch (e) {
        wrapper.remove();
        logCatch(TAG, e);
      }
    }
    if (!_mountedKeys.has(key)) {
      _mountedKeys.add(key);
      if (typeof g.onMount === 'function') {
        try {
          g.onMount(secEl);
        } catch (e) {
          logCatch(TAG, e);
        }
      }
    }
  }
}

/**
 * @param {string} tab
 * @param {HTMLElement} secEl
 */
function runMountHooks(tab, secEl) {
  const hooks = getHooksForTab(tab);
  for (const h of hooks) {
    const key = `hook:${tab}:${h.id}`;
    if (_mountedKeys.has(key)) continue;
    _mountedKeys.add(key);
    if (typeof h.onMount === 'function') {
      try {
        h.onMount(secEl);
      } catch (e) {
        logCatch(TAG, e);
      }
    }
  }
}

/**
 * 保证指定页签的扩展组与生命周期钩子已挂载（幂等）
 * @param {string} tabName
 */
export function ensureTabMounted(tabName) {
  if (typeof document === 'undefined') return;
  const secEl = document.querySelector(`.settings-section[data-section="${CSS.escape(tabName)}"]`);
  if (!secEl) return;
  mountRegisteredGroups(tabName, /** @type {HTMLElement} */ (secEl));
  runMountHooks(tabName, /** @type {HTMLElement} */ (secEl));
}

/**
 * 通知当前激活页签的 onShow 钩子
 * @param {string} tabName
 */
export function notifyTabShow(tabName) {
  if (typeof document === 'undefined') return;
  ensureTabMounted(tabName);
  const secEl = /** @type {HTMLElement|null} */ (
    document.querySelector(`.settings-section[data-section="${CSS.escape(tabName)}"]`)
  );
  if (!secEl) return;
  for (const g of getGroupsForTab(tabName)) {
    if (typeof g.onShow === 'function') {
      try { g.onShow(secEl); } catch (e) { logCatch(TAG, e); }
    }
  }
  for (const h of getHooksForTab(tabName)) {
    if (typeof h.onShow === 'function') {
      try { h.onShow(secEl); } catch (e) { logCatch(TAG, e); }
    }
  }
  if (tabName === 'appearance') {
    const controls = document.getElementById('lyricStyleControls');
    if (controls) controls.scrollTop = 0;
    syncModeOverrideBadges();
  }
}

/**
 * 根据 SETTINGS_NAV + Schema + settingsRegistry 同步渲染全量 #settingsBody
 * @param {HTMLElement} bodyEl #settingsBody
 * @param {{ initialTab?: string, initialMode?: string }} [options]
 */
export function renderSettingsBody(bodyEl, options = {}) {
  if (!bodyEl) return;
  const initialTab = options.initialTab || 'appearance';
  const initialMode = options.initialMode || 'cover';
  const tabs = listSchemaTabs();
  _mountedKeys.clear();

  const html = tabs.map((tab) => {
    const activeCls = tab === initialTab ? ' active' : '';
    let contentHtml = '';
    if (tab === 'appearance') {
      contentHtml = renderAppearanceSectionHtml(initialMode);
    } else {
      const schemaMap = /** @type {Record<string, Array<{ id: string, title?: string, html?: string }>>} */ (SETTINGS_SECTIONS_SCHEMA);
      const groups = schemaMap[tab] || [];
      contentHtml = groups.map((g) => g.html || '').join('');
    }
    return `<div class="settings-section${activeCls}" data-section="${esc(tab)}">${contentHtml}</div>`;
  }).join('');

  bodyEl.innerHTML = html;

  for (const tab of tabs) {
    ensureTabMounted(tab);
  }
}

export function resetSettingsRendererCacheForTest() {
  _mountedKeys.clear();
}
