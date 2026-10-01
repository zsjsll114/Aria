// Aria 适配：folia 的 loadPixi() 等价物——返回 vendor 化的 Pixi v8 命名空间。
// 上游从 'pixi.js' 动态加载；Aria 无构建管线，直接动态 import 本地 vendor bundle。

let pixiPromise = null;

export const loadPixi = async () => {
    if (!pixiPromise) {
        pixiPromise = import('../../../vendor/pixi/pixi.mjs');
    }
    return pixiPromise;
};
