/* index.js — 入口：按依赖优先顺序加载全部分片。
   顺序为「尽力而为」：分片之间存在交叉引用（如 135-crossfade ↔ 130-playlists ↔
   120-search-results ↔ 150-search-engine 的环），真正的装配保障是各分片内部的
   typeof 探测 + 惰性调用，而非本文件的求值顺序——改本文件顺序前务必确认被调函数
   已在运行时可访问，勿轻信「自动生成」字样。 */
import './000-aria-ns.js';  /* ★ 必须第一个：先建立 window.Aria 命名空间，其余分片再迁移 __ 工具键 */
import './000-tooltip.js';
import './005-skeleton.js';
import './006-layouts.js';
import './007-static-overlays.js';  /* 静态骨架浮层的可访问性收编：必须在 021 之前，早于任何分片操作浮层 */
import './021-aria-dialog.js';
import './10-config-state.js';
import './20-lyrics-render.js';
import './30-dom-refs.js';
import './40-playback-state.js';
import './55-wc-tuning.js';
import './56-playback-misc.js';
import './57-wordcloud-camera.js';
import './60-mobile-dual-page.js';
import './65-playback-position.js';
import './70-audio-engine.js';
import './75-play-mode.js';
import './80-context-menu.js';
import './85-rate-download.js';
import './90-eq.js';
import './95-track-loading.js';
import './100-cover-background.js';
import './101-mv-background.js';  /* MV 动态背景：搜索结果点 MV 卡片 → 铺满整窗循环播放 + 压暗/模糊 */
import './110-keyboard-nav.js';
import './120-search-results.js';
import './125-favorites.js';
import './130-playlists.js';
import './135-crossfade.js';
import './140-playlist-ui-events.js';
import './145-playlist-import.js';
import './96-automix.js';
import './245-playlist-manager.js';
import './150-search-engine.js';
import './155-random-toast-match.js';
import './157-search-history.js';
import './160-text-normalize.js';
import './165-audio-recognize.js';
import './170-lyric-sources.js';
import './175-track-index-online.js';
import './180-boot-config.js';
import './190-settings-fontsize.js';
import './200-settings-panel.js';
import './210-color-multilang.js';
import './215-multilang-fonts.js';
import './220-shortcuts-viewmode.js';
import './230-touch-gestures.js';
import './232-nowplaying-follow.js';
import './240-titlebar.js';
import './250-desktop-lyrics.js';
import './258-rankings.js';
import './259-selfhost-favorites.js';
import './275-play-source.js';
import './280-sleep-timer.js';
import './281-osd.js';
import './282-zen-mode.js';  /* 专注模式（只留歌词）：is-zen 叠加层 + 自挂载设置组 */
import './283-readability.js';
import './284-diagnostics.js';  /* 应用内诊断页（todos #21） */
import './285-bilingual-cycle.js';  /* 双语排版一键循环（todos #4） */
import './286-tempo-boost.js';  /* 长按临时加速（todos #13） */
import './287-bg-throttle.js';  /* 窗口不可见时自动轻量（todos #18） */
import './288-lyric-search.js';  /* 歌词内搜索（todos #2）：一句歌词定位到哪首歌哪一句 */
import './289-next-up.js';  /* 下一首预告 + 一键否决（todos #5）：自挂载浮层 + 自挂载设置组 */
import './290-vfx-recipe.js';  /* 视觉配方（todos #9）：保存/命名/分享码，覆盖九个模式的观感参数 */
import './291-phone-remote.js';  /* 手机遥控器总线（todos #17）：主窗 → /api/remote 推状态 + 取指令 */
import './292-toolbar.js';  /* 可自定义界面控件：右上角按钮增删/排序，隐藏项收进「更多」菜单 */
import './293-word-upgrade.js';  /* 行级歌词自动升级真逐字（todos #12 开关2）：跨音源找 >90% 匹配的逐字版 */
import './294-ab-loop.js';  /* 单句 / A-B 循环（todos #3）：学唱歌，边界在 core/abLoop.js */
import './295-vfx-intensity.js';  /* 动效强度滑杆（todos #6）：一根 0~100 代替四档，实时说明这一档给了什么 */
import './296-audio-output.js';  /* 输出设备选择（原生输出线 Phase 1）：AudioContext.setSinkId 收口在 core/audioOutput.js */
import './297-artist-page.js';  /* 歌手页：搜索结果/播放器的歌手名可点，数据源见 services/artistApi.js */
import './298-native-output.js';  /* WASAPI 独占输出（原生输出线 Phase 2b）：开关 + 把播放顶替给原生引擎 */
import './300-hearing-guard.js';  /* 听力健康提醒（需求 16）：连续播放/音量偏高时温和提示，不打断播放 */
import './301-source-status.js';  /* 音源状态面板（需求 1）：设置页一键探测各音源连通性与延迟 */
import './303-storage-backup.js';  /* 存储空间管理（需求 13）+ 自动备份（需求 23） */
import './304-lyric-poster.js';  /* 歌词海报（需求 2）：更多菜单 → 封面 + 歌名 + 当前歌词合成一张图 */
import './305-smart-playlist.js';  /* 智能播放列表（需求 7）：自然语言 → AI 解析成规则 → 本地曲库筛歌建单 */
import './306-energy-motion.js';  /* 能量微动效（需求 19）：低频能量 → 封面轻微缩放 + 光晕，硬上限 +2% */
import './307-start-fade.js';  /* 起播淡入（需求 18）：点播放/切歌/暂停恢复时 0→设定值，100~300ms */
import './308-jizura-preload.js';  /* 字面引擎预热：空闲时加载 JIZURA 的 39 个模块，切模式不空等 */
import './309-jizura-fontpack.js';  /* 字面·日文字体包：把上游字族注册成引擎认的家族名（复用 Aria 字体库持久化） */
import './999-global-audit.js';
