/**
 * DimensionCamera.js
 * 3D 真实空间多维平滑阻尼摄像机控制器
 * 支持 3D 位置 (X, Y, Z) 与 3D 欧拉角 (Pitch, Yaw, Roll)
 */

export class DimensionCamera {
    constructor() {
        this.pos = { x: 0, y: 0, z: 0 };
        this.targetPos = { x: 0, y: 0, z: 0 };
        this.rot = { x: 0, y: 0, z: 0 }; // x: pitch, y: yaw, z: roll (in degrees)
        this.targetRot = { x: 0, y: 0, z: 0 };
        this.damping = 0.08; // 平滑阻尼系数
        this.shake = { x: 0, y: 0 };
    }

    setTarget(x, y, z = 0, rx = 0, ry = 0, rz = 0) {
        this.targetPos.x = x;
        this.targetPos.y = y;
        this.targetPos.z = z;
        this.targetRot.x = rx;
        this.targetRot.y = ry;
        this.targetRot.z = rz;
    }

    addImpulse(energy = 0.5) {
        this.shake.x += (Math.random() - 0.5) * 6 * energy;
        this.shake.y += (Math.random() - 0.5) * 6 * energy;
    }

    update(dt = 0.016) {
        // 缓动追踪目标位置
        this.pos.x += (this.targetPos.x - this.pos.x) * this.damping;
        this.pos.y += (this.targetPos.y - this.pos.y) * this.damping;
        this.pos.z += (this.targetPos.z - this.pos.z) * this.damping;

        // 缓动追踪旋转角度 (Pitch, Yaw, Roll)
        this.rot.x += (this.targetRot.x - this.rot.x) * this.damping;
        this.rot.y += (this.targetRot.y - this.rot.y) * this.damping;
        this.rot.z += (this.targetRot.z - this.rot.z) * this.damping;

        // 震颤衰减
        this.shake.x *= 0.88;
        this.shake.y *= 0.88;
    }

    /**
     * 生成作用于 3D 场景根节点的逆向摄像机变换矩阵
     * 顺序：Roll(Z) -> Pitch(X) -> Yaw(Y) -> Translate(-X, -Y, -Z)
     */
    getViewMatrixTransform() {
        const px = this.pos.x + this.shake.x;
        const py = this.pos.y + this.shake.y;
        const pz = this.pos.z;

        const rx = this.rot.x;
        const ry = this.rot.y;
        const rz = this.rot.z;

        return `rotateZ(${(-rz).toFixed(2)}deg) rotateX(${(-rx).toFixed(2)}deg) rotateY(${(-ry).toFixed(2)}deg) translate3d(${(-px).toFixed(2)}px, ${(-py).toFixed(2)}px, ${(-pz).toFixed(2)}px)`;
    }
}
