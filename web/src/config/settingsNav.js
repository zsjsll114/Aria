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

    /* 搜索时锚点让位：过滤结果与锚点是两套高亮，同时在侧栏会互相打架 */
    container.querySelectorAll('.settings-nav-anchors').forEach(r => { r.style.display = q ? 'none' : ''; });

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

/* ============================================================
 * 阶段 2 收尾：节内锚点（2026-10-07）
 *
 * 长区块（外观页共 22 组、「字面 · Jizura」单块 4 组 20 行）在侧栏给出二级锚点：
 * 挂在当前激活节下面，点击滚到该组并闪烁，滚动时跟随高亮。
 *
 * ★ 锚点从 DOM 派生（组标题 → 锚点），刻意**不**写进 SETTINGS_NAV：
 *   组标题已在 HTML 里且是 i18n 的既有键，再抄一份到 nav 表必然漂移 ——
 *   本仓库已被"两份清单不同步"咬过（vfxRecipe 的 schema 漏收 defaults 键）。
 *   派生 = 新增一个组就自动有锚点，文案随语言切换自动正确。
 *
 * @returns {number} 生成的锚点数；0 表示该节不足两组（不值得出锚点）
 * ============================================================ */
export function refreshSectionAnchors() {
  if (typeof document === 'undefined') return 0;
  const navEl = document.getElementById('settingsTabs');
  const bodyEl = document.getElementById('settingsBody');
  if (!navEl || !bodyEl) return 0;
  navEl.querySelectorAll('.settings-nav-anchors').forEach((r) => r.remove());
  const sec = bodyEl.querySelector('.settings-section.active');
  if (!sec) return 0;
  /* 外观页是二级分栏（模式按钮 + [data-mode-section]）：锚点取**当前可见**的模式区块，
     而不是整节 22 组 —— 否则侧栏会被别的模式的组标题灌满。 */
  const scope = sec.querySelector('[data-mode-section].active') || sec;
  const groups = [...scope.querySelectorAll('.settings-group')]
    .map((g) => ({ group: g, title: g.querySelector('.settings-group-title') }))
    .filter((x) => x.title && x.title.textContent.trim());
  if (groups.length < 2) return 0;
  const activeBtn = navEl.querySelector('.settings-tab.active');
  if (!activeBtn) return 0;

  const row = document.createElement('div');
  row.className = 'settings-nav-anchors';
  groups.forEach((x, i) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'settings-nav-anchor' + (i === 0 ? ' active' : '');
    chip.textContent = x.title.textContent.trim();
    chip.__anchorTarget = x.group;   /* 滚动跟随时要用（见下方 scroll 监听） */
    chip.addEventListener('click', () => {
      /* ★ 用 scrollIntoView 而不是"自己算 scrollTop"（初版就是栽在这）：
         设置页**不是单一滚动容器** —— 外观页是 flex 分栏、块内由 .appearance-controls
         自己滚，其余节才是 #settingsBody 滚。手算就得先猜对容器，猜错就"点了没反应"。
         现有深搜跳转（200）用的也是 scrollIntoView，这里保持一致。
         缝隙由 CSS 的 scroll-margin-top 给，不需要 JS 加偏移。 */
      x.group.scrollIntoView({ behavior: 'smooth', block: 'start' });
      x.group.classList.add('settings-flash');
      setTimeout(() => x.group.classList.remove('settings-flash'), 1600);
      row.querySelectorAll('.settings-nav-anchor').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      /* 点击是明确意图：短暂锁住滚动跟随，别让随后的 scroll 事件把高亮抢回上一组
         （最后一组永远跨不过判定线，实测点了"背景与字体"会立刻被标回"日文字体包"） */
      try { scroller.__anchorClickLock = Date.now() + 900; } catch (e) { /* scroller 见下方，闭包内可达 */ }
    });
    row.appendChild(chip);
  });
  activeBtn.after(row);

  /* 滚动跟随：绑在**真正的滚动容器**上（见上一条注释：外观页不是 #settingsBody 在滚）。
     每个容器只挂一次（标记挂在元素上，不随刷新堆积）。 */
  const scroller = (() => {
    let e = scope.parentElement;
    while (e && e !== document.body) {
      const ov = getComputedStyle(e).overflowY;
      if ((ov === 'auto' || ov === 'scroll') && e.scrollHeight > e.clientHeight) return e;
      e = e.parentElement;
    }
    return bodyEl;
  })();
  if (!scroller.__anchorSpyBound) {
    scroller.__anchorSpyBound = true;
    let pend = false;
    scroller.addEventListener('scroll', () => {
      if (pend) return;
      pend = true;
      requestAnimationFrame(() => {
        pend = false;
        const r = navEl.querySelector('.settings-nav-anchors');
        if (!r) return;
        const chips = [...r.querySelectorAll('.settings-nav-anchor')];
        if (!chips.length) return;
        if (scroller.__anchorClickLock && Date.now() < scroller.__anchorClickLock) return;
        /* 判定线取滚动容器顶部稍下：谁跨过这条线，谁就是"当前所在组" */
        const line = scroller.getBoundingClientRect().top + 16;
        let cur = 0;
        chips.forEach((c, i) => {
          if (c.__anchorTarget && c.__anchorTarget.getBoundingClientRect().top <= line) cur = i;
        });
        /* ★ 触底特例：滚到底后最后一组仍跨不过判定线（容器已无内容可滚），
           不特判就会把"当前组"永久停在倒数第二组。 */
        if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) cur = chips.length - 1;
        chips.forEach((c, i) => c.classList.toggle('active', i === cur));
      });
    }, { passive: true });
  }
  return groups.length;
}
