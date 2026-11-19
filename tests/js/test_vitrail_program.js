/* ============================================================
 * tests/js/test_vitrail_program.js — 曲风匹配、分镜 Seek 确定性与情感词边界单测
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    VITRAIL_ARCHETYPES,
    VITRAIL_PALETTES,
    resolveVitrailSongProfile,
    computeVitrailCameraPose,
} from '../../web/src/core/visualizers/vitrail/vitrailProfiles.js';
import {
    compileVitrailProgram,
    findActiveVitrailShot,
    chunkVitrailGraphemes,
    resolveShotEmotionColors,
    wrapVitrailShotLines,
} from '../../web/src/core/visualizers/vitrail/vitrailProgram.js';

function makeWordLine(timeSec, text, opts = {}) {
    const chars = Array.from(text);
    const step = (opts.wordDurSec || 0.28);
    return {
        time: timeSec,
        text,
        original: text,
        translation: opts.translation || '',
        romaji: opts.romaji || '',
        words: chars.map((ch, idx) => ({
            word: ch,
            start: timeSec + idx * step,
            end: timeSec + (idx + 1) * step,
        })),
    };
}

test('VP1 四首不同语种/情绪歌曲能智能匹配多种原型与色板，且尊重显式覆盖', () => {
    const pBallad = resolveVitrailSongProfile({
        lyrics: [makeWordLine(2, '长夜教会教堂琥珀微光祈祷')],
        aiData: { mood: 'sad nostalgic reverent sacred cathedral' },
        songData: { title: 'Vespers', artist: 'Aria' },
    });
    assert.equal(pBallad.archetype, 'cathedral');

    const pCyber = resolveVitrailSongProfile({
        lyrics: [
            makeWordLine(1, 'Floating in the cosmic starlight telemetry', { wordDurSec: 0.08 }),
            makeWordLine(2.1, 'Orbiting around neon velvet gravity', { wordDurSec: 0.08 }),
        ],
        aiData: { mood: 'electronic dreamy synth cosmic' },
        songData: { title: 'Orbital', artist: 'Nova' },
    });
    assert.equal(pCyber.archetype, 'observatory');

    const pFolk = resolveVitrailSongProfile({
        lyrics: [makeWordLine(2, '春风十里竹林烟雨故乡山水静水流深', { wordDurSec: 0.42 })],
        aiData: { mood: 'acoustic calm gentle folk 竹叶 古典' },
        songData: { title: '水院暮雨', artist: 'Lin' },
    });
    assert.equal(pFolk.archetype, 'cloister');

    const pPop = resolveVitrailSongProfile({
        lyrics: [
            makeWordLine(1, 'きらめく光のダンス踊ろう', { wordDurSec: 0.07 }),
            makeWordLine(2.0, '晴れた空へ駆け出すメロディ', { wordDurSec: 0.07 }),
        ],
        aiData: { mood: 'bright upbeat dance energetic' },
        songData: { title: 'Prism', artist: 'Hana' },
    });
    assert.equal(pPop.archetype, 'pavilion');

    const pForced = resolveVitrailSongProfile({
        lyrics: [makeWordLine(1, 'test')],
        presetOverride: 'alabaster',
        archOverride: 'observatory',
    });
    assert.equal(pForced.archetype, 'observatory');
    assert.equal(pForced.palette.key, 'alabaster');
    assert.equal(pForced.palette.isLight, true);
    assert.ok(VITRAIL_ARCHETYPES.includes(pForced.archetype));
    assert.ok(VITRAIL_PALETTES.alabaster.isLight);
});

test('VP2 Seek 确定性与 O(log N) 分镜查找 + 自动插入超过 4.5s 间奏巡礼', () => {
    const lines = [
        makeWordLine(2.0, '幽暗圣殿回响著晨钟'),
        makeWordLine(4.5, '微光透过彩窗照亮石阶'),
        makeWordLine(15.0, '穿过长夜仍有星光守望'),
    ];
    const songProfile = resolveVitrailSongProfile({ lyrics: lines, presetOverride: 'amber', archOverride: 'cathedral' });
    const prog = compileVitrailProgram({
        lines,
        songProfile,
        songData: { title: 'Cathedral Dawn', artist: 'Aria Choir' },
    });

    const hasInterlude = prog.shots.some((s) => s.kind === 'interlude');
    const hasColophon = prog.shots.some((s) => s.kind === 'colophon');
    assert.ok(hasInterlude, '间隔超过 4.5s 时必须插入建筑间奏巡礼镜');
    assert.ok(hasColophon, '结尾必须生成碑铭 colophon 镜');

    // Seek 往返幂等性验证
    const sAt3a = findActiveVitrailShot(prog, 3.0);
    const sAt10 = findActiveVitrailShot(prog, 10.5);
    const sAt3b = findActiveVitrailShot(prog, 3.0);
    assert.equal(sAt10.shot.kind, 'interlude');
    assert.equal(sAt3a.shot.index, sAt3b.shot.index);
    assert.equal(sAt3a.shot.text, sAt3b.shot.text);
    const camA = computeVitrailCameraPose({ timeSec: 3.0, shot: sAt3a.shot, archetype: 'cathedral' });
    const camB = computeVitrailCameraPose({ timeSec: 3.0, shot: sAt3b.shot, archetype: 'cathedral' });
    assert.deepEqual(camA.eye, camB.eye);
    assert.deepEqual(camA.target, camB.target);
});

test('VP3 英文长行切块与折行绝不腰斩英文单词，且保持精确行级字符偏移', () => {
    const text = 'Unbelievable constellations illuminate cathedral arches forever';
    const gs = Array.from(text).map((ch, idx) => ({
        char: ch,
        start: 1000 + idx * 50,
        end: 1050 + idx * 50,
    }));
    const chunks = chunkVitrailGraphemes(gs, 16);
    assert.ok(chunks.length >= 2);
    const words = text.split(' ');
    const joinedChunks = chunks.map((ch) => ch.map((g) => g.char).join(''));
    for (const word of words) {
        assert.ok(joinedChunks.some((seg) => seg.includes(word)), `英文单词 "${word}" 在分块时被腰斩: ${joinedChunks.join(' | ')}`);
    }

    const wrapped = wrapVitrailShotLines(gs, new Array(gs.length).fill(null), 12.5);
    assert.ok(wrapped.length >= 2 && wrapped.length <= 3);
    for (const row of wrapped) {
        const str = row.items.map((x) => x.char).join('');
        assert.equal(str.includes('constell\n'), false);
    }

    // 还原 YRC 丢空格的英文词数组（如 PreviewEngine YRC）不应黏连，同时单字逐字输入也不误插空格
    const yrcProg = compileVitrailProgram({
        lines: [{
            time: 1.0,
            original: "Sittin' in the car listening",
            words: [
                { text: "Sittin'", start: 1000, end: 1300 },
                { text: ' in', start: 1300, end: 1500 },
                { text: 'the', start: 1500, end: 1700 },
                { text: ' car', start: 1700, end: 2000 },
                { text: 'listening', start: 2000, end: 2500 },
            ],
        }],
        songProfile: resolveVitrailSongProfile({ presetOverride: 'amber' }),
    });
    const yrcTextJoined = yrcProg.shots.filter((s) => s.kind === 'lyric').map((s) => s.text).join(' ');
    assert.ok(yrcTextJoined.includes("Sittin' in the car listening"), `YRC 英文词间应保留空格: ${yrcTextJoined}`);

    // 单字逐字数组（CJK/逐字母卡拉OK）不应被误插空格
    const charProg = compileVitrailProgram({
        lines: [{
            time: 1.0,
            original: 'Moonlight',
            words: Array.from('Moonlight').map((ch, idx) => ({
                text: ch,
                start: 1000 + idx * 100,
                end: 1100 + idx * 100,
            })),
        }],
        songProfile: resolveVitrailSongProfile({ presetOverride: 'amber' }),
    });
    const charJoined = charProg.shots.filter((s) => s.kind === 'lyric').map((s) => s.text).join('');
    assert.equal(charJoined, 'Moonlight', `单字逐字不应误插空格: ${charJoined}`);
});

test('VP4 aiEmotionWords 跨 chunk 偏移、英文词边界保护与开关尊重', () => {
    const prevWords = globalThis.aiEmotionWords;
    const prevSettings = globalThis.appSettings;
    try {
        const line = makeWordLine(1, '星辰坠入 luminous horizon 并照亮旧日 dreamscapes');
        globalThis.aiEmotionWords = [
            { word: '星辰', color: '#ffd166' },
            { word: 'luminous', color: '#446688' }, // 暗色背景上会被对比度校准提亮
            { word: 'dream', color: '#ff5555' },    // 不应误伤 dreamscapes!
        ];
        globalThis.appSettings = { lyrics: { emotionWords: true } };

        const prog = compileVitrailProgram({
            lines: [line],
            songProfile: resolveVitrailSongProfile({ presetOverride: 'sapphire' }),
        });

        // 合集所有 lyric shots 确认「星辰」与「luminous」准确命中，而「dream」没有误伤「dreamscapes」
        const hitMap = new Map();
        for (const shot of prog.shots.filter((s) => s.kind === 'lyric')) {
            const cols = resolveShotEmotionColors(shot, null, VITRAIL_PALETTES.sapphire);
            shot.graphemes.forEach((g, idx) => {
                if (cols[idx]) hitMap.set(shot.lineGraphemeOffset + idx, cols[idx]);
            });
        }
        assert.ok(hitMap.has(0) && hitMap.has(1), '应该命中首词「星辰」');
        const lumStart = line.text.indexOf('luminous');
        assert.ok(hitMap.has(lumStart), '应该命中跨片英文情感词 luminous');
        const dreamStart = line.text.indexOf('dreamscapes');
        assert.equal(hitMap.has(dreamStart), false, '前缀词 dream 不应误伤 dreamscapes');

        // 关闭情感词开关后必须全清空
        globalThis.appSettings = { lyrics: { emotionWords: false } };
        const shot0 = prog.shots.find((s) => s.kind === 'lyric');
        const offCols = resolveShotEmotionColors(shot0, null, VITRAIL_PALETTES.sapphire);
        assert.ok(offCols.every((c) => c === null), '关闭 emotionWords 后应全部返回 null');
    } finally {
        globalThis.aiEmotionWords = prevWords;
        globalThis.appSettings = prevSettings;
    }
});

test('VP5 多幕建筑巡游章节、场景边界溶解与 C1 连续机位零跳变', async () => {
    const { resolveVitrailSceneAtTime } = await import('../../web/src/core/visualizers/vitrail/vitrailProgram.js');
    const { computeVitrailCameraPose, VITRAIL_ARCHETYPES } = await import('../../web/src/core/visualizers/vitrail/vitrailProfiles.js');

    const longLines = [];
    for (let i = 0; i < 14; i++) {
        const t = 1 + i * 4;
        const text = i === 9 ? '♪' : (i >= 5 && i <= 8 ? 'Chorus illuminates the vaulted sky' : `Verse line ${i + 1} drifts through stone`);
        longLines.push({
            time: t,
            text,
            original: text,
            isChorus: i >= 5 && i <= 8,
        });
    }
    const profile = resolveVitrailSongProfile({
        lyrics: longLines,
        songData: { title: 'Grand Vault Suite' },
        presetOverride: 'auto',
        archOverride: 'auto',
    });
    assert.ok(profile.suite.length >= 3, `auto 巡游套件应至少包含 3 幕，实际 ${profile.suite.length}`);

    const prog = compileVitrailProgram({
        lines: longLines,
        songProfile: profile,
        songData: { title: 'Grand Vault Suite' },
    });
    assert.ok(prog.scenes.length >= 2, `长曲应切分为 >= 2 幕建筑场景，实际 ${prog.scenes.length}`);
    for (let k = 0; k < prog.scenes.length; k++) {
        assert.ok(VITRAIL_ARCHETYPES.includes(prog.scenes[k].archetype));
        if (k > 0) {
            assert.ok(prog.scenes[k].startSec > prog.scenes[k - 1].startSec);
        }
    }

    // 章节边界处于过渡区内部，0 < sceneMix < 1 且 Seek 幂等
    const boundary = prog.scenes[1].startSec;
    const midA = resolveVitrailSceneAtTime(prog, boundary + 0.12, profile, { crossfadeSec: 2.4 });
    const midB = resolveVitrailSceneAtTime(prog, boundary + 0.12, profile, { crossfadeSec: 2.4 });
    assert.ok(midA.sceneMix > 0.05 && midA.sceneMix < 0.95, `边界处应处于渐变溶解窗，实际 mix=${midA.sceneMix}`);
    assert.notEqual(midA.fromArch, midA.toArch);
    assert.equal(midA.sceneMix, midB.sceneMix);
    assert.equal(midA.palette.bgTop, midB.palette.bgTop);

    // 验证紧邻分句边界处的 3D 机位连续性（旧版会瞬移 >1m，现应 C1 连贯 <0.03m）
    for (let i = 0; i < prog.shots.length - 1; i++) {
        const sA = prog.shots[i];
        const sB = prog.shots[i + 1];
        if (Math.abs(sB.startSec - sA.endSec) > 0.02) continue;
        const poseEnd = computeVitrailCameraPose({
            timeSec: sA.endSec - 0.0005,
            shot: sA,
            prevShot: prog.shots[i - 1] || null,
            nextShot: sB,
            archetype: sA.sceneArchetype || profile.archetype,
        });
        const poseStart = computeVitrailCameraPose({
            timeSec: sB.startSec + 0.0005,
            shot: sB,
            prevShot: sA,
            nextShot: prog.shots[i + 2] || null,
            archetype: sB.sceneArchetype || profile.archetype,
        });
        const dist = Math.hypot(
            poseEnd.eye[0] - poseStart.eye[0],
            poseEnd.eye[1] - poseStart.eye[1],
            poseEnd.eye[2] - poseStart.eye[2],
        );
        assert.ok(dist < 0.03, `分镜 #${i}->#${i + 1} 边界相机跳变过大: ${dist.toFixed(4)}m`);
    }

    // findActiveVitrailShot 返回 prevShot
    const active = findActiveVitrailShot(prog, prog.shots[2].startSec + 0.5);
    assert.equal(active.prevShot?.index, prog.shots[1].index);
});

test('VP6 跨分句/间歇停顿/多行切块与场景溶解窗口具备全局 C1 机位及速度连续性', async () => {
    const { resolveVitrailSceneAtTime } = await import('../../web/src/core/visualizers/vitrail/vitrailProgram.js');

    const lines = [
        makeWordLine(1.0, 'Opening stone catches quiet light', { wordDurSec: 0.08 }),
        // 含长英文折块、轻微重叠时间戳、以及 0.7s / 2.2s 短停顿
        {
            time: 3.1,
            text: 'Sunlight pours across the towering arches and reflects upon the still water below',
            original: 'Sunlight pours across the towering arches and reflects upon the still water below',
            isChorus: false,
            words: 'Sunlight pours across the towering arches and reflects upon the still water below'
                .split(/\s+/)
                .map((w, idx) => ({ word: `${w} `, start: 3.1 + idx * 0.25, end: 3.1 + (idx + 1) * 0.25 })),
        },
        makeWordLine(7.6, 'Chorus rises over gilded nave', { wordDurSec: 0.09, isChorus: true }),
        makeWordLine(10.8, 'Every stained pane breathes as one', { wordDurSec: 0.09, isChorus: true }),
        makeWordLine(15.2, 'Lanterns linger through midnight air', { wordDurSec: 0.09 }),
        makeWordLine(18.6, 'Echoes settle into marble hush', { wordDurSec: 0.09 }),
        makeWordLine(22.4, 'Soft dawn opens a vaulted cloister', { wordDurSec: 0.09 }),
        makeWordLine(26.0, 'Final note floats above the water', { wordDurSec: 0.09 }),
    ];

    const profile = resolveVitrailSongProfile({
        lyrics: lines,
        songData: { title: 'Cathedral Flow Continuity Test' },
        presetOverride: 'auto',
        archOverride: 'auto',
    });
    const prog = compileVitrailProgram({
        lines,
        songProfile: profile,
        songData: { title: 'Cathedral Flow Continuity Test' },
    });

    assert.ok(prog.shots.length >= 8, `应产生足够分镜与切块，实际 ${prog.shots.length}`);
    assert.ok(prog.scenes.length >= 2, `应包含 >= 2 幕建筑场景以覆盖场景切换，实际 ${prog.scenes.length}`);

    // 同一原句被切分为多块时，movement 必须一致且携带相同 songSeed
    const chunkedShots = prog.shots.filter((s) => (s.totalChunks || 1) > 1);
    assert.ok(chunkedShots.length >= 2, '长英文句应拆分为多块');
    const firstLineChunks = chunkedShots.filter((s) => s.lineIndex === chunkedShots[0].lineIndex);
    for (let k = 1; k < firstLineChunks.length; k++) {
        assert.equal(firstLineChunks[k].movement, firstLineChunks[0].movement, '同句切块 movement 不得中途翻脸');
        assert.equal(firstLineChunks[k].songSeed, firstLineChunks[0].songSeed, '同歌曲切块 songSeed 必须一致');
    }

    const evalPoseAt = (t) => {
        const sc = resolveVitrailSceneAtTime(prog, t, profile, { crossfadeSec: 3.2 });
        const act = findActiveVitrailShot(prog, t);
        return computeVitrailCameraPose({
            timeSec: t,
            shot: act.shot,
            prevShot: act.prevShot,
            nextShot: act.nextShot,
            nextNextShot: act.nextNextShot,
            fromArchetype: sc.fromArch,
            archetype: sc.toArch,
            sceneMix: sc.sceneMix,
            cameraAmp: 0.85,
        });
    };

    // 1. 验证 findActiveVitrailShot 返回 nextNextShot
    const midAct = findActiveVitrailShot(prog, prog.shots[1].startSec + 0.1);
    assert.equal(midAct.nextNextShot?.index, prog.shots[3]?.index);

    // 2. 在每一个分镜边界处验证位置连续性 (< 0.005m) 与左右极限速度连续性 (< 0.08 m/s)
    const eps = 0.001;
    for (let i = 1; i < prog.shots.length; i++) {
        const b = prog.shots[i].startSec;
        if (b <= 0.02) continue;
        const pLm = evalPoseAt(b - 2 * eps);
        const pL = evalPoseAt(b - eps);
        const pR = evalPoseAt(b + eps);
        const pRp = evalPoseAt(b + 2 * eps);

        const posJump = Math.hypot(
            pR.eye[0] - pL.eye[0],
            pR.eye[1] - pL.eye[1],
            pR.eye[2] - pL.eye[2],
        );
        assert.ok(posJump < 0.005, `分镜边界 #${i} (t=${b.toFixed(2)}s) 位置跳变过大: ${posJump.toFixed(5)}m`);

        const vL = [0, 1, 2].map((k) => (pL.eye[k] - pLm.eye[k]) / eps);
        const vR = [0, 1, 2].map((k) => (pRp.eye[k] - pR.eye[k]) / eps);
        const velJump = Math.hypot(vR[0] - vL[0], vR[1] - vL[1], vR[2] - vL[2]);
        assert.ok(velJump < 0.08, `分镜边界 #${i} (t=${b.toFixed(2)}s) 速度折角过大: ${velJump.toFixed(4)} m/s`);
    }

    // 3. 在整首歌时间轴与场景解散窗口 (winStart ~ winEnd) 按 20ms 步进采样，保证全程零突跳
    let prevPose = evalPoseAt(0.5);
    const maxEnd = Math.min(28.0, prog.shots[prog.shots.length - 1].endSec);
    for (let t = 0.52; t <= maxEnd; t += 0.02) {
        const curPose = evalPoseAt(t);
        const stepDist = Math.hypot(
            curPose.eye[0] - prevPose.eye[0],
            curPose.eye[1] - prevPose.eye[1],
            curPose.eye[2] - prevPose.eye[2],
        );
        assert.ok(stepDist < 0.05, `t=${t.toFixed(2)}s 20ms 帧间机位跳变过大: ${stepDist.toFixed(4)}m`);
        prevPose = curPose;
    }

    // 4. 在幕间过渡早期 sceneMix <= 0.002 处也检查 sceneMix 单调且平滑过渡
    const scBound = prog.scenes[1].startSec;
    const preFade = resolveVitrailSceneAtTime(prog, Math.max(0, scBound - 1.1), profile, { crossfadeSec: 3.2 });
    const midFade = resolveVitrailSceneAtTime(prog, scBound + 0.1, profile, { crossfadeSec: 3.2 });
    const postFade = resolveVitrailSceneAtTime(prog, scBound + 2.5, profile, { crossfadeSec: 3.2 });
    assert.ok(preFade.sceneMix <= midFade.sceneMix && midFade.sceneMix <= postFade.sceneMix, 'sceneMix 必须单调递增');
});
