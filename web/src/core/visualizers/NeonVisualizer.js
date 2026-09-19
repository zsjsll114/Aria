/**
 * NeonVisualizer.js
 * 「霓虹 Neon Sign」歌词视觉：深夜街角的灯牌。
 *
 * 叙事：
 *   未唱的字是熄灭的灯管（空心描边，管形隐约可见）→ 唱到的字逐字「通电」
 *   （电流不稳地闪两下 → 白炽内芯 + 霓虹辉光全开）→ 整句唱完，灯牌全亮。
 *   段落情绪决定灯管颜色与功率：副歌全功率爆亮，间奏/呼吸段是昏黄钠灯。
 *
 * 底层架构与活字同源（独立副本，避免耦合）：buildUnits 词元切分 / 字符状态机 /
 * A/B 双牌交叉淡入 / whenSettled 字体就绪门 / fitBody 收缩 + checkOverflow
 * 自愈 + maybePreRenderNext 后台预计算。视觉层完全不同：灯牌（暗管→通电）
 * vs 纸页（无墨→压印）。
 *
 * 确定性：无 Math.random——灯色/构图/功率全部由段落序号 gi 取模轮换。
 * 每帧只切 class，绝不重建 innerHTML（重建打断过渡、逐帧掉帧）。
 */
import { VisualizerBase } from './VisualizerBase.js';
import { buildSceneGroups } from '../lyricSceneGrouper.js';

/* 段落 kind → 霓虹灯色板（段内同一色，段间按 gi 轮换）：
   chorus 高饱和暖色（粉/金/电光青），verse 冷色（青/蓝紫/薄荷），
   break/breath/outro 昏黄钠灯与月白（深夜收档的灯牌） */
const NEON_BY_KIND = {
  chorus: ['#ff5c8a', '#ffb347', '#7df9ff'],
  lift:   ['#7df9ff', '#b28dff'],
  verse:  ['#6ee7ff', '#8f9dff', '#7dffb3', '#c9b8ff'],
  break:  ['#c9a86a', '#9aa7b8'],
  breath: ['#c9a86a', '#9aa7b8'],
  outro:  ['#9aa7b8'],
};

/* 功率档：chorus 全功率爆亮，dim 档更昏暗静谧 */
const POWER_BY_KIND = {
  chorus: 'neon-power-chorus',
  lift:   'neon-power-lift',
  verse:  'neon-power-verse',
  break:  'neon-power-dim',
  breath: 'neon-power-dim',
  outro:  'neon-power-dim',
};

/* 10 款灯牌构图（段序确定性轮换）：位置/宽高/对齐 + 店招锚点。
   ★ 安全线：top+height 全部 ≤ 76%——底部控制栏（z-index 90）恒在灯牌之下不被遮挡。 */
const SIGNS = [
  { cls: 'neon-layout-center',      hero: 'tl' },
  { cls: 'neon-layout-wide-top',    hero: 'bl' },
  { cls: 'neon-layout-wide-bottom', hero: 'tl' },
  { cls: 'neon-layout-left',        hero: 'tr' },
  { cls: 'neon-layout-right',       hero: 'tl' },
  { cls: 'neon-layout-strip',       hero: 'br' },
  { cls: 'neon-layout-cinema',      hero: 'tr' },
  { cls: 'neon-layout-corner',      hero: 'bl' },
  { cls: 'neon-layout-offset',      hero: 'br' },
  { cls: 'neon-layout-half',        hero: 'tr' },
];

const isCjkCh = (ch) => /[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch);

/* 单元切分：CJK 每字一单元，拉丁整词一单元，空格独立（保词距）——与活字同源 */
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

/* 把一行拆成「通电单元」：优先真实词元时间（line.words），无则按区间均分 */
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
  /* 单调性兜底（无零长区间） */
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
     英文歌整首没有店招巨物（与活字同款修复）。 */
  let bestWord = '';
  for (const seg of text.split(/\s+/)) {
    const w = seg.replace(/[^\p{L}\p{N}]/gu, '');
    if (w.length > bestWord.length) bestWord = w;
  }
  return bestWord.slice(0, 6);
}

/* 两矩形是否相交（fitGiant 用）：店招巨物压到版心正文即算遮挡 */
function rectsOverlap(a, b) {
  if (!a || !b) return false;
  const ra = a.getBoundingClientRect();
  const rb = b.getBoundingClientRect();
  return ra.left < rb.right && ra.right > rb.left &&
         ra.top < rb.bottom && ra.bottom > rb.top;
}

export class NeonVisualizer extends VisualizerBase {
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

  getModeId() { return 'neon'; }

  /* 字号：外观面板的滑杆是乘数（0.5~2.0x）；历史 px 值（≥8）按基准 56 归一 */
  onApplySettings(settings = {}) {
    const fs = parseFloat(settings.fontSize);
    if (fs > 0 && this.viewContainer) {
      const scale = fs >= 8 ? fs / 56 : fs;
      this.viewContainer.style.setProperty('--neon-font-scale', scale.toFixed(3));
    }
    /* 翻译开关：默认开（undefined 视为显示） */
    this.showTranslation = settings.showTranslation !== false;
  }

  onInit() {
    this.viewContainer.classList.add('neon-stage');
    /* A/B 双灯牌：交叉淡入淡出，换段时中间不留空白 */
    this.viewContainer.innerHTML = `
      <div class="neon-sign neon-sign-a"></div>
      <div class="neon-sign neon-sign-b"></div>`;
    this.slots = [
      this.viewContainer.querySelector('.neon-sign-a'),
      this.viewContainer.querySelector('.neon-sign-b'),
    ];
    this.buildSlot(this.slots[0]);
    this.buildSlot(this.slots[1]);
    this.slots[0].classList.add('is-active');
    /* 隐藏测量层：预计算下一块牌 fit 字号用——绝不写可见牌（写槽与挂起激活/
       自愈竞态会把下一块牌内容写进当前画面）。visibility:hidden + 独立定位。 */
    const mea = document.createElement('div');
    mea.className = 'neon-sign neon-mea';
    this.viewContainer.appendChild(mea);
    this._meaEl = mea;
    this._preFit = null;
    /* 字体加载完成 → 立刻重算适配（FOUT 根治，同活字）。
       巨物一并复位：fitGiant 可能给过显式字号/隐藏，字体就绪后必须
       回到基准重算，否则店招尺寸失真或被错误隐藏（SVG 版字号在 text 上）。 */
    this._refit = () => {
      const slot = this.slots[this.activeSlot];
      if (!slot) return;
      if (slot._giant) slot._giant.style.display = '';
      if (slot._giantText) slot._giantText.style.fontSize = '';
      this.fitBody(slot);
      this.fitGiant(slot);
    };
    document.fonts.addEventListener?.('loadingdone', this._refit);
    document.fonts.ready?.then(this._refit);
    /* ★ 无歌词加载态（用户反馈：加载时左上角一直挂空框）：初始灯牌无 layout 类、
       无位置样式 → absolute 默认堆在左上角收缩成空框。补居中布局 + 合成占位行，
       歌词到位后 setLyrics → onLyricsLoaded 正常重置。 */
    this.slots[0].classList.add('neon-layout-center');
    try {
      this.renderLine({ original: '♪', translation: '歌词加载中 …' }, this.slots[0]);
      this.fitBody(this.slots[0]);
    } catch (e) { /* 占位失败只影响过渡观感 */ }
  }

  /* 每块灯牌内部结构（一次建好，后续只改内容与 class）。
     ★ 店招巨物改用 SVG <text>（用户确认方向）：SVG 的 stroke-linejoin/linecap
     = round 给出真圆角灯管折弯（CSS text-stroke 无 linejoin 控制），
     paint-order 同款单线；viewBox 等比缩放让巨物字号自适应免费获得。 */
  buildSlot(slot) {
    slot.innerHTML = `
      <svg class="neon-giant" viewBox="0 0 100 26" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <text class="neon-giant-text" x="50" y="13" text-anchor="middle" dominant-baseline="central"></text>
      </svg>
      <div class="neon-body">
        <div class="neon-main"></div>
        <div class="neon-trans"></div>
      </div>`;
    slot._giant = slot.querySelector('.neon-giant');
    slot._giantText = slot.querySelector('.neon-giant-text');
    slot._main = slot.querySelector('.neon-main');
    slot._trans = slot.querySelector('.neon-trans');
  }

  onLyricsLoaded() {
    /* 纯音乐（无歌词）：合成一块「纯音乐 请欣赏」灯牌，走正常渲染流程 */
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
      const colors = NEON_BY_KIND[kind] || NEON_BY_KIND.verse;
      return {
        gi, kind,
        neonColor: colors[gi % colors.length],
        powerCls: POWER_BY_KIND[kind] || POWER_BY_KIND.verse,
        sign: SIGNS[gi % SIGNS.length],
        lineIdx,
      };
    });
    this.lineSection = [];
    for (const s of this.sections) for (const i of s.lineIdx) this.lineSection[i] = s;
    this.currentPage = -1;
    this._preGi = null;
    this._pendingApply = null;
  }

  onLineChange(activeIdx, line) {
    /* 字体未就绪：保留当前画面，整次换行挂起，就绪后应用最新行（同活字，
       flush 自带出口防无限微任务循环） */
    if (!this._fontsReady) {
      this._pendingApply = { activeIdx, line };
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
      this.swapSign(sec, line);
    } else {
      this.renderLine(line);
    }
  }

  /* 灯牌切换（预计算版，同活字 swapPaper 结构）：
     1) 内容先填到非活动牌（离屏）；2) 等字体就绪后同步跑 renderLine+fitBody；
     3) 最后一步才交叉上屏。全程无可见的调整过程。 */
  swapSign(sec, line) {
    const outgoing = this.slots[this.activeSlot];
    const incoming = this.slots[1 - this.activeSlot];
    incoming.className = `neon-sign neon-sign-${(1 - this.activeSlot) === 1 ? 'b' : 'a'} ${sec.sign.cls} ${sec.powerCls}`;
    incoming.style.setProperty('--neon-c', sec.neonColor);
    incoming.dataset.kind = sec.kind;
    /* ★ SVG 元素的 className 是只读 getter（SVGAnimatedString）——直接赋值抛
       TypeError（用户实测：霓虹只显示左上角空框后整页卡死）。必须 setAttribute。 */
    incoming._giant.setAttribute('class', `neon-giant neon-giant-${sec.sign.hero}`);
    /* ★ 清店招内容必须清 <text> 的子内容（_giantText），不能清 <svg> 根——
       textContent='' 会把 text 元素从 DOM 摘除，_giantText 从此指向孤儿节点，
       巨物词永远填不回画面（用户实测：店招消失）。 */
    incoming._giantText.textContent = '';
    incoming._main.innerHTML = '';
    incoming._trans.textContent = '';
    incoming._trans.style.display = 'none';
    this._renderSlot = incoming;
    const activate = () => {
      /* 防御：渲染异常时降级为无 fit 的直接显示，绝不让整块牌空白 */
      try {
        this.renderLine(line, incoming);
      } catch (e) {
        try {
          incoming._main.innerHTML = '';
          const span = document.createElement('span');
          span.className = 'neon-char neon-lit';
          span.textContent = String(line.original || line.text || '');
          incoming._main.appendChild(span);
          incoming._trans.textContent = String(line.trans || line.translation || '');
        } catch (e2) { /* 保底失败也只能放弃 */ }
      }
      outgoing.classList.remove('is-active');
      incoming.classList.add('is-active');
      if (this.activeSlot !== 1 - this.activeSlot) this.activeSlot = 1 - this.activeSlot;
      this._renderSlot = null;
    };
    this.whenSettled(activate);
  }

  /* 字体就绪门：就绪（或 800ms 兜底）才执行 fn */
  whenSettled(fn) {
    if (this._fontsReady) { fn(); return; }
    let done = false;
    const once = () => { if (done) return; done = true; this._fontsReady = true; fn(); };
    document.fonts.ready?.then(once);
    setTimeout(once, 800);
  }

  /* 渲染一行：版心逐字 + 店招巨物（本行 hero 词）+ 翻译字条 */
  renderLine(line, slot = this._renderSlot || this.slots[this.activeSlot]) {
    const units = buildUnits(line);

    /* ① 版心：暗管字符（点亮由 onUpdate 状态机驱动）。
       ★ 每字一个独立 SVG <text>（用户实测反馈：HTML text-stroke 无 linejoin，
       折角是方的、不像霓虹灯管）——SVG 的 stroke-linejoin:round + paint-order
       单线方案给出真圆角灯管，lit 时管体烧成灯色。CJK 每字 1em、拉丁/数字按
       0.6em/字符估宽（900 字重 Helvetica 900 字宽 ≈ 0.55em，留 0.05 呼吸）。 */
    this.charEls = [];
    slot._main.innerHTML = '';
    for (const u of units) {
      if (u.t === ' ') {
        const sp = document.createElement('span');
        sp.className = 'neon-char neon-space';
        sp.dataset.start = String(Math.round(u.s));
        sp.dataset.end = String(Math.round(u.e));
        slot._main.appendChild(sp);
        this.charEls.push(sp);
        continue;
      }
      /* ★ 宽度校准（用户实测预览：拉丁词粘连「inthe」——0.56em/字符偏大，
         Helvetica 900 小写实宽 ≈0.5em；CJK 字面 ≈0.9em 按 0.94em 占位） */
      const isWord = Array.from(u.t).length > 1;    /* CJK 每字一单元，多字符=拉丁词 */
      const wEm = isWord ? (u.t.length * 0.52) : (isCjkCh(u.t[0]) ? 0.94 : 0.55);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'neon-char');
      svg.setAttribute('viewBox', isWord ? `0 0 ${u.t.length * 52} 100` : '0 0 100 100');
      svg.setAttribute('aria-hidden', 'true');
      svg.dataset.start = String(Math.round(u.s));
      svg.dataset.end = String(Math.round(u.e));
      svg.style.width = `${wEm.toFixed(2)}em`;
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', '50');
      t.setAttribute('y', '50');
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('dominant-baseline', 'central');
      t.textContent = u.t;
      svg.appendChild(t);
      slot._main.appendChild(svg);
      this.charEls.push(svg);
    }

    /* ② 情感词标记：命中字符点亮时烧成 AI 情感色（emotion_words[]..color，
       无色回退段落灯色）——每字局部覆盖 --neon-c，lit/hot/emo 全链路跟随 */
    const full = units.map(u => u.t).join('');
    const emoHits = [];
    const emoWords = (this.aiData && Array.isArray(this.aiData.emotion_words))
      ? this.aiData.emotion_words.map(w => (typeof w === 'string' ? w : (w && w.word) || '')).filter(w => w && w.length)
      : [];
    const emoColors = (this.aiData && Array.isArray(this.aiData.emotion_words))
      ? this.aiData.emotion_words.map(w => (w && typeof w === 'object' && w.color) || '')
      : [];
    for (let wi = 0; wi < emoWords.length; wi++) {
      let from = 0;
      while (emoHits.length < 400) {
        const i = full.indexOf(emoWords[wi], from);
        if (i < 0) break;
        emoHits.push([i, i + emoWords[wi].length, emoColors[wi] || '']);
        from = i + emoWords[wi].length;
      }
    }
    let off = 0;
    units.forEach((u, ui) => {
      const hit = emoHits.find(([a, b]) => off < b && (off + u.t.length) > a);
      if (hit) {
        this.charEls[ui].classList.add('neon-emo');
        if (hit[2]) this.charEls[ui].style.setProperty('--neon-c', hit[2]);
      }
      off += u.t.length;
    });

    /* ③ 店招：本行 hero 词（逐行更换）；SVG <tspan> 一次建好，之后只切 class */
    const hero = heroOfLine(line, this.aiData) || '';
    slot._giant.setAttribute('data-hero', hero);
    const giantText = slot._giantText;
    giantText.textContent = '';
    this.giantChars = [];
    for (const ch of Array.from(hero)) {
      const ts = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
      ts.setAttribute('class', 'neon-giant-ch');   /* SVG 元素 className 只读，须 setAttribute */
      ts.textContent = ch;
      giantText.appendChild(ts);
      this.giantChars.push(ts);
    }

    /* ④ 翻译：灯箱下方的素净小字，按设置开关显隐。
       ★ 占位 tag 过滤（用户反馈：有的歌词翻译只有一句 tag 占位符还会显示）：
       '//'、纯符号/标点行、与原文相同的「翻译」一律不显示。 */
    const rawTrans = String(line.trans || line.translation || '').trim();
    const origText = String(line.original || line.text || '').trim();
    const trans = (rawTrans && rawTrans !== '//' &&
                   !/^[\/\-—–·•.。,，、!！?？~～\s]+$/.test(rawTrans) &&
                   rawTrans !== origText) ? rawTrans : '';
    slot._trans.textContent = trans;
    slot._trans.style.display = (this.showTranslation && trans) ? '' : 'none';
    this.fitBody(slot, this._curGi != null ? this._curGi : null);
    this.fitGiant(slot);   /* 版心字号定稿后再做店招防遮挡（em 基准已稳定） */

    /* ⑤ ★ SVG 宽度精确校准（用户实测：词语之间空格不统一——拉丁字母宽窄
       差异大，0.52em/字符的均匀估算在 i/l 与 m/w 之间误差累积）。rAF 后量
       getComputedTextLength 把 viewBox 与占位宽改成「字形实宽 + 呼吸」，
       词间空格从此均匀；校准后重跑 fitBody/fitGiant（宽度变了）。 */
    requestAnimationFrame(() => {
      let changed = false;
      for (const el of this.charEls) {
        if (!el || el.tagName !== 'svg') continue;
        const t = el.querySelector('text');
        if (!t) continue;
        try {
          const len = t.getComputedTextLength();
          if (!len || !isFinite(len)) continue;
          const units = Math.max(24, len + 14);   /* 左右各 7 单位呼吸 */
          el.setAttribute('viewBox', `-7 0 ${units.toFixed(1)} 100`);
          el.style.width = `${(units / 100).toFixed(3)}em`;
          changed = true;
        } catch (_e) { /* 字体未就绪时量不到，下一行渲染会重来 */ }
      }
      if (changed) {
        try { this.fitBody(slot, this._curGi != null ? this._curGi : null); } catch (_e) {}
        try { this.fitGiant(slot); } catch (_e) {}
      }
    });
  }

  destroy() {
    if (this._refit) document.fonts.removeEventListener?.('loadingdone', this._refit);
    super.destroy();
  }

  /* 版心字号自适应：量整个版心块（主歌词+翻译），超出逐级缩小（×0.86，最多 8 级） */
  fitBody(slot, gi = null) {
    if (!slot || !slot._main) return;
    /* 有预计算结果（同 gi）直接套用，0 次迭代；否则走收缩循环 */
    const pre = (gi != null && this._preFit && this._preFit.gi === gi) ? this._preFit.size : null;
    if (pre) { slot.style.fontSize = pre; this._preFit = null; }
    else slot.style.fontSize = '';
    const body = slot.querySelector('.neon-body');
    if (!body) return;
    const fits = () => {
      void slot.offsetHeight;   /* 强制重排：字号刚改过，禁止读到脏布局 */
      return body.scrollHeight <= slot.clientHeight * 0.7 &&
             body.scrollWidth <= slot.clientWidth;
    };
    let guard = 0;
    while (guard < 16 && !fits()) {
      const cur = parseFloat(slot.style.fontSize) ||
                  parseFloat(getComputedStyle(slot).fontSize) || 48;
      slot.style.fontSize = (cur * 0.86).toFixed(1) + 'px';
      guard++;
    }
  }

  /* 溢出自愈：任何原因导致的版心超界，下一帧检测并当场重跑 fitBody + fitGiant */
  checkOverflow() {
    const slot = this.slots[this.activeSlot];
    if (!slot || !slot._main) return;
    const body = slot.querySelector('.neon-body');
    if (!body) return;
    const pr = slot.getBoundingClientRect();
    const br = body.getBoundingClientRect();
    if (br.bottom > pr.bottom + 1 || br.right > pr.right + 1 || br.top < pr.top - 1) {
      this.fitBody(slot);
      this.fitGiant(slot);
    }
  }

  /* 店招防遮挡：巨物与版心矩形相交 → 逐级缩小（×0.85，最多 12 级），
     仍相交则整块藏起——正文可读性永远优先于装饰（反馈：巨物词有时挡住原文）。
     必须在 fitBody 之后调用：版心字号同时决定版心矩形与巨物的 em 基准。
     ★ SVG 版：宽度自适应量 getBBox（viewBox 单位，100 宽视窗），超宽逐级缩
     字号（viewBox 内 px = 用户单位）；遮挡检测仍用屏幕坐标矩形。 */
  fitGiant(slot) {
    const giant = slot && slot._giant;
    if (!giant) return;
    giant.style.display = '';
    if (!String(giant.dataset.hero || '')) return;
    const giantText = slot._giantText;
    if (!giantText) return;
    const body = slot.querySelector('.neon-body');
    if (!body) return;
    /* 先跑宽度自适应：SVG text 超出 94% 视窗宽（viewBox=100 宽）逐级缩（×0.88） */
    let fs = 17;   /* viewBox 用户单位基准字号 */
    giantText.style.fontSize = fs + 'px';
    let guard = 0;
    try {
      while (guard < 10 && giantText.getBBox().width > 94) {
        fs *= 0.88;
        giantText.style.fontSize = fs + 'px';
        guard++;
      }
    } catch (e) { /* getBBox 在元素不可渲染时可能抛错——保底保留当前字号 */ }
    /* 再跑遮挡检测：与版心相交 → 缩 → 仍相交 → 隐藏 */
    void slot.offsetHeight;
    let oGuard = 0;
    while (oGuard < 12 && rectsOverlap(giant, body)) {
      fs *= 0.85;
      giantText.style.fontSize = fs + 'px';
      void slot.offsetHeight;
      oGuard++;
    }
    if (rectsOverlap(giant, body)) giant.style.display = 'none';
  }

  /* 后台预计算下一块牌 fit 字号：在隐藏测量层量出目标字号存 _preFit，
     换牌上屏时直接套用（0 次迭代），调整全程不可见（同活字方案） */
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
    mea.className = `neon-sign neon-mea ${nextSec.sign.cls} ${nextSec.powerCls}`;
    mea.style.setProperty('--neon-c', nextSec.neonColor);
    mea.style.fontSize = '';
    const savedMain = mea.querySelector('.neon-main');
    if (savedMain) savedMain.innerHTML = '';
    const units = buildUnits(nextLine);
    if (savedMain && units) {
      for (const u of units) {
        const sp = document.createElement('span');
        sp.className = 'neon-char' + (u.t === ' ' ? ' neon-space' : '');
        sp.textContent = u.t;
        savedMain.appendChild(sp);
      }
      const trans = mea.querySelector('.neon-trans');
      if (trans) trans.textContent = String(nextLine.trans || nextLine.translation || '');
      let guard = 0;
      const fits = () => {
        void mea.offsetHeight;
        return mea.querySelector('.neon-body').scrollHeight <= mea.clientHeight * 0.7 &&
               mea.querySelector('.neon-body').scrollWidth <= mea.clientWidth;
      };
      while (guard < 16 && !fits()) {
        const cur = parseFloat(getComputedStyle(mea).fontSize) || 48;
        mea.style.fontSize = (cur * 0.86).toFixed(1) + 'px';
        guard++;
      }
      this._preFit = { gi: nextSec.gi, size: mea.style.fontSize };
    }
  }

  /* 每帧只切 class（零重建、零重排）：
     future=暗管描边 → cur=通电（lit + just-lit 电流闪 + hot 最亮）→ past=lit 保持点亮 */
  onUpdate(timeMs) {
    this.maybePreRenderNext();
    this.checkOverflow();
    for (const span of this.charEls) {
      const s = +span.dataset.start, e = +span.dataset.end;
      if (timeMs >= e) {
        if (!span.classList.contains('neon-lit')) span.classList.add('neon-lit', 'neon-just-lit');
        span.classList.remove('neon-hot');
      } else if (timeMs >= s) {
        if (!span.classList.contains('neon-lit')) span.classList.add('neon-lit', 'neon-just-lit');
        span.classList.add('neon-hot');
      } else {
        span.classList.remove('neon-lit', 'neon-just-lit', 'neon-hot');
      }
    }
    /* 店招跟着唱到哪一字通电。
       ★ 底部巨物（bl/br）永不点亮（用户要求：像活字一样压底暗字）——
       仅清除 lit 状态，保持暗管轮廓。 */
    const line = this._curLine;
    if (line && this.giantChars.length) {
      const curGiant = this.slots[this.activeSlot]._giant;
      const isBottomGiant = !!(curGiant && (curGiant.classList.contains('neon-giant-bl') || curGiant.classList.contains('neon-giant-br')));
      if (isBottomGiant) {
        this.giantChars.forEach(ch => ch.classList.remove('neon-giant-lit'));
      } else {
        const ls = line.start !== undefined ? line.start : line.time || 0;
        const le = line.end !== undefined ? line.end : ls + (line.duration || 5000);
        const p = Math.max(0, Math.min(1, (timeMs - ls) / Math.max(1, le - ls)));
        const lit = Math.floor(p * this.giantChars.length);
        this.giantChars.forEach((ch, i) => ch.classList.toggle('neon-giant-lit', i < lit));
      }
    }
  }
}
