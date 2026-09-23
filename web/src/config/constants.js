/** config/constants.js — 全局常量 & Storage Keys */

// API 接口
export const API_BASE = 'https://api.vkeys.cn/v2/music';
export const OIAPI_LYRIC_BASE = 'https://www.oiapi.net/api/QQMusicLyric';

// Storage Keys
export const FAV_STORAGE_KEY = 'lyrics_player_favorites';
export const PLAYLIST_STORAGE_KEY = 'lyrics_player_playlists';
export const SETTINGS_STORAGE_KEY = 'lyrics_player_settings';
export const EQ_STORAGE_KEY = 'lyrics_player_eq';
export const PERF_STORAGE_KEY = 'lyrics_player_performance';

// 均衡器
export const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_LABELS = ['32', '64', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
export const EQ_PRESETS = {
    '默认':   [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    '流行':   [-1, 2, 4, 4, 1, -1, -1, -1, 1, 2],
    '摇滚':   [5, 3, -1, -2, -1, 2, 4, 5, 5, 5],
    '爵士':   [3, 2, 1, 2, -1, -1, 0, 1, 2, 3],
    '古典':   [4, 3, 2, 0, -1, -1, 0, 2, 3, 4],
    '电子':   [5, 4, 1, 0, -2, 2, 1, 1, 4, 5],
    '轻音乐': [2, 1, 0, -1, -1, 1, 2, 2, 1, 0],
    '人声':   [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1],
    '重低音': [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
    '金属':   [4, 3, 0, -2, -3, -1, 2, 4, 5, 5]
};

// 歌词虚拟滚动
export const LYRICS_VIRTUAL_SCROLL = {
    enabled: true,
    renderRange: 25,
    lineHeight: 60
};

// AI IndexedDB
export const AI_DB_NAME = 'LyricsPlayerDB';
// ★ v4：aiCache.js 成为该库唯一属主，upgrade 幂等补齐 aiThemeCache+chorusCache 双 store。
//   v3 时代曾出现「双 getAiDb 竞争建库导致 chorusCache 缺失」——提升版本强制触发 onupgradeneeded，
//   让存量（可能缺 store 的）库就地补齐，避免运行时 db.transaction('chorusCache') 抛 NotFoundError。
export const AI_DB_VERSION = 4;
export const AI_STORE_NAME = 'aiThemeCache';

// 字体 IndexedDB
export const FONT_DB_NAME = 'lyrics_player_fonts';
export const FONT_STORE = 'fonts';

// AI API Providers
export const AI_API_DEFAULT_BASE = 'https://api.openai.com/v1';
export const AI_PROVIDERS = {
    openai: {
        name: 'OpenAI',
        defaultBase: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o-mini',
        models: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo', 'o1-mini'],
        keyPlaceholder: 'sk-...',
        baseDesc: 'OpenAI API 地址',
        modelDesc: '推荐 gpt-4o-mini，极速、准确且性价比极高'
    },
    deepseek: {
        name: 'DeepSeek (深度求索)',
        defaultBase: 'https://api.deepseek.com',
        defaultModel: 'deepseek-chat',
        models: ['deepseek-chat', 'deepseek-reasoner'],
        keyPlaceholder: 'sk-...',
        baseDesc: 'DeepSeek 官方 API 地址（留空默认官方）',
        modelDesc: '推荐 deepseek-chat (V3)，中文歌词理解极强'
    },
    gemini: {
        name: 'Google Gemini',
        defaultBase: 'https://zsjsll-cf.de5.net',
        defaultModel: 'gemini-3.5-flash-lite',
        models: ['gemini-3.5-flash-lite', 'gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-1.5-pro'],
        keyPlaceholder: 'AIza...',
        baseDesc: 'Gemini API 代理或官方接口（默认反代: https://zsjsll-cf.de5.net）',
        modelDesc: '推荐 gemini-3.5-flash-lite，生成效果佳，速度快'
    },
    openrouter: {
        name: 'OpenRouter (聚合网关)',
        defaultBase: 'https://openrouter.ai/api/v1',
        defaultModel: 'google/gemini-2.0-flash-exp:free',
        models: [
            'google/gemini-2.0-flash-exp:free',
            'deepseek/deepseek-r1',
            'deepseek/deepseek-chat',
            'meta-llama/llama-3.3-70b-instruct',
            'anthropic/claude-3.5-sonnet',
            'openai/gpt-4o-mini'
        ],
        keyPlaceholder: 'sk-or-v1-...',
        baseDesc: 'OpenRouter 全球模型聚合网关',
        modelDesc: '支持多种免费与付费前沿模型免魔法调用'
    },
    'z-ai': {
        name: '智谱 AI (GLM / Z-AI)',
        defaultBase: 'https://open.bigmodel.cn/api/paas/v4',
        defaultModel: 'glm-4-flash',
        models: ['glm-4-flash', 'glm-4-plus', 'glm-4-air', 'glm-4-long'],
        keyPlaceholder: 'xxx.yyy...',
        baseDesc: '智谱开放平台 API 接口地址',
        modelDesc: '推荐 glm-4-flash，免费调用且速度极快'
    },
    aliyun: {
        name: '阿里云百炼 (通义千问 / Qwen)',
        defaultBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        defaultModel: 'qwen-plus',
        models: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen2.5-72b-instruct'],
        keyPlaceholder: 'sk-...',
        baseDesc: '阿里云百炼 DashScope 兼容接口地址',
        modelDesc: '推荐 qwen-plus，中文文学与歌词情绪分析极佳'
    },
    minimax: {
        name: 'MiniMax / 海螺',
        defaultBase: 'https://api.minimax.chat/v1',
        defaultModel: 'MiniMax-Text-01',
        models: ['MiniMax-Text-01', 'abab6.5s-chat', 'abab6.5g-chat'],
        keyPlaceholder: 'eyJhbG...',
        baseDesc: 'MiniMax 官方开放平台 API 接口',
        modelDesc: '推荐 MiniMax-Text-01，大语言模型理解力强'
    },
    hunyuan: {
        name: '腾讯混元 (Hunyuan)',
        defaultBase: 'https://api.hunyuan.cloud.tencent.com/v1',
        defaultModel: 'hunyuan-standard',
        models: ['hunyuan-standard', 'hunyuan-pro', 'hunyuan-lite', 'hunyuan-turbo'],
        keyPlaceholder: 'sk-...',
        baseDesc: '腾讯混元大模型兼容接口地址',
        modelDesc: '推荐 hunyuan-standard，响应稳定速度快'
    },
    nvidia: {
        name: 'NVIDIA NIM',
        defaultBase: 'https://integrate.api.nvidia.com/v1',
        defaultModel: 'meta/llama-3.3-70b-instruct',
        models: [
            'meta/llama-3.3-70b-instruct',
            'deepseek-ai/deepseek-r1',
            'nvidia/llama-3.1-nemotron-70b-instruct',
            'mistralai/mistral-large-2-instruct'
        ],
        keyPlaceholder: 'nvapi-...',
        baseDesc: 'NVIDIA NIM 大模型托管接口',
        modelDesc: 'NVIDIA 官方开源模型推理加速'
    },
    custom: {
        name: '自定义 (OpenAI 兼容)',
        defaultBase: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o-mini',
        models: ['gpt-4o-mini', 'gpt-4o', 'claude-3-5-sonnet-20241022', 'deepseek-chat'],
        keyPlaceholder: 'sk-...',
        baseDesc: '任何支持 /v1/chat/completions 的自定义 API 地址',
        modelDesc: '可手动输入任何兼容的模型名称'
    }
};
