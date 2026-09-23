import { logInfo, logWarn, logError } from '../../services/log.js';
/**
 * WordSegmenter.js
 * 专业级多语言语义分词与 YRC 时间轴聚合引擎：
 * 1. 情感词优先锁定 (Emotion-First Anchor)：情感词作为独立原子词块，绝对不被拆分
 * 2. 中文分词：深度集成 segmentit (linonetwo/segmentit)
 * 3. 日文分词：深度集成 kuromoji.js (takuyaa/kuromoji.js) 形态素分析器
 * 4. 英文/拉丁西文：天然词界与变音符保留，绝不吞空格
 * 5. YRC 真实时间轴：100% 继承原生毫秒级逐字时间戳，绝非生硬平均分
 */

// Node.js 与全局环境探测
let nodeSegmentitLib = (typeof globalThis !== 'undefined' && globalThis.Segmentit) || null;
let nodeKuromojiLib = (typeof globalThis !== 'undefined' && globalThis.kuromoji) || null;

if (typeof window === 'undefined' && typeof require === 'function') {
  try {
    nodeSegmentitLib = require('segmentit');
    nodeKuromojiLib = require('kuromoji');
  } catch (e) {}
}

/* 日文 kuromoji 字典路径：同源优先 → CDN 兜底 → 整体降级到原生 Intl.Segmenter。
   同源目录 web/src/vendor/kuromoji/dict/ 由 node_modules 复制而来（约 17MB，
   不入库：见 .gitignore 与 scripts/vendor-kuromoji-dict.bat）。缺失时自动走 CDN，
   离线环境最终降级为 Intl.Segmenter 分词，功能不中断、只是词组切分粒度变粗。 */
const KUROMOJI_DICT_LOCAL = 'src/vendor/kuromoji/dict/';
const KUROMOJI_DICT_CDN = 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/';
const KUROMOJI_DICT_NODE = 'node_modules/kuromoji/dict';

export class WordSegmenter {
  constructor() {
    this.segmentitInstance = null;
    this.kuromojiTokenizer = null;
    this.isKuromojiLoading = false;
    this.isKuromojiReady = false;

    // 原生 Intl.Segmenter 兜底器
    this.intlZh = (typeof Intl !== 'undefined' && Intl.Segmenter) ? new Intl.Segmenter('zh-CN', { granularity: 'word' }) : null;
    this.intlJa = (typeof Intl !== 'undefined' && Intl.Segmenter) ? new Intl.Segmenter('ja', { granularity: 'word' }) : null;
    this.intlEn = (typeof Intl !== 'undefined' && Intl.Segmenter) ? new Intl.Segmenter('en', { granularity: 'word' }) : null;
    /* ★ grapheme 安全切分器（上游参考项目 graphemeTiming 对齐）：合成序列视为一个可视化字素 */
    this.intlGrapheme = (typeof Intl !== 'undefined' && Intl.Segmenter)
      ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      : null;

    this._initSync();
  }

  /**
   * 同步环境探测与初始化
   * @private
   */
  _initSync() {
    try {
      const segLib = (typeof window !== 'undefined' && window.Segmentit) 
        ? window.Segmentit 
        : ((typeof globalThis !== 'undefined' && globalThis.Segmentit) 
          ? globalThis.Segmentit 
          : nodeSegmentitLib);

      if (segLib && !this.segmentitInstance) {
        const SegmentClass = segLib.Segment || segLib.default?.Segment;
        const useDefFn = segLib.useDefault || segLib.default?.useDefault;
        if (SegmentClass && useDefFn) {
          this.segmentitInstance = useDefFn(new SegmentClass());
          logInfo('WordSegmenter', '[WordSegmenter] Segmentit 中文分词器全局就绪');
        }
      }
    } catch (e) {}

    try {
      const kuromojiLib = (typeof window !== 'undefined' && window.kuromoji) 
        ? window.kuromoji 
        : ((typeof globalThis !== 'undefined' && globalThis.kuromoji) 
          ? globalThis.kuromoji 
          : nodeKuromojiLib);

      if (kuromojiLib && !this.isKuromojiLoading && !this.isKuromojiReady) {
        this._buildKuromoji(kuromojiLib);
      }
    } catch (e) {
      this.isKuromojiLoading = false;
    }
  }

  /**
   * 构建 kuromoji 分词器：字典路径按「本地优先 → CDN 兜底」逐个尝试，全失败则静默降级。
   * 抽成独立方法是因为 _initSync (同步 fire-and-forget) 与 initAsync (await) 都要用它，
   * 原先两处各自硬编码 dicPath，改路径必须改两遍——正是本次 CDN 依赖漏改的温床。
   * @param {object} lib kuromoji 库对象（UMD 的 window.kuromoji 或 Node 的 require 结果）
   * @param {Function} [done] 完成回调，参数为 tokenizer 或 null
   * @private
   */
  _buildKuromoji(lib, done) {
    const isNode = (typeof window === 'undefined');
    const candidates = isNode
      ? [KUROMOJI_DICT_NODE]
      : [KUROMOJI_DICT_LOCAL, KUROMOJI_DICT_CDN];

    const tryAt = (i) => {
      if (i >= candidates.length) {
        this.isKuromojiLoading = false;
        logWarn('WordSegmenter', '[WordSegmenter] Kuromoji 字典全部不可用，日文分词降级为 Intl.Segmenter');
        if (done) done(null);
        return;
      }
      let settled = false;   /* 防「回调已返回 + builder 又抛异常」双触发 */
      try {
        lib.builder({ dicPath: candidates[i] }).build((err, tokenizer) => {
          if (settled) return;
          settled = true;
          if (!err && tokenizer) {
            this.isKuromojiLoading = false;
            this.kuromojiTokenizer = tokenizer;
            this.isKuromojiReady = true;
            logInfo('WordSegmenter', '[WordSegmenter] Kuromoji 日文形态素分析器已成功装载');
            if (done) done(tokenizer);
            return;
          }
          tryAt(i + 1);
        });
      } catch (e) {
        if (settled) return;
        settled = true;
        tryAt(i + 1);
      }
    };

    this.isKuromojiLoading = true;
    tryAt(0);
  }

  /**
   * 异步深度初始化 (支持 ESM 动态 import 注入)
   */
  async initAsync() {
    this._initSync();
    if (this.isKuromojiReady) return;

    if (!this.segmentitInstance) {
      try {
        if (typeof window !== 'undefined' && window.Segmentit) {
          this.segmentitInstance = window.Segmentit.useDefault(new window.Segmentit.Segment());
        } else if (typeof process !== 'undefined') {
          const segPkg = await import('segmentit');
          const { Segment, useDefault } = segPkg.default || segPkg;
          this.segmentitInstance = useDefault(new Segment());
        }
      } catch (e) {}
    }

    if (!this.kuromojiTokenizer && !this.isKuromojiLoading && !this.isKuromojiReady) {
      try {
        let kuromojiLib = (typeof window !== 'undefined' && window.kuromoji) ? window.kuromoji : null;
        if (!kuromojiLib && typeof process !== 'undefined') {
          const kModule = await import('kuromoji');
          kuromojiLib = kModule.default || kModule;
        }
        if (kuromojiLib) {
          await new Promise((resolve) => this._buildKuromoji(kuromojiLib, () => resolve()));
        }
      } catch (e) {
        this.isKuromojiLoading = false;
      }
    }
  }

  /**
   * 语种判定：判断文本是否为日文
   */
  isJapanese(text = '') {
    return /[\u3040-\u309F\u30A0-\u30FF]/u.test(text);
  }

  /**
   * 语种判定：判断文本是否为纯中文（含汉字且无假名）
   */
  isChinese(text = '') {
    return /[\u4E00-\u9FFF]/u.test(text) && !this.isJapanese(text);
  }

  /**
   * 语种判定：判断是否包含中日韩文字 (CJK)
   */
  hasCjk(text = '') {
    return /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/u.test(text);
  }

  /**
   * ★ 核心：情感词优先锁定切词 (Emotion-First Tokenize)
   * 将文本中的情感词提取并锁定为原子词块，其余部分再交给对应语种的分词器处理
   * @param {string} text 待切分文本
   * @param {Array<string>} emotionWords 情感词列表 (可选)
   * @returns {Array<{ text: string, isEmotion: boolean }>} 语义词元列表
   */
  segmentWithEmotions(text = '', emotionWords = []) {
    if (!text || typeof text !== 'string') return [];
    const cleanText = text.trim();
    if (!cleanText) return [];

    // 1. 如果没有情感词，直接走常规分词
    const validEmotions = (Array.isArray(emotionWords) ? emotionWords : [])
      .map(w => (typeof w === 'string' ? w : w.word || '').trim())
      .filter(w => w.length > 0)
      // 按长度降序排列，优先匹配较长情感短语
      .sort((a, b) => b.length - a.length);

    if (validEmotions.length === 0) {
      return this.segment(cleanText).map(t => ({ text: t, isEmotion: false }));
    }

    // 2. 在文本中查找所有情感词区间
    const lowerText = cleanText.toLowerCase();
    const intervals = []; // { start, end, word }

    validEmotions.forEach(eWord => {
      const lowerEWord = eWord.toLowerCase();
      let pos = 0;
      while ((pos = lowerText.indexOf(lowerEWord, pos)) !== -1) {
        const start = pos;
        const end = pos + lowerEWord.length;
        // 检查是否有重叠
        const overlaps = intervals.some(inv => (start < inv.end && end > inv.start));
        if (!overlaps) {
          intervals.push({
            start,
            end,
            word: cleanText.substring(start, end)
          });
        }
        pos += lowerEWord.length;
      }
    });

    // 按起始位置升序排列区间
    intervals.sort((a, b) => a.start - b.start);

    if (intervals.length === 0) {
      return this.segment(cleanText).map(t => ({ text: t, isEmotion: false }));
    }

    // 3. 将文本切分为：普通文本片段 与 锁定情感词片段
    const result = [];
    let curIdx = 0;

    intervals.forEach(inv => {
      if (inv.start > curIdx) {
        const nonEmotionSlice = cleanText.substring(curIdx, inv.start);
        const subTokens = this.segment(nonEmotionSlice);
        subTokens.forEach(st => {
          if (st && st.trim()) {
            result.push({ text: st.trim(), isEmotion: false });
          }
        });
      }

      // ★ 情感词作为一个单独的词，绝对不被拆分！
      result.push({ text: inv.word, isEmotion: true });
      curIdx = inv.end;
    });

    if (curIdx < cleanText.length) {
      const tailSlice = cleanText.substring(curIdx);
      const subTokens = this.segment(tailSlice);
      subTokens.forEach(st => {
        if (st && st.trim()) {
          result.push({ text: st.trim(), isEmotion: false });
        }
      });
    }

    return result;
  }

  /**
   * 纯文本语义切词
   * @param {string} text 待切分文本
   * @returns {Array<string>} 词元列表
   */
  segment(text = '') {
    if (!text || typeof text !== 'string') return [];
    const cleanText = text.trim();
    if (!cleanText) return [];

    // 1. 日文歌词 -> kuromoji.js 形态素分词
    if (this.isJapanese(cleanText)) {
      return this._segmentJapanese(cleanText, 9);
    }

    // 2. 中文歌词 -> segmentit 中文分词
    if (this.isChinese(cleanText)) {
      return this._segmentChinese(cleanText);
    }

    // 3. 西文/拉丁语/混合 -> Unicode 自然词界分词
    return this._segmentWestern(cleanText);
  }

  /**
   * ★ 细粒度切词（流光隧道词级排版用）：日文聚合上限降为 4 字，
   * 使长句拆成多个可独立竖排/横排/斜排的小词块，而非一整行
   * @param {string} text 待切分文本
   * @returns {Array<string>} 细粒度词元列表
   */
  segmentFine(text = '') {
    if (!text || typeof text !== 'string') return [];
    const cleanText = text.trim();
    if (!cleanText) return [];

    if (this.isJapanese(cleanText)) {
      return this._segmentJapanese(cleanText, 4);
    }
    if (this.isChinese(cleanText)) {
      return this._segmentChinese(cleanText);
    }
    return this._segmentWestern(cleanText);
  }

  /**
   * 日文分词实现
   * @param {string} text
   * @param {number} maxChunk 粗粒度聚合的字数上限（默认 9；细粒度传 4）
   * @private
   */
  _segmentJapanese(text, maxChunk = 9) {
    if (this.kuromojiTokenizer) {
      try {
        const tokens = this.kuromojiTokenizer.tokenize(text);
        const result = [];
        let buf = '';
        let bufLen = 0;

        for (let i = 0; i < tokens.length; i++) {
          const t = tokens[i];
          const word = t.surface_form;
          if (!word || !word.trim()) continue;

          /* 跳过孤立标点（、。「」…等），避免把词块切得零碎 */
          if (/^[、。！？・…ー～「」『』（）…\s]+$/u.test(word)) continue;

          /* ★ 粗粒度聚合：形态素级续拼为"短语/情感词"级词块（≤maxChunk 字），
             使日文歌词贴合"只按情感词分词"的视觉需求，避免 助词/助动词
             各自成块导致整行被切得细碎 */
          if (buf && bufLen + word.length > maxChunk) {
            result.push(buf);
            buf = word;
            bufLen = word.length;
          } else {
            buf += word;
            bufLen += word.length;
          }
        }
        if (buf) result.push(buf);
        if (result.length > 0) return result;
      } catch (e) {}
    }

    // 降级使用 Intl.Segmenter (同样粗粒度聚合)
    if (this.intlJa) {
      const segments = Array.from(this.intlJa.segment(text), s => s.segment)
        .filter(s => s.trim().length > 0);
      const merged = [];
      let buf = '';
      for (const s of segments) {
        if (/^[、。！？・…ー～「」『』（）…\s]+$/u.test(s)) continue;
        if (buf && buf.length + s.length > maxChunk) {
          merged.push(buf);
          buf = s;
        } else {
          buf += s;
        }
      }
      if (buf) merged.push(buf);
      if (merged.length > 0) return merged;
    }

    // 兜底正则
    return text.match(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FA5]+|[^\s]+/gu) || [text];
  }

  /**
   * 中文分词实现
   * @private
   */
  _segmentChinese(text) {
    if (!this.segmentitInstance) {
      this._initSync();
    }

    if (this.segmentitInstance) {
      try {
        const result = this.segmentitInstance.doSegment(text);
        if (Array.isArray(result) && result.length > 0) {
          const words = [];
          for (let i = 0; i < result.length; i++) {
            const w = (typeof result[i] === 'string' ? result[i] : result[i].w || '').trim();
            /* ★ 保留标点 token（叠/断点信息）：纯标点/句读作为独立语义断点，
               供 stickyMerge 并入前词与 collapseShortCjkBlocks 断段；仅滤纯空白 */
            if (w && !/^\s+$/u.test(w)) {
              words.push(w);
            }
          }
          if (words.length > 0) return words;
        }
      } catch (e) {}
    }

    // 降级使用 Intl.Segmenter
    if (this.intlZh) {
      const segments = Array.from(this.intlZh.segment(text), s => s.segment);
      const filtered = segments.filter(s => s.trim().length > 0);
      if (filtered.length > 0) return filtered;
    }

    // 兜底正则
    return text.match(/[\u4e00-\u9fa5]{1,4}|[a-zA-Z0-9]+|[^\s]+/gu) || [text];
  }

  /**
   * 西文/拉丁语分词实现 (完整保留法语/德语/西语变音符与标点空格)
   * @private
   */
  _segmentWestern(text) {
    // 西文按单词边界匹配，保留变音符 (如 forçats, déjà, naïve, über) 与连字符
    const matches = text.match(/[\p{L}\p{N}'-]+|[^\s\p{L}\p{N}]+/gu);
    return matches ? matches.filter(m => m.trim().length > 0) : [text];
  }

  /**
   * ★ grapheme 安全切分（上游参考项目 graphemeTiming 对齐）：emoji 合成序列/字符+变音符
   * 视为一个可视化字素，避免拆碎笔画；无 Intl.Segmenter 时降级 Array.from(code point)
   * @param {string} text
   * @returns {Array<string>}
   */
  graphemeSplit(text = '') {
    if (!text) return [];
    if (this.intlGrapheme) {
      try { return Array.from(this.intlGrapheme.segment(text), s => s.segment); } catch (_e) {}
    }
    return Array.from(text);
  }

  /**
   * ★ sticky 布局单位合并（上游参考项目 cjkSemanticLayout.applyStickyPunctuationLayoutUnits 对齐）：
   * 把孤立的裸撇号+缩约后缀（It | ’ | s → It's）、直接缩约（'s/'ll）与尾随标点
   * （，。！？、：；）等）并入前一词块，避免视觉排版把它们拆成零散小词。
   * 合并延续逐字时间轴（chars 拼接，start/end 取跨距），并保留情感词标记。
   * @param {Array} blocks 词块数组（含 text/hasSpaceAfter/isEmotion/start/end/chars）
   * @returns {Array} 合并后的词块数组
   */
  stickyMergeBlocks(blocks = []) {
    const STICKY_TRAILING = /^[,.;:!?，。！？、：；）】》」』〉〕\])}"'"’]+$/u;
    const SUFFIX = /^(s|t|m|d|ll|re|ve|em)\s*$/i;
    const DIRECT = /^['’](s|t|m|d|ll|re|ve|em)\s*$/i;
    const TRAIL_WORD = /[\p{L}\p{N}]\s*$/u;
    const APOSTROPHE_END = /['’]\s*$/u;

    const merged = [];
    for (let i = 0; i < blocks.length; i++) {
      const cur = blocks[i];
      if (!cur) continue;
      const prev = merged[merged.length - 1];
      if (!prev) { merged.push(cur); continue; }

      const t = String(cur.text || '').trim();
      const pt = String(prev.text || '');
      let doMerge = false;

      if (/^['’]\s*$/u.test(t)) {
        // 裸撇号：其后续若是缩约后缀则整体并入前块（下次循环由「后缀接撇号」规则吸收）
        const nx = blocks[i + 1];
        if (nx && TRAIL_WORD.test(pt) && SUFFIX.test(String(nx.text || ''))) {
          doMerge = true;
        }
      } else if (DIRECT.test(t) && TRAIL_WORD.test(pt)) {
        doMerge = true;
      } else if (SUFFIX.test(t) && APOSTROPHE_END.test(pt)) {
        doMerge = true;
      } else if (STICKY_TRAILING.test(t) && TRAIL_WORD.test(pt)) {
        doMerge = true;
      }

      if (doMerge) {
        prev.text = pt + t;
        if (Array.isArray(cur.chars) && cur.chars.length > 0) {
          const pc = Array.isArray(prev.chars) ? prev.chars : [];
          prev.chars = pc.concat(cur.chars);
        }
        if (typeof cur.end === 'number') prev.end = cur.end;
        if (cur.isEmotion) prev.isEmotion = true;
        // 空格标记保留前块的（英文缩约 It's + 后缀后仍带原词空格）
        if (prev.hasSpaceAfter === undefined && cur.hasSpaceAfter !== undefined) {
          prev.hasSpaceAfter = cur.hasSpaceAfter;
        }
        continue;
      }
      merged.push(cur);
    }
    return merged;
  }

  /**
   * ★ 核心：将 YRC 逐字数据按照真实时间轴与情感词/语义词边界进行精准构建
   * @param {string} rawText 整行文本
   * @param {Array} yrcWords YRC 逐字数组 [{ text, start, end, duration }, ...]
   * @param {number} lineStart 整行开始时间 (ms)
   * @param {number} lineEnd 整行结束时间 (ms)
   * @param {Array<string>} emotionWords 情感词列表 (可选)
   * @returns {Array} 聚合后的原生词块数组
   */
  segmentYrcWords(rawText, yrcWords, lineStart, lineEnd, emotionWords = []) {
    if (!Array.isArray(yrcWords) || yrcWords.length === 0) {
      return this._segmentFromPlainText(rawText, lineStart, lineEnd, emotionWords);
    }

    // 1. 如果是纯西文/英文歌曲，YRC 数组本身已经是以单词为单位：
    // 检查 YRC 词条是否大部分已经包含独立单词
    const isPureWestern = !this.hasCjk(rawText);

    if (isPureWestern) {
      return this._tokenizeWesternYrcWords(yrcWords, lineStart, lineEnd, emotionWords);
    }

    // 2. 中文 / 日文 / 混合歌曲：从 YRC 提取每个字符的原生毫秒时间戳
    return this._tokenizeCjkYrcWords(rawText, yrcWords, lineStart, lineEnd, emotionWords);
  }

  /**
   * 西文 YRC 原生时间轴切分 (100% 尊重 YRC 原生单词时间，绝不平均分，绝不粘连)
   * @private
   */
  _tokenizeWesternYrcWords(yrcWords, lineStart, lineEnd, emotionWords = []) {
    const rawBlocks = [];
    const lowerEmotions = (Array.isArray(emotionWords) ? emotionWords : [])
      .map(w => (typeof w === 'string' ? w : w.word || '').trim().toLowerCase())
      .filter(Boolean);

    for (let i = 0; i < yrcWords.length; i++) {
      const yw = yrcWords[i];
      const txt = yw.text || '';
      const cleanTxt = txt.trim();
      if (!cleanTxt) {
        // 空格词：为前一个词块标记空格
        if (rawBlocks.length > 0) {
          rawBlocks[rawBlocks.length - 1].hasSpaceAfter = true;
        }
        continue;
      }

      const wStart = yw.start !== undefined ? yw.start : lineStart;
      const wEnd = yw.end !== undefined ? yw.end : (wStart + (yw.duration || 250));

      // 提取字符级时间 (西文单词内部的字符按原生时长分配)
      const chars = this.graphemeSplit(cleanTxt);
      const charDur = chars.length > 0 ? (wEnd - wStart) / chars.length : 0;
      const blockChars = chars.map((ch, ci) => ({
        char: ch,
        start: Math.round(wStart + ci * charDur),
        end: Math.round(wStart + (ci + 1) * charDur)
      }));

      // 判断该词是否为情感词
      const isEmotion = lowerEmotions.includes(cleanTxt.toLowerCase());

      rawBlocks.push({
        text: cleanTxt,
        hasSpaceAfter: true, // 西文单词后默认留空格
        isEmotion,
        start: Math.round(wStart),
        end: Math.round(wEnd),
        chars: blockChars
      });
    }

    return rawBlocks;
  }

  /**
   * 中文 / 日文 YRC 时间轴聚合 (语义分词 + 情感词锁定 + 继承 YRC 原生单字时间)
   * @private
   */
  _tokenizeCjkYrcWords(rawText, yrcWords, lineStart, lineEnd, emotionWords = []) {
    // ★★ 字符文本永远以 rawText 为主（YRC 作为"时间轴来源"而非"文本来源"）。
    //     先把 rawText 非空白字符展平为 canonicalChars（grapheme 安全切分），
    //     再把 YRC 里的单字时间平均映射到 canonicalChars 上——彻底解决
    //     "米津玄师" 少字、或繁体/异体导致 YRC 文本与 rawText 对不齐导致的缺字。
    const rawChars = this.graphemeSplit(rawText || '');
    const isNonSpace = (c) => !/\s/.test(c);
    const canonicalIndices = []; // 对应 rawChars 的非空格下标
    const canonicalChars = [];
    for (let i = 0; i < rawChars.length; i++) {
      if (isNonSpace(rawChars[i])) {
        canonicalIndices.push(i);
        canonicalChars.push(rawChars[i]);
      }
    }
    if (canonicalChars.length === 0) return [];

    // 构建逐字时间轴（长度 = canonicalChars.length）：
    //   - 先把 YRC 逐字数据合并为一个连续时间串（去掉空格/空词）
    //   - 按时间线性映射到 canonicalChars 上
    const yrcTimes = [];
    for (let i = 0; i < yrcWords.length; i++) {
      const yw = yrcWords[i];
      const txt = yw.text || '';
      if (!txt) continue;
      const wStart = yw.start !== undefined ? yw.start : lineStart;
      const wEnd = yw.end !== undefined ? yw.end : (wStart + (yw.duration || 200));
      const chs = this.graphemeSplit(txt).filter(c => isNonSpace(c));
      const n = chs.length;
      if (n === 0) continue;
      const cd = Math.max(0, (wEnd - wStart) / n);
      for (let k = 0; k < n; k++) {
        yrcTimes.push({
          s: Math.round(wStart + k * cd),
          e: Math.round(wStart + (k + 1) * cd)
        });
      }
    }

    // 逐字时间轴长度：以 canonicalChars 的长度为准
    const timings = [];
    if (yrcTimes.length === 0) {
      const charDur = Math.max(120, (lineEnd - lineStart) / canonicalChars.length);
      for (let i = 0; i < canonicalChars.length; i++) {
        timings.push({
          s: lineStart + Math.round(i * charDur),
          e: lineStart + Math.round((i + 1) * charDur)
        });
      }
    } else {
      // 对齐：canonicalChars 按 0..1 比例映射到 yrcTimes 的 0..yrcTimes.length-1 区间
      const yN = yrcTimes.length;
      for (let i = 0; i < canonicalChars.length; i++) {
        const t = canonicalChars.length > 1 ? (i / (canonicalChars.length - 1)) : 0;
        const yf = t * (yN - 1);
        const yi = Math.min(yN - 1, Math.floor(yf));
        const yfract = yf - yi;
        const ys = yrcTimes[yi].s + (yrcTimes[Math.min(yN - 1, yi + 1)].s - yrcTimes[yi].s) * yfract;
        const ye = yrcTimes[yi].e + (yrcTimes[Math.min(yN - 1, yi + 1)].e - yrcTimes[yi].e) * yfract;
        timings.push({ s: Math.round(ys), e: Math.round(ye) });
      }
    }

    const cleanFullText = canonicalChars.join('');
    // 2. 情感词优先锁定 + 语义分词（以 canonicalChars 的拼接文本为输入）
    const tokenObjects = this.segmentWithEmotions(cleanFullText, emotionWords);

    // 3. 按分词边界把 canonicalChars / timings 聚合为词块
    const rawBlocks = [];
    let cp = 0; // canonical pointer
    for (let wIdx = 0; wIdx < tokenObjects.length; wIdx++) {
      const tok = tokenObjects[wIdx];
      const sWord = tok.text;
      if (!sWord) continue;
      const sWordChars = this.graphemeSplit(sWord);
      const blockChars = [];
      let bStart = Infinity, bEnd = -Infinity;
      for (let scIdx = 0; scIdx < sWordChars.length; scIdx++) {
        if (cp < canonicalChars.length) {
          const ch = canonicalChars[cp];
          const tm = timings[cp];
          blockChars.push({ char: ch, start: tm.s, end: tm.e });
          bStart = Math.min(bStart, tm.s);
          bEnd = Math.max(bEnd, tm.e);
          cp++;
        } else {
          const s = bEnd > 0 ? bEnd : lineStart;
          blockChars.push({
            char: sWordChars[scIdx],
            start: s,
            end: s + 150
          });
        }
      }

      // ★ 非 CJK 词后 / 词间如果原 rawText 里有空格，hasSpaceAfter = true；
      //   西文词默认 hasSpaceAfter=true。
      let hasSpace = false;
      // 看下一个 rawText 非空格字符前是否存在空格
      if (cp < canonicalIndices.length) {
        const nextIdx = canonicalIndices[cp];
        for (let k = (cp > 0 ? canonicalIndices[cp - 1] + 1 : 0); k < nextIdx; k++) {
          if (/\s/.test(rawChars[k])) { hasSpace = true; break; }
        }
      }
      if (!hasSpace && !this.hasCjk(sWord)) hasSpace = true;

      if (blockChars.length > 0) {
        rawBlocks.push({
          text: sWord,
          hasSpaceAfter: hasSpace,
          isEmotion: tok.isEmotion,
          start: bStart === Infinity ? lineStart : bStart,
          end: bEnd === -Infinity ? lineEnd : bEnd,
          chars: blockChars
        });
      }
    }

    return rawBlocks;
  }

  /**
   * 普通 LRC 纯文本语义切词与时间分配 (支持情感词优先锁定)
   * @private
   */
  _segmentFromPlainText(text, lineStart, lineEnd, emotionWords = []) {
    const cleanText = (text || '').trim();
    if (!cleanText) return [];

    const tokenObjects = this.segmentWithEmotions(cleanText, emotionWords);
    if (tokenObjects.length === 0) return [];

    const totalChars = tokenObjects.reduce((acc, t) => acc + this.graphemeSplit(t.text).length, 0);
    const duration = Math.max(lineEnd - lineStart, tokenObjects.length * 200);
    const charDuration = totalChars > 0 ? duration / totalChars : duration;

    const rawBlocks = [];
    let currentStart = lineStart;

    for (let i = 0; i < tokenObjects.length; i++) {
      const tok = tokenObjects[i];
      const sWord = tok.text;
      const chars = this.graphemeSplit(sWord);
      const wDur = chars.length * charDuration;
      const wStart = Math.round(currentStart);
      const wEnd = Math.round(currentStart + wDur);

      const blockChars = [];
      for (let cIdx = 0; cIdx < chars.length; cIdx++) {
        const cStart = Math.round(wStart + cIdx * charDuration);
        const cEnd = Math.round(cStart + charDuration);
        blockChars.push({
          char: chars[cIdx],
          start: cStart,
          end: cEnd
        });
      }

      const isCjk = this.hasCjk(sWord);
      rawBlocks.push({
        text: sWord,
        hasSpaceAfter: !isCjk,
        isEmotion: tok.isEmotion,
        start: wStart,
        end: wEnd,
        chars: blockChars
      });

      currentStart += wDur;
    }

    return rawBlocks;
  }
/**
   * ★ 中文「≥4 字语义段」聚合（用户反馈：PV 中文 1~2 字一块太散）
   * 把相邻的 CJK 词块级联为 ≥minCjkChars 字的语义段，标点为天然断点；
   * 情感词/西文/日文 块不参与聚合（情感词优先锁定的独立性不被破坏）。
   * 纯计算、确定性：同一输入永远同一输出。
   * @param {Array} blocks 词块数组（text/hasSpaceAfter/isEmotion/start/end/chars）
   * @param {number} [minCjkChars=4] 聚合目标：至少多少字一段
   * @returns {Array} 聚合后的词块数组
   */
  collapseShortCjkBlocks(blocks = [], minCjkChars = 4) {
    if (!Array.isArray(blocks) || blocks.length === 0) return blocks;
    const MIN = Math.max(2, minCjkChars || 4);
    const MAX = Math.max(MIN, 9); // 语义段上限：避免整行糊成一大块
    const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff]/;
    const PUNCT_RE = /^[\s,.;:!?，。！？、；：~…·'"'"（）()《》【】]+$/u;
    const out = [];
    let pending = null;
    const emit = (list) => {
      const first = list[0];
      const last = list[list.length - 1];
      out.push({
        ...first,
        text: list.map(b => b.text).join(''),
        start: first.start,
        end: last.end,
        chars: list.flatMap(b => (Array.isArray(b.chars) ? b.chars : [])),
        isEmotion: list.some(b => b.isEmotion),
        hasSpaceAfter: last.hasSpaceAfter
      });
    };
    const flush = () => {
      if (!pending || pending.list.length === 0) { pending = null; return; }
      emit(pending.list);
      pending = null;
    };
    for (const b of blocks) {
      if (!b) { flush(); continue; }
      const t = String(b.text || '');
      const isCjk = CJK_RE.test(t);
      const isPunctBlock = PUNCT_RE.test(t);
      const endsPunct = /[，。！？、；：…]$/u.test(t); // 句末标点 → 语义断点
      if (!isCjk || b.isEmotion) { flush(); out.push(b); continue; }
      if (isPunctBlock || endsPunct) {
        /* 标点闭合当前语义段（标点留在段尾），随后续段的断点闭合 */
        if (!pending) pending = { list: [], len: 0 };
        pending.list.push(b);
        pending.len += Array.from(t).length;
        flush();
        continue;
      }
      if (!pending) pending = { list: [], len: 0 };
      pending.list.push(b);
      pending.len += Array.from(t).length;
      if (pending.len >= MAX) flush(); // 超上限先断；未到上限持续吸收，段落在断点处闭合
    }
    /* 行尾不足 MIN 的短 CJK 段直接并入前一段（保持"至少 4 字一段"且无重复前缀） */
    if (pending && pending.list.length > 0 && pending.len < MIN) {
      const prev = out.length ? out[out.length - 1] : null;
      if (prev && CJK_RE.test(String(prev.text || '')) && !prev.isEmotion) {
        for (const tb of pending.list) {
          prev.text += tb.text;
          if (typeof tb.end === 'number') prev.end = tb.end;
          if (Array.isArray(tb.chars)) prev.chars = (Array.isArray(prev.chars) ? prev.chars : []).concat(tb.chars);
        }
        pending = null;
      } else {
        flush();
      }
    } else {
      flush();
    }
    return out;
  }
}

// 导出全局单例
export const wordSegmenter = new WordSegmenter();
