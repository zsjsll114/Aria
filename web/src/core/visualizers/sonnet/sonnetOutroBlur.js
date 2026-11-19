/* Portions ported from chthollyphile/folia-major (AGPL-3.0) — Copyright (c) chthollyphile and contributors. See THIRD_PARTY_NOTICES.md */
// 移植自 scratch/folia-fresh/src/components/visualizer/sonnet/sonnetOutroBlur.ts
// 逐行保真机械移植：仅删除类型标注，不改任何逻辑/数值/分支。
//
// 集成约定：上游写 `filter.strength = strength`，本仓 Pixi 是 v8 且既有写法用
// `blurFilter.blur`（见 SonnetEngine 的转场 blurFilter），v8 里二者是同一强度的别名——
// 此处随本仓既有写法，数值语义一致。

// src/components/visualizer/sonnet/sonnetOutroBlur.ts
// 片尾模糊：片尾海报升起时给最后一段场景挂一个 BlurFilter，强度随片尾帧变化；回到 0 或换场景时摘下销毁。
export class SonnetOutroBlur {
    constructor(pixi) {
        this.pixi = pixi;
        this.filter = null;
        this.scene = null;
    }

    /** Whether the blur is currently attached to `scene`. */
    isOn(scene) {
        return this.scene === scene;
    }

    clear() {
        if (this.filter && this.scene) {
            this.scene.container.filters = (this.scene.container.filters ?? [])
                .filter(filter => filter !== this.filter);
            this.filter.destroy();
        }
        this.filter = null;
        this.scene = null;
    }

    update(scene, strength) {
        if (strength <= 0) {
            this.clear();
            return;
        }
        if (this.scene !== scene) this.clear();
        if (!this.filter) {
            this.filter = new this.pixi.BlurFilter({
                strength: 0,
                quality: 2,
                kernelSize: 5,
                resolution: 0.75,
            });
            // Shares the scene's filter chain with the post-process vignette, so its padding would
            // grow the shared render frame and drift the vignette outward as the outro blur ramps.
            this.filter.repeatEdgePixels = true;
            scene.container.filters = [...(scene.container.filters ?? []), this.filter];
            this.scene = scene;
        }
        this.filter.blur = strength;
    }
}
