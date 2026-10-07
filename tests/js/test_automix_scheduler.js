/* ============================================================
 * tests/js/test_automix_scheduler.js — Automix Phase 2 scheduler 单测
 *
 * 覆盖：开关短路 / AB 循环否决 / 在线曲否决（v1 范围）/ ARM 窗口判定 /
 * 决策→预载→ARMED 全流程 / canplay 推进 CROSSING / 交叉完成 → swapRoles
 * + onSwappedMeta / ARM 期超时放弃（too-late）。
 *
 * 手法：dualDeck 用真模块 + stub document；分析经 deps.analyzeImpl 注入
 * 固定结果；crossfader 时钟经 deps 透传手控——时间由测试推着走。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { initDualDeck, getActiveAudio, getShadowAudio, registerAudioListener, _resetDualDeckForTest } =
    await import('../../web/src/core/dualDeck.js');
const { initScheduler, onTimeUpdate, notifyTrackStarted, automixSnapshot,
    AUTOMIX_DEFAULTS, _resetSchedulerForTest } =
    await import('../../web/src/core/automix/scheduler.js');
const { crossfaderPhase, abortCrossfade, CROSSFADER_ARMED, CROSSFADER_CROSSING } =
    await import('../../web/src/core/automix/crossfader.js');
const { _resetCrossfaderForTest } = await import('../../web/src/core/automix/crossfader.js');
const { getLogs, lastLogSeq } = await import('../../web/src/services/log.js');

/* dualDeck 的 deckB 由 document.createElement 创建——stub 直接用 makeEl 同构 */
globalThis.document = {
    createElement() {
        const el = makeEl();
        el.setAttribute = () => {};
        return el;
    },
    body: { appendChild() {} },
};
globalThis.window = globalThis;

function makeEl() {
    const listeners = new Map();
    const el = {
        style: {}, volume: 0.8, playbackRate: 1, preservesPitch: false, currentTime: 0,
        duration: 240, paused: false, preload: '', loaded: false,
        playedCount: 0, srcs: [],
        set src(v) { this.srcs.push(v); },
        get src() { return this.srcs[this.srcs.length - 1] || ''; },
        load() { this.loaded = true; },
        play() { this.playedCount++; this.paused = false; return { catch() {} }; },
        pause() { this.paused = true; },
        addEventListener(t, fn) { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
        removeEventListener(t, fn) { const a = listeners.get(t); if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
        dispatch(t) { for (const fn of [...(listeners.get(t) || [])]) fn({ type: t }); },
    };
    return el;
}

function makeClock() {
    let nowMs = 0;
    let seq = 0;
    const pending = [];
    return {
        now: () => nowMs,
        advance(ms) { nowMs += ms; },
        schedule(fn, ms) { const h = { fn, ms, id: ++seq }; pending.push(h); return h; },
        cancelScheduled(h) { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); },
        raf(fn) { const h = { fn, raf: true, id: ++seq }; pending.push(h); return h; },
        caf(h) { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); },
        fireRaf() {
            const frames = pending.filter(t => t.raf);
            for (const f of frames) { const i = pending.indexOf(f); if (i >= 0) pending.splice(i, 1); f.fn(); }
            return frames.length;
        },
        fireScheduled() {
            const all = pending.filter(t => !t.raf);
            for (const f of all) { const i = pending.indexOf(f); if (i >= 0) pending.splice(i, 1); f.fn(); }
            return all.length;
        },
        pendingCount: () => pending.length,
    };
}

/* 固定分析结果：120 BPM / outroPoint=232s（曲尾前 8s）/ sparse=238s（曲尾前 2s）/ introPoint=500ms */
const GOOD_A = { bpm: 120, bpmConfidence: 3, outroPointMs: 232000, outroSparsePointMs: 238000, introPointMs: 0, durationMs: 240000 };
const GOOD_B = { bpm: 121, bpmConfidence: 3, outroPointMs: 230000, outroSparsePointMs: 236000, introPointMs: 500, durationMs: 238000 };

/** 在线下一曲的默认条目（下面的 setup 可整体替换） */
const ONLINE_B = { id: 42, source: 'tencent', url: 'http://x', title: '在线曲' };

function setup({ enabled = true, analyses = null, nextKind = 'local', mode = 'off', resolveOnlinePlayUrl = undefined, nextTrack = null, currentTrack = null } = {}) {
    _resetSchedulerForTest();
    _resetCrossfaderForTest();
    _resetDualDeckForTest();
    const clock = makeClock();
    const a = makeEl();
    a.currentTime = 233; a.duration = 240;
    initDualDeck(a);
    const bRef = getShadowAudio();   /* swap 前的影子 deck 引用（swap 后它成为活跃 deck） */
    const playlist = [
        { url: 'blob:a', title: 'A 曲' },
        { url: 'blob:b', title: 'B 曲' },
    ];
    const events = { meta: [] };
    const analyzed = [];   /* analyzeImpl 收到的 url 列表（验证预分析行为） */
    const analysisByUrl = analyses || { 'blob:a': GOOD_A, 'blob:b': GOOD_B };
    const deps = {
        isEnabled: () => enabled,
        getCurrentTrack: () => currentTrack || playlist[0],
        getNextTrack: () => nextKind === 'none' ? null : {
            track: nextTrack || (nextKind === 'online' ? ONLINE_B : playlist[1]),
            index: 1,
        },
        resolveTrackUrl: (t) => t.url || '',
        isAbLoopActive: () => mode !== 'off',
        /* phaseAt 记录通知时刻的交叉器状态——用来证明「换歌发生在交叉过半时」，
           而不是等曲线走完（进阶断言见文件尾的交接点测试） */
        onSwappedMeta: (info) => events.meta.push({ phaseAt: crossfaderPhase(), ...info }),
        analyzeImpl: (track) => { analyzed.push(track.url); return Promise.resolve(analysisByUrl[track.url] || null); },
        now: clock.now, schedule: clock.schedule, cancelScheduled: clock.cancelScheduled,
        raf: clock.raf, caf: clock.caf,
    };
    if (resolveOnlinePlayUrl !== undefined) deps.resolveOnlinePlayUrl = resolveOnlinePlayUrl;
    initScheduler(deps);
    return { clock, a, b: () => bRef, playlist, events, analyzed };
}

test('开关关闭：timeupdate 短路，不预载不 ARM', async () => {
    const s = setup({ enabled: false });
    notifyTrackStarted(s.playlist[0]);
    await new Promise(r => setTimeout(r, 5));
    onTimeUpdate();
    assert.equal(crossfaderPhase(), 'IDLE');
    assert.equal(s.b().srcs.length, 0, '影子 deck 未被预载');
});

test('AB 循环激活 / 下一曲缺失：不 ARM', async () => {
    setup({ mode: 'range' });
    onTimeUpdate();
    assert.equal(crossfaderPhase(), 'IDLE');
    assert.equal(getShadowAudio().srcs.length, 0);

    setup({ nextKind: 'none' });
    onTimeUpdate();
    assert.equal(crossfaderPhase(), 'IDLE');
});

test('在线源：无 resolveOnlinePlayUrl 依赖 → 放弃（不 ARM 不预载）', async () => {
    const s = setup({ nextKind: 'online' });
    onTimeUpdate();
    await new Promise(r => setTimeout(r, 5));
    assert.equal(crossfaderPhase(), 'IDLE');
    assert.equal(s.b().srcs.length, 0, '在线曲不进影子 deck');
});

test('在线源：解析依赖返回空（取链失败/超窗）→ 放弃', async () => {
    const s = setup({
        nextKind: 'online',
        resolveOnlinePlayUrl: async () => '',
    });
    onTimeUpdate();
    await new Promise(r => setTimeout(r, 5));
    assert.equal(crossfaderPhase(), 'IDLE');
    assert.equal(s.b().srcs.length, 0);
});

test('在线源 v2：ARM 期即时解析 → 以解析 URL 预载分析 → ARMED', async () => {
    const s = setup({
        nextKind: 'online',
        resolveOnlinePlayUrl: async (track) => {
            assert.equal(track.id, 42, '收到的是在线 track');
            return 'blob:online-b';
        },
        analyses: { 'blob:a': GOOD_A, 'blob:online-b': GOOD_B },
    });
    onTimeUpdate();
    await new Promise(r => setTimeout(r, 5));
    assert.equal(crossfaderPhase(), CROSSFADER_ARMED, '已 ARM');
    assert.equal(s.b().srcs.length, 1, 'B 已按解析 URL 预载');
    assert.equal(s.b().srcs[0], 'blob:online-b', '预载的是 ARM 期解析 URL，不是搜索期旧链');
    assert.equal(s.events.meta.length, 0);
    abortCrossfade('test-cleanup');
    assert.equal(crossfaderPhase(), 'IDLE');
});

test('★ 队列条目只有 song/singer 时归一：日志与取链都拿到真实歌名（A=?/B=2 根因）', async () => {
    /* 榜单 / 自建歌单 / 历史播放的「播放全部」都是先 push 原始接口对象、再以
       loadOnlineSong(first, skipPlaylistUpdate=true) 播放 —— 队列里留下的就是
       {song, singer} 形状（175 只把归一后的结果写进 currentSongData，**不改队列条目**）。
       automix 曾直读 .title，真机日志因此成了 `ARM 开始：A=? → B=2`，且更致命的是
       songName='' 让 fetchPlayUrlForPreload 里的「跨源同名歌兜底」（守卫恰是
       `if (!playUrl && songName)`）整条失效 —— ARM 取链失去最后的退路。 */
    const since = lastLogSeq();
    let seen = null;
    const s = setup({
        nextKind: 'online',
        currentTrack: { source: 'netease', id: 7, url: 'blob:a', song: '夜航', singer: '甲' },
        nextTrack: { id: 42, source: 'tencent', mid: 'MID42', song: '牵丝戏', singer: '银临' },
        resolveOnlinePlayUrl: async (track) => { seen = track; return 'blob:online-b'; },
        analyses: { 'blob:a': GOOD_A, 'blob:online-b': GOOD_B },
    });
    onTimeUpdate();
    await new Promise(r => setTimeout(r, 5));

    assert.ok(seen, '在线下一曲进入了取链');
    assert.equal(seen.title, '牵丝戏', '★ title 已归一（旧实现是 undefined → 日志 A=?）');
    assert.equal(seen.artist, '银临', '★ artist 已归一（参与跨源同名歌匹配）');
    assert.equal(seen.song, '牵丝戏', '原字段保留 —— 归一不得改写调用方持有的队列条目');
    assert.equal(s.b().srcs[0], 'blob:online-b', '归一后取链、预载照常走通');

    const msgs = getLogs({ tags: ['automix.scheduler'], sinceSeq: since, limit: 40 })
        .map(r => r.msg).join('\n');
    assert.ok(msgs.includes('牵丝戏'), '★ ARM 日志带上了真实歌名（旧实现是 A=? → B=2）');
    assert.ok(!msgs.includes('A=?'), '不得再出现 A=? 占位');
    abortCrossfade('test-cleanup');
});

test('A 起播（prewarm）即预分析队列下一曲，不等 ARM 窗口', async () => {
    const s = setup();
    notifyTrackStarted(s.playlist[0], true);
    await new Promise(r => setTimeout(r, 10));
    assert.ok(s.analyzed.includes('blob:b'), 'A 起播后立即分析 B（真机在线曲整首下载装不下 15s ARM 窗口）');
});

test('起播预分析：在线下一曲经 resolveOnlinePlayUrl 取链后再分析', async () => {
    let resolveCalls = 0;
    const s = setup({
        nextKind: 'online',
        resolveOnlinePlayUrl: async () => { resolveCalls++; return 'blob:online-b'; },
        analyses: { 'blob:a': GOOD_A, 'blob:online-b': GOOD_B },
    });
    notifyTrackStarted(s.playlist[0], true);
    await new Promise(r => setTimeout(r, 10));
    assert.equal(resolveCalls, 1, '起播时解析一次在线直链');
    assert.ok(s.analyzed.includes('blob:online-b'), '并按解析 URL 预分析 B');
});

test('timeupdate 补挂（非起播）不触发预分析取链', async () => {
    let resolveCalls = 0;
    setup({
        nextKind: 'online',
        resolveOnlinePlayUrl: async () => { resolveCalls++; return 'blob:online-b'; },
        analyses: { 'blob:a': GOOD_A, 'blob:online-b': GOOD_B },
    });
    onTimeUpdate();   /* _currentUrl 为 null → 补挂 A；随后进入 ARM 期解析一次 */
    await new Promise(r => setTimeout(r, 10));
    assert.equal(resolveCalls, 1, '仅 ARM 期解析一次——补挂路径不得预分析取链');
});

test('重叠时长由 A 的结构出口决定（供各决策层共用）', async () => {
    /* GOOD_A: durationMs=240000、outroPointMs=232000 → 重叠 = 8s。
       旧实现 beatmatch 写死 6s、segue 用 outroSparsePointMs（238s）算成 2s
       ——后者正是「等 A 没声了才淡入」的来源。 */
    setup();
    onTimeUpdate();
    await new Promise(r => setTimeout(r, 5));
    assert.equal(automixSnapshot().plannedOverlapMs, 8000, '重叠 = duration - outroPoint');

    /* 超长尾声 → 封顶 16s（再长会与下一首的进入打架） */
    const longOutro = { ...GOOD_A, durationMs: 300000, outroPointMs: 240000, outroSparsePointMs: 298000 };
    setup({ analyses: { 'blob:a': longOutro, 'blob:b': GOOD_B } });
    onTimeUpdate();
    await new Promise(r => setTimeout(r, 5));
    assert.equal(automixSnapshot().plannedOverlapMs, AUTOMIX_DEFAULTS.maxOverlapMs, '超长尾声封顶');

    /* 尾部突然截断（outroPoint = 全曲长，无自然淡出）→ 退固定兜底 */
    const abrupt = { ...GOOD_A, durationMs: 240000, outroPointMs: 240000, outroSparsePointMs: 240000 };
    setup({ analyses: { 'blob:a': abrupt, 'blob:b': GOOD_B } });
    onTimeUpdate();
    await new Promise(r => setTimeout(r, 5));
    assert.equal(automixSnapshot().plannedOverlapMs, AUTOMIX_DEFAULTS.overlapMs, '无衰减段退兜底');
});

test('决策 segue（BPM gap 过大）→ 同样从结构出口开始，两端都不变速', async () => {
    const s = setup({ analyses: { 'blob:a': GOOD_A, 'blob:b': { ...GOOD_B, bpm: 160 } } });
    onTimeUpdate();
    await new Promise(r => setTimeout(r, 5));
    assert.equal(crossfaderPhase(), CROSSFADER_ARMED, 'segue 也要 ARM');
    assert.equal(s.b().srcs.length, 1, 'B 已预载');
    assert.equal(automixSnapshot().plannedOverlapMs, 8000, '★ segue 也用结构出口（旧的 sparse 起点只剩 2s）');
    s.b().dispatch('canplay');
    assert.equal(crossfaderPhase(), CROSSFADER_ARMED, 'canplay 只标记就绪，窗口未到不开');
    s.a.currentTime = 233;     /* remaining=7s ≤ 8s → 开交叉，此时 A 离曲尾还有 7 秒 */
    onTimeUpdate();
    assert.equal(crossfaderPhase(), CROSSFADER_CROSSING, '交叉落在 A 仍有声的位置');
    assert.equal(s.b().playbackRate, 1, 'segue 不变速');
    abortCrossfade('test-cleanup');
    assert.equal(crossfaderPhase(), 'IDLE');
});

test('窗口内但 B 未就绪 → 保持 ARMED 等待，滑过窗口下沿 → too-late', async () => {
    const s = setup();
    onTimeUpdate();
    await new Promise(r => setTimeout(r, 5));
    assert.equal(crossfaderPhase(), CROSSFADER_ARMED);
    s.a.currentTime = 234.5;   /* remaining=5.5s ≤ 重叠 8s，但 B 没 canplay */
    onTimeUpdate();
    assert.equal(crossfaderPhase(), CROSSFADER_ARMED, '未就绪不开交叉');
    s.a.currentTime = 237.5;   /* remaining=2.5s < 重叠×0.6=4.8s */
    onTimeUpdate();
    assert.equal(crossfaderPhase(), 'IDLE', 'too-late 后归位 IDLE');
    assert.equal(s.b().paused, true);
});

test('ARM 全流程：窗口内 → 决策 beatmatch → 预载 B → ARMED → 就绪+窗口 → CROSSING', async () => {
    const s = setup();
    onTimeUpdate();
    await new Promise(r => setTimeout(r, 5));
    assert.equal(crossfaderPhase(), CROSSFADER_ARMED, '已 ARM');
    assert.equal(s.b().srcs.length, 1, 'B 已预载');
    assert.equal(s.b().loaded, true, 'load() 已触发');
    /* canplay 只标记就绪；交叉开始等 A 剩余进入 overlap 窗口 */
    s.b().dispatch('canplay');
    assert.equal(crossfaderPhase(), CROSSFADER_ARMED, '窗口未到保持 ARMED');
    s.a.currentTime = 234.5;   /* remaining=5.5s ≤ overlap 6s */
    onTimeUpdate();
    assert.equal(crossfaderPhase(), CROSSFADER_CROSSING, '就绪+窗口 → CROSSING');
    /* rate = 121/120 = 1.0083（对拍速率写入 plan，startCrossing 时落到 B） */
    assert.equal(s.b().playbackRate > 1 && s.b().playbackRate < 1.02, true, '对拍速率在 ±5% 内');
    /* 清理：abort 退出，不驱动完成 */
    abortCrossfade('test-cleanup');
    assert.equal(crossfaderPhase(), 'IDLE');
});

test('ARM 期超时放弃：B 一直没 canplay、窗口过半 → too-late 中止', async () => {
    const s = setup();
    onTimeUpdate();
    await new Promise(r => setTimeout(r, 5));
    assert.equal(crossfaderPhase(), CROSSFADER_ARMED);
    /* 时钟推进模拟：currentTime 不变（已停格在 233s，remaining=7s < overlap*0.6=3.6s? 不——7s > 3.6s），
       把 currentTime 推到 237.5s（remaining=2.5s < 3.6s）→ 放弃 */
    s.a.currentTime = 237.5;
    onTimeUpdate();
    assert.equal(crossfaderPhase(), 'IDLE', 'too-late 后归位 IDLE');
    assert.equal(s.b().paused, true);
});

test('交叉完成 → 旧 A 收尾 + swapRoles + onSwappedMeta 通知（含 next）', async () => {
    const s = setup();
    onTimeUpdate();
    await new Promise(r => setTimeout(r, 5));
    s.b().dispatch('canplay');
    s.a.currentTime = 234.5;
    onTimeUpdate();
    assert.equal(crossfaderPhase(), CROSSFADER_CROSSING);
    /* 推进交叉曲线：T=6000ms，rAF 帧写 volume；推到 T 完成后 _finishTimer(T+250) 兜底触发 */
    let guard = 0;
    while (crossfaderPhase() === CROSSFADER_CROSSING && guard++ < 200) {
        s.clock.advance(500);
        if (s.clock.fireRaf() === 0) s.clock.fireScheduled();
    }
    assert.equal(crossfaderPhase(), 'IDLE', '交叉完成');
    assert.equal(s.events.meta.length, 1, 'onSwappedMeta 恰好一次');
    assert.equal(s.events.meta[0].next.index, 1, 'meta 带 next 引用');
    assert.equal(s.events.meta[0].next.track.title, 'B 曲');
    /* swapRoles 后：新活跃元素是原 B */
    assert.equal(getActiveAudio(), s.b(), 'B 已顶替为活跃 deck');
    assert.ok(s.b().volume > 0.7 && s.b().volume <= 0.8, `B 终态音量=用户增益（0.8），实际 ${s.b().volume}`);
    assert.equal(getShadowAudio(), s.a, '旧 A 进入影子位');
});

/* ---------- 交接点：提前换歌（Apple Music 式） ---------- */

/** 把交叉曲线推到走完（帧步长 500ms，兜底句柄接管） */
function drainCrossing(s) {
    let guard = 0;
    while (crossfaderPhase() === CROSSFADER_CROSSING && guard++ < 200) {
        s.clock.advance(500);
        if (s.clock.fireRaf() === 0) s.clock.fireScheduled();
    }
}

test('交接点提前换歌：曲线过半即通知（此时仍是 CROSSING），走完只做收尾', async () => {
    const s = setup();
    onTimeUpdate();
    await new Promise(r => setTimeout(r, 5));
    s.b().dispatch('canplay');
    s.a.currentTime = 234.5;
    onTimeUpdate();
    assert.equal(crossfaderPhase(), CROSSFADER_CROSSING);
    /* 交叉 T = _resolveOverlap(GOOD_A) = duration 240s - outroPoint 232s = 8000ms，过半 = 4000ms */
    s.clock.advance(5000); s.clock.fireRaf();
    assert.equal(s.events.meta.length, 1, '★ 曲线才走到 58%，换歌通知已经到了');
    assert.equal(s.events.meta[0].phaseAt, CROSSFADER_CROSSING, '通知时交叉仍在进行');
    assert.equal(getActiveAudio(), s.b(), '角色已提前顶替');
    assert.equal(s.a.paused, false, '旧 A 仍要出声淡出——交叉没被打断');
    drainCrossing(s);
    assert.equal(crossfaderPhase(), 'IDLE');
    assert.equal(s.events.meta.length, 1, '收尾不得重复通知（否则元数据/索引被写第二遍）');
    assert.equal(getShadowAudio(), s.a, '旧 A 退役为影子 deck');
    assert.equal(s.a.paused, true, '收尾时才停旧 A');
});

test('收尾停旧 A 时其上已无常驻监听（播放图标不会被刷回「已暂停」）', async () => {
    const s = setup();
    let pausedOnActive = 0;
    registerAudioListener('pause', () => { pausedOnActive++; });
    onTimeUpdate();
    await new Promise(r => setTimeout(r, 5));
    s.b().dispatch('canplay');
    s.a.currentTime = 234.5;
    onTimeUpdate();
    drainCrossing(s);
    /* 交接完成后常驻监听已搬到 B */
    s.a.dispatch('pause');
    assert.equal(pausedOnActive, 0, '★ 旧 A 的 pause 不再触达常驻监听——这正是「明明在播却显示暂停」的根因');
    s.b().dispatch('pause');
    assert.equal(pausedOnActive, 1, '新活跃元素的 pause 正常触达');
});
