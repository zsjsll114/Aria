/**
 * TunnelAnimations.js — 「流光隧道」动画/装饰/拆字系统
 * 忠实落地 PV-技术方案.md 第 10 / 11 / 13.4 / 8.3 章：
 *
 * 1. 第 10.1 节 拆字粒度三档（按段落能量动态切换，不写死）：
 *    - phrase：整行/整块一次揭示（intro/outro 温和整块缓入）
 *    - word  ：词块一次爆出（不逐字吐字，一下直接出来）
 *    - char  ：逐字独立轨迹（每字独立入场动画类型/方向/大小/错峰）
 * 2. 第 10.3/10.4 节：8 大类入场 + 5 种出场 WAAPI 动画库
 * 3. 第 10.2 节 splitToCharSpans：char 档下每字 enterFrom: 'random'
 * 4. 第 13.4 节：37 种装饰元素库（几何18 + 有机5 + 构图辅助4 + 文字装饰10）
 * 5. 第 8.3 节：装饰组合 —— 每个句组从 37 种中选 3-5 个交错融合
 * 6. 第 11.1 节：几何蒙版 clip-path 转场
 */

const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
const EASE_BACK = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

function seededRandom(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17; s >>>= 0;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) / 4294967296;
  };
}

/* ★ 独立变换属性约定：内联 transform 承载世界坐标定位，
   逐字动画一律只驱动 opacity / filter / clip-path 与独立属性 translate/scale/rotate，
   绝不覆盖 transform 本身（与 PV 模式相同的硬约束）。 */

/* ========== 第 10.3 节：入场动画库（8 大类） ========== */
const ENTER_ANIMATIONS = {
  /* 1. 直線移動 */
  'slide-up': (el, d) => el.animate(
    [{ translate: '0 46px', scale: '0.85', opacity: 0 }, { translate: '0 0', scale: '1', opacity: 1 }],
    { duration: 200, delay: d, easing: EASE_OUT, fill: 'backwards' }),

  'slide-diagonal': (el, d, dir = 0) => {
    const v = [[70, 36], [-70, 36], [70, -36], [-70, -36]][dir % 4];
    return el.animate(
      [{ translate: `${v[0]}px ${v[1]}px`, opacity: 0 }, { translate: '0 0', opacity: 1 }],
      { duration: 180, delay: d, easing: 'ease-out', fill: 'backwards' });
  },

  'resize-slide': (el, d) => el.animate(
    [{ translate: '60px 0', scale: '1.28 0.82', opacity: 0 }, { translate: '0 0', scale: '1 1', opacity: 1 }],
    { duration: 200, delay: d, easing: EASE_OUT, fill: 'backwards' }),

  /* 2. 回転 */
  'rotate-z-bounce': (el, d) => el.animate(
    [{ rotate: '-42deg', scale: '0.5', opacity: 0 },
     { rotate: '14deg', scale: '1.1', opacity: 1, offset: 0.6 },
     { rotate: '0deg', scale: '1', opacity: 1 }],
    { duration: 300, delay: d, easing: EASE_BACK, fill: 'backwards' }),

  'rotate-3d': (el, d) => el.animate(
    [{ transform: 'perspective(400px) rotateY(88deg) rotateX(26deg)', opacity: 0 },
     { transform: 'perspective(400px) rotateY(0deg) rotateX(0deg)', opacity: 1 }],
    { duration: 350, delay: d, easing: 'ease-out', fill: 'backwards' }),

  /* 3. 拡大縮小 */
  'scale-burst': (el, d) => el.animate(
    [{ scale: '0.1', opacity: 0 }, { scale: '1.28', opacity: 1, offset: 0.7 }, { scale: '1', opacity: 1 }],
    { duration: 250, delay: d, easing: EASE_BACK, fill: 'backwards' }),

  /* 4. 歪み系（ラスター歪み） */
  'raster-wobble': (el, d) => el.animate(
    [{ translate: '8px 0', rotate: '6deg', opacity: 0 },
     { translate: '-4px 0', rotate: '-4deg', opacity: 0.6, offset: 0.3 },
     { translate: '2px 0', rotate: '2deg', opacity: 0.8, offset: 0.6 },
     { translate: '0 0', rotate: '0deg', opacity: 1 }],
    { duration: 250, delay: d, easing: 'ease-out', fill: 'backwards' }),

  /* 5. 点滅 */
  'blink-in': (el, d) => el.animate(
    [{ opacity: 0 }, { opacity: 1 }, { opacity: 0 }, { opacity: 1 }, { opacity: 0 }, { opacity: 1 }],
    { duration: 200, delay: d, easing: 'steps(6)', fill: 'backwards' }),

  /* 6. 砕け散る（シャター逆再生） */
  'shatter-reverse': (el, d) => el.animate(
    [{ scale: '1.5', rotate: '10deg', opacity: 0, filter: 'blur(8px)' },
     { scale: '1', rotate: '0deg', opacity: 1, filter: 'blur(0px)' }],
    { duration: 300, delay: d, easing: EASE_OUT, fill: 'backwards' }),

  /* 8. クリップ/スキャン */
  'clip-reveal': (el, d) => el.animate(
    [{ clipPath: 'inset(0 100% 0 0)', opacity: 1 }, { clipPath: 'inset(0 0% 0 0)', opacity: 1 }],
    { duration: 200, delay: d, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', fill: 'backwards' }),

  'scan-clip': (el, d) => el.animate(
    [{ clipPath: 'inset(50% 0 50% 0)', opacity: 0 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 }],
    { duration: 220, delay: d, easing: 'ease-out', fill: 'backwards' }),

  /* 补充：溶解入场（blur 收束） */
  'dissolve-in': (el, d) => el.animate(
    [{ opacity: 0, filter: 'blur(10px)', scale: '1.15' }, { opacity: 1, filter: 'blur(0px)', scale: '1' }],
    { duration: 260, delay: d, easing: EASE_OUT, fill: 'backwards' }),

  /* ===== 借鉴 JPV Lyrics Motion Kit 的逐字主题（AGPL-3.0，改作） ===== */

  /* ★ 泡泡生长（PositionBubble）：从底部轴心放大长出 0→1.03，摆动旋转 -30°→10°→0°，小幅回弹落位 */
  'bubble-grow': (el, d) => el.animate(
    [{ scale: '0', rotate: '-30deg', opacity: 0, translate: '0 6px' },
     { scale: '1.03', rotate: '10deg', opacity: 1, translate: '0 0', offset: 0.62 },
     { scale: '1.02', rotate: '0deg', opacity: 1, offset: 0.78 },
     { scale: '1', rotate: '0deg', opacity: 1 }],
    { duration: 340, delay: d, easing: EASE_BACK, fill: 'backwards' }),

  /* ★ 弧线飞入（Flying）：从画面外沿二次贝塞尔弧线飞入，旋转/模糊随进度衰减，收束落位 */
  'arc-fly': (el, d, dir = 0) => {
    const a = (dir % 4) * (Math.PI / 2);               // 0/90/180/270°
    const sx = Math.cos(a) * 46, sy = Math.sin(a) * 46; // 起点在远处
    const mx = sx * 0.15 - Math.sin(a * 2) * 26;        // 弧线弯度
    const my = sy * 0.15 + Math.cos(a * 2) * 26;
    return el.animate(
      [{ translate: `${sx}px ${sy}px`, rotate: `${(dir % 2 ? 1 : -1) * (44 + dir * 13)}deg`, opacity: 0, filter: 'blur(7px)', scale: '0.72' },
       { translate: `${mx}px ${my}px`, rotate: `${(dir % 2 ? 1 : -1) * 6}deg`, opacity: 0.92, offset: 0.5 },
       { translate: '0 0', rotate: '0deg', opacity: 1, filter: 'blur(0px)', scale: '1' }],
      { duration: 380, delay: d, easing: EASE_OUT, fill: 'backwards' });
  },

  /* ★ 字距收拢（TrackIn）：从宽字距向中间收拢（各字反向横向位移收敛 + 轻微放大） */
  'track-converge': (el, d, dir = 0) => {
    const pull = 36 + (dir % 3) * 10;
    const side = dir % 2 === 0 ? -pull : pull;
    return el.animate(
      [{ translate: `${side}px 0`, opacity: 0, scale: '0.86' },
       { translate: `${side * 0.25}px 0`, opacity: 1, offset: 0.45 },
       { translate: '0 0', opacity: 1, scale: '1' }],
      { duration: 300, delay: d, easing: EASE_OUT, fill: 'backwards' });
  },

  /* ★ 四角进场（BlockShadow 取意）：从角落向构图中位汇聚，末段轻微过冲落位 */
  'corners-in': (el, d, dir = 0) => {
    const cx = (dir % 2 === 0 ? -1 : 1) * 64;
    const cy = (dir % 4 < 2 ? -1 : 1) * 38;
    return el.animate(
      [{ translate: `${cx}px ${cy}px`, opacity: 0, scale: '0.7' },
       { translate: `${cx * 0.15}px ${cy * 0.15}px`, opacity: 1, offset: 0.7, scale: '1.06' },
       { translate: '0 0', opacity: 1, scale: '1' }],
      { duration: 320, delay: d, easing: EASE_OUT, fill: 'backwards' });
  },

  /* ★ 色闪揭示（StrokeShadow 取意）：先放大闪现，随即收敛为正位 */
  'stroke-flash-in': (el, d) => el.animate(
    [{ opacity: 0, scale: '1.4', filter: 'blur(4px)' },
     { opacity: 1, scale: '1.12', filter: 'blur(0px)', offset: 0.28 },
     { opacity: 0.6, scale: '1.02', offset: 0.55 },
     { opacity: 1, scale: '1', filter: 'blur(0px)' }],
    { duration: 300, delay: d, easing: EASE_OUT, fill: 'backwards' })
};

const ENTER_POOL_LOW = ['slide-up', 'slide-diagonal', 'clip-reveal', 'scan-clip', 'raster-wobble', 'resize-slide'];
const ENTER_POOL_HIGH = ['scale-burst', 'rotate-3d', 'rotate-z-bounce', 'blink-in', 'shatter-reverse'];

/* ===== 入场风格家族（借鉴 JPV 13 主题 + 现有 8 大类）
   ★ 每个分镜按构图/能量选一族，族内逐字选择 → 入场有主题感不单一，又保持变化 */
export const ENTER_FAMILIES = {
  'grow':    { pool: ['bubble-grow', 'scale-burst', 'rotate-z-bounce'], mind: ['bubble-grow', 'dissolve-in'] },
  'fly':     { pool: ['arc-fly', 'slide-diagonal', 'resize-slide'], mind: ['arc-fly', 'clip-reveal'] },
  'track':   { pool: ['track-converge', 'scan-clip', 'clip-reveal'], mind: ['track-converge', 'dissolve-in'] },
  'corners': { pool: ['corners-in', 'slide-up', 'rotate-3d'], mind: ['corners-in', 'slide-diagonal'] },
  'flash':   { pool: ['stroke-flash-in', 'blink-in', 'scale-burst'], mind: ['stroke-flash-in', 'clip-reveal'] },
  'burst':   { pool: ENTER_POOL_HIGH, mind: ['scale-burst', 'shatter-reverse'] },
  'slide':   { pool: ENTER_POOL_LOW, mind: ['slide-up', 'clip-reveal', 'scan-clip'] }
};

/**
 * 按构图 + 能量 + 拆字粒度挑选入场风格家族
 * @returns {string} family 名（对应 ENTER_FAMILIES 键）或空串（用默认池）
 */
export function pickEnterFamily(compType = '', energy = 0.5, gran = 'char') {
  // ★ 和缓段落（低能量）：无论构图一律 goto 柔和族，避免"爆"类动画造成顿挫感
  if (energy <= 0.42) {
    if (compType === 'column') return 'grow';
    if (compType === 'arc' || compType === 'steps') return 'track';
    return 'slide';
  }
  // 整词/整块揭示倾向柔和收拢；逐字倾向表现力
  if (gran !== 'char') {
    if (compType === 'column') return 'grow';
    if (compType === 'diagonal' || compType === 'tilt') return energy > 0.6 ? 'corners' : 'slide';
    if (compType === 'arc' || compType === 'steps') return 'track';
    if (compType === 'center') return 'flash';
    return energy > 0.7 ? 'burst' : 'slide';
  }
  switch (compType) {
    case 'column': return 'grow';
    case 'arc':
    case 'scatter': return 'fly';
    case 'steps': return 'track';
    case 'diagonal':
    case 'tilt': return energy > 0.6 ? 'corners' : 'slide';
    case 'center': return energy > 0.7 ? 'flash' : 'slide';
    default: return energy > 0.7 ? 'burst' : 'slide';
  }
}

/* ========== 第 10.4 节：出场动画库 ========== */
const EXIT_ANIMATIONS = {
  'fade-out': (el, d) => el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, delay: d, easing: 'ease-in', fill: 'forwards' }),

  'scatter': (el, d, i, total) => {
    const dx = (i - total / 2) * 36;
    const dy = -46 - ((i * 37) % 80);
    return el.animate(
      [{ translate: '0 0', opacity: 1 }, { translate: `${dx}px ${dy}px`, opacity: 0 }],
      { duration: 200, delay: d, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', fill: 'forwards' });
  },

  'implode': (el, d) => el.animate(
    [{ scale: '1', opacity: 1 }, { scale: '0.1', opacity: 0 }],
    { duration: 150, delay: d, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', fill: 'forwards' }),

  'slide-out': (el, d) => el.animate(
    [{ translate: '0 0', opacity: 1 }, { translate: '-110px 0', opacity: 0 }],
    { duration: 180, delay: d, easing: 'ease-in', fill: 'forwards' }),

  'dissolve': (el, d) => el.animate(
    [{ opacity: 1, filter: 'blur(0px)' }, { opacity: 0.5, filter: 'blur(4px)', offset: 0.5 }, { opacity: 0, filter: 'blur(12px)' }],
    { duration: 250, delay: d, easing: 'ease-in', fill: 'forwards' })
};

export function playEnterAnimation(el, type = 'slide-up', delay = 0, duration = 200, direction = 0) {
  if (!el || !el.animate) return null;
  const fn = ENTER_ANIMATIONS[type] || ENTER_ANIMATIONS['slide-up'];
  try {
    const anim = fn(el, delay, direction);
    if (duration && anim) {
      try { anim.effect.updateTiming({ duration: Math.max(80, Math.round(duration)) }); } catch (e) {}
    }
    return anim;
  } catch (e) { return null; }
}

export function playExitAnimation(el, type = 'fade-out', delay = 0, charIndex = 0, charTotal = 1) {
  if (!el || !el.animate) return null;
  const fn = EXIT_ANIMATIONS[type] || EXIT_ANIMATIONS['fade-out'];
  try { return fn(el, delay, charIndex, charTotal); } catch (e) { return null; }
}

/* ========== 第 10.2 节：splitToCharSpans —— 每字独立动画参数（char 档） ========== */
/**
 * 为一个词块的每个字符生成独立的入场参数（enterFrom: 'random'）
 * @param {number} charCount 字符数
 * @param {number} energy 段落能量（决定动画池高低能）
 * @param {number} seed 词块种子
 * @param {string} [family] 入场风格家族（ENTER_FAMILIES 键）：族内选择，入场有主题感
 * @returns {Array<{type, dir, scaleJitter, delay}>}
 */
function _isCjkCh(ch) {
  const cp = (ch && ch.codePointAt) ? ch.codePointAt(0) : 0;
  return (cp >= 0x3000 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xffef);
}

export function splitToCharAnimParams(charCount, energy, seed, family, chars) {
  const rng = seededRandom((seed >>> 0) || 7);
  const fam = ENTER_FAMILIES[family];
  const pool = fam ? fam.pool : (energy > 0.7 ? ENTER_POOL_HIGH : ENTER_POOL_LOW);
  const out = [];
  const baseEnergy = clamp01(energy);
  for (let i = 0; i < charCount; i++) {
    const chChar = chars && chars[i] ? chars[i].char : '';
    const isCjk = _isCjkCh(chChar);
    const maxRot = isCjk ? 15 : 5;
    const rhythmRot = Math.sin(i * 1.37 + seed * 0.017) * 0.5 + 0.5;
    const rnd = rng();
    let rotation = (rnd - 0.5) * 2 * maxRot * (0.3 + baseEnergy * 0.5 + rhythmRot * 0.25);
    if (i === 0) rotation *= 0.3;
    if (i === charCount - 1) rotation *= 0.6;
    rotation = Math.max(-maxRot, Math.min(maxRot, rotation));
    out.push({
      type: pool[Math.floor(rng() * pool.length)],
      dir: Math.floor(rng() * 4),
      scaleJitter: 0.9 + rng() * 0.3,
      delay: i * (18 + Math.floor(rng() * 34)),
      rotation: Number(rotation.toFixed(2)),
      isCjk
    });
  }
  return out;
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

/* ========== 第 11.1 节：几何蒙版转场 ========== */
const TRANSITION_MASKS = {
  'wipe-left':   { from: 'inset(0 100% 0 0)',  to: 'inset(0 0% 0 0)' },
  'wipe-center': { from: 'inset(0 50% 0 50%)', to: 'inset(0 0% 0 0)' },
  'wipe-down':   { from: 'inset(0 0 100% 0)',  to: 'inset(0 0 0% 0)' },
  'iris':        { from: 'circle(0% at 50% 50%)', to: 'circle(150% at 50% 50%)' },
  'blinds':      { from: 'inset(0 0 100% 0)',  to: 'inset(0 0 0% 0)' }
};

export function playMaskTransition(el, shape = 'wipe-left', duration = 300) {
  if (!el || !el.animate) return null;
  const m = TRANSITION_MASKS[shape] || TRANSITION_MASKS['wipe-left'];
  try {
    return el.animate(
      [{ clipPath: m.from, opacity: 0.4 }, { clipPath: m.to, opacity: 1 }],
      { duration: Math.max(150, duration), easing: 'ease-in-out', fill: 'backwards' });
  } catch (e) { return null; }
}

/* 第 11.5 节：段落白闪（柔和） */
export function playFlashOverlay(overlayEl, duration = 260) {
  if (!overlayEl || !overlayEl.animate) return;
  try {
    overlayEl.animate([{ opacity: 0.55 }, { opacity: 0 }], { duration, easing: 'ease-out' });
  } catch (e) {}
}

/* ==========================================================================
   第 13.4 节：37 种装饰元素库
   每种装饰一个生成器 (rng, color) => svg 片段；位置/尺寸由返回的包装决定
   ========================================================================== */
const N = (v) => Math.round(v * 10) / 10;

const DECORATION_LIBRARY = {
  /* ---- 几何图形类（18） ---- */
  'circle': (rng, c) => `<circle cx="250" cy="250" r="${N(120 + rng() * 80)}" fill="none" stroke="${c}" stroke-width="2" opacity="0.55"/>`,
  'diamond': (rng, c) => `<rect x="190" y="190" width="120" height="120" fill="none" stroke="${c}" stroke-width="2.5" opacity="0.6" transform="rotate(45 250 250)"/>`,
  'cross': (rng, c) => `<path d="M 250 170 V 330 M 170 250 H 330" stroke="${c}" stroke-width="3" opacity="0.55" stroke-linecap="round"/>`,
  'straight-line': (rng, c) => `<line x1="60" y1="${N(160 + rng() * 180)}" x2="440" y2="${N(160 + rng() * 180)}" stroke="${c}" stroke-width="1.6" opacity="0.5"/>`,
  'concentric': (rng, c) => {
    const cnt = 8 + Math.floor(rng() * 10);
    const lines = [];
    for (let i = 0; i < cnt; i++) {
      const a = (2 * Math.PI * i) / cnt + rng() * 0.2;
      lines.push(`<line x1="${N(250 + Math.cos(a) * 88)}" y1="${N(250 + Math.sin(a) * 88)}" x2="${N(250 + Math.cos(a) * 235)}" y2="${N(250 + Math.sin(a) * 235)}" stroke="${c}" stroke-width="2" opacity="0.42"/>`);
    }
    return lines.join('');
  },
  'dashed-line': (rng, c) => `<line x1="80" y1="${N(120 + rng() * 260)}" x2="420" y2="${N(120 + rng() * 260)}" stroke="${c}" stroke-width="2" stroke-dasharray="10 8" opacity="0.55"/>`,
  'triangle-grid': (rng, c) => {
    const s = 100 + Math.floor(rng() * 60);
    let t = '';
    for (let x = 0; x < 500; x += s) t += `<polygon points="${x},500 ${x + s / 2},${500 - s * 0.87} ${x + s},500" fill="none" stroke="${c}" stroke-width="1.2" opacity="0.3"/>`;
    return t;
  },
  'checker': (rng, c) => {
    const s = 50 + Math.floor(rng() * 30);
    let t = '';
    for (let y = 0; y < 500; y += s) for (let x = 0; x < 500; x += s) {
      if (((x / s) + (y / s)) % 2 === 0) t += `<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="${c}" opacity="0.08"/>`;
    }
    return t;
  },
  'color-block': (rng, c) => `<rect x="${N(rng() * 300)}" y="${N(rng() * 300)}" width="${N(120 + rng() * 160)}" height="${N(120 + rng() * 160)}" fill="${c}" opacity="0.12"/>`,
  'burst-ray': (rng, c) => {
    const cnt = 5 + Math.floor(rng() * 5);
    let t = '';
    for (let i = 0; i < cnt; i++) {
      const a = (2 * Math.PI * i) / cnt;
      t += `<polygon points="250,250 ${N(250 + Math.cos(a - 0.06) * 230)},${N(250 + Math.sin(a - 0.06) * 230)} ${N(250 + Math.cos(a + 0.06) * 230)},${N(250 + Math.sin(a + 0.06) * 230)}" fill="${c}" opacity="0.16"/>`;
    }
    return t;
  },
  'perspective-grid': (rng, c) => {
    let t = `<line x1="0" y1="500" x2="250" y2="250" stroke="${c}" stroke-width="1" opacity="0.3"/><line x1="500" y1="500" x2="250" y2="250" stroke="${c}" stroke-width="1" opacity="0.3"/><line x1="250" y1="500" x2="250" y2="250" stroke="${c}" stroke-width="1" opacity="0.3"/>`;
    for (let i = 1; i <= 4; i++) t += `<line x1="${N(i * 62)}" y1="${N(500 - i * 24)}" x2="${N(500 - i * 62)}" y2="${N(500 - i * 24)}" stroke="${c}" stroke-width="1" opacity="0.26"/>`;
    return t;
  },
  'geo-pattern': (rng, c) => {
    let t = '';
    for (let i = 0; i < 6; i++) t += `<polygon points="${N(rng() * 500)},${N(rng() * 500)} ${N(rng() * 500)},${N(rng() * 500)} ${N(rng() * 500)},${N(rng() * 500)}" fill="none" stroke="${c}" stroke-width="1.3" opacity="0.28"/>`;
    return t;
  },
  'brackets': (rng, c) => {
    const s = 70 + Math.floor(rng() * 50), L = 24, t2 = 2 + Math.floor(rng() * 2);
    const mk = (x, y, sx, sy) => `<path d="M ${x + sx * L} ${y} L ${x} ${y} L ${x} ${y + sy * L}" fill="none" stroke="${c}" stroke-width="${t2}" opacity="0.7"/>`;
    return mk(250 - s, 250 - s, 1, 1) + mk(250 + s, 250 - s, -1, 1) + mk(250 - s, 250 + s, 1, -1) + mk(250 + s, 250 + s, -1, -1);
  },
  'arrow': (rng, c) => {
    const a = rng() * 360;
    return `<g transform="rotate(${N(a)} 250 250)"><line x1="140" y1="250" x2="330" y2="250" stroke="${c}" stroke-width="2.4" opacity="0.55"/><polygon points="330,250 302,236 302,264" fill="${c}" opacity="0.55"/></g>`;
  },
  'asterisk': (rng, c) => {
    let t = '';
    for (let i = 0; i < 3; i++) t += `<line x1="${N(250 - Math.cos(i * Math.PI / 3) * 60)}" y1="${N(250 - Math.sin(i * Math.PI / 3) * 60)}" x2="${N(250 + Math.cos(i * Math.PI / 3) * 60)}" y2="${N(250 + Math.sin(i * Math.PI / 3) * 60)}" stroke="${c}" stroke-width="2.6" opacity="0.5" stroke-linecap="round"/>`;
    return t;
  },
  'hud-marker': (rng, c) => `<rect x="${N(160 + rng() * 60)}" y="${N(160 + rng() * 60)}" width="${N(160 + rng() * 60)}" height="${N(160 + rng() * 60)}" fill="none" stroke="${c}" stroke-width="1.2" opacity="0.4" stroke-dasharray="4 6"/><circle cx="250" cy="250" r="4" fill="${c}" opacity="0.7"/>`,
  'ring': (rng, c) => {
    const r = 90 + Math.floor(rng() * 100);
    const dashed = rng() > 0.5;
    return `<circle cx="250" cy="250" r="${r}" fill="none" stroke="${c}" stroke-width="${dashed ? 2 : 3}" opacity="0.5" ${dashed ? 'stroke-dasharray="12 10"' : ''}/>`;
  },
  'sawtooth': (rng, c) => {
    const w = 40 + Math.floor(rng() * 30);
    let pts = [];
    for (let x = 60; x <= 440; x += w) pts.push(`${x},380 ${x + w / 2},340`);
    return `<polyline points="${pts.join(' ')}" fill="none" stroke="${c}" stroke-width="2" opacity="0.45"/>`;
  },

  /* ---- 有机/流动类（5） ---- */
  'flow-curve': (rng, c) => `<path d="M 60 ${N(180 + rng() * 140)} C 180 ${N(80 + rng() * 120)}, 320 ${N(300 + rng() * 120)}, 440 ${N(160 + rng() * 160)}" fill="none" stroke="${c}" stroke-width="2" opacity="0.45"/>`,
  'wave': (rng, c) => {
    const amp = 24 + rng() * 30, y0 = 200 + rng() * 100;
    return `<path d="M 40 ${N(y0)} Q 115 ${N(y0 - amp)}, 190 ${N(y0)} T 340 ${N(y0)} T 460 ${N(y0)}" fill="none" stroke="${c}" stroke-width="2.2" opacity="0.45"/>`;
  },
  'cloud': (rng, c) => {
    const x = 120 + rng() * 180, y = 150 + rng() * 180;
    return `<g filter="url(#tunnel-blur-deco)" opacity="0.3"><circle cx="${N(x)}" cy="${N(y)}" r="46" fill="${c}"/><circle cx="${N(x + 52)}" cy="${N(y + 10)}" r="36" fill="${c}"/><circle cx="${N(x - 48)}" cy="${N(y + 14)}" r="32" fill="${c}"/></g>`;
  },
  'organic-blob': (rng, c) => `<path d="M 250 ${N(140 + rng() * 40)} C ${N(330 + rng() * 40)} ${N(150 + rng() * 60)}, ${N(360 + rng() * 30)} ${N(280 + rng() * 50)}, ${N(270 + rng() * 40)} ${N(350 + rng() * 30)} C ${N(180 + rng() * 40)} ${N(380 + rng() * 30)}, ${N(130 + rng() * 40)} ${N(280 + rng() * 50)}, 250 ${N(140 + rng() * 40)} Z" fill="${c}" opacity="0.14"/>`,
  'bokeh': (rng, c) => {
    let t = '';
    for (let i = 0; i < 5; i++) t += `<circle cx="${N(80 + rng() * 340)}" cy="${N(80 + rng() * 340)}" r="${N(18 + rng() * 40)}" fill="${c}" opacity="${N(0.08 + rng() * 0.1)}"/>`;
    return t;
  },

  /* ---- 构图辅助线类（4） ---- */
  'rule-thirds': (rng, c) => `<line x1="166" y1="0" x2="166" y2="500" stroke="${c}" stroke-width="0.8" opacity="0.3"/><line x1="333" y1="0" x2="333" y2="500" stroke="${c}" stroke-width="0.8" opacity="0.3"/><line x1="0" y1="166" x2="500" y2="166" stroke="${c}" stroke-width="0.8" opacity="0.3"/><line x1="0" y1="333" x2="500" y2="333" stroke="${c}" stroke-width="0.8" opacity="0.3"/>`,
  'phi-grid': (rng, c) => {
    const p = 500 * 0.382;
    return `<line x1="${N(p)}" y1="0" x2="${N(p)}" y2="500" stroke="${c}" stroke-width="0.8" opacity="0.28"/><line x1="${N(500 - p)}" y1="0" x2="${N(500 - p)}" y2="500" stroke="${c}" stroke-width="0.8" opacity="0.28"/><line x1="0" y1="${N(p)}" x2="500" y2="${N(p)}" stroke="${c}" stroke-width="0.8" opacity="0.28"/>`;
  },
  'golden-spiral': (rng, c) => {
    let t = '', x = 60, y = 60, w = 380, h = 380;
    for (let i = 0; i < 4; i++) {
      t += `<path d="M ${N(x + w)} ${N(y)} A ${N(w)} ${N(h)} 0 0 1 ${N(x + w)} ${N(y + h)}" fill="none" stroke="${c}" stroke-width="1" opacity="0.3"/>`;
      const nw = h * 0.618; const nh = w * 0.618;
      x += w - nw; w = nw; h = nh;
    }
    return t;
  },
  'frame': (rng, c) => `<rect x="70" y="90" width="360" height="320" fill="none" stroke="${c}" stroke-width="1.4" opacity="0.4"/><rect x="86" y="106" width="328" height="288" fill="none" stroke="${c}" stroke-width="0.7" opacity="0.25"/>`,

  /* ---- 文字装饰类（10，SVG <text>） ---- */
  'scattered-text': (rng, c) => {
    const chars = 'PVｱﾘｂｳﾄ★☆※2026'.split('');
    let t = '';
    for (let i = 0; i < 6; i++) t += `<text x="${N(60 + rng() * 380)}" y="${N(80 + rng() * 340)}" font-size="${N(10 + rng() * 14)}" fill="${c}" opacity="${N(0.2 + rng() * 0.3)}" font-family="monospace">${chars[Math.floor(rng() * chars.length)]}</text>`;
    return t;
  },
  'text-strip': (rng, c) => `<text x="0" y="${N(120 + rng() * 260)}" font-size="26" fill="${c}" opacity="0.28" font-weight="900" letter-spacing="8">LET IT FLOW ── LET IT FLOW ──</text>`,
  'text-card': (rng, c) => `<rect x="${N(150 + rng() * 80)}" y="${N(170 + rng() * 80)}" width="180" height="90" fill="none" stroke="${c}" stroke-width="1.4" opacity="0.45"/><text x="${N(160 + rng() * 80)}" y="${N(225 + rng() * 40)}" font-size="18" fill="${c}" opacity="0.5" font-family="monospace">LYRIC / 0${1 + Math.floor(rng() * 8)}</text>`,
  'outline-text': (rng, c) => `<text x="250" y="300" font-size="${N(140 + rng() * 60)}" fill="none" stroke="${c}" stroke-width="1.6" opacity="0.4" text-anchor="middle" font-weight="900">PV</text>`,
  'layered-text': (rng, c) => `<text x="${N(236 + rng() * 12)}" y="${N(286 + rng() * 12)}" font-size="90" fill="${c}" opacity="0.22" font-weight="900">MIX</text><text x="${N(252 + rng() * 12)}" y="${N(302 + rng() * 12)}" font-size="90" fill="${c}" opacity="0.22" font-weight="900">MIX</text>`,
  'glow-text': (rng, c) => `<text x="250" y="${N(200 + rng() * 160)}" font-size="${N(34 + rng() * 20)}" fill="${c}" opacity="0.5" text-anchor="middle" font-weight="900" style="filter:blur(1px)">GLOW</text>`,
  'vertical-subtext': (rng, c) => {
    let t = '';
    const y0 = 100 + rng() * 60;
    for (let i = 0; i < 5; i++) t += `<text x="${N(60 + rng() * 380)}" y="${N(y0 + i * 42)}" font-size="15" fill="${c}" opacity="0.4" writing-mode="tb">詩</text>`;
    return t;
  },
  'formula-overlay': (rng, c) => {
    const a = 1 + Math.floor(rng() * 9), b = 1 + Math.floor(rng() * 9);
    return `<text x="${N(70 + rng() * 120)}" y="${N(120 + rng() * 260)}" font-size="17" fill="${c}" opacity="0.42" font-family="monospace">f(t)=Σ${a}·sin(ωt+φ${b})</text><text x="${N(260 + rng() * 120)}" y="${N(320 + rng() * 120)}" font-size="14" fill="${c}" opacity="0.36" font-family="monospace">∂E/∂t&gt;0</text>`;
  },
  'text-rain': (rng, c) => {
    let t = '';
    for (let i = 0; i < 8; i++) {
      const x = 60 + rng() * 380, y0 = 60 + rng() * 100;
      t += `<text x="${N(x)}" y="${N(y0)}" font-size="${N(11 + rng() * 8)}" fill="${c}" opacity="${N(0.16 + rng() * 0.24)}" font-family="monospace">${'ｱｲｳｴｵ'.repeat(2 + Math.floor(rng() * 3))}</text>`;
    }
    return t;
  },
  'barcode': (rng, c) => {
    let t = '';
    let x = 150;
    while (x < 350) { const w = 2 + Math.floor(rng() * 6); t += `<rect x="${x}" y="${N(200 + rng() * 60)}" width="${w}" height="${N(60 + rng() * 50)}" fill="${c}" opacity="0.4"/>`; x += w + 2 + Math.floor(rng() * 6); }
    return t;
  }
};

export const DECORATION_COUNT = Object.keys(DECORATION_LIBRARY).length; // 37

/**
 * 第 8.3 节：装饰组合 —— 每个句组从 37 种中选 2-3 个交错融合
 * ★ 降噪策略（用户反馈"背景图形略杂乱"）：每组合仅 2-3 种装饰、
 *   低透明度叠加（0.16~0.3），只留一两种为视觉主角，其余做极淡的纹理陪衬
 * @param {number} seed 组种子
 * @param {number} count 数量（默认 2-3）
 * @returns {Array<string>} 装饰类型名列表
 */
export function pickDecorationCombo(seed, count) {
  const rng = seededRandom((seed >>> 0) || 11);
  const all = Object.keys(DECORATION_LIBRARY);
  // 主装饰（1种）+ 陪衬装饰（1-2种）：分层降噪
  const n = count || (2 + Math.floor(rng() * 2)); // 2~3
  const pool = [...all];
  const combo = [];
  for (let i = 0; i < n && pool.length; i++) {
    combo.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  return combo;
}

/**
 * 渲染一个装饰组合（2-3 种装饰交错融合叠加，低透明度降噪）
 * @param {Array<string>} combo 装饰类型名列表
 * @param {number} seed 组种子
 * @param {string} color 描边色
 * @param {number} variantIndex shot 序号（同组变体微调）
 * @returns {string} SVG 标记
 */
export function buildDecorationComboSVG(combo, seed, color = '#ffcc33', variantIndex = 0) {
  const rng = seededRandom(((seed >>> 0) + variantIndex * 977) || 23);
  const defs = `<defs><filter id="tunnel-blur-deco" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="6"/></filter></defs>`;
  const parts = combo.map((name, i) => {
    const gen = DECORATION_LIBRARY[name];
    if (!gen) return '';
    const inner = gen(rng, color);
    if (!inner) return '';
    // 每种装饰独立随机位置微移（交错融合）
    const dx = N((rng() - 0.5) * 90);
    const dy = N((rng() - 0.5) * 70);
    const rot = N((rng() - 0.5) * 24);
    const scale = N(0.85 + rng() * 0.4);
    // ★ 分层降噪：第 1 种为主角（0.55），其余陪衬（0.22）
    const layerOpacity = i === 0 ? 0.55 : 0.22;
    return `<g opacity="${layerOpacity}" transform="translate(${dx} ${dy}) rotate(${rot} 250 250) scale(${scale})">${inner}</g>`;
  }).join('');
  return `<svg viewBox="0 0 500 500" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">${defs}${parts}</svg>`;
}

/* 兼容旧接口 */
export function buildDecorationSVG(familyName, seed, variantIndex, color = '#ffcc33') {
  const map = {
    'concentric-lines': 'concentric',
    'brackets': 'brackets',
    'circles': 'ring',
    'grid': 'perspective-grid'
  };
  const name = map[familyName] || 'brackets';
  const rng = seededRandom(((seed >>> 0) + (variantIndex || 0) * 131) || 7);
  return `<svg viewBox="0 0 500 500" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">${DECORATION_LIBRARY[name](rng, color)}</svg>`;
}