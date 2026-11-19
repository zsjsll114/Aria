/* ============================================================
 * prismTransition.js — 「棱镜 · Prism」切镜性能决策（纯函数，无 DOM）
 *
 * 切镜卡顿的两个根因与对策：
 *   ① 文字底板每帧全量重栅格化（字素 singFrac 持续动画，无法按镜缓存），
 *      转场时新旧两镜各栅格化一遍共享底板 → 每帧 2× 工作量，且共享画布
 *      被交替覆写，每次切面 blit 都触发 GPU 纹理重传。
 *      对策：旧镜正在滑出淡出，其底板在转场首帧冻结到独立画布一次，
 *      后续帧只 blit 冻结纹理（稳定纹理只上传一次），新镜用另一块缓冲
 *      live 渲染。栅格化减半、纹理不再交替重传。
 *   ② 预热只在进度 >0.25 触发且只热排版，seek/情绪词到达/resize 清缓存后
 *      5 轮 measureText 落在切换帧。对策：阈值降到 0.12 并主动补热。
 * ============================================================ */

/** 预热下一镜排版的进度阈值（旧值 0.25 太晚，seek 后容易漏热）。 */
export const PREWARM_PROGRESS = 0.12;

/**
 * 当前镜推进超过阈值就预热下一镜的几何与排版缓存。
 * @param {number} activeProgress 当前镜进度 0~1
 * @returns {boolean}
 */
export function shouldPrewarmNextShot(activeProgress) {
    return Number(activeProgress) > PREWARM_PROGRESS;
}

/**
 * 转场首帧需要把旧镜底板冻结到独立画布（冻结索引还指向别的镜）。
 * @param {number} prevShotIndex 旧镜索引
 * @param {number} frozenShotIndex 当前冻结画布持有的镜索引（-1 = 空）
 * @param {number} transitionProgress 转场进度 0~1
 * @returns {boolean}
 */
export function shouldFreezeOutgoingPlate(prevShotIndex, frozenShotIndex, transitionProgress) {
    return transitionProgress < 1 && prevShotIndex !== frozenShotIndex;
}

/**
 * 旧镜底板已冻结且转场仍在进行 → 直接复用冻结纹理，跳过重栅格化。
 * @param {number} prevShotIndex
 * @param {number} frozenShotIndex
 * @param {number} transitionProgress
 * @returns {boolean}
 */
export function canReuseFrozenPlate(prevShotIndex, frozenShotIndex, transitionProgress) {
    return transitionProgress < 1 && prevShotIndex === frozenShotIndex;
}