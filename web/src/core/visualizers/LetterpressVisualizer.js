/**
 * LetterpressVisualizer.js
 * 「活字 Letterpress」歌词视觉 v3：可移动的铅字（活板）如何变成一页印品。
 *
 * 叙事（v3 起强化到肉眼可辨）：
 *   字盘里的**反字铅字** → 唱到哪个字，那枚字模在字盘里落印（翻转 + 压印）
 *   → 版面（色纸）上对应的字被压上墨 → 整句唱完，纸页翻过，下一句继续排版。
 *
 * 关键实现约定：
 * - 巨物（hero 词）**随每一行**更换（取该行最重的词），不再一段不变
 * - 版心逐字吃真实时间轴：优先 line.words（yrcParser 产出的词元 start/end），
 *   无数据才按行区间均分
 * - 每帧只切换 class，**绝不重建 innerHTML**（重建会打断过渡、逐帧掉帧）
 * - 纸页切换用 A/B 双张交叉淡入淡出，中间没有空白瞬间
 */
import { VisualizerBase } from './VisualizerBase.js';
import { buildSceneGroups } from '../lyricSceneGrouper.js';

/* 段落 kind → 纸色变体数组（同 kind 内按段序轮换，告别单调单色） */
const PAPER_BY_KIND = {
  chorus: [
    { cls: 'lp-paper-bright',  ink: 'dark' },
    { cls: 'lp-paper-bright2', ink: 'dark' },
    { cls: 'lp-paper-bright3', ink: 'dark' },
  ],
  lift: [
    { cls: 'lp-paper-bright3', ink: 'dark' },
    { cls: 'lp-paper-bright',  ink: 'dark' },
  ],
  verse: [
    { cls: 'lp-paper-neutral',  ink: 'light' },
    { cls: 'lp-paper-neutral2', ink: 'light' },
    { cls: 'lp-paper-neutral3', ink: 'light' },
    { cls: 'lp-paper-neutral4', ink: 'light' },
  ],
  break: [
    { cls: 'lp-paper-dark',  ink: 'light' },
    { cls: 'lp-paper-dark2', ink: 'light' },
  ],
  breath: [
    { cls: 'lp-paper-dark2', ink: 'light' },
    { cls: 'lp-paper-dark3', ink: 'light' },
  ],
  outro: [
    { cls: 'lp-paper-dark3', ink: 'light' },
  ],
};

/* 版式池：30 款，按段序确定性轮换（gi % 30）。
   设计语言（上游参考项目）：非对称、大留白、电影宽幅一族、角落极端构图、
   少量 ±1.6° 斜置（rotate 走独立属性，不与入场 transform 冲突）。
   巨物锚点在九宫格六位（tl/tr/ml/mr/bl/br）间随版式轮换。 */
const LAYOUTS = [
  { cls: 'lp-layout-duo',        giantAnchor: 'tr' },
  { cls: 'lp-layout-poster',     giantAnchor: 'bl' },
  { cls: 'lp-layout-note',       giantAnchor: 'tr' },
  { cls: 'lp-layout-banner',     giantAnchor: 'br' },
  { cls: 'lp-layout-banner-high', giantAnchor: 'tl' },
  { cls: 'lp-layout-banner-low',  giantAnchor: 'bl' },
  { cls: 'lp-layout-ribbon',      giantAnchor: 'tr' },
  { cls: 'lp-layout-strip',       giantAnchor: 'bl' },
  { cls: 'lp-layout-poster-wide', giantAnchor: 'br' },
  { cls: 'lp-layout-poster-right', giantAnchor: 'bl' },
  { cls: 'lp-layout-canvas',      giantAnchor: 'ml' },
  { cls: 'lp-layout-note-left',   giantAnchor: 'br' },
  { cls: 'lp-layout-card',        giantAnchor: 'tr' },
  { cls: 'lp-layout-ticket',      giantAnchor: 'bl' },
  { cls: 'lp-layout-pillar-left', giantAnchor: 'br' },
  { cls: 'lp-layout-pillar-right', giantAnchor: 'bl' },
  { cls: 'lp-layout-pillar-center', giantAnchor: 'mr' },
  { cls: 'lp-layout-cinema-scope', giantAnchor: 'tl' },
  { cls: 'lp-layout-cinema-upper', giantAnchor: 'bl' },
  { cls: 'lp-layout-cinema-lower', giantAnchor: 'tl' },
  { cls: 'lp-layout-tilt-l',      giantAnchor: 'br' },
  { cls: 'lp-layout-tilt-r',      giantAnchor: 'bl' },
  { cls: 'lp-layout-tilt-poster', giantAnchor: 'tr' },
  { cls: 'lp-layout-corner-tl',   giantAnchor: 'br' },
  { cls: 'lp-layout-corner-tr',   giantAnchor: 'bl' },
  { cls: 'lp-layout-corner-bl',   giantAnchor: 'tr' },
  { cls: 'lp-layout-corner-br',   giantAnchor: 'tl' },
  { cls: 'lp-layout-offset-band', giantAnchor: 'tr' },
  { cls: 'lp-layout-half-l',      giantAnchor: 'br' },
  { cls: 'lp-layout-half-r',      giantAnchor: 'bl' },
];

const isCjkCh = (ch) => /[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch);

/* 单元切分：CJK 每字一单元，拉丁整词一单元，空格独立（保词距，上游 §8.5） */
function splitUnits(text) {
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ t: buf, w: buf.length }); buf = ''; } };
  for (const ch of String(text || '')) {
    if (isCjkCh(ch)) { flush(); out.push({ t: ch, w: 1 }); }
    else if (ch === ' ') { flush(); out.push({ t: ' ', w: 0.35 }); }
    else buf += ch;
  }
  flush();
  return out;
}

/* 把一行拆成「上墨单元」：优先真实词元时间（line.words），无则按区间均分 */
function buildUnits(line) {
  const text = String(line.original || line.text || '').trim();
  const lineStart = line.start !== undefined ? line.start : line.time || 0;
  const lineEnd = line.end !== undefined ? line.end : lineStart + (line.duration || 5000);
  const units = [];
  const words = Array.isArray(line.words) ? line.words.filter(w => w && w.text) : [];
  const pushSplit = (str, ws, we) => {
    const subs = splitUnits(str);
    const tw = subs.reduce((s, x) => s + x.w, 0) || 1;
    let acc = 0;
    for (const su of subs) {
      const s0 = ws + (we - ws) * (acc / tw);
      const s1 = ws + (we - ws) * ((acc + su.w) / tw);
      acc += su.w;
      units.push({ t: su.t, s: s0, e: s1 });
    }
  };
  if (words.length) {
    /* ★ 词间空格修复：部分源（网易 YRC 三参排布、预览合成词元）的词元文本
       不携带空格，直接拼接会吃掉单词间距（预览实测踩坑）。
       以原文为基准推进游标对齐：词元之间被吞掉的空白补成空格单元；
       词元自带的前后空白一律剥离，空格只由 gap 统一供给（避免双空格）。 */
    let cursor = 0;
    let prevEnd = -1;
    for (const w of words) {
      const raw = String(w.text);
      const wtxt = raw.trim();
      const ws = typeof w.start === 'number' ? w.start : lineStart;
      const we = typeof w.end === 'number' ? w.end : ws + 200;
      if (wtxt && cursor < text.length) {
        const idx = text.indexOf(wtxt, cursor);
        if (idx >= 0) {
          const gap = text.slice(cursor, idx);
          if (gap && !/\S/.test(gap) && prevEnd >= 0 && units.length) {
            const gs = Math.min(prevEnd, ws);
            const ge = Math.max(prevEnd, ws);
            units.push({ t: ' ', s: gs, e: Math.max(ge, gs + 60) });
          }
          cursor = idx + wtxt.length;
        }
        /* idx<0：词元与原文对不上（元数据清洗差异），游标不动、不补空格——兜底安全 */
      }
      if (wtxt) pushSplit(wtxt, ws, Math.max(we, ws + 1));
      prevEnd = Math.max(we, ws + 1);
    }
  } else {
    pushSplit(text, lineStart, lineEnd);
  }
  /* 单调性兜底（无零长区间：60ms ≈ 2 帧，1ms 在 timeupdate 频率下来不及上墨） */
  for (let i = 0; i < units.length; i++) {
    if (units[i].e <= units[i].s) units[i].e = units[i].s + 60;
    if (i > 0 && units[i].s < units[i - 1].e) units[i].s = units[i - 1].e;
  }
  return units;
}

/* 一行里的 hero 词：AI 情感词命中优先，其次最长的 CJK 片段，纯拉丁行取最长词 */
function heroOfLine(line, aiData) {
  const text = String(line.original || line.text || '').trim();
  const emoWords = (aiData && Array.isArray(aiData.emotion_words))
    ? aiData.emotion_words.map(w => (typeof w === 'string' ? w : (w && w.word) || '')).filter(Boolean)
    : [];
  for (const w of emoWords) {
    if (w.length >= 2 && text.includes(w)) {
      /* CJK 词可截 4 字；拉丁词绝不腰斩（"story" 截成 "stor" 的教训） */
      return isCjkCh(w[0]) ? w.slice(0, 4) : w;
    }
  }
  let best = '';
  for (const seg of text.split(/\s+/)) {
    const cjk = Array.from(seg).filter(isCjkCh).join('');
    if (cjk.length > best.length) best = cjk;
  }
  if (best) return best.slice(0, 4);
  /* ★ 纯拉丁行（英文歌等）：取最长词的前 6 字符做店招——此前返回空串，
     英文歌整首没有店招巨物（用户反馈：活字英文歌观感单薄、纸色还白）。 */
  let bestWord = '';
  for (const seg of text.split(/\s+/)) {
    const w = seg.replace(/[^\p{L}\p{N}]/gu, '');
    if (w.length > bestWord.length) bestWord = w;
  }
  return bestWord.slice(0, 6);
}

export class LetterpressVisualizer extends VisualizerBase {
  constructor(container, options = {}) {
    super(container, options);
    this.sections = [];
    this.lineSection = [];
    this.currentPage = -1;
    this.activeSlot = 0;
    this.charEls = [];
    this.giantChars = [];
    this._curLine = null;
  }

  getModeId() { return 'letterpress'; }

  /* 字号：外观面板的滑杆是乘数（0.5~2.0x）；若历史数据是 px（≥8）则按基准 56 归一 */
  onApplySettings(settings = {}) {
    const fs = parseFloat(settings.fontSize);
    if (fs > 0 && this.viewContainer) {
      const scale = fs >= 8 ? fs / 56 : fs;
      this.viewContainer.style.setProperty('--lp-font-scale', scale.toFixed(3));
    }
    /* 翻译开关：默认开（undefined 视为显示，与其它模式一致） */
    this.showTranslation = settings.showTranslation !== false;
  }

  onInit() {
    this.viewContainer.classList.add('lp-stage');
    /* A/B 双张纸页：交叉淡入淡出，换段时中间不留空白 */
    this.viewContainer.innerHTML = `
      <div class="lp-paper lp-paper-a"></div>
      <div class="lp-paper lp-paper-b"></div>`;
    this.slots = [
      this.viewContainer.querySelector('.lp-paper-a'),
      this.viewContainer.querySelector('.lp-paper-b'),
    ];
    this.buildSlot(this.slots[0]);
    this.buildSlot(this.slots[1]);
    this.slots[0].classList.add('is-active');
    /* ★ 隐藏测量层：预计算下一页 fit 字号用——绝不写纸槽（写槽与挂起激活/自愈
       竞态，会把下一页内容写进当前可见画面）。visibility:hidden + 独立定位。 */
    const mea = document.createElement('div');
    mea.className = 'lp-paper lp-mea';
    this.viewContainer.appendChild(mea);
    this._meaEl = mea;
    this._preFit = null;
    /* ★ 字体加载完成 → 立刻重算适配（FOUT 根治）：自定义字体异步加载，
       首行先用回退字体排版，真字体到达后重新折行——版心居中布局会"突然上跳"，
       且用回退字体量出的尺寸对宽字体必然偏小（溢出纸页）。
       监听 loadingdone + fonts.ready，对当前纸页重跑 fitBody。 */
    this._refit = () => {
      const slot = this.slots[this.activeSlot];
      if (slot) this.fitBody(slot);
    };
    document.fonts.addEventListener?.('loadingdone', this._refit);
    document.fonts.ready?.then(this._refit);
  }

  /* 每张纸页内部结构（一次建好，后续只改内容与 class） */
  buildSlot(slot) {
    slot.innerHTML = `
      <div class="lp-giant"></div>
      <div class="lp-roller"></div>
      <div class="lp-body">
        <div class="lp-main"></div>
        <div class="lp-trans"></div>
      </div>`;
    slot._giant = slot.querySelector('.lp-giant');
    slot._roller = slot.querySelector('.lp-roller');
    slot._main = slot.querySelector('.lp-main');
    slot._trans = slot.querySelector('.lp-trans');
  }

  onLyricsLoaded() {
    /* ★ 纯音乐（无歌词）：合成一页「纯音乐 请欣赏」，走正常渲染流程 */
    if (!this.lines || !this.lines.length) {
      this.lines = [{ original: '纯音乐', start: 0, end: 3600000, translation: '请欣赏' }];
    }
    const groups = buildSceneGroups(this.lines, { maxLines: 6, maxSpanSec: 7 }) || [];
    this.sections = groups.map((g, gi) => {
      const kind = g.kind || 'verse';
      const lineIdx = [];
      for (const ln of g.lines) {
        const i = this.lines.indexOf(ln);
        if (i >= 0) lineIdx.push(i);
      }
      const papers = PAPER_BY_KIND[kind] || PAPER_BY_KIND.verse;
      return {
        gi, kind,
        paper: papers[gi % papers.length],
        layout: LAYOUTS[gi % LAYOUTS.length],
        lineIdx,
      };
    });
    this.lineSection = [];
    for (const s of this.sections) for (const i of s.lineIdx) this.lineSection[i] = s;
    this.currentPage = -1;
    this._preGi = null;        /* 新歌词：预排缓存失效 */
    this._pendingApply = null;
  }

  onLineChange(activeIdx, line) {
    /* ★ 字体未就绪：保留当前画面，整次换行挂起，就绪后应用**最新**行。
       FOUT 期间渲染必然"先按回退字体排版→真字体到达重新折行→版面上跳"，
       用户要求预计算、不显示调整过程——挂起是唯一根治法。 */
    if (!this._fontsReady) {
      this._pendingApply = { activeIdx, line };
      /* ★ 冲刷必须自带出口（置 _fontsReady=true + 1.2s 超时兜底）：
         否则 fonts.ready 若在挂起后才 resolve，flush 会再次进挂起分支 →
         无限微任务循环 → 渲染进程崩溃（探针实测踩坑） */
      let fired = false;
      const flush = () => {
        if (fired) return;
        fired = true;
        this._fontsReady = true;
        const p = this._pendingApply;
        if (p) { this._pendingApply = null; this.onLineChange(p.activeIdx, p.line); }
      };
      document.fonts.ready?.then(flush);
      setTimeout(flush, 1200);
      return;
    }
    const sec = this.lineSection[activeIdx] || this.sections.find(s => s.lineIdx.includes(activeIdx));
    if (!sec) return;
    this._activeIdx = activeIdx;
    this._curGi = sec.gi;
    this._curLine = line;
    if (this.currentPage !== sec.gi) {
      this.currentPage = sec.gi;
      this.swapPaper(sec, line);
    } else {
      this.renderLine(line);
    }
  }

  /* 纸页切换（提前计算版）：
     1) 内容先填到**非活动槽**（离屏，用户不可见）；
     2) 等字体就绪（或 800ms 兜底）后同步跑 renderLine+fitBody——尺寸算好；
     3) 最后一步才交叉上屏。全程无可见的调整过程。 */
  swapPaper(sec, line) {
    const outgoing = this.slots[this.activeSlot];
    const incoming = this.slots[1 - this.activeSlot];
    incoming.className = `lp-paper lp-paper-${(1 - this.activeSlot) === 1 ? 'b' : 'a'} ${sec.paper.cls} ${sec.layout.cls}`;
    incoming.dataset.ink = sec.paper.ink;
    incoming._giant.className = `lp-giant lp-giant-${sec.layout.giantAnchor}`;
    incoming._giant.textContent = '';
    incoming._main.innerHTML = '';
    incoming._trans.textContent = '';
    this._renderSlot = incoming;
    const activate = () => {
      /* ★ 防御：真实歌词数据触发 renderLine 异常时，降级为无 fit 的直接显示，
         绝不让整页空白（用户反馈"活字什么东西都没了"的可能来源之一） */
      try {
        this.renderLine(line, incoming);            /* 填充 + fitBody 同步完成 */
      } catch (e) {
        try {
          incoming._main.innerHTML = '';
          const span = document.createElement('span');
          span.className = 'lp-char lp-sung';
          span.textContent = String(line.original || line.text || '');
          incoming._main.appendChild(span);
          incoming._trans.textContent = String(line.trans || line.translation || '');
        } catch (e2) { /* 保底失败也只能放弃 */ }
      }
      incoming._roller.classList.remove('lp-inking');
      void incoming._roller.offsetWidth;
      incoming._roller.classList.add('lp-inking');
      outgoing.classList.remove('is-active');
      incoming.classList.add('is-active');
      if (this.activeSlot !== 1 - this.activeSlot) this.activeSlot = 1 - this.activeSlot;
      this._renderSlot = null;
    };
    this.whenSettled(activate);
  }

  /* 字体就绪门：就绪（或 800ms 兜底）才执行 fn——保证上屏前完成排版计算 */
  whenSettled(fn) {
    if (this._fontsReady) { fn(); return; }
    let done = false;
    const once = () => { if (done) return; done = true; this._fontsReady = true; fn(); };
    document.fonts.ready?.then(once);
    setTimeout(once, 800);
  }

  /* 渲染一行：版心逐字 + 字盘字模 + 巨物（本行 hero 词） */
  renderLine(line, slot = this._renderSlot || this.slots[this.activeSlot]) {
    const units = buildUnits(line);

    /* ① 版心 */
    this.charEls = [];
    slot._main.innerHTML = '';
    for (const u of units) {
      const span = document.createElement('span');
      span.className = 'lp-char' + (u.t === ' ' ? ' lp-space' : '');
      span.textContent = u.t;
      span.dataset.start = String(Math.round(u.s));
      span.dataset.end = String(Math.round(u.e));
      /* 手排铅字的微歪斜（确定性 ±0.5°） */
      span.style.setProperty('--char-tilt', (((this.charEls.length % 3) - 1) * 0.5).toFixed(2) + 'deg');
      slot._main.appendChild(span);
      this.charEls.push(span);
    }

    /* ② 钢印标记：情感词命中 → 唱响时用强调色；每个字带确定性墨量（手压不匀） */
    const full = units.map(u => u.t).join('');
    const emoHits = [];
    const emoWords = (this.aiData && Array.isArray(this.aiData.emotion_words))
      ? this.aiData.emotion_words.map(w => (typeof w === 'string' ? w : (w && w.word) || '')).filter(w => w && w.length)
      : [];
    for (const ew of emoWords) {
      let from = 0;
      while (emoHits.length < 400) {
        const i = full.indexOf(ew, from);
        if (i < 0) break;
        emoHits.push([i, i + ew.length]);
        from = i + ew.length;
      }
    }
    let off = 0;
    units.forEach((u, ui) => {
      const isEmo = emoHits.some(([a, b]) => off < b && (off + u.t.length) > a);
      if (isEmo) this.charEls[ui].classList.add('lp-emotion');
      /* 手压墨量不均：0.9~1.0 确定性波动（压印的真实感） */
      const ink = 0.9 + ((ui * 37) % 11) / 100;
      this.charEls[ui].style.setProperty('--char-ink', ink.toFixed(2));
      off += u.t.length;
    });

    /* ③ 巨物：本行 hero 词（逐行更换）；span 一次建好，之后只切 class */
    const hero = heroOfLine(line, this.aiData) || '';
    slot._giant.dataset.hero = hero;
    slot._giant.innerHTML = '';
    this.giantChars = [];
    for (const ch of Array.from(hero)) {
      const s = document.createElement('span');
      s.className = 'lp-giant-ch';
      s.textContent = ch;
      slot._giant.appendChild(s);
      this.giantChars.push(s);
    }

    /* ④ 巨物自适应：字幅大的字体（像素体等）下 2.2em 可能超出纸页宽，逐级缩到放得下 */
    slot._giant.style.fontSize = '';
    let gGuard = 0;
    while (gGuard < 10 && slot._giant.scrollWidth > slot.clientWidth * 0.94) {
      const cur = parseFloat(slot._giant.style.fontSize) ||
                  parseFloat(getComputedStyle(slot._giant).fontSize) || 100;
      slot._giant.style.fontSize = (cur * 0.88).toFixed(1) + 'px';
      gGuard++;
    }

    /* ⑤ 翻译：按设置开关显隐（此前忽略 showTranslation，开关无效） */
    const trans = String(line.trans || line.translation || '');
    slot._trans.textContent = trans;
    slot._trans.style.display = (this.showTranslation && trans) ? '' : 'none';
    /* ★ 落印：巨物以重压入场（大→正、虚→实），像整块大字字模压进纸里 */
    slot._giant.classList.remove('lp-giant-press');
    void slot._giant.offsetWidth;
    if (hero) slot._giant.classList.add('lp-giant-press');
    this.fitBody(slot, this._curGi != null ? this._curGi : null);
  }

  destroy() {
    if (this._refit) document.fonts.removeEventListener?.('loadingdone', this._refit);
    super.destroy();
  }

  /* 版心字号自适应：量**整个版心块**（主歌词+翻译）——只量主歌词时翻译会溢出纸页。
     超出就逐级缩小（×0.86，最多 8 级）。 */
  fitBody(slot, gi = null) {
    if (!slot || !slot._main) return;
    /* ★ 缩放纸页根字号：主歌词/翻译/巨物都以 em 挂在它下面，整体等比缩放。
       ★ 有预计算结果（同 gi）直接套用，0 次迭代；否则走收缩循环。
       ★ 判定要同时看高与宽：像素字体等自定义字体的字幅远宽于常规字体。 */
    const pre = (gi != null && this._preFit && this._preFit.gi === gi) ? this._preFit.size : null;
    if (pre) { slot.style.fontSize = pre; this._preFit = null; }
    else slot.style.fontSize = '';
    const body = slot.querySelector('.lp-body');
    if (!body) return;
    const fits = () => {
      void slot.offsetHeight;                 /* ★ 强制重排：字号刚改过，禁止读到脏布局 */
      return body.scrollHeight <= slot.clientHeight * 0.60 &&
             body.scrollWidth <= slot.clientWidth;
    };
    let guard = 0;
    while (guard < 16 && !fits()) {
      const cur = parseFloat(slot.style.fontSize) ||
                  parseFloat(getComputedStyle(slot).fontSize) || 48;
      slot.style.fontSize = (cur * 0.84).toFixed(1) + 'px';
      guard++;
    }
  }

  /* ★ 溢出自愈：任何原因（FOUT、字体切换、渲染中途异常跳过 fitBody）导致的
     版心超界，都会在下一帧被检测并当场重跑 fitBody——不再依赖"找出所有
     可能的溢出场景"，而是让结果自适应收敛。每帧两次 getBoundingClientRect，
     元素少，开销可忽略。 */
  checkOverflow() {
    const slot = this.slots[this.activeSlot];
    if (!slot || !slot._main) return;
    const body = slot.querySelector('.lp-body');
    if (!body) return;
    const pr = slot.getBoundingClientRect();
    const br = body.getBoundingClientRect();
    if (br.bottom > pr.bottom + 1 || br.right > pr.right + 1 || br.top < pr.top - 1) {
      this.fitBody(slot);
    }
  }

  /* ★ 后台预计算下一页 fit 字号：在隐藏测量层用「下一页版式 + 下一行内容」
     量出合适的字号，存 _preFit；换页上屏时直接套用（0 次迭代），调整全程不可见。
     不写纸槽——写槽与挂起激活/自愈竞态（实测会把下一页内容写进当前画面）。 */
  maybePreRenderNext() {
    if (!this._fontsReady || !this._curLine) return;
    if (!this.lines || !this.lines.length || !this._meaEl) return;
    const nextIdx = (this._activeIdx != null ? this._activeIdx : -1) + 1;
    const nextLine = this.lines[nextIdx];
    if (!nextLine) return;
    const nextSec = this.lineSection[nextIdx];
    if (!nextSec) return;
    if (this._preFit && this._preFit.gi === nextSec.gi) return;   /* 已预算 */
    const mea = this._meaEl;
    mea.className = `lp-paper lp-mea ${nextSec.paper.cls} ${nextSec.layout.cls}`;
    mea.style.fontSize = '';
    /* 用下一行内容在测量层跑一遍收缩，得到目标字号 */
    const savedMain = mea.querySelector('.lp-main');
    if (savedMain) savedMain.innerHTML = '';
    const units = buildUnits(nextLine);
    if (savedMain && units) {
      for (const u of units) {
        const sp = document.createElement('span');
        sp.className = 'lp-char' + (u.t === ' ' ? ' lp-space' : '');
        sp.textContent = u.t;
        savedMain.appendChild(sp);
      }
      const trans = mea.querySelector('.lp-trans');
      if (trans) trans.textContent = String(nextLine.trans || nextLine.translation || '');
      let guard = 0;
      const fits = () => {
        void mea.offsetHeight;
        return mea.querySelector('.lp-body').scrollHeight <= mea.clientHeight * 0.60 &&
               mea.querySelector('.lp-body').scrollWidth <= mea.clientWidth;
      };
      while (guard < 16 && !fits()) {
        const cur = parseFloat(getComputedStyle(mea).fontSize) || 48;
        mea.style.fontSize = (cur * 0.84).toFixed(1) + 'px';
        guard++;
      }
      this._preFit = { gi: nextSec.gi, size: mea.style.fontSize };
    }
  }

  /* 每帧只切 class（零重建、零重排，过渡不会被切断） */
  onUpdate(timeMs) {
    this.maybePreRenderNext();
    this.checkOverflow();
    for (const span of this.charEls) {
      const s = +span.dataset.start, e = +span.dataset.end;
      if (timeMs >= e) {
        if (!span.classList.contains('lp-sung')) span.classList.add('lp-sung');
        span.classList.remove('lp-active');
      } else if (timeMs >= s) {
        span.classList.add('lp-sung', 'lp-active');
      } else {
        span.classList.remove('lp-sung', 'lp-active');
      }
    }
    /* 巨物跟着唱到哪一字上墨 */
    const line = this._curLine;
    if (line && this.giantChars.length) {
      const ls = line.start !== undefined ? line.start : line.time || 0;
      const le = line.end !== undefined ? line.end : ls + (line.duration || 5000);
      const p = Math.max(0, Math.min(1, (timeMs - ls) / Math.max(1, le - ls)));
      const lit = Math.floor(p * this.giantChars.length);
      this.giantChars.forEach((ch, i) => ch.classList.toggle('lp-giant-sung', i < lit));
    }
  }
}
