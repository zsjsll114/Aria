/**
 * TunnelDirector.js — 「流光隧道」导演层
 * 忠实落地 PV-技术方案.md 第 6/7/8/9/18 章：
 *
 * 1. 三级连贯层级（第 18 章）：Shot(行分镜) → Group(句组=layout场景) → Section(段落)
 *    - 组内共享场景(SceneState：纹理+色板+装饰族)与连续运镜轨道锚点
 *    - 组间轨道衔接过渡，段间预设/色板/纹理全换
 * 2. 参数化生成器（第 8 章）：ShotParams 六轴（排版/运镜/入场/出场/转场/纹理/色彩）
 *    seededRandom + 60% 连贯性沿用（lerp(prev, new, 1-continuity)）
 * 3. 四维样式匹配（第 7 章）：语义情感(词典降级) × 段落结构 × 词语权重 × 音乐动态 → computeStyle
 * 4. 速度自适应（第 9 章）：calcLyricDensity → adaptiveDuration（快歌缩短、慢歌放慢）
 * 5. 装饰族系统（18.12）与运镜类型选择（18.6 pickMoveType）
 */

import { PVLyricLayout } from '../pvEngine/PVLyricLayout.js';
import { wordSegmenter } from '../pvEngine/WordSegmenter.js';
import { pickDecorationCombo, pickEnterFamily, ENTER_FAMILIES, splitToCharAnimParams } from './TunnelAnimations.js';
import { segmentBlocksByAI, multiPageSegment } from './AILyricSegmenter.js';
import { logCatch } from '../../services/log.js';

/* ========== 第 7.2 节：情感词典（无 AI 时的降级路径） ========== */
const EMOTION_LEXICON = {
  ja: {
    '悲しい': 'sorrow', '泣く': 'sorrow', '泣い': 'sorrow', '痛い': 'sorrow', '孤独': 'sorrow', '寂し': 'sorrow',
    '悲しみ': 'sorrow', '涙': 'sorrow', '痛み': 'sorrow', '傷つく': 'sorrow', '苦しい': 'sorrow', '苦しみ': 'sorrow', '淋しさ': 'sorrow', '暗闇': 'sorrow', '虚無': 'sorrow', '不幸': 'sorrow', '忘れた': 'sorrow', '思い出': 'sorrow', '過去': 'sorrow',
    '好き': 'love', '愛': 'love', '恋': 'love', 'キス': 'love', '抱き': 'love', '甘い': 'love',
    '怒り': 'anger', '壊': 'anger', '裂': 'anger', '叫': 'anger', '殴': 'anger', '狂気': 'anger', '狂っ': 'anger',
    '光': 'hope', '夢': 'hope', '未来': 'hope', '輝': 'hope', '明日': 'hope', '空': 'hope', '幸せ': 'hope', '希望': 'hope', '明る': 'hope', '笑い': 'hope', '笑っ': 'hope',
    '嘘': 'betray', '偽': 'betray', '裏切り': 'betray', '騙': 'betray', '影': 'betray', 'フェイク': 'betray', '虚偽': 'betray'
  },
  zh: {
    '哭': 'sorrow', '泪': 'sorrow', '痛': 'sorrow', '孤': 'sorrow', '伤': 'sorrow',
    '难过': 'sorrow', '失落': 'sorrow', '迷茫': 'sorrow', '绝望': 'sorrow', '压抑': 'sorrow', '寂寞': 'sorrow', '遗憾': 'sorrow', '心碎': 'sorrow', '痛苦': 'sorrow', '麻木': 'sorrow', '空虚': 'sorrow', '思念': 'sorrow', '逝去': 'sorrow',
    '爱': 'love', '恋': 'love', '吻': 'love', '抱': 'love', '甜': 'love',
    '温柔': 'love', '浪漫': 'love', '深情': 'love', '幸福': 'love', '甜蜜': 'love', '依恋': 'love',
    '怒': 'anger', '毁': 'anger', '裂': 'anger', '吼': 'anger', '恨': 'anger', '疯狂': 'anger', '残酷': 'anger',
    '光': 'hope', '梦': 'hope', '未来': 'hope', '辉': 'hope', '明': 'hope',
    '希望': 'hope', '温暖': 'hope', '自由': 'hope', '治愈': 'hope', '理想': 'hope', '明亮': 'hope',
    '谎': 'betray', '伪': 'betray', '背叛': 'betray', '骗': 'betray', '影': 'betray',
    '虚假': 'betray', '虚伪': 'betray', '谎言': 'betray', '伪装': 'betray', '欺骗': 'betray', '幻觉': 'betray', '假装': 'betray'
  },
  en: {
    'cry': 'sorrow', 'tear': 'sorrow', 'pain': 'sorrow', 'lonely': 'sorrow', 'sad': 'sorrow',
    'broken': 'sorrow', 'hurt': 'sorrow', 'agony': 'sorrow', 'goodbye': 'sorrow', 'miss': 'sorrow', 'give up': 'sorrow',
    'love': 'love', 'kiss': 'love', 'heart': 'love', 'sweet': 'love', 'baby': 'love',
    'rage': 'anger', 'break': 'anger', 'scream': 'anger', 'hate': 'anger', 'burn': 'anger', 'destroy': 'anger',
    'light': 'hope', 'dream': 'hope', 'future': 'hope', 'shine': 'hope', 'sky': 'hope', 'smile': 'hope', 'bright': 'hope', 'warm': 'hope', 'heal': 'hope',
    'lie': 'betray', 'fake': 'betray', 'betray': 'betray', 'shadow': 'betray', 'deceive': 'betray', 'pretend': 'betray'
  }
};

/* ========== 第 7.2 节：情感 → 视觉参数映射表 ========== */
export const EMOTION_STYLE_MAP = {
  sorrow:  { accent: '#5b8def', speed: 0.7, textureDensity: 0.8, composition: 'contract', decorationFamily: 'circles',       cameraMoves: ['pan', 'pull'] },
  love:    { accent: '#ff7eb6', speed: 1.0, textureDensity: 0.5, composition: 'center',  decorationFamily: 'circles',       cameraMoves: ['push', 'orbit'] },
  anger:   { accent: '#ff4466', speed: 1.5, textureDensity: 0.3, composition: 'diagonal', decorationFamily: 'concentric-lines', cameraMoves: ['pan', 'orbit', 'dive'] },
  hope:    { accent: '#ffd866', speed: 1.1, textureDensity: 0.5, composition: 'rise',    decorationFamily: 'brackets',      cameraMoves: ['push', 'rise'] },
  betray:  { accent: '#a06bff', speed: 1.2, textureDensity: 0.7, composition: 'scatter', decorationFamily: 'grid',          cameraMoves: ['tilt', 'pan'] },
  neutral: { accent: '#7b8fb2', speed: 1.0, textureDensity: 0.5, composition: 'flow',    decorationFamily: 'brackets',      cameraMoves: ['pan', 'push'] }
};

/* ========== 第 7.3 节：段落结构 → 全局基线 ========== */
const SECTION_STYLE_MAP = {
  intro:  { energy: 0.25, cutRate: 4, cameraIntensity: 0.35, texture: 'halftone' },
  verse:  { energy: 0.45, cutRate: 2, cameraIntensity: 0.60, texture: 'scanline' },
  pre:    { energy: 0.65, cutRate: 1, cameraIntensity: 0.80, texture: 'grid' },
  chorus: { energy: 0.90, cutRate: 0.5, cameraIntensity: 1.00, texture: 'halftone' },
  bridge: { energy: 0.60, cutRate: 2, cameraIntensity: 0.70, texture: 'noise' },
  outro:  { energy: 0.30, cutRate: 4, cameraIntensity: 0.30, texture: 'scanline' }
};

/* ========== 第 8.2 节：参数池 ========== */
const LAYOUT_TYPES = ['center', 'diagonal', 'band', 'corner', 'scatter', 'arc', 'tilt', 'steps'];
const ENTER_POOL_LOW = ['slide-up', 'slide-diagonal', 'clip-reveal', 'scan-clip', 'raster-wobble', 'resize-slide'];
const ENTER_POOL_HIGH = ['scale-burst', 'rotate-3d', 'rotate-z-bounce', 'blink-in', 'shatter-reverse', 'slide-up'];
const EXIT_POOL = ['fade-out', 'dissolve', 'implode', 'slide-out', 'scatter'];
const TRANSITION_SHAPES = ['wipe-left', 'wipe-center', 'wipe-down', 'iris', 'blinds'];
const TEXTURE_TYPES = ['halftone', 'scanline', 'noise', 'grid'];

/* ========== 种子随机（第 8.2 seededRandom） ========== */
function seededRandom(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17; s >>>= 0;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) / 4294967296;
  };
}

/* 数值工具 */
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const lerp = (a, b, t) => a + (b - a) * t;

/* ===== 借鉴 JPV Lyrics Motion Kit（AGPL-3.0，改作）：确定性随机 + 文字宽度估算 ===== */
/* 确定性命中随机：frac(sin(seed)*10000)，相同 seed 在任何机器/帧同值 */
function hash01(seed) {
  const x = Math.sin(seed || 1) * 10000;
  return x - Math.floor(x);
}
function isCjkCh(ch) {
  const cp = (ch && ch.codePointAt) ? ch.codePointAt(0) : 0;
  return (cp >= 0x3000 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xffef);
}
/* 文字宽度估算（不依赖字体加载时序）：汉字 1.0 / 拉丁字母数字 0.56 / 标点 0.32 / 空格 0.3（单位：fontPx） */
function estimateTextWidthPx(text, fontPx) {
  let units = 0;
  for (const ch of String(text || '')) {
    if (ch === ' ') units += 0.3;
    else if (isCjkCh(ch)) units += 1.0;
    else if (/[.,'’!?:;|()[\]"-]/.test(ch)) units += 0.32;
    else units += 0.56;
  }
  return units * fontPx;
}

export class TunnelDirector {
  constructor() {
    this.layout = new PVLyricLayout();
    this.sections = [];
    this.shotList = [];   // 展平的 shot 索引（供 findShotAt 二分）
  }

  /* ---------- 第 7.2 节：词典情感判定（降级路径） ---------- */
  static detectLineEmotion(text = '') {
    const votes = {};
    const check = (dict) => {
      for (const [word, emo] of Object.entries(dict)) {
        if (text.includes(word)) votes[emo] = (votes[emo] || 0) + 1;
      }
    };
    check(EMOTION_LEXICON.ja);
    check(EMOTION_LEXICON.zh);
    check(EMOTION_LEXICON.en);
    const top = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
    return top ? top[0] : 'neutral';
  }

  /* ---------- 第 9.3 节：速度自适应 ---------- */
  static calcLyricDensity(line) {
    const duration = Math.max((line.end - line.start) / 1000, 0.5);
    const charCount = (line.blocks || []).reduce((sum, b) => sum + (b.chars ? b.chars.length : Array.from(b.text).length), 0);
    return charCount / duration;
  }

  static adaptiveDuration(baseMs, density) {
    const REFERENCE_DENSITY = 5;
    const ratio = REFERENCE_DENSITY / Math.max(density, 0.5);
    return clamp(baseMs * ratio, 50, 400);
  }

  static computeTiming(line) {
    /* ★ 上游参考项目 renderHints：极短行(<100ms)/短行(<180ms) 用瞬时/快进入场——蒙德里安
       一闪而过的气口/叹词不再配一整套缓进缓出，成"卡点闪现"的快节奏分镜 */
    const hints = line && line.renderHints;
    if (hints) {
      if (hints.wordRevealMode === 'instant') {
        return { enterDuration: 40, exitDuration: 30, staggerDelay: 0, transitionDuration: 40 };
      }
      if (hints.wordRevealMode === 'fast') {
        const d = TunnelDirector.calcLyricDensity(line);
        return {
          enterDuration: Math.min(70, TunnelDirector.adaptiveDuration(200, d) * 0.5),
          exitDuration: Math.min(50, TunnelDirector.adaptiveDuration(150, d) * 0.5),
          staggerDelay: 8,
          transitionDuration: Math.min(60, TunnelDirector.adaptiveDuration(120, d) * 0.5)
        };
      }
    }
    const d = TunnelDirector.calcLyricDensity(line);
    return {
      enterDuration: TunnelDirector.adaptiveDuration(200, d),
      exitDuration: TunnelDirector.adaptiveDuration(150, d),
      staggerDelay: TunnelDirector.adaptiveDuration(30, d),
      transitionDuration: TunnelDirector.adaptiveDuration(120, d)
    };
  }

  /* ---------- 第 8.2 节：参数化采样（连贯性 60/40） ---------- */
  sampleShotParams(shotIndex, prevParams, emotion, energy, seed) {
    const rng = seededRandom((seed + shotIndex * 977) >>> 0);
    const emoStyle = EMOTION_STYLE_MAP[emotion] || EMOTION_STYLE_MAP.neutral;

    // 连贯性约束：60% 沿用上一 shot 大部分参数，只微调；40% 跳到新值
    const continuity = rng() < 0.6 ? 0.7 : 0.3;
    const mix = (prev, next) => lerp(prev, next, 1 - continuity);

    const prevL = (prevParams && prevParams.layout) || {};
    const layoutType = (prevL.type && rng() < 0.6)
      ? prevL.type
      : LAYOUT_TYPES[Math.floor(rng() * LAYOUT_TYPES.length)];

    const enterPool = energy > 0.7 ? ENTER_POOL_HIGH : ENTER_POOL_LOW;
    const prevE = (prevParams && prevParams.enter) || {};

    return {
      layout: {
        type: layoutType,
        angle: mix(prevL.angle ?? 0, (rng() * 90 - 45)),
        scale: clamp(mix(prevL.scale ?? 1, 0.9 + rng() * 0.7), 0.85, 1.7),
        offsetX: clamp(mix(prevL.offsetX ?? 0, rng() * 1.6 - 0.8), -0.8, 0.8),
        offsetY: clamp(mix(prevL.offsetY ?? 0, rng() * 1.2 - 0.6), -0.6, 0.6),
        skew: mix(prevL.skew ?? 0, rng() * 16 - 8),
        letterSpacing: mix(prevL.letterSpacing ?? 0, rng() * 0.12)
      },
      camera: {
        move: emoStyle.cameraMoves[Math.floor(rng() * emoStyle.cameraMoves.length)] || 'pan',
        intensity: clamp(mix((prevParams && prevParams.camera && prevParams.camera.intensity) ?? 0.5, energy * rng()), 0.1, 1)
      },
      enter: {
        type: (prevE.type && rng() < 0.5) ? prevE.type : enterPool[Math.floor(rng() * enterPool.length)],
        direction: Math.floor(rng() * 4),
        stagger: rng() * 60,
        overshoot: rng() * 0.2
      },
      exit: { type: EXIT_POOL[Math.floor(rng() * EXIT_POOL.length)] },
      transition: { shape: TRANSITION_SHAPES[Math.floor(rng() * TRANSITION_SHAPES.length)] },
      texture: {
        type: TEXTURE_TYPES[Math.floor(rng() * TEXTURE_TYPES.length)],
        density: clamp(emoStyle.textureDensity + rng() * 0.2, 0.1, 1),
        opacity: clamp(0.2 + rng() * 0.4, 0.1, 0.6)
      },
      color: { accent: emoStyle.accent }
    };
  }

  /* ---------- 第 7.4 节：词语权重 → 逐词强调 ---------- */
  static getWordEmphasis(word, lineEmotion, sectionEnergy) {
    if (!word.isEmotion) {
      return { scale: 0.72, glow: 0, effect: 'none', color: null }; // 功能词：缩小、无特效
    }
    if (sectionEnergy > 0.7) {
      return { scale: 1.45, glow: 0.9, effect: 'rgb-split', burst: true, color: word.emotionColor };
    }
    return { scale: 1.22, glow: 0.5, effect: 'glow', burst: false, color: word.emotionColor };
  }

  /* ---------- 第 7.6 节：四维合成 ---------- */
  static computeStyle(word, lineEmotion, section, audioPulse, params) {
    const emo = EMOTION_STYLE_MAP[lineEmotion] || EMOTION_STYLE_MAP.neutral;
    const sec = SECTION_STYLE_MAP[section.type] || SECTION_STYLE_MAP.verse;
    const em = TunnelDirector.getWordEmphasis(word, lineEmotion, sec.energy);
    return {
      accentColor: (word.isEmotion && word.emotionColor) || emo.accent || params.color.accent,
      wordScale: em.scale + (audioPulse || 0) * 0.04,
      wordGlow: em.glow,
      wordEffect: em.effect,
      cameraIntensity: sec.cameraIntensity * (emo.speed || 1),
      textureDensity: clamp(sec.texture ? 0.5 : 0.5, 0, 1)
    };
  }

  /* ---------- 第 18.6 节：组级运镜类型选择 ---------- */
  static pickMoveType(emotion, role) {
    const map = {
      sorrow:  { opening: 'pan', building: 'push', peak: 'dive', resolving: 'tilt', transition: 'pan' },
      anger:   { opening: 'pan', building: 'push', peak: 'orbit', resolving: 'pan', transition: 'dive' },
      love:    { opening: 'push', building: 'orbit', peak: 'push', resolving: 'tilt', transition: 'pan' },
      hope:    { opening: 'push', building: 'push', peak: 'dive', resolving: 'orbit', transition: 'push' },
      betray:  { opening: 'tilt', building: 'pan', peak: 'orbit', resolving: 'pan', transition: 'tilt' },
      neutral: { opening: 'pan', building: 'push', peak: 'pan', resolving: 'pull', transition: 'pan' }
    };
    return (map[emotion] && map[emotion][role]) || 'pan';
  }

  /* ---------- 18.12 装饰族选择 ---------- */
  static pickDecorationFamily(emotion, energy) {
    if (energy > 0.7) return 'concentric-lines';
    if (emotion === 'betray') return 'grid';
    if (emotion === 'love' || emotion === 'sorrow') return 'circles';
    return 'brackets';
  }

  /* ---------- 第 13.2 节：词级独立排版 ✦ 紧凑流式（借鉴 上游参考项目） ----------
   * 不再"一个句子一整行"，也不散点乱放：词块按阅读顺序紧凑折行，
   * 词间距≈字号×0.35、行高≈1.5 字高、全部装入 42%/37% 安全区 → 有规律、不杂乱、不溢出。
   * 竖排/斜排仅作少量点缀；hero 词放大强调。 */

  /** 组间排布风格节奏轮换序列（保证句组排列规律） */
  static COMPOSITION_RHYTHM = ['band', 'diagonal', 'column', 'arc', 'steps', 'center', 'tilt', 'scatter'];

  /* ★★ 背景主题色板池（6 套）：组间轮换渐变，画面背景"多态夹杂"而非单一底色
     a/b/c = 深色渐变上/中/下；glow = 中心柔光；streak = 流光扫射色 */
  static BG_THEMES = [
    { a: 'rgba(10,8,24,0.94)',  b: 'rgba(16,10,38,0.92)',  c: 'rgba(8,6,18,0.96)',   glow: 'rgba(58,30,110,0.38)',  streak: 'rgba(255,255,255,0.07)' }, // 暗夜紫
    { a: 'rgba(8,12,30,0.94)',  b: 'rgba(12,20,52,0.90)',  c: 'rgba(6,10,24,0.96)',  glow: 'rgba(30,70,170,0.34)',  streak: 'rgba(140,180,255,0.06)' }, // 深海蓝
    { a: 'rgba(26,8,14,0.94)',  b: 'rgba(42,12,20,0.90)',  c: 'rgba(20,6,10,0.96)',  glow: 'rgba(180,40,60,0.30)',   streak: 'rgba(255,140,160,0.05)' }, // 暗绯红
    { a: 'rgba(12,22,12,0.94)', b: 'rgba(18,34,20,0.90)',  c: 'rgba(10,18,10,0.96)', glow: 'rgba(50,150,90,0.30)',   streak: 'rgba(150,255,190,0.05)' }, // 墨绿
    { a: 'rgba(20,16,32,0.94)', b: 'rgba(32,22,52,0.90)',  c: 'rgba(16,12,26,0.96)', glow: 'rgba(120,80,200,0.34)', streak: 'rgba(190,160,255,0.06)' }, // 紫罗兰
    { a: 'rgba(14,10,26,0.94)', b: 'rgba(26,18,44,0.90)',  c: 'rgba(10,8,20,0.96)',  glow: 'rgba(200,120,50,0.26)',  streak: 'rgba(255,200,140,0.05)' }  // 琥珀
  ];

  /** ★★ 组级纹理候选池：用户反馈"栅格过多" —— 以 none（纯背景）为主，
      仅少量 halftone/noise/scanline 点缀，且移除 grid 网格纹理 */
  static BG_TEXTURES = ['none', 'halftone', 'none', 'noise', 'none', 'scanline'];

  /**
   * ★ 词级紧凑流式排布（借鉴 上游参考项目：词间距≈字号×0.35、测量盒子+全局缩放装入安全区）
   * 不再"散点构图"——词块按阅读顺序紧凑流式折行在中心区域，词与词之间只留小间隙；
   * hero 词放大作为强调，竖排/斜排仅作少量点缀。返回整镜 fitScale（≤1）。
   * @param {Array} blocks 词块
   * @param {number} seed 组种子
   * @param {string} layoutType 排布风格（band/diagonal/column/arc/...）
   * @param {Object} [variant] 变体（{ mirror: true } → 第二行水平镜像）
   * @param {boolean} [layoutFit] 是否参与整镜 fitScale
   * @param {string} [alignment] 对齐方式 left/center/right
   * @param {Object} [edgeInfo] 蒙德里安矩形边缘 {leftEdgePct,rightEdgePct,...} 百分比 0~100
   * @returns {number} 本镜 fitScale
   */
  static assignWordLayouts(blocks, seed, layoutType = 'band', variant = {}, layoutFit = true, alignment = 'center', edgeInfo = null, opts = {}) {
    if (!blocks || !blocks.length) return 1;
    const n = blocks.length;
    /* ★ 横平竖直模式（mosaicTilt 关闭，默认）：
       - 无任何旋转（整行/单字角度全部归零）
       - 无竖排、无镜像、无弧线/阶梯倾斜
       - 英文词间按 hasSpaceAfter / 拉丁语检测插入真实空格间距
       - 居中排布，整体抬升避开下方控制栏 */
    const straight = !!(opts && opts.straight);

    // 1. 主角词：情感词优先，其次长词（视觉锚点）
    let heroIdx = 0, heroScore = -1;
    blocks.forEach((b, i) => {
      const len = Array.from(b.text || '').length;
      const score = (b.isEmotion ? 80 : 0) + Math.min(len, 6) * 5;
      if (score > heroScore) { heroScore = score; heroIdx = i; }
    });

    // 2. 词块基础信息：估算宽度 wU（字号=1 时的单位宽度 × 相对字号），方向决策
    // ★ 规范化：字号跨度收窄（hero 略大、长词略小，避免破坏行的视觉对齐）
    const isCjkRe = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/u;
    const isLatinText = (t) => /^[\p{L}\p{M}]+$/u.test((t || '').trim()) && !isCjkRe.test(t || '');
    const items = blocks.map((b, i) => {
      const len = Array.from(b.text || '').length;
      const isCjk = isCjkRe.test(b.text || '');
      const isHero = i === heroIdx;
      // ★ 横平竖直：字号差只体现"主角/情感词/长短词"，幅度收窄，保持行的整齐
      let relSize;
      if (straight) {
        /* ★ 直排模式的强调靠**墨色**（情感色/高亮色），不靠字号放大：
           字号放大在字符级 CSS（--char-scale）上没有对应的布局槽位，
           字号单位对齐（vw）后会把邻词压在身下（实测 you 与放大 S 重叠）。
           保留极小的字号层次维持节奏感。 */
        relSize = isHero ? 1.06 : (b.isEmotion ? 1.05 : (len <= 2 ? 1.02 : (len >= 6 ? 0.96 : 1)));
      } else {
        relSize = isHero ? 1.30 : (b.isEmotion ? 1.15 : (len <= 2 ? 1.06 : (len >= 6 ? 0.92 : 1)));
      }
      let dir = 'h';
      // ★ 规范化：竖排仅保留给「column 构图的 hero」与「center 构图的 hero」，
      //   其余一律横排，维持统一的左→右、上→下阅读基线；横平竖直模式强制全横排
      const verticalEligible = !straight && isCjk && len >= 2 && len <= 5;
      if ((layoutType === 'column' || layoutType === 'center') && isHero && verticalEligible) dir = 'v';
      return { b, i, len, isCjk, isHero, relSize, dir, wU: estimateTextWidthPx(b.text || '', 1) * relSize };
    });

    // 3. 排版参数
    // ★ 词间距收紧（用户反馈"歌词之间间距有些大"）：此前 0.010 + 各档词距偏宽，
    //   蒙德里安的色块本身就承担分组语义，词距应贴紧到近似正常字排。
    // ★ fs 必须与 CSS 渲染字号同源：CSS 用 6.4vw × --tunnel-font-size(设置档 fontSize)，
    //   这里若不吃 fontScale，排版假设的字号 = 渲染字号 / 1.1 → 词距虚大一档、
    //   hero 词渲染盒比布局盒大 1.1 倍（与邻词重叠）。
    const fs = 0.064 * ((opts && opts.fontScale) || 1);
    const gap = 0.006;           // 词紧贴（原 0.010）
    const rowH = fs * 1.28;      // 行距收紧（原 1.48）

    // ★★ 根据 alignment + edgeInfo 决定安全区边界
    const edges = edgeInfo || { leftEdgePct: 8, rightEdgePct: 92, topEdgePct: 15, bottomEdgePct: 85 };
    // ★ 默认（含居中）整体居中 + 抬高底部（原 safeB=0.85 现在 0.78，避开底部控制栏 22%）
    let safeL = 0.10, safeR = 0.90, safeT = 0.16, safeB = 0.78;

    // ★ 横平竖直：水平居中 + 垂直整体抬升（视觉不再偏下），忽略 left/right 对齐
    if (straight) {
      safeL = 0.12;
      safeR = 0.88;
      safeT = 0.13;
      safeB = 0.80;
      alignment = 'center';
    }

    if (alignment === 'left') {
      safeL = 0.10;
      safeR = 0.88;
      safeT = 0.16;
      safeB = 0.78;
    } else if (alignment === 'right') {
      safeL = 0.12;
      safeR = 0.90;
      safeT = 0.16;
      safeB = 0.78;
    }

    // ★ 3a. 每行整体排布在整镜安全区内（不再把行分散进多个色块）：
    //     行内折行/间距/词序保持原样（“排列方式不变”），每行整体按对齐锚定
    //     （左→靠左、右→靠右、居中→整页居中），行与行垂直居中叠放
    // ★ 排版稳定性：同一 section 内所有页面共用同一个「锚定安全区 cell」（由引擎传入）。
    //   这样每页词块始终锁定在同一垂直带内居中，换页不再左右/上下跳变，整体更像连续分栏的排版。
    const defaultCells = [{ x0: safeL, y0: safeT, x1: safeR, y1: safeB, w_: safeR - safeL, h_: safeB - safeT }];
    const cells = (opts && opts.cell) ? [opts.cell] : defaultCells;

    const dim = i => items[i].wU * fs;

    // ★ 3b. 预折行（贪心）：词先分成若干行，每行宽度不超全安全区；
    //      横平竖直模式下优先按 AI line_breaks 语义断行（分词效果可见），再按宽度兜底
    const forcedBreakSet = new Set(
      (opts && Array.isArray(opts.lineBreaks)) ? opts.lineBreaks.filter(x => x > 0 && x < n) : []
    );
    const preRows = [];
    let curRow = [], curW = 0;
    const totalSafeW = safeR - safeL;
    for (let i = 0; i < n; i++) {
      const isForcedBreak = straight && forcedBreakSet.has(i);
      const w = dim(i) + (curRow.length ? ((items[i].b && items[i].b.hasSpaceAfter) ? 0.030 : gap) : 0);
      if (curRow.length && (isForcedBreak || curW + w > totalSafeW)) {
        preRows.push({ items: curRow, w: curW });
        curRow = []; curW = 0;
      }
      curRow.push(i); curW += w;
    }
    if (curRow.length) preRows.push({ items: curRow, w: curW });

    // 3c. 全局 fitScale：按最大行宽、总行数夹紧（先估，后文如果碰撞再缩）
    let fitScale = 1;
    if (layoutFit) {
      const needH = preRows.length * rowH;
      const availH = Math.max(safeB - safeT, 0.15);
      fitScale = Math.min(1, availH / Math.max(needH, rowH));
      let mRw = 0;
      preRows.forEach(r => { if (r.w > mRw) mRw = r.w; });
      const availW = Math.max(totalSafeW, 0.2);
      fitScale = Math.min(fitScale, availW / Math.max(mRw, 0.04));
      fitScale = Math.max(0.65, fitScale);
    }

    // ★ 3d. 把每一行分配进 cells：按对齐方向在页面内铺开，避免全部挤进单个色块
    //      参考图风格：多块色块各自承载 1~2 行词，左/右对齐时靠在对应方向的色块上
    const rowsWithCell = [];
    const capOf = (c) => Math.max(1, Math.floor(c.h_ / Math.max(rowH * fitScale, 0.008)));
    // 分配顺序按对齐方向 + 阅读顺序：居中=上→下/左→右铺开；左=先靠最左色块；右=先靠最右色块
    const order = cells.slice();
    if (alignment === 'left') order.sort((a, b) => (a.x0 - b.x0) || ((a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2));
    else if (alignment === 'right') order.sort((a, b) => (b.x1 - a.x1) || ((a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2));
    let rIdx = 0;
    for (let ci = 0; ci < order.length && rIdx < preRows.length; ci++) {
      const cell = order[ci];
      const quota = capOf(cell);
      for (let k = 0; k < quota && rIdx < preRows.length; k++, rIdx++) {
        rowsWithCell.push({ row: preRows[rIdx], cell });
      }
    }
    // 兜底：剩下的行铺到整个安全区，保证始终分散、不挤角
    const fullSafeCell = { x0: safeL, y0: safeT, x1: safeR, y1: safeB, w_: safeR - safeL, h_: safeB - safeT };
    while (rIdx < preRows.length) {
      rowsWithCell.push({ row: preRows[rIdx], cell: fullSafeCell });
      rIdx++;
    }

    // ★★ 4. 逐 cell 摆放：每个 cell 内部按 rows 数量居中/对齐，词块贴近不重叠
    //    placed: {x0,y0,x1,y1} AABB 用来碰撞检测
    const placedBoxes = [];
    const aabbOverlap = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
    // ★ 碰撞检测的包围盒膨胀系数：
    //   倾斜模式（mosaicTilt 开）词块带旋转，需要 1.42 的大余量防重叠；
    //   **横平竖直模式（straight，默认）词块无旋转，膨胀必须是 1.0** ——
    //   行内间距已收得很紧（CJK 仅 0.008），任何 >1.0 的膨胀都会让相邻词的
    //   膨胀盒互相"碰撞"，被逐个下推一整行，排版退化成锯齿、阅读顺序断裂。
    const inflate = straight ? 1.0 : 1.42;
    const placements = [];

    // 先按 cell 聚合各行
    const byCell = new Map();
    for (const rc of rowsWithCell) {
      if (!byCell.has(rc.cell)) byCell.set(rc.cell, []);
      byCell.get(rc.cell).push(rc.row);
    }

    for (const [cell, cellRows] of byCell) {
      const crCount = cellRows.length;
      const cellAvailH = cell.y1 - cell.y0;
      const cellRowH = Math.min(rowH * fitScale, cellAvailH / Math.max(crCount, 1) * 0.92);
      const totalCH = (crCount - 1) * cellRowH;
      // cell 内垂直对齐：词少则居中
      let yStart = cell.y0 + cellRowH / 2;
      if (crCount * cellRowH <= cellAvailH) {
        yStart = (cell.y0 + cell.y1) / 2 - totalCH / 2;
      }
      cellRows.forEach((row, ri) => {
        const rowW = row.w * fitScale;
        const cellAvailW = cell.x1 - cell.x0;
        // 横向对齐：cell 内按 alignment 调整
        let cx;
        if (alignment === 'left') {
          cx = cell.x0;
        } else if (alignment === 'right') {
          cx = Math.max(cell.x0, cell.x1 - rowW);
        } else {
          cx = cell.x0 + Math.max(cellAvailW - rowW, 0) / 2;
        }
        const yCenter = yStart + ri * cellRowH;
        const rowItems = row.items;
        rowItems.forEach((idx, rii) => {
          const it = items[idx];
          const w = dim(idx) * fitScale;
          const h = cellRowH * 0.92;
          // 以 AABB 估计字块包围盒（考虑 scale 上限 1.32）
          const cxp = cx + w / 2;
          const aabb = {
            x0: cxp - (w / 2) * inflate - 0.004,
            x1: cxp + (w / 2) * inflate + 0.004,
            y0: yCenter - (h / 2) * inflate - 0.004,
            y1: yCenter + (h / 2) * inflate + 0.004
          };
          // ★ 碰撞检测：与任何已放置字块相交就向右/向下推开
          let attempts = 0;
          while (attempts < 16) {
            let collide = null;
            for (const p of placedBoxes) { if (aabbOverlap(aabb, p)) { collide = p; break; } }
            if (!collide) break;
            if (alignment === 'left') {
              aabb.x0 = collide.x1 + 0.004; aabb.x1 = aabb.x0 + (cxp - (cx + w / 2 - aabb.x0 > 0 ? (w) * 1.42 : w));
            } else if (alignment === 'right') {
              aabb.x1 = collide.x0 - 0.004; aabb.x0 = aabb.x1 - w * inflate;
            } else {
              aabb.y0 = collide.y1 + 0.004; aabb.y1 = aabb.y0 + h * inflate;
            }
            attempts++;
          }
          // 钳制到本 cell 内
          aabb.x0 = Math.max(cell.x0, aabb.x0);
          aabb.y0 = Math.max(cell.y0, aabb.y0);
          aabb.x1 = Math.min(cell.x1, aabb.x1);
          aabb.y1 = Math.min(cell.y1, aabb.y1);
          const cxpFinal = (aabb.x0 + aabb.x1) / 2;
          const cypFinal = (aabb.y0 + aabb.y1) / 2;
          placedBoxes.push({ ...aabb });
          placements.push({ it, x: cxpFinal, y: cypFinal, w });
          // ★ 西文单词间保留可辨识的空间（词距 ≈ 空格），中日文保持紧凑贴近；
          //   用户反馈词距偏大 —— 全档收紧（横平竖直略宽于倾斜，仍明显小于旧值）
          const prevIt = rii > 0 ? items[rowItems[rii - 1]] : null;
          let wordGap;
          if (it.b && it.b.hasSpaceAfter) {
            wordGap = straight ? 0.038 : 0.026;
          } else if (prevIt && isLatinText(prevIt.b.text) && isLatinText(it.b.text)) {
            wordGap = straight ? 0.028 : 0.024;
          } else if (isLatinText(it.b.text)) {
            wordGap = straight ? 0.020 : 0.022;
          } else {
            wordGap = straight ? 0.008 : gap;
          }
          cx += w + wordGap * fitScale;
        });
      });
    }

    // 竖排词分量：★ 规范化——竖排词保留在流式队列中的中心位，不做边距散落
    const vWords = placements.filter(p => p.it.dir === 'v');
    vWords.forEach((p, vi) => {
      const it = p.it;
      const h = it.len * fs * fitScale;
      const w = fs * 1.35 * fitScale;
      // 与横排同基线：保留流式 x，仅让竖向中心对齐行中心
      let vx = p.x;
      if (alignment === 'left') vx = safeL + w / 2;
      else if (alignment === 'right') vx = safeR - w / 2;
      const x = clamp(vx, safeL + w / 2, safeR - w / 2);
      const y = clamp(p.y, safeT + h / 2, safeB - h / 2);
      const vChars = it.b.chars || [];
      const vCharRots = vChars.map((ch, ci) => {
        const cp = (ch && ch.char && ch.char.codePointAt) ? ch.char.codePointAt(0) : 0;
        const isCjk = (cp >= 0x3000 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xffef);
        const r = hash01(seed + it.i * 73 + ci * 151);
        const baseMax = isCjk ? 4 : 3;
        let rot = (r - 0.5) * 2 * baseMax;
        return Number(clamp(rot, -baseMax, baseMax).toFixed(2));
      });
      it.b.__wordLayout = { x, y, dir: 'v', angle: 0, relSize: it.relSize, slotIdx: it.i, __fitScale: fitScale, charRotations: vCharRots };
    });
    const vSet = new Set(vWords.map(p => p.it.i));

    // 4b. 多行镜像变体（组内第二行）：整体水平镜像 + 角度取反，保持同构
    //     横平竖直模式不做镜像（保持阅读方向统一）
    const mirror = straight ? false : !!variant.mirror;

    // 5. 写回 __wordLayout：★ 规范化——
    //    - 词块共享一个恒定的整镜倾角（仅 diagonal/tilt 轻微倾斜，其余一律平齐）
    //    - 移除逐词随机角度抖动（ja），避免行内字词东倒西歪
    //    - 单字旋转收窄到 ±2~3°，保持可读的规整基线（真正的倾斜由引擎行级微调承载）
    //    - 横平竖直模式：角度/单字旋转全部归零
    const baseAngle = straight ? 0 : (layoutType === 'diagonal' ? 3 : (layoutType === 'tilt' ? -2.5 : 0));
    const arcBend = (straight) ? 0 : (layoutType === 'arc' ? 0.03 : 0);
    const layoutRotEnvelope = straight ? 0 : ((layoutType === 'diagonal' || layoutType === 'tilt') ? 0.6 : 0.4);
    placements.forEach(p => {
      if (vSet.has(p.it.i)) return;
      const it = p.it;
      let x = p.x, y = p.y;
      if (mirror) { x = 1 - x; }
      if (arcBend && preRows.length === 1) {
        const t = (x - safeL) / totalSafeW - 0.5;
        y += Math.sin(t * Math.PI) * 0.025;
      }
      const angle = straight ? 0 : (baseAngle + (mirror ? -baseAngle * 2 : 0));
      const charRotations = (bChars) => {
        const out = [];
        if (straight) return bChars.map(() => 0);
        const n = bChars.length;
        for (let ci = 0; ci < n; ci++) {
          const ch = bChars[ci];
          const cp = (ch && ch.char && ch.char.codePointAt) ? ch.char.codePointAt(0) : 0;
          const isCjk = (cp >= 0x3000 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xffef);
          const charSeed = seed + it.i * 131 + ci * 97;
          const r = hash01(charSeed);
          const baseMax = isCjk ? 2.5 : 2;
          // ★ 轻微单字倾斜：仅对角/倾斜构图沿字位置做渐变，书生态的规整起伏
          let rot = (r - 0.5) * 2 * baseMax * layoutRotEnvelope;
          const posT = n > 1 ? (ci / (n - 1) - 0.5) * 2 : 0;
          if (layoutType === 'diagonal' || layoutType === 'tilt') {
            rot += posT * (isCjk ? 2 : 1);
          }
          rot = Math.max(-baseMax, Math.min(baseMax, rot));
          out.push(Number(rot.toFixed(2)));
        }
        return out;
      };
      const chars = it.b.chars || [];
      it.b.__wordLayout = {
        x: clamp(x, safeL + fs * 0.3, safeR - fs * 0.3),
        y: clamp(y, safeT + fs * 0.75, safeB - fs * 0.75),
        dir: 'h', angle: clamp(angle, -3, 3), relSize: it.relSize, slotIdx: it.i, __fitScale: fitScale,
        charRotations: charRotations(chars)
      };
    });

    return fitScale;
  }

  /* ---------- ★ 细粒度词块再拆（词级排版前提） ----------
   * PVLyricLayout 粗粒度聚合（日文 ≤9 字）会让整句成为一个词块；
   * 词级独立排版需要把 >4 字的块用 segmentFine 再拆（日文 ≤4 字），
   * 时间戳与逐字 chars 按字符指针精确映射（100% 继承原生时间轴）。 */
  _refineBlocks(blocks) {
    const out = [];
    for (const b of blocks || []) {
      const chars = Array.from(b.text || '');
      if (chars.length <= 4) { out.push(b); continue; }

      let subs = null;
      try { subs = wordSegmenter.segmentFine(b.text); } catch (e) { logCatch('TunnelDirector', e); }
      if (!subs || !subs.length || subs.join('') !== b.text) { out.push(b); continue; }

      // 字符指针：把原生逐字时间精确分配给子词
      const srcChars = b.chars || [];
      let ptr = 0;
      subs.forEach((txt, i) => {
        const n = Array.from(txt).length;
        const subChars = [];
        for (let k = 0; k < n && ptr < srcChars.length; k++, ptr++) subChars.push(srcChars[ptr]);
        if (subChars.length === 0 && n > 0) {
          // 容错：无逐字数据时按字符比例生成
          const ratio = n / chars.length;
          const dur = (b.end - b.start) * ratio;
          const s0 = b.start + (b.end - b.start) * (i / subs.length);
          for (let k = 0; k < n; k++) subChars.push({ char: Array.from(txt)[k], start: s0 + dur * k / n, end: s0 + dur * (k + 1) / n });
        }
        out.push({
          ...b,
          text: txt,
          start: subChars[0].start,
          end: subChars[subChars.length - 1].end,
          chars: subChars,
          // ★ 保留原始词间的空格标记：仅末尾子词继承（空格紧随整词之后），
          //   避免长英文词子拆分后与下一词粘连（如 "sometimes pump" 显示成 "sometimespump"）
          hasSpaceAfter: (i === subs.length - 1) ? Boolean(b.hasSpaceAfter) : false
        });
      });
    }
    // 合并孤立单字块（促音/助词残片）到前块，避免画面碎片化
    // ★ 西文单字母（a / I / o）是完整的英文单词，不参与合并——否则会把 "in a bus" 粘连成 "inabus"
    const merged = [];
    for (const b of out) {
      const len = Array.from(b.text).length;
      const prev = merged.length ? merged[merged.length - 1] : null;
      /* ★ 纯标点块并入前块（标点不再独立成块飘在画面；行尾标点收敛到词尾） */
      if (prev && /^[,.;:!?，。！？、；：…~]+$/u.test(String(b.text || ''))) {
        prev.text += b.text;
        prev.end = b.end;
        prev.chars = (prev.chars || []).concat(b.chars || []);
        continue;
      }
      const prevIsCjk = !!(prev && /[\u3040-\u30ff\u3400-\u9fff]/.test(prev.text || ''));
      const bIsCjk = /[\u3040-\u30ff\u3400-\u9fff]/.test(b.text || '');
      const isWestSingle = len === 1 && !bIsCjk;
      if (len === 1 && !b.isEmotion && !isWestSingle && prev && prevIsCjk) {
        prev.text += b.text;
        prev.end = b.end;
        prev.chars = (prev.chars || []).concat(b.chars || []);
      } else {
        merged.push(b);
      }
    }
    /* ★ 西文空格回填（用户反馈：AI 合并的 "imissyou" 无空格）：
       对纯拉丁 ≥5 字母的块，若能用 segmentit/字典词典找回词界且不是情感词，
       就把 text/chars 按词界重新拼并插入空格字符。只影响显示分组，时间轴不变。 */
    for (const b of merged) {
      if (b.isEmotion) continue;
      const t = String(b.text || '');
      if (!/^[a-zA-Z][a-zA-Z'\u00C0-\u024F'-]*$/u.test(t) || t.length < 5) continue;
      let sub = null;
      try { sub = wordSegmenter.segment(t); } catch (e) { logCatch('TunnelDirector', e); }
      if (!sub || sub.length < 2) continue;
      const joined = sub.join('');
      if (joined !== t) continue; // 词典拼不回原文 → 跳过，别乱拆
      /* 重新拼回空格：词间加一个空格字符（缩约词内部不插） */
      const spaced = sub.join(' ');
      const chars = b.chars || [];
      if (chars.length === 0) {
        b.text = spaced;
        continue;
      }
      /* 逐字符指针重排：单词 chars 之后插一个空格 char */
      const newChars = [];
      let ptr = 0;
      for (let si = 0; si < sub.length; si++) {
        const n = Array.from(sub[si]).length;
        const slice = [];
        for (let k = 0; k < n && ptr < chars.length; k++, ptr++) slice.push(chars[ptr]);
        newChars.push(...slice);
        if (si < sub.length - 1) {
          /* 空格 char：借用下一个词首字的时间，避免零时长 */
          const nxt = sub[si + 1];
          const nxtLen = Array.from(nxt).length;
          const nxtChars = [];
          for (let k = 0; k < nxtLen && ptr < chars.length; k++, ptr++) nxtChars.push(chars[ptr]);
          if (nxtChars.length > 0 && newChars.length > 0) {
            newChars.push({ char: ' ', start: nxtChars[0].start, end: nxtChars[0].start });
          }
          newChars.push(...nxtChars);
        }
      }
      b.text = spaced;
      if (newChars.length > 0) b.chars = newChars;
    }
    return merged.filter(x => x.text && x.text.trim());
  }

  /* ---------- 第 10.1 节：拆字粒度（按段落能量动态切换，不写死） ----------
   * intro/verse → phrase（温和，整块缓入）
   * pre-chorus  → word（开始碎开，词一次爆出）
   * chorus      → char（逐字爆入，每字独立轨迹）
   * bridge      → word/char 混合（部分拆部分不拆） */
  static granularityForSection(type, energy) {
    switch (type) {
      case 'intro':
      case 'outro': return 'phrase';
      case 'chorus': return 'char';
      case 'pre': return energy > 0.6 ? 'char' : 'word';
      case 'bridge': return energy > 0.62 ? 'char' : 'word';
      case 'verse':
      default: return energy > 0.55 ? 'word' : 'phrase';
    }
  }

  /**
   * ★ 主入口：构建三级层级结构（第 18.4/20.2 节）
   * @param {Array} rawLyrics 原始歌词
   * @param {Object} aiData AI 情感数据（可空 → 词典降级）
   *   支持 aiData.line_analyses: [{index,emotion,energy,keywords,visual_hint}]（第 15.3 节阶段B）
   * @returns {{sections: Array, shots: Array}}
   */
  build(rawLyrics = [], aiData = {}) {
    // ★ 快节奏分镜：每 2 句一个场景（场景切换频率翻倍，分镜感强）
    const nodes = this.layout.process(rawLyrics, aiData, 2);
    if (!nodes.length) { this.sections = []; this.shotList = []; return { sections: [], shots: [] }; }

    // 情感词集合（AI 优先）
    const aiEmotions = (aiData && Array.isArray(aiData.emotion_words))
      ? aiData.emotion_words.map(w => (typeof w === 'string' ? w : w.word))
      : [];
    // 第 15.3 节：AI 逐行分析（emotion/energy/keywords）
    const lineAnalyses = (aiData && Array.isArray(aiData.line_analyses)) ? aiData.line_analyses : null;
    let globalLineIdx = -1;

    const seed = Math.abs(Array.from((nodes[0].text || 'seed')).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)) || 42;

    /* ── Level 2: Group（句组）── */
    const groups = nodes.map((node, gIdx) => {
      const shots = [];
      for (let lIdx = 0; lIdx < (node.lines || []).length; lIdx++) {
        const rawLine = node.lines[lIdx];
        // ★ 细粒度再拆：粗聚合长块拆成可独立排版的词块
        const line = { ...rawLine, blocks: this._refineBlocks(rawLine.blocks) };
        // ★ 拼接词块文本时按 hasSpaceAfter 回填空格，避免英文词间被挤成 "i'minabus"
        const joinBlocks = (arr) => (arr || []).map(b => (b.hasSpaceAfter ? `${b.text} ` : b.text)).join('').trim();
        const fullText = joinBlocks(line.blocks);
        globalLineIdx++;

        // 第 15.3 节：AI 逐行分析优先（emotion/energy/keywords），词典降级
        const aiLine = lineAnalyses ? lineAnalyses[globalLineIdx] : null;
        let emotion = 'neutral';
        let aiEnergy = null;
        let keywords = [];
        if (aiLine && aiLine.emotion) {
          emotion = String(aiLine.emotion).split(' ')[0];
          aiEnergy = typeof aiLine.energy === 'number' ? aiLine.energy : null;
          keywords = Array.isArray(aiLine.keywords) ? aiLine.keywords : [];
        } else if (aiEmotions.some(w => w && fullText.includes(w))) {
          emotion = 'love';
        } else {
          emotion = TunnelDirector.detectLineEmotion(fullText);
        }
        if ((!aiLine || emotion === 'neutral') && aiData && aiData.mood) {
          const moodMap = { sorrow: 'sorrow', anger: 'anger', love: 'love', hope: 'hope', betray: 'betray' };
          emotion = moodMap[aiData.mood] || 'neutral';
        }

        // ★ AI 驱动句意分页：将一行的词块按语义拆分为 4-7 词的「页」
        const blocks = line.blocks || [];
        const lineStart = line.start;
        const lineEnd = line.end;
        const lineDur = Math.max(lineEnd - lineStart, 400);

        // 使用 AI 分段对 blocks 进行分页（★ 传入 globalLineIdx，按 line_index 过滤当前行分析）
        const pageSegments = multiPageSegment(blocks, aiData, shots.length + lIdx, globalLineIdx);

        if (pageSegments.length <= 1) {
          // 单行不足 4 词或无需分页，保持原 shot
          shots.push({
            id: `g${gIdx}s${shots.length}`,
            line,
            text: fullText,
            start: lineStart,
            end: lineEnd,
            duration: lineDur,
            groupId: gIdx,
            indexInGroup: shots.length,
            groupRole: shots.length === 0 ? 'start' : (lIdx === (node.lines || []).length - 1 ? 'end' : 'mid'),
            emotion,
            keywords,
            timing: TunnelDirector.computeTiming(line),
            alignment: pageSegments[0]?.alignment || 'center',
            lineBreaks: pageSegments[0]?.lineBreaks || []
          });
        } else {
          // 一行拆为多页：每页按时长比例分配时间
          let pageStart = lineStart;
          let globalBlockIdx = 0;
          const totalBlocks = blocks.length;

          pageSegments.forEach((page, pIdx) => {
            const pageWordCount = page.blocks.length;
            const pageDur = Math.round(lineDur * (pageWordCount / Math.max(totalBlocks, 1)));
            const pageEnd = Math.min(pageStart + pageDur, lineEnd);

            // 构建该页的子 line
            const pageBlocks = page.blocks.map((pb, bi) => {
              const srcBlock = blocks[globalBlockIdx + bi];
              if (!srcBlock) return null;
              return {
                ...srcBlock,
                start: Math.round(pageStart + (srcBlock.start - lineStart) * (pageEnd - pageStart) / lineDur),
                end: Math.round(pageStart + (srcBlock.end - lineStart) * (pageEnd - pageStart) / lineDur)
              };
            }).filter(Boolean);

            // 修正时间戳单调递增
            for (let bi = 1; bi < pageBlocks.length; bi++) {
              if (pageBlocks[bi].start < pageBlocks[bi - 1].end) {
                pageBlocks[bi].start = pageBlocks[bi - 1].end;
              }
              if (pageBlocks[bi].end <= pageBlocks[bi].start) {
                pageBlocks[bi].end = pageBlocks[bi].start + 50;
              }
            }

            const pageText = joinBlocks(pageBlocks);
            const pageLine = {
              ...line,
              blocks: pageBlocks,
              start: pageStart,
              end: pageEnd
            };

            shots.push({
              id: `g${gIdx}s${shots.length}`,
              line: pageLine,
              text: pageText,
              start: pageStart,
              end: pageEnd,
              duration: Math.max(pageEnd - pageStart, 200),
              groupId: gIdx,
              indexInGroup: shots.length,
              groupRole: shots.length === 0 ? 'start' : 'mid',
              emotion,
              keywords,
              timing: TunnelDirector.computeTiming(pageLine),
              alignment: page.alignment,
              lineBreaks: page.lineBreaks || [],
              pageIndex: pIdx,
              isPageSplit: true
            });

            globalBlockIdx += pageWordCount;
            pageStart = pageEnd;
          });
        }
      }

      const validShots = shots.filter(s => s.text);

      const groupEmotion = validShots.length
        ? validShots.reduce((acc, s) => { acc[s.emotion] = (acc[s.emotion] || 0) + 1; return acc; }, {})
        : {};
      const groupEmo = Object.entries(groupEmotion).sort((a, b) => b[1] - a[1])[0]?.[0] || 'neutral';
      const charCount = validShots.reduce((n, s) => n + Array.from(s.text).length, 0);
      const dur = Math.max((node.end - node.start) / 1000, 1);

      return {
        id: gIdx,
        node,
        shots: validShots,
        start: node.start,
        end: node.end,
        groupEmotion: groupEmo,
        energy: clamp(0.35 + (charCount / dur) / 14, 0.2, 1),
        roleInSection: 'building'
      };
    }).filter(g => g.shots.length > 0);

    /* ── Level 3: Section（段落）划分：按时间轴能量切分 ── */
    const sections = [];
    const total = groups[groups.length - 1].end;
    const SECTION_SIZES = [
      { type: 'intro', ratio: 0.14 },
      { type: 'verse', ratio: 0.22 },
      { type: 'chorus', ratio: 0.24 },
      { type: 'bridge', ratio: 0.16 },
      { type: 'chorus', ratio: 0.14 },
      { type: 'outro', ratio: 0.10 }
    ];
    let cursor = 0;
    let secIdx = 0;
    groups.forEach((g, i) => {
      const t = g.start / total;
      while (secIdx < SECTION_SIZES.length - 1 && t >= cursor + SECTION_SIZES[secIdx].ratio) {
        cursor += SECTION_SIZES[secIdx].ratio;
        secIdx++;
      }
      const type = SECTION_SIZES[secIdx].type;
      if (!sections.length || sections[sections.length - 1].type !== type) {
        sections.push({ id: sections.length, type, groups: [], start: g.start, end: g.end, energy: 0 });
      }
      const sec = sections[sections.length - 1];
      g.sectionId = sec.id;
      g.roleInSection = sec.groups.length === 0 ? 'opening'
        : (i === groups.length - 1 ? 'resolving' : (g.energy > 0.65 ? 'peak' : 'building'));
      sec.groups.push(g);
      sec.end = g.end;
      sec.energy = sec.groups.reduce((s, x) => s + x.energy, 0) / sec.groups.length;
    });

    /* ── 导演层分配：场景共享 + 参数化采样 + 运镜类型 + 拆字粒度 + 装饰组合 ── */
    let flatIdx = 0;
    let prevParams = null;
    sections.forEach(sec => {
      const secStyle = SECTION_STYLE_MAP[sec.type] || SECTION_STYLE_MAP.verse;
      // ★ 第 10.1 节：段落级拆字粒度（intro→phrase / pre→word / chorus→char...）
      const secGranularity = TunnelDirector.granularityForSection(sec.type, sec.energy);
      sec.groups.forEach((g, gi) => {
        // 18.4 SceneState：组内共享 背景主题 + 纹理类型 + 色板 + 装饰组合（同族变体）
        const emoStyle = EMOTION_STYLE_MAP[g.groupEmotion] || EMOTION_STYLE_MAP.neutral;
        // ★ 第 8.3 节：每句组从 37 种装饰中选 3-5 个交错融合（组间轮换）
        const decoSeed = (seed + g.id * 131) >>> 0;
        const decoCombo = pickDecorationCombo(decoSeed);
        /* ★★ 背景多态：按组轮换 6 套背景主题色板（组间渐变夹杂，不再"一种背景"）+ 组级纹理轮换 */
        const bgIdx = Math.abs(Math.floor((g.id * 7 + g.sectionId * 13) / 1)); // 组序号驱动
        const bgTheme = TunnelDirector.BG_THEMES[bgIdx % TunnelDirector.BG_THEMES.length];
        const texIdx = Math.abs(g.id * 3 + (g.groupEmotion === 'anger' ? 1 : 0));
        const textureType = TunnelDirector.BG_TEXTURES[texIdx % TunnelDirector.BG_TEXTURES.length];
        g.scene = {
          groupId: g.id,
          palette: { bg: 'rgba(8,6,18,0.92)', fg: '#ffffff', accent: emoStyle.accent },
          backgroundTheme: bgTheme,                         // 背景主题色板（引擎写 CSS 变量）
          textureType,                                      // 组级纹理（含偶尔无纹理 → 纯背景夹杂）
          textureParams: { density: clamp(emoStyle.textureDensity + g.energy * 0.2, 0.15, 1), opacity: 0.35 },
          decoCombo,                                        // 37 选 3-5 组合
          decorationSeed: decoSeed,
          cameraIntensity: secStyle.cameraIntensity * (emoStyle.speed || 1),
          groupIndex: g.id
        };
        // 18.6 组级连续运镜类型
        g.moveType = TunnelDirector.pickMoveType(g.groupEmotion, g.roleInSection);

        g.shots.forEach(s => {
          s.sectionId = sec.id;
          s.sectionType = sec.type;
          s.sectionEnergy = sec.energy;
          s.params = this.sampleShotParams(flatIdx, prevParams, s.emotion, sec.energy, seed);
          /* ★ 句组排列规律：同组共用同一构图（组内第二行镜像变体），组间按节奏轮换。
             sampled 的随机 layout.type 弃用，改由规律序列驱动 → 画面有规律不杂乱 */
          const compType = TunnelDirector.COMPOSITION_RHYTHM[g.id % TunnelDirector.COMPOSITION_RHYTHM.length];
          s.params.layout.type = compType;
          /* 分镜级整体倾角收敛到构图适宜的微倾（防随机大倾角导致画面乱） */
          const globalTilt = (compType === 'diagonal' || compType === 'tilt')
            ? (Math.sin(g.id * 1.7) * 6) : (Math.sin(g.id * 1.3) * 3);
          s.params.layout.angle = clamp(globalTilt, -8, 8);
          /* 分镜级整体缩放收敛（构图已在槽位内铺满，过大会把边缘词推出画面） */
          s.params.layout.scale = clamp(s.params.layout.scale, 0.95, 1.15);
          // ★ 第 10.1 节：shot 级粒度（段落基线 + 情感调制：高能情感句升 char，低能降 phrase）
          let gran = secGranularity;
          const sEmoStyle = EMOTION_STYLE_MAP[s.emotion] || EMOTION_STYLE_MAP.neutral;
          if (gran === 'word' && sEmoStyle.speed >= 1.4) gran = 'char';
          if (gran === 'word' && sEmoStyle.speed <= 0.75) gran = 'phrase';
          s.granularity = gran;
          /* ★ 入场风格家族：按构图书选择主题化入场族（借鉴 JPV 13 主题） */
          s.enterFamily = pickEnterFamily(compType, sec.energy, gran);
          // ★ AI 分页：将 alignment 写入 params 供 TunnelEngine 使用
          if (s.alignment) {
            s.params.alignment = s.alignment;
          }
          // ★ AI 分页：将 lineBreaks 写入 params 供行内换行排版
          if (s.lineBreaks && s.lineBreaks.length > 0) {
            s.params.lineBreaks = s.lineBreaks;
          }

          // ★★★ 跨分镜连贯对齐：同组内非首个 shot，80% 概率沿用前一 shot 的对齐方向
          let shotAlign = s.params.alignment || s.alignment || 'center';
          const shotIdxInGroup = g.shots.indexOf(s);
          if (shotIdxInGroup > 0 && g.shots.length >= 2) {
            const prevShotInGroup = g.shots[shotIdxInGroup - 1];
            if (prevShotInGroup && prevShotInGroup.alignment) {
              const coherenceR = ((flatIdx * 19 + gi * 29) % 100) / 100;
              if (coherenceR < 0.80) {   // 80% 概率沿用同组前一分镜的对齐
                shotAlign = prevShotInGroup.alignment;
              }
            }
          }
          s.alignment = shotAlign;
          s.params.alignment = shotAlign;

          // 蒙德里安边缘信息（占位：在 TunnelEngine 运行时会根据实际背景计算精确值）
          // 这里先用 alignment 驱动的默认边缘位置，保证 Director 阶段布局正确
          const defaultEdges = {
            left: shotAlign === 'left'   ? 22 : 8,
            right: shotAlign === 'right' ? 78 : 92,
            top: 15, bottom: 85
          };
          const placeholderEdges = {
            leftEdgePct: defaultEdges.left,
            rightEdgePct: defaultEdges.right,
            topEdgePct: defaultEdges.top,
            bottomEdgePct: defaultEdges.bottom
          };

          // 词级强调预计算（7.4 getWordEmphasis）+ 每字独立动画参数（10.2 splitToCharSpans）
          // + ★ 词级独立排版构图（13.2：几何构图 + 同组第二行镜像变体 + 防出界钳制）
          s.__fitScale = TunnelDirector.assignWordLayouts(
            s.line.blocks || [],
            decoSeed + flatIdx * 53,
            compType,
            (s.indexInGroup === 1 || (s.isPageSplit && (s.pageIndex || 0) === 1)) ? { mirror: true } : {},
            true,            // layoutFit
            shotAlign,       // alignment ★ 传入对齐方式
            placeholderEdges, // edgeInfo  ★ 传入边缘占位信息
            { straight: true } // ★ 蒙德里安占位排版：横平竖直兜底（引擎会以真实色块边缘重排）
          ) || 1;
          const fam = ENTER_FAMILIES[s.enterFamily] || ENTER_FAMILIES.slide;
          (s.line.blocks || []).forEach((b, bi) => {
            b.__emphasis = TunnelDirector.getWordEmphasis(
              { isEmotion: b.isEmotion, emotionColor: b.emotionColor }, s.emotion, sec.energy);
            // char 档：每字独立入场类型/方向/大小/错峰；word/phrase 档：词统一入场
            b.__charAnims = (gran === 'char')
              ? splitToCharAnimParams((b.chars || []).length || 1, sec.energy, decoSeed + bi * 397, s.enterFamily, b.chars)
              : null;
            // word/phrase 档：词块入场从【本镜家族】池中选（入场有主题感，不随机乱跳）
            if (!b.__charAnims) {
              const pool = gran === 'phrase' ? fam.mind : fam.pool;
              b.__wordAnim = {
                type: pool[(decoSeed + bi * 61 + flatIdx * 17) % pool.length],
                dir: (decoSeed + bi) % 4
              };
            }
          });
          prevParams = s.params;
          flatIdx++;
        });
        void gi;
      });
    });

    // 展平 shot 列表（供时间查找）
    this.sections = sections;
    this.shotList = sections.flatMap(sec => sec.groups.flatMap(g => g.shots));
    return { sections, shots: this.shotList };
  }

  /* ---------- 第 17.1 节：时间查找（支持 seek） ---------- */
  findShotAt(timeMs) {
    const list = this.shotList;
    if (!list.length) return null;
    let lo = 0, hi = list.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].start <= timeMs) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (idx === -1) idx = 0;
    return list[idx];
  }

  findGroupAt(timeMs) {
    for (const sec of this.sections) {
      for (const g of sec.groups) {
        if (timeMs >= g.start && timeMs < g.end) return g;
      }
    }
    return this.sections.length ? this.sections[0].groups[0] : null;
  }

  findSectionAt(timeMs) {
    for (const sec of this.sections) {
      if (timeMs >= sec.start && timeMs < sec.end) return sec;
    }
    return this.sections.length ? this.sections[this.sections.length - 1] : null;
  }
}
