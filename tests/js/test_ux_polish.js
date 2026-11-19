/* ============================================================
 * tests/js/test_ux_polish.js — UX 打磨功能单测与静态防回归守护
 *
 * 覆盖：
 *   1. core/mediaSession.js：标签标题、MediaMetadata、封面 URL 与 PositionState 夹紧
 *   2. core/progressPreview.js：进度百分比映射、时间戳推算、浮层边界夹紧
 *   3. core/playlistQueue.js：下一首插播（去重重排 + currentIndex 同步）与队列时长格式化
 *   4. app 层关键接线防回退断言（媒体会话 / 进度拖拽预览 / 队列定位撤销 / 搜索重试键盘导航）
 * ============================================================ */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    normalizeMediaArtworkUrl,
    formatDocumentTitle,
    buildMediaMetadataInit,
    clampPositionState,
} from '../../web/src/core/mediaSession.js';
import {
    calcProgressPercent,
    calcPreviewTimestampMs,
    calcTooltipLeft,
} from '../../web/src/core/progressPreview.js';
import {
    enqueueTrack,
    enqueuePlayNext,
    formatQueueTrackDuration,
} from '../../web/src/core/playlistQueue.js';
import { compileFocalCutWalls } from '../../web/src/core/visualizers/focalcut/focalcutLayout.js';
import { FocalCutDirector } from '../../web/src/core/visualizers/focalcut/focalcutCamera.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readWeb = (rel) => readFileSync(join(ROOT, 'web/src', rel), 'utf8');

describe('core/mediaSession 纯逻辑', () => {
    it('normalizeMediaArtworkUrl 过滤无效协议并补全相对路径', () => {
        assert.equal(normalizeMediaArtworkUrl('https://cdn.example.com/a.jpg'), 'https://cdn.example.com/a.jpg');
        assert.equal(normalizeMediaArtworkUrl('data:image/png;base64,AAA'), 'data:image/png;base64,AAA');
        assert.equal(normalizeMediaArtworkUrl('blob:http://localhost:8001/123'), 'blob:http://localhost:8001/123');
        assert.equal(normalizeMediaArtworkUrl('/covers/a.jpg', 'http://localhost:8001/'), 'http://localhost:8001/covers/a.jpg');
        assert.equal(normalizeMediaArtworkUrl('/covers/a.jpg'), '/covers/a.jpg');
        assert.equal(normalizeMediaArtworkUrl('  "https://cdn.example.com/b.jpg"  '), 'https://cdn.example.com/b.jpg');
        assert.equal(normalizeMediaArtworkUrl('#'), '');
        assert.equal(normalizeMediaArtworkUrl('about:blank'), '');
        assert.equal(normalizeMediaArtworkUrl('javascript:alert(1)'), '');
        assert.equal(normalizeMediaArtworkUrl(null), '');
    });

    it('formatDocumentTitle 在无曲目/占位文案时返回默认标题，有曲目时同步播放符号', () => {
        assert.equal(formatDocumentTitle('', '', true), 'Aria - 歌词播放器');
        assert.equal(formatDocumentTitle('未选择歌曲', '未知歌手', true), 'Aria - 歌词播放器');
        assert.equal(formatDocumentTitle('加载中...', '', false), 'Aria - 歌词播放器');
        assert.equal(formatDocumentTitle('夜曲', '周杰伦', true), '▶ 夜曲 - 周杰伦 · Aria');
        assert.equal(formatDocumentTitle('夜曲', '周杰伦', false), '夜曲 - 周杰伦 · Aria');
        assert.equal(formatDocumentTitle('River', '未知歌手', true), '▶ River · Aria');
    });

    it('buildMediaMetadataInit 组装标题/歌手/专辑与归一化封面', () => {
        assert.equal(buildMediaMetadataInit(null), null);
        assert.equal(buildMediaMetadataInit({ title: '加载中…' }), null);

        const meta = buildMediaMetadataInit(
            { song: '晴天', singer: '周杰伦', albumName: '叶惠美', coverUrl: '/api/cover/1' },
            { origin: 'http://localhost:8001' }
        );
        assert.deepEqual(meta, {
            title: '晴天',
            artist: '周杰伦',
            album: '叶惠美',
            artwork: [{ src: 'http://localhost:8001/api/cover/1' }],
        });

        const fallbackMeta = buildMediaMetadataInit(
            {},
            { domTitle: 'Fade', domArtist: '选择一首音乐开始播放', coverUrl: 'invalid://x' }
        );
        assert.deepEqual(fallbackMeta, {
            title: 'Fade',
            artist: 'Aria',
            album: '',
            artwork: [],
        });
    });

    it('clampPositionState 保护边界并拒绝非法总时长', () => {
        assert.equal(clampPositionState(10, 0, 1), null);
        assert.equal(clampPositionState(10, NaN, 1), null);
        assert.deepEqual(clampPositionState(-5, 240, 0), {
            duration: 240,
            playbackRate: 1,
            position: 0,
        });
        assert.deepEqual(clampPositionState(300, 240, 1.25), {
            duration: 240,
            playbackRate: 1.25,
            position: 240,
        });
        assert.deepEqual(clampPositionState(NaN, 180, -2), {
            duration: 180,
            playbackRate: 1,
            position: 0,
        });
    });
});

describe('core/progressPreview 纯逻辑', () => {
    it('calcProgressPercent 将指针坐标夹紧到 [0, 1]', () => {
        const rect = { left: 100, width: 200 };
        assert.equal(calcProgressPercent(50, rect), 0);
        assert.equal(calcProgressPercent(200, rect), 0.5);
        assert.equal(calcProgressPercent(400, rect), 1);
        assert.equal(calcProgressPercent(150, { left: 0, width: 0 }), 0);
        assert.equal(calcProgressPercent(NaN, rect), 0);
        assert.equal(calcProgressPercent(150, null), 0);
    });

    it('calcPreviewTimestampMs 按比例换算毫秒时间戳', () => {
        const rect = { left: 0, width: 400 };
        assert.equal(calcPreviewTimestampMs(100, rect, 240000), 60000);
        assert.equal(calcPreviewTimestampMs(500, rect, 240000), 240000);
        assert.equal(calcPreviewTimestampMs(100, rect, 0), 0);
        assert.equal(calcPreviewTimestampMs(100, rect, NaN), 0);
    });

    it('calcTooltipLeft 防止预览气泡在左右边缘被裁剪', () => {
        assert.equal(calcTooltipLeft(5, 1000, 32), 32);
        assert.equal(calcTooltipLeft(995, 1000, 32), 968);
        assert.equal(calcTooltipLeft(500, 1000, 32), 500);
        assert.equal(calcTooltipLeft(20, 48, 32), 20);
    });
});

describe('core/playlistQueue 下一首插播与时长格式化', () => {
    const mk = (id) => ({ source: 'qq', id, title: `Song ${id}`, artist: 'Artist' });

    it('enqueuePlayNext 将新歌插入当前曲目正后方并保持其余顺序', () => {
        const q = [mk('1'), mk('2'), mk('3')];
        const res = enqueuePlayNext(q, mk('9'), 'qq', 0);
        assert.equal(res.added, true);
        assert.equal(Boolean(res.moved), false);
        assert.equal(res.index, 1);
        assert.equal(res.currentIndex, 0);
        assert.deepEqual(q.map(x => x.id), ['1', '9', '2', '3']);
    });

    it('enqueuePlayNext 移动较晚的重复曲目到当前曲目正后方', () => {
        const q = [mk('1'), mk('2'), mk('3'), mk('4')];
        const res = enqueueTrack(q, mk('4'), '', { insertNext: true, moveIfDuplicate: true, currentIndex: 1 });
        assert.equal(res.added, false);
        assert.equal(res.moved, true);
        assert.equal(res.currentIndex, 1);
        assert.deepEqual(q.map(x => x.id), ['1', '2', '4', '3']);
    });

    it('enqueuePlayNext 移动排在当前之前的重复曲目时同步更新 currentIndex', () => {
        const q = [mk('1'), mk('2'), mk('3'), mk('4')];
        const res = enqueuePlayNext(q, mk('1'), '', 2);
        assert.equal(res.moved, true);
        assert.equal(res.currentIndex, 1);
        assert.deepEqual(q.map(x => x.id), ['2', '3', '1', '4']);
    });

    it('enqueuePlayNext 对当前正在播放或已是下一首的曲目不做无意义重排', () => {
        const q = [mk('1'), mk('2'), mk('3')];
        const curRes = enqueuePlayNext(q, mk('1'), '', 0);
        assert.equal(curRes.alreadyCurrent, true);
        assert.equal(curRes.added, false);
        assert.equal(curRes.moved, false);
        assert.deepEqual(q.map(x => x.id), ['1', '2', '3']);

        const nextRes = enqueuePlayNext(q, mk('2'), '', 0);
        assert.equal(nextRes.alreadyNext, true);
        assert.equal(nextRes.added, false);
        assert.equal(nextRes.moved, false);
        assert.deepEqual(q.map(x => x.id), ['1', '2', '3']);
    });

    it('formatQueueTrackDuration 兼容秒与网易毫秒级时长（含入队归一化后的 dt）并忽略无效值', () => {
        assert.equal(formatQueueTrackDuration({ duration: 215 }), '03:35');
        assert.equal(formatQueueTrackDuration({ duration: 245000 }), '04:05');
        const q = [mk('1')];
        const res = enqueuePlayNext(q, { source: 'netease', id: '888', name: '网易单曲', dt: 185000 }, 'netease', 0);
        assert.equal(formatQueueTrackDuration(res.track), '03:05');
        assert.equal(formatQueueTrackDuration({ duration: 0 }), '');
        assert.equal(formatQueueTrackDuration({ duration: NaN }), '');
        assert.equal(formatQueueTrackDuration(null), '');
    });
});

describe('UX 关键接线防回归断言', () => {
    it('310-media-session.js 注册标准媒体键并避让接管态', () => {
        const src = readWeb('app/310-media-session.js');
        assert.match(src, /navigator\.mediaSession/);
        assert.match(src, /Aria\.__npActive\(\)/);
        for (const action of ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto', 'seekbackward', 'seekforward']) {
            assert.match(src, new RegExp(`'${action}'`));
        }
        assert.match(src, /document\.title\s*=\s*nextDocTitle/);
    });

    it('245-playlist-manager.js 具备当前定位、15s 撤销清空与 enqueuePlayNextTrack', () => {
        const src = readWeb('app/245-playlist-manager.js');
        assert.match(src, /id\s*=\s*['"]plmLocate['"]/);
        assert.match(src, /now-playing-active/);
        assert.match(src, /plmUndoClearBtn/);
        assert.match(src, /Aria\.enqueuePlayNextTrack\s*=/);
        assert.match(src, /plm-dur/);
    });

    it('70-audio-engine.js 与 220-shortcuts-viewmode.js 接入统一进度拖拽预览', () => {
        const engine = readWeb('app/70-audio-engine.js');
        assert.match(engine, /core\/progressPreview\.js/);
        assert.match(engine, /mousedown/);
        assert.match(engine, /mousemove/);

        const vm = readWeb('app/220-shortcuts-viewmode.js');
        assert.match(vm, /core\/progressPreview\.js/);
        assert.match(vm, /bottomProgressTrack/);
        assert.match(vm, /Aria\.__npActive\(\)/);
    });

    it('150-search-engine.js 与 157-search-history.js 提供空态/失败重试与键盘联想导航', () => {
        const searchSrc = readWeb('app/150-search-engine.js');
        assert.match(searchSrc, /search-feedback-card/);
        assert.match(searchSrc, /id="searchRetryBtn"/);
        assert.match(searchSrc, /enqueuePlayNextTrack/);

        const histSrc = readWeb('app/157-search-history.js');
        assert.match(histSrc, /ArrowDown/);
        assert.match(histSrc, /ArrowUp/);
        assert.match(histSrc, /isComposing/);
        assert.match(histSrc, /is-kb-active/);
    });

    it('310 从 56-playback-misc 导入 getDuration 且 175 静默预加载取链失败不调度前台重试', () => {
        const ms = readWeb('app/310-media-session.js');
        assert.match(ms, /import\s*\{\s*getDuration\s*\}\s*from\s*'\.\/56-playback-misc\.js'/);

        const online = readWeb('app/175-track-index-online.js');
        assert.match(
            online,
            /if\s*\(!playUrl\)\s*\{[\s\S]{0,400}if\s*\(preloadOnly\)\s*\{\s*preloadedSongReady\s*=\s*null;\s*return;\s*\}[\s\S]{0,400}markResolveFailed\(\)[\s\S]{0,400}handlePlayFailure\(/,
        );
    });

    it('selfhost-settings 参数配置使用 .setting-dropdown 而非原生 <select>，且与 sections/hints 共用毛玻璃风格', () => {
        const shSrc = readWeb('app/selfhost-settings.js');
        assert.match(shSrc, /import\s*\{\s*mountDropdown\s*\}\s*from\s*'\.\.\/ui\/settingsPrimitives\.js'/);
        assert.doesNotMatch(shSrc, /createElement\s*\(\s*['"]select['"]\s*\)/);
        assert.match(shSrc, /setting-dropdown\s+selfhost-option-dropdown/);

        const glassRe = /rgba\(14,\s*16,\s*22,\s*0\.44\)[\s\S]{0,220}blur\(20px\)\s+saturate\(150%\)/;
        const frostedGlassRe = /rgba\(14,\s*16,\s*22,\s*0\.4[246]\)[\s\S]{0,260}blur\(2[068]px\)\s+saturate\(1[578][05]%\)/;
        const baseCss = readWeb('styles/base.css');
        const appCss = readWeb('styles/appearance.css');
        const modCss = readWeb('styles/modals.css');
        const playerCss = readWeb('styles/player.css');
        const diagCss = readWeb('styles/diagnostics.css');
        const posterCss = readWeb('styles/poster.css');
        const rankCss = readWeb('styles/rankings.css');

        assert.match(baseCss.match(/^[ \t]*\.top-action-buttons\s*\{[^}]+\}/m)?.[0] || '', frostedGlassRe);
        assert.match(baseCss.match(/^[ \t]*\.empty-hint\s*\{[^}]+\}/m)?.[0] || '', glassRe);
        assert.match(appCss.match(/^\.ws-header::before\s*\{[^}]+\}/m)?.[0] || '', frostedGlassRe);
        assert.match(appCss.match(/^\.ws-mode-popover\s*\{[^}]+\}/m)?.[0] || '', frostedGlassRe);
        assert.match(modCss.match(/^[ \t]*\.settings-group::before\s*\{[^}]+\}/m)?.[0] || '', frostedGlassRe);
        assert.match(modCss.match(/^[ \t]*\.setting-dropdown-menu\s*\{[^}]+\}/m)?.[0] || '', frostedGlassRe);
        assert.match(modCss.match(/^[ \t]*\.settings-group\s+\.setting-dropdown-menu\s*\{[^}]+\}/m)?.[0] || '', /rgba\(14,\s*16,\s*22,\s*0\.46\)/);
        assert.match(playerCss.match(/^[ \t]*\.bottom-control-bar\s*\{[^}]+\}/m)?.[0] || '', frostedGlassRe);

        const glassJs = readWeb('app/210-color-multilang.js');
        assert.match(glassJs, /\.settings-overlay::before/);
        assert.doesNotMatch(glassJs, /\.settings-panel,\s*\.setting-dropdown-menu/);
        assert.match(modCss.match(/^[ \t]*\.status-hint\s*\{[^}]+\}/m)?.[0] || '', glassRe);
        assert.match(modCss, /\.status-hint:empty\s*\{\s*display:\s*none;/);
        assert.match(modCss, /\.setting-row:has\(\.setting-dropdown\.open\)/);
        assert.match(modCss, /\.selfhost-option-dropdown/);
        assert.match(modCss.match(/^[ \t]*\.lyric-source-hint\s*\{[^}]+\}/m)?.[0] || '', glassRe);
        assert.match(modCss.match(/^[ \t]*\.ps-hint\s*\{[^}]+\}/m)?.[0] || '', glassRe);
        assert.match(modCss.match(/^[ \t]*\.lyric-download-format-section\s*\{[^}]+\}/m)?.[0] || '', glassRe);
        assert.match(modCss.match(/^[ \t]*\.rec-status-bar\s*\{[^}]+\}/m)?.[0] || '', glassRe);
        assert.match(diagCss.match(/^html#ariaRoot \.diag-section\s*\{[^}]+\}/m)?.[0] || '', glassRe);
        assert.match(diagCss.match(/^html#ariaRoot \.diag-hint\s*\{[^}]+\}/m)?.[0] || '', glassRe);
        assert.match(posterCss.match(/^\.lp-section\s*\{[^}]+\}/m)?.[0] || '', glassRe);
        assert.match(rankCss.match(/^\.stats-block\s*\{[^}]+\}/m)?.[0] || '', glassRe);
    });

    it('282-zen-mode 与 zen.css 不再用 position:fixed 逃逸，而是收缩 .top-action-buttons 并将 #zenModeBtn 置最右且可点回', () => {
        const zenJs = readWeb('app/282-zen-mode.js');
        const zenCss = readWeb('styles/zen.css');
        const baseCss = readWeb('styles/base.css');

        assert.doesNotMatch(zenJs, /position\s*=\s*['"]fixed['"]/);
        assert.match(zenJs, /animateTopBarTransition/);
        assert.match(zenJs, /clearTopBarAnimStyles/);
        assert.match(zenCss, /\.top-action-buttons\s*>\s*\*:not\(#zenModeBtn\)[\s\S]*display:\s*none\s*!important/);
        assert.match(zenCss, /\.top-action-buttons\s+#zenModeBtn\s*\{[\s\S]*order:\s*999/);
        assert.match(zenCss, /@media\s*\(max-width:\s*700px\)[\s\S]*\.top-action-buttons[\s\S]*left:\s*auto\s*!important/);
        assert.match(baseCss.match(/^[ \t]*\.icon-action-btn\s*\{[^}]+\}/m)?.[0] || '', /flex-shrink:\s*0/);
    });

    it('FocalCut 重构后具备均衡字号、段内零极性频闪、受控景别与双层 clip-path 光学扫字', () => {
        const lines = [
            { start: 1000, end: 4200, original: '在星光倾泻的午夜街头', trans: 'Starlight' },
            { start: 4400, end: 7600, original: '一瞬间光影把你我温柔定格', trans: 'Framed' },
            { start: 7800, end: 11000, original: '镜头越过沉默的旧时光', trans: 'Lens' },
        ];
        const { walls } = compileFocalCutWalls(lines, { emotion_words: ['星光', '一瞬间'] });
        assert.ok(walls.length >= 1);
        assert.equal(walls[0].polarity, 'dark', '首墙必须稳定以曜石暗房开场');
        assert.ok(walls[0].watermarkGlyph.length >= 1, '展墙需生成远景水印字形');
        for (const ln of walls[0].lines) {
            assert.ok(ln.fontSize >= 46, `行字号过小: ${ln.fontSize}`);
            assert.ok(ln.weight >= 800, `副行字重不得退回纤细 300: ${ln.weight}`);
        }

        const dir = new FocalCutDirector();
        const wall = walls[0];
        const seenPolarities = new Set();
        for (let step = 0; step < 12; step++) {
            const ln = wall.lines[step % wall.lines.length];
            const u = ln.units.find(x => !x.isSpace) || ln.units[0];
            const res = dir.step({
                wall,
                activeLine: ln,
                activeUnit: u,
                timeMs: u.start + 100,
                nowPerf: 1000 + step * 2200,
                vw: 1280,
                vh: 720,
                settings: { focalcutCutRate: 'normal', focalcutSplitLens: true, focalcutCamera: 1.0 },
            });
            seenPolarities.add(res.polarity);
            assert.ok(res.primary.zoom <= 1.65, `主视口缩放越界: ${res.primary.zoom}`);
            assert.ok(Math.abs(res.primary.rotZ) <= 2.5, `主视口 Z 轴歪斜过大: ${res.primary.rotZ}`);
        }
        assert.equal(seenPolarities.size, 1, '同一面展墙内不得频闪翻转明暗极性');

        const fcCss = readWeb('styles/focalcut.css');
        assert.doesNotMatch(fcCss, /-webkit-text-stroke/, '不得使用锯齿描边 -webkit-text-stroke');
        assert.match(fcCss, /clip-path:\s*inset\(0\s+calc\(100%\s*-\s*var\(--fc-p/);
        assert.match(fcCss, /\.fc-anamorphic-slit/);
        assert.match(fcCss, /\.fc-stage\.is-split\s+\.fc-subtitles/);
        assert.match(fcCss, /html#ariaRoot\.is-software-renderer/);
    });

    it('模式选择卡除默认/拾光外全部 12 种视觉模式均采用对应新封面结构', () => {
        const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
        // 默认模式 & 拾光模式原封不动
        assert.match(html, /view-mode-mock-disc/);
        assert.match(html, /view-mode-mock-bottom-bar/);
        // 其余 12 个模式的新封面结构标记
        for (const marker of [
            'vm-flyin-chars',
            'vm-wc-focus',
            'vm-sonnet-svg',
            'vm-tempera-svg',
            'vm-m-grid',
            'vm-dim-svg',
            'vm-dim-depth-front',
            'vm-jz-svg',
            'vm-astro-svg',
            'vm-prism-svg',
            'vm-vitrail-svg',
            'vmVitWall',
            'vm-fc-split-pane',
            'vm-lp-seal',
        ]) {
            assert.ok(html.includes(marker), `index.html 缺少重绘封面结构标记: ${marker}`);
        }
    });

    it('后台切回前台稳健恢复：visible 清 _occluded、核心渲染仅在 TIER_HIDDEN 暂停、切回重置 activeLineIndex 与视口', () => {
        const bgCore = readWeb('core/backgroundThrottle.js');
        assert.match(bgCore, /if\s*\(doc\s*&&\s*doc\.hidden\s*===\s*false\)\s*\{[\s\S]{0,80}_occluded\s*=\s*false/);
        assert.match(bgCore, /pageshow/);
        assert.match(bgCore, /onUserWake/);

        const bgApp = readWeb('app/287-bg-throttle.js');
        assert.match(bgApp, /id:\s*'lyricsLoop'[\s\S]{0,60}tier:\s*TIER_HIDDEN/);
        assert.match(bgApp, /id:\s*'activeVisualizer'[\s\S]{0,60}tier:\s*TIER_HIDDEN/);
        assert.match(bgApp, /snapLyricsWaveOnResume/);

        const audioJs = readWeb('app/70-audio-engine.js');
        assert.match(audioJs, /activeLineIndex\s*=\s*-1/);
        assert.match(audioJs, /handleResize/);
    });

    it('词云重构具备星图连线 SVG、纯 GPU scale 运镜、景深分级与 0x0 窗口保护', () => {
        const wcLayout = readWeb('app/56-playback-misc.js');
        const wcCam = readWeb('app/57-wordcloud-camera.js');
        assert.match(wcLayout, /wcConstellation/);
        assert.match(wcLayout, /wc-constellation-svg/);
        assert.match(wcLayout, /wc-thread/);
        assert.match(wcCam, /z\.style\.transform\s*=\s*`scale\(/);
        assert.match(wcCam, /function\s+snapLyricsWaveOnResume/);
        assert.match(wcCam, /viewW\s*<\s*40\s*\|\|\s*viewH\s*<\s*40/);
        assert.match(wcCam, /dataset\.wcDepth/);
    });

    it('活字模式背景字块矩阵监听容器尺寸变化并自适应网格列行缩放', () => {
        const lpSrc = readWeb('core/visualizers/LetterpressVisualizer.js');
        assert.match(lpSrc, /ResizeObserver/);
        assert.match(lpSrc, /onResize\s*\(/);
        assert.match(lpSrc, /gridTemplateColumns\s*=\s*`repeat\(\$\{cols\},\s*1fr\)`/);
        assert.match(lpSrc, /gridTemplateRows\s*=\s*`repeat\(\$\{rows\},\s*1fr\)`/);
    });

    it('消除全模式概率卡顿与飞入模式切后台后字号变小/双行残留', () => {
        const emJs = readWeb('app/306-energy-motion.js');
        assert.doesNotMatch(emJs, /document\.documentElement\.style\.setProperty\(['"]--aria-energy/);
        assert.match(emJs, /getActiveEnergyTarget/);

        const baseCss = readWeb('styles/base.css');
        assert.match(baseCss, /body\.vis-opaque-bg:not\(\.mv-bg-on\)\s+\.blur-background/);

        const vmJs = readWeb('app/220-shortcuts-viewmode.js');
        assert.match(vmJs, /classList\.toggle\('vis-opaque-bg'/);

        const wcJs = readWeb('app/57-wordcloud-camera.js');
        assert.match(wcJs, /function\s+clearStaleActiveLines/);
        assert.match(wcJs, /if\s*\(isDedicatedVisMode\)\s*\{[\s\S]{0,120}stopLyricsFxLoop\(\)/);

        const audioJs = readWeb('app/70-audio-engine.js');
        assert.match(audioJs, /if\s*\(isLyricsLoopRunning\)\s*return;/);
        assert.match(audioJs, /clearStaleActiveLines\(-1\)/);

        const miscJs = readWeb('app/56-playback-misc.js');
        assert.match(miscJs, /function\s+flyinAutoScaleFont\s*\(targetLineEl\s*=\s*null\)/);
        assert.match(miscJs, /viewW\s*<\s*80\s*\|\|\s*viewH\s*<\s*80/);

        const dtkJs = readWeb('app/250-desktop-lyrics.js');
        assert.match(dtkJs, /BroadcastChannel\('aria_dtk_sync'\)/);
    });
});
