/* ============================================================
 * 56-playback-misc.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 794-1051 行 | 单元数: 4
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { audio } from './20-lyrics-render.js';
import { updateWordcloudCamera } from './57-wordcloud-camera.js';

/* ========== 获取时长 ========== */
function getDuration() {
            if (audio.duration && !isNaN(audio.duration)) {
                return audio.duration * 1000;
            }
            return 0;
        }

/* ========== 飞入模式：更新底部翻译/罗马音区域 ========== */
function updateFlyinTranslation(lineIndex) {
            const flyinArea = typeof document !== 'undefined' ? document.getElementById('flyinTranslationArea') : null;
            if (!flyinArea) return;
            const flyinTrans = typeof document !== 'undefined' ? document.getElementById('flyinTranslation') : null;
            const flyinRoma = typeof document !== 'undefined' ? document.getElementById('flyinRomaji') : null;
            const line = lyrics[lineIndex];
            if (!line) return;

            /* 先淡出，再更新内容，再淡入。
               ★ 2026-09-27：此前完全无视双语排版开关（appSettings.lyrics.showTranslation/
               showRomaji），只要有译文/罗马音就无脑塞——bilingualCycleBtn（285）切
               「只看原文」时底栏上方的翻译/罗马音区纹丝不动，用户报「按钮没用」。
               现与主歌词行（20-lyrics-render:383/390 读同一组键）保持同判定。
               两类内容都被关掉时整个区域淡出，不留空占位。 */
            flyinArea.style.opacity = '0';
            setTimeout(() => {
                const ly = (globalThis.appSettings && globalThis.appSettings.lyrics) || {};
                const hasTrans = !!ly.showTranslation && !!(line.translation && line.translation.trim() !== '//');
                const hasRoma = !!ly.showRomaji && !!(line.romaji && line.romaji.trim());
                if (flyinTrans) flyinTrans.textContent = hasTrans ? line.translation : '';
                if (flyinRoma) flyinRoma.textContent = hasRoma ? line.romaji : '';
                flyinArea.style.opacity = (hasTrans || hasRoma) ? '1' : '0';
            }, 300);
        }

/* ========== 飞入模式：动态缩放字体以适配可用高度 ========== */
let _flyinResizeTimer = 0;
function flyinAutoScaleFont(targetLineEl = null) {
            const container = typeof document !== 'undefined' ? document.querySelector('.lyrics-container') : null;
            if (!container) return;
            const flyinArea = typeof document !== 'undefined' ? document.getElementById('flyinTranslationArea') : null;
            /* ★ 2026-11-19：优先定位当前 activeLineIndex 对应行，绝不盲目用 querySelector('.view-flyin .line.active')
               命中残留的旧 .line.active，彻底根治后台切回后飞入模式后续行全部不缩放/变小的 bug。 */
            const activeLine = targetLineEl
                || (typeof activeLineIndex === 'number' && activeLineIndex >= 0 && Array.isArray(lineElements) && lineElements[activeLineIndex])
                || (typeof document !== 'undefined' ? document.querySelector('.view-flyin .line.active') : null);
            if (!activeLine) return;
            const lrcEl = activeLine.querySelector('.lrc-original');
            if (!lrcEl) return;

            /* 后台最小化/极小视口保护：容器尺寸未恢复时绝不把字号锁死成 32px */
            const viewW = container.clientWidth;
            const viewH = container.clientHeight;
            if (!viewW || !viewH || viewW < 80 || viewH < 80) return;

            /* 若目标行尚处于虚拟滚动占位态（例如切后台跳行后刚恢复），先解除占位再测量自然宽高 */
            if (activeLine.dataset.virtual === 'true' || activeLine.classList.contains('line-placeholder')) {
                activeLine.dataset.virtual = 'false';
                activeLine.classList.remove('line-placeholder');
                lrcEl.style.display = '';
            }

            /* 计算可用高度：容器高度 - 最小边距 */
            /* 顶部留 20px，底部根据翻译区高度 + 20px 余量 */
            const topReserved = 20;
            let bottomReserved = flyinArea ? flyinArea.offsetHeight + 20 : 80;
            const maxH = viewH - topReserved - bottomReserved;
            if (maxH < 60) return;

            /* ★ 飞入模式巨幕海报大字基准：1.0x ≥ 原 5x 体量，短句爆发全屏视觉冲击，
               长句按可用宽高比平滑缩放适配 */
            let userScale = 1.0;
            const flyinMs = (globalThis.appSettings && globalThis.appSettings.modeSettings && globalThis.appSettings.modeSettings.flyin);
            if (flyinMs && flyinMs.fontSize !== undefined) {
                userScale = parseFloat(flyinMs.fontSize) || 1.0;
            } else if (globalThis.appSettings && globalThis.appSettings.lyrics && globalThis.appSettings.lyrics.fontSize !== undefined) {
                userScale = parseFloat(globalThis.appSettings.lyrics.fontSize) || 1.0;
            }
            if (userScale > 3) userScale = userScale / 24; // 兼容旧像素值

            const heroBase = Math.max(240, Math.min(420, viewW * 0.28));
            const targetSize = Math.round(heroBase * userScale);

            /* 一次测量自然宽高 → 超出可用框时自适应线性收缩，短句享受完整巨幕字号 */
            lrcEl.style.fontSize = targetSize + 'px';
            lrcEl.style.maxHeight = 'none';
            lrcEl.style.overflow = 'visible';
            void lrcEl.offsetHeight;
            const naturalHeight = lrcEl.scrollHeight;
            const maxW = viewW * 0.94;
            const naturalWidth = lrcEl.scrollWidth;

            if (naturalHeight > maxH || naturalWidth > maxW) {
                const shrinkH = naturalHeight > maxH ? (maxH / naturalHeight) * 0.94 : 1;
                const shrinkW = naturalWidth > maxW ? (maxW / naturalWidth) * 0.94 : 1;
                const shrink = Math.max(0.14, Math.min(1.0, shrinkH, shrinkW));
                lrcEl.style.fontSize = Math.max(32, Math.round(targetSize * shrink)) + 'px';
            }
            lrcEl.style.maxHeight = maxH + 'px';
            lrcEl.style.overflow = 'visible';
        }

if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => {
        const pc = document.querySelector('.player-container');
        if (!pc || !pc.classList.contains('view-flyin')) return;
        if (_flyinResizeTimer) clearTimeout(_flyinResizeTimer);
        _flyinResizeTimer = setTimeout(() => {
            _flyinResizeTimer = 0;
            flyinAutoScaleFont();
        }, 80);
    }, { passive: true });
}

/* ========== 词云模式：2D 螺旋排版算法 ==========
         * 将所有歌词行以不同字号错落排布在虚拟矩形画布内，
         * 使用螺旋搜索 + AABB 碰撞检测确保各行绝对不重叠。
         */
function layoutWordCloud() {
            const scrollEl = typeof document !== 'undefined' ? document.getElementById('lyricsScroll') : null;
            const container = typeof document !== 'undefined' ? document.querySelector('.lyrics-container') : null;
            if (!scrollEl || !container || lineElements.length === 0) return;

            const viewW = container.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 1280);
            const viewH = container.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 720);
            if (viewW < 40 || viewH < 40) return;

            /* 画布尺寸：按曲目行数弹性展开，足够容纳全部诗意星轨而不过度空旷 */
            const lineCount = lineElements.length;
            const canvasSpan = Math.max(2400, Math.min(4600, Math.round(Math.sqrt(lineCount) * 460 + Math.max(viewW, viewH) * 1.8)));
            wordcloudCanvasW = Math.max(viewW * 3.2, canvasSpan);
            wordcloudCanvasH = Math.max(viewH * 3.2, canvasSpan);
            scrollEl.style.width = wordcloudCanvasW + 'px';
            scrollEl.style.height = wordcloudCanvasH + 'px';

            /* 焦距层：#wcZoom 包裹星轨连线与全部歌词行 */
            let zoomLayer = scrollEl.querySelector(':scope > #wcZoom');
            if (!zoomLayer) {
                zoomLayer = document.createElement('div');
                zoomLayer.id = 'wcZoom';
                zoomLayer.style.position = 'absolute';
                zoomLayer.style.left = '0';
                zoomLayer.style.top = '0';
                zoomLayer.style.transformOrigin = '0 0';
                zoomLayer.style.zoom = '1';
                while (scrollEl.firstChild) zoomLayer.appendChild(scrollEl.firstChild);
                scrollEl.appendChild(zoomLayer);
            }
            zoomLayer.style.width = wordcloudCanvasW + 'px';
            zoomLayer.style.height = wordcloudCanvasH + 'px';
            zoomLayer.style.zoom = '1';
            zoomLayer.style.transform = '';

            /* 移除旧星轨 SVG */
            const oldSvg = zoomLayer.querySelector('#wcConstellation');
            if (oldSvg) oldSvg.remove();

            const placed = []; /* 已放置行的包围盒 {x, y, w, h, cx, cy} */
            const centerX = wordcloudCanvasW / 2;
            const centerY = wordcloudCanvasH / 2;

            /* 确定性伪随机数（同歌同布局） */
            let seed = 73 + lineCount * 17;
            const rand = () => {
                seed = (seed * 9301 + 49297) % 233280;
                return seed / 233280;
            };

            const padding = 34; /* 宽裕留白，彻底消除词云拥挤与撞字 */

            /* 从用户设置读取词云字号范围（rem），同时按三档编辑级节奏收敛，避免相机忽大忽小 */
            const wcSet = (appSettings.modeSettings && appSettings.modeSettings.wordcloud) || {};
            const wcFmin = parseFloat(wcSet.wcFontMin);
            const wcFmax = parseFloat(wcSet.wcFontMax);
            const rawMin = isNaN(wcFmin) ? 1.55 : Math.max(1.0, wcFmin);
            const rawMax = isNaN(wcFmax) ? 3.35 : Math.max(rawMin + 0.35, Math.min(4.8, wcFmax));
            const spanRem = rawMax - rawMin;

            const aiEmo = (typeof currentAiTheme !== 'undefined' && currentAiTheme && Array.isArray(currentAiTheme.emotion_words))
                ? currentAiTheme.emotion_words.map(w => (typeof w === 'string' ? w : (w && w.word) || '')).filter(w => w.length >= 2)
                : [];

            /* 阶段 1：批量写入三档排版层级（hero / mid / soft）与微倾角 */
            for (let i = 0; i < lineCount; i++) {
                const lineEl = lineElements[i];
                lineEl.dataset.virtual = 'false';
                lineEl.classList.remove('line-placeholder');
                const origEl = lineEl.querySelector('.lrc-original');
                if (origEl) origEl.style.display = '';
                const transEl = lineEl.querySelector('.lrc-translation');
                if (transEl) transEl.style.display = '';
                const romaEl = lineEl.querySelector('.lrc-romaji');
                if (romaEl) romaEl.style.display = '';

                const txt = String(lineEl.textContent || '').trim();
                const hasEmo = aiEmo.some(ew => txt.includes(ew));
                const isHero = hasEmo || (i % 5 === 1);
                const isSoft = !isHero && (txt.length <= 6 || i % 4 === 3);

                let ratio;
                if (isHero) ratio = 0.74 + rand() * 0.26;
                else if (isSoft) ratio = 0.08 + rand() * 0.26;
                else ratio = 0.36 + rand() * 0.34;

                const fontSize = rawMin + spanRem * ratio;
                const tilt = ((i % 2 === 0 ? 1 : -1) * (0.4 + rand() * 1.9)).toFixed(2);
                lineEl.style.fontSize = fontSize.toFixed(2) + 'rem';
                lineEl.style.setProperty('--wc-tilt', `${tilt}deg`);
                lineEl.dataset.wcFontSize = fontSize.toFixed(2);
                lineEl.dataset.wcTier = isHero ? 'hero' : (isSoft ? 'soft' : 'mid');
                lineEl.dataset.wcDepth = '3';
                lineEl.style.left = '0px';
                lineEl.style.top = '0px';
            }

            /* 阶段 2：单次同步读取全部行包围盒（零 Layout Thrashing） */
            const dims = new Array(lineCount);
            for (let i = 0; i < lineCount; i++) {
                dims[i] = { w: lineElements[i].offsetWidth, h: lineElements[i].offsetHeight };
            }

            /* 阶段 3：叙事星轨螺旋放置 —— 相邻歌词行沿黄金角自然延续，
               镜头切换如星海漫游般顺滑，彻底消除跨屏 1800px 乱跳 */
            const GOLDEN_ANGLE = 2.39996323;
            const collidesAt = (x, y, w, h) => {
                if (x < padding || y < padding || x + w + padding > wordcloudCanvasW || y + h + padding > wordcloudCanvasH) {
                    return true;
                }
                for (let p = 0; p < placed.length; p++) {
                    const box = placed[p];
                    if (x - padding < box.x + box.w &&
                        x + w > box.x - padding &&
                        y - padding < box.y + box.h &&
                        y + h > box.y - padding) {
                        return true;
                    }
                }
                return false;
            };

            let prevCx = centerX;
            let prevCy = centerY;

            for (let i = 0; i < lineCount; i++) {
                const lineEl = lineElements[i];
                const w = dims[i].w;
                const h = dims[i].h;
                if (w === 0 || h === 0) continue;

                let px = centerX - w / 2;
                let py = centerY - h / 2;
                let placedOk = false;

                if (i === 0 && !collidesAt(px, py, w, h)) {
                    placedOk = true;
                } else {
                    /* 优先围绕上一句（偏向右下方/螺旋切线方向）搜索近邻空位，保持阅读动线流畅 */
                    const baseAngle = i * GOLDEN_ANGLE + Math.sin(i * 0.7) * 0.45;
                    const anchorX = prevCx * 0.72 + centerX * 0.28;
                    const anchorY = prevCy * 0.72 + centerY * 0.28;
                    let radius = Math.max(h * 1.15, 110);
                    let angle = baseAngle;

                    for (let iter = 0; iter < 1800; iter++) {
                        const x = anchorX + radius * Math.cos(angle) * 1.22 - w / 2;
                        const y = anchorY + radius * Math.sin(angle) * 0.88 - h / 2;
                        if (!collidesAt(x, y, w, h)) {
                            px = x; py = y;
                            placedOk = true;
                            break;
                        }
                        angle += 0.34;
                        radius += 6.5;
                    }
                }

                /* 全局螺旋兜底 */
                if (!placedOk) {
                    let angle = rand() * Math.PI * 2;
                    let radius = 80;
                    for (let iter = 0; iter < 2400; iter++) {
                        const x = centerX + radius * Math.cos(angle) - w / 2;
                        const y = centerY + radius * Math.sin(angle) - h / 2;
                        if (!collidesAt(x, y, w, h)) {
                            px = x; py = y;
                            break;
                        }
                        angle += 0.32;
                        radius += 8;
                    }
                }

                lineEl.style.left = px.toFixed(1) + 'px';
                lineEl.style.top = py.toFixed(1) + 'px';
                const cx = px + w / 2;
                const cy = py + h / 2;
                const ax = cx;
                const ay = py + h + 10; /* 星锚置于句底基线下方，不穿透当前演唱字形 */
                placed.push({ idx: i, x: px, y: py, w, h, cx, cy, ax, ay });
                prevCx = cx;
                prevCy = cy;
            }

            /* 阶段 4：生成轻盈的星轨连线与星尘坐标 SVG（挂在 #wcZoom 底层，随镜头同步缩放平移） */
            if (placed.length >= 2) {
                const svgNS = 'http://www.w3.org/2000/svg';
                const svg = document.createElementNS(svgNS, 'svg');
                svg.setAttribute('id', 'wcConstellation');
                svg.setAttribute('class', 'wc-constellation-svg');
                svg.setAttribute('width', String(wordcloudCanvasW));
                svg.setAttribute('height', String(wordcloudCanvasH));
                svg.setAttribute('viewBox', `0 0 ${wordcloudCanvasW} ${wordcloudCanvasH}`);
                svg.setAttribute('aria-hidden', 'true');

                /* 中心微弱天文坐标环 */
                for (const r of [240, 520, 860]) {
                    const c = document.createElementNS(svgNS, 'circle');
                    c.setAttribute('cx', centerX.toFixed(1));
                    c.setAttribute('cy', centerY.toFixed(1));
                    c.setAttribute('r', String(r));
                    c.setAttribute('class', 'wc-orbit-ring');
                    svg.appendChild(c);
                }

                /* 相邻句的柔弧星轨连线（沿句底星锚自然衔接） */
                for (let k = 0; k < placed.length - 1; k++) {
                    const a = placed[k];
                    const b = placed[k + 1];
                    const mx = (a.ax + b.ax) / 2;
                    const my = (a.ay + b.ay) / 2;
                    const dx = b.ax - a.ax;
                    const dy = b.ay - a.ay;
                    const bend = ((k % 2 === 0) ? 1 : -1) * 0.14;
                    const qx = mx - dy * bend;
                    const qy = my + dx * bend;

                    const path = document.createElementNS(svgNS, 'path');
                    path.setAttribute('d', `M ${a.ax.toFixed(1)} ${a.ay.toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${b.ax.toFixed(1)} ${b.ay.toFixed(1)}`);
                    path.setAttribute('class', 'wc-thread');
                    path.dataset.from = String(a.idx);
                    path.dataset.to = String(b.idx);
                    svg.appendChild(path);
                }

                /* 句锚点星芒节点 */
                for (const pt of placed) {
                    const dot = document.createElementNS(svgNS, 'circle');
                    dot.setAttribute('cx', pt.ax.toFixed(1));
                    dot.setAttribute('cy', pt.ay.toFixed(1));
                    dot.setAttribute('r', '2.8');
                    dot.setAttribute('class', 'wc-star-node');
                    dot.dataset.line = String(pt.idx);
                    svg.appendChild(dot);
                }

                zoomLayer.insertBefore(svg, zoomLayer.firstChild);
            }

            wordcloudLayoutDone = true;
            wordcloudLayoutVer++;
            wordcloudCamCache = null;

            /* 镜头初始定位：将画布中心居中于视口 */
            wordcloudCurrentX = viewW / 2 - wordcloudCanvasW / 2;
            wordcloudCurrentY = viewH / 2 - wordcloudCanvasH / 2;
            wordcloudCurrentScale = 1;
            wcLastTransform = '';
            __wcSetCam(wordcloudCurrentX, wordcloudCurrentY, 1, false);

            if (activeLineIndex >= 0 && lineElements[activeLineIndex]) {
                updateWordcloudCamera();
            }
        }

export { flyinAutoScaleFont, getDuration, layoutWordCloud, updateFlyinTranslation };
