/**
 * config/performance.js — 性能分档唯一事实源
 *
 * 来历：本文件曾长期是一份只到 animation 字段的旧快照，而真正被消费的定义
 * 长在 10-config-state.js 里，两边已经漂移（medium.glassStrength 30 vs 25、
 * low.blurLevel 3 vs 0、low.compactMode true vs false…）。改这份不生效，
 * 改那份又散在状态分片里，所以把存活值整体搬进来、由 10-config-state 反向 import。
 *
 * 值以迁移前 10-config-state.js 的字面量为准（行为零变化）；要调分档只改这里。
 * 消费方：180-boot-config（自动检测后套用）、220-shortcuts-viewmode（性能设置页展示）、
 * VisualizerManager.applyPerformanceProfile、PV/隧道/词云等引擎按档降级。
 */
export const PERFORMANCE_PROFILES = {
    high: {
        name: '高性能',
        description: '流畅运行所有视效与全量特效',
        background: { dynamicBg: true, swayEnabled: true, swayAmp: 12, swayDuration: 16, blur: 60 },
        lyrics: { blurLevel: 8, showTranslation: true, showRomaji: true },
        interface: { glassStrength: 40, compactMode: false },
        animation: { crossfadeDuration: 800, colorExtract: true },
        flyin: { maxActiveBlocks: 16, enableGlow: true, enable3DDepth: true, blurFx: true },
        wordcloud: { maxParticles: 60, updateIntervalMs: 16, enableRandomDrift: true },
        floating: { parallaxLayers: 5, precisionSample: 'high' },
        pv: { renderDpr: 1.25, maxParticles: 120, enableBloom: true, bufferCleanupMs: 15000 },
        /* ★ 流光隧道 / 浮空（原分档缺失，现补齐，供各引擎全量消费） */
        tunnel: { particleCount: 60, depthDpr: 2, decorLevel: 3, dofEnabled: true, animBlur: true },
        dimension: { particleScale: 1, shadowEnabled: true, canvasDpr: 2, bgLayers: 3 },
        /* ★ 全局视觉效果模糊/粒子矩阵：各模式共享的降级开关，供设置项手动调整与 CSS/引擎读取 */
        vfx: { renderScale: 1, coverBlur: 60, glassBlur: 40, lyricBlur: 8, textBlur: 6, pvBloom: true, flyinGlow: true, wcParticles: true, tunnelParticles: true, dimParticles: true },
        memory: { maxProbeCache: 50, aggressiveGC: false }
    },
    medium: {
        name: '中性能',
        description: '平衡画质与流畅度，适中资源占用',
        background: { dynamicBg: true, swayEnabled: true, swayAmp: 8, swayDuration: 20, blur: 40 },
        lyrics: { blurLevel: 5, showTranslation: true, showRomaji: true },
        interface: { glassStrength: 25, compactMode: false },
        animation: { crossfadeDuration: 500, colorExtract: true },
        flyin: { maxActiveBlocks: 10, enableGlow: true, enable3DDepth: false, blurFx: true },
        wordcloud: { maxParticles: 40, updateIntervalMs: 33, enableRandomDrift: true },
        floating: { parallaxLayers: 3, precisionSample: 'medium' },
        pv: { renderDpr: 1.0, maxParticles: 60, enableBloom: false, bufferCleanupMs: 10000 },
        tunnel: { particleCount: 40, depthDpr: 1.5, decorLevel: 2, dofEnabled: true, animBlur: true },
        dimension: { particleScale: 0.8, shadowEnabled: false, canvasDpr: 1.5, bgLayers: 2 },
        vfx: { renderScale: 0.9, coverBlur: 40, glassBlur: 25, lyricBlur: 5, textBlur: 4, pvBloom: false, flyinGlow: true, wcParticles: true, tunnelParticles: true, dimParticles: true },
        memory: { maxProbeCache: 30, aggressiveGC: false }
    },
    low: {
        name: '低性能',
        description: '大幅降低视觉与内存开销，提升流畅度',
        background: { dynamicBg: true, swayEnabled: false, swayAmp: 0, swayDuration: 20, blur: 20 },
        lyrics: { blurLevel: 0, showTranslation: true, showRomaji: false },
        interface: { glassStrength: 15, compactMode: false },
        animation: { crossfadeDuration: 300, colorExtract: false },
        flyin: { maxActiveBlocks: 6, enableGlow: false, enable3DDepth: false, blurFx: false },
        wordcloud: { maxParticles: 20, updateIntervalMs: 60, enableRandomDrift: false },
        floating: { parallaxLayers: 2, precisionSample: 'low' },
        pv: { renderDpr: 0.75, maxParticles: 30, enableBloom: false, bufferCleanupMs: 5000 },
        tunnel: { particleCount: 20, depthDpr: 1, decorLevel: 1, dofEnabled: false, animBlur: false },
        dimension: { particleScale: 0.5, shadowEnabled: false, canvasDpr: 1, bgLayers: 1 },
        vfx: { renderScale: 0.75, coverBlur: 20, glassBlur: 12, lyricBlur: 0, textBlur: 0, pvBloom: false, flyinGlow: false, wcParticles: false, tunnelParticles: false, dimParticles: false },
        memory: { maxProbeCache: 15, aggressiveGC: true }
    },
    minimal: {
        name: '极简',
        description: '极低内存与GPU占用，专注极速播放',
        background: { dynamicBg: false, swayEnabled: false, swayAmp: 0, swayDuration: 20, blur: 0 },
        lyrics: { blurLevel: 0, showTranslation: false, showRomaji: false },
        interface: { glassStrength: 10, compactMode: true },
        animation: { crossfadeDuration: 200, colorExtract: false },
        flyin: { maxActiveBlocks: 4, enableGlow: false, enable3DDepth: false, blurFx: false },
        wordcloud: { maxParticles: 12, updateIntervalMs: 100, enableRandomDrift: false },
        floating: { parallaxLayers: 1, precisionSample: 'minimal' },
        pv: { renderDpr: 0.6, maxParticles: 10, enableBloom: false, bufferCleanupMs: 3000 },
        tunnel: { particleCount: 0, depthDpr: 1, decorLevel: 0, dofEnabled: false, animBlur: false },
        dimension: { particleScale: 0.3, shadowEnabled: false, canvasDpr: 1, bgLayers: 0 },
        vfx: { renderScale: 0.6, coverBlur: 0, glassBlur: 8, lyricBlur: 0, textBlur: 0, pvBloom: false, flyinGlow: false, wcParticles: false, tunnelParticles: false, dimParticles: false },
        memory: { maxProbeCache: 8, aggressiveGC: true }
    }
};
