/** config/performance.js — 性能等级配置 */
export const PERFORMANCE_PROFILES = {
    high: {
        name: '高性能',
        description: '流畅运行所有特效',
        background: { dynamicBg: true, swayEnabled: true, swayAmp: 12, swayDuration: 16, blur: 60 },
        lyrics: { blurLevel: 8, showTranslation: true, showRomaji: true },
        interface: { glassStrength: 40, compactMode: false },
        animation: { crossfadeDuration: 800, colorExtract: true }
    },
    medium: {
        name: '中性能',
        description: '平衡画质与性能',
        background: { dynamicBg: true, swayEnabled: true, swayAmp: 8, swayDuration: 20, blur: 40 },
        lyrics: { blurLevel: 5, showTranslation: true, showRomaji: false },
        interface: { glassStrength: 30, compactMode: false },
        animation: { crossfadeDuration: 600, colorExtract: true }
    },
    low: {
        name: '低性能',
        description: '优先保证流畅度',
        background: { dynamicBg: true, swayEnabled: false, swayAmp: 0, swayDuration: 0, blur: 20 },
        lyrics: { blurLevel: 3, showTranslation: true, showRomaji: false },
        interface: { glassStrength: 20, compactMode: true },
        animation: { crossfadeDuration: 400, colorExtract: false }
    },
    minimal: {
        name: '极简',
        description: '最低资源占用',
        background: { dynamicBg: false, swayEnabled: false, swayAmp: 0, swayDuration: 0, blur: 0 },
        lyrics: { blurLevel: 0, showTranslation: false, showRomaji: false },
        interface: { glassStrength: 10, compactMode: true },
        animation: { crossfadeDuration: 200, colorExtract: false }
    }
};
