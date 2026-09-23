/* ============================================================
 * 100-cover-background.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 2626-3061 行 | 单元数: 12
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { playerConfig } from '../config/defaults.js';
import { getBlurBgLayers, getCoverLayers } from '../infrastructure/dom.js';
import { extractCoverPalette } from '../utils/colorUtils.js';
import { audio, updateLineBlur } from './20-lyrics-render.js';
import { songCover, songCover2 } from './30-dom-refs.js';
import { playerContainer } from './40-playback-state.js';
import { updateLyricsHighlight } from './57-wordcloud-camera.js';
import { updatePlaybackPosition } from './65-playback-position.js';
import { logInfo, logWarn, logError } from '../services/log.js';

/* 获取当前活动封面层 */
function getActiveCover() {
            const layers = getCoverLayers();
            return layers[activeCoverIndex] || layers[0];
        }

/* 获取当前非活动封面层 */
function getInactiveCover() {
            const layers = getCoverLayers();
            return layers[1 - activeCoverIndex] || layers[0];
        }

/* URL 规整：剥离误包裹的反引号/引号与首尾空白（部分接口返回脏数据会导致图片永远加载失败）
   + QQ封面 800x800 降为 500x500：体积约减半，手机网络下封面能与背景同步快速出现 */
function sanitizeImageUrl(u) {
            if (typeof u !== 'string') return u;
            return u.trim()
                .replace(/^[`'"\s]+/, '').replace(/[`'"\s]+$/, '')
                .replace(/(photo_new\/T002R)800x800(M000)/, '$1500x500$2');
        }

function setCoverImage(url) {
            const coverToUse = sanitizeImageUrl(url || playerConfig.coverUrl);
            const layers = getCoverLayers();
            if (layers.length === 0) return;

            if (!url) {
                /* 隐藏所有封面层 */
                layers.forEach(l => {
                    l.style.opacity = '0';
                    if (l === songCover) l.removeAttribute('src');
                    if (l === songCover2) l.removeAttribute('src');
                });
                return;
            }

            const activeCover = getActiveCover();
            const inactiveCover = getInactiveCover();

            /* 同一张图且已可见，无需切换 */
            if ((activeCover.src === coverToUse || activeCover.getAttribute('src') === coverToUse) &&
                activeCover.style.opacity === '1') {
                return;
            }

            /* 代际计数器递增——本次调用的所有回调都携带此代际 */
            coverGen++;
            const myGen = coverGen;
            let applied = false;

            /* ★ 幂等的交叉淡入函数 */
            const tryCrossfade = () => {
                if (applied || myGen !== coverGen) return;
                applied = true;

                inactiveCover.style.opacity = '1';
                activeCover.style.opacity = '0';
                activeCoverIndex = 1 - activeCoverIndex;

                try {
                    extractDominantColor(inactiveCover);
                } catch (e) {}

                /* ★ 同步更新底部控件栏封面（带淡入效果） */
                const bottomCover = typeof document !== 'undefined' ? document.getElementById('bottomSongCover') : null;
                if (bottomCover && inactiveCover.src) {
                    bottomCover.style.opacity = '0';
                    setTimeout(() => {
                        if (myGen !== coverGen) return;
                        bottomCover.src = inactiveCover.src;
                        bottomCover.style.opacity = '1';
                    }, 150);
                }
            };

            /* 优先尝试 CORS 模式以支持提取调色板，失败则平滑降级 */
            inactiveCover.crossOrigin = 'anonymous';
            inactiveCover.src = coverToUse;

            const corsProbe = new Image();
            corsProbe.crossOrigin = 'anonymous';
            corsProbe.onload = () => {
                if (myGen !== coverGen) return;
                tryCrossfade();
            };
            corsProbe.onerror = () => {
                if (myGen !== coverGen) return;
                /* CORS 失败：降级为普通跨域图片 */
                inactiveCover.removeAttribute('crossOrigin');
                inactiveCover.src = coverToUse;
                const plainProbe = new Image();
                plainProbe.onload = () => {
                    if (myGen !== coverGen) return;
                    tryCrossfade();
                };
                plainProbe.onerror = () => {
                    if (myGen !== coverGen) return;
                    tryCrossfade();
                };
                plainProbe.src = coverToUse;
            };
            corsProbe.src = coverToUse;

            /* 若图片已在缓存中，立即淡入 */
            if (corsProbe.complete && corsProbe.naturalWidth > 0) {
                tryCrossfade();
            }

            /* 超时保护：2.5 秒兜底淡入，绝不卡在旧封面 */
            setTimeout(() => {
                if (applied || myGen !== coverGen) return;
                tryCrossfade();
            }, 2500);
        }

function extractDominantColor(imgElement) {
            /* 跨域图片未设置 crossOrigin 时 canvas 会被 tainted，跳过提取 */
            if (!imgElement.crossOrigin) {
                applyColorOverlay(100, 100, 100, 0.3);
                return;
            }
            try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = 50;
                canvas.height = 50;
                ctx.drawImage(imgElement, 0, 0, 50, 50);
                const imageData = ctx.getImageData(0, 0, 50, 50);
                const pixels = imageData.data;
                let r = 0, g = 0, b = 0, count = 0;
                for (let i = 0; i < pixels.length; i += 20) {
                    r += pixels[i];
                    g += pixels[i + 1];
                    b += pixels[i + 2];
                    count++;
                }
                r = Math.round(r / count);
                g = Math.round(g / count);
                b = Math.round(b / count);
                applyColorOverlay(r, g, b);
                applyColorToLyrics(r, g, b);
                window.dominantColor = { r, g, b };
                /* ★ 标题栏颜色跟随（240 事件驱动钩子，替代原 700ms 轮询） */
                if (typeof globalThis.__updateBrandColor === 'function') globalThis.__updateBrandColor();
                const palette = typeof extractCoverPalette === 'function' ? extractCoverPalette(imgElement) : { primary: '#3a86ff', secondary: '#ff006e', accent: '#ffbe0b' };
                window.coverPalette = palette;
                if (pvEngineInstance && pvEngineInstance.background) {
                    pvEngineInstance.background.updateTheme(palette.primary, palette.secondary, palette.accent);
                }
                /* ★ 上游参考项目 第一步：封面取色 → 全局 CSS 变量，供 PV 流体背景/隧道背景等消费
                   （--cover-primary/secondary/accent），实现「背景 = 封面色板拉渐变」 */
                try {
                    const root = document.documentElement;
                    const toCss = (c) => (c && typeof c === 'object' && c.r !== undefined)
                        ? `rgb(${c.r}, ${c.g}, ${c.b})` : (c || '');
                    root.style.setProperty('--cover-primary', toCss(palette.primary));
                    root.style.setProperty('--cover-secondary', toCss(palette.secondary));
                    root.style.setProperty('--cover-accent', toCss(palette.accent));
                } catch (e) { /* 静默 */ }
            } catch (error) {
                logError('coverBackground', '提取颜色失败:', error);
                applyColorOverlay(100, 100, 100, 0.3);
            }
        }

/* 初始即暂停背景摇摆，播放时再启动 */
getBlurBgLayers().forEach(l => l.classList.add('paused'));

/* ========== 离线预烘焙模糊背景（无显卡虚拟机/低性能模式终极减负） ==========
 * 根因：CSS filter: blur(...) 在 CPU 软件渲染器下对 150% 面积的层每帧执行高斯卷积，
 * 并配合 bgSway 旋转，导致虚拟机/无显卡环境 CPU 100% 占满、剧烈卡顿。
 * 优化：在微型离屏 Canvas（128x128）上将原图做一次性极轻量下采样 + 模糊 + 压暗，
 * 导出 DataURL 作为背景图，并彻底消除 CSS 实时 filter（设为 none）。
 * 全屏 cover 时浏览器利用双线性抗锯齿自动呈现出柔和均匀的虚化背景，
 * 视觉效果与 60px 高斯模糊几乎无异，但后续旋转/平移每帧滤镜计算量直接归零！ */
const prebakedBlurCache = new Map();
const MAX_PREBAKE_CACHE = 12;

function shouldUsePrebakedBlur() {
    if (typeof document === 'undefined') return false;
    const body = document.body;
    if (!body) return false;
    return body.classList.contains('perf-low') ||
           body.classList.contains('perf-minimal') ||
           document.documentElement.classList.contains('is-software-renderer') ||
           Boolean(window.__isSoftwareRenderer);
}

function generatePrebakedBlurBackground(imageUrl, blurPx = 60, brightness = 0.35) {
    return new Promise((resolve) => {
        if (!imageUrl || typeof document === 'undefined') return resolve(imageUrl);
        const cacheKey = `${imageUrl}_${blurPx}_${brightness}`;
        if (prebakedBlurCache.has(cacheKey)) {
            return resolve(prebakedBlurCache.get(cacheKey));
        }

        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            try {
                const BAKE_SIZE = 128;
                const canvas = document.createElement('canvas');
                canvas.width = BAKE_SIZE;
                canvas.height = BAKE_SIZE;
                const ctx = canvas.getContext('2d');
                if (!ctx) return resolve(imageUrl);

                /* 1. 先缩放绘制到 128x128（大比例缩放本身即完成高性价比低通去噪） */
                ctx.drawImage(img, 0, 0, BAKE_SIZE, BAKE_SIZE);

                /* 2. 尝试利用 Canvas 2D 进行微量滤镜 (128px 画布上的 5px 相当于全屏 70px) */
                let filterApplied = false;
                try {
                    if (typeof ctx.filter === 'string') {
                        const r = Math.max(3, Math.min(8, Math.round(blurPx * 0.1)));
                        ctx.filter = `blur(${r}px) brightness(${brightness})`;
                        ctx.drawImage(canvas, 0, 0);
                        ctx.filter = 'none';
                        filterApplied = true;
                    }
                } catch (_) {}

                /* 3. 若 ctx.filter 不可用，使用经典双重下采样柔化 + 压暗 */
                if (!filterApplied) {
                    const smallCanvas = document.createElement('canvas');
                    smallCanvas.width = 48;
                    smallCanvas.height = 48;
                    const sctx = smallCanvas.getContext('2d');
                    if (sctx) {
                        sctx.drawImage(canvas, 0, 0, 48, 48);
                        ctx.clearRect(0, 0, BAKE_SIZE, BAKE_SIZE);
                        ctx.imageSmoothingEnabled = true;
                        ctx.drawImage(smallCanvas, 0, 0, BAKE_SIZE, BAKE_SIZE);
                    }
                    ctx.fillStyle = `rgba(0, 0, 0, ${Math.max(0, Math.min(1, 1 - brightness))})`;
                    ctx.fillRect(0, 0, BAKE_SIZE, BAKE_SIZE);
                }

                const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
                if (prebakedBlurCache.size >= MAX_PREBAKE_CACHE) {
                    const firstKey = prebakedBlurCache.keys().next().value;
                    prebakedBlurCache.delete(firstKey);
                }
                prebakedBlurCache.set(cacheKey, dataUrl);
                resolve(dataUrl);
            } catch (e) {
                resolve(imageUrl);
            }
        };
        img.onerror = () => resolve(imageUrl);
        img.src = imageUrl;
    });
}

function applyColorOverlay(r, g, b, opacity = 0.3) {
            const colorOverlay = typeof document !== 'undefined' ? document.getElementById('colorOverlay') : null;
            if (colorOverlay) {
                colorOverlay.style.backgroundColor = `rgba(${r}, ${g}, ${b}, ${opacity})`;
                colorOverlay.classList.add('visible');
            }
        }

function applyColorToLyrics(r, g, b) {
            if (!lyricsColorStyleEl) {
                lyricsColorStyleEl = document.createElement('style');
                lyricsColorStyleEl.id = 'lyrics-color-style';
                document.head.appendChild(lyricsColorStyleEl);
            }
/* 不使用 !important，让 applyHighlightColor 的 .line .word（更高优先级）可以覆盖 */
/* 不设置 .lrc-romaji 和 .lrc-translation 的颜色，让用户设置可以控制 */
lyricsColorStyleEl.textContent = `
.word { color: rgba(${r}, ${g}, ${b}, 0.25); }
`;
        }

/* 获取当前活动层 */
function getActiveBgLayer() {
            const layers = getBlurBgLayers();
            return layers[activeBgIndex] || layers[0];
        }

/* 获取当前非活动层 */
function getInactiveBgLayer() {
            const layers = getBlurBgLayers();
            return layers[1 - activeBgIndex] || layers[0];
        }

function setBlurBackground(imageUrl) {
            imageUrl = sanitizeImageUrl(imageUrl);
            const layers = getBlurBgLayers();
            if (layers.length === 0) return;

            /* 提取 backgroundImage 中的 URL（兼容浏览器序列化差异） */
            const extractUrl = (bgVal) => {
                if (!bgVal || bgVal === 'none') return '';
                const m = bgVal.match(/url\(["']?(.+?)["']?\)/);
                return m ? m[1] : bgVal;
            };

            /* 如果当前可见层已经显示同一张图，直接跳过 */
            const activeLayer = getActiveBgLayer();
            if (extractUrl(activeLayer.style.backgroundImage) === imageUrl &&
                activeLayer.classList.contains('visible')) {
                return;
            }

            const inactiveLayer = getInactiveBgLayer();

            const usePrebaked = shouldUsePrebakedBlur();
            const bgSettings = appSettings.background || {};
            const blurPx = bgSettings.blur != null ? bgSettings.blur : 60;
            const brightness = bgSettings.brightness != null ? bgSettings.brightness : 0.35;

            /* 代际计数器递增——本次调用的所有回调都携带此代际 */
            bgGen++;
            const myGen = bgGen;

            const applyBgImage = (urlToSet, isBaked) => {
                if (myGen !== bgGen) return;
                inactiveLayer.style.backgroundImage = `url("${urlToSet}")`;
                inactiveLayer.style.filter = (isBaked || !playerConfig.enableBlurBackground)
                    ? 'none'
                    : `blur(${blurPx}px) brightness(${brightness})`;

                if (!playerConfig.enableBlurBackground) {
                    inactiveLayer.style.backgroundSize = 'cover';
                    inactiveLayer.style.backgroundPosition = 'center';
                }
            };

            /* ★ 幂等的交叉淡入函数：可被 onload / onerror / setTimeout
               多次安全调用，同一代际只执行一次实际切换 */
            const tryCrossfade = () => {
                /* 1) 如果已被更新的调用取代，直接放弃 */
                if (myGen !== bgGen) return;
                /* 2) 如果目标层已经可见（本代际已执行过），跳过 */
                if (inactiveLayer.classList.contains('visible')) return;
                /* 3) 执行交叉淡入淡出 */
                inactiveLayer.classList.add('visible');
                activeLayer.classList.remove('visible');
                activeBgIndex = 1 - activeBgIndex;
            };

            if (usePrebaked && playerConfig.enableBlurBackground) {
                /* ★ 预烘焙模式：异步离屏微缩模糊 + 压暗一次性生成，CSS filter 置 none，
                   免除每帧高斯卷积计算，后续 bgSway 旋转只变换纯位图，CPU 零压力 */
                generatePrebakedBlurBackground(imageUrl, blurPx, brightness).then(bakedUrl => {
                    if (myGen !== bgGen) return;
                    applyBgImage(bakedUrl, true);
                    tryCrossfade();
                }).catch(() => {
                    if (myGen !== bgGen) return;
                    applyBgImage(imageUrl, false);
                    tryCrossfade();
                });
            } else {
                applyBgImage(imageUrl, false);
                /* 预加载图片，加载完成后淡入 */
                const img = new Image();
                img.onload = tryCrossfade;
                img.onerror = tryCrossfade;
                img.src = imageUrl;

                /* 超时保护：3 秒后如果图片已加载完成（含失败）但回调未触发，强制淡入 */
                setTimeout(() => {
                    if (myGen !== bgGen) return;
                    if (img.complete) {
                        tryCrossfade();
                    }
                }, 3000);
            }

            /* 非动态背景模式下应用遮罩 */
            if (!playerConfig.enableBlurBackground) {
                applyColorOverlay(0, 0, 0, 0.8);
            }
        }

/* ========== 歌词行点击跳转 ========== */
function initLyricsInteractions() {
            if (typeof document !== "undefined") document.addEventListener('click', function(e) {
                if (typeof window !== 'undefined' && window.Aria && window.Aria.__npActive && window.Aria.__npActive()) return; /* 接管只读：点击歌词行不跳转 */
                const line = e.target.closest('.line');
                if (line) {
                    const lineIndex = parseInt(line.dataset.index);
                    if (lineIndex >= 0 && lineIndex < lyrics.length) {
                        /* ★ 减去 lyricOffset：用户设置了歌词偏移后，点击跳转应跳到调整后的时间轴位置
                           例如偏移 +500ms（延迟），歌词 start=10000，音频应跳到 (10000-500)/1000=9.5s
                           这样 effectiveTime = currentTime + offset = 9500 + 500 = 10000 = start */
                        const targetTime = Math.max(0, (lyrics[lineIndex].start - lyricOffset) / 1000);
                        audio.currentTime = targetTime;
                        currentTime = lyrics[lineIndex].start - lyricOffset;  /* 补偿偏移，使点击行正确高亮 */
                        isUserScrolling = false;
                        if (scrollTimeout) { clearTimeout(scrollTimeout); }
document.querySelector('.lyrics-container')?.classList.remove('user-scrolling');
                        /* ★ 点击跳转：走 AM 风格弹簧滚动到目标行（由 57 的常驻 rAF 驱动，
                           带过冲回弹；不再直接 transition 直写，避免与弹簧层打架导致"无动效"） */
                        const scrollEl = typeof document !== 'undefined' ? document.getElementById('lyricsScroll') : null;
                        const lineTargetEl = lineElements[lineIndex];
                        const lyricsContainerEl = typeof document !== 'undefined' ? document.querySelector('.lyrics-container') : null;
                        if (scrollEl && lineTargetEl && lyricsContainerEl) {
                            const svh = lyricsContainerEl.clientHeight;
                            const targetY = Math.max(0, lineTargetEl.offsetTop - svh / 2 + lineTargetEl.clientHeight / 2);
                            if (typeof Aria !== 'undefined' && typeof Aria.__lyricsScrollTo === 'function') {
                                Aria.__lyricsScrollTo(targetY, false, lineIndex);
                            } else {
                                scrollEl.style.transition = 'transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)';
                                scrollEl.style.transform = `translateY(-${targetY}px)`;
                                currentScrollY = targetY;
                            }
                        }
                        updatePlaybackPosition();
                        line.style.backgroundColor = 'rgba(255, 255, 255, 0.2)';
                        setTimeout(() => { line.style.backgroundColor = ''; }, 200);
                    }
                }
            });

            /* 滚轮手动浏览歌词（只绑定一次） */
            const lyricsContainer = typeof document !== 'undefined' ? document.querySelector('.lyrics-container') : null;
            const scrollTimeoutDelay = 3500;
            lyricsContainer?.addEventListener('wheel', (e) => {
                e.preventDefault();

                /* ★ 词云模式：滚轮缩放词云（以鼠标位置为中心） */
                if (playerContainer.classList.contains('view-wordcloud')) {
                    const scrollEl = typeof document !== 'undefined' ? document.getElementById('lyricsScroll') : null;
                    if (!scrollEl || !wordcloudLayoutDone) return;
                    const rect = lyricsContainer.getBoundingClientRect();
                    const mouseX = e.clientX - rect.left;
                    const mouseY = e.clientY - rect.top;

                    /* 缩放前鼠标指向的画布坐标 */
                    const canvasXBefore = (mouseX - wordcloudCurrentX) / wordcloudCurrentScale;
                    const canvasYBefore = (mouseY - wordcloudCurrentY) / wordcloudCurrentScale;

                    /* 缩放 */
                    const zoomFactor = e.deltaY > 0 ? 0.92 : 1.08;
                    wordcloudCurrentScale = Math.max(0.2, Math.min(5, wordcloudCurrentScale * zoomFactor));

                    /* 缩放后调整平移，使鼠标位置不变 */
                    wordcloudCurrentX = mouseX - canvasXBefore * wordcloudCurrentScale;
                    wordcloudCurrentY = mouseY - canvasYBefore * wordcloudCurrentScale;

                    __wcSetCam(wordcloudCurrentX, wordcloudCurrentY, wordcloudCurrentScale, false);

                    /* ★ 3s 超时后：吸附为 CSS zoom（高清渲染）并恢复自动跟焦 */
                    if (wcZoomTimer) clearTimeout(wcZoomTimer);
                    wcZoomTimer = setTimeout(() => {
                        wcZoomTimer = null;
                        __wcSetCam(wordcloudCurrentX, wordcloudCurrentY, wordcloudCurrentScale, true);
                    }, 3000);
                    wcTween = null;   /* 手动缩放 → 取消进行中的补间 */

                    return;  /* 词云模式下不走普通滚动逻辑 */
                }

                isUserScrolling = true;
                if (scrollTimeout) { clearTimeout(scrollTimeout); }
                /* ★ 用容器级 CSS 类替代逐行操作 className，大幅减少 DOM 操作 */
                lyricsContainer.classList.add('user-scrolling');
                const scrollEl = typeof document !== 'undefined' ? document.getElementById('lyricsScroll') : null;

                /* ★ AM 风格逐行牵动：真实 delta 直接进弹簧目标位（近 1:1 跟手），
                   由 57 常驻 rAF 平滑写入 transform——不再固定 ±30 步长 + transition
                   直写（那是"卡顿/瞬移"的根源）。瞬移根因还包含弹簧层与 transition
                   直写互相覆盖，现统一只走 Aria.__lyricsWheelApply。
                   ★ 虚拟渲染也移到 rAF 内（stepLyricsScroll），按弹簧「实际位置」
                   计算中心行，避免 wheel 里同步改 DOM 卡顿 + 上方行提前消失。 */
                const wheelDelta = (e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY);
                if (typeof Aria !== 'undefined' && typeof Aria.__lyricsWheelApply === 'function') {
                    Aria.__lyricsWheelApply(wheelDelta);
                } else if (scrollEl) {
                    const maxScroll = scrollEl.scrollHeight - lyricsContainer.clientHeight;
                    currentScrollY = Math.max(0, Math.min(currentScrollY + wheelDelta, maxScroll));
                }
                scrollTimeout = setTimeout(() => {
                    isUserScrolling = false;
                    lyricsContainer.classList.remove('user-scrolling');
                    /* 恢复模糊状态 */
                    for (let i = 0; i < lineElements.length; i++) {
                        updateLineBlur(i);
                    }
                    updateLyricsHighlight();
                }, scrollTimeoutDelay);
            });

            /* ★ 词云模式：长按拖动移动词云，短点击切行 */
            const WC_DRAG_THRESHOLD = 6;  /* 超过此像素视为拖动 */

            const wcPointerDown = (clientX, clientY) => {
                if (!playerContainer.classList.contains('view-wordcloud') || !wordcloudLayoutDone) return;
                wcTween = null;   /* 开始拖动 → 取消进行中的补间 */
                wcDragState = {
                    startX: clientX,
                    startY: clientY,
                    startXform: wordcloudCurrentX,
                    startYform: wordcloudCurrentY,
                    startTime: Date.now(),
                    moved: false
                };
            };
            const wcPointerMove = (clientX, clientY) => {
                if (!wcDragState) return;
                const dx = clientX - wcDragState.startX;
                const dy = clientY - wcDragState.startY;
                if (!wcDragState.moved && (Math.abs(dx) > WC_DRAG_THRESHOLD || Math.abs(dy) > WC_DRAG_THRESHOLD)) {
                    wcDragState.moved = true;
                    lyricsContainer.style.cursor = 'grabbing';
                }
                if (wcDragState.moved) {
                    wordcloudCurrentX = wcDragState.startXform + dx;
                    wordcloudCurrentY = wcDragState.startYform + dy;
                    __wcSetCam(wordcloudCurrentX, wordcloudCurrentY, wordcloudCurrentScale);
                }
            };
            const wcPointerUp = () => {
                if (!wcDragState) return;
                if (wcDragState.moved) {
                    /* 拖动结束，抑制后续点击事件（防止误切行） */
                    lyricsContainer.style.cursor = '';
                    wcSuppressClick = true;
                    setTimeout(() => { wcSuppressClick = false; }, 100);
                }
                wcDragState = null;
            };

            /* ★ 拖动后拦截点击，防止误触发歌词行跳转 */
            lyricsContainer?.addEventListener('click', (e) => {
                if (wcSuppressClick) {
                    e.stopPropagation();
                    e.preventDefault();
                }
            }, true);  /* capture 阶段拦截，先于行 click 触发 */

            /* 鼠标事件 */
            lyricsContainer?.addEventListener('mousedown', (e) => {
                if (playerContainer.classList.contains('view-wordcloud')) {
                    wcPointerDown(e.clientX, e.clientY);
                }
            });
            if (typeof document !== "undefined") document.addEventListener('mousemove', (e) => {
                if (wcDragState) wcPointerMove(e.clientX, e.clientY);
            });
            if (typeof document !== "undefined") document.addEventListener('mouseup', () => {
                wcPointerUp();
            });

            /* 触摸事件 */
            lyricsContainer?.addEventListener('touchstart', (e) => {
                if (playerContainer.classList.contains('view-wordcloud') && e.touches.length === 1) {
                    wcPointerDown(e.touches[0].clientX, e.touches[0].clientY);
                }
            }, { passive: true });
            lyricsContainer?.addEventListener('touchmove', (e) => {
                if (wcDragState && wcDragState.moved) {
                    e.preventDefault();  /* 拖动时阻止页面滚动 */
                    wcPointerMove(e.touches[0].clientX, e.touches[0].clientY);
                }
            }, { passive: false });
            lyricsContainer?.addEventListener('touchend', () => {
                wcPointerUp();
            });
        }

export { applyColorOverlay, applyColorToLyrics, extractDominantColor, generatePrebakedBlurBackground, getActiveBgLayer, getActiveCover, getInactiveBgLayer, getInactiveCover, initLyricsInteractions, sanitizeImageUrl, setBlurBackground, setCoverImage, shouldUsePrebakedBlur };
