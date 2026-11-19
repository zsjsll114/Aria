/**
 * @file tests/js/test_listen_stats_report.js
 * 单元测试：web/src/core/listenStatsReport.js
 *   1. localDayKey / shiftLocalDayKey 本地时区一致性（跨午夜不偏移到 UTC 昨天）
 *   2. applyPlayTick：30s 阈前积攒时长不丢（修复原 258 只加最后 5s 的缺陷）、歌曲封面与时段累加
 *   3. buildStatsReport：空态 / 零点守夜人 / 晨光 / 暮色 / 连续天数 / 14 日节拍 / 旧存档退化兜底 / AI 情绪光谱聚合
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    applyPlayTick,
    buildStatsReport,
    createTickTracker,
    defaultPlayStats,
    formatCompactDuration,
    formatStatsDuration,
    localDayKey,
    normalizeStatsData,
    resetTickForTrack,
    sanitizeHexColor,
    shiftLocalDayKey,
} from '../../web/src/core/listenStatsReport.js';

test('localDayKey follows local calendar rather than UTC midnight', () => {
    const lateLocal = new Date(2026, 9, 10, 23, 55, 0, 0).getTime();
    const earlyLocal = new Date(2026, 9, 11, 0, 15, 0, 0).getTime();
    assert.equal(localDayKey(lateLocal), '2026-10-10');
    assert.equal(localDayKey(earlyLocal), '2026-10-11');
    assert.equal(shiftLocalDayKey('2026-10-11', -1), '2026-10-10');
});

test('applyPlayTick preserves pre-threshold duration and updates hourly + cover metadata', () => {
    const tracker = createTickTracker();
    let st = defaultPlayStats();
    const song = {
        source: 'tencent',
        id: '108879872',
        mid: '0039MnYb0qxYhV',
        title: '晴天',
        artist: '周杰伦',
        cover: 'https://example.com/qingtian.jpg',
    };
    const t23 = new Date(2026, 9, 10, 23, 20, 0, 0).getTime();

    /* 5s × 5 = 25s，尚未到 30s：累计时长与当日/23点时段必须已记，但播放次数仍为 0 */
    for (let i = 0; i < 5; i++) {
        const res = applyPlayTick(st, tracker, 5, song, t23 + i * 5000);
        st = res.stats;
        assert.equal(res.changed, true);
    }
    assert.equal(st.totalPlays, 0);
    assert.equal(st.totalMs, 25000);
    assert.equal(st.days['2026-10-10'], 25000);
    assert.equal(st.hours[23], 25000);

    /* 第 6 次 tick (+5s = 30s)：记 1 次播放，且把全部 30000ms（而非仅最后 5000ms）计入歌曲与歌手 */
    const hit = applyPlayTick(st, tracker, 5, song, t23 + 25000);
    st = hit.stats;
    assert.equal(st.totalPlays, 1);
    const key = 'tencent:108879872';
    assert.equal(st.songs[key].n, 1);
    assert.equal(st.songs[key].ms, 30000);
    assert.equal(st.songs[key].cover, 'https://example.com/qingtian.jpg');
    assert.equal(st.artists['周杰伦'].n, 1);
    assert.equal(st.artists['周杰伦'].ms, 30000);

    /* 第 7 次 tick (+5s)：继续累加到单曲和歌手时长 */
    st = applyPlayTick(st, tracker, 5, song, t23 + 30000).stats;
    assert.equal(st.songs[key].ms, 35000);
    assert.equal(st.artists['周杰伦'].ms, 35000);

    resetTickForTrack(tracker);
    assert.equal(tracker.activeKey, '');
});

test('buildStatsReport empty state and persona classification', () => {
    const now = new Date(2026, 10, 16, 20, 0, 0, 0).getTime();
    const empty = buildStatsReport({ stats: defaultPlayStats(), now });
    assert.equal(empty.overview.hasAnyData, false);
    assert.equal(empty.persona.id, 'empty');
    assert.equal(empty.persona.title, '初遇频段');

    /* 深夜占比主导 -> 零点守夜人 */
    const stNight = defaultPlayStats();
    stNight.totalPlays = 12;
    stNight.totalMs = 3000000;
    stNight.firstAt = new Date(2026, 10, 10, 23, 0, 0, 0).getTime();
    stNight.days['2026-11-14'] = 300000;
    stNight.days['2026-11-15'] = 900000;
    stNight.days['2026-11-16'] = 1200000;
    stNight.hours[23] = 1600000;
    stNight.hours[1] = 800000;
    stNight.hours[14] = 600000;
    stNight.songs['netease:101'] = { title: '夜曲', artist: '周杰伦', n: 7, ms: 1600000, cover: '', source: '', id: '', mid: '', hash: '', firstAt: 0, lastAt: 0 };
    stNight.artists['周杰伦'] = { n: 7, ms: 1600000, cover: '', source: '', lastAt: 0 };

    const nightRep = buildStatsReport({
        stats: stNight,
        recentHistory: [{ key: 'netease:101', title: '夜曲', artist: '周杰伦', source: 'netease', id: '101', cover: 'https://img/yequ.jpg', at: now - 3600000 }],
        favorites: [{ key: 'netease:101', title: '夜曲', artist: '周杰伦' }],
        aiThemes: {
            '夜曲|周杰伦': {
                mood: '微凉怀旧',
                primary_color: '#7c9ce0',
                emotion_words: [{ word: '夜色', color: '#7c9ce0', emotion: 'nostalgia' }, { word: '温柔', color: '#e8be6a' }],
            },
        },
        now,
    });
    assert.equal(nightRep.overview.hasAnyData, true);
    assert.equal(nightRep.overview.companionDays, 7);
    assert.equal(nightRep.overview.streakDays, 3);
    assert.equal(nightRep.persona.id, 'lateNight');
    assert.equal(nightRep.spotlight?.cover, 'https://img/yequ.jpg');
    assert.equal(nightRep.spotlight?.isFav, true);
    assert.equal(nightRep.moodSpectrum.dominantColor, '#7C9CE0');
    assert.equal(nightRep.moodSpectrum.words[0]?.word, '夜色');
    assert.equal(nightRep.rhythm14.days.length, 14);
    assert.equal(nightRep.rhythm14.bestDay?.dayKey, '2026-11-16');

    /* 清晨主导 -> 晨光拾音者 */
    const stDawn = defaultPlayStats();
    stDawn.totalPlays = 4;
    stDawn.totalMs = 900000;
    stDawn.hours[7] = 700000;
    stDawn.hours[15] = 200000;
    stDawn.songs['kugou:abc'] = { title: '稻香', artist: '周杰伦', n: 4, ms: 900000, cover: '', source: 'kugou', id: 'abc', mid: '', hash: '', firstAt: 0, lastAt: 0 };
    const dawnRep = buildStatsReport({ stats: stDawn, now });
    assert.equal(dawnRep.persona.id, 'dawn');
});

test('legacy stats without hours fall back to recent timestamps & source key parsing', () => {
    const legacy = normalizeStatsData({
        totalPlays: 3,
        totalMs: 420000,
        songs: { 'tencent:0039MnYb0qxYhV': { title: '晴天', artist: '周杰伦', n: 3, ms: 30000 } },
        artists: { '周杰伦': { n: 3, ms: 30000 } },
        days: { '2026-11-15': 420000 },
    });
    const at20 = new Date(2026, 10, 15, 20, 30, 0, 0).getTime();
    const rep = buildStatsReport({
        stats: legacy,
        recentHistory: [{ title: '晴天', artist: '周杰伦', cover: 'https://img/qt.jpg', at: at20 }],
        now: new Date(2026, 10, 16, 10, 0, 0, 0).getTime(),
    });
    assert.equal(rep.circadian.hourSource, 'recent');
    assert.equal(rep.circadian.peakHour, 20);
    assert.equal(rep.topSongs[0]?.source, 'tencent');
    assert.equal(rep.topSongs[0]?.mid, '0039MnYb0qxYhV');
    assert.equal(rep.topSongs[0]?.cover, 'https://img/qt.jpg');
});

test('format helpers, resetAt filter & hex color guard', () => {
    const t0 = new Date(2026, 10, 15, 10, 0, 0, 0).getTime();
    const resetRep = buildStatsReport({
        stats: defaultPlayStats(t0 + 1000),
        recentHistory: [{ title: '旧歌', artist: '歌手', at: t0 }],
        now: t0 + 2000,
    });
    assert.equal(resetRep.overview.hasAnyData, false);
    assert.equal(sanitizeHexColor('#abc'), '#AABBCC');
    assert.equal(sanitizeHexColor('javascript:alert(1)'), '');
    assert.equal(formatStatsDuration(3720000), '1小时2分');
    assert.equal(formatCompactDuration(7800000), '2h 10m');
});
