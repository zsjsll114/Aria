/* ============================================================
 * 292-toolbar.js — 可自定义界面控件（右上角工具栏）
 *
 * 需求：设置里能增删/排序右上角按钮；**被移除的按钮不许真的消失**，
 * 全部收进既有的「更多」菜单，点菜单条目 = 点那颗按钮本身。
 *
 * 三条硬规矩（都是这个功能容易做错就静默坏掉的地方）：
 *  1. 只 reorder 不重建。所有按钮都是**别的分片**绑好监听器的现有节点，
 *     一律 insertBefore 挪位置；cloneNode / 重写 innerHTML 会把监听器丢掉
 *     ——没有报错，只是按钮按下去没反应。（克隆图标画进菜单条目是另一回事，
 *     那颗按钮本体永远留在工具条里，见 buildOverflowNode。）
 *  2. 隐藏的写法是 class + display:none，按钮**留在原父节点**。
 *     为什么不用「搬去另一个容器」：搬走的按钮仍在 Tab 序列里（键盘导航
 *     110 的簇选择器就是 .top-action-buttons），藏起来的按钮不该被选中；
 *     display:none 同时把它移出焦点序列和布局，且 insertBefore 的
 *     「目标位置已正确就不写」判定仍然成立。
 *  3. 幂等 apply：分片用 MutationObserver 盯着工具条（283/285/288 会在
 *     boot 之后挂按钮进来），所以 apply 自己触发的写入必须能在下一轮
 *     判定为「已经是对的」，否则观察器↔apply 自激。位置比较逐格做，
 *     完全一致时零 DOM 写入。刻意不用定时器轮询。
 *
 * 「更多」菜单有两面，**必须都挂**（2026-09-26 实测，AGENTS 约束 14/21）：
 *   · #moreBtn（播控列那颗）→ 80 分片的 showCtxMenu 动态菜单：cover 模式下
 *     唯一够得着的一面（此时 .bottom-control-bar 整条 display:none）。
 *   · #bottomMoreBtn → index.html 里那串静态 .more-item：歌词/PV/隧道等
 *     模式下 .player-controls-wrapper 整列隐藏，#moreBtn 够不着，只剩这面。
 * 两面各按自己的形状生成条目，数据源同一个 overflowControls()，
 * 不复制第二份清单。菜单条目里的按钮如果此刻不在 DOM 上，这条**不显示**
 * （显示一条点了没反应的死项比少一项更糟）。
 *
 * 状态：appSettings.interface.toolbar（AGENTS 约束 11——刻意不新增顶层键，
 * 180 的 loadSettings() 按固定键白名单重建 appSettings，只有 interface /
 * shortcuts 全量展开）。纯逻辑（registry / 净化 / 排序）在 core/toolbarLayout.js，
 * 由 tests/js/test_toolbar.js 覆盖。
 *
 * TODO（底栏，需求里明确低优先）：registry 已经带 bar 字段、apply/sanitize
 *   全是按 bar 参数化的，加底栏只差两件事：① 往 TOOLBAR_CONTROLS 里添
 *   { bar: 'bottom' } 的行并把 BARS 补上 '#bottomControlBar .bottom-controls-row'；
 *   ② 想清楚底栏自身的隐藏项该落在哪——cover 模式下整条底栏不可见，
 *   把按钮藏进「底栏的更多菜单」等于在默认模式下彻底没有入口，
 *   需要一条跨条目的兜底（例如底栏隐藏项一律并进 #ctxMenu 那面）。
 *   没做完不是因为接口不通，是这个兜底策略要先定。
 * ============================================================ */
import { esc } from '../utils/formatters.js';
import { logCatch, logWarn } from '../services/log.js';
import { state } from '../infrastructure/state.js';
import { saveSettings } from './180-boot-config.js';
import { hideCtxMenu } from './80-context-menu.js';
import { translatePhrase } from '../core/i18n.js';
import {
    TOOLBAR_BARS, TOOLBAR_PREF_KEY, controlsOfBar, buildPref, defaultLayout,
    isRemovable, layoutEqual, moveId, normalizePref, resolveChildIds,
    sanitizeLayout, setHidden,
} from '../core/toolbarLayout.js';

const TAG = 'toolbar';
const GROUP_ID = 'toolbarSettingsGroup';
const LIST_ID = 'toolbarCtlRows';
const HIDDEN_CLASS = 'tb-ctl-hidden';
const ITEM_CLASS = 'tb-overflow-item';
/* 选中态的勾：内联 SVG（和 283/285 自己的 ICON 常量同一写法）。
   ★ 不要用 ✓ 这类 unicode 字符当图标：字体里没有就掉成豆腐块，且它跟着
     text 排版走、没法与图标线宽对齐，颜色也只能靠 color 猜。 */
const CHECK_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" '
    + 'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M20 6 9 17l-5-5"></path></svg>';
const SUBMENU_FLAG = 'has-toolbar-items';
/* 工具条宿主：key 必须与 core/toolbarLayout.js 的 bar 名一致 */
const BARS = { top: '.top-action-buttons' };

function doc() { return typeof document !== 'undefined' ? document : null; }
function q(sel) { const d = doc(); return d && d.querySelector ? d.querySelector(sel) : null; }
function byId(id) { const d = doc(); return d && d.getElementById ? d.getElementById(id) : null; }
function tx(zh) {
    try {
        return translatePhrase(zh);
    } catch (e) { logCatch(TAG, e); return zh; }
}

function settings() {
    try {
        return state.appSettings || (typeof globalThis !== 'undefined' && globalThis.appSettings) || null;
    } catch (e) { logCatch(TAG, e); return null; }
}

/* ==================== 偏好读写 ==================== */

function readBars() {
    try {
        const s = settings();
        return normalizePref(s && s.interface && s.interface[TOOLBAR_PREF_KEY]).bars;
    } catch (e) {
        logCatch(TAG, e);
        const bars = {};
        TOOLBAR_BARS.forEach(b => { bars[b] = defaultLayout(b); });
        return bars;
    }
}

function writeBars(bars) {
    const s = settings();
    if (!s || !s.interface) return false;
    const pref = buildPref(bars);
    if (pref) s.interface[TOOLBAR_PREF_KEY] = pref;
    else delete s.interface[TOOLBAR_PREF_KEY];
    try {
        saveSettings();
    } catch (e) { logCatch(TAG, e); }
    return true;
}

function layoutFor(bar) {
    return readBars()[bar] || defaultLayout(bar);
}

/* ==================== 工具条与按钮 ==================== */

function hostOf(bar) {
    const sel = BARS[bar];
    return sel ? q(sel) : null;
}

/** 当前真正在这条工具条里的子元素，键 = id（没有 id 的用哨兵键，只在本次 apply 内有意义）。
 *  ★ 必须按「是不是这个工具条的孩子」取，不能 getElementById：285 的双语按钮优先落底栏，
 *    getElementById 会把它从底栏拽到顶栏来。 */
function childrenOf(bar) {
    const host = hostOf(bar);
    const map = new Map();
    if (!host) return { host: null, map };
    Array.prototype.forEach.call(host.children, (el, i) => {
        map.set(el.id || '@' + i, el);
    });
    return { host, map };
}

/** 菜单/设置行里显示的名字：★ 必须取 aria-label，不要退回 data-tooltip。
 *  这两个字段在本仓有明确分工——data-tooltip 是「给人看的长说明」（会带
 *  「（跟播其它播放器）」「· 已开启（点击关闭）」这类从句），aria-label 是控件的短名。
 *  菜单条目按 tooltip 取名就会撑出一整行（2026-09-26 用户圈出的就是这条）。
 *  开关类按钮的「开没开」由 isOnOf() 画成选中态，不靠文案，所以短名不丢信息；
 *  长说明改成悬停时显示（见 buildOverflowNode 里那份 data-tooltip）。 */
function labelOf(el) {
    if (!el) return '';
    const short = (el.getAttribute('aria-label') || '').trim();
    if (short) return short;
    const tip = (el.getAttribute('data-tooltip') || el.getAttribute('title') || '').trim();
    return tip || el.id;
}

/** 这颗按钮此刻是不是「开着」。全仓没有统一的开关类，四颗各用一个（别再新增第五个）：
 *  npQuickToggle / sleepTimerBtn / readabilityBtn → `.on`（base.css:701 那颗高亮态）
 *  bilingualCycleBtn → `.is-active`（非默认排版）
 *  desktopLyricsBtn  → `.active-dl`
 *  readabilityBtn 另带 aria-pressed，作为程序化读法的第二判据。 */
function isOnOf(el) {
    if (!el || !el.classList) return false;
    return el.classList.contains('on') || el.classList.contains('is-active')
        || el.classList.contains('active-dl') || el.getAttribute('aria-pressed') === 'true';
}

/** 该出现的溢出条目：登记过 + 此刻在这条工具条里 + 已被隐藏。
 *  未登记的节点完全不在 registry 里 → 永远不会被隐藏 → 不会进这里。 */
function overflowControls(bar) {
    const { map } = childrenOf(bar);
    const layout = sanitizeLayout(bar, layoutFor(bar));
    const out = [];
    for (const id of layout.order) {
        if (!layout.hidden.includes(id)) continue;
        const el = map.get(id);
        if (!el) continue;
        out.push({ id, el, label: labelOf(el) });
    }
    return out;
}

/* ==================== 落地（apply） ==================== */

let _applying = false;

function applyBar(bar) {
    const { host, map } = childrenOf(bar);
    if (!host) return;                       /* lyrics.html / remote.html：整块缺席就静默不做 */
    const layout = sanitizeLayout(bar, layoutFor(bar));
    const wanted = resolveChildIds(bar, layout, Array.from(map.keys())).map(k => map.get(k));

    /* 逐格比对：已经在位的一律不写，DOM 已符合期望时整趟零 mutation，
       观察器不会被自己的写入唤醒（约束 3 的幂等前提） */
    for (let i = 0; i < wanted.length; i++) {
        const el = wanted[i];
        if (!el || host.children[i] === el) continue;
        host.insertBefore(el, host.children[i] || null);
    }
    for (const [key, el] of map) {
        if (key.charAt(0) === '@') continue;             /* 哨兵键 = 未登记节点，不代理显隐 */
        if (!controlsOfBar(bar).some(c => c.id === key)) continue;
        el.classList.toggle(HIDDEN_CLASS, layout.hidden.includes(key));
    }
}

function applyAll() {
    if (_applying) return;
    _applying = true;
    try {
        TOOLBAR_BARS.forEach(bar => {
            try {
                applyBar(bar);
            } catch (e) { logCatch(TAG, e); }
        });
    } finally {
        _applying = false;
    }
}

/* 菜单条目的点击只有一行：走按钮自己的处理函数。
   realBtn.click() 而不是复制一份逻辑——两条代码路径迟早分叉。 */
function onOverflowActivate(el) {
    if (!el || typeof el.click !== 'function') return;
    try {
        el.click();
    } catch (e) { logCatch(TAG, e); }
}

function buildOverflowNode(cls, ctrl) {
    const d = doc();
    const node = d.createElement('div');
    const label = ctrl.label || ctrl.id;
    const on = isOnOf(ctrl.el);
    node.className = cls + ' ' + ITEM_CLASS + (on ? ' is-on' : '');
    node.dataset.toolbarId = ctrl.id;
    node.dataset.on = on ? '1' : '0';
    const svg = ctrl.el.querySelector('svg');
    if (svg) {
        /* 只克隆**图标**给菜单用；按钮本体一个字节都没被复制/搬走 */
        const icon = svg.cloneNode(true);
        icon.removeAttribute('id');
        icon.querySelectorAll?.('[id]').forEach(n => n.removeAttribute('id'));
        node.appendChild(icon);
    }
    const span = d.createElement('span');
    span.className = 'tb-overflow-label';
    span.textContent = label;
    node.appendChild(span);
    if (on) {
        const check = d.createElement('span');
        check.className = 'tb-overflow-check';
        check.innerHTML = CHECK_ICON;      /* 常量字符串，不含外部数据 */
        node.appendChild(check);
    }
    /* 条目名字被压短了，原来那句长说明改挂到悬停提示上，信息一条不丢 */
    const tip = (ctrl.el.getAttribute('data-tooltip') || '').trim();
    if (tip && tip !== label) node.setAttribute('data-tooltip', tip);
    node.addEventListener('click', (e) => {
        e.stopPropagation();
        onOverflowNodeClick(node, ctrl.id);
    });
    return node;
}

function onOverflowNodeClick(node, id) {
    const submenu = node.closest ? node.closest('.more-submenu') : null;
    if (submenu) submenu.classList.remove('open');
    else hideCtxMenu();
    /* 按 bar 找那颗按钮（底栏接进来时这里不用改） */
    let el = null;
    for (const bar of TOOLBAR_BARS) {
        el = childrenOf(bar).map.get(id);
        if (el) break;
    }
    onOverflowActivate(el);
}

/* ---------- 面一：底栏静态 .more-submenu（歌词/PV/隧道模式下唯一够得着的「更多」） ---------- */

function syncStaticSubmenu() {
    const d = doc();
    const sub = byId('moreSubmenu');
    if (!d || !sub) return;
    try {
        sub.querySelectorAll(':scope > .' + ITEM_CLASS).forEach(n => n.remove());
        const items = TOOLBAR_BARS.reduce((acc, bar) => acc.concat(overflowControls(bar)), []);
        if (!items.length) {
            sub.classList.remove(SUBMENU_FLAG);
            return;
        }
        items.forEach((ctrl, i) => {
            const node = buildOverflowNode('more-item', ctrl);
            /* 第一条画一条分隔线：CSS 里没法用 :first-of-type 判（菜单里全是 div） */
            if (i === 0) node.classList.add('tb-overflow-first');
            sub.appendChild(node);
        });
        /* 条目是我加上去的，向上弹出的菜单可能顶出屏幕：给它一个可滚的上限 */
        sub.classList.add(SUBMENU_FLAG);
    } catch (e) { logCatch(TAG, e); }
}

/* ---------- 面二：#moreBtn → showCtxMenu 那张动态菜单（cover 模式下唯一入口） ---------- */

function syncCtxMenuOverflow() {
    const d = doc();
    const menu = byId('ctxMenu');
    if (!d || !menu || !menu.classList.contains('visible')) return;
    try {
        /* 幂等：showCtxMenu 每次 open 都会 innerHTML 重建（我这批节点随之消失），
           但同一个开着的菜单被再同步一次（例如语言切换）不该出现重复条目 */
        menu.querySelectorAll('.' + ITEM_CLASS).forEach(n => n.remove());
        const items = TOOLBAR_BARS.reduce((acc, bar) => acc.concat(overflowControls(bar)), []);
        if (!items.length) return;
        const sep = d.createElement('div');
        sep.className = 'ctx-separator ' + ITEM_CLASS;
        sep.dataset.toolbarId = '@separator';
        menu.appendChild(sep);
        items.forEach(ctrl => menu.appendChild(buildOverflowNode('ctx-item', ctrl)));
        clampCtxMenu(menu);
    } catch (e) { logCatch(TAG, e); }
}

/** 追加完必须重新夹一次位置：80 的夹取发生在 showCtxMenu 里、我追加之前，
 *  多出来的高度不会自己回到视口内（AGENTS 约束 21）。
 *  ★ 尺寸读 offsetWidth/offsetHeight、位置读 style.left/top——元素正跑着
 *    scale(0.95)→1 的进场，getBoundingClientRect() 量到的是缩放中的盒子。 */
function clampCtxMenu(menu) {
    try {
        const winW = window.innerWidth;
        const winH = window.innerHeight;
        const w = menu.offsetWidth;
        const h = menu.offsetHeight;
        let left = parseFloat(menu.style.left) || 0;
        let top = parseFloat(menu.style.top) || 0;
        if (left + w > winW - 8) left = winW - w - 8;
        if (top + h > winH - 8) top = winH - h - 8;
        menu.style.left = Math.max(8, left) + 'px';
        menu.style.top = Math.max(8, top) + 'px';
    } catch (e) { logCatch(TAG, e); }
}

function wireMoreButton() {
    const d = doc();
    const btn = byId('moreBtn');
    if (!d || !btn || btn.dataset.tbCtxWired === '1') return;
    btn.dataset.tbCtxWired = '1';
    /* 90 分片比本分片先注册监听，所以这一跳跑在 openMoreMenu() 之后，
       菜单已经建好并 visible —— 正是追加的时机。菜单每次 open 都重建，
       条目按当时的隐藏集合现算，天然跟着配置走。 */
    btn.addEventListener('click', () => {
        try {
            syncCtxMenuOverflow();
        } catch (e) { logCatch(TAG, e); }
    });
}

/* ==================== 设置页 UI ==================== */

function ensureStyles() {
    /* 样式正常由 index.html 里 link 的 toolbar.css 提供；这一层是「链接被人漏掉」
       时的兜底（本仓库有过 feature CSS 忘了 link、浮层完全裸奔的先例）。
       只兜必须成立的一条：隐藏那颗按钮得真的不占位。 */
    const d = doc();
    if (!d || byId('toolbarStyleGuard')) return;
    const style = d.createElement('style');
    style.id = 'toolbarStyleGuard';
    style.textContent = '.' + HIDDEN_CLASS + '{display:none!important;}';
    d.head.appendChild(style);
}

function rowHTML(ctrl, index, total) {
    const disabled = ctrl.removable ? '' : ' disabled';
    const stateClass = ctrl.hidden ? '' : ' on';
    const stateLabel = ctrl.removable
        ? (ctrl.hidden ? tx('隐藏') : tx('显示'))
        : tx('固定显示');
    return `<div class="setting-row tb-ctl-row${ctrl.hidden ? ' is-hidden' : ''}" data-toolbar-id="${esc(ctrl.id)}">
        <div class="tb-ctl-name">
            <span class="tb-ctl-icon" data-tb-icon></span>
            <div class="setting-label">${esc(ctrl.label)}</div>
        </div>
        <div class="setting-control tb-ctl-actions">
            <button type="button" class="setting-toggle${stateClass}" data-tb-act="toggle" aria-label="${esc(stateLabel)}" title="${esc(stateLabel)}"${disabled}></button>
            <button type="button" class="setting-btn tb-move-btn" data-tb-act="up" aria-label="${esc(tx('上移'))}" title="${esc(tx('上移'))}"${index === 0 ? ' disabled' : ''}>↑</button>
            <button type="button" class="setting-btn tb-move-btn" data-tb-act="down" aria-label="${esc(tx('下移'))}" title="${esc(tx('下移'))}"${index === total - 1 ? ' disabled' : ''}>↓</button>
        </div>
    </div>`;
}

/** 当前顺序里「此刻真在工具条上」的控件；缺席的（别的分片还没挂 / 新版本删了）
 *  直接不列——列一行灰掉的去隐藏一个不存在的按钮没有意义 */
function listedControls(bar) {
    const { map } = childrenOf(bar);
    const layout = sanitizeLayout(bar, layoutFor(bar));
    const out = [];
    layout.order.forEach((id, index) => {
        const el = map.get(id);
        if (!el) return;
        out.push({
            id,
            index,
            el,
            label: labelOf(el),
            hidden: layout.hidden.includes(id),
            removable: isRemovable(bar, id),
        });
    });
    return out;
}

function renderSettings() {
    const list = byId(LIST_ID);
    if (!list) return;
    try {
        const controls = listedControls('top');
        syncGroupHost();
        if (!controls.length) {
            list.innerHTML = `<div class="setting-desc">${esc(tx('当前没有可设置的按钮'))}</div>`;
            return;
        }
        const total = controls.length;
        list.innerHTML = controls.map((c, i) => rowHTML(c, i, total)).join('');
        controls.forEach((c) => {
            const row = list.querySelector(`[data-toolbar-id="${CSS.escape(c.id)}"]`);
            if (!row) return;
            const slot = row.querySelector('[data-tb-icon]');
            const svg = c.el.querySelector('svg');
            if (slot && svg) {
                const icon = svg.cloneNode(true);
                icon.removeAttribute('id');
                icon.querySelectorAll?.('[id]').forEach(n => n.removeAttribute('id'));
                slot.appendChild(icon);
            }
            row.querySelector('[data-tb-act="toggle"]')?.addEventListener('click', () => {
                commit(setHidden(sanitizeLayout('top', layoutFor('top')), c.id, !c.hidden, c.removable));
            });
            row.querySelector('[data-tb-act="up"]')?.addEventListener('click', () => {
                commit(moveId(sanitizeLayout('top', layoutFor('top')), c.id, -1));
            });
            row.querySelector('[data-tb-act="down"]')?.addEventListener('click', () => {
                commit(moveId(sanitizeLayout('top', layoutFor('top')), c.id, 1));
            });
        });
    } catch (e) { logCatch(TAG, e); }
}

/**
 * 宿主自愈：这一组按需求挂在「界面」分区里，但分区本身渲染得出来吗？
 * 2026-09-26 实测过一种真实状态：index.html 视觉模式那一段少了 18 个未闭合的 </div>
 * （已由并阵补上），浏览器解析完 [data-section="interface"] 成了
 * .appearance-section[data-mode-section=…] 的后代，而那个祖先在 cover 模式下
 * display:none —— 切到「界面」页签后 .settings-body.innerText 长度为 0，
 * 连既有的「界面语言」下拉、「主题强调色」都看不见（289 的说明组同样中招）。
 * 那种情形下把这一组挪到 #settingsBody（看得见、点得到），分区能渲染时立刻挪回去。
 * 判据必须带 .active——不看当前页签的话，停在「视觉模式」时也会误挪。
 * 本分片不改 index.html（不是我的文件），这里只保证自己的控件不会静默不可达。
 */
function syncGroupHost() {
    const d = doc();
    if (!d) return;
    const group = byId(GROUP_ID);
    const section = q('[data-section="interface"]');
    const body = byId('settingsBody');
    if (!group || !body) return;
    const active = !!(section && section.classList.contains('active'));
    const sectionRenders = !!(section && section.offsetParent);
    const want = (section && (!active || sectionRenders)) ? section : body;
    if (group.parentElement !== want) {
        try {
            want.appendChild(group);
        } catch (e) { logCatch(TAG, e); }
    }
}

function mountSettingsGroup() {
    const d = doc();
    if (!d || byId(GROUP_ID)) return;
    const host = q('[data-section="interface"]') || q('#settingsBody');
    if (!host) return;
    try {
        const group = d.createElement('div');
        group.className = 'settings-group';
        group.id = GROUP_ID;
        group.innerHTML = `
            <div class="settings-group-title">${esc(tx('界面控件'))}</div>
            <div class="setting-row">
                <div>
                    <div class="setting-label">${esc(tx('自定义工具栏'))}</div>
                    <div class="setting-desc">${esc(tx('调整右上角按钮的顺序，或隐藏不常用的。隐藏的按钮不会消失，会收进「更多」菜单，点它等于点原按钮。'))}</div>
                </div>
                <div class="setting-control">
                    <button type="button" class="setting-btn" id="tbRestoreDefaults">${esc(tx('恢复默认'))}</button>
                </div>
            </div>
            <div id="${LIST_ID}"></div>`;
        host.appendChild(group);
        byId('tbRestoreDefaults')?.addEventListener('click', () => {
            const bars = readBars();
            if (layoutEqual(bars.top, defaultLayout('top'))) return;
            bars.top = defaultLayout('top');
            if (writeBars(bars)) {
                applyAll();
                syncStaticSubmenu();
                renderSettings();
            }
        });
    } catch (e) { logCatch(TAG, e); }
}

/* 改一份布局 → 存盘 → 立即生效（不需要刷新页面） */
function commit(nextLayout) {
    try {
        const bars = readBars();
        bars.top = nextLayout;
        if (!writeBars(bars)) return;
        applyAll();
        syncStaticSubmenu();
        renderSettings();
    } catch (e) { logCatch(TAG, e); }
}

/* ==================== 变更来源（全部事件驱动，没有轮询定时器） ==================== */

/** 别的分片会在 boot 之后往工具条里挂按钮（283/285/288），挂完得重新落一次布局 */
function watchBars() {
    const d = doc();
    if (!d || typeof MutationObserver === 'undefined') return;
    for (const bar of TOOLBAR_BARS) {
        const host = hostOf(bar);
        if (!host || host.dataset.tbObserved === '1') continue;
        host.dataset.tbObserved = '1';
        try {
            new MutationObserver(() => {
                if (_applying) return;         /* 自己那一趟写入不算外来变更 */
                try {
                    applyBar(bar);
                    syncStaticSubmenu();
                } catch (e) { logCatch(TAG, e); }
            }).observe(host, { childList: true });
        } catch (e) { logCatch(TAG, e); }
    }
}

/** bootApp() 里 loadSettings() 排在一次 await 之后（读 /api/config/load），
 *  本分片的 boot 跑在它前面 —— 直接照首屏配置渲染会用错默认值。
 *  loadSettings 之后必然紧跟 applyAllSettings()，它写 documentElement.style
 *  （--theme-color 等），这就是「配置落地了」的信号（283 用的是同一个信号）。
 *  顺带覆盖设置面板重新打开的情形。 */
function watchConfigLanded() {
    const d = doc();
    if (!d) return;
    const onConfig = () => {
        try {
            applyAll();
            syncStaticSubmenu();
            if (byId(GROUP_ID)) renderSettings();
        } catch (e) { logCatch(TAG, e); }
    };
    if (typeof MutationObserver !== 'undefined') {
        try {
            new MutationObserver(onConfig)
                .observe(d.documentElement, { attributes: true, attributeFilter: ['style'] });
        } catch (e) { logCatch(TAG, e); }
    }
    const overlay = byId('settingsOverlay');
    if (overlay && typeof MutationObserver !== 'undefined') {
        try {
            /* 面板里的节内容是按需重建的（200 每次进 interface 都可能重写 DOM），
               所以每次打开都确认说明组还在、并把行重画一遍（同 289/290 的兜法） */
            new MutationObserver(() => {
                if (!overlay.classList.contains('visible')) return;
                mountSettingsGroup();
                applyAll();
                renderSettings();
            }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
        } catch (e) { logCatch(TAG, e); }
    }
    /* 页签切换不改 overlay 的 class，光靠上面那个观察器会在「界面」页签打开后
       错过 syncGroupHost 的判定时机（200 换页签只动 .settings-section.active）。
       mountSettingsGroup 是幂等的：万一 200 把分区内容整段重建了，这里补回来。 */
    if (d.addEventListener) {
        d.addEventListener('click', (e) => {
            if (!e.target || !e.target.closest || !e.target.closest('.settings-tab')) return;
            try {
                mountSettingsGroup();
                renderSettings();
            } catch (err) { logCatch(TAG, err); }
        }, true);
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('load', onConfig);
        /* 按钮的 data-tooltip 会被 i18n 就地翻成英文，菜单条目/设置行的标题得跟着重取 */
        window.addEventListener('aria:languagechange', () => {
            try {
                syncStaticSubmenu();
                if (byId(GROUP_ID)) renderSettings();
            } catch (e) { logCatch(TAG, e); }
        });
    }
}

function boot() {
    try {
        ensureStyles();
        if (!q(BARS.top)) {
            /* 桌面歌词窗口 / 手机远端页没有右上角工具条：整套功能静默缺席，不报错 */
            return;
        }
        mountSettingsGroup();
        applyAll();
        syncStaticSubmenu();
        renderSettings();
        watchBars();
        wireMoreButton();
        watchConfigLanded();
        if (typeof window !== 'undefined' && typeof Aria !== 'undefined') {
            Aria.__toolbar = {
                apply: applyAll,
                layout: () => layoutFor('top'),
                defaults: () => defaultLayout('top'),
                reset: () => commit(defaultLayout('top')),
                hide: id => commit(setHidden(sanitizeLayout('top', layoutFor('top')), id,
                    true, isRemovable('top', id))),
                show: id => commit(setHidden(sanitizeLayout('top', layoutFor('top')), id,
                    false, isRemovable('top', id))),
                controls: () => listedControls('top'),
            };
        }
    } catch (e) {
        logCatch(TAG, e);
        logWarn(TAG, '工具栏自定义未启用');
    }
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
}

export { applyAll, layoutFor, overflowControls, syncStaticSubmenu };
