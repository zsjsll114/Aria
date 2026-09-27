/* ============================================================
 * tests/js/test_toolbar.js — core/toolbarLayout.js 行为回归（292 可自定义工具栏）
 * 运行方式：node --test tests/js/test_toolbar.js
 *          （仓库根目录跑全套：node --test tests/js/ ——
 *           注意 git-bash 下 `node --test tests/js/test_*.js` 只会展开到 5 个文件）
 *
 * 盯的是「用户偏好落地成 DOM 顺序」这件事的四个不变量，它们全部在
 * 分片外侧、没有 DOM 也能判：
 *   1. registry 是唯一事实源：默认顺序 = 数组下标，且**不得与 index.html 的
 *      真实 DOM 顺序打架**（对不上时第一次 apply 就会重排按钮，
 *      MutationObserver ↔ apply 有自激风险，见 292 头注释第 3 条）。
 *   2. 隐藏/显示严格可逆：藏起来再放回去，顺序必须逐位相同
 *      ——order 存全量、hidden 存子集就是为了这条。
 *   3. 脏数据不抛、不残留：未知 id（旧版本删掉的按钮）、重复 id、
 *      hidden 里塞未登记/不可藏的 id、整个值不是对象——一律收敛成可用布局；
 *      新版本往 registry 中间插按钮时，老配置要按默认位置补进来而不是挤到末尾。
 *   4. 可见集合 ∩ 隐藏集合 = ∅ 恒成立（含各种坏输入），
 *      以及「设置」那颗永远不许被藏（它是回到这个设置页的逃生通道）。
 * 手法：纯逻辑，不 stub DOM —— core 零 DOM 依赖正是为了能这样测。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const R = await import('../../web/src/core/toolbarLayout.js');
const { DEFAULT_SETTINGS } = await import('../../web/src/config/defaults.js');

const {
    TOOLBAR_CONTROLS, TOOLBAR_BARS, TOOLBAR_PREF_KEY, TOOLBAR_PREF_VERSION,
    buildPref, controlsOfBar, defaultLayout, defaultOrder, isRemovable, isRegistered,
    layoutEqual, moveId, normalizePref, resolveChildIds, sanitizeLayout,
    setHidden, visibleIds, hiddenIds,
} = R;

const BAR = 'top';
const ALL_IDS = defaultOrder(BAR);

/* ---------- 工具 ---------- */

/** 断言 list 里这几个 id 的先后关系与 given 一致（缺席的忽略） */
function keepsRelativeOrder(list, given) {
    assert.deepEqual(given.filter(id => list.includes(id)), given,
        '用户指定的先后顺序被 sanitize 改写了');
}

const STATIC_IDS = [
    'openSearchBtn', 'openDailyBtn', 'openRankingsBtn', 'openStatsBtn',
    'openFavoritesBtn', 'openPlaylistsBtn', 'npQuickToggle', 'desktopLyricsBtn',
    'sleepTimerBtn', 'openViewModeBtn', 'openSettingsBtn',
];

/* ==================== 1. registry / 默认顺序 ==================== */

test('registry 是单一事实源：id 不重复、bar 都有归属、默认顺序即数组顺序', () => {
    assert.equal(new Set(TOOLBAR_CONTROLS.map(c => c.id)).size, TOOLBAR_CONTROLS.length,
        '同一个按钮登记两次会让 order 里去重后位置漂移');
    for (const bar of TOOLBAR_BARS) {
        assert.ok(controlsOfBar(bar).length > 0, bar + ' 一条登记都没有，设置页会是空列表');
        assert.deepEqual(defaultOrder(bar), controlsOfBar(bar).map(c => c.id));
    }
    /* 每个 bar 名都必须在 TOOLBAR_BARS 里，否则 sanitize/apply 永远看不到它 */
    for (const c of TOOLBAR_CONTROLS) {
        assert.ok(TOOLBAR_BARS.includes(c.bar), c.id + ' 的 bar=' + c.bar + ' 没有登记在 TOOLBAR_BARS');
        assert.equal(isRegistered(c.bar, c.id), true);
    }
    assert.equal(isRegistered(BAR, 'ghostBtn'), false, '未登记的 id 一律不算这条工具栏的控件');
    assert.equal(isRegistered('没有这条工具栏', 'openStatsBtn'), false);
});

test('默认顺序与 index.html 里的静态顺序一致（对不上等于 boot 即重排）', () => {
    const html = fs.readFileSync('web/index.html', 'utf8').replace(/\r\n/g, '\n');
    const start = html.indexOf('<div class="top-action-buttons">');
    const end = html.indexOf('<button id="mobilePageToggle"', start);
    assert.ok(start > 0 && end > start, '找不到右上角工具栏那一段，本测试的判据得跟着 index.html 改');
    const region = html.slice(start, end);
    const domIds = [...region.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(domIds, STATIC_IDS, 'index.html 的右上角按钮与本测试的清单不一致，先对齐再改 registry');
    /* registry 里这批的相对顺序必须与 DOM 相同（288/283 那颗动态按钮另说） */
    const regStaticOrder = ALL_IDS.filter(id => STATIC_IDS.includes(id));
    assert.deepEqual(regStaticOrder, domIds,
        'registry 默认顺序与 DOM 不一致：第一次 apply 会重排既有按钮，观察器有自激风险');
});

test('「设置」是唯一的非 removable 项（逃生通道）', () => {
    const pinned = TOOLBAR_CONTROLS.filter(c => c.removable === false).map(c => c.id);
    assert.deepEqual(pinned, ['openSettingsBtn']);
    assert.equal(isRemovable(BAR, 'openSettingsBtn'), false);
    assert.equal(isRemovable(BAR, 'openStatsBtn'), true);
    assert.equal(isRemovable(BAR, '未登记的按钮'), false, '未登记的 id 不该被当成可藏');
});

/* ==================== 2. 隐藏 / 显示可逆 ==================== */

test('隐藏再显示：顺序逐位复原，且全程可见∩隐藏为空', () => {
    const start = defaultLayout(BAR);
    const target = ALL_IDS.filter(id => isRemovable(BAR, id)).slice(0, 5);
    let l = start;
    for (const id of target) l = setHidden(l, id, true, isRemovable(BAR, id));
    assert.deepEqual(hiddenIds(l), target);
    assert.deepEqual(visibleIds(l), ALL_IDS.filter(id => !target.includes(id)));
    for (const id of target) l = setHidden(l, id, false);
    assert.deepEqual(l.hidden, [], '全部放回后不该有残留');
    assert.ok(layoutEqual(l, start), '往返必须回到逐位相同的 order');
});

test('setHidden 不改 order（位置是 order 的事，在不在是 hidden 的事）', () => {
    const l = defaultLayout(BAR);
    const next = setHidden(l, 'openStatsBtn', true);
    assert.deepEqual(next.order, l.order);
    assert.deepEqual(l.hidden, [], '不得原地改入参——设置页要能整份丢回旧值');
});

test('非 removable 的 id 藏不掉，也不抛', () => {
    const l = setHidden(defaultLayout(BAR), 'openSettingsBtn', true, false);
    assert.deepEqual(l.hidden, []);
    assert.deepEqual(visibleIds(l), ALL_IDS);
});

test('藏一个 order 里不存在的 id 是空操作', () => {
    const l = setHidden(defaultLayout(BAR), 'ghostBtn', true, true);
    assert.deepEqual(l, defaultLayout(BAR));
});

/* ==================== 3. 脏数据净化 ==================== */

test('未知 id 丢弃、重复 id 只留第一次，缺席项按默认位置补回', () => {
    const raw = {
        order: ['openDailyBtn', 'openDailyBtn', '已不存在的按钮', 'openStatsBtn'],
        hidden: ['openStatsBtn', '已不存在的按钮'],
    };
    const l = sanitizeLayout(BAR, raw);
    assert.equal(l.order.filter(x => x === 'openDailyBtn').length, 1, '重复 id 只能留第一次');
    assert.ok(!l.order.includes('已不存在的按钮'), '旧版本删掉的按钮不该留在顺序里');
    assert.deepEqual(l.hidden, ['openStatsBtn'], 'hidden 里的未知项要丢掉');
    assert.deepEqual(l.order, ALL_IDS,
        '这两位本来就按默认先后排着 → 补回缺席项后应等于默认序，而不是被挤到开头');

    /* 用户真的换了先后（stats 排到 search 前）时必须保留，只补缺席的那位 */
    const moved = sanitizeLayout(BAR, { order: ['openStatsBtn', 'openSearchBtn'], hidden: [] });
    keepsRelativeOrder(moved.order, ['openStatsBtn', 'openSearchBtn']);
    assert.equal(moved.order.length, ALL_IDS.length, '补完之后必须仍是全量');
    assert.equal(new Set(moved.order).size, moved.order.length);
});

test('新版本在 registry 中间插一颗按钮时，老配置按默认槽位补它（不是追加到末尾）', () => {
    /* 模拟「这份 order 是在 lyricSearchBtn 还不存在的版本里存的」 */
    const legacy = ALL_IDS.filter(id => id !== 'lyricSearchBtn');
    const l = sanitizeLayout(BAR, { order: legacy, hidden: [] });
    assert.deepEqual(l.order, ALL_IDS, '缺席的登记项必须回到它在默认序里的位置');
});

test('hidden 里塞未知/重复/不可藏的 id 一律清掉', () => {
    const raw = {
        order: ALL_IDS,
        hidden: ['openSettingsBtn', 'openStatsBtn', 'openStatsBtn', 'ghost', '别的条的按钮'],
    };
    const l = sanitizeLayout(BAR, raw);
    assert.deepEqual(l.hidden, ['openStatsBtn']);
    assert.ok(!visibleIds(l).includes('openStatsBtn'));
});

test('整体坏掉（null / 字符串 / 数字 / 数组 / order 不是字符串数组）一律退回默认且不抛', () => {
    const bad = [undefined, null, 0, '', 'oops', [], ['openStatsBtn'], {},
        { order: 'openStatsBtn' }, { order: null, hidden: undefined },
        { order: [1, {}, null, 'openStatsBtn'], hidden: { nope: 1 } },
        { bars: { top: defaultLayout(BAR) } }];
    for (const v of bad) {
        const l = sanitizeLayout(BAR, v);
        assert.deepEqual(l.order, ALL_IDS, '坏值 ' + JSON.stringify(v) + ' 必须退回默认顺序');
        assert.ok(Array.isArray(l.hidden) && l.hidden.length === 0);
    }
});

test('normalizePref / buildPref 往返：与默认一致时整个键不落盘（恢复默认 = 删键）', () => {
    const bars = {};
    TOOLBAR_BARS.forEach(b => { bars[b] = defaultLayout(b); });
    assert.equal(buildPref(bars), null, '全默认不该往 appSettings 里写垃圾');
    bars.top = setHidden(defaultLayout(BAR), 'openStatsBtn', true);
    const pref = buildPref(bars);
    assert.equal(pref.version, TOOLBAR_PREF_VERSION);
    assert.deepEqual(normalizePref(pref).bars.top.hidden, ['openStatsBtn']);
    assert.deepEqual(normalizePref(null).bars.top.order, ALL_IDS);
    assert.deepEqual(normalizePref({ version: 99, bars: { top: 'x' } }).bars.top.order, ALL_IDS,
        '未来版本/坏结构都要退回默认，不能抛');
});

/* ==================== 4. 排序与落地 ==================== */

test('moveId 上移/下移一格，两端不越界', () => {
    let l = defaultLayout(BAR);
    const idx = id => l.order.indexOf(id);
    l = moveId(l, 'openRankingsBtn', -1);
    assert.equal(idx('openRankingsBtn'), ALL_IDS.indexOf('openRankingsBtn') - 1);
    l = moveId(l, 'openRankingsBtn', 1);
    assert.ok(layoutEqual(l, defaultLayout(BAR)), '下移回去必须逐位复原');
    const top = moveId(defaultLayout(BAR), ALL_IDS[0], -1);
    assert.ok(layoutEqual(top, defaultLayout(BAR)), '第一行再上移是原地不动');
    const bottom = moveId(defaultLayout(BAR), ALL_IDS[ALL_IDS.length - 1], 1);
    assert.ok(layoutEqual(bottom, defaultLayout(BAR)), '最后一行再下移是原地不动');
    assert.ok(layoutEqual(moveId(defaultLayout(BAR), 'ghost', -1), defaultLayout(BAR)));
});

test('resolveChildIds：登记项按 order 在前，未登记的保持原顺序在后，且集合不增不减', () => {
    const l = defaultLayout(BAR);
    const present = ['openSettingsBtn', 'ghostDiv', 'openDailyBtn', 'openSearchBtn'];
    const wanted = resolveChildIds(BAR, l, present);
    assert.equal(wanted.length, present.length, '期望序列必须与在场子元素一一对应');
    assert.deepEqual(new Set(wanted), new Set(present));
    assert.deepEqual(wanted.slice(0, 2), ['openSearchBtn', 'openDailyBtn'], '登记项按 registry 顺序');
    assert.equal(wanted[wanted.length - 1], 'ghostDiv', '未登记的排到最后且不去重不丢弃');
});

test('resolveChildIds 对缺席/坏布局都不抛，且只引用在场的 id', () => {
    const present = ['openSearchBtn', 'openSettingsBtn'];
    assert.deepEqual(resolveChildIds(BAR, null, present), present);
    assert.deepEqual(resolveChildIds(BAR, { order: 'x', hidden: 'y' }, present), present);
    assert.deepEqual(resolveChildIds(BAR, defaultLayout(BAR), []), []);
    assert.deepEqual(resolveChildIds('没有这条工具栏', defaultLayout(BAR), present), present,
        '未知 bar 不得抛，交回在场顺序');
});

test('不变量：任何输入下 可见 ∩ 隐藏 = ∅', () => {
    const samples = [
        defaultLayout(BAR),
        { order: ALL_IDS, hidden: ALL_IDS.filter(id => isRemovable(BAR, id)) },
        sanitizeLayout(BAR, { order: ALL_IDS.slice(0, 3), hidden: ALL_IDS }),
        sanitizeLayout(BAR, { order: [1, 'x'], hidden: ['openStatsBtn'] }),
        setHidden(defaultLayout(BAR), 'openSettingsBtn', true, false),
        normalizePref({ bars: { top: { order: ALL_IDS, hidden: ['openStatsBtn', 'openStatsBtn'] } } }).bars.top,
    ];
    for (const l of samples) {
        const vis = visibleIds(l);
        const hid = hiddenIds(l);
        assert.equal(vis.filter(id => hid.includes(id)).length, 0,
            '同一颗按钮既在又不在了：' + JSON.stringify(l));
        assert.equal(new Set(vis).size, vis.length);
        assert.equal(vis.length + hid.length, new Set(vis.concat(hid)).size);
    }
});

test('全藏（除固定项）后设置页仍留得下、也解得开', () => {
    let l = defaultLayout(BAR);
    for (const id of ALL_IDS) l = setHidden(l, id, true, isRemovable(BAR, id));
    assert.deepEqual(visibleIds(l), ['openSettingsBtn'], '只剩固定显示那颗');
    assert.equal(hiddenIds(l).length, ALL_IDS.length - 1);
    /* 恢复默认 = 丢回 defaultLayout，不依赖逐颗取消隐藏 */
    assert.ok(layoutEqual(defaultLayout(BAR), sanitizeLayout(BAR, defaultLayout(BAR))));
});

test('TOOLBAR_PREF_KEY 落在 interface 下（AGENTS 约束 11：不许新增顶层键）', () => {
    assert.equal(Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, TOOLBAR_PREF_KEY), false,
        'toolbar 一旦进 DEFAULT_SETTINGS 顶层，180 的 loadSettings() 白名单就会把它丢掉');
    assert.equal(TOOLBAR_PREF_KEY, 'toolbar');
});
