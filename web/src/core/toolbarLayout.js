/* ============================================================
 * core/toolbarLayout.js — 「界面控件」可自定义工具栏的纯逻辑层
 *
 * 为什么单独一个文件（同 290 的 core/vfxRecipe.js）：
 *   这里只做「一串 id ↔ 一份布局」的换算，零 DOM 依赖，所以能被
 *   tests/js/test_toolbar.js 直接 import 测（分片本体拉进 Node 会把
 *   180/80 那一串带 document 的模块全拖起来，测不动）。
 *
 * 数据形状（落在 appSettings.interface.toolbar，AGENTS 约束 11：
 * 刻意不新增顶层键——180 的 loadSettings() 按固定键白名单整体重建
 * appSettings，只有 interface / shortcuts 是全量展开，挂别处会被静默丢弃）：
 *
 *   { version: 1, bars: { top: { order: ['openSearchBtn', …], hidden: ['openStatsBtn'] } } }
 *
 * ★ order 是**全量**顺序（隐藏的按钮也在里面），hidden 是它的子集。
 *   为什么不像直觉那样只存「可见顺序」：隐藏一个按钮时它的邻居会跳位，
 *   再显示出来就回不到原来的槽位了；把「位置」和「在不在」拆成两份数据，
 *   隐藏/显示才是严格可逆的（test_toolbar.js 里那条往返测试钉的就是这个）。
 *   由此「可见集合」永远是 order \ hidden，
 *   所以 `可见 ∩ 隐藏 = ∅` 是构造性成立的，不是靠清理维持的。
 *
 * registry（本文件唯一事实源）只登记**已存在的 DOM 控件 id**，
 * 分片拿 getElementById 取现有节点，绝不重建、绝不 cloneNode——
 * 这些按钮的监听器是别的分片绑的，克隆一次就静默失效（无报错的坏法）。
 *
 * removable：只有「设置」为 false。理由不是审美，是逃生通道——
 *   这个偏好本身要在设置面板里改，把回设置面板的那颗按钮藏掉，
 *   等于允许用户把自己锁在配置外面（「更多」菜单里那条 设置 只在
 *   cover 模式点得到，歌词类模式下底栏那面才有，见分片头注释的实测）。
 * ============================================================ */

export const TOOLBAR_PREF_KEY = 'toolbar';
export const TOOLBAR_PREF_VERSION = 1;

/** 可自定义控件清单。数组下标 = 默认顺序（不再另存一份 order 数字，避免第二个事实源）。
 *  bar 是归属工具条；bottom 目前一件都没有（分片头有 TODO），字段先留着是为了
 *  加底栏时只往数组里添行、不必再动 apply/sanitize 任何一处。
 *
 *  顺序按「boot 完成后的真实 DOM 顺序」写：288 把 lyricSearchBtn 插在
 *  openSearchBtn 右边、283 把 readabilityBtn 插在 openViewModeBtn 左边，
 *  这里跟它们一致，于是默认配置下第一次 apply 是**零次 DOM 写入**
 *  （分片用 MutationObserver 观察工具条，写入会再触发观察，幂等不了就会自激）。
 *  285 的 bilingualCycleBtn 优先落底栏，只有底栏不存在时才 append 到顶栏末尾，
 *  所以它排在最后。 */
export const TOOLBAR_CONTROLS = [
    { id: 'openSearchBtn', bar: 'top', removable: true },
    { id: 'lyricSearchBtn', bar: 'top', removable: true },
    { id: 'openDailyBtn', bar: 'top', removable: true },
    { id: 'openRankingsBtn', bar: 'top', removable: true },
    { id: 'openStatsBtn', bar: 'top', removable: true },
    { id: 'openFavoritesBtn', bar: 'top', removable: true },
    { id: 'openPlaylistsBtn', bar: 'top', removable: true },
    { id: 'npQuickToggle', bar: 'top', removable: true },
    { id: 'desktopLyricsBtn', bar: 'top', removable: true },
    { id: 'sleepTimerBtn', bar: 'top', removable: true },
    { id: 'readabilityBtn', bar: 'top', removable: true },
    { id: 'zenModeBtn', bar: 'top', removable: true },
    { id: 'openViewModeBtn', bar: 'top', removable: true },
    /* ★ 固定显示（见文件头 removable 的理由） */
    { id: 'openSettingsBtn', bar: 'top', removable: false },
    { id: 'bilingualCycleBtn', bar: 'top', removable: true },
];

/** 已登记的 bar 名（顺序稳定，供遍历用） */
export const TOOLBAR_BARS = ['top'];

const CONTROLS_BY_BAR = TOOLBAR_CONTROLS.reduce((acc, c) => {
    (acc[c.bar] || (acc[c.bar] = [])).push(c);
    return acc;
}, {});

export function controlsOfBar(bar) {
    return (CONTROLS_BY_BAR[bar] || []).slice();
}

/** 某条工具栏的默认 id 顺序 */
export function defaultOrder(bar) {
    return controlsOfBar(bar).map(c => c.id);
}

export function isRemovable(bar, id) {
    const c = (CONTROLS_BY_BAR[bar] || []).find(x => x.id === id);
    return !!c && c.removable !== false;
}

export function isRegistered(bar, id) {
    return (CONTROLS_BY_BAR[bar] || []).some(x => x.id === id);
}

export function defaultLayout(bar) {
    return { order: defaultOrder(bar), hidden: [] };
}

function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function idList(v) {
    return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : [];
}

function dedupe(list) {
    const seen = new Set();
    const out = [];
    for (const x of list) {
        if (seen.has(x)) continue;
        seen.add(x);
        out.push(x);
    }
    return out;
}

/**
 * 把任意「用户存的 / 版本升级后剩下的 / 手改的」脏值收敛成一份可用布局。
 * 规则（需求里写死的四条）：未知 id 丢弃、重复 id 丢弃、登记了但当前没有的 id
 * 要能容忍（按默认位置补回来，未来版本新增按钮时老配置不会把它挤到最后）、
 * 整体坏掉（null / 字符串 / 数字 / 数组）一律退回默认，且绝不抛。
 */
export function sanitizeLayout(bar, raw) {
    const known = defaultOrder(bar);
    let order = [];
    let hidden = [];
    if (isPlainObject(raw)) {
        /* 丢掉未知 id 与重复项：未知项可能来自旧版本删掉的按钮 */
        order = dedupe(idList(raw.order).filter(id => known.includes(id)));
        hidden = idList(raw.hidden);
    }
    /* 缺席的登记项按「它在默认序列里的位置」插回去，而不是简单 append 到末尾 */
    for (const id of known) {
        if (order.includes(id)) continue;
        const defIdx = known.indexOf(id);
        const after = order.findIndex(x => known.indexOf(x) > defIdx);
        if (after < 0) order.push(id);
        else order.splice(after, 0, id);
    }
    /* hidden 必须是 order 的子集，而且非 removable 的一律不许藏（构造性保证
       可见 ∩ 隐藏 = ∅：可见集合就是 order 去掉 hidden 剩下的那部分） */
    hidden = dedupe(hidden).filter(id => order.includes(id) && isRemovable(bar, id));
    return { order, hidden };
}

/** 读整份偏好 → { bars: { top: layout, … } }。缺 bar / 多 bar 都不抛。 */
export function normalizePref(raw) {
    const bars = {};
    const src = isPlainObject(raw) && isPlainObject(raw.bars) ? raw.bars : {};
    for (const bar of TOOLBAR_BARS) bars[bar] = sanitizeLayout(bar, src[bar]);
    return { version: TOOLBAR_PREF_VERSION, bars };
}

/** 写回偏好：与默认完全一致的 bar 整个不落盘，好让「恢复默认」= 删键 */
export function buildPref(barsByLayout) {
    const src = isPlainObject(barsByLayout) ? barsByLayout : {};
    const bars = {};
    for (const bar of TOOLBAR_BARS) {
        const layout = sanitizeLayout(bar, src[bar]);
        if (!layoutEqual(layout, defaultLayout(bar))) bars[bar] = layout;
    }
    return Object.keys(bars).length
        ? { version: TOOLBAR_PREF_VERSION, bars }
        : null;
}

export function layoutEqual(a, b) {
    const x = a || {};
    const y = b || {};
    const ax = idList(x.order);
    const ay = idList(y.order);
    const bx = idList(x.hidden);
    const by = idList(y.hidden);
    return ax.length === ay.length && ax.every((v, i) => v === ay[i])
        && bx.length === by.length && bx.every((v, i) => v === by[i]);
}

export function visibleIds(layout) {
    const l = sanitizeLayoutLoose(layout);
    return l.order.filter(id => !l.hidden.includes(id));
}

export function hiddenIds(layout) {
    const l = sanitizeLayoutLoose(layout);
    return l.hidden.slice();
}

/* 内部：visibleIds/hiddenIds 也会被测试直接喂半成品布局，走一遍 sanitize 的
   order 收敛即可，但不必按 bar 查登记表（调用方只给了 layout） */
function sanitizeLayoutLoose(layout) {
    if (!isPlainObject(layout)) return { order: [], hidden: [] };
    const order = dedupe(idList(layout.order));
    const hidden = dedupe(idList(layout.hidden)).filter(id => order.includes(id));
    return { order, hidden };
}

/**
 * 上移/下移：在 order 里挪一格。跳过同组里已经不在场（present=null 表示未知）
 * 的项没有意义，所以这里只管 order，缺席由 apply 那侧处理。
 * @param {Object} layout
 * @param {string} id
 * @param {number} delta -1 上移 / +1 下移
 * @returns {Object} 新对象（不改入参，设置面板依赖「改坏了还能整个丢回去」）
 */
export function moveId(layout, id, delta) {
    const l = sanitizeLayoutLoose(layout);
    const order = l.order.slice();
    const i = order.indexOf(id);
    if (i < 0) return { order, hidden: l.hidden };
    const j = Math.max(0, Math.min(order.length - 1, i + (Number(delta) || 0)));
    if (j === i) return { order, hidden: l.hidden };
    order.splice(i, 1);
    order.splice(j, 0, id);
    return { order, hidden: l.hidden };
}

/** 显示/隐藏一个控件；非 removable 的 id 直接原样返回（不抛） */
export function setHidden(layout, id, hide, removable = true) {
    const l = sanitizeLayoutLoose(layout);
    if (!l.order.includes(id)) return { order: l.order, hidden: l.hidden };
    if (hide && !removable) return { order: l.order, hidden: l.hidden };
    const hidden = l.hidden.filter(x => x !== id);
    if (hide) hidden.push(id);
    return { order: l.order, hidden };
}

/**
 * 算出「工具条里应该有的子元素顺序」：登记项按 order 排在前面，
 * 未登记的（未来别的分片挂进来的、没有 id 的）保持原相对顺序跟在后面。
 * @param {string} bar
 * @param {Object} layout
 * @param {string[]} presentIds 当前工具条里真实存在的子元素 id（按现状顺序）
 * @returns {string[]} 期望顺序（一定与 presentIds 同集合，不多不少）
 */
export function resolveChildIds(bar, layout, presentIds) {
    const l = sanitizeLayout(bar, layout);
    const present = dedupe(idList(presentIds));
    const managed = [];
    for (const id of l.order) {
        if (isRegistered(bar, id) && present.includes(id)) managed.push(id);
    }
    /* 未登记的：按当前 DOM 顺序补在后面（分片侧对没有 id 的节点用哨兵键，
       所以这里不能用 present 过滤掉哨兵——调用方传什么就尊重什么） */
    const rest = present.filter(id => !managed.includes(id));
    return managed.concat(rest);
}
