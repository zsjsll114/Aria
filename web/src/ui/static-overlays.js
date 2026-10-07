/* ============================================================
 * ui/static-overlays.js — 静态骨架浮层的可访问性收编（P3-b）
 *
 * 背景（P3 调研实测）：web/index.html 里有 28 个静态骨架浮层，靠
 * `classList.add('visible')` 显隐。它们的 ESC 由各分片自行处理，但
 * **可访问性语义几乎全缺** —— 全仓 role="dialog" 只有 1/28 是手写的
 * （#sleepTimerOverlay，本模块以它为格式基准）。屏幕阅读器把整页当普通
 * 内容读，用户根本不知道"现在打开了一个对话框"。
 *
 * ★ 本模块只做**纯增量**的属性收编：role / aria-modal / aria-labelledby /
 *   tabindex / 一个公开标记类。不改显隐逻辑、不改 ESC、不动焦点。
 *   理由：那些要改就得逐层改各分片的开闭函数（每层的关闭都带自己的收尾，
 *   例如 165 要停录音、200 要 pausePreview），风险与收益不对等。
 *   ESC 现状与缺口清单见 tests/js/test_static_overlay_adoption.js 的注释。
 *
 * ★ 为什么不收编 #ctxMenu 与 #aiStatusPanel：见 OVERLAY_EXCLUSIONS 的 note。
 *
 * ★ 幂等：可重复调用；已存在的 role / aria-labelledby 一律不覆盖。
 *
 * ★ 三个无标题元素可用的浮层（搜索 / 听歌识曲 / 自选收藏）**不编造可访问名**：
 *   编造就得新增中文串并进 i18n 词表，而且 i18n 扫描器不翻译 aria-label
 *   （它只翻文本节点 / placeholder / title），英文模式下会留下中文无障碍名——
 *   比"没有名字"更糟。这三个的真实标题应由各自分片补（P3-b step 2）。
 * ============================================================ */

/** 逐个浮层的登记表。panel 为 null 表示根元素本身就是面板。 */
export const STATIC_OVERLAYS = [
    /* ── .search-overlay 家族（13） ── */
    { root: '#searchOverlay', panel: '.search-modal', title: null },
    { root: '#audioRecognizeOverlay', panel: '.audio-recognize-modal', title: null },
    { root: '#favoritesOverlay', panel: '.search-modal', title: '.favorites-title' },
    { root: '#playlistsOverlay', panel: '.search-modal', title: '.favorites-title' },
    { root: '#addToPlaylistOverlay', panel: '.search-modal', title: '.favorites-title' },
    { root: '#importPlaylistOverlay', panel: '.import-modal', title: '.favorites-title' },
    { root: '#createPlaylistModalOverlay', panel: '.import-modal', title: '.favorites-title' },
    { root: '#rankingsOverlay', panel: '.search-modal', title: '#rankPageTitle' },
    { root: '#artistOverlay', panel: '.artist-modal', title: '#artistPageTitle' },
    { root: '#selfFavOverlay', panel: '.search-modal', title: null },
    { root: '#recentOverlay', panel: '.search-modal', title: '#recentOverlayTitle' },
    { root: '#statsOverlay', panel: '.search-modal', title: '#statsTitle' },
    { root: '#sleepTimerOverlay', panel: '.sleep-timer-panel', title: '#sleepTimerTitleText' },
    /* ── .lyric-source-overlay 家族（5） ── */
    { root: '#selfhostQrOverlay', panel: '.lyric-source-panel', title: '#selfhostQrTitle' },
    { root: '#lyricSourceOverlay', panel: '.lyric-source-panel', title: '.lyric-source-title' },
    { root: '#playSourceOverlay', panel: '.lyric-source-panel', title: '.lyric-source-title' },
    { root: '#diagnosticsOverlay', panel: '.lyric-source-panel', title: '#diagTitle' },
    { root: '#lyricDownloadOverlay', panel: '.lyric-source-panel', title: '.lyric-source-title' },
    /* ── 其它模态（8） ── */
    { root: '#settingsOverlay', panel: '.settings-panel', title: '.settings-title' },
    { root: '#colorPickerOverlay', panel: '.color-picker-panel', title: '#colorPickerTitleText' },
    { root: '#viewModeOverlay', panel: '.view-mode-modal', title: '.view-mode-title' },
    { root: '#aiModelsOverlay', panel: '.ai-models-modal', title: '.ai-models-title' },
    { root: '#aiTestResultOverlay', panel: '.ai-models-modal', title: '#aiTestModalTitle' },
    { root: '#eqPanel', panel: null, title: '#eqTitle' },
    { root: '#plmPanel', panel: null, title: '.plm-title' },
    { root: '#welcomeOverlay', panel: '.welcome-card', title: '.welcome-title' },
];

/**
 * 显式排除的浮层。必须给出 reason 与 note —— 宁可写清"为什么不管"，
 * 也不要静默漏掉一个浮层（P3-b 的棘轮测试会检查登记表与 index.html 覆盖一致）。
 */
export const OVERLAY_EXCLUSIONS = [
    {
        root: '#ctxMenu',
        reason: 'menu',
        note: '右键菜单：正确语义是 role="menu" + 子项 role="menuitem"（还涉及 roving tabindex），标成 dialog 反而更错 —— 单独一轮做',
    },
    {
        root: '#aiStatusPanel',
        reason: 'status',
        note: '信息性浮动面板（AI 分析进度），不是模态；标 aria-modal="true" 会错误地告诉辅助技术"其余内容不可用"',
    },
];

/** 收编后的面板标记类（公开契约，供诊断与测试查询） */
export const STATIC_MODAL_CLASS = 'aria-static-modal';

/**
 * 给静态浮层补可访问性语义。幂等。
 * @param {Document} [doc]
 * @returns {{adopted: string[], missing: string[], labelled: number}}
 */
export function adoptStaticOverlays(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    const adopted = [];
    const missing = [];
    let labelled = 0;
    if (!d || typeof d.querySelector !== 'function') {
        return { adopted, missing, labelled };
    }

    STATIC_OVERLAYS.forEach((spec, i) => {
        const root = d.querySelector(spec.root);
        if (!root) {
            missing.push(spec.root);
            return;
        }
        const panel = spec.panel ? root.querySelector(spec.panel) : root;
        if (!panel) {
            missing.push(spec.root + ' ' + spec.panel);
            return;
        }

        panel.classList.add(STATIC_MODAL_CLASS);
        /* 已手写的语义不覆盖：#sleepTimerOverlay 是格式基准 */
        if (!panel.hasAttribute('role')) panel.setAttribute('role', 'dialog');
        if (!panel.hasAttribute('aria-modal')) panel.setAttribute('aria-modal', 'true');
        if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');

        if (!panel.hasAttribute('aria-labelledby') && spec.title) {
            const t = spec.title ? root.querySelector(spec.title) : null;
            if (t) {
                if (!t.id) t.id = 'aria-static-title-' + (i + 1);
                panel.setAttribute('aria-labelledby', t.id);
                labelled++;
            }
        } else if (panel.hasAttribute('aria-labelledby')) {
            labelled++;
        }

        adopted.push(spec.root);
    });

    return { adopted, missing, labelled };
}
