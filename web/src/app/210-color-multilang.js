/* ============================================================
 * 210-color-multilang.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 12646-13003 行 | 单元数: 10
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { FONT_FAMILY_MAP } from './10-config-state.js';
import { applyAdvancedFonts, removeAdvancedFontFaces } from './215-multilang-fonts.js';

function bindColorRow(containerId, currentColor, onChange) {
            const container = typeof document !== 'undefined' ? document.getElementById(containerId) : null;
            if (!container) return;
            const swatches = container.querySelectorAll('.color-swatch');
            let customColor = currentColor;
            let matched = false;
            swatches.forEach(sw => {
                if (sw.dataset.color === currentColor) { sw.classList.add('active'); matched = true; }
                sw?.addEventListener('click', () => {
                    if (sw.dataset.color === '__custom__') {
                        openColorPicker(customColor, (color) => {
                            customColor = color;
                            swatches.forEach(s => s.classList.remove('active'));
                            sw.classList.add('active');
                            onChange(color);
                        });
                    } else {
                        swatches.forEach(s => s.classList.remove('active'));
                        sw.classList.add('active');
                        onChange(sw.dataset.color);
                    }
                });
            });
            if (!matched) {
                const customSw = container.querySelector('.color-swatch.custom');
                if (customSw) { customSw.classList.add('active'); customColor = currentColor; }
            }
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

export { applyFontFamily, applyGlassStrength, bindColorRow, hexToHsv, hsvToRgb, openColorPicker, resolveFontFamily, rgbToHex };
