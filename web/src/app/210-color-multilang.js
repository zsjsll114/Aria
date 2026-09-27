/* ============================================================
 * 210-color-multilang.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 12646-13003 行 | 单元数: 10
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { FONT_FAMILY_MAP } from './10-config-state.js';
import { applyAdvancedFonts, removeAdvancedFontFaces } from './215-multilang-fonts.js';
import { CUSTOM_SWATCH_SVG, PALETTES } from '../config/themePalette.js';
import { logCatch } from '../services/log.js';

/* ============================================================
 * 色板行水合：index.html 里只写 <div class="setting-color-row"
 * data-var="highlightColor" data-palette="accent+white" data-active="#ffffff">，
 * 色值一颗都不出现在 HTML。
 *
 * 原先 17 行各自内联 5~7 颗 .color-swatch + 同一个 12 路径彩虹 SVG（那份 SVG
 * 复制了 15 遍，index.html 因此多出约 60KB），改一个颜色要动 17 处。
 *
 * ★ active 只是「JS 还没跑时的默认显示」：真正的选中态由 syncModeSectionValues /
 *   syncColorRowActive / syncGlobalThemeSwatches 从 appSettings 反推，会覆盖这里。
 * ★ 水合会整体替换 row.innerHTML ⇒ 绑在旧节点上的监听全灭，所以下面的点击
 *   一律走 document 级委托，绝不回到「拿节点挂 click」。
 * ============================================================ */
export function hydrateColorRows(root = (typeof document !== 'undefined' ? document : null)) {
    if (!root || typeof document === 'undefined') return 0;
    const rows = root.querySelectorAll('.setting-color-row[data-palette]');
    let n = 0;
    rows.forEach(row => {
        try {
            const kind = row.dataset.palette;
            const colors = PALETTES[kind];
            if (!colors) { logCatch('colorMultilang', new Error(`未知 data-palette="${kind}"`)); return; }
            if (row.dataset.hydrated === '1') return;   /* 幂等：重开面板不重复插 */
            row.dataset.hydrated = '1';
            const varName = row.dataset.var || '';
            const active = row.dataset.active || '';
            const sw = (color, extraClass) => '<div class="color-swatch' + (extraClass || '')
                + '" data-var="' + varName + '" data-color="' + color
                + '" style="background:' + color + '"></div>';
            row.innerHTML = colors.map(c => sw(c, c === active ? ' active' : '')).join('')
                + '<div class="color-swatch custom' + (active === '__custom__' ? ' active' : '')
                + '" data-var="' + varName + '" data-color="__custom__" title="自定义颜色">'
                + CUSTOM_SWATCH_SVG + '</div>';
            n++;
        } catch (e) { logCatch('colorMultilang', e); }
    });
    return n;
}
hydrateColorRows();

/* ============================================================
 * 预设色块：全仓唯一一处 .color-swatch 点击委托
 *
 * 为什么是委托（2026-09-26 修「设置→外观里 17/18 预设色块点了没反应」）：
 * 旧写法是 `document.getElementById(containerId)` 找容器再给每颗色块挂 click。
 * 约束 22 的色板重构把 index.html 那些行的外层 id 换成了
 * `<div class="setting-color-row" data-var="…" data-palette="…">`，容器 id 全没了，
 * bindColorRow 四次调用里三次当场静默 return（`if (!container) return;`）——
 * 症状不是报错而是「点了没反应」，正是约束 9 要禁的那类静默失败。
 * 委托之后：写入目标由**行自己声明**的 data-var + 是否处在 [data-mode-section]
 * 里决定，水合、重渲染、新增行都不需要重新绑，也不存在「改个 id 整行失效」的死角。
 *
 * 解析不出写入目标时一律 logCatch（约束 9），不再静默。
 * ============================================================ */

/** 由 200-settings-panel.js 注入的读写通道：mode 为 null 表示全局设置 */
let colorChannel = null;

/**
 * 注册色块的读写目标。
 * @param {{read:(field:string, mode:string|null)=>string,
 *          write:(field:string, mode:string|null, value:string)=>void}} channel
 */
export function setColorSwatchChannel(channel) {
    colorChannel = (channel && typeof channel.write === 'function') ? channel : null;
    if (!colorChannel) logCatch('colorMultilang', new Error('setColorSwatchChannel 收到无效的写入通道'));
}

/** 把一行里「哪颗色块算当前值」的 active 态摆正；值不在预设里就点亮「自定义」那颗 */
function applyRowActive(row, currentColor) {
    let matched = false;
    row.querySelectorAll('.color-swatch').forEach(sw => {
        const isMatch = sw.dataset.color === currentColor;
        sw.classList.toggle('active', isMatch);
        if (isMatch) matched = true;
    });
    if (!matched) {
        const customSw = row.querySelector('.color-swatch.custom');
        if (customSw) customSw.classList.add('active');
    }
}

/**
 * 同步某字段所有色板行的选中态（原 bindColorRow 留下的那半行为，容器 id 已不再需要）。
 * @param field  写入字段名（data-var）
 * @param mode   所属视图模式；null = 全局（不在 [data-mode-section] 内的行）
 * @param currentColor 当前值
 */
export function syncColorRowActive(field, mode, currentColor) {
    if (typeof document === 'undefined' || !field) return 0;
    const wantMode = mode || null;
    let n = 0;
    document.querySelectorAll('.setting-color-row[data-var="' + field + '"]').forEach(row => {
        const sec = row.closest('[data-mode-section]');
        const rowMode = sec ? (sec.dataset.modeSection || null) : null;
        if (rowMode !== wantMode) return;
        applyRowActive(row, currentColor);
        n++;
    });
    return n;
}

/** 从被点的色块反推「该写哪儿」：字段名 + 模式。解析不出来就抛，交给调用方留痕。 */
function resolveSwatchTarget(swatch) {
    const row = swatch.closest('.setting-color-row');
    if (!row) throw new Error('色块不在 .setting-color-row 内: ' + (swatch.dataset.color || ''));
    const field = row.dataset.var || swatch.dataset.var || '';
    if (!field) {
        throw new Error('色板行缺 data-var，无法确定写入字段: ' + (row.id || row.className));
    }
    const sec = row.closest('[data-mode-section]');
    return { row, field, mode: sec ? (sec.dataset.modeSection || null) : null };
}

function commitSwatch(row, field, mode, color) {
    /* 先写再亮：写入抛错时 active 留在原来那颗上，界面不会比配置更乐观 */
    colorChannel.write(field, mode, color);
    applyRowActive(row, color);
}

function onColorSwatchClick(e) {
    const swatch = e.target && typeof e.target.closest === 'function'
        ? e.target.closest('.color-swatch') : null;
    if (!swatch) return;
    try {
        if (!colorChannel) throw new Error('颜色写入通道未注册（setColorSwatchChannel 没被调用）');
        const { row, field, mode } = resolveSwatchTarget(swatch);
        if (swatch.dataset.color === '__custom__') {
            const cur = String(colorChannel.read ? (colorChannel.read(field, mode) || '') : '');
            const init = cur.startsWith('#') && cur.length === 7 ? cur : '#ffffff';
            openColorPicker(init, (color) => {
                try { commitSwatch(row, field, mode, color); }
                catch (err) { logCatch('colorMultilang', err); }
            });
            return;
        }
        commitSwatch(row, field, mode, swatch.dataset.color);
    } catch (err) { logCatch('colorMultilang', err); }
}

if (typeof document !== 'undefined') {
    document.addEventListener('click', onColorSwatchClick);
}

/* ========== 调色板弹出框（自绘 HSV 取色器） ========== */
globalThis.colorPickerCallback = null;

function hsvToRgb(h, s, v) {
            const c = v * s;
            const x = c * (1 - Math.abs((h / 60) % 2 - 1));
            const m = v - c;
            let r, g, b;
            if (h < 60) { r=c; g=x; b=0; }
            else if (h < 120) { r=x; g=c; b=0; }
            else if (h < 180) { r=0; g=c; b=x; }
            else if (h < 240) { r=0; g=x; b=c; }
            else if (h < 300) { r=x; g=0; b=c; }
            else { r=c; g=0; b=x; }
            return [Math.round((r+m)*255), Math.round((g+m)*255), Math.round((b+m)*255)];
        }

function rgbToHex(r, g, b) {
            return '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
        }

function hexToHsv(hex) {
            const r = parseInt(hex.slice(1,3),16)/255;
            const g = parseInt(hex.slice(3,5),16)/255;
            const b = parseInt(hex.slice(5,7),16)/255;
            const max = Math.max(r,g,b), min = Math.min(r,g,b);
            const d = max - min;
            let h = 0;
            if (d !== 0) {
                if (max === r) h = ((g-b)/d) % 6;
                else if (max === g) h = (b-r)/d + 2;
                else h = (r-g)/d + 4;
                h *= 60; if (h < 0) h += 360;
            }
            const s = max === 0 ? 0 : d / max;
            const v = max;
            return [h, s, v];
        }

function openColorPicker(initialColor, callback) {
            const overlay = typeof document !== 'undefined' ? document.getElementById('colorPickerOverlay') : null;
            const hexInput = typeof document !== 'undefined' ? document.getElementById('colorPickerHex') : null;
            const preview = typeof document !== 'undefined' ? document.getElementById('hsvPreview') : null;
            const svCanvas = typeof document !== 'undefined' ? document.getElementById('hsvSvCanvas') : null;
            const hueCanvas = typeof document !== 'undefined' ? document.getElementById('hsvHueCanvas') : null;
            const closeBtn = typeof document !== 'undefined' ? document.getElementById('colorPickerCloseBtn') : null;
            const svCtx = svCanvas.getContext('2d');
            const hueCtx = hueCanvas.getContext('2d');
            colorPickerCallback = callback;

            /* 同步 canvas 内部分辨率与 CSS 显示尺寸，避免圆形指示器被拉伸成椭圆 */
            const syncCanvasSize = () => {
                const svRect = svCanvas.getBoundingClientRect();
                const dpr = window.devicePixelRatio || 1;
                svCanvas.width = Math.round(svRect.width * dpr);
                svCanvas.height = Math.round(svRect.height * dpr);
                svCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
                const hueRect = hueCanvas.getBoundingClientRect();
                hueCanvas.width = Math.round(hueRect.width * dpr);
                hueCanvas.height = Math.round(hueRect.height * dpr);
                hueCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
            };

            let [hue, sat, val] = hexToHsv(initialColor);
            let currentColor = initialColor;

            function drawSV() {
                const rect = svCanvas.getBoundingClientRect();
                const w = rect.width, h = rect.height;
                const baseRgb = hsvToRgb(hue, 1, 1);
                const baseHex = rgbToHex(...baseRgb);
                const gradH = svCtx.createLinearGradient(0, 0, w, 0);
                gradH.addColorStop(0, '#ffffff');
                gradH.addColorStop(1, baseHex);
                svCtx.fillStyle = gradH;
                svCtx.fillRect(0, 0, w, h);
                const gradV = svCtx.createLinearGradient(0, 0, 0, h);
                gradV.addColorStop(0, 'rgba(0,0,0,0)');
                gradV.addColorStop(1, 'rgba(0,0,0,1)');
                svCtx.fillStyle = gradV;
                svCtx.fillRect(0, 0, w, h);
                /* 指示器 */
                const cx = sat * w, cy = (1 - val) * h;
                svCtx.beginPath();
                svCtx.arc(cx, cy, 7, 0, Math.PI * 2);
                svCtx.strokeStyle = '#fff';
                svCtx.lineWidth = 2.5;
                svCtx.stroke();
                svCtx.beginPath();
                svCtx.arc(cx, cy, 7, 0, Math.PI * 2);
                svCtx.strokeStyle = 'rgba(0,0,0,0.4)';
                svCtx.lineWidth = 1;
                svCtx.stroke();
            }
            function drawHue() {
                const rect = hueCanvas.getBoundingClientRect();
                const w = rect.width, h = rect.height;
                const grad = hueCtx.createLinearGradient(0, 0, w, 0);
                for (let i = 0; i <= 6; i++) {
                    grad.addColorStop(i / 6, rgbToHex(...hsvToRgb(i * 60, 1, 1)));
                }
                hueCtx.fillStyle = grad;
                hueCtx.fillRect(0, 0, w, h);
                /* 指示器 */
                const hx = (hue / 360) * w;
                hueCtx.fillStyle = '#fff';
                hueCtx.fillRect(hx - 3, -1, 6, h + 2);
                hueCtx.fillStyle = 'rgba(0,0,0,0.5)';
                hueCtx.fillRect(hx - 1, 0, 2, h);
            }
            function updateColor() {
                const [r, g, b] = hsvToRgb(hue, sat, val);
                currentColor = rgbToHex(r, g, b);
                hexInput.value = currentColor.toUpperCase();
                preview.style.background = currentColor;
                drawSV();
                drawHue();
            }

            /* SV 画布交互 */
            function onSvPointer(e) {
                const rect = svCanvas.getBoundingClientRect();
                const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
                sat = x; val = 1 - y;
                updateColor();
            }
            let svDragging = false;
            function onSvDown(e) { svDragging = true; onSvPointer(e); e.preventDefault(); }
            function onSvMove(e) { if (svDragging) onSvPointer(e); }
            function onSvUp() { svDragging = false; }

            /* Hue 画布交互 */
            function onHuePointer(e) {
                const rect = hueCanvas.getBoundingClientRect();
                const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                hue = x * 360;
                updateColor();
            }
            let hueDragging = false;
            function onHueDown(e) { hueDragging = true; onHuePointer(e); e.preventDefault(); }
            function onHueMove(e) { if (hueDragging) onHuePointer(e); }
            function onHueUp() { hueDragging = false; }

            /* Hex 输入 */
            function onHexInput() {
                let v = hexInput.value.trim();
                if (!v.startsWith('#')) v = '#' + v;
                if (/^#[0-9a-fA-F]{6}$/.test(v)) {
                    [hue, sat, val] = hexToHsv(v);
                    currentColor = v.toLowerCase();
                    preview.style.background = currentColor;
                    drawSV();
                    drawHue();
                }
            }

            function closePicker() {
                overlay.classList.remove('visible');
                if (colorPickerCallback) { colorPickerCallback(currentColor); colorPickerCallback = null; }
                svCanvas.removeEventListener('pointerdown', onSvDown);
                document.removeEventListener('pointermove', onSvMove);
                document.removeEventListener('pointerup', onSvUp);
                hueCanvas.removeEventListener('pointerdown', onHueDown);
                document.removeEventListener('pointermove', onHueMove);
                document.removeEventListener('pointerup', onHueUp);
                hexInput.removeEventListener('input', onHexInput);
                closeBtn.removeEventListener('click', closePicker);
                overlay.removeEventListener('click', onOverlayClick);
                document.removeEventListener('keydown', onEsc);
            }
            function onOverlayClick(e) { if (e.target === overlay) closePicker(); }
            function onEsc(e) { if (e.key === 'Escape') closePicker(); }

            svCanvas?.addEventListener('pointerdown', onSvDown);
            if (typeof document !== "undefined") document.addEventListener('pointermove', onSvMove);
            if (typeof document !== "undefined") document.addEventListener('pointerup', onSvUp);
            hueCanvas?.addEventListener('pointerdown', onHueDown);
            if (typeof document !== "undefined") document.addEventListener('pointermove', onHueMove);
            if (typeof document !== "undefined") document.addEventListener('pointerup', onHueUp);
            hexInput?.addEventListener('input', onHexInput);
            closeBtn?.addEventListener('click', closePicker);
            overlay?.addEventListener('click', onOverlayClick);
            if (typeof document !== "undefined") document.addEventListener('keydown', onEsc);

            /* 先显示 overlay，再同步 canvas 尺寸并绘制（display:none 时 getBoundingClientRect 为 0） */
            overlay.classList.add('visible');
            syncCanvasSize();
            updateColor();
        }

function applyGlassStrength(strength) {
            let style = document.getElementById('glass-style');
            if (!style) {
                style = document.createElement('style');
                style.id = 'glass-style';
                document.head.appendChild(style);
            }
            style.textContent = `
                .search-overlay, .settings-overlay {
                    backdrop-filter: saturate(180%) blur(${Math.round(strength * 0.6)}px) !important;
                    -webkit-backdrop-filter: saturate(180%) blur(${Math.round(strength * 0.6)}px) !important;
                }
                .search-modal, .ctx-menu, .eq-panel, .settings-panel, .setting-dropdown-menu {
                    backdrop-filter: saturate(200%) blur(${strength}px) !important;
                    -webkit-backdrop-filter: saturate(200%) blur(${strength}px) !important;
                }
            `;
        }

/* 全局字体应用 */
function resolveFontFamily(fontKey) {
            if (!fontKey || fontKey === 'default' || fontKey === 'inherit') {
                return "'Segoe UI', 'Microsoft YaHei', sans-serif";
            }
            const cfList = (customFonts && Object.keys(customFonts).length > 0) 
                ? customFonts 
                : ((typeof window !== 'undefined' && window.customFonts) ? window.customFonts : {});
            if (cfList) {
                if (cfList[fontKey]) {
                    const cf = cfList[fontKey];
                    return `'${cf.family}', '${cf.label}', sans-serif`;
                }
                const match = Object.values(cfList).find(c => 
                    c.key === fontKey || 
                    c.family === fontKey || 
                    c.label === fontKey || 
                    c.fileName === fontKey ||
                    (c.label && fontKey && c.label.toLowerCase() === fontKey.toLowerCase())
                );
                if (match) {
                    return `'${match.family}', '${match.label}', sans-serif`;
                }
            }
            if (FONT_FAMILY_MAP && FONT_FAMILY_MAP[fontKey]) {
                return FONT_FAMILY_MAP[fontKey];
            }
            /* ★ custom 前缀键 = 自定义字体管理器注册的自定义字体。表里没有却命中此处，
               只可能是 boot 竞态（IndexedDB 注册未完成）或字体已被删除——键名不是可用的
               系统族名，按旧回退会产出 'custom_xxx', sans-serif 这类永不命中的死值，
               落进视觉容器的 inline 变量后无人再纠正（启动字体随机的根源之一）。
               直接回退默认链，注册完成后的 __reapplyFontSettings 重放会写入真族名。 */
            if (/^custom/i.test(fontKey)) {
                return "'Segoe UI', 'Microsoft YaHei', sans-serif";
            }
            if (fontKey.includes("'") || fontKey.includes(',') || fontKey.includes('sans-serif') || fontKey.includes('serif')) {
                return fontKey;
            }
            return `'${fontKey}', sans-serif`;
        }

if (typeof window !== 'undefined') {
            window.resolveFontFamily = resolveFontFamily;
            window.customFonts = customFonts;
        }

function applyFontFamily(font) {
            let ff = resolveFontFamily(font);
            document.documentElement.style.setProperty('--app-font-family', ff);
            document.documentElement.style.setProperty('--pv-font-family', ff);
            document.documentElement.style.setProperty('--vis-font-family', ff);

            /* 高级字体设置优先：按语言 Unicode 范围注入 @font-face */
            const adv = appSettings.interface && appSettings.interface.advancedFonts;
            if (adv && adv.enabled) {
                applyAdvancedFonts();
                return;
            }

            /* 未开启高级设置：移除旧的多语言 @font-face，使用全局字体 */
            removeAdvancedFontFaces();
            let style = document.getElementById('font-family-style');
            if (!style) {
                style = document.createElement('style');
                style.id = 'font-family-style';
                document.head.appendChild(style);
            }
            style.textContent = `
                body, button, input, select, textarea, .song-title, .song-artist, .song-album, .playlist-name, .playlist-track-title {
                    font-family: var(--app-font-family);
                }
                .player-container,
                .player-container *,
                .lyrics-container,
                .lyrics-container *,
                .scroll-container,
                .scroll-container *,
                .line,
                .line *,
                .lrc-original,
                .lrc-translation,
                .lrc-romaji,
                .words-container,
                .words-container *,
                .word,
                .word *,
                .word-highlight,
                .pv-poster-container,
                .pv-poster-container *,
                .pv-poster-line,
                .pv-word-block,
                .pv-char,
                .pv-bg-text,
                .vis-dimension-stage,
                .vis-dimension-stage *,
                .dim-line,
                .dim-char,
                .dim-word {
                    font-family: var(--app-font-family) !important;
                }
                .preview-player,
                .preview-player * {
                    font-family: var(--preview-font-family, var(--app-font-family)) !important;
                }
                .settings-overlay, .settings-overlay *,
                .settings-panel, .settings-panel *,
                .settings-body, .settings-body *,
                .dropdown-menu, .dropdown-menu *,
                .context-menu, .context-menu *,
                .modal, .modal * {
                    font-family: var(--app-font-family) !important;
                }
                /* ★ 弹层界面（搜索/听歌识曲/歌单/收藏/导入/欢迎页/视图切换/
                 *   均衡器/AI模型/歌词源/取色器/全局提示）同样跟随字体设置 */
                .search-overlay, .search-overlay *,
                .welcome-overlay, .welcome-overlay *,
                .view-mode-overlay, .view-mode-overlay *,
                .eq-panel, .eq-panel *,
                .ai-models-overlay, .ai-models-overlay *,
                .lyric-source-overlay, .lyric-source-overlay *,
                .color-picker-overlay, .color-picker-overlay *,
                .global-floating-toast, .global-floating-toast * {
                    font-family: var(--app-font-family) !important;
                }
            `;
        }

export { applyFontFamily, applyGlassStrength, hexToHsv, hsvToRgb, openColorPicker, resolveFontFamily, rgbToHex };
