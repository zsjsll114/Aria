/* ============================================================
 * tests/js/test_prism_transition.js — 「棱镜 · Prism」切镜性能决策单测
 *
 * 钉两个卡顿根因的修复决策（纯函数，无 DOM）：
 *   ① 预热阈值从 0.25 降到 0.12：seek/情绪词到达后更早热下一镜排版，
 *      杜绝 5 轮 measureText 落在切换帧。
 *   ② 转场旧镜底板「首帧冻结、后续复用」：旧镜正在滑出淡出，内部字素
 *      动画冻结看不出，但省掉每帧第二份全屏底板栅格化 + 共享画布交替
 *      覆写引发的 GPU 纹理重传。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    PREWARM_PROGRESS,
    shouldPrewarmNextShot,
    shouldFreezeOutgoingPlate,
    canReuseFrozenPlate,
} from '../../web/src/core/visualizers/prism/prismTransition.js';

test('T1 预热阈值降到 0.12（旧 0.25 会让 0.13 漏热）', () => {
    assert.equal(PREWARM_PROGRESS, 0.12);
    assert.equal(shouldPrewarmNextShot(0), false);
    assert.equal(shouldPrewarmNextShot(0.10), false);
    assert.equal(shouldPrewarmNextShot(0.13), true, '0.13 必须预热（旧阈值 0.25 会漏）');
    assert.equal(shouldPrewarmNextShot(0.25), true);
    assert.equal(shouldPrewarmNextShot(1), true);
});

test('T2 转场首帧冻结旧镜底板（冻结索引尚未等于旧镜）', () => {
    assert.equal(shouldFreezeOutgoingPlate(3, -1, 0.0), true, '进入转场第一帧必须冻结');
    assert.equal(shouldFreezeOutgoingPlate(3, 2, 0.2), true, '冻结的是别的镜，要重冻');
});

test('T3 已冻结则不再重栅格化（同镜复用）', () => {
    assert.equal(shouldFreezeOutgoingPlate(3, 3, 0.5), false, '同镜已冻结，禁止重栅格化');
    assert.equal(canReuseFrozenPlate(3, 3, 0.5), true, '同镜转场中直接复用冻结纹理');
    assert.equal(canReuseFrozenPlate(3, -1, 0.0), false, '还没冻结不能复用');
});

test('T4 转场结束（tp>=1）既不冻结也不复用', () => {
    assert.equal(shouldFreezeOutgoingPlate(3, -1, 1), false);
    assert.equal(canReuseFrozenPlate(3, 3, 1), false);
    assert.equal(shouldFreezeOutgoingPlate(3, 3, 1.2), false);
});