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

            /* 先淡出，再更新内容，再淡入 */
            flyinArea.style.opacity = '0';
            setTimeout(() => {
                if (flyinTrans) flyinTrans.textContent = (line.translation && line.translation.trim() !== '//') ? line.translation : '';
                if (flyinRoma) flyinRoma.textContent = line.romaji || '';
                flyinArea.style.opacity = '1';
            }, 300);
        }

/* ========== 飞入模式：动态缩放字体以适配可用高度 ========== */
function flyinAutoScaleFont() {
            const container = typeof document !== 'undefined' ? document.querySelector('.lyrics-container') : null;
            if (!container) return;
            const flyinArea = typeof document !== 'undefined' ? document.getElementById('flyinTranslationArea') : null;
            const activeLine = typeof document !== 'undefined' ? document.querySelector('.view-flyin .line.active') : null;
            if (!activeLine) return;
            const lrcEl = activeLine.querySelector('.lrc-original');
            if (!lrcEl) return;

            /* 计算可用高度：容器高度 - 最小边距 */
            /* 顶部留 20px，底部根据翻译区高度 + 20px 余量 */
            const topReserved = 20;
            let bottomReserved = flyinArea ? flyinArea.offsetHeight + 20 : 80;
            const maxH = container.clientHeight - topReserved - bottomReserved;
            if (maxH <= 0) return;

            /* ★ 飞入模式海报大字基准（对齐 folia 视觉体量）：
               全屏单行舞台式呈现，基准字号基于视口动态适配（~5.8vw），
               真实读取用户倍率 userScale（2.00x 时可达 120-150px 巨幕冲击力） */
            let userScale = 1.0;
            const flyinMs = (globalThis.appSettings && globalThis.appSettings.modeSettings && globalThis.appSettings.modeSettings.flyin);
            if (flyinMs && flyinMs.fontSize !== undefined) {
                userScale = parseFloat(flyinMs.fontSize) || 1.0;
            } else if (globalThis.appSettings && globalThis.appSettings.lyrics && globalThis.appSettings.lyrics.fontSize !== undefined) {
                userScale = parseFloat(globalThis.appSettings.lyrics.fontSize) || 1.0;
            }
            if (userScale > 3) userScale = userScale / 24; // 兼容旧像素值

            const viewW = container.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 1080);
            const heroBase = Math.max(46, Math.min(80, viewW * 0.056));
            const targetSize = Math.round(heroBase * userScale);

            /* 一次测量自然高度 → 超出可用高时自适应线性收缩，短句享受完整巨幕字号 */
            lrcEl.style.fontSize = targetSize + 'px';
            lrcEl.style.maxHeight = 'none';
            lrcEl.style.overflow = 'visible';
            void lrcEl.offsetHeight;
            const naturalHeight = lrcEl.scrollHeight;

            if (naturalHeight > maxH) {
                const shrink = Math.max(0.35, Math.min(1.0, (maxH / naturalHeight) * 0.96));
                lrcEl.style.fontSize = Math.max(26, Math.round(targetSize * shrink)) + 'px';
            }
            lrcEl.style.maxHeight = maxH + 'px';
            lrcEl.style.overflow = 'visible';
        }

/* ========== 词云模式：2D 螺旋排版算法 ==========
         * 将所有歌词行以不同字号错落排布在虚拟矩形画布内，
         * 使用螺旋搜索 + AABB 碰撞检测确保各行绝对不重叠。
         */
function layoutWordCloud() {
            const scrollEl = typeof document !== 'undefined' ? document.getElementById('lyricsScroll') : null;
            const container = typeof document !== 'undefined' ? document.querySelector('.lyrics-container') : null;
            if (!scrollEl || !container || lineElements.length === 0) return;

            const viewW = container.clientWidth;
            const viewH = container.clientHeight;

            /* 画布尺寸：远大于视口，容纳所有行 */
            wordcloudCanvasW = Math.max(viewW * 4, 2400);
            wordcloudCanvasH = Math.max(viewH * 4, 2400);
            scrollEl.style.width = wordcloudCanvasW + 'px';
            scrollEl.style.height = wordcloudCanvasH + 'px';

            /* ★ 焦距层：#wcZoom 包裹全部行。摄像机缩放(zoom)写在这里——
               Chromium 布局级缩放、文字按高分渲染，放大不糊；平移仍写在 scrollEl。
               行以绝对坐标置于焦距层内，坐标与之前的 scrollEl 坐标系完全一致。 */
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

            const placed = []; /* 已放置行的包围盒 {x, y, w, h} */
            const centerX = wordcloudCanvasW / 2;
            const centerY = wordcloudCanvasH / 2;

            /* 伪随机数（可复现） */
            let seed = 42;
            const rand = () => {
                seed = (seed * 9301 + 49297) % 233280;
                return seed / 233280;
            };

            const padding = 24; /* 行间最小间距（增大防止重叠） */

            /* ★ 从用户设置读取词云字号范围，单位 rem，回退到默认值 */
            const wcSet = (appSettings.modeSettings && appSettings.modeSettings.wordcloud) || {};
            const WC_BASE_REM = 1; /* rem 基准（1rem = 根字号，通常 16px） */
            const wcFmin = parseFloat(wcSet.wcFontMin); const wcFmax = parseFloat(wcSet.wcFontMax);
            const minRem = (isNaN(wcFmin) ? 1.2 : wcFmin) * WC_BASE_REM;
            const maxRem = (isNaN(wcFmax) ? 4.5 : wcFmax) * WC_BASE_REM;

            const lineCount = lineElements.length;
            /* ★ 阶段1：批量写入（恢复可见 + 设置字号 + 重置位置），不读取布局信息 */
            for (let i = 0; i < lineCount; i++) {
                const lineEl = lineElements[i];
                /* 确保行可见（退出虚拟滚动占位状态） */
                lineEl.dataset.virtual = 'false';
                lineEl.classList.remove('line-placeholder');
                const origEl = lineEl.querySelector('.lrc-original');
                if (origEl) origEl.style.display = '';
                const transEl = lineEl.querySelector('.lrc-translation');
                if (transEl) transEl.style.display = '';
                const romaEl = lineEl.querySelector('.lrc-romaji');
                if (romaEl) romaEl.style.display = '';
                /* 差异化字号：使用用户设置的 wcFontMin~wcFontMax 范围伪随机 */
                const fontSize = minRem + rand() * Math.max(0.1, maxRem - minRem);
                lineEl.style.fontSize = fontSize + 'rem';
                lineEl.dataset.wcFontSize = fontSize.toFixed(2);  /* 保存原始字号供变焦计算 */
                lineEl.style.left = '0px';
                lineEl.style.top = '0px';
            }
            /* ★ 阶段2：一次性读取全部行的包围盒（首个读取触发唯一一次重排，其余命中缓存；
               此前逐行"写字号→读尺寸"交替执行导致 N 次强制同步布局，滑块拖动卡顿的根因） */
            const dims = new Array(lineCount);
            for (let i = 0; i < lineCount; i++) {
                dims[i] = { w: lineElements[i].offsetWidth, h: lineElements[i].offsetHeight };
            }

            /* ★ 阶段3：纯计算放置（螺旋碰撞检测 + 网格兜底），随后批量写回位置 */
            for (let i = 0; i < lineCount; i++) {
                const lineEl = lineElements[i];
                const w = dims[i].w;
                const h = dims[i].h;
                if (w === 0 || h === 0) continue;

                /* 螺旋搜索：从中心向外旋转，寻找无碰撞位置 */
                let placedOk = false;
                let angle = rand() * Math.PI * 2;
                let radius = 0;
                const angleStep = 0.35;
                const radiusStep = 24;
                let px = 0, py = 0;

                for (let iter = 0; iter < 3000; iter++) {
                    const x = centerX + radius * Math.cos(angle) - w / 2;
                    const y = centerY + radius * Math.sin(angle) - h / 2;

                    /* 边界检查 */
                    if (x < padding || y < padding ||
                        x + w + padding > wordcloudCanvasW ||
                        y + h + padding > wordcloudCanvasH) {
                        angle += angleStep;
                        radius += 2;
                        if (radius > Math.max(wordcloudCanvasW, wordcloudCanvasH)) break;
                        continue;
                    }

                    /* AABB 碰撞检测 */
                    let collides = false;
                    for (let p = 0; p < placed.length; p++) {
                        const box = placed[p];
                        if (x - padding < box.x + box.w &&
                            x + w > box.x - padding &&
                            y - padding < box.y + box.h &&
                            y + h > box.y - padding) {
                            collides = true;
                            break;
                        }
                    }

                    if (!collides) {
                        px = x; py = y;
                        placedOk = true;
                        break;
                    }

                    angle += angleStep;
                    if (angle > Math.PI * 2) {
                        angle -= Math.PI * 2;
                        radius += radiusStep;
                    }
                }

                /* 回退：在画布边缘空区放置（仍做碰撞检测，避免重叠） */
                if (!placedOk) {
                    px = padding; py = padding;
                    let found = false;
                    for (let fy_try = padding; fy_try < wordcloudCanvasH - h - padding; fy_try += h + padding) {
                        for (let fx_try = padding; fx_try < wordcloudCanvasW - w - padding; fx_try += w + padding) {
                            let collides = false;
                            for (let p = 0; p < placed.length; p++) {
                                const box = placed[p];
                                if (fx_try - padding < box.x + box.w &&
                                    fx_try + w > box.x - padding &&
                                    fy_try - padding < box.y + box.h &&
                                    fy_try + h > box.y - padding) {
                                    collides = true; break;
                                }
                            }
                            if (!collides) { px = fx_try; py = fy_try; found = true; break; }
                        }
                        if (found) break;
                    }
                }
                lineEl.style.left = px + 'px';
                lineEl.style.top = py + 'px';
                placed.push({ x: px, y: py, w, h });
            }

            wordcloudLayoutDone = true;
            wordcloudLayoutVer++;          /* 布局版本递增，使相机焦点缓存失效 */
            wordcloudCamCache = null;

            /* ★ 镜头初始定位：将画布中心居中于视口 */
            const container2 = typeof document !== 'undefined' ? document.querySelector('.lyrics-container') : null;
            if (container2) {
                const vw = container2.clientWidth;
                const vh = container2.clientHeight;
                wordcloudCurrentX = vw / 2 - wordcloudCanvasW / 2;
                wordcloudCurrentY = vh / 2 - wordcloudCanvasH / 2;
                wordcloudCurrentScale = 1;
                wcLastTransform = '';   /* 重布局后强制下一帧重写 transform */
                __wcSetCam(wordcloudCurrentX, wordcloudCurrentY, 1, true);
            }

            /* 如果有活动行，立即跟焦到活动行 */
            if (activeLineIndex >= 0 && lineElements[activeLineIndex]) {
                updateWordcloudCamera();
            }
        }

export { flyinAutoScaleFont, getDuration, layoutWordCloud, updateFlyinTranslation };
