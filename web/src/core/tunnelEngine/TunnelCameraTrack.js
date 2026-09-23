/**
 * TunnelCameraTrack.js — 「流光隧道」摄像机层
 * 落地 PV-技术方案.md 第 3.1 / 14 / 18.6 / 18.11 章：
 *
 * 1. CatmullRomSpline（18.11）：经过组内所有 shot 锚点的平滑曲线，
 *    保证位移/速度/加速度连续（一阶二阶可导）
 * 2. CameraGroupController（18.6）：组内沿轨道连续运动，shot 之间不切轨道；
 *    组间轨道衔接；节拍脉冲只做微调不破坏轨道连续性
 * 3. 支柱 A（3.1）：摄像机最终状态由"弹簧-速度积分"平滑趋近轨道采样点——
 *    任何目标改变只影响期望值，位移与速度永远连续
 * 4. 马达混合（14.2）：轨道马达 × 呼吸参数马达 × 手持微抖马达 加权叠加
 */

/* ---------- 18.11 Catmull-Rom 样条 ---------- */
export class CatmullRomSpline {
  constructor(anchors = []) {
    this.anchors = anchors;
  }

  sample(t) {
    const n = this.anchors.length - 1;
    if (n < 0) return null;
    if (n === 0) return { ...this.anchors[0] };
    const scaledT = Math.min(Math.max(t, 0), 1) * n;
    const i = Math.min(Math.floor(scaledT), n - 1);
    const localT = scaledT - i;
    const a = this.anchors;
    const p0 = a[Math.max(0, i - 1)];
    const p1 = a[i];
    const p2 = a[Math.min(n, i + 1)];
    const p3 = a[Math.min(n, i + 2)];
    return {
      x: this._crm(p0.x, p1.x, p2.x, p3.x, localT),
      y: this._crm(p0.y, p1.y, p2.y, p3.y, localT),
      z: this._crm(p0.z, p1.z, p2.z, p3.z, localT),
      scale: this._crm(p0.scale, p1.scale, p2.scale, p3.scale, localT),
      rotation: this._crm(p0.rotation, p1.rotation, p2.rotation, p3.rotation, localT)
    };
  }

  _crm(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (
      (2 * p1) +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
  }
}

const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const smoothstep = (t) => t * t * (3 - 2 * t);   // 两端速度=0，用于单程平滑横移

/* ===== 借鉴 PV Tool（个人非商用许可，改作）：节拍强度 exp 指数衰减 =====
   ★ 和缓化改造：不再用固定 BPM——
   · 节拍窗口 = 句组时长×0.5（慢歌句长 → 拍点稀 → 顿挫感弱）
   · 衰减速率随能量：低能量段落衰减平缓（更绵延），高能量段落攻击更尖锐 */
function beatEnvelopeAt(timeSec, beatInterval, energy) {
  const interval = clamp(beatInterval, 0.9, 4.5);
  const phase = (timeSec % interval) / interval;
  const decay = clamp(5 - 2.2 * energy, 2.2, 5);          // 低能量→2.2 缓衰减；高能量→5 尖锐
  return Math.exp(-phase * decay);
}

/* ---------- 18.6 组轨道摄像机控制器 ---------- */
export class TunnelCameraController {
  constructor() {
    this.currentGroupId = -1;
    this.track = null;
    this.trackStart = 0;
    this.trackDuration = 1;
    this.moveType = 'pan';
    this.bpm = 116;
    this.frozen = false;

    this.transition = null;

    this.cam = { x: 0, y: 0, z: 0, scale: 1, rotZ: 0, rotX: 0, rotY: 0, vx: 0, vy: 0 };
    this.focus = null;
    this.spring = 0.05;
    this.friction = 0.88;
    this.speedMultiplier = 1.0;
    this.intensity = 0.6;

    this.beatPhase = 0;
    this.beatEnv = 0;
    this.velocity = { vx: 0, vy: 0 };
  }

  setFrozen(v) { this.frozen = !!v; }
  isFrozen() { return this.frozen; }

  setSpeed(v) { this.speedMultiplier = Math.max(0.2, v || 1); }
  setDamping(d) {
    const dd = Math.min(Math.max(d || 0.05, 0.012), 0.12);
    this.spring = dd;
    this.friction = Math.min(Math.max(1 - dd * 2.4, 0.6), 0.97);
  }
  setBpm(b) { if (b > 0 && isFinite(b)) this.bpm = clamp(b, 60, 220); }

  /**
   * 为整组规划连续轨道（18.6 planGroupTrack）
   * 锚点来自每个 shot 的排版参数偏移 —— ★ 统一大尺度（±40% 视口）保证看得见的运镜
   */
  planGroupTrack(group) {
    const anchors = group.shots.map(shot => {
      const L = shot.params.layout;
      return {
        x: L.offsetX * 460,
        y: L.offsetY * 340,
        z: 0,
        scale: 1 + (L.scale - 1) * 0.35,
        rotation: L.angle * 0.22,
        time: shot.start
      };
    });
    if (!anchors.length) anchors.push({ x: 0, y: 0, z: 0, scale: 1, rotation: 0, time: group.start });

    // ★ 单锚点组补一段反向姿态差，组内镜头持续漫游而非钉死
    if (anchors.length === 1) {
      anchors.push({ ...anchors[0], x: anchors[0].x * -0.6, y: anchors[0].y * -0.6, time: group.end });
    }

    const prevEnd = (this.track && this.track.anchors)
      ? this.track.anchors[this.track.anchors.length - 1]
      : null;

    this.track = new CatmullRomSpline(anchors);
    this.trackStart = group.start;
    this.trackDuration = Math.max(group.end - group.start, 500);
    this.moveType = group.moveType || 'pan';
    this.intensity = Math.max((group.scene && group.scene.cameraIntensity) || 0.6, 0.4);

    // 组间过渡：上一组轨道终点 → 本组轨道起点，300ms 曲线衔接
    if (prevEnd && this.currentGroupId !== group.id) {
      const startAnchor = anchors[0];
      this.transition = {
        from: { x: prevEnd.x, y: prevEnd.y, scale: prevEnd.scale, rotation: prevEnd.rotation, z: prevEnd.z },
        to: { x: startAnchor.x, y: startAnchor.y, scale: startAnchor.scale, rotation: startAnchor.rotation, z: startAnchor.z },
        t0: performance.now(),
        dur: 300
      };
    }
    this.currentGroupId = group.id;
  }

  /**
   * 运镜类型调制（在轨道采样上叠加马达，14.2 马达混合）
   * ★ 幅度按 intensity 放大 + 节拍包络叠加 → 镜头持续运动（推进/环绕/横移/俯仰）
   * ★ 防抖：旋转 ≤7°，只用慢速正弦/缓动，不产生高频振动
   */
  _motorOffset(t, timeSec) {
    const I = this.intensity;
    const beat = this.beatEnv || 0;
    switch (this.moveType) {
      // 推进：持续前进 + 节拍脉冲回推
      case 'push':  return { z: lerp(0, -150, t) * I - beat * 16 * I, rotX: 0, rotY: 0, rotZ: Math.sin(t * Math.PI * 2) * 2.2 * I };
      case 'pull':  return { z: lerp(0, 170, t) * I + beat * 18 * I, rotX: 0, rotY: 0, rotZ: -Math.sin(t * Math.PI * 2) * 2 * I };
      case 'dive':  return { y: lerp(-130, 30, t) * I, z: lerp(90, -30, t) * I, rotX: lerp(7, -2, t) * I, rotY: Math.sin(t * Math.PI) * 2 * I, rotZ: Math.sin(t * Math.PI * 2) * 1.4 * I }; // 俯冲（缓俯仰）
      case 'orbit': { const a = t * Math.PI * 2; return { x: Math.sin(a) * 190 * I, z: Math.cos(a) * 110 * I, rotY: -Math.sin(a) * 7 * I, rotX: Math.sin(a * 2) * 2 * I, rotZ: 0 }; } // 环绕（轻 Y 摆）
      case 'tilt':  return { rotZ: Math.sin(t * Math.PI) * 5 * I, y: lerp(20, -70, t) * I, rotX: lerp(-2, 5, t) * I, rotY: 0, z: -beat * 12 * I };  // 倾斜
      case 'rise':  return { y: lerp(120, -60, t) * I, rotX: lerp(-5, 4, t) * I, rotY: Math.sin(t * Math.PI) * 3 * I, rotZ: 0, z: -beat * 12 * I };   // 上升（缓俯仰）
      case 'spiral': { const a = t * Math.PI * 3; return { x: Math.sin(a) * 120 * I, y: lerp(60, -80, t) * I, z: Math.cos(a) * 80 * I, rotZ: a * 1.6 * I, rotX: Math.sin(a) * 3 * I, rotY: -Math.sin(a) * 3 * I }; } // 螺旋（轻柔三轴）
      case 'pan':
      default:      return { x: lerp(-170, 170, smoothstep(t)) * I, y: Math.sin(t * Math.PI) * 22 * I, rotY: lerp(-3, 3, smoothstep(t)) * I, rotX: 0, rotZ: 0, z: -beat * 14 * I }; // 平滑单程横移（两端无初速，换词不顿）
    }
  }

  /**
   * 逐帧更新：轨道采样 + 马达混合 + ★节拍驱动 + 弹簧积分平滑（连续无振）
   * ★ 焦点优先：focusTarget（最新唱响词块中心，纯计算无 DOM rect 反馈）作为 x/y 主目标；
   *   同时混合轨道漫游与节拍脉冲，保证镜头既跟词又有持续运动。
   * @returns {{x,y,z,scale,rotX,rotY,rotZ,vx,vy,beatPulse}}
   */
  update(group, shot, audioTimeMs, now, focusTarget) {
    if (this.frozen) {
      return { x: 0, y: 0, z: 0, scale: 1, rotX: 0, rotY: 0, rotZ: 0, vx: 0, vy: 0, beatPulse: 0 };
    }
    if (!group) return { ...this.cam, vx: 0, vy: 0, rotX: 0, rotY: 0, beatPulse: 0 };
    if (this.currentGroupId !== group.id) this.planGroupTrack(group);

    const timeSec = audioTimeMs / 1000;
    const groupProgress = Math.min(Math.max((audioTimeMs - this.trackStart) / this.trackDuration, 0), 1);
    const sample = this.track.sample(groupProgress) || { x: 0, y: 0, z: 0, scale: 1, rotation: 0 };

    // ★ 节拍包络：句组时长为节拍窗口 + 能量调制的指数衰减（慢歌拍点稀、衰减缓 → 顿挫感弱）
    const groupDurSec = Math.max((this.trackDuration || 1000) / 1000, 1);
    const energy = clamp(this.intensity, 0.25, 1);
    this.beatEnv = beatEnvelopeAt(timeSec, groupDurSec * 0.5, energy);
    const beat = this.beatEnv;

    const motor = this._motorOffset(easeInOut(groupProgress), timeSec);

    // 组间衔接混合（Level 2：旧轨道终点 → 新轨道起点）
    let blend = 1;
    if (this.transition) {
      const tt = (now - this.transition.t0) / this.transition.dur;
      if (tt >= 1) this.transition = null;
      else {
        const e = easeInOut(tt);
        sample.x = lerp(this.transition.from.x, sample.x, e);
        sample.y = lerp(this.transition.from.y, sample.y, e);
        sample.z = lerp(this.transition.from.z, sample.z, e);
        sample.scale = lerp(this.transition.from.scale, sample.scale, e);
        sample.rotation = lerp(this.transition.from.rotation, sample.rotation, e);
        blend = e;
      }
    }

    // ★ 焦点光标（二级平滑）：镜头不直接追词块中心，而追一个缓慢漂移的光标——换词时光标平滑滑过去，
    //   消除"换词甩镜/顿挫"。距离自适应：远目标跟得快（但封顶），近目标精细慢跟。
    let tX = 0, tY = 0;
    if (!this.focus) this.focus = { x: 0, y: 0 };
    if (focusTarget && focusTarget.worldX !== undefined) {
      const fdx = focusTarget.worldX - this.focus.x;
      const fdy = focusTarget.worldY - this.focus.y;
      const fdist = Math.hypot(fdx, fdy);
      const kFollow = clamp(fdist * 0.0022, 0.05, 0.17);
      this.focus.x += fdx * Math.min(kFollow, 1);
      this.focus.y += fdy * Math.min(kFollow, 1);
    }
    // ★ 焦点 + 轨道漫游加权混合：跟焦点 82% + 镜头自身漫游 18% → 摄像机持续缓慢移动但不顿
    const mox = motor.x || 0, moy = motor.y || 0;
    tX = this.focus.x * 0.82 + (sample.x + mox) * 0.18;
    tY = this.focus.y * 0.82 + (sample.y + moy) * 0.18;
    // ★ 视口边界钳制：焦点词始终留在画面安全区（滑动运镜不会把在唱的词推出可视范围）
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 720;
    tX = clamp(tX, -vw * 0.42, vw * 0.42);
    tY = clamp(tY, -vh * 0.4, vh * 0.4);

    const breath = 1 + Math.sin(timeSec * 0.9) * 0.01 * this.intensity;
    // ★ 节拍缩放脉冲 + 低频微震（～1.8Hz 平滑推震，取代高频 60Hz 抖动 → 换词不再顿挫刺眼）
    const beatPulse = beat * this.intensity * 0.5;
    const shakeX = beat > 0.45 ? Math.sin(timeSec * 11.3) * 1.6 * beat * this.intensity : 0;
    const shakeY = beat > 0.45 ? Math.cos(timeSec * 9.7) * 1.2 * beat * this.intensity : 0;

    const target = {
      x: tX + shakeX,
      y: tY + shakeY,
      z: (sample.z || 0) + (motor.z || 0),
      scale: sample.scale * breath * (1 + beatPulse * 0.035),
      rotZ: (sample.rotation || 0) + (motor.rotZ || 0) + Math.sin(timeSec * 0.55) * 1.2 * this.intensity,
      rotX: motor.rotX || 0,
      rotY: (motor.rotY || 0) + Math.sin(timeSec * 0.4) * 1.6 * this.intensity
    };

    // 支柱 A：弹簧-速度积分趋近目标（位移与速度永远连续，低增益防反馈振荡）
    const cam = this.cam;
    const k = this.spring * 60 * Math.max(blend, 0.25);
    cam.vx += (target.x - cam.x) * k;
    cam.vy += (target.y - cam.y) * k;
    const fr = Math.pow(this.friction, 60 / 60);
    cam.vx *= fr; cam.vy *= fr;
    cam.x += cam.vx * this.speedMultiplier;
    cam.y += cam.vy * this.speedMultiplier;
    cam.z += (target.z - cam.z) * 0.035 * this.speedMultiplier;
    cam.scale += (target.scale - cam.scale) * 0.05;
    cam.rotZ += (target.rotZ - cam.rotZ) * 0.045;
    cam.rotX += (target.rotX - cam.rotX) * 0.05;
    cam.rotY += (target.rotY - cam.rotY) * 0.05;

    this.velocity = { vx: cam.vx, vy: cam.vy };
    return { x: cam.x, y: cam.y, z: cam.z, scale: Math.min(cam.scale, 1.16), rotX: cam.rotX, rotY: cam.rotY, rotZ: cam.rotZ, vx: cam.vx, vy: cam.vy, beatPulse };
  }

  reset() {
    this.cam = { x: 0, y: 0, z: 0, scale: 1, rotZ: 0, rotX: 0, rotY: 0, vx: 0, vy: 0 };
    this.focus = null;
    this.currentGroupId = -1;
    this.track = null;
    this.transition = null;
    this.beatEnv = 0;
  }
}
