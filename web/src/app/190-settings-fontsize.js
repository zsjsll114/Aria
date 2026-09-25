/* ============================================================
 * 190-settings-fontsize.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 8843-9257 行 | 单元数: 13
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { EQ_PRESETS, EQ_STORAGE_KEY } from '../config/constants.js';
import { playerConfig } from '../config/defaults.js';
import { getBlurBgLayers } from '../infrastructure/dom.js';
import { volumePercentToGain } from '../utils/volumeCurve.js';
import { audio, renderLyrics } from './20-lyrics-render.js';
import { volumeBar } from './30-dom-refs.js';
import { setPlayMode, updatePlayModeIcon } from './75-play-mode.js';
import { applyPlaybackRate, applyPreservesPitch } from './85-rate-download.js';
import { applyEqPreset, saveEqSettings } from './90-eq.js';
import { applyColorOverlay, generatePrebakedBlurBackground, getActiveBgLayer, shouldUsePrebakedBlur } from './100-cover-background.js';
import { saveSettings } from './180-boot-config.js';
import { applyFontFamily, applyGlassStrength } from './210-color-multilang.js';
import { getLanguage, setLanguage } from '../core/i18n.js';
import { logInfo, logWarn, logError, logCatch } from '../services/log.js';

/* 应用所有设置到播放器 */
function applyAllSettings() {
            const p = appSettings.playback;
            const l = appSettings.lyrics;
            const b = appSettings.background;
            const i = appSettings.interface;

            /* 播放设置 */
            /* ★ 不在此重放 volume（2026-09-25 probe3 实测）：volume 是运行时可变状态
               （滑杆/遥控器/淡入淡出都在改，persistVolume 又把它们写回 initialVolume）。
               __reapplyFontSettings 触发的全量重放会把旧 initialVolume 打回 volume——
               自定义字体注册完成后 ~2.5s，用户当前音量被静默覆盖（栈：
               initCustomFonts → applyAllSettings:29）。boot 初始值由
               10-config-state.js 的 globalThis.volume = playerConfig.initialVolume 负责，
               「初始音量」面板滑块本身就是下次启动生效的语义，此处只同步音频节点增益。 */
            audio.volume = volumePercentToGain(volume);
            if (volumeBar) volumeBar.style.width = volume + '%';
            playMode = p.defaultPlayMode;
            if (typeof updatePlayModeIcon === 'function') updatePlayModeIcon();
            applyPlaybackRate(p.defaultRate);
            applyPreservesPitch(p.preservesPitch);

            /* 歌词设置 */
            applyLyricFontSize(l.fontSize);
            applyLyricBlurLevel(l.blurLevel);
            applyHighlightColor(l.highlightColor);

            /* 背景设置 */
            applyBackgroundSettings();

            /* 界面设置 */
            applyInterfaceSettings();

            /* 音效设置：首次使用时应用默认EQ预设 */
            const rawEq = localStorage.getItem(EQ_STORAGE_KEY);
            if (!rawEq && appSettings.audio.defaultEqPreset !== 'default') {
                const preset = EQ_PRESETS[appSettings.audio.defaultEqPreset];
                if (preset) {
                    eqGains = [...preset];
                    eqActivePreset = appSettings.audio.defaultEqPreset;
                    saveEqSettings();
                }
            }

            /* ★ 确保每次刷新页面或启动时应用当前视图模式的全量独立外观（包含情感词发光等） */
            try {
                applyModeSettings(currentViewMode || 'cover');
            } catch (e) {
                logWarn('settingsFontsize', '[applyAllSettings] applyModeSettings error:', e);
            }
        }

/* ========== 应用函数 ========== */
/* LYRIC_FONT_MAP 已提升至顶部 */
/* ★ 基准字号 (medium = 1.0x 的基准像素值) */
const FONT_BASE_ORIGINAL = 24;

/* medium 档位原文基准 px */
const FONT_BASE_SUB = 16;

/* medium 档位翻译/罗马音基准 px */
function applyLyricFontSize(size) {
            /* 兼容旧格式：档位关键字 small/medium/large/xlarge → 倍率 */
            let scale;
            if (typeof size === 'string' && (size === 'small' || size === 'medium' || size === 'large' || size === 'xlarge')) {
                const map = { small: 0.75, medium: 1.0, large: 1.35, xlarge: 1.7 };
                scale = map[size] || 1.0;
            } else {
                scale = parseFloat(size);
                if (isNaN(scale) || scale <= 0) scale = 1.0;
                /* ★ 迁移旧像素值：如果 >3 说明是旧的 px 值，自动转为倍率 */
                if (scale > 3) scale = scale / FONT_BASE_ORIGINAL;
            }
            const originalSize = (FONT_BASE_ORIGINAL * scale) + 'px';
            const subSize = (FONT_BASE_SUB * scale) + 'px';
            let style = document.getElementById('lyric-font-style');
            if (!style) {
                style = document.createElement('style');
                style.id = 'lyric-font-style';
                document.head.appendChild(style);
            }
            /* ★ 仅作用于主播放器，不污染预览引擎 (.preview-player)；排除词云模式（词云行使用内联随机字号） */
            style.textContent = `
                .player-container:not(.preview-player):not(.view-wordcloud) .lrc-original { --font-size: ${originalSize} !important; font-size: ${originalSize} !important; }
                .player-container:not(.preview-player):not(.view-wordcloud) .lrc-romaji,
                .player-container:not(.preview-player):not(.view-wordcloud) .lrc-translation { --font-size: ${subSize} !important; font-size: ${subSize} !important; }
            `;
        }

function applyLyricBlurLevel(level) {
            let style = document.getElementById('lyric-blur-style');
            if (!style) {
                style = document.createElement('style');
                style.id = 'lyric-blur-style';
                document.head.appendChild(style);
            }
            const blurSteps = [0, 1.5, 3, 4.5, 6, 7.5, 9, 10.5, 12];
            const opacitySteps = [1, 0.55, 0.45, 0.38, 0.32, 0.28, 0.24, 0.22, 0.20];
            let css = '';
            for (let d = 0; d <= 8; d++) {
                const bl = (d <= level) ? blurSteps[d] : blurSteps[Math.min(level, 8)];
                const op = (d <= level) ? opacitySteps[d] : opacitySteps[Math.min(level, 8)];
                css += `.line.blur-d${d} { opacity: ${op}; filter: blur(${bl}px); }\n`;
            }
            style.textContent = css;
        }

function applyHighlightColor(color) {
            const l = appSettings.lyrics;
            const highlightColor = color || l.highlightColor || '#ffffff';
            const highlightInactiveColor = l.highlightInactiveColor || 'rgba(255,255,255,0.6)';
            const inactiveColor = l.inactiveColor || '#ffffff';
            const align = l.align || 'left';
            if (typeof document !== 'undefined') {
                document.documentElement.style.setProperty('--highlight-color', highlightColor);
                document.documentElement.style.setProperty('--highlight-inactive-color', highlightInactiveColor);
            }
            /* 缩放原点跟随对齐方向，避免溢出 */
            const transformOrigin = align === 'left' ? 'left center'
                                  : align === 'right' ? 'right center'
                                  : 'center center';
            /* 时间标签位置：右对齐时在左侧，左/居中对齐时在右侧 */
            const timePosition = align === 'right'
                ? '.line .line-time { left: 15px; right: auto; }'
                : '.line .line-time { right: 15px; left: auto; }';
            let style = document.getElementById('lyric-highlight-style');
            if (!style) {
                style = document.createElement('style');
                style.id = 'lyric-highlight-style';
                document.head.appendChild(style);
            }
            /* 逐字高亮 + 纯LRC高亮行颜色（无逐字数据时 .lrc-original 直接显示高亮色）
               高亮行未高亮部分（.word 非高亮状态、.lrc-original 在无逐字时的底色）
               非高亮行的 .lrc-original 颜色
               歌词对齐方式
               高亮行文字缩放（仅缩放文字，不缩放容器，避免溢出）
               时间标签位置 */
            style.textContent = `
                .word-highlight { color: ${highlightColor} !important; }
                .line.active .lrc-original { color: ${highlightColor} !important; }
                .line .word { color: ${highlightInactiveColor}; }
                .line.active .word { color: ${highlightInactiveColor}; }
                .line.active .word-highlight { color: ${highlightColor} !important; }
                .line:not(.active) .lrc-original { color: ${inactiveColor}; }
                .player-container:not(.preview-player) .lrc-original { text-align: ${align}; }
                .player-container:not(.preview-player) .lrc-romaji { text-align: ${align}; }
                .player-container:not(.preview-player) .lrc-translation { text-align: ${align}; }
                .line.active .lrc-original,
                .line.active .lrc-romaji,
                .line.active .lrc-translation {
                    transform: scale(1.03);
                    transform-origin: ${transformOrigin};
                }
                /* ★ 词云模式不缩放高亮行（避免溢出碰撞检测的包围盒） */
                .view-wordcloud .line.active .lrc-original,
                .view-wordcloud .line.active .lrc-romaji,
                .view-wordcloud .line.active .lrc-translation {
                    transform: none !important;
                }
                /* ★ 防止高亮行缩放导致文字溢出容器（clip 不影响滚动） */
                .line.active { overflow-x: clip; }
                ${timePosition}
            `;
        }

function applyLyricAlign(align) {
            appSettings.lyrics.align = align;
            /* 复用 highlight style 节点，重新生成全部歌词样式 */
            applyHighlightColor(appSettings.lyrics.highlightColor);
        }

/* ★ 切换视图模式时应用该模式的全套独立外观设置 */
function applyModeSettings(mode) {
            if (!appSettings.modeSettings) {
                appSettings.modeSettings = {
                    cover: { align: 'left', fontSize: 24, blurLevel: 5, highlightColor: '#ffffff', highlightInactiveColor: 'rgba(255,255,255,0.6)', inactiveColor: '#ffffff', showTranslation: true, showRomaji: true, bgBlur: 60, bgBrightness: 0.35, swayEnabled: true, swayAmp: 12, swayDuration: 16, fontFamily: 'default', emotionGlow: 10 },
                    lyrics: { align: 'center', fontSize: 24, blurLevel: 5, highlightColor: '#ffffff', highlightInactiveColor: 'rgba(255,255,255,0.6)', inactiveColor: '#ffffff', showTranslation: true, showRomaji: true, bgBlur: 60, bgBrightness: 0.35, swayEnabled: true, swayAmp: 12, swayDuration: 16, fontFamily: 'default', emotionGlow: 10 },
                    flyin: { align: 'center', fontSize: 28, blurLevel: 5, highlightColor: '#ffffff', showTranslation: true, showRomaji: true, graphicColor: '#ffcc33', bgBlur: 80, bgBrightness: 0.12, swayEnabled: true, swayAmp: 12, swayDuration: 16, fontFamily: 'default', flyinTranslateY: 14, flyinScale: 0.8, flyinGlow: 8, flyinTransSize: 15, flyinTransBottom: 16, emotionGlow: 10 },
                    wordcloud: { align: 'center', fontSize: 20, blurLevel: 5, highlightColor: '#ffffff', showTranslation: true, showRomaji: true, bgBlur: 60, bgBrightness: 0.35, swayEnabled: true, swayAmp: 12, swayDuration: 16, fontFamily: 'default', wcFontMin: 14, wcFontMax: 36, wcDensity: 20, wcDimBlur: 4, wcDimOpacity: 0.25, wcLerpFactor: 0.04, emotionGlow: 10 },
                    pv: { align: 'center', fontSize: 36, blurLevel: 5, highlightColor: '#ffffff', showTranslation: true, showRomaji: true, graphicColor: '#ffcc33', bgBlur: 60, bgBrightness: 0.35, swayEnabled: true, swayAmp: 12, swayDuration: 16, fontFamily: 'default', preset: 'dream', cameraSpeed: 1.0, cameraZoom: 1.0, showHud: true, showParticles: true, showDecorations: true, aiColorSync: true, emotionGlow: 10 },
                    /* ★ neon/letterpress 缺席时 applyModeSettings 会 fallback 到 cover 档
                       （错档的字号/字体设置被错误应用），与 defaults.js 保持同键 */
                    neon: { align: 'center', fontSize: 1.0, highlightColor: '#ffffff', showTranslation: true, fontFamily: 'default', emotionGlow: 14 },
                    letterpress: { align: 'center', fontSize: 1.0, highlightColor: '#ffffff', showTranslation: true, fontFamily: 'default', emotionGlow: 14 },
                    dimension: { align: 'center', fontSize: 32, blurLevel: 5, highlightColor: '#ffffff', showTranslation: true, showRomaji: true, bgColor: '#ffcc33', bgBlur: 60, bgBrightness: 0.35, swayEnabled: true, swayAmp: 12, swayDuration: 16, fontFamily: 'default', emotionGlow: 10 }
                };
            }
            const s = appSettings.modeSettings[mode] || appSettings.modeSettings.cover;
            if (!s) return;
            let needRender = false;

            /* 对齐 */
            if (s.align !== undefined) { appSettings.lyrics.align = s.align; applyLyricAlign(s.align); }
            /* 模糊度 */
            if (s.blurLevel !== undefined) { appSettings.lyrics.blurLevel = parseInt(s.blurLevel); applyLyricBlurLevel(appSettings.lyrics.blurLevel); }
            /* 颜色 */
            if (s.highlightColor !== undefined) appSettings.lyrics.highlightColor = s.highlightColor;
            if (s.highlightInactiveColor !== undefined) appSettings.lyrics.highlightInactiveColor = s.highlightInactiveColor;
            if (s.inactiveColor !== undefined) appSettings.lyrics.inactiveColor = s.inactiveColor;
            applyHighlightColor(appSettings.lyrics.highlightColor || '#ffffff');
            /* 翻译与罗马音 */
            if (s.showTranslation !== undefined && appSettings.lyrics.showTranslation !== s.showTranslation) { appSettings.lyrics.showTranslation = s.showTranslation; needRender = true; }
            if (s.showRomaji !== undefined && appSettings.lyrics.showRomaji !== s.showRomaji) { appSettings.lyrics.showRomaji = s.showRomaji; needRender = true; }
            /* 字号 */
            if (s.fontSize !== undefined) {
                /* ★ 迁移旧像素值到倍率系统 */
                let fsVal = s.fontSize;
                const fsNum = parseFloat(fsVal);
                if (!isNaN(fsNum) && fsNum > 3) {
                    /* 旧像素值 → 倍率 (FONT_BASE_ORIGINAL = 24) */
                    fsVal = fsNum / 24;
                    s.fontSize = fsVal; /* 同步回 modeSettings 避免反复迁移 */
                }
                appSettings.lyrics.fontSize = fsVal;
                applyLyricFontSize(fsVal);
            }
            /* 全局主题色：控制全局控件/按钮/强调色 */
            const effectiveThemeColor = appSettings.interface.themeColor || '#ffcc33';
            applyThemeColor(effectiveThemeColor);
            /* 背景设置（模糊度、亮度、摇摆） */
            if (s.bgBlur !== undefined) appSettings.background.blur = parseInt(s.bgBlur);
            if (s.bgBrightness !== undefined) appSettings.background.brightness = parseFloat(s.bgBrightness);
            if (s.swayEnabled !== undefined) appSettings.background.swayEnabled = s.swayEnabled;
            if (s.swayAmp !== undefined) appSettings.background.swayAmp = parseInt(s.swayAmp);
            if (s.swayDuration !== undefined) appSettings.background.swayDuration = parseInt(s.swayDuration);
            applyBackgroundSettings();
            /* 字体 — ★ 每个模式独立字体设置
               「跟随字体设置」(default/inherit)：应用全局字体，不覆盖 interface.fontFamily
               设置具体字体(宋体/楷体/黑体/仿宋/等宽/自定义)：该模式内独立生效 */
            if (typeof applyFontFamily === 'function') {
                if (s.fontFamily !== undefined && s.fontFamily !== 'default' && s.fontFamily !== 'inherit') {
                    applyFontFamily(s.fontFamily);
                } else {
                    applyFontFamily((appSettings.interface && appSettings.interface.fontFamily) || 'default');
                }
            }

            /* 各模式专有变量导出到根 CSS 变量 */
            if (typeof document !== 'undefined') {
                const root = document.documentElement;
                if (s.graphicColor !== undefined) root.style.setProperty('--graphic-color', s.graphicColor);
                if (s.bgColor !== undefined) root.style.setProperty('--bg-color', s.bgColor);
                if (s.flyinTranslateY !== undefined) root.style.setProperty('--flyin-translateY', s.flyinTranslateY + 'px');
                if (s.flyinScale !== undefined) root.style.setProperty('--flyin-scale', s.flyinScale);
                if (s.flyinGlow !== undefined) root.style.setProperty('--flyin-glow', s.flyinGlow + 'px');
                if (s.flyinTransSize !== undefined) root.style.setProperty('--flyin-trans-size', s.flyinTransSize + 'px');
                if (s.flyinTransBottom !== undefined) root.style.setProperty('--flyin-trans-bottom', s.flyinTransBottom + 'px');
                if (s.wcFontMin !== undefined) root.style.setProperty('--wc-font-min', s.wcFontMin + 'rem');
                if (s.wcFontMax !== undefined) root.style.setProperty('--wc-font-max', s.wcFontMax + 'rem');
                if (s.wcDensity !== undefined) root.style.setProperty('--wc-density', s.wcDensity + 'px');
                if (s.wcDimBlur !== undefined) root.style.setProperty('--wc-dim-blur', s.wcDimBlur + 'px');
                if (s.wcDimOpacity !== undefined) root.style.setProperty('--wc-dim-opacity', s.wcDimOpacity);
                /* ★ 情感词发光强度（每个模式独立） */
                if (s.emotionGlow !== undefined) {
                    root.style.setProperty('--emotion-glow', (parseFloat(s.emotionGlow) || 10) + 'px');
                    /* 重新应用情感词，使发光强度实时变化 */
                    if (typeof applyEmotionWordColors === 'function' && aiEmotionWords && aiEmotionWords.length > 0) {
                        try { applyEmotionWordColors(); } catch (e) { logCatch('settingsFontsize', e); }
                    }
                }
            }

            if (mode === 'pv' && pvEngineInstance) {
                pvEngineInstance.applySettings(s);
            }
            if (mode === 'tunnel' && tunnelEngineInstance) {
                tunnelEngineInstance.applySettings(s);
            }
            if (mainVisManager && mainVisManager.has(mode)) {
                mainVisManager.applySettings(s);
            }
            if (needRender && typeof lyrics !== 'undefined' && lyrics.length > 0) renderLyrics(lyrics);
        }

function applyThemeColor(color) {
            if (!color || typeof document === 'undefined') return;
            const root = document.documentElement;
            root.style.setProperty('--theme-color', color);
            let hex = color.replace('#', '');
            if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
            if (hex.length === 6) {
                const r = parseInt(hex.slice(0, 2), 16);
                const g = parseInt(hex.slice(2, 4), 16);
                const b = parseInt(hex.slice(4, 6), 16);
                root.style.setProperty('--theme-color-rgb', `${r}, ${g}, ${b}`);
            }
            root.style.setProperty('--dim-highlight-color', color);
            root.style.setProperty('--vis-theme-color', color);
            root.style.setProperty('--pv-emotion-color', color);
        }

function applyBackgroundSettings() {
            const b = appSettings.background;
            const layers = getBlurBgLayers();
            if (layers.length === 0) return;
            playerConfig.enableBlurBackground = b.dynamicBg;

            const usePrebaked = typeof shouldUsePrebakedBlur === 'function' && shouldUsePrebakedBlur();

            if (b.dynamicBg) {
                layers.forEach(bg => {
                    bg.style.filter = usePrebaked ? 'none' : `blur(${b.blur}px) brightness(${b.brightness})`;
                    /* 仅当前活动层保持可见，非活动层保持隐藏 */
                });
                const active = getActiveBgLayer();
                active.classList.add('visible');
                /* 若启用了预烘焙且当前活动层尚未烘焙，则从当前背景图片地址异步生成一次 */
                if (usePrebaked && typeof generatePrebakedBlurBackground === 'function') {
                    const rawUrlMatch = (active.style.backgroundImage || '').match(/url\(["']?(.+?)["']?\)/);
                    const curUrl = rawUrlMatch ? rawUrlMatch[1] : '';
                    if (curUrl && !curUrl.startsWith('data:image')) {
                        generatePrebakedBlurBackground(curUrl, b.blur, b.brightness).then(baked => {
                            if (baked && baked !== curUrl) {
                                active.style.backgroundImage = `url("${baked}")`;
                                active.style.filter = 'none';
                            }
                        }).catch((e) => logCatch('settingsFontsize', e));
                    }
                }
            } else {
                layers.forEach(bg => {
                    bg.style.filter = 'none';
                });
                getActiveBgLayer().classList.add('visible');
                applyColorOverlay(0, 0, 0, 0.8);
            }

            /* 摇摆动画 - 两个层保持同步（无显卡虚拟机或极简档下彻底停止动画，消除每帧旋转消耗） */
            const isMinimal = typeof document !== 'undefined' && document.body && document.body.classList.contains('perf-minimal');
            const isSw = typeof document !== 'undefined' && (document.documentElement.classList.contains('is-software-renderer') || Boolean(window.__isSoftwareRenderer));
            const animStr = (b.swayEnabled && !isMinimal && !isSw)
                ? `bgSway ${b.swayDuration}s ease-in-out infinite`
                : 'none';
            layers.forEach(bg => { bg.style.animation = animStr; });

            if (b.swayEnabled && !isMinimal && !isSw) {
                /* 动态注入摇摆幅度 */
                let style = document.getElementById('bg-sway-style');
                if (!style) {
                    style = document.createElement('style');
                    style.id = 'bg-sway-style';
                    document.head.appendChild(style);
                }
                style.textContent = `@keyframes bgSway { 0%,100% { transform: rotate(-${b.swayAmp}deg) scale(1.1); } 50% { transform: rotate(${b.swayAmp}deg) scale(1.1); } }`;
            }
        }

function applyInterfaceSettings() {
            const i = appSettings.interface;
            applyThemeColor(i.themeColor);
            applyGlassStrength(i.glassStrength);
            applyFontFamily(i.fontFamily);
            let style = document.getElementById('interface-style');
            if (!style) {
                style = document.createElement('style');
                style.id = 'interface-style';
                document.head.appendChild(style);
            }
            let css = '';
            if (i.compactMode) {
                css += `
                    .control-button { width: 38px !important; height: 38px !important; }
                    .controls-row { gap: 16px !important; }
                    .player-controls-wrapper { width: clamp(280px, 24vw, 360px) !important; min-width: 280px !important; }
                    .player-container { gap: clamp(8px, 1.5vw, 20px) !important; padding: clamp(8px, 1.5vh, 20px) clamp(20px, 2.5vw, 40px) !important; }
                    .song-info-wrapper { gap: 4px !important; }
                    .progress-container { margin-top: 6px !important; }
                `;
            }
            style.textContent = css;
        }

/* ========== 设置面板交互 ========== */
/* previewEngineInstance 已提升至 bootApp 之上声明，避免 TDZ */
/* ========== 全局设置键值读取与更新 ========== */
function getSettingValue(key) {
            if (!appSettings) return '';
            switch (key) {
                case 'defaultPlayMode':
                    return appSettings.playback?.defaultPlayMode || 'sequence';
                case 'defaultRate':
                    return String(appSettings.playback?.defaultRate ?? '1');
                case 'defaultEqPreset':
                    return appSettings.audio?.defaultEqPreset || 'default';
                case 'fontFamily':
                    return appSettings.interface?.fontFamily || 'default';
                case 'language':
                    return getLanguage();
                case 'aiProvider':
                    return appSettings.ai?.provider || 'openai';
                case 'qqPlaybackQuality':
                    return appSettings.quality?.qqPlayback || '320';
                case 'qqDownloadQuality':
                    return appSettings.quality?.qqDownload || 'flac';
                case 'neteasePlaybackQuality':
                    return appSettings.quality?.neteasePlayback || 'exhigh';
                case 'neteaseDownloadQuality':
                    return appSettings.quality?.neteaseDownload || 'lossless';
                case 'kugouPlaybackQuality':
                    return appSettings.quality?.kugouPlayback || '320';
                case 'kugouDownloadQuality':
                    return appSettings.quality?.kugouDownload || 'flac';
                default:
                    return '';
            }
        }

function setSettingValue(key, value) {
            if (!appSettings) return;
            switch (key) {
                case 'defaultPlayMode':
                    if (!appSettings.playback) appSettings.playback = {};
                    appSettings.playback.defaultPlayMode = value;
                    if (typeof setPlayMode === 'function') setPlayMode(value);
                    break;
                case 'defaultRate':
                    if (!appSettings.playback) appSettings.playback = {};
                    appSettings.playback.defaultRate = parseFloat(value) || 1;
                    if (audio) audio.playbackRate = appSettings.playback.defaultRate;
                    break;
                case 'defaultEqPreset':
                    if (!appSettings.audio) appSettings.audio = {};
                    appSettings.audio.defaultEqPreset = value;
                    if (typeof applyEqPreset === 'function') applyEqPreset(value);
                    break;
                case 'fontFamily':
                    if (!appSettings.interface) appSettings.interface = {};
                    appSettings.interface.fontFamily = value;
                    applyFontFamily(value);
                    /* ★ 同步到外观预览引擎，使预览页实时跟随字体切换 */
                    if (typeof previewEngineInstance !== 'undefined' && previewEngineInstance && typeof previewEngineInstance.setModeVar === 'function') {
                        try { previewEngineInstance.setModeVar('fontFamily', value); } catch (e) { logCatch('settingsFontsize', e); }
                    }
                    break;
                case 'language':
                    if (!appSettings.interface) appSettings.interface = {};
                    appSettings.interface.language = value;
                    setLanguage(value);
                    break;
                case 'aiProvider':
                    if (typeof updateAiProviderUI === 'function') {
                        updateAiProviderUI(value);
                    } else {
                        if (!appSettings.ai) appSettings.ai = {};
                        appSettings.ai.provider = value;
                    }
                    break;
                case 'qqPlaybackQuality':
                    if (!appSettings.quality) appSettings.quality = {};
                    appSettings.quality.qqPlayback = value;
                    break;
                case 'qqDownloadQuality':
                    if (!appSettings.quality) appSettings.quality = {};
                    appSettings.quality.qqDownload = value;
                    break;
                case 'neteasePlaybackQuality':
                    if (!appSettings.quality) appSettings.quality = {};
                    appSettings.quality.neteasePlayback = value;
                    break;
                case 'neteaseDownloadQuality':
                    if (!appSettings.quality) appSettings.quality = {};
                    appSettings.quality.neteaseDownload = value;
                    break;
                case 'kugouPlaybackQuality':
                    if (!appSettings.quality) appSettings.quality = {};
                    appSettings.quality.kugouPlayback = value;
                    break;
                case 'kugouDownloadQuality':
                    if (!appSettings.quality) appSettings.quality = {};
                    appSettings.quality.kugouDownload = value;
                    break;
            }
            saveSettings();
        }

export { FONT_BASE_ORIGINAL, FONT_BASE_SUB, applyAllSettings, applyBackgroundSettings, applyHighlightColor, applyInterfaceSettings, applyLyricAlign, applyLyricBlurLevel, applyLyricFontSize, applyModeSettings, applyThemeColor, getSettingValue, setSettingValue };

/* ★ 自定义字体异步注册完成后的重放钩子（由 215-multilang-fonts 触发）：
   boot 时序 applyFontFamily 先于 IndexedDB 字体注册，自定义字体的
   族名解析会失败——注册完成后重跑 applyAllSettings 恢复用户字体设置 */
if (typeof window !== 'undefined') {
    window.__reapplyFontSettings = () => {
        try { applyAllSettings(); } catch (e) { /* 忽略：重放失败不影响首渲 */ }
        /* ★ 视觉引擎容器的 --vis-font-family 是 inline 自定义属性，优先级高于
           根节点同名变量；boot 竞态下它可能已落到「注册前解析的错误回退值」，
           且此后无人再触碰（applyAllSettings 只刷根节点）——用户实测表现：
           霓虹/活字启动后字体与退出时不一致。注册完成后必须重放当前实例的
           settings，让 VisualizerBase 以真族名重写容器 inline 值。 */
        try {
            const mgr = (typeof window !== 'undefined' && window.mainVisManager) ||
                        (typeof mainVisManager !== 'undefined' ? mainVisManager : null);
            if (mgr && mgr.activeInstance && mgr.settings) mgr.applySettings(mgr.settings);
        } catch (e) { /* 忽略 */ }
        try {
            const pe = (typeof window !== 'undefined' && window.previewEngineInstance) ||
                       (typeof previewEngineInstance !== 'undefined' ? previewEngineInstance : null);
            if (pe && typeof pe.setModeVar === 'function') {
                const cm = pe.currentMode || (typeof currentViewMode !== 'undefined' ? currentViewMode : 'cover');
                const ms = (typeof appSettings !== 'undefined' && appSettings.modeSettings && appSettings.modeSettings[cm]) || null;
                const mf = (ms && ms.fontFamily && ms.fontFamily !== 'default' && ms.fontFamily !== 'inherit')
                    ? ms.fontFamily
                    : ((appSettings.interface && appSettings.interface.fontFamily) || 'default');
                pe.setModeVar('fontFamily', mf);
            }
        } catch (e) { /* 忽略 */ }
    };
}
