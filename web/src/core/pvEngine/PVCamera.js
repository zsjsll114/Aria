/**
 * PVCamera.js
 * 3D 复合景深电影级平滑缓动摄像机 (融合 上游参考项目 镜台 Diorama 长镜头运镜精髓)
 * ★ 采用 Unity 式临界阻尼 SmoothDamp（diorama cameraPath.ts 同款）：
 *   带速度、进出都平滑——目标步进(切场景/切词)时是"加速→落位"的圆滑过程，
 *   不再是指数 lerp 的"开始最快、只减速"(snap then coast) kink。
 */

export class PVCamera {
  constructor() {
    this.target = { x: 0, y: 0, z: 0, pitch: 0, roll: 0, scale: 1.0 };
    this.current = { x: 0, y: 0, z: 0, pitch: 0, roll: 0, scale: 1.0 };
    /* ★ 每轴速度（smoothDamp 状态，调用方持有） */
    this._velocity = { x: 0, y: 0, z: 0, pitch: 0, roll: 0, scale: 0 };
    /* ★ 平滑时间常数（秒）：与原 damping 语义对齐，默认 0.42s。
       用户反馈：1.2s 运镜太拖沓，tanh 饱和跟焦虽对但速度慢 → 收紧到 0.42s
       （临界阻尼无 overshoot，切场景/跟长行都能快速落位又保持圆滑） */
    this.smoothTime = 0.42;
    this.shakeOffsetX = 0;
    this.shakeOffsetY = 0;
    this.speedMultiplier = 1.0;
  }

  /**
   * 设定摄像机目标状态
   */
  setTarget(x = 0, y = 0, scale = 1.0, z = 0, pitch = 0, roll = 0) {
    this.target.x = x;
    this.target.y = y;
    this.target.scale = scale;
    this.target.z = z;
    this.target.pitch = pitch;
    this.target.roll = roll;
  }

  /**
   * 逐帧平滑插值计算（diorama smoothDamp：临界阻尼、无 overshoot、无 kink）
   * @param {number} [dtSec] 帧间隔秒数（缺省 1/60）
   */
  update(dtSec = 0) {
    const dt = dtSec > 0 ? Math.min(dtSec, 0.1) : 1 / 60;
    /* speedMultiplier：越大越跟得快 → smoothTime 越小 */
    const st = Math.max(0.05, this.smoothTime / Math.max(this.speedMultiplier, 0.2));

    const dampAxis = (key, timeScale = 1) => {
      const s = Math.max(0.05, st * timeScale);
      const om = 2 / s;
      const xx = om * dt;
      const e = 1 / (1 + xx + 0.48 * xx * xx + 0.235 * xx * xx * xx);
      const change = this.current[key] - this.target[key];
      const temp = (this._velocity[key] + om * change) * dt;
      this._velocity[key] = (this._velocity[key] - om * temp) * e;
      this.current[key] = this.target[key] + (change + temp) * e;
    };

    dampAxis('x');
    dampAxis('y');
    dampAxis('z');
    dampAxis('pitch');
    dampAxis('roll');
    /* 缩放沿用原"略慢"语义（时间常数 ×1.18） */
    dampAxis('scale', 1 / 0.85);
  }

  /**
   * 生成各图层专用的 3D 视差变换矩阵字符串
   */
  getTransform(parallax = 1.0, enable3D = true) {
    const px = Math.round((-this.current.x * parallax + this.shakeOffsetX) * 100) / 100;
    const py = Math.round((-this.current.y * parallax + this.shakeOffsetY) * 100) / 100;
    const pz = Math.round(-this.current.z * parallax * 10) / 10;

    const scaleFactor = 1.0 + (this.current.scale - 1.0) * parallax;
    const s = Math.round(scaleFactor * 1000) / 1000;

    if (enable3D && Math.abs(this.current.pitch) > 0.02) {
      const pitch = Math.round(this.current.pitch * parallax * 100) / 100;
      const roll = Math.round(this.current.roll * parallax * 100) / 100;
      return `translate3d(${px}px, ${py}px, ${pz}px) rotateX(${pitch}deg) rotateZ(${roll}deg) scale(${s})`;
    }

    return `translate3d(${px}px, ${py}px, ${pz}px) scale(${s})`;
  }

  /**
   * 设置阻尼系数（旧 API 兼容：0.005~0.06 → 平滑时间 3.33s~0.28s）
   */
  setDamping(dampingVal) {
    if (typeof dampingVal === 'number' && !isNaN(dampingVal)) {
      const d = Math.min(Math.max(dampingVal, 0.005), 0.06);
      this.smoothTime = 1 / (d * 60);
    }
  }

  /**
   * 重置摄像机至初始中心
   */
  reset() {
    this.target = { x: 0, y: 0, z: 0, pitch: 0, roll: 0, scale: 1.0 };
    this.current = { x: 0, y: 0, z: 0, pitch: 0, roll: 0, scale: 1.0 };
    this._velocity = { x: 0, y: 0, z: 0, pitch: 0, roll: 0, scale: 0 };
    this.shakeOffsetX = 0;
    this.shakeOffsetY = 0;
  }

  /**
   * 触发重拍微弱震屏
   */
  impulse(intensity = 3) {
    this.shakeOffsetX = (Math.random() - 0.5) * intensity * 2;
    this.shakeOffsetY = (Math.random() - 0.5) * intensity * 2;
    setTimeout(() => {
      this.shakeOffsetX = 0;
      this.shakeOffsetY = 0;
    }, 120);
  }
}
