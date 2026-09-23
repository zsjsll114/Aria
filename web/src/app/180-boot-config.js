/* ============================================================
 * 180-boot-config.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 8210-8840 行 | 单元数: 21
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { AI_PROVIDERS, EQ_STORAGE_KEY, FAV_STORAGE_KEY, PERF_STORAGE_KEY, PLAYLIST_STORAGE_KEY, SETTINGS_STORAGE_KEY } from '../config/constants.js';
import { DEFAULT_SETTINGS, DEFAULT_SONG } from '../config/defaults.js';
import { PERFORMANCE_PROFILES } from './10-config-state.js';
import { audio } from './20-lyrics-render.js';
import { sourceBtns } from './30-dom-refs.js';
import { handleAudioPlayError } from './70-audio-engine.js';
import { getFavorites } from './120-search-results.js';
import { getPlaylists } from './130-playlists.js';
import { applyVolumeOnSongChange, loadPlaylistTrack } from './135-crossfade.js';
import { lyricSourceProbeCache } from './170-lyric-sources.js';
import { initPlayer, loadOnlineSong, pickInitialTrackSelection } from './175-track-index-online.js';
import { autoKugouCheckinOnce, dayRecommend, selfhostEnabled, updateSelfHostBadge } from './selfhost-runtime.js';
import { applyAllSettings } from './190-settings-fontsize.js';
import { initSettingsPanel, initAboutLinks } from './200-settings-panel.js';
import { initCustomFonts } from './215-multilang-fonts.js';
import { wordcloudApplyPerf } from './57-wordcloud-camera.js';
import { setLanguage } from '../core/i18n.js';
import { logInfo, logWarn, logError } from '../services/log.js';

/* ★ 开篇歌单（刚进入应用播放的歌单，装进播放队列的那一份）：
   优先 三平台日推合并（QQ → 酷狗 → 网易云，登录且有日推才会返回）；
   无日推 → 各平台热歌榜前 30 首合并（258 提供）；
   都拿不到 → 返回 null（交给原逻辑：收藏/歌单/默认曲）。
   ★ 音源顺序按用户要求：QQ 优先 → 酷狗 → 网易云；
     **未启用自建 vendor 的平台往后延**（稳定排序，组内仍保持该次序）。
     注：dayRecommend 本身依赖自建服务，没启用的平台本来也拿不到数据。 */
const START_QUEUE_SRC_ORDER = ['qq', 'kugou', 'netease'];

function orderedStartQueueSources() {
    const enabled = (src) => {
        try { return !!(typeof selfhostEnabled === 'function' && selfhostEnabled(src)); }
        catch { return false; }
    };
    return [...START_QUEUE_SRC_ORDER].sort((a, b) => (enabled(b) ? 1 : 0) - (enabled(a) ? 1 : 0));
}

async function pickPlatformStartQueue() {
    const dRes = await Promise.all(
        orderedStartQueueSources().map(src => dayRecommend(src)
            .then(r => ({ src, r }))
            .catch(e => ({ src, r: { ok: false, err: (e && e.message) || 'fail' } })))
    );
    const daily = [];
    for (const { src, r } of dRes) {
        if (r && r.ok && Array.isArray(r.list) && r.list.length) {
            for (const s of r.list) daily.push(s);
        }
    }
    if (daily.length) {
        const playlist = daily.map(s => ({
            url: null, title: s.name || '', artist: s.singer || '', cover: s.cover || '',
            source: s.source || '', id: s.id, mid: s.mid || '', key: (s.source || '') + '_' + (s.id || '')
        }));
        /* ★ 开篇随机选曲（用户要求）：~120 首聚合池每次进软件随机起一首，不再固定第一首 */
        return { tag: 'daily', playlist, trackIndex: Math.floor(Math.random() * playlist.length) };
    }
    /* 未登录/无日推：热歌榜前 30 合并 */
    if (typeof Aria !== 'undefined' && typeof Aria.__fetchHotBoardQueue === 'function') {
        try {
            const hot = await Aria.__fetchHotBoardQueue(30);
            if (Array.isArray(hot) && hot.length) {
                return { tag: 'hot', playlist: hot, trackIndex: Math.floor(Math.random() * hot.length) };
            }
        } catch (e) { logWarn('bootConfig', '热歌榜开篇队列失败:', e); }
    }
    return null;
}

/* 预加载默认歌曲：在用户点击公告前就获取 URL、歌词、封面并加载音频，但不播放 */
async function preloadDefaultSong() {
            if (initSongStarted) return;
            initSongStarted = true;
            preloadedSongReady = false;  /* 标记为加载中 */
            try {
                /* ★ 开篇歌单 = 平台内容（日推合并 → 热歌榜前30合并），空才走收藏/歌单/默认曲 */
                const plat = await pickPlatformStartQueue();
                if (plat) {
                    playlist = plat.playlist;
                    currentTrackIndex = plat.trackIndex;
                    await loadPlaylistTrack(plat.trackIndex, true);  /* preloadOnly=true */
                    logInfo('bootConfig', `开篇歌单：${plat.tag === 'daily' ? '三平台日推' : '各平台热歌榜'}（${plat.playlist.length} 首）`);
                    return;
                }
                const initialSel = pickInitialTrackSelection();
                if (!initialSel.isDefault && initialSel.playlist.length > 0) {
                    playlist = initialSel.playlist;
                    currentTrackIndex = initialSel.trackIndex;
                    await loadPlaylistTrack(initialSel.trackIndex, true);  /* preloadOnly=true */
                    return;
                }
                /* 无收藏/歌单，加载硬编码默认歌曲 */
                currentSource = DEFAULT_SONG.source;
                sourceBtns.forEach(b => b.classList.toggle('active', b.dataset.source === DEFAULT_SONG.source));
                await loadOnlineSong(DEFAULT_SONG, false, false, true);  /* preloadOnly=true */
            } catch (e) {
                logError('bootConfig', '预加载失败:', e);
                preloadedSongReady = null;  /* 标记为失败 */
            }
        }

async function initDefaultSong() {
            /* 如果预加载已启动，不再重复初始化 */
            if (initSongStarted) return;
            initSongStarted = true;
            /* ★ 开篇歌单 = 平台内容（日推合并 → 热歌榜前30合并），空才走收藏/歌单/默认曲 */
            const plat = await pickPlatformStartQueue();
            if (plat) {
                playlist = plat.playlist;
                currentTrackIndex = plat.trackIndex;
                await loadPlaylistTrack(plat.trackIndex);
                logInfo('bootConfig', `开篇歌单：${plat.tag === 'daily' ? '三平台日推' : '各平台热歌榜'}（${plat.playlist.length} 首）`);
                return;
            }
            const initialSel = pickInitialTrackSelection();
            if (!initialSel.isDefault && initialSel.playlist.length > 0) {
                playlist = initialSel.playlist;
                currentTrackIndex = initialSel.trackIndex;
                await loadPlaylistTrack(initialSel.trackIndex);
                return;
            }
            /* 无收藏/歌单，播放硬编码默认歌曲 */
            currentSource = DEFAULT_SONG.source;
            sourceBtns.forEach(b => b.classList.toggle('active', b.dataset.source === DEFAULT_SONG.source));
            await loadOnlineSong(DEFAULT_SONG);
        }

globalThis.previewEngineInstance = null;

/* 提前声明，避免 initSettingsPanel 内部访问时触发 TDZ */
async function bootApp() {
            try {
                const loaded = await loadConfigFromBackend();
                if (loaded) {
                    loadSettings();
                }
            } catch(e) {
                logWarn('bootConfig', 'Backend config load fallback:', e);
            }
            try { loadSettings(); } catch(e) { logError('bootConfig', 'loadSettings error:', e); }
            /* 自动检测性能并应用配置（首次访问时） */
            autoDetectAndApplyPerformance(true).then(result => {
                if (result && result.auto) {
                    /* 首次自动检测，显示对话框 */
                    showPerformanceDialog(result);
                    /* 重新应用设置 */
                    applyAllSettings();
                }
            }).catch(e => logWarn('bootConfig', '自动性能检测跳过:', e));
            try { applyAllSettings(); } catch(e) { logError('bootConfig', 'applyAllSettings error:', e); }
            try { initPlayer(); } catch(e) { logError('bootConfig', 'initPlayer error:', e); }
            try { initSettingsPanel(); } catch(e) { logError('bootConfig', 'initSettingsPanel error:', e); }
            /* 设置 → 关于：作者链接呼出系统浏览器（Tauri opener / 网页回退） */
            try { initAboutLinks(); } catch(e) { logWarn('bootConfig', 'initAboutLinks 跳过:', e); }
            /* ★ 性能（2026-09-20）：自定义字体同步（IndexedDB 全量 + /api/font/list 逐个
               fetch+FontFace 解析，仓库内置字体约 100MB）挪出启动关键路径——低端机冷启动
               少几十次大 buffer 解析卡顿；延迟到浏览器空闲时执行，字体下拉打开前必然就绪
               （下拉展示本就晚于设置面板首次交互，且 family 缺失时 CSS 回退链无缝兜底） */
            const scheduleFontInit = (fn) => (typeof requestIdleCallback === 'function')
                ? requestIdleCallback(fn, { timeout: 4000 })
                : setTimeout(fn, 1500);
            try { scheduleFontInit(() => { try { initCustomFonts(); } catch(e) { logError('bootConfig', 'initCustomFonts error:', e); } }); } catch(e) { logError('bootConfig', 'initCustomFonts schedule error:', e); }
            /* 打开应用即自动签到酷狗 VIP（静默；启用+已登录+今日未签才触发） */
            try { autoKugouCheckinOnce(); } catch(e) { logWarn('bootConfig', '启动签到跳过:', e); }
            /* 右上角「自建服务」入口：更新未登录角标 */
            try { updateSelfHostBadge(); } catch(e) { logWarn('bootConfig', 'badge 跳过:', e); }
            /* 在用户阅读公告期间就开始预加载第一首歌（获取URL、歌词、封面，加载音频但不播放） */
            try { preloadDefaultSong(); } catch(e) { logError('bootConfig', 'preloadDefaultSong error:', e); }
            /* 启动时自动同步当前完整配置到本地 user_config.json */
            setTimeout(() => {
                if (typeof syncConfigToBackend === 'function') syncConfigToBackend();
            }, 1000);

            const welcomeOverlay = typeof document !== 'undefined' ? document.getElementById('welcomeOverlay') : null;
            const welcomeBtn = typeof document !== 'undefined' ? document.getElementById('welcomeBtn') : null;
            
            const handleWelcomeEnter = (e) => {
                if (e && e.stopPropagation) e.stopPropagation();
                if (welcomeOverlay) {
                    welcomeOverlay.classList.add('hidden');
                    setTimeout(() => {
                        try { welcomeOverlay.remove(); } catch(err) {}
                    }, 400);
                }
                /* 用户手势已触发，安全激活 Web Audio Context 并播放音频 */
                if (typeof audioCtx !== 'undefined' && audioCtx && audioCtx.state === 'suspended') {
                    try { audioCtx.resume(); } catch(e) {}
                }
                if (preloadedSongReady === true) {
                    /* 预加载已就绪：直接播放，秒开 */
                    if (audio) {
                        audio.play().then(() => {
                            retryCount = 0;
                            applyVolumeOnSongChange();
                            /* AI 智能分析 + 高潮检测（立即触发，不改原行为；见 triggerPostLoadTasks） */
                            if (typeof triggerPostLoadTasks === 'function') triggerPostLoadTasks({ refill: false });
                        }).catch(err => {
                            handleAudioPlayError();
                            logError('bootConfig', '预加载后播放失败:', err);
                        });
                    }
                } else if (preloadedSongReady === false) {
                    /* 预加载仍在进行中：标记待播放，加载完成后自动播放 */
                    pendingPlayAfterPreload = true;
                } else {
                    /* 预加载未开始或失败：回退到正常初始化 */
                    initSongStarted = false;  /* 重置标志，允许 initDefaultSong 执行 */
                    initDefaultSong();
                }
            };

            welcomeBtn?.addEventListener('click', handleWelcomeEnter);
            welcomeOverlay?.addEventListener('click', (e) => {
                if (e.target === welcomeOverlay || e.target.closest('.welcome-card')) {
                    handleWelcomeEnter(e);
                }
            });
        }

if (typeof document !== 'undefined') {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', bootApp);
            } else {
                bootApp();
            }
        }

/* ========== 设置系统 ========== */
/* ========== 硬件检测与性能优化 ========== */
/* 性能等级配置 */
/* PERFORMANCE_PROFILES 已提升至顶部 */
/* 检测硬件信息 */
/* ★ GPU 名称清洗（2026-09-22 用户反馈「不要显示别名」）：
   WebGL 原始 renderer 是 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Ti Laptop D3D11)'
   这类包装串——取 ANGLE 括号内第二段（真实显卡名）、剥掉尾部图形 API 后缀与
   PCI 设备 ID，得到 'NVIDIA GeForce RTX 5070 Ti Laptop' 干净名。 */
function cleanGpuName(raw) {
    if (!raw) return null;
    let s = String(raw).trim();
    const angle = /^ANGLE\s*\((.+)\)\s*$/i.exec(s);
    if (angle) {
        const parts = angle[1].split(',').map(p => p.trim());
        s = (parts.length >= 2) ? parts[1] : parts[0];
    }
    /* 尾部图形 API 后缀（含 Direct3D12 vs_5_0 ps_5_0 shader profile 组合） */
    s = s.replace(/\s+(vs_\d+_\d+\s+ps_\d+_\d+)\s*/gi, ' ');
    s = s.replace(/\s*(D3D1[01]|Direct3D\s*\d+(\s+vs_\d+_\d+\s+ps_\d+_\d+)?|Vulkan(\.\d+)*|OpenGL(\.\d+)*|Metal(\.\d+)*)\s*$/i, '');
    /* PCI 设备 ID（0x + 4~12 位十六进制） */
    s = s.replace(/\s*\((0x)?[0-9a-fA-F]{4,12}\)\s*/g, ' ');
    s = s.replace(/\s{2,}/g, ' ').trim();
    return s || String(raw);
}

async function detectHardware() {
            const hw = {
                memory: (typeof navigator !== 'undefined' && navigator.deviceMemory) || 4,
                cpuCores: (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4,
                gpu: null,
                gpuTier: 'unknown',
                isLowPower: false,
                screenResolution: (typeof window !== 'undefined' && window.screen) ? (window.screen.width * window.screen.height) : (1920 * 1080),
                pixelRatio: (typeof window !== 'undefined' && window.devicePixelRatio) || 1
            };

            /* GPU 检测 */
            let hasWebgl = false;
            try {
                const canvas = document.createElement('canvas');
                const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
                hasWebgl = !!gl;
                if (gl) {
                    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
                    if (debugInfo) {
                        const rawGpu = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
                        hw.gpuRaw = String(rawGpu || '');
                        hw.gpu = cleanGpuName(rawGpu) || hw.gpuRaw;
                        const gpuLower = hw.gpuRaw.toLowerCase();
                        /* 检测低端 GPU（含虚拟机与集成显卡） */
                        const lowEndGPUs = [
                            'intel', 'hd graphics', 'basic', 'microsoft', 'software',
                            'swiftshader', 'llvmpipe', 'vmware', 'virtualbox', 'vbox',
                            'qemu', 'parallels', 'svga', 'mesa', 'softpipe', 'gdi generic'
                        ];
                        hw.isLowPower = lowEndGPUs.some(g => gpuLower.includes(g));
                        /* 检测高端 GPU */
                        const highEndGPUs = ['nvidia', 'rtx', 'gtx 16', 'gtx 10', 'amd', 'radeon rx'];
                        const isHighEnd = highEndGPUs.some(g => gpuLower.includes(g)) && !hw.isLowPower;
                        hw.gpuTier = isHighEnd ? 'high' : hw.isLowPower ? 'low' : 'medium';
                        /* ★ 软件渲染/虚拟机识别：WebGL 正常但走软件光栅化或虚拟显卡 */
                        const softwareRenderers = [
                            'software', 'swiftshader', 'llvmpipe', 'microsoft basic', 'basic render',
                            'vmware', 'virtualbox', 'vbox', 'qemu', 'parallels', 'svga', 'softpipe', 'gdi generic'
                        ];
                        if (softwareRenderers.some(s => gpuLower.includes(s))) {
                            hw.isSoftwareRenderer = true;
                            hw.isLowPower = true;
                        }
                    }
                }
            } catch (e) {
                logWarn('bootConfig', 'GPU 检测失败:', e);
            }
            hw.hasWebgl = hasWebgl;
            /* ★ 无 WebGL / 纯软件渲染 → 视为无 GPU 设备，强制拉低档位 */
            hw.isSoftwareRenderer = hw.isSoftwareRenderer || !hasWebgl;
            if (!hasWebgl) {
                hw.isLowPower = true;
                hw.gpuTier = 'low';
            }

            /* 根据综合指标判断性能等级 */
            let score = 0;
            score += hw.memory >= 8 ? 3 : hw.memory >= 4 ? 2 : 1;
            score += hw.cpuCores >= 8 ? 3 : hw.cpuCores >= 4 ? 2 : 1;
            /* ★ WebGL 存在但拿不到显卡名（debugInfo 被禁）：不能当低端扣分，按中等处理 */
            score += hw.gpuTier === 'high' ? 3 : (hw.gpuTier === 'medium' || hw.gpuTier === 'unknown') ? 2 : 1;
            score += hw.screenResolution > 1920 * 1080 ? 0 : 1; /* 高分辨率减分 */
            score += hw.pixelRatio > 1 ? 0 : 1; /* 高DPI减分 */

            /* ★ 无 GPU（WebGL 缺失或软件渲染）：所有视觉模式全靠 CPU 合成，强制不高于 low */
            if (hw.isSoftwareRenderer) {
                score = Math.min(score, 4);
                if (typeof window !== 'undefined') window.__isSoftwareRenderer = true;
                if (typeof document !== 'undefined' && document.documentElement) {
                    document.documentElement.classList.add('is-software-renderer');
                }
            }

            hw.performanceScore = score;
            hw.recommendedProfile = score >= 8 ? 'high' : score >= 6 ? 'medium' : score >= 4 ? 'low' : 'minimal';

            return hw;
        }

/* 快速性能测试（实际渲染测试） */
async function runPerformanceTest() {
            return new Promise((resolve) => {
                const startTime = performance.now();
                let frames = 0;
                const testDuration = 500; /* 测试 500ms */

                function testFrame() {
                    frames++;
                    const elapsed = performance.now() - startTime;
                    if (elapsed < testDuration) {
                        requestAnimationFrame(testFrame);
                    } else {
                        const fps = (frames / elapsed) * 1000;
                        resolve(fps);
                    }
                }
                requestAnimationFrame(testFrame);
            });
        }

/* ★ 渲染压力测试：模拟各歌词样式共用的高开销合成（backdrop-blur + 大量 transform/text-shadow/blur 卡片）。
   词云/飞入/PV/浮空/和鸣/隧道的本质消耗都是「多层模糊+阴影+逐帧 transform」，
   用一次真实合成压力短测把软件渲染/无 GPU 机器暴露出来，覆盖全部样式场景。 */
async function runRenderStressTest() {
            return new Promise((resolve) => {
                if (typeof document === 'undefined') return resolve(60);
                const probe = document.createElement('div');
                probe.style.cssText = 'position:fixed;inset:-40px;z-index:-9999;backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);pointer-events:none;opacity:0.01;';
                document.body.appendChild(probe);

                const cards = [];
                for (let i = 0; i < 48; i++) {
                    const c = document.createElement('div');
                    c.style.cssText = `position:fixed;left:${((i % 8) * 13)}%;top:${Math.floor(i / 8) * 14}%;width:11%;height:12%;border-radius:10px;` +
                        `background:rgba(255,255,255,0.02);filter:blur(${i % 3}px);text-shadow:0 0 ${(i % 4) * 6}px rgba(255,255,255,0.5);` +
                        `transform:translate3d(0,0,0);transition:none;will-change:transform;`;
                    document.body.appendChild(c);
                    cards.push(c);
                }

                const startTime = performance.now();
                let frames = 0;
                const testDuration = 400; /* 400ms 压力合成 */

                function frame() {
                    frames++;
                    for (let i = 0; i < cards.length; i++) {
                        cards[i].style.transform = `translate3d(${(Math.sin((frames + i) * 0.03) * 22).toFixed(1)}px,0,0)`;
                    }
                    const elapsed = performance.now() - startTime;
                    if (elapsed < testDuration) {
                        requestAnimationFrame(frame);
                    } else {
                        cards.forEach(c => c.remove());
                        probe.remove();
                        resolve((frames / elapsed) * 1000);
                    }
                }
                requestAnimationFrame(frame);
            });
        }

/* 获取保存的性能配置 */
function getPerformanceSettings() {
            try {
                const raw = localStorage.getItem(PERF_STORAGE_KEY);
                if (raw) return JSON.parse(raw);
            } catch (e) {}
            return null;
        }

/* 保存性能配置 */
function savePerformanceSettings(settings) {
            try {
                localStorage.setItem(PERF_STORAGE_KEY, JSON.stringify(settings));
            } catch (e) {}
        }

/* ========== 「视觉开销」手动覆盖（设置面板微调项，在所选档位 vfx 矩阵上叠加） ========== */
const PERF_VFX_KEY = 'perf_vfx_overrides_v1';

function getVfxOverrides() {
            try {
                const raw = localStorage.getItem(PERF_VFX_KEY);
                if (raw) return JSON.parse(raw) || {};
            } catch (e) {}
            return {};
        }

function setVfxOverride(key, value) {
            const cur = getVfxOverrides();
            cur[key] = value;
            try {
                localStorage.setItem(PERF_VFX_KEY, JSON.stringify(cur));
            } catch (e) {}
            return cur;
        }

/* 重建/读取当前生效的视觉效果矩阵（档位 vfx + 用户手动覆盖），供引擎与全局读取 */
function getPerfVfx() {
            const saved = getPerformanceSettings();
            const prof = (saved && saved.profile && PERFORMANCE_PROFILES[saved.profile]) || null;
            return Object.assign({}, prof ? prof.vfx || {} : {}, getVfxOverrides());
        }

if (typeof window !== 'undefined' && window) {
            window.getPerfVfx = getPerfVfx;
        }

/* ★ OOBE 首启性能档即时生效口子（000-tooltip 引导调用；balanced→medium 档位映射） */
if (typeof window !== 'undefined' && window) {
            Aria.__applyPerfTier = (tier) => {
                const map = { low: 'low', balanced: 'medium', high: 'high', minimal: 'minimal' };
                const key = map[tier] || tier;
                if (!key || !PERFORMANCE_PROFILES[key]) return;
                try { applyPerformanceProfile(key, true); } catch (e) { /* 静默 */ }
            };
        }

/* 应用性能配置到系统与所有视觉模式 */
function applyPerformanceProfile(profileName, applyToSettings = true) {
            let profile = PERFORMANCE_PROFILES[profileName];
            if (!profile) return;

            /* ★ 用户「视觉开销」手动覆盖：在档位 vfx 矩阵上叠加后再分发（不污染共享配置对象） */
            const overrides = getVfxOverrides();
            if (overrides && Object.keys(overrides).length) {
                profile = Object.assign({}, profile, { vfx: Object.assign({}, profile.vfx || {}, overrides) });
            }

            if (applyToSettings) {
                /* 应用到背景设置 */
                Object.assign(appSettings.background, profile.background);
                /* 应用到歌词设置 */
                Object.assign(appSettings.lyrics, profile.lyrics);
                /* 应用到界面设置 */
                Object.assign(appSettings.interface, profile.interface);

                /* 更新全局动画配置 */
                if (profile.animation) {
                    window.BG_CROSSFADE_DURATION = profile.animation.crossfadeDuration;
                }

                /* 动态向 body 注入性能等级 class 便于 CSS 降级渲染压力 */
                if (typeof document !== 'undefined' && document.body) {
                    document.body.classList.remove('perf-high', 'perf-medium', 'perf-low', 'perf-minimal');
                    document.body.classList.add(`perf-${profileName}`);
                }

                /* 分发模式特定性能参数给全量视觉管理器 (FlyIn, WordCloud, Floating, PV) */
                if (typeof window !== 'undefined') {
                    Aria.__lastPerfProfile = profile;
                }
                if (typeof mainVisManager !== 'undefined' && mainVisManager) {
                    if (typeof mainVisManager.applyPerformanceProfile === 'function') {
                        mainVisManager.applyPerformanceProfile(profile);
                    }
                }
                if (typeof pvEngineInstance !== 'undefined' && pvEngineInstance) {
                    if (typeof pvEngineInstance.setPerformanceConfig === 'function') {
                        pvEngineInstance.setPerformanceConfig({ pv: profile.pv, vfx: profile.vfx });
                    }
                }
                /* ★ 流光隧道引擎（懒加载，创建晚于配置下发 → 220-shortcuts-viewmode 创建后再次消费） */
                if (typeof tunnelEngineInstance !== 'undefined' && tunnelEngineInstance) {
                    if (typeof tunnelEngineInstance.setPerfConfig === 'function') {
                        tunnelEngineInstance.setPerfConfig(profile);
                    }
                }
                /* ★ 词云相机跟焦节流 */
                if (typeof wordcloudApplyPerf === 'function') {
                    try { wordcloudApplyPerf(profile); } catch(e) { logWarn('bootConfig', '词云性能配置失败:', e); }
                }

                /* 内存清理与缓存修剪策略 */
                if (profile.memory) {
                    const maxCache = profile.memory.maxProbeCache || 30;
                    if (typeof lyricSourceProbeCache !== 'undefined' && lyricSourceProbeCache.size > maxCache) {
                        const keysToDelete = Array.from(lyricSourceProbeCache.keys()).slice(0, lyricSourceProbeCache.size - maxCache);
                        keysToDelete.forEach(k => lyricSourceProbeCache.delete(k));
                    }
                }

                saveSettings();
            }

            return profile;
        }

/* 自动检测并应用配置 */
async function autoDetectAndApplyPerformance(skipIfSaved = true) {
            /* 检查是否已有保存的手动配置 */
            const saved = getPerformanceSettings();
            if (skipIfSaved && saved && saved.manuallyConfigured) {
                logInfo('bootConfig', '使用已保存的手动性能配置:', saved.profile);
                applyPerformanceProfile(saved.profile);
                return { profile: saved.profile, hardware: saved.hardware, auto: false };
            }

            /* 检测硬件 */
            const hw = await detectHardware();
            logInfo('bootConfig', '硬件检测结果:', hw);

            /* 冷启动等待主线程安定（欢迎页/字体/首曲预加载会明显压低 FPS，易造成假阴性），
           再进行双测：基础 rAF + 全样式合成压力短测（覆盖词云/飞入/PV/浮空/和鸣/隧道
           共用的模糊+阴影+transform 开销场景） */
            await new Promise(r => setTimeout(r, 600));

            /* 页面在后台/离屏时 rAF 会被浏览器节流到约 0~1 FPS，实测无意义 → 直接信任硬件档 */
            if (typeof document !== 'undefined' && document.hidden) {
                logWarn('bootConfig', '检测时页面在后台，跳过渲染实测，采用硬件推荐配置:', hw.recommendedProfile);
                const rp = hw.recommendedProfile;
                applyPerformanceProfile(rp);
                savePerformanceSettings({ profile: rp, hardware: hw, testFps: 0, stressFps: 0, effectiveFps: 0, detectedAt: Date.now(), manuallyConfigured: false });
                return { profile: rp, hardware: hw, testFps: 0, stressFps: 0, effectiveFps: 0, auto: true };
            }

            const testFps = await runPerformanceTest();
            const stressFps = await runRenderStressTest();
            const effectiveFps = Math.min(testFps, stressFps || testFps);
            logInfo('bootConfig', '性能测试 FPS:', testFps, '| 合成压力 FPS:', stressFps, '| 取用:', effectiveFps);

            /* 根据测试结果调整推荐配置
               ★ 高配硬件（detectHardware 判定 high）：只接受极端/可信的压力结果降级；
                 FPS<8 且高配有 WebGL → 环境节流/离屏假阴性，保持硬件推荐不降档 */
            let recommendedProfile = hw.recommendedProfile;
            if (recommendedProfile === 'high') {
                if (effectiveFps < 8 && hw.hasWebgl && !hw.isSoftwareRenderer) {
                    logWarn('bootConfig', '实测 FPS 异常低但硬件为高配(有 WebGL)，判定为环境节流/假阴性，保持:', hw.recommendedProfile);
                    recommendedProfile = hw.recommendedProfile;
                } else if (effectiveFps < 24) {
                    recommendedProfile = 'minimal';
                } else if (effectiveFps < 40) {
                    recommendedProfile = 'low';
                }
            } else if (effectiveFps < 24) {
                recommendedProfile = 'minimal';
            } else if (effectiveFps < 45) {
                recommendedProfile = 'low';
            } else if (recommendedProfile === 'medium' && effectiveFps > 60 && hw.gpuTier === 'high') {
                /* 硬件信息不全被低估(如拿不到显卡名)，但实测极其流畅 → 升档 */
                recommendedProfile = 'high';
            }

            /* 应用配置 */
            applyPerformanceProfile(recommendedProfile);

            /* 保存检测结果 */
            savePerformanceSettings({
                profile: recommendedProfile,
                hardware: hw,
                testFps: testFps,
                stressFps: stressFps || testFps,
                effectiveFps: effectiveFps,
                detectedAt: Date.now(),
                manuallyConfigured: false
            });

            return { profile: recommendedProfile, hardware: hw, testFps, stressFps, effectiveFps, auto: true };
        }

/* 显示性能检测对话框 */
function showPerformanceDialog(detectResult) {
            const profile = PERFORMANCE_PROFILES[detectResult.profile];
            const hw = detectResult.hardware;

            const dialog = document.createElement('div');
            dialog.className = 'welcome-overlay';
            dialog.id = 'performanceDialog';
            dialog.innerHTML = `
                <div class="welcome-bg"></div>
                <div class="welcome-card" style="max-width: 420px; padding: 0 20px;">
                    <div class="welcome-icon">
                        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5">
                            <rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect>
                            <rect x="9" y="9" width="6" height="6"></rect>
                            <line x1="9" y1="1" x2="9" y2="4"></line>
                            <line x1="15" y1="1" x2="15" y2="4"></line>
                            <line x1="9" y1="20" x2="9" y2="23"></line>
                            <line x1="15" y1="20" x2="15" y2="23"></line>
                            <line x1="20" y1="9" x2="23" y2="9"></line>
                            <line x1="20" y1="14" x2="23" y2="14"></line>
                            <line x1="1" y1="9" x2="4" y2="9"></line>
                            <line x1="1" y1="14" x2="4" y2="14"></line>
                        </svg>
                    </div>
                    <div class="welcome-title">性能优化配置</div>
                    <div class="welcome-desc" style="text-align: left; line-height: 1.6;">
                        <p>已根据您的电脑配置自动优化设置：</p>
                        <div style="background: rgba(255,255,255,0.1); border-radius: 8px; padding: 12px; margin: 12px 0; font-size: 13px;">
                            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                                <span style="color: rgba(255,255,255,0.6)">推荐配置</span>
                                <span style="color: var(--theme-color);">${profile.name}</span>
                            </div>
                            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                                <span style="color: rgba(255,255,255,0.6)">内存</span>
                                <span>${hw.memory} GB</span>
                            </div>
                            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                                <span style="color: rgba(255,255,255,0.6)">CPU 核心</span>
                                <span>${hw.cpuCores} 核</span>
                            </div>
                            ${hw.gpu ? `<div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                                <span style="color: rgba(255,255,255,0.6)">显卡</span>
                                <span style="max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${hw.gpu}</span>
                            </div>` : ''}
                            ${detectResult.effectiveFps ? `<div style="display: flex; justify-content: space-between;">
                                <span style="color: rgba(255,255,255,0.6)">渲染测试</span>
                                <span>${Math.round(detectResult.effectiveFps)} FPS</span>
                            </div>` : (detectResult.testFps ? `<div style="display: flex; justify-content: space-between;">
                                <span style="color: rgba(255,255,255,0.6)">渲染测试</span>
                                <span>${Math.round(detectResult.testFps)} FPS</span>
                            </div>` : '')}
                        </div>
                        <p style="font-size: 13px; color: rgba(255,255,255,0.5);">${profile.description}</p>
                    </div>
                    <div style="display: flex; gap: 12px; justify-content: center;">
                        <button class="welcome-btn" id="perfAcceptBtn" style="background: var(--theme-color); color: #1a1a1a;">应用推荐</button>
                        <button class="welcome-btn" id="perfCustomBtn" style="background: rgba(255,255,255,0.15); color: #fff;">手动调整</button>
                    </div>
                </div>
            `;
            document.body.appendChild(dialog);

            /* 绑定按钮事件 */
document.getElementById('perfAcceptBtn')?.addEventListener('click', () => {
                /* 标记为已配置，下次打开不再弹窗 */
                savePerformanceSettings({
                    profile: detectResult.profile,
                    hardware: hw,
                    testFps: detectResult.testFps,
                    manuallyConfigured: true,
                    configuredAt: Date.now()
                });
                dialog.classList.add('hidden');
                setTimeout(() => dialog.remove(), 400);
            });

document.getElementById('perfCustomBtn')?.addEventListener('click', () => {
                /* 标记为已配置，下次打开不再弹窗 */
                savePerformanceSettings({
                    profile: detectResult.profile,
                    hardware: hw,
                    testFps: detectResult.testFps,
                    manuallyConfigured: true,
                    configuredAt: Date.now()
                });
                dialog.classList.add('hidden');
                setTimeout(() => dialog.remove(), 400);
                /* 打开设置面板并切换到「性能」分栏（openSettingsPanel 不存在于分片，改用按钮触发） */
                try {
                    const openBtn = typeof document !== 'undefined' ? document.getElementById('openSettingsBtn') : null;
                    if (openBtn) openBtn.click();
                } catch (e) { logWarn('bootConfig', '打开设置失败:', e); }
                setTimeout(() => {
                    const perfTab = typeof document !== 'undefined' ? document.querySelector('#settingsTabs .settings-tab[data-tab="performance"]') : null;
                    if (perfTab) perfTab.click();
                }, 60);
                /* 滚动到性能设置部分 */
                setTimeout(() => {
                    const perfSection = typeof document !== 'undefined' ? document.querySelector('[data-section="performance"]') : null;
                    if (perfSection) perfSection.scrollIntoView({ behavior: 'smooth' });
                }, 150);
            });
        }

function loadSettings() {
            try {
                const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
                if (raw) {
                    const saved = JSON.parse(raw);
                    appSettings = {
                        playback: { ...DEFAULT_SETTINGS.playback, ...(saved.playback || {}) },
                        lyrics: { ...DEFAULT_SETTINGS.lyrics, ...(saved.lyrics || {}) },
                        background: { ...DEFAULT_SETTINGS.background, ...(saved.background || {}) },
                        interface: {
                            ...DEFAULT_SETTINGS.interface,
                            ...(saved.interface || {}),
                            advancedFonts: {
                                ...DEFAULT_SETTINGS.interface.advancedFonts,
                                ...((saved.interface && saved.interface.advancedFonts) || {})
                            }
                        },
                        audio: { ...DEFAULT_SETTINGS.audio, ...(saved.audio || {}) },
                        nowPlaying: { ...DEFAULT_SETTINGS.nowPlaying, ...(saved.nowPlaying || {}) },
                        quality: { ...DEFAULT_SETTINGS.quality, ...(saved.quality || {}) },
                        shortcuts: { ...DEFAULT_SETTINGS.shortcuts, ...(saved.shortcuts || {}) },
                        ai: (() => {
                            const defAi = DEFAULT_SETTINGS.ai || {};
                            const savedAi = saved.ai || {};
                            const mergedConfigs = {};
                            if (defAi.providerConfigs) {
                                Object.keys(defAi.providerConfigs).forEach(p => {
                                    mergedConfigs[p] = { ...defAi.providerConfigs[p] };
                                });
                            }
                            if (savedAi.providerConfigs && typeof savedAi.providerConfigs === 'object') {
                                Object.keys(savedAi.providerConfigs).forEach(p => {
                                    mergedConfigs[p] = { ...(mergedConfigs[p] || {}), ...(savedAi.providerConfigs[p] || {}) };
                                    if (savedAi.providerConfigs[p] && savedAi.providerConfigs[p].model) {
                                        mergedConfigs[p].model = savedAi.providerConfigs[p].model;
                                    }
                                });
                            }
                            const activeProv = savedAi.provider || defAi.provider || 'openai';
                            if (savedAi.apiKey && !mergedConfigs[activeProv]?.apiKey) {
                                if (!mergedConfigs[activeProv]) mergedConfigs[activeProv] = {};
                                mergedConfigs[activeProv].apiKey = savedAi.apiKey;
                            }
                            if (savedAi.apiBase && !mergedConfigs[activeProv]?.apiBase) {
                                if (!mergedConfigs[activeProv]) mergedConfigs[activeProv] = {};
                                mergedConfigs[activeProv].apiBase = savedAi.apiBase;
                            }
                            if (savedAi.model && !mergedConfigs[activeProv]?.model) {
                                if (!mergedConfigs[activeProv]) mergedConfigs[activeProv] = {};
                                mergedConfigs[activeProv].model = savedAi.model;
                            }

                            const activeSaved = mergedConfigs[activeProv] || {};
                            return {
                                ...defAi,
                                ...savedAi,
                                provider: activeProv,
                                apiKey: activeSaved.apiKey || '',
                                apiBase: activeSaved.apiBase || '',
                                model: (activeSaved.model !== undefined && activeSaved.model !== '') ? activeSaved.model : (AI_PROVIDERS[activeProv]?.defaultModel || ''),
                                providerConfigs: mergedConfigs
                            };
                        })(),
                        /* ★ 各模式独立设置深度合并（覆盖默认配置并保留用户修改） */
                        modeSettings: (() => {
                            const merged = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.modeSettings || {}));
                            if (saved.modeSettings && typeof saved.modeSettings === 'object') {
                                Object.keys(saved.modeSettings).forEach(m => {
                                    merged[m] = { ...(merged[m] || {}), ...(saved.modeSettings[m] || {}) };
                                    /* ★ 迁移旧像素 fontSize 值到倍率系统 (24px = 1.0x) */
                                    if (merged[m].fontSize !== undefined) {
                                        const fsNum = parseFloat(merged[m].fontSize);
                                        if (!isNaN(fsNum) && fsNum > 3) {
                                            merged[m].fontSize = fsNum / 24;
                                        }
                                    }
                                });
                            }
                            return merged;
                        })()
                    };
                }

                /* 读取/兼容独立 ai_api_base, ai_api_key, ai_model 配置 */
                if (typeof localStorage !== 'undefined' && appSettings && appSettings.ai) {
                    const rawBase = localStorage.getItem('ai_api_base');
                    const rawKey = localStorage.getItem('ai_api_key');
                    const rawModel = localStorage.getItem('ai_model');
                    const curP = appSettings.ai.provider || 'openai';
                    if (rawBase && appSettings.ai.providerConfigs && appSettings.ai.providerConfigs[curP] && !appSettings.ai.providerConfigs[curP].apiBase) {
                        appSettings.ai.providerConfigs[curP].apiBase = rawBase;
                    }
                    if (rawKey && appSettings.ai.providerConfigs && appSettings.ai.providerConfigs[curP] && !appSettings.ai.providerConfigs[curP].apiKey) {
                        appSettings.ai.providerConfigs[curP].apiKey = rawKey;
                    }
                    if (rawModel && appSettings.ai.providerConfigs && appSettings.ai.providerConfigs[curP] && !appSettings.ai.providerConfigs[curP].model) {
                        appSettings.ai.providerConfigs[curP].model = rawModel;
                    }
                }
            } catch (e) { logError('bootConfig', '加载设置失败:', e); }
            /* appSettings 被整体替换后同步全局引用，避免 window.appSettings / previewEngine 持有过期对象 */
            if (typeof window !== 'undefined') window.appSettings = appSettings;
            if (typeof previewEngineInstance !== 'undefined' && previewEngineInstance) previewEngineInstance.appSettings = appSettings;
            if (appSettings.interface && appSettings.interface.language) {
                try { setLanguage(appSettings.interface.language); } catch (_) {}
            }
        }

/* ★ 后端本地全量配置文件 (user_config.json) 双向持久化与同步 */
globalThis._isLocalBackendAvailable = null;

globalThis._configSaveDebounceTimer = null;

async function syncConfigToBackend() {
            try {
                const savedRaw = localStorage.getItem(SETTINGS_STORAGE_KEY);
                let currentSettings = (appSettings && Object.keys(appSettings).length > 0) ? appSettings : null;
                if (!currentSettings && savedRaw) {
                    try { currentSettings = JSON.parse(savedRaw); } catch(e) {}
                }
                if (!currentSettings) currentSettings = DEFAULT_SETTINGS;

                let favs = [];
                try {
                    favs = typeof getFavorites === 'function' ? getFavorites() : JSON.parse(localStorage.getItem(FAV_STORAGE_KEY) || '[]');
                } catch(e) {}

                let pls = [];
                try {
                    pls = typeof getPlaylists === 'function' ? getPlaylists() : JSON.parse(localStorage.getItem(PLAYLIST_STORAGE_KEY) || '[]');
                } catch(e) {}

                let eqData = {};
                try {
                    eqData = typeof eqGains !== 'undefined' ? { gains: eqGains, activePreset: eqActivePreset } : JSON.parse(localStorage.getItem(EQ_STORAGE_KEY) || '{}');
                } catch(e) {}

                let perfData = {};
                try {
                    perfData = JSON.parse(localStorage.getItem(PERF_STORAGE_KEY) || '{}');
                } catch(e) {}

                const fullBundle = {
                    settings: currentSettings,
                    playlists: pls,
                    favorites: favs,
                    eq: eqData,
                    performance: perfData,
                    lastUpdated: Date.now()
                };
                const res = await fetch('/api/config/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(fullBundle)
                });
                if (res.ok) {
                    _isLocalBackendAvailable = true;
                    logInfo('bootConfig', '[Config] 成功同步全量配置（含收藏、歌单、设置）到本地 user_config.json');
                }
            } catch (e) {
                // 本地服务未运行
            }
        }

if (typeof window !== 'undefined') window.syncConfigToBackend = syncConfigToBackend;

function debouncedSaveConfigToBackend() {
            if (_configSaveDebounceTimer) clearTimeout(_configSaveDebounceTimer);
            _configSaveDebounceTimer = setTimeout(syncConfigToBackend, 400);
        }

async function loadConfigFromBackend() {
            try {
                const res = await fetch('/api/config/load');
                if (res.ok) {
                    _isLocalBackendAvailable = true;
                    const data = await res.json();
                    let hasValidData = false;
                    if (data && data.settings && typeof data.settings === 'object' && Object.keys(data.settings).length > 0) {
                        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(data.settings));
                        hasValidData = true;
                    }
                    if (data && data.playlists && Array.isArray(data.playlists) && data.playlists.length > 0) {
                        localStorage.setItem(PLAYLIST_STORAGE_KEY, JSON.stringify(data.playlists));
                        hasValidData = true;
                    }
                    if (data && data.favorites && Array.isArray(data.favorites) && data.favorites.length > 0) {
                        localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify(data.favorites));
                        hasValidData = true;
                    }
                    if (data && data.eq && Object.keys(data.eq).length > 0) {
                        localStorage.setItem(EQ_STORAGE_KEY, JSON.stringify(data.eq));
                        hasValidData = true;
                    }
                    if (data && data.performance && Object.keys(data.performance).length > 0) {
                        localStorage.setItem(PERF_STORAGE_KEY, JSON.stringify(data.performance));
                        hasValidData = true;
                    }
                    if (hasValidData) {
                        return true;
                    } else {
                        /* 后端 user_config.json 为空，立即将前端已有配置推送到后端 */
                        setTimeout(syncConfigToBackend, 600);
                    }
                }
            } catch (e) {
                // 本地服务未运行
            }
            return false;
        }

/* ★ 在线音频流短时本地缓存代理（防 QQ 音乐 URL 3~5分钟失效风控） */
function getStreamCachedAudioUrl(rawUrl, songId) {
            if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
            if (rawUrl.startsWith('blob:') || rawUrl.startsWith('data:') || rawUrl.startsWith('/local_music/')) {
                return rawUrl;
            }
            /* ★ 仅当确认后端不可用时才使用裸外链：启动初期 _isLocalBackendAvailable 尚为 null（配置
               未加载完），也一律走本地流式代理——否则冷启动阶段 audio.src 直接用外网原链
               （QQ 系需要 Referer/跨域），正是"刚启动就播放失败、运行一会后才正常"的根因之一。 */
            if (_isLocalBackendAvailable !== false && (rawUrl.startsWith('http://') || rawUrl.startsWith('https://'))) {
                const sid = encodeURIComponent(songId || (currentSongData ? (currentSongData.mid || currentSongData.id || currentSongData.title) : 'track'));
                return (window.__TAURI_API_ORIGIN || '') + `/api/audio/stream?url=${encodeURIComponent(rawUrl)}&songId=${sid}`;
            }
            return rawUrl;
        }

function saveSettings() {
            try {
                localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(appSettings));
                if (appSettings.ai) {
                    if (appSettings.ai.apiBase !== undefined) localStorage.setItem('ai_api_base', appSettings.ai.apiBase);
                    if (appSettings.ai.apiKey !== undefined) localStorage.setItem('ai_api_key', appSettings.ai.apiKey);
                    if (appSettings.ai.model !== undefined) localStorage.setItem('ai_model', appSettings.ai.model);
                }
                debouncedSaveConfigToBackend();
            } catch (e) { logError('bootConfig', '保存设置失败:', e); }
        }

export { applyPerformanceProfile, autoDetectAndApplyPerformance, bootApp, cleanGpuName, debouncedSaveConfigToBackend, detectHardware, getPerformanceSettings, getPerfVfx, getStreamCachedAudioUrl, getVfxOverrides, initDefaultSong, loadConfigFromBackend, loadSettings, preloadDefaultSong, runPerformanceTest, runRenderStressTest, savePerformanceSettings, saveSettings, setVfxOverride, showPerformanceDialog, syncConfigToBackend };
