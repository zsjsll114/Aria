/**
 * core/themeEngine.js — 主题色彩引擎
 * 封面颜色提取、CSS 变量管理、AI 动态主题应用、情感词着色
 */
import { state } from '../infrastructure/state.js';
import { dom, getBlurBgLayers, getCoverLayers } from '../infrastructure/dom.js';
import { refineColor, rgbToHsl, hslToRgb } from '../utils/colorUtils.js';

/* ★ 嶌新的倍率字号系统 */
const FONT_BASE_ORIGINAL = 24;
const FONT_BASE_SUB = 16;

export function applyLyricFontSize(size) {
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
    if (!style) { style = document.createElement('style'); style.id = 'lyric-font-style'; document.head.appendChild(style); }
    /* ★ 仅作用于主播放器，不污染预览引擎 (.preview-player) */
    style.textContent = `
        .player-container:not(.preview-player) .lrc-original { --font-size: ${originalSize} !important; font-size: ${originalSize} !important; }
        .player-container:not(.preview-player) .lrc-romaji,
        .player-container:not(.preview-player) .lrc-translation { --font-size: ${subSize} !important; font-size: ${subSize} !important; }
    `;
}

export function applyLyricBlurLevel(level) {
    let style = document.getElementById('lyric-blur-style');
    if (!style) { style = document.createElement('style'); style.id = 'lyric-blur-style'; document.head.appendChild(style); }
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

export function applyHighlightColor(color) {
    const l = state.appSettings.lyrics;
    const highlightColor = color || l.highlightColor;
    const highlightInactiveColor = l.highlightInactiveColor;
    const inactiveColor = l.inactiveColor;
    const align = l.align || 'left';
    const transformOrigin = align === 'left' ? 'left center' : align === 'right' ? 'right center' : 'center center';
    const timePosition = align === 'right' ? '.line .line-time { left: 15px; right: auto; }' : '.line .line-time { right: 15px; left: auto; }';
    let style = document.getElementById('lyric-highlight-style');
    if (!style) { style = document.createElement('style'); style.id = 'lyric-highlight-style'; document.head.appendChild(style); }
    style.textContent = `
        .word-highlight { color: ${highlightColor} !important; }
        .line.active .lrc-original { color: ${highlightColor} !important; }
        .line .word { color: ${highlightInactiveColor}; }
        .line.active .word { color: ${highlightInactiveColor}; }
        .line.active .word-highlight { color: ${highlightColor} !important; }
        .line:not(.active) .lrc-original { color: ${inactiveColor}; }
        .lrc-original { text-align: ${align}; }
        .lrc-romaji { text-align: ${align}; }
        .lrc-translation { text-align: ${align}; }
        .line.active .lrc-original, .line.active .lrc-romaji, .line.active .lrc-translation {
            transform: scale(1.06); transform-origin: ${transformOrigin};
        }
        ${timePosition}
    `;
}

export function applyBackgroundSettings() {
    const b = state.appSettings.background;
    if (!b) return;
    const layers = getBlurBgLayers();
    layers.forEach(layer => {
        if (b.swayEnabled) {
            layer.style.setProperty('--bg-scale', '1.1');
            layer.style.setProperty('--bg-sway-amp', `${b.swayAmp}px`);
            layer.style.setProperty('--bg-sway-duration', `${b.swayDuration}s`);
            layer.classList.add('sway-enabled');
        } else {
            layer.style.setProperty('--bg-scale', '1.1');
            layer.classList.remove('sway-enabled');
        }
        layer.style.filter = `blur(${b.blur}px) brightness(${b.brightness})`;
    });
}

export function applyInterfaceSettings() {
    const i = state.appSettings.interface;
    if (!i) return;
    document.documentElement.style.setProperty('--glass-strength', `${i.glassStrength}px`);
    document.documentElement.style.setProperty('--lyric-radius', `${i.lyricRadius}px`);
    if (i.themeColor) {
        document.documentElement.style.setProperty('--theme-color', i.themeColor);
        const r = parseInt(i.themeColor.slice(1, 3), 16);
        const g = parseInt(i.themeColor.slice(3, 5), 16);
        const b = parseInt(i.themeColor.slice(5, 7), 16);
        document.documentElement.style.setProperty('--theme-color-rgb', `${r}, ${g}, ${b}`);
    }
}

/**
 * 从封面图片提取主色调
 * @param {string} imgUrl - 图片 URL
 * @returns {Promise<string|null>} hex 颜色值
 */
export function extractMainColor(imgUrl) {
    return new Promise((resolve) => {
        if (!imgUrl) { resolve(null); return; }
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                const w = 50, h = 50;
                canvas.width = w; canvas.height = h;
                ctx.drawImage(img, 0, 0, w, h);
                const data = ctx.getImageData(0, 0, w, h).data;
                let r = 0, g = 0, b = 0, count = 0;
                for (let i = 0; i < data.length; i += 4) {
                    if (data[i + 3] < 128) continue;
                    r += data[i]; g += data[i + 1]; b += data[i + 2]; count++;
                }
                if (count === 0) { resolve(null); return; }
                r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count);
                resolve(`#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`);
            } catch (e) { resolve(null); }
        };
        img.onerror = () => resolve(null);
        img.src = imgUrl;
    });
}

/**
 * 应用 AI 主题（严格限制仅提取情感词并着色，不改动全局主题色与默认视图动画）
 * @param {Object} themeObj - AI 返回的主题对象
 */
export function applyAITheme(themeObj) {
    if (!themeObj) return;

    /* 清理遗留的全局侵入式样式 */
    document.body.classList.remove(
        'ai-text-shadow-low', 'ai-text-shadow-medium', 'ai-text-shadow-high',
        'ai-theme-breathing', 'ai-theme-floating', 'ai-theme-glitch', 'ai-theme-smooth', 'ai-theme-flyin'
    );
    const existingWireframes = document.getElementById('ai-flyin-wireframes');
    if (existingWireframes) existingWireframes.remove();
    const existingBlur = document.getElementById('ai-lyric-blur-style');
    if (existingBlur) existingBlur.remove();

    /* 情感关键词着色 */
    state.aiEmotionWords = Array.isArray(themeObj.emotion_words) ? themeObj.emotion_words : [];
    applyEmotionWordColors();

    state.currentAiTheme = themeObj;
}

/**
 * 将歌词中富有感情色彩的词语染上对应颜色
 */
export function applyEmotionWordColors() {
    if (!state.aiEmotionWords || state.aiEmotionWords.length === 0) return;

    /* 添加情感词着色 CSS */
    let emotionStyle = document.getElementById('ai-emotion-word-style');
    if (!emotionStyle) {
        emotionStyle = document.createElement('style');
        emotionStyle.id = 'ai-emotion-word-style';
        document.head.appendChild(emotionStyle);
    }
    let css = '';
    state.aiEmotionWords.forEach((item, idx) => {
        if (item.word && item.color) {
            css += `.word-emotion-${idx} { color: ${item.color} !important; }\n`;
            css += `.word-emotion-${idx} .word-highlight { color: ${item.color} !important; }\n`;
        }
    });
    emotionStyle.textContent = css;

    /* 遍历歌词 DOM，标记匹配的情感词 */
    state.lineElements.forEach((lineEl, lineIdx) => {
        const words = state.wordElementsByLine[lineIdx] || [];
        if (words.length === 0) return;

        /* 拼接行内所有 word 的文本 */
        const fullText = words.map(w => w.textContent).join('');
        let searchOffset = 0;

        state.aiEmotionWords.forEach((item, eIdx) => {
            if (!item.word) return;
            let searchPos = 0;
            while (searchPos < fullText.length) {
                const foundIdx = fullText.indexOf(item.word, searchPos);
                if (foundIdx === -1) break;

                /* 映射 foundIdx 回各个 word 元素 */
                let charCount = 0;
                for (let wi = 0; wi < words.length; wi++) {
                    const wordText = words[wi].textContent;
                    const wordStart = charCount;
                    const wordEnd = charCount + wordText.length;
                    if (foundIdx >= wordStart && foundIdx < wordEnd) {
                        /* 这个 word 元素包含情感词的起始 */
                        let remaining = item.word.length;
                        let currentWi = wi;
                        let currentCharInWord = foundIdx - wordStart;
                        while (remaining > 0 && currentWi < words.length) {
                            const wText = words[currentWi].textContent;
                            const charsAvailable = wText.length - currentCharInWord;
                            const charsToMark = Math.min(remaining, charsAvailable);
                            words[currentWi].classList.add(`word-emotion-${eIdx}`);
                            remaining -= charsToMark;
                            currentWi++;
                            currentCharInWord = 0;
                        }
                        break;
                    }
                    charCount += wordText.length;
                }
                searchPos = foundIdx + item.word.length;
            }
        });
    });
}
