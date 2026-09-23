/* index.js — 入口：按依赖优先顺序加载全部分片。
   顺序为「尽力而为」：分片之间存在交叉引用（如 135-crossfade ↔ 130-playlists ↔
   120-search-results ↔ 150-search-engine 的环），真正的装配保障是各分片内部的
   typeof 探测 + 惰性调用，而非本文件的求值顺序——改本文件顺序前务必确认被调函数
   已在运行时可访问，勿轻信「自动生成」字样。 */
import './000-aria-ns.js';  /* ★ 必须第一个：先建立 window.Aria 命名空间，其余分片再迁移 __ 工具键 */
import './000-tooltip.js';
import './005-skeleton.js';
import './006-layouts.js';
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
import './110-keyboard-nav.js';
import './120-search-results.js';
import './125-favorites.js';
import './130-playlists.js';
import './135-crossfade.js';
import './140-playlist-ui-events.js';
import './145-playlist-import.js';
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
import './999-global-audit.js';
