// ScrollEngine.js — 「长卷 · Scroll」引擎（2026-10-01，方案见 scratch/新模式提案_长卷Scroll.md）
//
// 概念：把整首歌画成一幅横卷。时间从右往左推进，当前句居中最大，
// 已唱句以墨色留在卷上（随距离衰减），未唱句是右侧淡灰底稿。
// 章节色带铺在卷底，副歌加宽提亮 + 底缘网点条。连续单镜头——与商籁（跳切）、版画（换版）正交。
//
// 与 sonnet/tempera 同一方法论：一切运动是播放时间的纯函数（time→space 线性映射，
// x = startTime × pxPerSec），seek 稳定、逐帧可复现。分段自包含（空白/非空白 run +
// 按字符占比插值），不跨模块借时间单位。

import { Application, Container, Graphics, Text, TextStyle } from '../../../../vendor/pixi/pixi.mjs';

const FALLBACK_FONT = '"Noto Sans SC", "Microsoft YaHei", sans-serif';
const PX_PER_SEC_BASE = 90;

/* Aria 行形状 → 秒制 { fullText, startTime, endTime, words[] }
   （与 temperaMode.normalizeTemperaLines 同启发式：全集任一行 start≥1000 判毫秒整体 ÷1000） */
export function normalizeScrollLines(lines) {
    const isMs = lines.some(l => typeof l.start === 'number' && l.start >= 1000);
    const div = isMs ? 1000 : 1;
    return lines.map(l => {
        const rawWords = Array.isArray(l.words) ? l.words : [];
        const fullText = l.original || l.text || rawWords.map(w => w.text || '').join('');
        if (!fullText) return null;
        const startS = typeof l.start === 'number' ? l.start / div : 0;
        /* ★ 2026-10-02 首词消失根修（同 temperaMode）：词级时间逐词 `>= 1000` 猜毫秒，
           首词 <1s 开唱不被除 → 第一个字整首不可见。沿用行级全集判定（div）。 */
        const words = rawWords.map(w => {
            const ws = typeof w.start === 'number' ? w.start / div : startS;
            const we = typeof w.end === 'number' ? w.end / div : ws + 0.3;
            return { text: w.text || '', startTime: Math.max(ws, startS), endTime: Math.max(we, ws + 0.05) };
        }).filter(w => w.text.trim());
        const lastEnd = words.length ? Math.max(...words.map(w => w.endTime)) : startS + 4;
        return {
            fullText,
            startTime: startS,
            endTime: Math.max(lastEnd, startS + 0.5),
            words,
            isChorus: !!l.isChorus,
            /* ★ 2026-10-01 夜（用户实测「长卷没有翻译」）：透传翻译/罗马音行 */
            translation: l.translation || '',
            romaji: l.romaji || '',
        };
    }).filter(Boolean);
}

/* 行内分段：空白/非空白 run，时间按字符占比在线区间内插值（自包含，无跨模块单位） */
function segmentLine(fullText, startS, endS, words) {
    const runs = fullText.match(/\s+|[^\s]+/g) || [];
    const span = Math.max(0.3, endS - startS);
    const total = Math.max(1, fullText.length);
    const out = [];
    let cursor = 0;
    /* 有逐字数据时优先用词时间对齐（词序与去空白 run 序一致）；否则纯占比 */
    const wordTexts = words.map(w => (w.text || '').replace(/\s+/g, ''));
    let wi = 0;
    runs.forEach(run => {
        const t0 = startS + span * (cursor / total);
        cursor += run.length;
        const t1 = startS + span * (cursor / total);
        if (/^\s+$/.test(run)) {
            out.push({ text: run, startTime: t0, endTime: t1, isWordLike: false });
            return;
        }
        const target = run.replace(/\s+/g, '');
        let start = t0; let end = t1;
        if (wordTexts.length > 0) {
            const block = [];
            let acc = '';
            while (wi < wordTexts.length && acc.length < target.length) {
                block.push(words[wi]);
                acc += wordTexts[wi];
                wi += 1;
            }
            if (block.length > 0) {
                start = block[0].startTime;
                end = Math.max(block[block.length - 1].endTime, start + 0.05);
            }
        }
        out.push({ text: run, startTime: start, endTime: end, isWordLike: true });
    });
    return out;
}

/* 章节分组：行间隙 ≥ chapterGapSec 视为新章节 */
function groupChapters(lines, chapterGapSec) {
    const chapters = [];
    let current = [];
    let prevEnd = null;
    lines.forEach(line => {
        if (prevEnd !== null && line.startTime - prevEnd >= chapterGapSec && current.length > 0) {
            chapters.push(current);
            current = [];
        }
        current.push(line);
        prevEnd = line.endTime;
    });
    if (current.length) chapters.push(current);
    return chapters;
}

const mixHex = (a, b, ratio) => {
    const pa = /^#([0-9a-f]{6})$/i.exec(String(a || ''));
    const pb = /^#([0-9a-f]{6})$/i.exec(String(b || ''));
    if (!pa || !pb) return b || a || '#101014';
    const na = parseInt(pa[1], 16);
    const nb = parseInt(pb[1], 16);
    const ch = (shift) => Math.round(
        (((na >> shift) & 0xff) * (1 - ratio)) + (((nb >> shift) & 0xff) * ratio),
    );
    return '#' + [16, 8, 0].map(shift => ch(shift).toString(16).padStart(2, '0')).join('');
};

const colorNum = (hex) => parseInt(/^#([0-9a-f]{6})$/i.exec(hex)[1], 16);

/* ★ 2026-10-01 流水线测宽：Pixi Text 构造期 .width 不可靠（字体未就绪/懒测量
   偏差可达数倍——实测 41 字符行测出 198px 渲染 700px），行间距必须用与
   CanvasTextMetrics 同源的 2D canvas 自测（temperaMeasure 同法）。 */
let _measureCtx = null;
function measureTextWidth(text, fontSize, fontFamily, fontWeight, letterSpacing) {
    if (typeof document === 'undefined') return text.length * fontSize * 0.6;
    if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
    _measureCtx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
    return _measureCtx.measureText(text).width + Math.max(0, text.length - 1) * letterSpacing;
}

export class ScrollEngine {
    constructor(container) {
        this.containerEl = container;
        this.app = null;
        this.destroyed = false;
        this.lines = [];
        this._rawLines = [];
        this.currentTime = 0;
        this.lyricsFontScale = 1.0;
        this.bottomInset = 96;
        this.fontFamily = FALLBACK_FONT;
        this.tuning = {
            scrollSpeed: 1.0,
            chapterBandAlpha: 0.16,
            parallaxStrength: 0.6,
        };
        this.theme = {
            paper: '#101014',
            ink: '#f4f4f5',
            accent: '#E8BE6A',
            secondary: '#4a4e57',
        };
        this._lastError = null;
        this._lastW = 0;
        this._lastH = 0;
    }

    async init() {
        this.app = new Application();
        await this.app.init({
            resizeTo: this.containerEl,
            backgroundAlpha: 1,
            background: '#101014',
            antialias: true,
            autoDensity: true,
            resolution: Math.min(1.5, (typeof window !== 'undefined' && window.devicePixelRatio) || 1),
            autoStart: false,
            sharedTicker: false,
            preference: 'webgl',
        });
        this.app.canvas.style.cssText = 'width:100%;height:100%;display:block';
        this.containerEl.appendChild(this.app.canvas);

        /* 层级：封面色晕（最底）→ 章节色带 → world（歌词行）→ HUD（角标/题字，屏幕系不随卷动） */
        this.bgLayer = new Container();
        this.chapterLayer = new Container();
        this.world = new Container();
        this.hudLayer = new Container();
        this.app.stage.addChild(this.bgLayer);
        this.app.stage.addChild(this.chapterLayer);
        this.app.stage.addChild(this.world);
        this.app.stage.addChild(this.hudLayer);
        this._buildHud();

        this.app.ticker.add(this._tick);
        this.app.start();
        /* ★ 2026-10-01 重叠根因之二：Text 宽度测量发生在 _buildProgram 时——若此刻
           webfont 尚未就绪，测宽走 fallback 字体（偏小），流水线间距按错误宽度结算，
           字体加载后文字变宽但 x0 不变 → 行重叠（app 实测，standalone 复现不了：
           探针页面字体早已就绪）。fonts.ready 后重建一次；已就绪时立刻 resolve，
           多一次幂等重建无副作用。 */
        if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => {
                if (!this.destroyed && this._rawLines.length) this.setLyrics(this._rawLines);
            }).catch(() => { /* ignore */ });
        }
        return this;
    }

    _viewSize() {
        return {
            w: this.app.renderer.width / this.app.renderer.resolution,
            h: this.app.renderer.height / this.app.renderer.resolution,
        };
    }

    _buildHud() {
        this.hudMarks = new Graphics();
        this.hudLayer.addChild(this.hudMarks);
        this.hudTitle = new Text({
            text: '[ 長卷 ] SCROLL',
            style: new TextStyle({
                fontFamily: this.fontFamily,
                fontSize: 13,
                fontWeight: 'bold',
                fill: 0xf4f4f5,
                letterSpacing: 5,
            }),
        });
        this.hudTitle.alpha = 0.22;
        this.hudTitle.rotation = -Math.PI / 2;
        this.hudTitle.anchor.set(0, 1);
        this.hudLayer.addChild(this.hudTitle);
        this._drawHud();
    }

    _drawHud() {
        const { w, h } = this._viewSize();
        const m = 18; const s = 8;
        this.hudMarks.clear();
        this.hudMarks.moveTo(m, m + s).lineTo(m, m).lineTo(m + s, m)
            .stroke({ color: 0xf4f4f5, width: 1.5, alpha: 0.4 });
        this.hudMarks.moveTo(w - m - s, h - m).lineTo(w - m, h - m).lineTo(w - m, h - m - s)
            .stroke({ color: 0xf4f4f5, width: 1.5, alpha: 0.4 });
        this.hudTitle.position.set(16, h - 24);
    }

    setLyrics(rawLines) {
        this._rawLines = rawLines || [];
        if (!this.app) return;
        try {
            this._buildProgram(normalizeScrollLines(this._rawLines));
        } catch (e) {
            this._lastError = String(e && e.stack ? e.stack : e).slice(0, 300);
        }
    }

    _buildProgram(normLines) {
        this.world.removeChildren().forEach(child => child.destroy({ children: true }));
        this.chapterLayer.removeChildren().forEach(child => child.destroy({ children: true }));
        this.bgLayer.removeChildren().forEach(child => child.destroy({ children: true }));
        this.lines = [];
        const { w } = this._viewSize();
        const rawH = this.app.renderer.height / this.app.renderer.resolution;
        /* 预览小窗不钳 96px 内缩（同 SonnetEngine 的小窗豁免） */
        const height = rawH > 300 ? rawH - this.bottomInset : rawH;
        this._height = height;
        this._viewW = w;
        if (normLines.length === 0) return;

        const pxPerSec = PX_PER_SEC_BASE * (this.tuning.scrollSpeed || 1);
        this._pxPerSec = pxPerSec;
        const fontScale = (this.lyricsFontScale || 1) * (this.settingsVars?.fontSize || 1);
        const ink = this.theme.ink;
        const accent = (this.settingsVars?.highlightColor) || this.theme.accent;
        const secondary = this.theme.secondary;
        /* 卡拉 OK 三态色（白字 + tint） */
        this._colors = {
            ink: colorNum(ink),
            accent: colorNum(accent),
            unsung: colorNum(mixHex(mixHex(this.theme.paper, secondary, 0.5), ink, 0.35)),
        };
        /* 卷面底色跟随 paper（封面主色混黑），不再钉死 #101014 */
        try { this.app.renderer.background.color = colorNum(this.theme.paper); } catch (e) { /* ignore */ }

        /* ★ 2026-10-01 视觉升级（用户反馈「长卷不好看」）：封面色晕——对齐 verse 的
           径向渐变语言，左上 primary 晕 + 右下 secondary 晕，低 alpha 铺满全卷 */
        const glowA = new Graphics();
        glowA.ellipse(w * 0.18, height * 0.22, w * 0.5, height * 0.55)
            .fill({ color: colorNum(mixHex(this.theme.paper, accent, 0.3)), alpha: 0.12 });
        const glowB = new Graphics();
        glowB.ellipse(w * 0.85, height * 0.82, w * 0.45, height * 0.5)
            .fill({ color: colorNum(mixHex(this.theme.paper, secondary, 0.35)), alpha: 0.14 });
        this.bgLayer.addChild(glowA);
        this.bgLayer.addChild(glowB);
        /* 轻噪点：1px 点阵铺底（借版画纸感，密度极低不吃性能） */
        const grain = new Graphics();
        for (let gx = 0; gx < w; gx += 26) {
            for (let gy = 0; gy < height; gy += 26) {
                const jitter = ((gx * 7 + gy * 13) % 17) / 17;
                grain.circle(gx + jitter * 12, gy + jitter * 10, 0.8)
                    .fill({ color: this._colors.ink, alpha: 0.045 });
            }
        }
        this.bgLayer.addChild(grain);

        /* ★ 2026-10-01 重做（用户实测「只占左半段 / 歌词重叠 / 要 tempera·verse 级视觉」）：
           1) 字号改屏高基准（8%）而非「时间填槽」——verse/tempera 的大字排版语言；
           2) 实测行宽流水线排布：下一行 x0 = max(时间位, 上一行右缘 + 间隙)——彻底消灭重叠；
           3) 逐字白底 + tint 着色：唱过=墨、正在唱=accent 放大、未唱=纸色弱化（卡拉 OK 色彩契约）；
           4) 超宽行自动换行成多行块。 */

        /* 章节色带（卷底） */
        const chapters = groupChapters(normLines, 3.5);
        if (this.settingsVars?.showChapters !== false) {
            chapters.forEach((chapterLines, _chapterIndex) => {
                const chStart = chapterLines[0].startTime;
                const chEnd = Math.max(...chapterLines.map(l => l.endTime));
                const isChorus = chapterLines.some(l => l.isChorus);
                const hue = isChorus ? accent : secondary;
                const band = new Graphics();
                const bandAlpha = this.tuning.chapterBandAlpha * (isChorus ? 1.6 : 1);
                band.rect(chStart * pxPerSec, 0, Math.max(40, (chEnd - chStart) * pxPerSec), height)
                    .fill({ color: colorNum(mixHex(this.theme.paper, hue, 0.5)), alpha: bandAlpha });
                /* 副歌章节：底缘网点条（借版画 screentone 语言） */
                if (isChorus) {
                    for (let x = chStart * pxPerSec; x < chEnd * pxPerSec; x += 14) {
                        for (let y = height * 0.86; y < height; y += 14) {
                            band.circle(x, y, 1.6).fill({ color: colorNum(hue), alpha: 0.32 });
                        }
                    }
                }
                /* 章节界线 */
                band.moveTo(chStart * pxPerSec, 0).lineTo(chStart * pxPerSec, height)
                    .stroke({ color: colorNum(mixHex(this.theme.paper, hue, 0.7)), width: 2, alpha: 0.5 });
                /* ★ verse 式背景巨型字：章节首行首个词，纸色化巨型铺底 */
                const firstWords = chapterLines[0].fullText.split(/\s+/).filter(Boolean);
                const heroWord = firstWords[0] || chapterLines[0].fullText.slice(0, 2);
                if (heroWord) {
                    const hero = new Text({
                        text: heroWord,
                        style: new TextStyle({
                            fontFamily: this.fontFamily,
                            fontSize: height * 0.52,
                            fontWeight: '900',
                            fill: colorNum(mixHex(this.theme.paper, ink, 0.04)),
                            letterSpacing: height * 0.01,
                        }),
                    });
                    hero.anchor.set(0, 0.5);
                    hero.alpha = 0.22;
                    hero.x = chStart * pxPerSec;
                    hero.y = height * 0.52;
                    this.chapterLayer.addChildAt(hero, 0);
                }
                this.chapterLayer.addChild(band);
            });
        }

        /* 逐行装配（2026-10-01 第三版）：时间位 = startTime × pxPerSec 恒定不动
           （卡拉 OK 同步契约），**每行按自己的时间槽宽折行成多行块**——
           槽宽 = 距下一句的滚动距离：blockW ≤ slotW 保证世界坐标永不重叠，
           长句折成 2–3 行而不是缩小字号（tempera/verse 级大字号得以保留）。
           相机在 _tickInner 里于行块中心之间线性滑动（当前句始终趋向居中）。 */
        normLines.forEach((line, lineIdx) => {
            const segments = segmentLine(line.fullText, line.startTime, line.endTime, line.words);
            if (segments.length === 0) return;

            const timeX = line.startTime * pxPerSec;
            /* 字号：屏高 9.5% 基准 × 副歌 ×1.15 × 用户倍率（2026-10-01 二提：8%→9.5%） */
            let fontSize = Math.max(24, Math.min(170,
                height * 0.095 * (line.isChorus ? 1.15 : 1) * fontScale));
            const nextLine = normLines[lineIdx + 1] || null;
            const slotSec = nextLine ? (nextLine.startTime - line.startTime) : 8;
            /* 槽宽：到下一句的滚动距离 − 边距；间奏长槽夹到屏宽 0.9 */
            const slotW = Math.max(180, Math.min(w * 0.9,
                slotSec * pxPerSec - fontSize * 0.8));
            const fontWeight = line.isChorus ? '900' : '700';
            const letterSpacing = fontSize * 0.06;

            /* 行数预算：整句测宽 → 估行数；>3 行则字号按比例缩小（宽度∝字号） */
            const fullW = measureTextWidth(line.fullText.replace(/\s+/g, ''),
                fontSize, this.fontFamily, fontWeight, letterSpacing);
            const estRows = Math.max(1, Math.ceil(fullW / slotW));
            if (estRows > 3) {
                fontSize = Math.max(20, fontSize * 3 / estRows);
            }
            const maxRowWidth = slotW;
            const rowHeight = fontSize * 1.22;

            const lineContainer = new Container();
            const lineView = {
                line,
                container: lineContainer,
                segments: [],
                fontSize,
                rowHeight,
                blockW: 0,
                blockH: rowHeight,
                x0: timeX,
            };
            /* 换行装配：2D canvas 测宽（Text 构造期 width 不可靠）；
               blockW 必须取「最宽行」而非尾行 cursorX（折行 bug 教训）。
               ★ 2026-10-02 重叠根修（用户截图：中文整句溢出槽宽压住下一句）：
               折行检查 cursorX>0 对行首 segment 永不触发，而中文整句无空格 →
               segmentLine 切出单个超宽 run → 直接越出槽宽。修法：segment 装不进
               当前行剩余宽度就按测宽拆成多块（时间按字符占比切，卡拉 OK 阅读
               顺序不变，粒度从词级降到块级）；拆出的块逐块换行，行宽 ≤ 槽宽
               重新成为硬保证（不可拆的单字符除外，字号下限使其极罕见）。 */
            const splitToFit = (seg, firstAvail, fullWidth) => {
                const n = seg.text.length;
                const span = Math.max(0.05, seg.endTime - seg.startTime);
                const chunks = [];
                let from = 0;
                while (from < n) {
                    const avail = from === 0 ? firstAvail : fullWidth;
                    let lo = 1, hi = n - from, best = 1;
                    while (lo <= hi) {
                        const mid = (lo + hi) >> 1;
                        const wMid = measureTextWidth(
                            seg.text.substr(from, mid), fontSize, this.fontFamily, fontWeight, letterSpacing);
                        if (wMid <= avail) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
                    }
                    const to = from + best;
                    chunks.push({
                        text: seg.text.slice(from, to),
                        startTime: seg.startTime + span * (from / n),
                        endTime: seg.startTime + span * (to / n),
                        isWordLike: seg.isWordLike !== false,
                    });
                    from = to;
                }
                return chunks;
            };
            let cursorX = 0;
            let rowIndex = 0;
            let rowMaxWidth = 0;
            const queue = segments.slice();
            while (queue.length > 0) {
                const segment = queue.shift();
                if (!segment.text.trim()) {
                    cursorX += fontSize * 0.5;
                    rowMaxWidth = Math.max(rowMaxWidth, cursorX);
                    continue;
                }
                const measured = measureTextWidth(segment.text, fontSize, this.fontFamily, fontWeight, letterSpacing);
                if (cursorX > 0 && cursorX + measured > maxRowWidth) {
                    rowMaxWidth = Math.max(rowMaxWidth, cursorX);
                    rowIndex += 1;
                    cursorX = 0;
                }
                const avail = maxRowWidth - cursorX;
                const pieces = (measured > avail && segment.text.length > 1)
                    ? splitToFit(segment, avail, maxRowWidth)
                    : [segment];
                pieces.forEach((piece, pi) => {
                    if (pi > 0) { rowIndex += 1; cursorX = 0; }
                    const text = new Text({
                        text: piece.text,
                        style: new TextStyle({
                            fontFamily: this.fontFamily,
                            fontSize,
                            fontWeight,
                            fill: 0xffffff,   /* 白底字，色彩全靠 tint（卡拉 OK 三态着色） */
                            letterSpacing,
                            /* ★ 副歌词辉光（视觉升级）：accent 微光晕增强主角感 */
                            ...(line.isChorus ? {
                                dropShadow: {
                                    color: colorNum(accent),
                                    blur: 10, distance: 0, angle: 0, alpha: 0.4,
                                },
                            } : {}),
                        }),
                    });
                    text.anchor.set(0, 0.5);
                    const m2 = measureTextWidth(piece.text, fontSize, this.fontFamily, fontWeight, letterSpacing);
                    text.x = cursorX;
                    text.y = rowIndex * rowHeight;
                    lineContainer.addChild(text);
                    lineView.segments.push({
                        text, startTime: piece.startTime, endTime: piece.endTime,
                        isWordLike: piece.isWordLike !== false,
                    });
                    cursorX += m2 + fontSize * 0.16;
                    rowMaxWidth = Math.max(rowMaxWidth, cursorX);
                });
            }
            lineView.blockW = Math.max(1, Math.min(rowMaxWidth - fontSize * 0.16, slotW));
            lineView.blockH = (rowIndex + 1) * rowHeight;
            /* ★ 2026-10-01 夜（用户实测「长卷没有翻译/没有情感词」）：
               1) 翻译：主文本块正下方挂一行 accent 淡色小字（有翻译才占位）；
               2) 情感词：命中 AI 情感词的 segment 标记，卡拉 OK 唱过后保持 accent
                  高亮不回落墨色（tempera wordColors 同语义）。 */
            const emotionWords = (typeof globalThis !== 'undefined'
                && Array.isArray(globalThis.aiEmotionWords)) ? globalThis.aiEmotionWords : [];
            lineView.segments.forEach(seg => {
                const segText = seg.text.text || '';
                seg.isEmotion = emotionWords.some(e => e.word
                    && segText.toLowerCase().includes(String(e.word).toLowerCase()));
            });
            if (line.translation) {
                const transText = new Text({
                    text: line.translation,
                    style: new TextStyle({
                        fontFamily: this.fontFamily,
                        fontSize: Math.max(14, fontSize * 0.42),
                        fontWeight: '600',
                        fill: colorNum(mixHex(ink, accent, 0.35)),
                        letterSpacing: fontSize * 0.03,
                    }),
                });
                transText.anchor.set(0, 0.5);
                transText.y = lineView.blockH + fontSize * 0.3;
                lineContainer.addChild(transText);
                lineView.transH = fontSize * 0.3 + Math.max(14, fontSize * 0.42) * 1.3;
                lineView.blockH += lineView.transH;
            }
            this.world.addChild(lineContainer);
            this.lines.push(lineView);
        });
    }

    setPaused(p) {
        if (!this.app) return;
        if (p) this.app.stop(); else this.app.start();
    }

    update(timeSec) {
        this.currentTime = timeSec;
    }

    /* 每帧：相机 = time × pxPerSec；行深度（当前/历史/底稿）+ 视差 + 逐字书写入场 */
    _tick = () => {
        if (!this.app || this.destroyed) return;
        try {
            this._tickInner();
        } catch (e) {
            this._lastError = String(e && e.stack ? e.stack : e).slice(0, 300);
        }
    };

    _tickInner() {
        const time = this.currentTime || 0;
        const { w, h } = this._viewSize();
        if ((w !== this._lastW || h !== this._lastH) && w >= 160 && h >= 120) {
            this._lastW = w;
            this._lastH = h;
            this._buildProgram(normalizeScrollLines(this._rawLines));
            this._drawHud();
        }

        /* ★ 2026-10-01 夜（用户实测「歌词区域靠上」）：_height 已扣掉底部播放器栏
           96px，其几何中心比屏幕物理中心偏上 48px——补回 inset 的一半让当前句
           正对屏幕中心。 */
        const centerY = (this._height || h) / 2 + (h > 300 ? this.bottomInset / 2 : 0);
        const viewW = this._viewW || w;
        const colors = this._colors || { ink: 0xf4f4f5, accent: 0xE8BE6A, unsung: 0x4a4e57 };

        /* ★ 相机 = 行块中心之间的线性滑动（纯时间函数，seek 稳定）：
           t 落在某行时段内 → 相机从该行中心滑向下一行中心；当前句在起始时刻
           精确居中，随后平滑让位给下一句。x0 = timeX 恒定 → 卡拉 OK 同步不破坏。 */
        let camX = time * (this._pxPerSec || PX_PER_SEC_BASE);
        let curIdx = -1;
        for (let i = this.lines.length - 1; i >= 0; i--) {
            if (time >= this.lines[i].line.startTime) { curIdx = i; break; }
        }
        if (curIdx >= 0) {
            const cur = this.lines[curIdx];
            const cA = cur.x0 + cur.blockW / 2;
            const next = this.lines[curIdx + 1];
            if (next && next.line.startTime > cur.line.startTime) {
                const cB = next.x0 + next.blockW / 2;
                const p = Math.min(1, Math.max(0,
                    (time - cur.line.startTime) / (next.line.startTime - cur.line.startTime)));
                camX = cA + (cB - cA) * p;
            } else {
                camX = cA;
            }
        } else if (this.lines.length > 0) {
            camX = this.lines[0].x0;
        }

        this.lines.forEach((lv, idx) => {
            const d = time - lv.line.startTime;
            const isCurrent = idx === curIdx;

            /* 深度：当前句 1.0；已唱随距离缩小减淡（卷上历史）；未唱右侧底稿 */
            let lineAlpha; let lineScale;
            if (isCurrent) { lineAlpha = 1; lineScale = 1; }
            else if (d > 0) {
                const k = Math.min(1, d / 30);
                lineAlpha = Math.max(0.22, 1 - k * 0.75);
                lineScale = Math.max(0.55, 1 - k * 0.4);
            } else {
                lineAlpha = 0.16;
                lineScale = 0.92;
            }
            /* 超出保留深度的远端历史直接隐藏（性能 + 卷面不糊） */
            lv.container.visible = d <= 60;
            lv.container.alpha = lineAlpha;
            lv.container.scale.set(lineScale);
            /* ★ x 向全行同速（camX 已含行块中心滑动），无相对漂移 → 流水线间距有效；
               块左缘对位（blockW ≤ 槽宽，世界坐标无重叠） */
            lv.container.x = viewW / 2 + (lv.x0 - camX);
            /* 多行块垂直居中 */
            lv.container.y = centerY - lv.blockH / 2 + lv.rowHeight / 2;

            /* ★ 卡拉 OK 三态着色（verse/tempera 视觉语言）：唱过=墨、正在唱=accent 微放大、
               未唱=纸色调弱化。历史行整体保持 sung 色（卷面留墨），当前行逐词点亮。 */
            const animate = isCurrent || (d > 0 && d < 1.5);
            lv.segments.forEach(seg => {
                const sung = time >= seg.endTime;
                const active = time >= seg.startTime && time < seg.endTime;
                if (!animate) {
                    seg.text.tint = seg.isEmotion ? colors.accent : colors.ink;
                    seg.text.alpha = 1;
                    seg.text.scale.set(1);
                    return;
                }
                if (active) {
                    const span = Math.max(0.08, seg.endTime - seg.startTime);
                    const p = Math.min(1, Math.max(0, (time - seg.startTime) / span));
                    seg.text.tint = colors.accent;
                    seg.text.scale.set(1.08 - 0.08 * p);
                    seg.text.alpha = 0.85 + 0.15 * p;
                } else if (sung) {
                    /* ★ 情感词唱过后保持 accent 高亮不回落墨色（tempera wordColors 同语义） */
                    seg.text.tint = seg.isEmotion ? colors.accent : colors.ink;
                    seg.text.alpha = 1;
                    seg.text.scale.set(1);
                } else {
                    seg.text.tint = colors.unsung;
                    seg.text.alpha = 1;
                    seg.text.scale.set(1);
                }
            });
        });
    }

    applySettings(settings) {
        if (!settings) return;
        /* ★ 2026-10-01 接通设置面板（此前只吃 scrollSpeed/fontFamily） */
        if (typeof settings.fontSize === 'number' && settings.fontSize > 0) {
            this.settingsVars = { ...(this.settingsVars || {}), fontSize: settings.fontSize };
        }
        if (typeof settings.highlightColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(settings.highlightColor)) {
            this.settingsVars = { ...(this.settingsVars || {}), highlightColor: settings.highlightColor };
        }
        if (settings.showChapters !== undefined) {
            this.settingsVars = { ...(this.settingsVars || {}), showChapters: settings.showChapters !== false };
        }
        if (typeof settings.scrollSpeed === 'number' && settings.scrollSpeed > 0) {
            this.tuning.scrollSpeed = Math.min(1.4, Math.max(0.7, settings.scrollSpeed));
        }
        if (typeof settings.fontFamily === 'string' && settings.fontFamily
            && settings.fontFamily !== 'default' && settings.fontFamily !== 'inherit') {
            this.fontFamily = settings.fontFamily;
        }
        if (this._rawLines.length) this.setLyrics(this._rawLines);
    }

    destroy() {
        this.destroyed = true;
        if (this.app) {
            try { this.app.destroy({ removeView: true }, { children: true, texture: true }); } catch (e) { /* ignore */ }
            this.app = null;
        }
    }
}
