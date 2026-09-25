/**
 * settingsNav.js — 设置面板声明式导航模型（上游参考项目 settingsNavModel 对齐）
 *
 * 唯一事实源：侧栏由本表生成，点击走 window.switchSettingsTab（唯一收敛的
 * 切换函数，含各节副作用）。阶段 2（卡片化）/阶段 3（搜索）复用同一份数据。
 */

import { esc } from '../utils/formatters.js';

export const SETTINGS_NAV = [
  { group: '外观', groupEn: 'Appearance', items: [
    { tab: 'appearance', label: '视觉模式', labelEn: 'Visual Modes' },
    { tab: 'background', label: '背景', labelEn: 'Background' },
    { tab: 'fonts',      label: '字体', labelEn: 'Fonts' },
  ] },
  { group: '播放', groupEn: 'Playback', items: [
    { tab: 'playback',    label: '播放', labelEn: 'Playback' },
    { tab: 'quality',     label: '音质', labelEn: 'Audio Quality' },
    { tab: 'audio',       label: '音效', labelEn: 'Audio Effects' },
    { tab: 'performance', label: '性能', labelEn: 'Performance' },
  ] },
  { group: '服务', groupEn: 'Services', items: [
    { tab: 'selfhost', label: '自建服务', labelEn: 'Self-Hosted' },
    { tab: 'ai',       label: 'AI 分析', labelEn: 'AI Analysis' },
    { tab: 'data',     label: '数据', labelEn: 'Data' },
  ] },
  { group: '系统', groupEn: 'System', items: [
    { tab: 'interface', label: '界面', labelEn: 'Interface' },
    { tab: 'shortcuts', label: '快捷键', labelEn: 'Shortcuts' },
    { tab: 'about',     label: '关于', labelEn: 'About' },
  ] },
];

/** 当前界面语言（AriaI18n 未加载时默认中文） */
function navLang() {
  try {
    return (typeof globalThis !== 'undefined' && globalThis.AriaI18n) ? globalThis.AriaI18n.getLanguage() : 'zh-CN';
  } catch (e) { return 'zh-CN'; }
}
const navIsEn = () => navLang() === 'en-US';

/**
 * 渲染分组侧栏到容器（保留 #settingsTabs id——switchSettingsTab 等
 * 既有引用全部兼容）。默认高亮第一项（appearance）。
 * ★ 双语直出（2026-09-22）：label/group 带 labelEn/groupEn，渲染时按当前
 *   语言直接输出——「加中文时顺便把翻译写进数据」，不再依赖运行时扫描猜。
 * 顶部搜索框：按节名/组名实时过滤（上游参考项目 命令面板的轻量版）。
 * @param {HTMLElement} container #settingsTabs
 */
export function renderSettingsNav(container) {
  if (!container) return;
  const en = navIsEn();
  container.innerHTML = `
    <input class="settings-nav-search" id="settingsNavSearch" type="text"
           placeholder="${en ? 'Search settings...' : '搜索设置…'}" autocomplete="off" />
    <div class="settings-nav-list">
      ${SETTINGS_NAV.map((g) => `
        <div class="settings-nav-group">
          <div class="settings-nav-group-title">${en ? (g.groupEn || g.group) : g.group}</div>
          ${g.items.map((it, i) => `
            <button class="settings-tab${g === SETTINGS_NAV[0] && i === 0 ? ' active' : ''}" data-tab="${it.tab}" title="${esc(en ? (it.labelEn || it.label) : it.label)}">
              <span>${esc(en ? (it.labelEn || it.label) : it.label)}</span>
            </button>`).join('')}
        </div>`).join('')}
    </div>`;
  /* 过滤 + 小项深搜（用户要求：设置搜索要能搜到节内的具体设置项）：
     输入 ≥2 字符时扫描全部 section 的 setting-label/desc/组标题——
     ★ nav 过滤条件 = 节名/组名匹配 OR 该节深搜命中 > 0（否则深搜命中的节
     会被节名过滤藏掉，用户永远点不到），命中节挂计数徽章，点击跳转后滚到
     首个命中行。 */
  const input = container.querySelector('#settingsNavSearch');
  const groups = container.querySelectorAll('.settings-nav-group');
  input?.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    input.dataset.q = q;
    const deep = q.length >= 2;

    /* 先跑深搜（nav 过滤要用命中数） */
    const secHits = new Map();
    if (typeof document !== 'undefined') {
      document.querySelectorAll('.settings-section').forEach(sec => {
        let n = 0;
        sec.querySelectorAll('.setting-label, .setting-desc, .settings-group-title').forEach(l => {
          const hit = deep && l.textContent.toLowerCase().includes(q);
          l.classList.toggle('settings-hit', hit);
          if (hit) n++;
        });
        if (n > 0) secHits.set(sec.dataset.section, n);
      });
    }

    groups.forEach((gEl, gi) => {
      const g = SETTINGS_NAV[gi];
      if (!g) return;
      let any = false;
      gEl.querySelectorAll('.settings-tab').forEach((bEl, ii) => {
        const it = g.items[ii];
        const nameHit = !q || !it || it.label.toLowerCase().includes(q) || g.group.toLowerCase().includes(q);
        const deepHit = deep && (secHits.get(it.tab) || 0) > 0;
        const hit = nameHit || deepHit;
        bEl.style.display = hit ? '' : 'none';
        if (hit) any = true;
        /* 命中计数徽章 */
        const n = deepHit ? secHits.get(it.tab) : 0;
        let badge = bEl.querySelector('.nav-hit-badge');
        if (n > 0) {
          if (!badge) { badge = document.createElement('span'); badge.className = 'nav-hit-badge'; bEl.appendChild(badge); }
          badge.textContent = String(n);
        } else if (badge) badge.remove();
      });
      const title = gEl.querySelector('.settings-nav-group-title');
      if (title) title.style.display = any ? '' : 'none';
    });
  });
}
