/* ============================================================
 * tests/js/test_next_up.js — core/nextUp.js「下一首预告」判定回归（todos #5）
 *
 * 盯的是三条会直接坑到用户的不变量：
 *  1. 触发时机：只在「距切歌 ≤ leadSeconds 且还在播」时浮出；已经浮出的用迟滞一路留到
 *     切歌（剩 0.3 秒才浮出来一闪而过 = 不如不浮）。
 *  2. 撤销：换歌（代际 / 索引 / audio.src 任一变化）、暂停、seek 出窗口、
 *     切歌播完 —— 全部必须 HIDE，杜绝「预告 A 实际播 B」。
 *  3. 各播放模式的候选语义与 95-track-loading.js 的 _stepTrack(+1) /
 *     175-track-index-online.js 的 getNextTrackIndex() 一致：
 *     loop=重播当前、random=不报名（当场才摇）、sequence=+1 取模（队尾回到第一首）。
 * 候选顺序必须是确定性轮转且不含「正在播的」和「默认要播的」，跑两遍结果必须相同
 * （函数里没有 Math.random / Date.now / DOM，这条断言才有意义）。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    ACTION,
    KIND,
    LEAD_MAX_SECONDS,
    LEAD_MIN_SECONDS,
    MAX_CANDIDATES,
    MIN_REMAINING_SEC,
    REASON,
    buildCandidates,
    describeDecision,
    evaluateNextUp,
    isPlayableTrack,
    normalizeLeadSeconds,
    normalizeNextUpPrefs,
    pickNext,
    resolveNextUp,
    songSignature,
} from '../../web/src/core/nextUp.js';

/* ---------- 夹具 ---------- */

function track(i, extra = {}) {
    return {
        title: `歌 ${i + 1}`,
        artist: `歌手 ${i + 1}`,
        cover: `https://cdn.example/cover${i}.jpg`,
        source: 'tencent',
        id: `id${i}`,
        ...extra,
    };
}

function queue(n, extraFor) {
    return Array.from({ length: n }, (_, i) => (extraFor ? (extraFor(i) || track(i, {})) : track(i)));
}

/** 默认快照：正在播、队列 5 首、索引 0、顺序播放、剩 4 秒（5 秒提前量的窗口内） */
function snap(over = {}) {
    const { remainingSec = 4, durationSec = 200, ...rest } = over;
    return {
        playlist: queue(5),
        currentIndex: 0,
        playMode: 'sequence',
        durationSec,
        currentTimeSec: durationSec - remainingSec,
        isPlaying: true,
        prefs: { enabled: true, leadSeconds: 5 },
        generation: 7,
        src: 'https://cdn.example/play0.mp3',
        alreadyRevealed: false,
        ...rest,
    };
}

/* ---------- 1. 触发时机 ---------- */

test('时机：离切歌还远 → 不浮出（too-early）', () => {
    const d = resolveNextUp(snap({ remainingSec: 60 }));
    assert.equal(d.show, false);
    assert.equal(d.reason, REASON.TOO_EARLY);
});

test('时机：进入提前量窗口 → 浮出，且报的是队列的下一首', () => {
    const d = resolveNextUp(snap({ remainingSec: 4.2 }));
    assert.equal(d.show, true, d.reason);
    assert.equal(d.kind, KIND.TRACK);
    assert.equal(d.index, 1);
    assert.equal(d.title, '歌 2');
    assert.equal(d.clickable, true);
});

test('时机：恰好等于 leadSeconds 也算进入窗口（边界闭区间）', () => {
    assert.equal(resolveNextUp(snap({ remainingSec: 5 })).show, true);
    assert.equal(resolveNextUp(snap({ remainingSec: 5.001 })).show, false);
});

test('时机：只剩零点几秒时不要一闪而过（too-late）', () => {
    const d = resolveNextUp(snap({ remainingSec: 0.4 }));
    assert.equal(d.show, false);
    assert.equal(d.reason, REASON.TOO_LATE);
    assert.ok(MIN_REMAINING_SEC > 0, '迟滞门槛必须存在');
});

test('时机：已经浮出的条靠迟滞一路留到切歌，不在最后 1 秒被自己撤掉', () => {
    const d = resolveNextUp(snap({ remainingSec: 0.4, alreadyRevealed: true }));
    assert.equal(d.show, true, d.reason);
    assert.equal(d.key, 'track:1:1');
});

test('时机：remaining ≤ 0（真到曲终）→ 不再显示', () => {
    const d = resolveNextUp(snap({ remainingSec: 0, alreadyRevealed: true }));
    assert.equal(d.show, false);
    assert.equal(d.reason, REASON.ENDED);
});

test('时机：时长未知（直播/流式 duration=Infinity 或 NaN）→ 一律不浮出', () => {
    [Infinity, NaN, 0, -3, undefined].forEach((durationSec) => {
        const d = resolveNextUp({ ...snap(), durationSec, currentTimeSec: 5 });
        assert.equal(d.show, false, `${String(durationSec)} 不该浮出`);
        assert.equal(d.reason, REASON.NO_DURATION);
    });
});

test('时机：leadSeconds 越大窗口越早开', () => {
    const big = resolveNextUp(snap({ remainingSec: 12, prefs: { enabled: true, leadSeconds: 15 } }));
    assert.equal(big.show, true);
    assert.equal(resolveNextUp(snap({ remainingSec: 12 })).show, false);
});

/* ---------- 2. 撤销 ---------- */

test('撤销：暂停 → HIDE（正在播的东西变了语义，预告作废）', () => {
    const r = evaluateNextUp(snap({ isPlaying: false, revealed: { key: 'track:1:1', signature: songSignature(snap()) } }));
    assert.equal(r.action, ACTION.HIDE);
    assert.equal(r.reason, REASON.NOT_PLAYING);
});

test('撤销：seek 回窗口外 → HIDE（too-early）', () => {
    const revealed = { key: 'track:1:1', signature: songSignature(snap()) };
    const r = evaluateNextUp(snap({ remainingSec: 90, revealed }));
    assert.equal(r.action, ACTION.HIDE);
    assert.equal(r.reason, REASON.TOO_EARLY);
});

test('撤销：代际 +1（用户按了下一曲 / 自动切歌）→ HIDE，而不是改口成另一首', () => {
    const revealed = { key: 'track:1:1', signature: songSignature(snap({ generation: 7 })) };
    const r = evaluateNextUp(snap({ generation: 8, remainingSec: 3, revealed }));
    assert.equal(r.action, ACTION.HIDE);
    assert.equal(r.reason, REASON.SONG_CHANGED);
});

test('撤销：队列索引变了（点队列里的歌直接播）→ HIDE', () => {
    const before = snap({ currentIndex: 0 });
    const after = snap({ currentIndex: 2, revealed: { key: 'x', signature: songSignature(before) } });
    const r = evaluateNextUp({ ...after, generation: before.generation });
    assert.equal(r.action, ACTION.HIDE);
    assert.equal(r.reason, REASON.SONG_CHANGED);
});

test('撤销：audio.src 变了但代际没变（新增切歌路径漏埋点时的兜底）→ HIDE', () => {
    const before = snap();
    const revealed = { key: 'track:1:1', signature: songSignature(before) };
    const r = evaluateNextUp(snap({ src: 'https://cdn.example/play9.mp3', revealed }));
    assert.equal(r.action, ACTION.HIDE);
    assert.equal(r.reason, REASON.SONG_CHANGED);
});

test('签名里代际/索引/音源三者任一都会改变（防止只比对一个维度）', () => {
    const a = songSignature(snap());
    assert.notEqual(songSignature(snap({ generation: 8 })), a);
    assert.notEqual(songSignature(snap({ currentIndex: 3 })), a);
    assert.notEqual(songSignature(snap({ src: 'x' })), a);
    assert.equal(songSignature(snap({ remainingSec: 1 })), a, '只剩时间变化不该算换歌');
});

test('开关关掉：已浮出的条也必须立刻 HIDE，而不是等它自己过期', () => {
    const revealed = { key: 'track:1:1', signature: songSignature(snap()) };
    const r = evaluateNextUp(snap({ prefs: { enabled: false, leadSeconds: 5 }, revealed }));
    assert.equal(r.action, ACTION.HIDE);
    assert.equal(r.reason, REASON.OFF);
});

test('被抑制（专注模式 / 系统接管 / 正在加载 / 弹窗挡路）→ 不浮出', () => {
    const d = resolveNextUp(snap({ suppressed: true }));
    assert.equal(d.show, false);
    assert.equal(d.reason, REASON.SUPPRESSED);
});

test('同一首歌但预测改口（改播放模式 / 动队列）→ REFRESH，且新 key 生效', () => {
    const revealed = { key: 'track:1:1', signature: songSignature(snap()) };
    const r = evaluateNextUp(snap({ playMode: 'loop', revealed }));
    assert.equal(r.action, ACTION.REFRESH, '不能继续显示「下一首：歌 2」');
    assert.equal(r.decision.kind, KIND.REPLAY);
    assert.equal(r.decision.index, 0);
});

test('什么都没变 → KEEP（渲染层只刷剩余秒数，不重播动画）', () => {
    const revealed = { key: 'track:1:1', signature: songSignature(snap()) };
    const r = evaluateNextUp(snap({ remainingSec: 2.5, revealed }));
    assert.equal(r.action, ACTION.KEEP);
});

/* ---------- 3. 各播放模式的下一步语义 ---------- */

test('sequence：+1；队尾回到第一首（wraps 标记，仍然是可信预告）', () => {
    const mid = resolveNextUp(snap({ currentIndex: 1 }));
    assert.equal(mid.index, 2);
    assert.equal(mid.wraps, false);

    const tail = resolveNextUp(snap({ currentIndex: 4 }));
    assert.equal(tail.index, 0);
    assert.equal(tail.wraps, true);
    assert.equal(tail.kind, KIND.TRACK);
});

test('loop：预告的就是当前这首（kind=replay，报名字是真话）', () => {
    const d = resolveNextUp(snap({ playMode: 'loop' }));
    assert.equal(d.show, true);
    assert.equal(d.kind, KIND.REPLAY);
    assert.equal(d.index, 0);
    assert.equal(d.title, '歌 1');
    assert.equal(d.namesSong, true);
    /* 候选里不能出现「正在播的/重播的」那首，否则点了等于没换 */
    assert.ok(d.candidates.every(c => c.index !== 0));
});

test('random：不报名（kind=random、index=-1、track=null）—— 摇点在实际切歌时才发生', () => {
    const d = resolveNextUp(snap({ playMode: 'random' }));
    assert.equal(d.show, true);
    assert.equal(d.kind, KIND.RANDOM);
    assert.equal(d.index, -1);
    assert.equal(d.track, null);
    assert.equal(d.namesSong, false);
    assert.equal(d.title, '');
    assert.equal(d.clickable, true);
    assert.equal(d.candidates.length, 4, '随机模式下候选=队列里其它 4 首');
});

test('random：pickNext 不给索引，所以「报了 A 播了 B」在这条路上不可能发生', () => {
    for (let i = 0; i < 50; i++) {
        const n = pickNext({ length: 5, currentIndex: 2, playMode: 'random' });
        assert.equal(n.kind, KIND.RANDOM);
        assert.equal(n.index, -1);
    }
});

test('队列只有一首：没有可否决的对象，也不值得预告重播 → 不浮出', () => {
    ['sequence', 'loop', 'random'].forEach((playMode) => {
        const d = resolveNextUp(snap({ playlist: queue(1), currentIndex: 0, playMode }));
        assert.equal(d.show, false, `${playMode} 不该浮出`);
        assert.equal(d.reason, REASON.NO_CHOICE);
    });
});

test('空队列：95 会去摇随机 API（播的不是队列里的歌）→ 一律不报', () => {
    const d = resolveNextUp(snap({ playlist: [], currentIndex: 0 }));
    assert.equal(d.show, false);
    assert.equal(d.reason, REASON.EMPTY_QUEUE);
    assert.equal(pickNext({ length: 0, currentIndex: 0, playMode: 'sequence' }).index, -1);
});

test('两首队列：默认要播的就是另一首 → 没有第三种选择，但「接下来播 X」本身仍有信息量', () => {
    const d = resolveNextUp(snap({ playlist: queue(2), currentIndex: 0 }));
    assert.equal(d.show, true);
    assert.equal(d.kind, KIND.TRACK);
    assert.equal(d.index, 1);
    assert.equal(d.clickable, false);
    assert.equal(d.candidates.length, 0);
});

/* ---------- 4. 候选列表 ---------- */

test('候选：确定性轮转，跳过正在播的与默认要播的', () => {
    const c = buildCandidates({ playlist: queue(6), currentIndex: 1, predictedIndex: 2, limit: MAX_CANDIDATES });
    assert.deepEqual(c.map(x => x.index), [3, 4, 5, 0]);
});

test('候选：跨过队尾回到开头，且不重复', () => {
    const c = buildCandidates({ playlist: queue(4), currentIndex: 3, predictedIndex: 0, limit: MAX_CANDIDATES });
    assert.deepEqual(c.map(x => x.index), [1, 2]);
});

test('候选：同一入参跑两遍必须一模一样（禁止 Math.random）', () => {
    const args = { playlist: queue(9), currentIndex: 4, predictedIndex: 5, limit: MAX_CANDIDATES };
    assert.deepEqual(buildCandidates(args), buildCandidates(args));
});

test('候选：条数上限 = MAX_CANDIDATES', () => {
    const c = buildCandidates({ playlist: queue(30), currentIndex: 0, predictedIndex: 1, limit: MAX_CANDIDATES });
    assert.equal(c.length, MAX_CANDIDATES);
});

test('候选：不可播的条目（没有 id/url）不进列表', () => {
    const pl = queue(4);
    pl[2] = { title: '缺链接的残条目' };
    const c = buildCandidates({ playlist: pl, currentIndex: 0, predictedIndex: 1, limit: MAX_CANDIDATES });
    assert.deepEqual(c.map(x => x.index), [3]);
    assert.equal(isPlayableTrack(pl[2]), false);
    assert.equal(isPlayableTrack({ title: 'x', mid: 'm' }), false);
    assert.equal(isPlayableTrack({ title: 'x', source: 'tencent', id: '1' }), true);
    assert.equal(isPlayableTrack({ title: '本地', url: 'blob:https://x/y' }), true);
});

test('候选：本地文件条目（只有 url）也在列表里，字段名兼容 title/song/name', () => {
    const pl = [
        { url: 'blob:a', title: 'A' },
        { url: 'blob:b', song: 'B' },
        { url: 'blob:c', name: 'C', singer: '某人' },
    ];
    const c = buildCandidates({ playlist: pl, currentIndex: 0, predictedIndex: 1, limit: MAX_CANDIDATES });
    assert.deepEqual(c.map(x => x.title), ['C']);
    assert.equal(c[0].artist, '某人');
});

/* ---------- 5. 偏好归一 ---------- */

test('偏好：缺省=开（不写进 defaults.js 也生效），leadSeconds 越界夹紧', () => {
    assert.deepEqual(normalizeNextUpPrefs(undefined), { enabled: true, leadSeconds: 5 });
    assert.deepEqual(normalizeNextUpPrefs({ enabled: false }), { enabled: false, leadSeconds: 5 });
    assert.equal(normalizeNextUpPrefs({ leadSeconds: 0 }).leadSeconds, LEAD_MIN_SECONDS);
    assert.equal(normalizeNextUpPrefs({ leadSeconds: 999 }).leadSeconds, LEAD_MAX_SECONDS);
    [null, undefined, 'abc', NaN, {}].forEach((v) => {
        assert.equal(normalizeLeadSeconds(v, 5), 5, `${String(v)} 必须退回默认`);
    });
    assert.equal(normalizeLeadSeconds('8', 5), 8, '表单里的字符串数字要认');
});

test('决策摘要：不显示时给出原因，显示时给出歌名与候选数（日志排查用）', () => {
    assert.match(describeDecision(resolveNextUp(snap({ remainingSec: 60 }))), /^hide\(too-early\)$/);
    const shown = describeDecision(resolveNextUp(snap()));
    assert.match(shown, /^show\(track #2 歌 2/);
    assert.match(shown, /cands:3\)$/);
});
