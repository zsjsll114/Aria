/**
 * i18n.js — 国际化多语言系统 (English / 简体中文)
 * 提供声明式 key 翻译、动态语言切换、持久化与 DOM 文本智能映射
 */
import { logCatch } from '../services/log.js';

const STORAGE_KEY = 'aria_i18n_lang';

export const DICTIONARY = {
  'zh-CN': {
    // 导航与顶部
    'nav.search': '搜索',
    'nav.lyrics': '歌词',
    'nav.playlists': '歌单',
    'nav.settings': '设置',
    'nav.about': '关于',
    'nav.equalizer': '均衡器',
    'nav.desktopLyrics': '桌面歌词',
    'nav.toggleTheme': '切换主题',
    'nav.audioRec': '听歌识曲',

    // 设置侧栏分组
    'settings.group.appearance': '外观',
    'settings.group.playback': '播放',
    'settings.group.services': '服务',
    'settings.group.system': '系统',

    // 设置 Tabs
    'settings.tab.appearance': '视觉模式',
    'settings.tab.background': '背景',
    'settings.tab.fonts': '字体',
    'settings.tab.playback': '播放',
    'settings.tab.quality': '音质',
    'settings.tab.audio': '音效',
    'settings.tab.performance': '性能',
    'settings.tab.selfhost': '自建服务',
    'settings.tab.ai': 'AI 分析',
    'settings.tab.data': '数据',
    'settings.tab.interface': '界面',
    'settings.tab.shortcuts': '快捷键',
    'settings.tab.about': '关于',

    // 常用操作按钮
    'btn.playAll': '播放全部',
    'btn.multiSelect': '多选',
    'btn.selectAll': '全选',
    'btn.deselectAll': '全不选',
    'btn.done': '完成',
    'btn.deleteSelected': '删除选中',
    'btn.shuffle': '随机排序',
    'btn.batchDownload': '批量下载',
    'btn.mergeTo': '合并到...',
    'btn.create': '创建',
    'btn.save': '保存',
    'btn.import': '导入',
    'btn.close': '关闭',
    'btn.confirm': '确定',
    'btn.cancel': '取消',
    'btn.clear': '清空',
    'btn.collapseBottomBar': '收起底部播放栏',
    'btn.expandBottomBar': '展开底部播放栏',

    // 搜索与历史
    'search.placeholder': '搜索歌曲或歌手...',
    'search.clearInput': '清空输入',
    'search.history': '历史搜索',
    'search.hint': '搜索提示',

    // 歌单与弹窗
    'playlist.title': '歌单',
    'playlist.new': '新建歌单',
    'playlist.import': '导入歌单',
    'playlist.saveQueue': '保存当前队列为新歌单',
    'playlist.inputName': '输入歌单名称...',
    'playlist.pasteLink': '粘贴网易云音乐/QQ音乐歌单链接...',
    'playlist.addTo': '添加到歌单',

    // 播放模式
    'mode.sequence': '顺序播放',
    'mode.loop': '单曲循环',
    'mode.random': '随机播放',
    'mode.listLoop': '列表循环',

    // 界面语言设置
    'settings.interface.language': '界面语言 / Language',
    'settings.interface.languageDesc': '选择播放器界面的显示语言',
    'settings.interface.oobeTitle': '初始设置向导',
    'settings.interface.oobeDesc': '重新运行初始设置向导，可调整语言、性能与音质偏好',
    'settings.interface.reopenOobe': '重新运行',
    'settings.about.reopenOobe': '重新运行初始设置'
  },
  'en-US': {
    // Navigation & Topbar
    'nav.search': 'Search',
    'nav.lyrics': 'Lyrics',
    'nav.playlists': 'Playlists',
    'nav.settings': 'Settings',
    'nav.about': 'About',
    'nav.equalizer': 'Equalizer',
    'nav.desktopLyrics': 'Desktop Lyrics',
    'nav.toggleTheme': 'Toggle Theme',
    'nav.audioRec': 'Recognize',

    // Settings Sidebar Groups
    'settings.group.appearance': 'Appearance',
    'settings.group.playback': 'Playback',
    'settings.group.services': 'Services',
    'settings.group.system': 'System',

    // Settings Tabs
    'settings.tab.appearance': 'Visual Modes',
    'settings.tab.background': 'Background',
    'settings.tab.fonts': 'Fonts',
    'settings.tab.playback': 'Playback',
    'settings.tab.quality': 'Audio Quality',
    'settings.tab.audio': 'Audio Effects',
    'settings.tab.performance': 'Performance',
    'settings.tab.selfhost': 'Self-Hosted',
    'settings.tab.ai': 'AI Analysis',
    'settings.tab.data': 'Data',
    'settings.tab.interface': 'Interface',
    'settings.tab.shortcuts': 'Shortcuts',
    'settings.tab.about': 'About',

    // Common Action Buttons
    'btn.playAll': 'Play All',
    'btn.multiSelect': 'Select',
    'btn.selectAll': 'Select All',
    'btn.deselectAll': 'Deselect All',
    'btn.done': 'Done',
    'btn.deleteSelected': 'Delete Selected',
    'btn.shuffle': 'Shuffle',
    'btn.batchDownload': 'Download All',
    'btn.mergeTo': 'Merge To...',
    'btn.create': 'Create',
    'btn.save': 'Save',
    'btn.import': 'Import',
    'btn.close': 'Close',
    'btn.confirm': 'Confirm',
    'btn.cancel': 'Cancel',
    'btn.clear': 'Clear',
    'btn.collapseBottomBar': 'Collapse bottom player bar',
    'btn.expandBottomBar': 'Expand bottom player bar',

    // Search & History
    'search.placeholder': 'Search songs or artists...',
    'search.clearInput': 'Clear input',
    'search.history': 'Search History',
    'search.hint': 'Search Hints',

    // Playlist & Modals
    'playlist.title': 'Playlists',
    'playlist.new': 'New Playlist',
    'playlist.import': 'Import Playlist',
    'playlist.saveQueue': 'Save Queue as Playlist',
    'playlist.inputName': 'Enter playlist name...',
    'playlist.pasteLink': 'Paste Netease or QQ Music playlist link...',
    'playlist.addTo': 'Add to Playlist',

    // Play Modes
    'mode.sequence': 'Sequential',
    'mode.loop': 'Repeat One',
    'mode.random': 'Shuffle',
    'mode.listLoop': 'Repeat All',

    // Interface Language Setting
    'settings.interface.language': 'Display Language / 界面语言',
    'settings.interface.languageDesc': 'Select your preferred application display language',
    'settings.interface.oobeTitle': 'Setup Guide',
    'settings.interface.oobeDesc': 'Run the setup guide again to adjust language, performance and audio preferences',
    'settings.interface.reopenOobe': 'Run Again',
    'settings.about.reopenOobe': 'Run Setup Again',
    // Performance page (hardware info / config preview, data-i18n declarative)
    'perf.hardware': 'Hardware Info',
    'perf.memory': 'Memory',
    'perf.moreDetails': 'More hardware details ▾',
    'perf.resolution': 'Screen Resolution',
    'perf.pixelRatio': 'Pixel Ratio',
    'perf.score': 'Performance Score',
    'perf.dynamicBg': 'Dynamic Background',
    'perf.bgBlur': 'Background Blur',
    'perf.lyricBlur': 'Lyric Blur',
    'perf.showTrans': 'Show Translation',
    'perf.showRomaji': 'Show Romaji',
    'perf.glass': 'Glass Blur',
    'perf.compact': 'Compact Mode',
    'vfx.intensity': 'Motion Intensity'
  }
};

/** 中英通用静态文本对照映射（用于实时全量翻译已有的通用 UI 节点） */
const STATIC_PHRASE_MAP = {
  // 设置导航
  '外观': 'Appearance',
  '视觉模式': 'Visual Modes',
  /* 配方分组：外观令牌（2026-10-06 新增，静态中文必须登记，否则 i18n 门禁会拦） */
  '外观令牌': 'Appearance Tokens',
  '圆角（窗口直角）、毛玻璃模糊、文字三档色、间距字号、焦点环、语义色': 'Corner radius (square windows), glass blur, the three text levels, spacing and font sizes, focus ring, semantic colors',
  /* 智能播放列表（需求 7，2026-10-06）：静态中文必须登记，否则 i18n 门禁会拦 */
  '智能歌单': 'Smart Playlist',
  /* 起播淡入（需求 18，2026-10-06） */
  '起播淡入': 'Fade In On Start',
  /* 字面 · Jizura（第 10 种视觉模式，2026-10-06）：上游 JIZURA 引擎移植 */
  '字面 · Jizura': 'Jizura',
  '把歌词交给 JIZURA 引擎自动生成日系文字 PV：分镜、卡点、装饰与后处理全自动': 'Hand the lyrics to the JIZURA engine for an automatic Japanese-style text PV: shots, beat cuts, decorations and post-processing all automated',
  '设计分辨率': 'Design resolution',
  '引擎的画幅尺寸。720p 更省电，1080p 更锐利': 'Canvas size of the engine. 720p saves power, 1080p is sharper',
  '帧率（动画时基）': 'Frame rate (animation base)',
  '24 为标准（上游默认），12 会让动画按"一拍两格"运行，更省电': '24 is standard (upstream default); 12 runs the animation on twos and costs less',
  /* 字面 · Jizura 的风格/情绪/性能档（2026-10-06 P2）：
     风格与情绪的取值是上游的 ASCII 键名（noir / calm…），直接当标签用**不进词表**，
     只有我们自己的中文说明需要登记。 */
  '风格': 'Style',
  '27 套版式语言；「自动匹配」会按歌词抽一套': 'Twenty-seven layout languages; "Auto match" draws one to fit the lyrics',
  '自动匹配': 'Auto match',
  '情绪倾向': 'Mood bias',
  '只在「自动匹配」时参与抽签': 'Only used together with Auto match',
  '不限': 'Any',
  /* 追加分（2026-10-11）：首版之后新增的部件/风格是否参与抽签。
     引擎侧闸门是 11q_sets.js 的 J.randomOk（严格 === true），关掉后抽签池只剩 486/910。 */
  '追加部件': 'Extra parts',
  /* 字面 · Jizura 的「AI 推荐」与帧率档位（2026-10-11）：AI 分析完自动挑一套风格 + 心情，
     不必用户手选；帧率档位从 12/24 扩到 12/24/30/60。 */
  'AI 推荐': 'AI pick',
  '27 套版式语言；「AI 推荐」按 AI 分析结果选一套（需先分析；未分析时等同「自动匹配」）': '27 layout languages. "AI pick" chooses one from the AI analysis (run the analysis first; without it this behaves like "Auto")',
  '留「不限」时由「AI 推荐」按分析结果填，或由「自动匹配」抽签决定；手选则强制用它': 'Left unset, "AI pick" fills it from the analysis or "Auto" rolls it; a manual choice always wins',
  '输出与字幕': 'Output & subtitles',
  '画面输出帧率：12 最省电、24 默认、30/60 更顺滑但更吃性能；「动画节拍」选「一拍两格」时固定按 24（步长由 koma 决定）': 'Output frame rate: 12 saves the most power, 24 is the default, 30/60 are smoother but heavier. With "On twos" it is pinned to 24 (the step is driven by koma)',
  /* ★ 黑胶 · Vinyl（2026-10-29，自研引擎）：模式名 + 卡片文案 + 面板文案。
     引擎里的 'A1' 是唱片面号，不是 UI 文案；'暂无歌词' 词表里已有。 */
  '黑胶 · Vinyl': 'Vinyl',
  '黑胶': 'Vinyl',
  '封面变成一张缓慢旋转的黑胶，歌词像唱片内页排在旁边': 'The cover becomes a slowly spinning record, with the lyrics set like sleeve notes beside it',
  '把旧唱片放回唱机': 'Put the old record back on the turntable',
  '让针尖落在第一道纹里': 'Let the needle settle into the first groove',
  '唱片': 'Record',
  '转速': 'Speed',
  '暖光': 'Warm light',
  '颗粒': 'Grain',
  '唱臂': 'Tonearm',
  '内页版式': 'Sleeve layout',
  '版式': 'Layout',
  /* ★ 棱镜 · Prism（多镜头光学切面视觉引擎） */
  '棱镜 · Prism': 'Prism',
  '棱镜': 'Prism',
  '多镜头光学切面分镜：36 种几何晶体构图、跨切面文字折射反色与光谱色散': 'Multi-shot optical facet storyboard: 36 geometric crystal compositions, cross-facet refraction inversion and chromatic dispersion',
  '折光': 'Refracted ',
  '切面': 'facets',
  '折光切面': 'Refracted facets',
  '晶体与分镜': 'Crystal & cuts',
  '晶体色温': 'Crystal palette',
  '跟随封面': 'Follow cover',
  '冰钻': 'Diamond',
  '琥珀': 'Amber',
  '黑曜': 'Obsidian',
  '极光': 'Aurora',
  '分镜节奏': 'Cut pacing',
  '短语分镜': 'By phrase',
  '整句一镜': 'Full line',
  '高频快切': 'Fast cuts',
  '光学与运镜': 'Optics & camera',
  '切面折射强度': 'Facet refraction',
  '光谱色散强度': 'Chromatic dispersion',
  '焦散光束强度': 'Caustic beam',
  '镜头运镜幅度': 'Camera motion',
  '光学刻度角标': 'Optical HUD marks',
  /* ★ 画册 · Folio（54 镜瑞士平面构成与正负形反色版画引擎，内部 mode id = astrolabe） */
  '画册 · Folio': 'Folio',
  '画册': 'Folio',
  '画册版画': 'Folio Print',
  '瑞士海报构成：54 种破框天体圆弧与包豪斯实色切面、8 种排版拓扑与正负形反色': 'Swiss poster constructivism: 54 off-frame celestial arcs & Bauhaus flat masses, 8 typographic topologies and figure-ground inversion',
  '版画色板与分镜': 'Print palette & cuts',
  '版画纸墨色板': 'Paper & ink palette',
  '曜石羊皮': 'Obsidian Vellum',
  '普鲁士版画': 'Prussian Print',
  '包豪斯构成': 'Bauhaus Construct',
  '朱砂金泥': 'Vermilion Press',
  '青瓷松烟': 'Celadon Ink',
  '赭石手稿': 'Ochre Archive',
  '曜石赤金 · Obsidian & Gold': 'Obsidian & Gold',
  '普鲁士群青 · Prussian Ultramarine': 'Prussian Ultramarine',
  '包豪斯三原 · Weimar Bauhaus': 'Weimar Bauhaus',
  '大漆朱砂 · Lacquer Vermilion': 'Lacquer Vermilion',
  '天青石绿 · Celadon Malachite': 'Celadon Malachite',
  '赭石古铜 · Ochre & Copper': 'Ochre & Copper',
  '构成与肌理': 'Construct & texture',
  '正负形反色块': 'Figure-ground inversion',
  '版画排线密度': 'Hatching density',
  '色块对比张力': 'Mass contrast',
  '印刷裁切角标': 'Print crop marks',
  '琉璃龛 · Vitrail': 'Vitrail Sanctuary',
  '琉璃龛': 'Vitrail',
  '镜幕 · FocalCut': 'FocalCut Director',
  '镜幕': 'FocalCut',
  '建筑展墙排版与 2.5D 多机位分屏闪切': 'Architectural exhibition wall & 2.5D split-lens cuts',
  '建筑感立体展墙 × 2.5D 多机位闪切导播台：微距裁切、透视斜拍与同画布双视口分屏': 'Architectural wall × 2.5D director: macro crops, oblique angles & live dual-viewport split cuts',
  '展墙极性模式': 'Wall polarity',
  '自动翻转': 'Auto flip',
  '曜石黑墙': 'Obsidian dark',
  '暖白画廊': 'Alabaster gallery',
  '自动模式下主歌为深曜石墙、副歌快门翻转为美术馆暖白墙': 'Auto flips from obsidian verse walls to warm alabaster chorus walls via shutter sweep',
  '闪切节奏密度': 'Cut cadence',
  '舒缓': 'Calm',
  '标准': 'Normal',
  '高频': 'Intense',
  '同步双视口分屏': 'Dual-viewport split lens',
  '高潮或情感词触发全景 × 微距同框分屏': 'Triggers simultaneous wide + macro split screen on chorus peaks and emotion words',
  '2.5D 机位景别张力': '2.5D camera intensity',
  '建筑定位标尺线': 'Architectural guides',
  '切镜光学对焦呼吸': 'Optical rack focus',
  '原生 WebGL2 3D 光学圣殿：8 种空间原型随曲风章节巡游、双缓冲无缝转场与浮雕逐字光晕': 'Native WebGL2 3D optical sanctuary: 8 spatial archetypes touring by musical chapters, dual-buffer seamless transitions & beveled SDF typography',
  '原生 WebGL2 3D 光学圣殿：4 种空间原型随曲风智能匹配、实时水镜倒影与浮雕逐字光晕': 'Native WebGL2 3D optical sanctuary: 4 song-matched spatial archetypes, planar water reflection & beveled SDF typography',
  '殿堂与光影': 'Sanctuary & Lighting',
  '光影材质色板': 'Material & light palette',
  '选「随歌曲智能匹配」时依据封面色板、歌词情绪与语种自动定调': 'Auto adapts to cover palette, lyric mood and language when set to Smart match',
  '随歌曲智能匹配': 'Match song automatically',
  '琥珀圣殿 · Sainte Amber': 'Sainte Amber',
  '群青圣堂 · Chartres Blue': 'Chartres Blue',
  '青石水院 · Ando Celadon': 'Ando Celadon',
  '朱砂穹殿 · Vermilion Dome': 'Vermilion Dome',
  '银月浑仪 · Nocturne Silver': 'Nocturne Silver',
  '白石日影 · Travertine Sun': 'Travertine Sun',
  '琥珀圣殿': 'Amber Sanctuary',
  '群青圣堂': 'Chartres Blue',
  '青石水院': 'Ando Celadon',
  '朱砂穹殿': 'Vermilion Dome',
  '银月浑仪': 'Nocturne Silver',
  '白石日影': 'Travertine Sun',
  '建筑空间原型': 'Spatial archetype',
  '包含尖拱大殿、浑天穹顶、静谧回廊、水镜亭台、星穹万神坛、水上拱廊、秘阁穹廊与曦光晶庭；选「随歌曲智能匹配」将随全曲乐章无缝巡游切换': 'Includes Cathedral, Observatory, Cloister, Pavilion, Rotunda, Venetian Arcade, Scriptorium & Sunlit Atrium; Smart match tours seamlessly across song chapters',
  '尖拱大殿适合宏阔抒情、浑天穹顶适合电子迷幻、静谧回廊适合古风民谣、水镜亭台适合明快律动': 'Cathedral for sweeping ballads, Observatory for electronic/cinematic, Cloister for acoustic/folk, Pavilion for upbeat grooves',
  '尖拱大殿': 'Cathedral',
  '浑天穹顶': 'Observatory',
  '静谧回廊': 'Cloister',
  '水镜亭台': 'Pavilion',
  '星穹万神坛': 'Starlight Rotunda',
  '水上拱廊': 'Venetian Arcade',
  '秘阁穹廊': 'Vaulted Scriptorium',
  '曦光晶庭': 'Sunlit Atrium',
  '渲染画质档': 'Render quality',
  '「自动」启用自适应分辨率看门狗；低配设备可选平衡或轻量模式': 'Auto enables adaptive resolution watchdog; choose Balanced or Lite on modest hardware',
  '平衡省电': 'Balanced',
  '轻量流畅': 'Lite',
  '光学效果与交互': 'Optics & Interaction',
  '运镜幅度': 'Camera motion amplitude',
  '圣光束与泛光': 'God rays & bloom',
  '地面水镜倒影': 'Planar water reflection',
  '圣光浮尘微粒': 'Dust motes',
  '指针 3D 视差': 'Pointer 3D parallax',
  '排版与字幕': 'Typography & Subtitles',
  '控制非情感词逐字扫光高亮颜色（AI 情感词优先保留情绪着色）': 'Controls sweep highlight tint for neutral words (AI emotion words keep mood hues)',
  '思源黑体 / 黑体': 'Sans-serif (Hei)',
  '思源宋体 / 衬线': 'Serif (Song)',
  'INSTRUMENTAL · 间奏': 'INSTRUMENTAL',
  'SANCTUARY INTERLUDE · 间奏巡礼': 'SANCTUARY INTERLUDE',
  /* 诗镜 · Verse 的「动态强度」（2026-10-11）：上游 Theme.animationIntensity，
     合法值 calm/normal/chaotic（'标准' 全库已有英文，复用不另起）。 */
  '动态强度': 'Animation intensity',
  '整体运动与镜头的幅度：平静 0.65× ／ 标准 1×（原版默认）／ 激烈 1.35×': 'Overall motion and camera amplitude: Calm 0.65x / Standard 1x (upstream default) / Intense 1.35x',
  '平静': 'Calm',
  '激烈': 'Intense',
  '抽签范围含首版之后新增的部件与 12 套风格（候选池约 1.8 倍）；关掉只用首版部件集，转场这类容易看出重复的部件会明显变少': 'Random picks may also use the parts and 12 styles added after the first release (about 1.8x the candidate pool). Off keeps the first-release parts only — the pool of transitions and similar repeat-prone parts shrinks noticeably',
  '性能档': 'Performance profile',
  '按实测帧耗时动态调整清晰度；旧机器可选省电': 'Sharpness adapts to the measured frame time; pick Power saver on older machines',
  '自动': 'Auto',
  '省电': 'Power saver',
  '高清': 'High definition',
  /* 动画节拍与逐字跟唱（2026-10-06 P3） */
  '帧率': 'Frame rate',
  '动画的输出帧率。12 最省电，24 最顺滑': 'Output frame rate. 12 is the lightest, 24 the smoothest',
  '动画节拍': 'Animation beat',
  '逐帧最流畅；「一拍两格」为引擎原生的卡帧感（每秒 12 张）': 'Frame-by-frame is smoothest; "On twos" is the engine\'s original staccato look (12 drawings per second)',
  '逐帧': 'Frame-by-frame',
  '一拍两格': 'On twos',
  '块级': 'Blocks',
  '按字切分镜': 'Split shots by syllable',
  /* 画面细节（引擎 fx）：面板暴露的六个数值 + 两个开关 */
  '画面细节': 'Composition detail',
  '动感': 'Motion',
  '镜头与元素的运动幅度': 'How far the camera and elements travel',
  '故障闪烁': 'Glitch',
  '色散': 'Chromatic aberration',
  '装饰': 'Decorations',
  '密度': 'Density',
  '影响一行切成几个分镜': 'How many shots one lyric line is split into',
  '颗粒质感': 'Grain',
  '闪光': 'Flash',
  'HUD': 'HUD',
  '画面里的角标与刻度': 'Corner marks and tickers drawn on the frame',
  /* 日文字体包 */
  '日文字体包': 'Japanese font pack',
  '导入日文字体': 'Import Japanese fonts',
  '导入日文字体（支持 .ttf/.otf/.woff/.woff2，可多选）；本模式按原始字体排版，导入的字体也可用于其它模式': 'Import the Japanese fonts the upstream engine uses (multi-select .ttf/.otf/.woff/.woff2). This mode then typesets exactly like upstream, and the imported fonts are available to the other modes too',
  '选择字体文件': 'Choose font files',
  '正在导入日文字体…': 'Importing Japanese fonts…',
  '字体导入失败，请看日志': 'Font import failed — see the logs',
  '字体导入出错，请看日志': 'Font import errored out — see the logs',
  '日文字体已导入，画面将按上游原貌排版': 'Japanese fonts imported — the visuals now typeset like upstream',
  '字体已导入，但没有命中引擎用的日文字族（文件名需含 Noto Sans JP 等家族名）': 'Fonts imported, but none matched the Japanese families the engine uses (the file name should contain a family name such as Noto Sans JP)',
  '按真实逐字时间把一行拆成多个分镜；引擎里一段即一个画面，拆得太多会显得碎（需要逐字歌词）': 'Splits one lyric line into several shots using the real syllable timings, so the cuts land closer to what is actually being sung. In this engine one cut is one composition, so too many cuts look choppy (needs KRC/YRC/QRC word lyrics, or a completed spectral alignment)',
  '按真实逐字时间对齐分镜切点；「逐字」最精确，但分镜更碎、更耗性能（需要逐字歌词）': 'Aligns the shot cuts to the real per-character timings. "Per character" is the most accurate but fragments the shots and costs more (needs KRC/YRC/QRC word lyrics, or a completed spectral alignment)',
  /* 歌单迁移：未匹配清单（需求 6，2026-10-06） */
  '未匹配的歌曲': 'Unmatched Songs',
  '这些歌请手动搜索，或换一个歌单来源再导入': 'Search for these manually, or import from another playlist source',
  /* 练习变速保音高（需求 15，2026-10-06）：独占路径的已知边界 */
  '独占输出下变速会改变音调（保音高需关闭独占输出）': 'Playback rate changes pitch in exclusive output — turn exclusive mode off to keep the pitch',
  '固定播放速度（0.5×~2.0×，每档 0.05）并保持音高；独占输出下音高仍会变化': 'Locks the speed to a fixed value, 0.5×–2.0× in 0.05 steps; pitch is preserved (exclusive output still shifts it)',
  /* 声道设置（需求 20，2026-10-06）修复后新增的失败提示 */
  '独占输出下声道设置不生效，请先关闭独占': 'Channel settings have no effect in exclusive output — turn exclusive mode off first',
  '当前音源不支持音效处理（跨域限制），声道设置未生效': 'This source does not support audio processing (cross-origin restriction) — channel settings were not applied',
  /* 输出设备切换超时（需求 4，2026-10-06） */
  '切换输出设备超时，已保持原设备': 'Switching output device timed out — keeping the previous device',
  '播放、切歌或恢复时音量平滑淡入（100~300 毫秒）': 'When you hit play, change track or resume from pause, the volume rises smoothly from zero (100–300 ms)',
  '用一句话描述你想听什么。AI 只把它翻译成规则，之后在本地曲库里筛歌，不再调用 AI。': 'Describe what you want to hear in one sentence. AI only turns it into rules; the songs are picked from your local library afterwards, with no further AI calls.',
  '例如：深夜适合听的慢歌，BPM 80 以下，别要现场版': 'e.g. slow songs for late at night, under 80 BPM, no live versions',
  '解析': 'Parse',
  '请先描述你想要什么样的歌单': 'Describe the playlist you want first',
  '请先在 设置 → AI 分析 里配置 API 密钥': 'Configure an API Key in Settings → AI Analysis first',
  'AI 正在解析你的描述…': 'AI is reading your description…',
  'AI 解析失败': 'AI parsing failed',
  '没能从 AI 回复里读出规则，请再试一次': 'Could not read any rules from the AI reply — please try again',
  '确认规则': 'Confirm Rules',
  '可以直接改这份 JSON，改完点"生成歌单"。': 'You can edit this JSON directly, then click "Generate Playlist".',
  '生成歌单': 'Generate Playlist',
  '规则 JSON 格式有误，已取消': 'The rules JSON is malformed — cancelled',
  '这份规则没有任何筛选条件，已取消': 'These rules have no filters at all — cancelled',
  '正在本地曲库里筛歌…': 'Picking songs from your local library…',
  '本地曲库是空的，先去收藏或歌单里攒点歌吧': 'Your local library is empty — add some favourites or playlists first',
  '没有匹配到歌曲': 'No matching songs',
  '首已检查': 'songs checked',
  '已生成': 'Created',
  '首不匹配': 'songs did not match',
  '首超出上限未收录': 'songs over the limit were left out',
  '智能歌单生成失败，请看日志': 'Smart playlist generation failed — check the logs',
  '背景': 'Background',
  '字体': 'Fonts',
  '播放': 'Playback',
  '音质': 'Audio Quality',
  '音效': 'Audio Effects',
  '性能': 'Performance',
  '服务': 'Services',
  '自建服务': 'Self-Hosted',
  'AI 分析': 'AI Analysis',
  '数据': 'Data',
  '系统': 'System',
  '界面': 'Interface',
  '快捷键': 'Shortcuts',
  '关于': 'About',
  '常规与语言': 'General & Language',
  '主题与外观': 'Theme & Look',

  // 界面设置项
  '界面语言 / Language': 'Language / 界面语言',
  '选择播放器界面的显示语言': 'Choose the application display language',
  '主题强调色': 'Accent Color',
  '主色调（影响按钮、高亮等）': 'Primary color (buttons, highlights, etc.)',
  '毛玻璃强度': 'Glass Blur',
  /* 歌词逐字显示（todos #12，界面设置组） */
  '歌词逐字显示': 'Karaoke Word Timing',
  '行级歌词也按逐字显示': 'Show line-level lyrics per word',
  '自动替换为真逐字歌词': 'Auto-upgrade to real word timing',
  '行级歌词按行时长摊平为逐字高亮，关闭则整行一起跳；仅对歌词、默认、词云三种模式生效':
    'Spread line-only timestamps (plain LRC, most external sources) into per-word highlighting; off = the whole line jumps at once. Applies to the Lyrics / Default / Word-cloud modes only',
  '当前为行级歌词时，从其它音源找匹配度高于 90% 的逐字歌词替换（酷狗优先）。开启后不再摊平假逐字，上面的开关会自动关闭':
    'When the current lyrics are line-only, look for a word-level copy matching >90% from another source (KuGou KRC first). Turns off the fake spreading above',
  '界面磨砂模糊半径 (px)': 'Frosted blur radius (px)',
  '动态背景': 'Dynamic Background',
  '专辑封面模糊渐变背景': 'Album-cover blurred gradient background',
  '模糊半径': 'Blur Radius',
  '背景高斯模糊程度 (px)': 'Background gaussian blur (px)',
  '背景亮度': 'Brightness',
  '调节背景明暗程度': 'Adjust background brightness',
  '呼吸摇摆动画': 'Sway Animation',
  '背景缓慢流动摇摆': 'Slow background sway',
  '摇摆幅度': 'Sway Amplitude',
  '移动范围 (px)': 'Range (px)',
  '摇摆周期': 'Sway Period',
  '一个完整循环的秒数': 'Seconds per cycle',
  /* MV 动态背景（2026-10-03）：设置项 3 条 + 搜索页卡片 5 条 */
  'MV': 'MV',
  'MV 动态背景': 'MV Background',
  '在搜索结果里点 MV 卡片，把它铺成动态背景': 'Click an MV card in search results to use it as a live background',
  'MV 压暗': 'MV Dim',
  '降低 MV 亮度，让歌词更清楚': 'Dim the MV so lyrics stay readable',
  'MV 模糊': 'MV Blur',
  'MV 背景模糊程度 (px)': 'MV background blur (px)',
  'MV 画质增强': 'MV Quality Boost',
  'Anime4K 超分与去伪影，改善 MV 的模糊与噪点': 'Anime4K upscaling + de-artifacting for sharper, cleaner MV',
  '增强强度': 'Strength',
  'S 轻快、M 更锐、L 最强；越强越耗显卡，性能不足时自动降级': 'S is lightest, M is sharper, L is strongest — heavier tiers use more GPU and fall back automatically if too slow',
  '轻 S': 'Light S',
  '中 M': 'Medium M',
  '强 L': 'Strong L',
  '音画偏移矫正': 'A/V Sync Correction',
  '自动对齐 MV 正片与歌曲进度；每首额外下载约 10MB 用于分析': 'Align the MV picture with the song automatically; each MV costs ~10MB of analysis, turn off to save data',
  '点卡片设为动态背景': 'Click a card to set as background',
  '背景中': 'In use',
  'MV 取址中...': 'Resolving MV…',
  '这支 MV 暂时取不到播放地址': 'No playable source for this MV right now',
  '这支 MV 的地址播不出来（源站限制），已回退封面背景': 'This MV resolved but will not play (source restriction) · fell back to cover',
  '当前性能模式下已停用 MV 动态背景': 'MV background is disabled in the current performance mode',
  '该音源暂不支持 MV · 切到 QQ 音乐／网易云音乐／酷狗音乐试试': 'MV is unavailable for this source · try QQ Music / NetEase Cloud Music / Kugou Music',
  '全局默认字体': 'Global Font',
  '主界面与默认歌词渲染字体': 'Font for UI and default lyrics',
  '多语言字体匹配': 'Per-Language Fonts',
  '按中/日/韩/英/俄等文字语言分别指定字体': 'Assign fonts per script language',
  '桌面歌词': 'Desktop Lyrics',
  '歌词字号': 'Lyric Font Size',
  '桌面歌词窗口的文字大小（24–72px）': 'Desktop lyrics font size (24–72px)',
  '歌词字体': 'Lyric Font',
  '默认 = 跟随全局字体设置': 'Default = follow global font',
  '显示情感词颜色': 'Emotion Word Colors',
  '关闭后桌面歌词只用单色高亮': 'Off = single-color highlight only',

  // 音质设置项
  'QQ音乐音质': 'QQ Music Quality',
  '网易云音乐音质': 'Netease Music Quality',
  '酷狗音乐音质': 'KuGou Music Quality',
  '播放音质': 'Playback Quality',
  '下载音质': 'Download Quality',
  '在线播放时获取的音质': 'Quality for online streaming',
  '在线播放与自建服务时获取的音质': 'Quality for streaming & self-hosted',
  '下载歌曲时获取的音质': 'Quality for downloads',
  '标准 128kbps': 'Standard (128kbps)',
  '高品质 320kbps': 'High (320kbps)',
  '无损 FLAC': 'Lossless (FLAC)',
  '全景声': 'Dolby Atmos',
  '臻品母带': 'Premium Master',
  '超高解析 / 母带': 'Hi-Res / Master',
  // 重复键 '标准' 已定义在顶部（Standard/Normal）
  '较高': 'Higher',
  '极高': 'Ex-High',
  '无损': 'Lossless',

  // PV / 视觉模式设置项
  '基础字号': 'Base Font Size',
  '默认焦距 (镜头特写)': 'Focal Length (Close-up)',
  '调大：聚焦当前两三个词的特写；调小：显示更完整的句子': 'Zoom in to focus on 2-3 words at a time, zoom out for fuller lines',
  '网点大小': 'Halftone Size',
  '运镜平滑速度': 'Camera Speed',
  '相机阻尼系数': 'Camera Damping',
  '显示 HUD 边框与准心': 'Show HUD Frame',
  '显示巨型背景字与几何构图': 'Show Giant BG Words & Geometry',
  '显示星芒微粒': 'Show Particles',
  '情感词多色发光联动': 'Emotion Glow Sync',
  /* 诗镜 · Verse 的「后期处理」组（2026-10-11）：上游 SonnetTuning 的 postProcess*。
     默认档 = folia 的干净画面（主开关 false），开启后才叠加这几层。 */
  '后期处理': 'Post-processing',
  'folia 默认关闭；开启后才叠加胶片颗粒 / RGB 色散 / 半调网点 / 暗角——薄线装饰（图形、画框）上容易显得像雪花噪点': 'Off by default in folia. Turns on film grain, RGB shift, halftone screen and vignette — over thin line art these read as snow/static noise',
  '胶片颗粒': 'Film grain',
  '对比度': 'Contrast',
  'RGB 色散': 'RGB shift',
  '半调网点': 'Halftone screen',
  '暗角': 'Vignette',
  '镜头畸变': 'Lens distortion',
  '镜头色散': 'Lens dispersion',
  /* 诗镜 · Verse 的「画面元素」开关（2026-10-11）：上游 SonnetTuning 里本仓缺失的 4 个 */
  '仅文字': 'Text only',
  '只保留歌词文字：引导线、装饰画框、图形与片尾海报一并隐藏': 'Keep lyric text only — guides, decorative frames, graphics and the end poster are all hidden',
  '显示引导线': 'Show guides',
  '逐词入场之前的引导曲线与定位标记': 'Lead-in curves and locator marks before each word arrives',
  '显示巨型装饰字': 'Show giant decorative type',
  '每个镜头里的巨型残影字（装饰层，不参与逐字高亮）': 'Giant afterimage type per shot (a decoration layer, not part of the karaoke highlight)',
  '装饰画框与文字浮标': 'Decorative frames & floating marks',
  '每句背后的开放画框：与「显示巨型背景字与几何构图」不同，后者管的是背景几何层': 'Open frames behind each phrase. Distinct from "Show Giant BG Words & Geometry", which controls the background geometry layer',
  /* ★ 2026-10-11 三个数值旋钮 + 外层边框三档 + 间奏标记扩展（标签措辞照抄上游 zh-CN） */
  '镜头运动强度': 'Camera motion intensity',
  '文字动势': 'Typography motion',
  '逐字入场幅度，同时乘进发光强度': 'Per-glyph entrance amplitude; also scales the glow strength',
  '背景短线密度': 'Background line density',
  '外层边框': 'Outer frame',
  '完全隐藏': 'Hidden',
  '仅显示框架': 'Frame only',
  '完全显示': 'Full',
  '完全显示会再叠上场景里那行竖排主题名': 'Full also adds the vertical theme name inside the scene',
  '间奏标记也走谱面': 'Interlude markers also use the staff',
  'folia 只认 ♪；打开后 MUSIC / MUSIC- / ♪♪ 与纯点号行（…）也画成五线谱（本仓扩展，默认关 = 原版行为）': 'folia only recognizes ♪. When on, MUSIC / MUSIC- / ♪♪ and dotted-only lines (…) also render the staff shot (an Aria extension; off = upstream behavior)',
  '高亮颜色': 'Highlight Color',
  '显示翻译': 'Show Translation',
  '显示罗马音': 'Show Romaji',
  '背景图形颜色': 'Graphic Color',
  '控制PV模式几何构图与装饰图层颜色': 'Color of PV geometry & decoration layers',
  '导入自定义字体': 'Import Font',
  '支持 .ttf .otf .woff .woff2': 'Supports .ttf .otf .woff .woff2',
  '活泼排版（允许词块倾斜）': 'Dynamic Layout (tilt blocks)',
  '关闭后不旋转，仅按字号大小居中排版': 'Off = straight grid: no rotation, centered',
  '系统默认': 'System Default',
  '思源黑体': 'Noto Sans SC',
  '思源宋体': 'Noto Serif SC',
  '思源宋体（衬线）': 'Noto Serif SC',
  '微软雅黑': 'Microsoft YaHei',
  '黑体': 'SimHei',
  '宋体': 'SimSun / Serif',
  '楷体': 'KaiTi',
  '仿宋': 'FangSong',
  '苹方': 'PingFang SC',
  '等宽字体': 'Monospace',
  '选择字体': 'Choose Font',
  '跟随字体设置': 'Follow Global Font',
  '默认（全局字体）': 'Default (Global Font)',
  '默认': 'Default',
  '自定义颜色': 'Custom Color',

  // 视觉模式卡名
  '默认模式': 'Classic',
  '拾光 · Lyrics': 'Lyrics',
  '飞白 · Fly-In': 'Fly-In',
  '词云 · WordCloud': 'Word Cloud',
  '绘卷 · PV': 'PV Art',
  '格律 · Mondrian': 'Mondrian',
  '流字 · Tunnel': 'Tunnel',
  '活字 · Letterpress': 'Letterpress',
  '霓虹 · Neon': 'Neon',

  // 按钮
  '搜索': 'Search',
  '识曲': 'Recognize',
  '歌单': 'Playlists',
  '设置': 'Settings',
  '在 GitHub 上点个 Star': 'Star on GitHub',
  '登录后日推、收藏与高音质走自建接口，无 VIP 时自动回退免费源池；扫码一次长期有效。各平台的启用开关决定哪些功能走自建：酷狗目前只有日推与收藏走自建，汽水音乐的搜索与逐字歌词匿名可用、仅播放需要登录；酷狗若提示需要验证，可在登录弹窗改用手机号验证码登录。': 'After login, daily mix, favorites and hi-res go through the self-hosted service; without VIP, trial links fall back to the free pool. Scanning once keeps you signed in. Each platform switch decides which features are self-hosted: KuGou currently serves daily mix and favorites only, while Soda search and per-word lyrics work anonymously (only playback needs a login). If KuGou asks for verification, use SMS login in the dialog.',
  '反馈问题': 'Report Issues',
  '播放全部': 'Play All',
  '上一页': 'Prev',
  '下一页': 'Next',
  '多选': 'Select',
  '全选': 'Select All',
  '全不选': 'Deselect All',
  '完成': 'Done',
  '随机排序': 'Shuffle',
  '批量下载': 'Download All',
  '合并到...': 'Merge To...',
  '合并到其它歌单': 'Merge to another playlist',
  '创建': 'Create',
  '保存': 'Save',
  '导入': 'Import',
  '关闭': 'Close',
  '加入当前播放': 'Play Next',
  '收藏': 'Favorite',
  '取消收藏': 'Unfavorite',
  '从队列移除': 'Remove from Queue',
  '移除': 'Remove',
  '正在播放': 'Now Playing',
  '依次下载本歌单全部歌曲': 'Download all songs in this playlist',
  '下载整单': 'Download All',
  '随机排序（打乱当前队列）': 'Shuffle queue',
  '随机排序（打乱本歌单顺序）': 'Shuffle playlist order',
  '批量下载整单歌曲': 'Download all songs',

  // 弹窗标题与提示
  '历史搜索': 'Search History',
  '清空输入': 'Clear Input',
  '新建歌单': 'New Playlist',
  '导入歌单': 'Import Playlist',
  '保存当前队列为新歌单': 'Save Queue as Playlist',
  '输入歌单名称...': 'Enter playlist name...',
  '输入新歌单名称以保存当前队列...': 'Name the new playlist...',
  '粘贴网易云音乐/QQ音乐歌单链接...': 'Paste a Netease / QQ Music playlist link...',
  '搜索歌曲或歌手...': 'Search songs or artists...',
  '搜索QQ音乐歌曲...': 'Search QQ Music...',
  '搜索网易云音乐歌曲...': 'Search Netease Music...',
  '搜索酷狗音乐歌曲...': 'Search KuGou Music...',
  '已恢复出厂默认性能配置（高性能）': 'Factory performance config restored (High)',
  '恢复出厂性能配置？': 'Restore factory performance config?',
  '恢复出厂性能配置？将清空全部手动微调，操作不可撤销。': 'Restore factory performance config? All manual tuning will be cleared. This cannot be undone.',
  '恢复': 'Restore',
  '搜索酷我音乐歌曲...': 'Search Kuwo Music...',
  '搜索汽水音乐歌曲...': 'Search Soda Music...',
  '汽水音乐搜索暂无结果（需本机自建服务在线）': 'No Soda results (self-hosted service must be running)',
  '添加到歌单': 'Add to Playlist',
  '请输入关键词': 'Type a keyword first',
  '搜索中...': 'Searching...',
  '无搜索结果': 'No results',
  '没有更多结果了': 'No more results',
  '请先播放歌曲': 'Play a song first',
  '当前列表没有歌曲': 'No songs in this list',

  // 播放模式
  '顺序播放': 'Sequential',
  '单曲循环': 'Repeat One',
  '随机播放': 'Shuffle',
  '列表循环': 'Repeat All',

  // 界面/字体管理（截图漏网补全 2026-09-22）
  '全局字体': 'Global Font',
  '字体管理中心': 'Font Manager',
  '锁定字体设置': 'Lock Font Settings',
  '管理自定义与本地字体，或匹配多语言字体': 'Manage custom & local fonts, or per-language matching',
  '思源宋体 VF': 'Noto Serif SC VF',
  '思源黑体 VF': 'Noto Sans SC VF',
  '（可变字体）': ' (Variable)',
  '搜索设置…': 'Search settings...',
  '搜索设置...': 'Search settings...',

  // 性能
  '性能档位': 'Performance Tier',
  '自动检测': 'Auto Detect',
  '流畅优先': 'Smooth First',
  '均衡表现': 'Balanced',
  '画质优先': 'Quality First',
  '粒子预算': 'Particle Budget',
  '装饰降级': 'Decoration Fallback',

  // 播放
  '默认播放模式': 'Default Play Mode',
  '默认播放速度': 'Default Speed',
  '均衡器预设': 'EQ Preset',
  '初始音量': 'Initial Volume',
  '音量均衡': 'Volume Normalization',
  '倍速播放保持音调': 'Preserve Pitch',

  // AI / 服务
  'AI 服务商': 'AI Provider',
  'API 密钥': 'API Key',
  '模型': 'Model',
  '自动签到': 'Auto Check-in',
  '扫码登录': 'Scan to Login',
  '服务未启动': 'Service not running',
  '本地服务运行中': 'Local service running',
  '本地组件未安装': 'Local component not installed',

  // 数据 / 关于
  '导出配置': 'Export Config',
  '导入配置': 'Import Config',
  '下载数据': 'Download Data',
  '清空缓存': 'Clear Cache',
  '版本': 'Version',
  '作者': 'Author',
  '开源仓库': 'Repository',
  '检查更新': 'Check for Updates',

  /* ===== 2026-09-22 第二轮全量补全（index.html 静态扫描） ===== */
  // 顶栏与通用
  'QQ音乐': 'QQ Music',
  'QQ 音乐': 'QQ Music',
  '网易云音乐': 'Netease Music',
  '网易云': 'Netease',
  '酷狗音乐': 'KuGou Music',
  '酷我音乐': 'Kuwo Music',
  '汽水音乐': 'Soda Music',
  '汽水': 'Soda',
  '多源音源': 'Multi-Source',
  '音乐榜单': 'Charts',
  '每日推荐': 'Daily Mix',
  '最近播放': 'Recent',
  '播放统计': 'Stats',
  '均衡器': 'Equalizer',

  /* —— 听歌统计「声音手账 / 情绪档案」（256-listen-stats.js + core/listenStatsReport.js）—— */
  '声音手账': 'Sound Journal',
  'Aria · 声音手账': 'Aria · Sound Journal',
  '生成纪念卡': 'Save Card',
  '保存声音纪念卡': 'Save Keepsake Card',
  '正在生成纪念卡...': 'Generating keepsake card...',
  '声音纪念卡已保存': 'Keepsake card saved',
  '生成纪念卡失败': 'Failed to generate card',
  '相伴': 'Together',
  '连续聆听': 'Streak',
  '约听完': 'About',
  '张专辑': 'albums',
  '自': 'Since',
  '起相伴': 'with you',
  '累计聆听': 'Total Time',
  '完整驻足': 'Full Plays',
  '听过的歌': 'Tracks',
  '重逢歌手': 'Artists',
  '今日': 'Today',
  '本周': 'This Week',
  '已收藏': 'Favorited',
  '活跃': 'Active',
  '次': ' plays',
  '天': ' days',
  '位': ' artists',
  '分': 'm',
  '单曲偏爱 · #1': 'Top Track · #1',
  '最近心动旋律': 'Recent Highlight',
  '反复倾听': 'Repeated',
  '占总播放': 'of plays',
  '刚刚响起': 'Just started playing',
  '再听一遍': 'Play Again',
  '情绪光谱': 'Mood Spectrum',
  '已显影心境': 'Moods Captured',
  '声音气质关键词': 'Emotional Echoes',
  '声音色卡尚未显影': 'Mood Palette Not Captured Yet',
  '开启「AI 情绪分析」后，歌词里的心境色彩与情感词会在这里汇成你的情绪光谱':
    'Enable AI Emotion Analysis in Settings to gather lyric colors and emotional keywords here',
  '前往开启': 'Open AI Settings',
  '情绪余韵': 'Mood Hue',
  '昼夜音律': '24h Listening Arc',
  '按近期播放估算': 'Est. from recent plays',
  '清晨': 'Dawn',
  '白昼': 'Day',
  '暮色': 'Dusk',
  '深夜': 'Night',
  '安静休息': 'Quiet day',
  '近 14 日节拍': '14-Day Rhythm',
  '最沉浸': 'Peak',
  '暂无连续记录': 'No listens in 14 days',
  '常听旋律': 'Most Played Tracks',
  '常伴声线': 'Favorite Artists',
  '去发现音乐': 'Discover Music',
  '点亮任意一首歌，这里会慢慢写下你的深夜时段、偏爱声线与情绪色卡':
    'Play any track and your late-night hours, favorite voices, and mood palette will slowly take shape here',
  '仅统计本机聆听记忆': 'Stored locally on this device',
  '清空统计': 'Reset Stats',
  '重置听歌统计': 'Reset Listening Stats',
  '确定清空累计播放时长、单曲排行与时段分布记忆吗？此操作无法撤销。':
    'Clear your accumulated listening time, top tracks, and circadian history? This cannot be undone.',
  '听歌统计已清空': 'Listening stats cleared',
  '暂无可用播放信息': 'Track playback info unavailable',
  '初遇频段': 'First Frequency',
  '耳机尚未开启的此刻，第一首会是谁呢': 'Silence before the first play — which track opens this chapter?',
  '初声漫游者': 'First-Note Wanderer',
  '每一段漫长的偏爱，都从第一句副歌轻轻开始': 'Every lasting favorite begins with a single chorus you stayed for',
  '零点守夜人': 'Midnight Keeper',
  '夜深人静时旋律格外清晰，歌单替你留着没睡的夜晚': 'Melodies speak clearest after midnight; your queue keeps watch over quiet nights',
  '晨光拾音者': 'Dawn Listener',
  '习惯让第一首歌比太阳更早抵达，把清晨调成喜欢的频率': 'Waking with music before the sun, tuning each morning to a gentler frequency',
  '暮色收藏家': 'Dusk Collector',
  '日落到夜灯亮起的这段时光，被你安稳地交给了耳机与旋律': 'Between sunset and evening lights, the day unwinds inside your headphones',
  '光影漫游者': 'Daylight Drifter',
  '耳机把忙碌的日常与空白午后，静静剪成流动的电影胶片': 'Turning busy hours and quiet afternoons into a flowing soundtrack',
  '全天候听觉旅人': 'All-Day Listener',
  '清晨、午后与深夜都有声音相伴，旋律是你最诚实的日记': 'Morning, afternoon, and night — music stays your most honest diary',
  '傍晚时刻': 'Evening Hours',
  '此刻启程': 'Just Beginning',
  '深夜倾听': 'Late Night',
  '清晨倾听': 'Morning',
  '暮色倾听': 'Dusk Hours',
  '白昼倾听': 'Daytime',
  '全天相伴': 'Balanced',
  '周日': 'Sun',
  '周一': 'Mon',
  '周二': 'Tue',
  '周三': 'Wed',
  '周四': 'Thu',
  '周五': 'Fri',
  '周六': 'Sat',
  /* 输出设备（原生输出线 Phase 1：app/296-audio-output.js + core/audioOutput.js） */
  '输出': 'Output',
  '输出设备': 'Output Device',
  '声音输出到哪个设备，切换后即时生效': 'Which device audio plays through (applies immediately)',
  /* 「系统默认」复用上方既有词条，勿重复登记（no-dupe-keys 会拦） */
  '输出设备已切换': 'Output device switched',
  '应用未被允许使用该输出设备': 'This output device is not allowed for the app',
  '该输出设备已不可用': 'That output device is no longer available',
  '切换输出设备失败': 'Failed to switch the output device',
  /* WASAPI 独占输出（原生输出线 Phase 2b：app/298-native-output.js） */
  '独占输出': 'WASAPI Exclusive Output',
  '绕过系统混音器直通声卡。开启后由原生引擎接管播放，Automix 与变速暂不可用':
    'Bypass the system mixer and feed the sound card directly (bit-perfect). Playback is handed to the native engine; Automix and speed changes are unavailable',
  '当前环境不支持原生输出': 'Native output is not available in this environment',
  '原生输出不可用': 'Native output unavailable',
  '本机不支持独占输出': 'Exclusive mode does not work on this machine',
  '本机不支持独占输出，已保持系统默认输出':
    'Exclusive mode does not work on this machine; staying on the system default output',
  '已启用独占输出': 'WASAPI exclusive output enabled',
  '已关闭独占输出，恢复系统混音': 'WASAPI exclusive output disabled; back to the system mixer',
  '原生输出初始化失败，已回到浏览器播放':
    'Native output failed to start; playback fell back to the browser engine',
  '原生独占模式下 Automix 暂不可用，已临时让位':
    'Automix is unavailable under native exclusive output and has been suspended',
  '原生独占模式暂不支持变速，已按原速播放':
    'Native exclusive output does not support speed changes; playing at 1x',
  /* Automix 过渡态（app/289-next-up.js 的交叉期预告条） */
  '过渡中': 'Mixing',
  '正在交叉混音': 'Crossfading into the next track',
  '当前环境不支持选择输出设备': 'Selecting an output device is not supported here',
  '更多': 'More',
  '更多菜单': 'More Menu',
  '最小化': 'Minimize',
  '最大化': 'Maximize',
  '返回': 'Back',
  '返回到顶部': 'Back to Top',
  '返回榜单列表': 'Back to Charts',
  '清除': 'Clear',
  '清除全部': 'Clear All',
  '清空': 'Clear',
  '重置': 'Reset',
  '导出': 'Export',
  '导出全部': 'Export All',
  '收起': 'Collapse',
  '收起底部播放栏': 'Collapse bottom player bar',
  '展开底部播放栏': 'Expand bottom player bar',
  '下载': 'Download',
  '下载歌词': 'Download Lyrics',
  '分享码': 'Share Code',
  '缓存管理': 'Cache Management',
  '缓存清理': 'Cache Cleanup',
  '加载中...': 'Loading...',
  '未知歌曲': 'Unknown Song',
  '未知歌手': 'Unknown Artist',
  /* 歌手页（app/297-artist-page.js） */
  '热门歌曲': 'Top Songs',
  '专辑': 'Albums',
  '暂无作品': 'No tracks yet',
  '暂无专辑': 'No albums yet',
  '歌手信息暂时不可用': 'Artist info unavailable',
  '作品暂时拉不到，稍后再试': 'Tracks unavailable, try again later',
  '立即分析': 'Analyze Now',
  '立即分析当前歌曲': 'Analyze the current song now',
  '重新分析当前播放的歌曲': 'Re-analyze the current song',
  '未分析': 'Not Analyzed',
  '正在分析...': 'Analyzing...',
  '正在分析 0/0': 'Analyzing 0/0',
  '一键分析歌单主题': 'Analyze playlist theme',
  '智能情绪分析': 'Smart Emotion Analysis',
  '启用智能分析': 'Enable Smart Analysis',
  '播放时自动分析歌曲情绪并切换主题，关闭后使用手动主题': 'Auto-analyze song emotion and switch theme while playing',
  '清除智能主题，回到手动设置': 'Clear AI theme and revert to manual',
  '播放歌曲后将自动分析': 'Will analyze after playback starts',
  '立即检测': 'Test Now',
  '测试连接': 'Test Connection',
  '测试连通性': 'Test Connectivity',
  '连通性测试诊断': 'Connectivity Diagnostics',
  '发送一条短消息，测试接口是否可以正常使用': 'Send a short message to verify the API',
  '获取列表': 'Fetch Models',
  '可用模型列表': 'Available models',
  '推荐 gemini-1.5-flash，高速且额度充裕': 'gemini-1.5-flash recommended (fast, generous quota)',
  '选择 API 调用格式': 'Choose API call format',
  'API 地址': 'API Endpoint',
  'API 服务商': 'API Provider',
  '填写 API 地址或代理地址': 'Fill in the API endpoint or proxy URL',
  '启用反向代理': 'Enable Reverse Proxy',
  '反代访问令牌': 'Proxy Token',
  '反代访问令牌（可选）': 'Proxy Token (optional)',
  '留空 = 未启用令牌鉴权': 'Empty = token auth disabled',
  '中国大陆网络可直连，无需代理工具': 'Direct connection works in mainland China, no proxy needed',

  // 播放/音效/播放行为
  '播放行为': 'Playback Behavior',
  '播放方式': 'Play Mode',
  '启动时的播放方式': 'Play mode on startup',
  '启动时的播放速率': 'Playback rate on startup',
  '启动时应用的音量': 'Volume on startup',
  '启动时应用的均衡器预设': 'EQ preset on startup',
  '默认 EQ 预设': 'Default EQ Preset',
  '默认倍速': 'Default Speed',
  '默认音量': 'Default Volume',
  '倍速': 'Speed',
  '变速不变调': 'Preserve Pitch',
  '倍速时保持音调不变': 'Keep pitch when speed changes',
  '音量': 'Volume',
  '音量+': 'Vol +',
  '音量-': 'Vol -',
  '音量标准化': 'Volume Normalization',
  /* ★ 2026-10-05：空间音频（P2）+ 虚拟声场（P1）设置项。
     ★ 登记前先 grep：'中' / '轻' 等单字词已在别处登记，重复键会直接报 eslint
       no-dupe-keys。P1 那两条「独占输出下不可用」已随 P2 解除置灰而删除（不再被引用）。 */
  '空间音频': 'Spatial Audio',
  '用双耳 HRTF 卷积营造前后深度与定位感（建议使用耳机）': 'Binaural HRTF convolution adds front-back depth and localisation (best on headphones)',
  '轻：轻微染色；中：空间感明显；强：包围感最强': 'Light = subtle colouration; Medium = clearly spatial; Strong = maximum envelopment (wet/dry)',
  '空间类型': 'Space type',
  '近场：紧致；厅堂：更多早期反射；宽阔：声场最宽': 'Near = tight; Hall = more early reflections; Wide = strongest binaural decorrelation',
  '近场': 'Near',
  '厅堂': 'Hall',
  '宽阔': 'Wide',
  '强': 'Strong',
  '虚拟声场': 'Virtual Soundstage',
  '横向拉宽声场、提升器乐分离度（人声位置不变，耳机更明显）': 'Widen the soundstage and improve instrument separation (vocal stays centered; most noticeable on headphones)',
  '强度': 'Strength',
  '轻': 'Light',
  '轻 = 仅展宽；中 = 展宽 + 微延时包围感': 'Light = widening only; Medium = widening + micro-delay ambience',
  /* ★ 2026-10-05：输出声道（需求 20）+ AutoEQ PEQ 导入（需求 3）。
     ★ 登记前 grep 过：'导入' / '左' / '右' 已存在，勿重复登记（no-dupe-keys）。 */
  '输出声道': 'Output channels',
  '立体声（默认）、单声道、只听左或右、交换左右': 'Stereo (default) / Mono / Left only / Right only / Swap L-R. Pure routing, no effect on audio quality',
  '立体声': 'Stereo',
  '单声道': 'Mono',
  '交换': 'Swap',
  '导入 AutoEQ PEQ': 'Import AutoEQ PEQ',
  '粘贴 AutoEQ / Peace 导出的参数文本，自动折算为 10 段均衡设置': 'Paste a parametric EQ export from AutoEQ or Peace, folded onto the 10-band equalizer',
  '没有内容': 'Nothing to import',
  '未识别到任何滤波器，请检查格式': 'No filters recognised; check the format',
  '无法应用': 'Could not apply',
  '导入失败': 'Import failed',
  '导入完成': 'Import complete',
  /* ★ 2026-10-05：会话恢复（需求 17）。 */
  '记住播放进度': 'Remember playback position',
  '下次启动恢复上次的歌、进度与队列（异常退出也能恢复）': 'Restore the last song, position and queue on next launch (works after a crash too)',
  /* ★ 2026-10-05：存储空间（需求 13）+ 自动备份（需求 23）。
     ★ 登记前 grep 过：'刷新' / '选择' / '选择文件' / '确定' / '取消' 已存在，勿重复登记。 */
  '存储空间': 'Storage',
  '占用概览': 'Usage overview',
  '点「刷新」查看各类缓存占用': 'Press Refresh to see how much each cache takes',
  '总占用': 'Total',
  '高价值数据（清理需确认）': 'High-value data (confirmation required)',
  '可清理缓存': 'Rebuildable caches',
  '受保护（永不自动清理）': 'Protected (never auto-cleared)',
  '其他键': 'Other keys',
  '高价值': 'High value',
  '存储上限': 'Storage limit',
  '超过后自动清理最旧缓存（0 为不限；歌单、收藏与记录不清理）': 'Above this, the oldest caches are cleared automatically (0 = no limit; playlists, favourites and history are never cleared)',
  '清理缓存': 'Clear caches',
  '按占用从低价值到高价值清理；高价值数据会先确认': 'Clears from low-value to high-value; high-value data asks first',
  '清理到上限': 'Clear to limit',
  '已刷新': 'Refreshed',
  '未超过上限，无需清理': 'Under the limit, nothing to clear',
  '自动备份': 'Auto backup',
  '定期自动备份': 'Scheduled auto backup',
  '按间隔把收藏/歌单/设置/歌词偏移写入备份文件夹': 'Writes favourites, playlists, settings and lyric offsets to the backup folder on a schedule',
  '备份文件夹': 'Backup folder',
  '未选择': 'Not selected',
  '已选择': 'Selected',
  '当前环境不支持，将下载到默认位置': 'Not supported here; backups will be downloaded instead',
  '备份间隔': 'Backup interval',
  '小时': 'hours',
  '立即备份': 'Back up now',
  '上次：—': 'Last: —',
  '备份一次': 'Back up',
  '从备份恢复': 'Restore from backup',
  '选择之前导出的备份 JSON，恢复收藏/歌单/设置': 'Pick a previously exported backup JSON to restore favourites, playlists and settings',
  '已设置备份文件夹': 'Backup folder set',
  '请先选择备份文件夹': 'Pick a backup folder first',
  '当前环境不支持选择文件夹，备份将下载为文件': 'This environment cannot pick a folder; backups will be downloaded as files',
  '正在备份…': 'Backing up…',
  '已备份到所选文件夹': 'Backed up to the selected folder',
  '文件不是合法 JSON': 'Not a valid JSON file',
  '未识别到有效备份内容': 'No recognisable backup content',
  '已从备份恢复': 'Restored from backup',
  /* ★ 2026-10-05：存储清单里的分组/缓存名（storageManager 的 label，会直接显示在面板上）。
     ★ '收藏' / '歌单' 已存在，勿重复登记。 */
  '应用设置': 'App settings',
  '均衡器设置': 'Equalizer settings',
  '歌词偏移': 'Lyric offset',
  '播放会话': 'Playback session',
  '性能偏好': 'Performance preference',
  '界面偏好': 'Interface preference',
  'AI 情绪分析结果': 'AI mood analysis',
  '逐字对齐数据': 'Word-timing alignment',
  '高潮检测缓存': 'Chorus detection cache',
  '混音分析缓存': 'Mix analysis cache',
  '歌词索引': 'Lyric index',
  /* ★ 2026-10-05：歌词海报（需求 2）。登记前 grep 过：'默认' 已存在（勿重复），
     '格律'/'活字'/'霓虹'/'词云' 只以「XX · English」长键存在，短名是新键。 */
  '歌词海报': 'Lyric poster',
  '原画幅': 'Original',
  '保留播放器画面比例': 'Keep the player frame ratio',
  '无法获取当前画面': 'Could not capture the current view',
  '画面是空的，请先播放': 'The view is empty — start playback first',
  '方图': 'Square',
  '竖图': 'Portrait',
  '1:1 · 朋友圈 / Instagram': '1:1 · Moments / Instagram',
  '9:16 · 小红书 / 故事': '9:16 · RED / Stories',
  '请先播放一首歌': 'Play a song first',
  '正在生成歌词海报…': 'Generating lyric poster…',
  '海报已保存': 'Poster saved',
  /* 「已保存 / 下载已开始」是「打开文件所在位置」确认框的标题（core/revealPath.js
     与 85-rate-download.js），两个词条都要有英文，否则 i18n 棘轮会拦下来。 */
  '已保存': 'Saved',
  '下载已开始': 'Download started',
  '打开所在位置': 'Show in folder',
  '海报已保存（未取到封面）': 'Poster saved (cover unavailable)',
  '海报保存失败': 'Failed to save poster',
  '海报生成失败': 'Failed to generate poster',
  /* 海报右下角角标用的视觉模式短名（与样式选择器显示名一致） */
  '歌词': 'Lyrics',
  '飞白': 'Fly-In',
  '词云': 'WordCloud',
  '诗镜': 'Verse',
  '版画': 'Tempera',
  '格律': 'Mondrian',
  '穿行': 'Tunnel',
  '活字': 'Letterpress',
  '霓虹': 'Neon',
  /* ★ 2026-10-05：应用诊断页「音频输出与音效链路」段（专治「有时候放歌没声音」）。
     登记前先 grep 过：'正常' / '音量' / '静音' / '正在播放' / '无' / '开' / '关' / '是' / '否'
     均已存在，勿重复登记（no-dupe-keys）。 */
  '音频输出与音效链路': 'Audio output & effects chain',
  '音频链路': 'Audio chain',
  '输出去向': 'Output path',
  '独占输出（原生引擎，绕过系统混音器）': 'WASAPI exclusive (native engine; audio bypasses the Web Audio graph)',
  '共享输出（WebView2 音频图）': 'Shared output (WebView2 audio graph)',
  '音频引擎状态': 'AudioContext state',
  '无（音效图从未建立）': 'none (graph never built)',
  '采样率': 'Sample rate',
  '音效图': 'Effects graph',
  '未建立（没开过均衡器 / 虚拟声场 / 空间音频）': 'not built (EQ / virtual soundstage / spatial audio never enabled)',
  '初始化失败（本进程内不会出声，请重启 Aria）': 'initialisation failed (no sound for this process; restart Aria)',
  '已建立': 'built',
  '已拆（元素仍被捕获，靠直连旁通保声；此时音效不生效）': 'torn down (element still captured → passthrough keeps sound; effects inactive)',
  '元素已改道进音效图': 'Element routed into the effects graph',
  'deck 增益（非交叉期应为 1.000）': 'deck gain (should be 1.000 outside crossfade)',
  '音频元素': 'Audio element',
  '原生 deck（nativeDeck）': 'native deck (nativeDeck)',
  '播放状态': 'Playback state',
  '已暂停': 'Paused',
  '元素音量': 'Element volume',
  '元素静音 muted': 'Element muted',
  '解码/网络错误': 'Decode / network error',
  '当前音源': 'Current source',
  '未取得（播放链路可能未初始化）': 'unavailable (playback chain may not be initialised)',
  '链路判定': 'Chain verdict',
  '检测到可能静音的因素：从上往下看第一处非 ok 项': 'Possible mute factor detected: check the first non-ok row above',
  '未发现静音因素': 'No mute factor found',
  '异常（详见下面「音频输出与音效链路」段）': 'abnormal (see the "Audio output & effects chain" section below)',
  '没有声音时先看这几项：音频引擎未运行、音效图已拆除、输出增益为 0，都会让界面看起来正常却没有声音。': 'For "sometimes no sound": check this section first. A non-running AudioContext, a captured element whose effects graph was torn down, or a deck gain of 0 will all leave the UI perfectly normal while producing no sound at all.',
  /* ★ 2026-10-05：音源状态面板（需求 1）+ 听力健康提醒（需求 16）。
     ★ 登记前已 grep：'QQ 音乐' / '酷狗音乐' / '网易云音乐' / '汽水音乐' 四个词**已存在**，不再登记。 */
  '音源状态': 'Source status',
  '音源连通性': 'Source connectivity',
  '向各音源接口发一次轻量请求，显示成功失败与延迟': 'Send one lightweight request to each source and report success/failure with latency',
  '测试': 'Test',
  '测试中…': 'Testing…',
  '超时': 'Timeout',
  '不可达': 'Unreachable',
  '探测失败': 'Probe failed',
  '点「测试」向各音源发一次轻量请求': 'Click "Test" to send one lightweight request to each source',
  '个音源不可用': 'sources unavailable',
  '本机主服务': 'Local service',
  '公网兜底（vkeys）': 'Public fallback (vkeys)',
  '听力健康提醒': 'Hearing health reminder',
  '连续播放 2 小时或音量长时间偏高时温和提示，不打断播放': 'A gentle nudge after 2 hours of continuous playback or sustained high volume; never interrupts playback',
  '已经连续播放 2 小时了，建议歇一会儿，让耳朵透透气': "You've been playing for 2 hours straight — take a break and let your ears breathe",
  '音量偏高已持续 30 分钟': 'Volume has stayed high for 30 minutes',
  '自动播放下一曲': 'Auto-play Next',
  '播放结束后自动切换': 'Auto-advance after playback',
  '切歌淡入淡出': 'Crossfade',
  '智能混音（Automix）': 'Automix',
  '歌尾与下一曲开头无缝交叉（本地/缓存源）': 'Seamless crossfade into the next track (local/cached sources)',
  '切歌时自动调整音量到默认值': 'Reset volume to default on song change',
  '播放失败重试': 'Retry on Failure',
  '最大重试次数': 'Max Retries',
  '重试次数': 'Retries',
  '加载失败时自动重试': 'Auto-retry when loading fails',
  '每次跳转秒数': 'Seek Step (seconds)',
  '前进/后退': 'Forward / Rewind',
  'Ctrl + ← / → 快速前进/后退': 'Ctrl + ← / → to seek',

  // 均衡器
  '打开均衡器': 'Open Equalizer',
  '打开均衡器面板': 'Open the equalizer panel',
  '手动调节 10 段音频均衡器': 'Manually tune the 10-band equalizer',
  '复制 EQ 分享码': 'Copy EQ Share Code',
  '粘贴 EQ 分享码导入': 'Paste EQ share code to import',

  // 背景与外观
  '背景效果': 'Background Effects',
  '背景模糊': 'Background Blur',
  '背景颜色': 'Background Color',
  '背景高斯模糊程度': 'Background gaussian blur',
  '全局主题色': 'Global Theme Color',
  '主色调': 'Primary Color',
  '当前主题': 'Current Theme',
  '恢复默认主题': 'Restore Default Theme',
  '全局渲染缩放': 'Global Render Scale',
  '全局设置': 'Global Settings',
  '当前配置效果': 'Current config preview',
  '界面磨砂模糊半径': 'Frosted blur radius',
  '控制全局所有模式的控件、按钮、开关与强调色': 'Controls, buttons, switches & accents across modes',
  '恢复到推荐性能档位或出厂默认配置': 'Restore recommended tier or factory defaults',
  '恢复推荐配置': 'Restore Recommended',
  '恢复出厂配置': 'Factory Reset',
  '恢复默认快捷键': 'Restore Default Shortcuts',
  '自动检测配置': 'Auto-detected Config',
  '根据硬件跑分自动推荐最佳设置': 'Auto-recommend best settings by hardware benchmark',
  '硬件信息': 'Hardware Info',
  '显卡': 'GPU',
  'CPU 核心': 'CPU Cores',
  '内存': 'Memory',
  '屏幕分辨率': 'Screen Resolution',
  '性能等级': 'Performance Tier',
  '高性能': 'High',
  '中性能': 'Medium',
  '低性能': 'Low',
  '极简': 'Minimal',
  '性能配置': 'Performance Config',
  '视觉开销': 'Visual Cost',
  '专注模式 · 已开启（点击退出，控件立即唤回）': 'Focus mode on — click to bring the controls back',
  '专注模式（只留歌词，其余控件淡出）': 'Focus mode: hide everything but the lyrics',
  '在所选性能等级基础上微调各模式特效开销': 'Fine-tune per-mode effects on top of the selected tier, effective immediately',
  '选择适合您电脑配置的预设': 'Pick a preset that fits your hardware',
  '重置性能配置': 'Reset Performance Config',
  '降低时以更低分辨率渲染 3D 视觉效果': 'Render 3D visuals at lower resolution when lowered',
  '降低时以更低分辨率渲染 3D 特效（浮空、PV、隧道）': 'Lower-res 3D rendering (aurora / PV / tunnel canvas)',
  // 动效强度滑杆（todos #6）：core/vfxIntensity.js 的说明行 + 设置页这一行
  '动效强度': 'Motion Intensity',
  '一根滑杆总控特效开销：0 只保留逐字高亮，100 为全部特效；下方单项开关优先生效。': 'One slider instead of four tiers: 0 = per-character highlight only, no background blur or particles; 100 = every effect. The per-item switches below take precedence over this slider.',
  '当前跟随档位': 'Following tier',
  '当前跟随档位「中性能」': 'Currently following the Medium tier',
  '等效': 'equivalent to',
  '跟随': 'Follow',
  '跟随等级': 'Follow Tier',
  '已改为跟随性能等级': 'Now following the performance tier',
  '只保留逐字高亮，不做背景模糊与粒子': 'per-character highlight only, no background blur or particles',
  '渲染分辨率': 'Render Resolution',
  '歌词模糊': 'Lyric Blur',
  'PV 发光': 'PV Bloom',
  '飞入光晕': 'Fly-in Glow',
  '词云跟焦': 'Word-cloud Focus',
  '隧道粒子': 'Tunnel Particles',
  '浮空粒子': 'Aurora Particles',
  '发光阴影强度': 'Glow Shadow Intensity',
  '情感词发光强度': 'Emotion Glow Strength',
  '情感词唱响时的强调色': 'Accent color when emotion words sing',
  '控制非情感词普通高亮文字颜色': 'Color of normal (non-emotion) highlighted text',
  '非高亮歌词行颜色': 'Inactive lyric line color',
  '非活动行暗淡': 'Dim Inactive Lines',
  '非活动行模糊': 'Blur Inactive Lines',
  '歌词模糊强度': 'Lyric Blur Strength',
  '高亮行未高亮部分': 'Unsung part of active line',

  // 歌词
  '歌词字体大小': 'Lyric Font Size',
  '歌词对齐': 'Lyric Align',
  '歌词偏移（秒），正=延迟，负=提前': 'Lyric offset (s), positive = delay, negative = advance',
  '歌词延迟': 'Lyric Delay',
  '歌词提前': 'Lyric Advance',
  '行间距': 'Line Height',
  '选择歌词来源': 'Lyric Source',
  '切换歌词来源': 'Switch lyric source',
  // 取链透明化（todos #15）：角标 / 详情面板 / 渠道与音质名
  '取链详情': 'Stream source',
  '查看这首歌的取链来源与降级过程': 'See which source resolved this track and how it fell back',
  '命中渠道': 'Resolved via',
  '实际接口': 'Provider',
  '容器': 'Container',
  '缓存': 'Cache',
  '命中 15 分钟解析缓存': 'Served from 15-min resolve cache',
  '解析池逐源尝试': 'Resolve-pool attempts',
  // 睡眠定时器（todos #1，280-sleep-timer.js）
  '睡眠定时器': 'Sleep timer',
  /* 单句 / A-B 循环（todos #3，294-ab-loop.js）。提示走 setHint，
     而 hint 条不在 UI_ROOT_SELECTOR 内，所以这些键由 t() 在 JS 侧直接查。 */
  '单句循环': 'Loop line',
  'A-B 循环': 'A-B loop',
  '单句循环已开启': 'Line loop on',
  'A-B 循环已开启': 'A-B loop on',
  '已取消循环': 'Loop cleared',
  '当前没有可循环的歌词行': 'No lyric line to loop',
  '循环区间无效': 'Invalid loop range',
  'A 点已标记，再按一次标记 B': 'A set — press again to set B',
  'B 必须晚于 A，已重置': 'B must come after A',
  '单句循环中': 'Line looping',
  'A-B 循环中': 'A-B looping',
  '已标记 A，等待 B': 'A marked',
  '自定义分钟数': 'Custom minutes',
  '减少一分钟': 'One minute less',
  '增加一分钟': 'One minute more',
  '启动': 'Start',
  '取消定时': 'Cancel timer',
  '未设置': 'Not set',
  '分钟': 'min',
  '最后 1 分钟自动渐弱，到点暂停播放（队列保留）': 'Volume fades over the last minute; playback pauses at zero (queue kept)',
  /* 280 自带 bilingual STR 表按语言组句（含 {t}/{m} 占位符的那几条走不了整句精确匹配，
     仍由 STR 负责）；这里登记的是**无占位符**的整句，让全库词表对它们也有账。 */
  '睡眠定时器已取消': 'Sleep timer cancelled',
  '睡眠定时器到点，已暂停播放（队列已保留）': 'Sleep timer: playback paused (queue kept)',
  // OSD 屏幕浮层（todos #14，281-osd.js）
  '快进': 'Forward',
  '快退': 'Rewind',
  '正常': 'Normal',
  /* —— 应用内诊断页（todos #21，284-diagnostics.js）——
     2026-09-26 起该分片不再自带词表（原来是一张私有 PHRASE_EN），面板整页由 JS
     渲染、逐条走 translatePhrase()，所以它的文案全部登记在这里。
     ★ 与既有键同名的 18 条（音质/耗时/性能档位/应用诊断/是/否/在线/失败…）
       保留的是**词表里既有位置**的英文值，没有被 284 的写法覆盖：同一个中文串在全库
       只能有一个英文说法，否则同一个词在两个面板里长得不一样。 */
  '应用诊断': 'App diagnostics',
  /* 面板骨架 */
  '刷新': 'Refresh',
  '复制诊断文本': 'Copy diagnostics',
  '已复制': 'Copied',
  '采集中…': 'Collecting…',
  '采集失败': 'Collection failed',
  /* 作用域徽标 */
  '浏览器环境': 'Browser',
  '本机 Python 服务': 'Local Python server',
  '本机自建 vendor': 'Local self-hosted vendor',
  '渠道决定': 'Varies by channel',
  /* 结论摘要 */
  '结论摘要': 'Summary',
  '本页数据仅反映当前设备与本次运行；更换设备后请重新打开本页。': 'This page reflects only this device and this run. Frame times on a dev machine do not represent a VM or a GPU-less box — reopen it on the device in question.',
  '软件渲染（纯 CPU）已识别': 'Software rendering (CPU only)',
  '页面帧时中位': 'Median page frame time',
  '本机主服务未响应': 'Local server down',
  /* 运行环境 */
  '运行环境': 'Runtime environment',
  '外壳': 'Shell',
  '桌面壳（Tauri）': 'Desktop shell (Tauri)',
  '纯浏览器': 'Plain browser',
  '页面地址': 'Page URL',
  '浏览器 UA': 'User agent',
  '平台': 'Platform',
  '界面语言': 'UI language',
  '网络': 'Network',
  '在线': 'online',
  'CPU 逻辑核': 'CPU logical cores',
  '设备内存': 'Device memory',
  'JS 堆': 'JS heap',
  '屏幕': 'Screen',
  '视口': 'Viewport',
  '标签页可见': 'Tab visible',
  '当前视觉模式': 'Current visual mode',
  '未知（浏览器未提供）': 'unknown (not exposed by browser)',
  /* 显卡 */
  '显卡与渲染后端': 'GPU & render backend',
  'WebGL renderer 原文': 'WebGL renderer (raw)',
  '未获取': 'not available',
  '清洗后显卡名': 'GPU name (cleaned)',
  '是否有 WebGL': 'WebGL available',
  '软件渲染标记': 'Software-renderer marker',
  '有': 'present',
  '无': 'absent',
  '低端/集显判定': 'Low-end GPU verdict',
  '显卡分级': 'GPU tier',
  '硬件评分': 'Hardware score',
  '硬件推荐档位': 'Hardware-recommended profile',
  '内存/核': 'Memory / cores',
  '探测时间': 'Detected at',
  '本次读取启动快照（未重新探测）': 'boot snapshot (not re-probed)',
  '本次新探测': 'probed now',
  /* 档位与 vfx */
  '性能档位与 vfx 实际值': 'Performance profile & effective vfx',
  '当前档位': 'Active profile',
  '是否手动设定': 'Manually configured',
  '手动档时自动检测会被跳过': 'auto detection is skipped while a manual profile is set',
  '检测出的 FPS': 'Measured FPS (base/stress/used)',
  'body 性能 class': 'body perf class',
  '视觉开销手动覆盖': 'Manual vfx overrides',
  '无（全部按档位矩阵）': 'none (profile matrix only)',
  '手动覆盖': 'manual override',
  '已生效设置（appSettings）': 'Effective settings (appSettings)',
  '开': 'on',
  '关': 'off',
  '渲染缩放 renderScale': 'renderScale',
  '封面模糊 coverBlur': 'coverBlur',
  '玻璃模糊 glassBlur': 'glassBlur',
  '歌词模糊 lyricBlur': 'lyricBlur',
  '文字光晕 textBlur': 'textBlur',
  'PV 泛光 pvBloom': 'pvBloom',
  '飞入辉光 flyinGlow': 'flyinGlow',
  '词云粒子 wcParticles': 'wcParticles',
  '隧道粒子 tunnelParticles': 'tunnelParticles',
  '景深粒子 dimParticles': 'dimParticles',
  /* 帧时 */
  '帧时（实时采样）': 'Frame time (live sampling)',
  '在跑的 rAF 循环': 'Running rAF loops',
  '个，其中引擎': 'loops, engines',
  '已登记源': 'Registered sources',
  '空闲': 'idle',
  '每源保留帧数': 'Frames kept per source',
  '帧': 'frames',
  '记为挂起': 'counted as a gap',
  '无样本': 'no samples',
  '未运行': 'idle',
  '运行中': 'running',
  '中位': 'median',
  '最大': 'max',
  '样本': 'samples',
  '挂起': 'gaps',
  '未埋点的引擎只有内置心跳。': 'Per-engine rows need one frameProbe.frame(name) call inside each engine rAF loop; without it only the built-in heartbeat shows.',
  /* 帧时源标签（由各引擎的 registerLoop/frame 埋点写死中文，这里过词表） */
  '页面全局帧时（内置心跳）': 'Page frame time (built-in heartbeat)',
  '歌词逐字高亮循环': 'Lyrics word-highlight loop',
  '歌词弹簧/波纹循环': 'Lyrics spring & wave loop',
  'PV 主循环': 'PV main loop',
  'PV 背景丝绸': 'PV background silk',
  '维度视觉化循环': 'Dimension visualizer loop',
  '预览引擎循环': 'Preview engine loop',
  '移动端逐字进度': 'Mobile word progress',
  '音量淡变循环': 'Volume fade loop',
  '睡眠定时淡出': 'Sleep-timer fade',
  /* 启动耗时 */
  '启动耗时分解': 'Boot timing breakdown',
  '导航类型': 'Navigation type',
  '协议': 'Protocol',
  'DNS 解析': 'DNS lookup',
  'TCP 连接': 'TCP connect',
  'TLS': 'TLS',
  '首字节 TTFB': 'TTFB',
  'DOM 完成': 'DOM content loaded',
  'load 事件结束': 'load event end',
  '未完成': 'not finished',
  '文档传输': 'Document transfer size',
  '资源请求数': 'Resource requests',
  '资源总传输': 'Total transferred',
  '脚本请求': 'Scripts',
  '最大资源': 'Largest resource',
  '浏览器资源计时缓冲已满或未开放': 'Resource timing buffer full or unavailable',
  /* 分词库 */
  '分词库加载状态': 'Segmentation libraries',
  '中文 segmentit': 'Chinese segmentit',
  '日文 kuromoji': 'Japanese kuromoji',
  '已就位': 'loaded',
  '未加载': 'not loaded',
  '延迟加载器': 'Lazy loader hook',
  '已注入脚本': 'Injected script tags',
  '日文词典分片': 'Japanese dictionary chunks',
  'Intl.Segmenter 兜底': 'Intl.Segmenter fallback',
  '可用': 'available',
  '不可用': 'unavailable',
  '日文词典未下载属正常：只有真的出现日文歌词才拉（约 17MB）。': 'The Japanese dictionary staying undownloaded is normal: it is fetched only when Japanese lyrics actually appear (~17MB).',
  /* vendor */
  '本机服务与 vendor': 'Local services & vendors',
  '主服务 :8001': 'Main server :8001',
  '正常返回': 'responding',
  '无响应（未启动 / 绿色版路径异常）': 'no response (not started, or portable path issue)',
  '查询异常': 'status query failed',
  '配置后端标记': 'Config backend flag',
  '本地服务': 'local service',
  '登录态': 'Login',
  '平台开关': 'Toggle',
  '已启用': 'enabled',
  '未启用': 'disabled',
  '本地组件缺失（未运行安装脚本）': 'Local component missing (installer not run)',
  '公网上游不主动探测（探测会让面板卡住数秒），请看下一段的实际渠道。': 'Public upstreams (vkeys/ygking/byfuns) are not probed on purpose: when they die they time out and would stall this panel for seconds. Check the actual channel in the next section.',
  /* 取链 */
  '取链详情（最近一次）': 'Playback resolve (latest)',
  '当前歌曲': 'Current song',
  '未在播放': 'nothing playing',
  '角标': 'Badge',
  '无取链记录': 'no resolve recorded',
  '命中渠道层级': 'Channel tier',
  '结果': 'Result',
  '逐源尝试': 'Provider attempt',
  '成功': 'ok',
  '本次取链日志': 'Resolve log line',
  '无日志（第一级就命中）': 'no log lines (first channel hit)',
  '其它模块告警': 'Other module warnings',
  '暂无告警': 'no warnings yet',
  '直链是临时签名地址：本页只输出域名与路径尾段，不输出完整链接与参数。': 'Play URLs are temporarily signed: only host and path tail are emitted, never the full link or its query.',
  '本机自建': 'self-hosted',
  '本机解析': 'local resolver',
  '平台官方接口': 'official API',
  '公网上游': 'public upstream',
  '跨源兜底': 'cross-source fallback',
  '直链/本地': 'direct/local',
  '未知': 'unknown',
  /* 全局键 */
  '全局状态登记表': 'Global state registry',
  '登记键': 'Registered keys',
  '未定义键': 'Undefined keys',
  '未定义键名': 'Undefined key names',
  '多写键': 'Multi-writer keys',
  '只读取当前全局变量，未做全量审计（避免挤掉取链轨迹）': 'Read-only listGlobals(); auditGlobals() is not called because it would flood the log ring and push out the resolve trail.',
  /* 表外补登记：原来写死在渲染处的三元分支与常量表 */
  '酷狗 KuGouMusicApi': 'KuGou KuGouMusicApi',
  '网易云音乐 NeteaseCloudMusicApi': 'Netease NeteaseCloudMusicApi',
  '正在检索酷狗 / 网易云音乐 / QQ / LRCLIB…': 'Searching KuGou / Netease / QQ / LRCLIB…',
  'QQ 日推可能需要登录，可切到网易云音乐/酷狗': 'QQ daily mix may require login — try Netease or KuGou',
  '重新采集数据': 'Reload diagnostics',
  '复制为纯文本，便于粘贴到 issue': 'Copy as plain text for an issue report',
  // 可读性一键修正（todos #11，283-readability.js）
  '歌词可读性增强': 'Lyrics readability boost',
  '歌词可读性增强 · 已开启（点击关闭）': 'Readability boost on (click to turn off)',
  '歌词可读性增强已开启：描边、底衬、压暗背景': 'Readability boost on: outline, backing, dimmed backdrop',
  '歌词可读性增强已关闭': 'Readability boost off',
  // 专注模式（todos #7，282-zen-mode.js）
  '专注模式': 'Focus mode',
  '启用专注模式': 'Enable focus mode',
  '只留歌词与背景，其余控件淡出': 'Fade everything out but the lyrics and the background',
  '鼠标静止后自动进入': 'Enter automatically when idle',
  '停止操作若干秒后淡出控件，动一下鼠标立即唤回': 'Fades the controls out after a few idle seconds; any pointer motion brings them back',
  '静止判定时长': 'Idle delay',
  '多少秒无操作后进入专注模式（1~60 秒）': 'Seconds of no activity before entering (1-60s)',
  '隐藏范围': 'What gets hidden',
  '默认只隐藏右上角图标组、底部控制条与播放信息列': 'By default: top icons, bottom bar and the cover/info column only',
  '右上角图标组': 'Top icon row',
  '底部控制条': 'Bottom control bar',
  '播放信息列（封面 / 歌名 / 主控制区）': 'Cover & info column',
  '桌面端标题栏': 'Desktop title bar',
  '歌词延时控件': 'Lyric offset control',
  '专注模式：动一下鼠标即可唤回控件': 'Focus mode: move the pointer to bring the controls back',
  '已关闭专注模式': 'Focus mode is off',
  /* 282 自带 bilingual STR 表（同 280：无占位符的整句在这里也记一笔账） */
  '点击按键后按下新键，Esc 取消': 'Click the chip, then press a new key; Esc cancels',
  '该按键已被其它功能占用': 'That key is already bound to another action',
  /* 282 zen 2026-09-27 重设计（删静止自动进入；封面竖直下移居中；按钮 FLIP 到右上角） */
  '歌名歌手与主控制区': 'Title, artist & main controls',
  '隐藏控件与播放队列；封面与歌词留在画面': 'Hide controls and the queue; the cover and lyrics stay',
  '进入专注模式': 'Enter focus mode',
  '退出专注模式': 'Exit focus mode',
  '先点这里，再按下要绑定的按键；按 Esc 放弃': 'Click here first, then press the key to bind; Esc to give up',
  // 双语排版一键循环（todos #4，285-bilingual-cycle.js）
  '双语排版': 'Bilingual layout',
  '原文': 'Original',
  '原文+译文': 'Orig + Trans',
  '原文+音译': 'Orig + Romaji',
  '三行': 'All 3 lines',
  '歌词排版：只看原文': 'Lyrics layout: original only',
  '歌词排版：原文 + 译文': 'Lyrics layout: original + translation',
  '歌词排版：原文 + 音译': 'Lyrics layout: original + romaji',
  '歌词排版：三行全显示': 'Lyrics layout: all three lines',
  '这首歌没有译文，已跳过带译文的排版': 'This song has no translation, so that layout was skipped',
  '这首歌没有音译，已跳过带音译的排版': 'This song has no romaji, so that layout was skipped',
  '这首歌既没有译文也没有音译，已跳过带它们的排版': 'This song has neither translation nor romaji, so those layouts were skipped',
  '这首歌只有原文，没有可叠加的译文或音译': 'This song only has the original line, nothing to layer on',
  '当前没有歌词，排版偏好已保存（下一首生效）': 'No lyrics loaded; layout preference saved (applies to the next song)',
  '耗时': 'Elapsed',
  '链接域名': 'Host',
  '降级轨迹': 'Fallback trace',
  '本次取链没有留下日志（说明第一级就命中了）': 'No log for this run — the first attempt already hit',
  '尚未记录到取链过程': 'Nothing recorded yet',
  /* 275-play-source（取链详情面板）：整段是 `html += '<div …>状态</div>'` 拼出来的，
     文本节点就是这几个短词，所以按词登记而不是按整坨 HTML。 */
  '（当前未播放歌曲）': '(nothing playing)',
  '状态': 'Status',
  '命中': 'hit',
  '全部渠道失败': 'All sources failed',
  '尚未取链': 'Not resolved yet',
  '取链失败': 'Resolution failed',
  /* 角标的三种「还没有结果」状态（services/playSource.js describeBadge）。
   ★ 角标在底栏 .bottom-song-meta-row 里，而底栏不在 UI_ROOT_SELECTOR 内，
     所以这三条不会被 observer 自动翻——登记是为了「取链详情」弹窗里复用同样的词，
     以及不欠账（约束 7）。 */
  '正在获取…': 'Resolving…',
  '重试中': 'Retrying',
  '兜底': 'fallback',
  '本机自建 QQ 服务': 'Self-hosted QQ',
  '本机自建网易服务': 'Self-hosted Netease',
  '本机自建酷狗服务': 'Self-hosted KuGou',
  '本机自建汽水服务': 'Self-hosted Soda',
  '汽水音乐 qishui-music-api': 'Soda qishui-music-api',
  '本机解析池': 'Local resolve pool',
  '酷狗取链接口': 'KuGou API',
  '酷我官方取链': 'KuWo official',
  'ygking 公网接口': 'ygking (public)',
  'vkeys 预取链接': 'vkeys prefetched',
  'vkeys 公网接口': 'vkeys (public)',
  'byfuns 公网接口': 'byfuns (public)',
  '网易云外链': 'Netease outer link',
  '跨源·酷狗同名歌': 'Cross-source KuGou',
  '跨源·网易同名歌': 'Cross-source Netease',
  '跨源·酷我同名歌': 'Cross-source KuWo',
  '歌曲自带直链': 'Track-provided link',
  '未知渠道': 'Unknown source',
  '母带': 'Master',
  '臻品全景声': 'Immersive',
  '极高 320k': 'Very high 320k',
  '较高 192k': 'Higher 192k',
  '标准 128k': 'Standard 128k',
  '显示/隐藏歌词': 'Show/Hide Lyrics',
  '切换播放/歌词页': 'Toggle Play / Lyrics page',
  '播放/暂停': 'Play / Pause',
  '上一曲': 'Previous',
  '下一曲': 'Next',

  // 各视觉模式描述（外观页卡片区）
  '封面与歌词并排显示，完整控制栏': 'Cover & lyrics side by side with full controls',
  '全屏歌词显示，底部迷你控制栏': 'Full-screen lyrics with mini control bar',
  '深色极简，逐字飞入发光': 'Dark minimal with glowing word fly-in',
  '二维词云排版，镜头阻尼跟焦，逐字填充': '2D word-cloud layout, damped camera focus, per-word fill',
  '3D空间粒子流体，主题色律动，景深运镜': '3D particle fluid, theme-color rhythm, depth camera',
  '日系排版，网点半调质感，平滑运镜与多层视差': 'Japanese editorial, halftone texture, smooth camera & parallax',
  '蒙德里安风格色块拼画，按句意分块 + 8 种几何构图，词块贴合色块并碰撞避让': 'Mondrian color-block collage, semantic blocks + 8 geometric layouts',
  '深夜街角灯牌，未唱的字是熄灭灯管，唱到的字逐字通电点亮，段落情绪换灯色与功率': 'Midnight neon sign: unsung tubes stay dark, sung words light up per emotion',
  '铅字版面排版，唱到的字逐字压印上墨，段落情绪换纸色': 'Letterpress typeset: sung words inked in, paper color follows emotion',
  '逐句情感标注 · 构图配色随情绪编排': 'Per-line emotion tagging · layout & palette follow mood',
  '构图池按段落情绪分池轮换 · hero 竖柱': 'Composition pool rotates by section mood · hero pillars',
  '上游式分镜': 'Upstream-style storyboard',
  '逐字 / PV 分镜 / 活字 / 霓虹 / 蒙德里安 / 隧道…': 'Per-word / PV shots / Letterpress / Neon / Mondrian / Tunnel...',
  '9 种歌词视觉': '9 lyric visuals',
  '穿行 · Tunnel': 'Tunnel',
  '云涌 · WordCloud': 'Word Cloud',
  '本地优先的多源歌词播放器 · 网页版 + Tauri 桌面壳': 'Local-first multi-source lyric player · Web + Tauri desktop',
  '本地音乐 · 歌单导入 · 均衡器 · RTL 适配': 'Local music · playlist import · EQ · RTL support',
  'QQ / 酷狗 / 网易 / 酷我 · 自建服务高音质': 'QQ / KuGou / Netease / Kuwo · self-hosted hi-fi',
  '开源歌词视觉项目 · 「诗镜 · Verse」与「版画 · Tempera」引擎的代码来源（AGPL-3.0）': 'Open-source lyric visual project · source of the code for our Verse and Tempera engines (AGPL-3.0)',
  '字体：思源黑体 / 思源宋体（Noto CJK，SIL OFL）· 霞鹜系列 · Cubic 11　·　© 2026 Aria Lyrics Player　·　本程序按 AGPL-3.0 发布，源码见 github.com/zsjsll114/Aria': 'Fonts: Noto Sans/Serif SC (Noto CJK, SIL OFL) · LXGW family · Cubic 11 · © 2026 Aria Lyrics Player · Released under AGPL-3.0, source at github.com/zsjsll114/Aria',
  '享受音乐': 'Enjoy Music',
  '点击进入音乐世界': 'Click to enter',

  // PV / 视觉参数
  '默认焦距': 'Focal Length',
  '镜头特写)': 'Close-up)',
  '初始缩放比例': 'Initial Scale',
  '大字形模式，1.0x 约为屏宽 5.5%': 'Large-type mode, 1.0x ≈ 5.5% of viewport width',
  '活字是大字形模式，1.0x 约为屏宽 6%': 'Letterpress large-type mode, 1.0x ≈ 6% of viewport width',
  '字体随机 Min': 'Font Random Min',
  '字体随机 Max': 'Font Random Max',
  '字体：思源黑体 / 思源宋体': 'Fonts: Noto Sans / Noto Serif',
  '活泼排版': 'Dynamic Layout',
  '允许词块倾斜）': 'tilt blocks)',
  '手动微调）': 'manual tuning)',
  'PV 发光效果': 'PV Glow Effect',
  '场景过渡时长': 'Scene Transition',
  '歌词场景过渡时长': '',
  '螺旋排版间距': 'Spiral Spacing',
  '词云相机跟焦': 'Word-cloud Camera Focus',
  '关闭后排布/高亮保持不变，仅停用逐帧镜头跟焦': 'Off = keep layout & highlight, disable per-frame camera focus',
  '显示回响装饰字': 'Show Echo Deco Words',
  '控制回响描边字与构图辅助线颜色': 'Color of echo outline words & guide lines',
  '显示背景流光': 'Show Background Streaks',
  '关闭流光隧道背景的 3D 粒子层': 'Disable tunnel background 3D particle layer',
  '隧道粒子层': 'Tunnel Particles',
  '浮空粒子与阴影': 'Aurora Particles & Shadow',
  '关闭后浮空点阵粒子减半且不绘制阴影': 'Halve aurora particles and skip shadows',
  '控制浮空粒子背景色调': 'Tint of aurora particle background',
  '控制飞入背景装饰图形颜色': 'Color of fly-in background decorations',
  '按压辉光': 'Press Glow',
  '钢印按下时墨晕的扩散强度': 'Ink spread when letterpress presses',
  '灯管辉光': 'Tube Glow',
  '点亮字符最外层光晕的扩散半径': 'Spread radius of the outermost glow on lit characters',
  '浮空/PV/隧道 Canvas）': 'aurora/PV/tunnel canvas)',

  // 字体管理
  '全局与高级字体': 'Global & Advanced Fonts',
  '当前生效的主界面字体': 'Currently active UI font',
  '已安装自定义字体': 'Custom fonts installed',
  '上传与持久化字体': 'Upload & persist fonts',
  '安装、删除自定义字体或配置多语言字体': 'Install/remove custom fonts or configure per-language fonts',
  '前往字体设置': 'Go to Font Settings',
  '字体与排版快捷入口': 'Font & typography shortcuts',
  '选择文件': 'Choose File',
  '点击或将字体文件拖拽至此处上传': 'Click or drop font files here to upload',
  '支持 MP3, WAV, FLAC, M4A, OGG, AAC, WEBM': 'Supports MP3, WAV, FLAC, M4A, OGG, AAC, WEBM',
  '上传音频': 'Upload Audio',
  '听歌识曲 (麦克风录音 / 上传音频)': 'Song Recognition (mic / upload)',
  '点击或将音频文件拖拽至此处识曲': 'Click or drop an audio file to recognize',
  '点击开始录音': 'Click to start recording',
  '点击按钮开始录音，再次点击停止并开始识别': 'Click to record, click again to stop & recognize',
  '麦克风录音': 'Microphone',
  'Shazam 声学指纹': 'Shazam Fingerprint',
  '正在提取声学指纹与特征比对...': 'Extracting fingerprint & matching...',

  // 桌面歌词
  '独立窗口 · 点击穿透 · 逐字本地插值': 'Standalone window · click-through · local per-word interpolation',
  '桌面歌词窗口的文字大小': 'Desktop lyrics font size',
  '翻译区字号': 'Translation Font Size',
  '翻译区距底边距': 'Translation Bottom Margin',
  '飞入位移距离': 'Fly-in Distance',
  '淡入淡出时长': 'Fade Duration',
  '毫秒': 'ms',
  '秒': 's',
  '秒)': 's)',

  // 手机遥控器页（remote.html）
  '连接中…': 'Connecting…',
  '已连接': 'Connected',
  '已连接 · 未播放': 'Connected · Idle',
  '已断开': 'Disconnected',
  '主窗未响应': 'Player not responding',
  '遥控器后端未启用': 'Remote backend not enabled',
  '服务器未开放遥控通道：以 --lan 参数启动服务后可用。': 'The local server has no remote channel yet: start it with "python server.py --lan".',
  '无法连接服务器：请确认手机与电脑在同一网络，且电脑端以 --lan 启动服务。': 'Cannot reach the server: phone and PC must be on the same Wi-Fi, and the PC server must run with --lan.',
  '服务器在线，但播放器主窗口没有心跳（窗口刚被关闭或正在重启）。': 'Server is up, but the player window has no heartbeat (it was just closed or is restarting).',
  '播放队列': 'Play Queue',
  '队列': 'Queue',
  '音量加': 'Volume up',
  '音量减': 'Volume down',
  '在电脑上开始播放后自动同步': 'Syncs automatically once playback starts on the desktop',

  // 数据
  '数据备份与迁移': 'Backup & Migration',
  '导出全部数据': 'Export All Data',
  '导出收藏': 'Export Favorites',
  '导出歌单': 'Export Playlists',
  '下载收藏列表 JSON': 'Download favorites JSON',
  '下载歌单 JSON': 'Download playlist JSON',
  '收藏+歌单+设置+EQ': 'Favorites + playlists + settings + EQ',
  '从 JSON 文件导入，自动识别内容类型': 'Import from JSON with auto content detection',
  '收藏列表': 'Favorites',
  '当前播放队列': 'Current Queue',
  '保存配置': 'Save Config',
  '保存当前播放队列为新歌单': 'Save Queue as Playlist',
  '保存当前为自定义预设': 'Save as Custom Preset',
  '保存后立即生效': 'Effective immediately after saving',
  '清除所有数据': 'Clear All Data',
  '清除搜索缓存': 'Clear Search Cache',
  '清空当前搜索缓存': 'Clear current search cache',
  '清除高潮检测缓存': 'Clear Chorus Cache',
  '清空已缓存的歌曲高潮数据': 'Clear cached chorus data',
  '分析缓存': 'Analysis Cache',
  '分析状态': 'Analysis Status',
  '收藏/取消': 'Favorite / Unfavorite',

  // 快捷键
  '点击按键重新绑定，按下新键确认，Esc 取消': 'Click to rebind, press new key to confirm, Esc to cancel',

  // 自建服务 / Now Playing
  '本机 Now Playing 接管': 'Local Now-Playing Takeover',
  '本机 Now Playing 接管（跟播其它播放器）': 'Local Now-Playing takeover (follow other players)',
  '启用接管': 'Enable Takeover',
  '自动跟播': 'Auto Follow',
  '检测到切歌后自动在 Aria 同步播放同一首': 'Auto-play the same song in Aria when detected',
  '轮询本机 now-playing 服务，检测其它软件正在播放的歌': 'Poll local now-playing service for songs in other players',
  '轮询间隔': 'Poll Interval',
  '轮询间隔(秒)': 'Poll Interval (s)',
  '服务地址': 'Service URL',
  '拖动调整或直接输入': 'Drag to adjust or type directly',
  '拖动调整或直接输入（1~10秒）': 'Drag or type directly (1–10s)',
  '在浏览器中打开作者主页': 'Open author page in browser',
  '在浏览器中打开项目主页': 'Open project page in browser',
  '点击复制版本号': 'Click to copy version',
  '管理播放队列': 'Manage Queue',
  '背景与字体': 'Background & Fonts',
  '视图模式': 'View Mode',
  '选择样式': 'Choose Style',
  '切换样式': 'Switch Style',
  '立即试读': 'Preview Now',
  '试读': 'Preview',
  '取消': 'Cancel',
  '确定': 'Confirm',
  '左': 'Left',
  '右': 'Right',
  '中': 'Center',
  '榜单': 'Charts',
  '摇摆动画': 'Sway',
  '移动范围': 'Range',
  '播放偏好': 'Playback Preferences',
  '导入数据': 'Import Data',
  '尚未读取': 'Not read yet',
  'AI 情绪分析': 'AI Emotion Analysis',
  '三大平台最佳匹配播放版本': 'Best-matching playback versions across 3 platforms',
  '从链接导入歌单': 'Import from Link',
  '点击或拖拽音频文件到此处识曲': 'Click or drop an audio file to recognize',
  '关闭后唱词高光不再使用发光合成': 'Off = no drop-shadow glow synthesis on highlight',
  '收藏、歌单、设置、EQ 全部清除': 'Favorites, playlists, settings & EQ will all be cleared',

  /* ===== 2026-09-22 第三批：JS 动态二级弹窗/页面（扫描 web/src 源码） ===== */
  // OOBE
  '第一步 · 视觉模式偏好': 'Step 1 · Visual Mode',
  '选择你最喜爱的歌词呈现形态，随时可在主界面快捷键 V 切换': 'Pick your favorite lyric presentation, press V anytime',
  'PV 动态排版（推荐）': 'PV Art Layout (Recommended)',
  '海报级电影感排版，智能长镜头运镜与构图': 'Poster-grade cinematic layout with smart camera',
  '词云律动': 'Word Cloud',
  '3D 环绕词阵空间，随歌曲演唱焦点丝滑跟随': '3D word-cloud space following your singing focus',
  '经典封面': 'Classic Cover',
  '经典黑胶大封面与逐字平滑滚动歌词': 'Classic vinyl cover with smooth per-word lyrics',
  '现代艺术 · 蒙德里安': 'Modern Art · Mondrian',
  '几何色块拼画与动感空间飞入': 'Geometric color blocks with dynamic fly-in',
  '第二步 · 性能与视觉体验': 'Step 2 · Performance & Visuals',
  '按设备硬件选择渲染效果档位，可随时在设置-性能中调整': 'Pick a render tier for your hardware, adjustable in Settings',
  '自动检测（推荐）': 'Auto Detect (Recommended)',
  '启动时按显卡与帧率自动匹配最佳档位': 'Auto-match the best tier by GPU & frame rate',
  '保留主要视觉特效，兼顾高帧率与流畅度': 'Keep main effects while staying smooth',
  '极致画质': 'Best Quality',
  '开启全部背景特效、毛玻璃、粒子与运镜细节': 'All background effects, glass, particles & camera details',
  '简化毛玻璃模糊与粒子特效，适合低配或集显设备': 'Simplify glass & particles for low-end devices',
  '第三步 · 初始主题色': 'Step 3 · Theme Color',
  '主界面与歌词高亮主题色，点击即时预览': 'Theme color for UI & lyric highlight, instant preview',
  /* 预设主题色名（唯一登记处：config/themePalette.js 的 ACCENT_PRESETS）。
     首跑向导把这 6 个名字画成色块，所以必须在这里有英文对照。 */
  '曜金': 'Obsidian Gold',
  '丹霞': 'Terracotta',
  '松雨': 'Sage Green',
  '石青': 'Stone Teal',
  '远黛': 'Dusty Indigo',
  '暮紫': 'Muted Violet',
  '第四步 · 自建音乐服务': 'Step 4 · Self-Hosted Services',
  '启用后扫码登录即可享受最高音质与完整官方歌单': 'Scan to login for hi-fi & official playlists',
  '已开启': 'On',
  '未开启': 'Off',
  '步骤': 'Step',
  '下一步': 'Next',

  // 通用按钮/状态
  '重命名': 'Rename',
  '删除': 'Delete',
  '删除歌单': 'Delete Playlist',
  '推荐': 'Recommended',
  '自定义': 'Custom',
  '输入': 'Input',
  '选择': 'Select',
  '静音': 'Mute',
  '本地': 'Local',
  '酷狗': 'KuGou',
  '网易': 'Netease',
  '酷我': 'Kuwo',
  '是': 'Yes',
  '否': 'No',
  '开（带摇摆）': 'On (sway)',
  '核': ' cores',
  '点击检测以获取': 'Click Detect to read',
  '按下按键...': 'Press a key...',
  '检测中...': 'Detecting...',
  '重置中...': 'Resetting...',
  '已导出': 'Exported',
  '未识别到有效数据': 'No valid data detected',
  '立即': 'Immediate',
  '15-30 秒': '15–30s',
  '已命中，不消耗': 'Cached, no cost',
  '分析后缓存': 'Cached after analysis',
  '（未配置 API 密钥，不可用）': '(no API Key, unavailable)',

  // 搜索弹窗
  '搜索失败，请检查网络': 'Search failed, check your network',
  '酷狗搜索暂无结果，可尝试点击顶部音源切换': 'No KuGou results, try switching source above',
  '服务暂时不可用(503)': 'Service temporarily unavailable (503)',
  '暂无结果': 'No results',
  '随机获取过于频繁，请稍后再试': 'Random fetch rate-limited, try later',
  '随机获取失败，请稍后重试': 'Random fetch failed, try again later',

  // 歌单弹窗
  '本地音乐': 'Local Music',
  '历史播放': 'History',
  '当前播放': 'Now Playing',
  '网易云歌单': 'Netease Playlists',
  '酷狗歌单': 'KuGou Playlists',
  'QQ音乐歌单': 'QQ Music Playlists',
  '点击查看我的': 'Click to view mine',
  '点击查看': 'Click to view',
  '未登录，点击去「设置 → 自建服务」登录': 'Not logged in — go to Settings → Self-Hosted',
  '请先到「设置 → 自建服务」登录对应平台': 'Login in Settings → Self-Hosted first',
  '未命名歌单': 'Untitled Playlist',
  '还没有歌单，请先创建': 'No playlists yet, create one first',
  '还没有自定义歌单，点击 + 创建': 'No custom playlists, click + to create',
  '还没有收藏的歌曲': 'No favorites yet',
  '歌单暂无歌曲': 'Playlist is empty',
  '账号下暂无歌单': 'No playlists on this account',
  '该歌单暂无歌曲': 'This playlist is empty',
  '该列表暂无歌曲': 'This list is empty',
  '歌单已随机排序': 'Playlist shuffled',
  '批量下载暂不可用': 'Batch download unavailable',
  '合并暂不可用': 'Merge unavailable',
  '该歌曲已在歌单中': 'Already in this playlist',
  '请输入歌单名称': 'Enter a playlist name',
  '已存在同名歌单': 'A playlist with this name exists',
  '已加入当前播放队列': 'Added to queue',
  '已在当前播放队列中': 'Already in queue',
  '已加入收藏': 'Added to favorites',
  '已取消收藏': 'Removed from favorites',
  '请点击右上角「＋」将当前歌曲加入歌单': 'Click ＋ above to add this song to a playlist',
  '已添加': 'Added',
  '暂无播放记录': 'No play history',
  '本地音频播放中 (点击右侧按钮可上传或替换 LRC)': 'Playing local audio (upload/replace LRC via button)',
  '清空播放记录': 'Clear History',
  '确定要清空全部历史播放记录吗？操作不可撤销。': 'Clear all play history? This cannot be undone.',
  '清空全部历史播放记录？': 'Clear all play history?',
  '还没有播放过歌曲': 'No songs played yet',
  '去搜索 / 榜单 / 收藏里点一首吧': 'Pick one from Search / Charts / Favorites',
  '正在读取本地音乐库...': 'Reading local library...',
  '暂无本地音乐，点击上方横幅上传第一首歌吧！': 'No local music, upload via the banner above!',
  '点击上传 / 暂无歌曲': 'Click to upload / empty',
  '首结构化单曲': 'tracks',
  '· 3 平台': '· 3 platforms',
  /* 歌单页底部的「· N 平台」随自建平台数量变化（加入汽水后为 4）。
     数字变一下就是一个新字面量，门禁会当作新文案拦下 —— 这里按同一口径登记。 */
  '· 4 平台': '· 4 platforms',
  /* 汽水日推走字节推荐流（匿名可用、无平台开关），失败只可能是本机服务没起来，
     所以不能套用另三家的「去设置里启用」引导。 */
  '汽水服务未启动': 'Local Soda service is not ready',
  '每日推荐 · 汽水音乐': 'Daily Mix · Soda Music',
  '歌单 · 汽水音乐': 'Playlist · Soda Music',
  '获取失败': 'Fetch failed',
  '队列为空': 'Queue empty',
  '首歌曲': 'songs',
  '首 · 点击查看': ' · Click to view',
  '首': ' songs',
  '0 首': '0 songs',
  '删除本地歌曲': 'Delete Local Song',
  '已删除本地歌曲': 'Local song deleted',
  '删除失败：目录可能被占用或不存在': 'Delete failed: directory busy or missing',
  '歌单基础信息': 'Playlist Info',
  '歌单名称': 'Playlist Name',
  '歌单封面': 'Playlist Cover',
  '歌曲ID': 'Song ID',
  '歌曲名称': 'Song Name',
  '歌手': 'Artist',
  '专辑封面': 'Album Cover',
  '当前页歌曲列表': 'Current page tracks',
  '正在解析链接...': 'Parsing link...',
  '请输入歌单链接': 'Paste a playlist link',
  '正在获取歌单信息...': 'Fetching playlist info...',
  '直连API失败，尝试备用方式...': 'Direct API failed, trying fallback...',
  '无法从链接中提取歌单ID，请检查链接是否正确': 'Cannot extract playlist ID, check the link',
  '未获取到歌单曲目，可能歌单不存在或链接无效': 'No tracks found — playlist may not exist',
  '正在计算剩余时间...': 'Estimating remaining time...',
  '导入失败：': 'Import failed: ',
  '网络错误': 'Network error',
  '此歌单': 'this playlist',
  '删除失败': 'Delete failed',
  '保存失败：': 'Save failed: ',
  '未知错误': 'Unknown error',
  '✅ 自定义歌词已成功保存！': '✅ Custom lyrics saved!',

  // 播放队列面板
  '正在播放，拖拽可排序': 'Playing — drag to reorder',
  '点击播放，拖拽可排序': 'Click to play — drag to reorder',
  '清空播放队列': 'Clear Queue',
  '确定要清空当前整个播放队列吗？操作不可撤销。': 'Clear the whole queue? This cannot be undone.',
  '清空当前整个播放队列？': 'Clear the whole queue?',
  '续推': 'Auto-Fill',
  '续推·开': 'Auto-Fill · On',
  '队列剩余 ≤3 首时自动追加每日推荐，让列表一直续上（点击切换）': 'Auto-append Daily Mix when ≤3 left',
  '打乱当前播放队列的顺序（不影响歌单原顺序），之后按新顺序播放；随机播放模式下会自动切回顺序播放': 'Shuffle queue order; auto-reverts to sequential in shuffle mode',
  '已随机排序，并切回顺序播放': 'Shuffled, switched to sequential',
  '已随机排序，按新顺序播放': 'Shuffled, playing in new order',

  // 榜单/每日推荐/收藏（vendor）
  '每日推荐 · QQ音乐': 'Daily Mix · QQ Music',
  '每日推荐 · 网易云': 'Daily Mix · Netease',
  '每日推荐 · 酷狗': 'Daily Mix · KuGou',
  '我喜欢的歌 · 网易云': 'Liked Songs · Netease',
  '我喜欢的歌 · 酷狗': 'Liked Songs · KuGou',
  '我喜欢的歌 · QQ音乐': 'Liked Songs · QQ Music',
  '我喜欢的歌 ·': 'Liked Songs ·',
  '歌单 · 网易云': 'Playlist · Netease',
  '歌单 · 酷狗': 'Playlist · KuGou',
  '歌单 · QQ音乐': 'Playlist · QQ Music',
  '该平台未启用自建服务': 'Self-hosted not enabled for this platform',
  '未找到«我喜欢的歌»歌单': '«Liked Songs» playlist not found',
  '该歌单暂无曲目': 'Playlist has no tracks',
  'QQ 榜单接口不可用': 'QQ Charts API unavailable',
  'QQ 榜单为空': 'QQ Charts empty',
  '酷狗榜单为空': 'KuGou Charts empty',
  '网易云榜单接口不可用': 'Netease Charts API unavailable',
  '该榜单暂无歌曲': 'This chart is empty',
  '酷狗该曲缺少播放标识': 'KuGou track missing play identifier',
  '没有可下载的歌曲': 'No downloadable songs',
  '均衡器暂不可用': 'Equalizer not ready',
  'EQ 分享码已复制': 'EQ share code copied',
  '复制失败': 'Copy failed',
  '导入 EQ 分享码': 'Import EQ Share Code',
  'EQ 预设已导入': 'EQ preset imported',
  '分享码无效': 'Invalid share code',
  '分享码解析失败': 'Share code parse failed',
  '暂无数据': 'No data',
  '亿': '100M+',
  '洛天依': 'Luo Tianyi',

  // 播放/下载/歌词下载弹窗（90/95）
  '当前没有正在播放的歌曲': 'Nothing is playing',
  '均衡器不可用': 'Equalizer unavailable',
  '当前歌曲不支持均衡器（跨域限制），请尝试本地文件或支持 CORS 的音源。': 'EQ not supported for this song (CORS). Try local files or CORS-friendly sources.',
  '知道了': 'Got it',
  '预设面板暂不可用': 'Preset panel not ready',
  '保存为自定义预设': 'Save as Custom Preset',
  '例如：我的重低音': 'e.g. My Bass Boost',
  '已保存预设：': 'Preset saved: ',
  '当前歌词': 'Current Lyrics',
  '使用当前正在显示的歌词': 'Use the lyrics currently shown',
  '逐行歌词 · 兼容性最好': 'Line-by-line · best compatibility',
  '增强逐字时间轴': 'Enhanced per-word timeline',
  'QQ 音乐逐字格式': 'QQ Music per-word format',
  '酷狗音乐加密格式': 'KuGou encrypted format',
  '步骤 1 · 选择歌词来源': 'Step 1 · Choose lyric source',
  '当前没有可用的歌词': 'No lyrics available',
  '获取中…': 'Fetching…',
  '请先播放歌曲，再从该来源获取歌词': 'Play a song first, then fetch from this source',
  '未获取到有效歌词': 'No valid lyrics found',
  '该来源未能获取到有效歌词，请换一个来源': 'No valid lyrics from this source, try another',
  '请先选择歌词来源': 'Choose a lyric source first',
  '当前没有可下载的歌词': 'No downloadable lyrics',
  '歌词导出失败': 'Lyric export failed',
  '未播放': 'Not playing',
  '本地文件': 'Local file',
  '请先搜索或加载音乐': 'Search or load music first',
  '暂无歌词': 'No lyrics',
  '切换到播放页面': 'Switch to player',
  '切换到歌词页面': 'Switch to lyrics',
  '(无歌词)': '(no lyrics)',
  '播放失败': 'Playback failed',
  '播放失败（本地文件链接可能已失效）': 'Playback failed (local file link may be stale)',
  '音频加载超时': 'Audio load timeout',
  'LRCLIB 开放词库': 'LRCLIB Open Lyrics',

  // 自建服务页
  '自建服务（需 Node.js）': 'Self-hosted service (Node.js required)',
  '登录后日推/收藏/高音质走自建接口；无 VIP 试听链自动回退免费源池。扫码一次长期有效（登录态自动保存）。': 'After login, daily mix/favorites/hi-fi use self-hosted APIs; preview links auto-fallback to free pool. Login persists after one scan.',
  '汽水音乐的搜索与逐字歌词匿名就能用，只有播放需要扫码登录；登录态由本机服务保管，重启不用重扫。': 'Soda search and per-word lyrics work anonymously; only playback needs a scan. The session is kept by the local service, so no rescan after a restart.',
  '登录会话由本机服务保管，无需手动填 Cookie；换设备重新扫码即可': 'The session is kept by the local service — no manual cookie needed. Rescan on a new device.',
  '无平台开关（搜索与播放始终走本机）': 'No platform switch (search & playback always use the local service)',
  '酷狗若扫码后仍提示需要验证，可在登录弹窗改用「手机号」短信验证码登录。': 'If KuGou scan still asks verification, use phone SMS login instead.',
  '· 已登录': '· Logged in',
  '本地组件缺失': 'Local component missing',
  '未安装': 'Not installed',
  '本地运行中': 'Local running',
  '离线': 'Offline',
  '服务离线': 'Service offline',
  '状态查询失败': 'Status query failed',
  '未登录': 'Not logged in',
  '已登录': 'Logged in',
  '失败': 'Failed',
  '✗ 失败': '✗ Failed',
  '退出登录': 'Logout',
  '服务未启动，请先启动服务': 'Service not running — start it first',
  '启用 QQ 自建：日推/收藏 + 取播放链接都走本机（关掉则取链接退回在线源池）': 'QQ self-hosted: daily mix/favorites + link resolution local',
  '启用网易云自建：日推/收藏/歌单走本机（取播放链接只要求本地服务在线，不受此开关影响）': 'Netease self-hosted: daily mix/favorites/playlists local',
  '启用酷狗自建：日推/收藏/签到走本机（酷狗暂无自建取播放链接，播放仍走公网源）': 'KuGou self-hosted: daily mix/favorites/check-in local',
  '启用该平台自建': 'Enable self-hosted for this platform',
  '自动签到（打开应用时自动执行）': 'Auto check-in on app start',
  '立即签到': 'Check In Now',
  '签到中…': 'Checking in…',
  '启动签到…': 'Starting check-in…',
  '启动失败': 'Start failed',
  '再领一次': 'Claim Again',
  '本地组件缺失，无法启动服务': 'Local component missing — the service cannot start',
  '扫码': 'Scan QR',
  '手机号': 'Phone',
  '邮箱': 'Email',
  '微信': 'WeChat',
  '11 位手机号（不带 +86）': '11-digit phone (without +86)',
  '验证码': 'SMS Code',
  '6 位短信验证码': '6-digit SMS code',
  '获取验证码': 'Get Code',
  '验证码由酷狗官方短信下发；登录态仅保存在本机': 'Code sent by KuGou official SMS; login stays local',
  '登 录': 'Log In',
  '请先填手机号': 'Enter phone number first',
  '发送中…': 'Sending…',
  '验证码已发送，请查收短信': 'Code sent, check your SMS',
  '发送失败': 'Send failed',
  '请填写手机号与验证码': 'Fill in phone & SMS code',
  '登录中…': 'Logging in…',
  '登录成功': 'Login successful',
  '登录失败': 'Login failed',
  '11 位手机号': '11-digit phone',
  '密码': 'Password',
  '网易云账号密码': 'Netease account & password',
  '密码仅在本地校验，不会上传到本机以外': 'Password verified locally only, never uploaded',
  '请填写完整': 'Fill in all fields',
  '取码失败': 'QR fetch failed',
  '请用网易云音乐 App 扫码授权（若扫码无效，请改用上方「手机号 / 邮箱」登录）': 'Scan with Netease Music App (or use Phone / Email above)',
  '请用酷狗音乐 App 扫码授权（若扫码不行，点上方「手机号」用短信验证码登录）': 'Scan with KuGou Music App (or use Phone SMS above)',
  '请用汽水音乐 App 扫码授权（搜索与逐字歌词匿名可用，播放需登录）': 'Scan with Soda Music App (search & per-word lyrics work anonymously; playback needs login)',
  '请用对应 App 扫码授权（QQ App 或 微信）': 'Scan with the matching App (QQ or WeChat)',
  '二维码已失效，点击右上角关闭后重新扫码': 'QR expired — close and rescan',
  '二维码已过期，点击右上角关闭后重新扫码': 'QR expired — close and rescan',
  '等待扫码…': 'Waiting for scan…',
  '已登录成功…': 'Logged in…',
  '已扫码，请在手机上确认': 'Scanned — confirm on your phone',
  '二维码已过期': 'QR expired',
  '二维码已失效': 'QR invalid',

  // AI 设置与弹窗
  '接口响应正常': 'API responds normally',
  '连接异常': 'Connection error',
  '测试成功': 'Test successful',
  '测试中...': 'Testing...',
  '请先填写 API 密钥': 'Enter API Key first',
  '请先输入 API 密钥': 'Enter API Key first',
  '请先输入有效的 API 密钥': 'Enter a valid API Key first',
  '请先在设置中输入有效的 API 密钥': 'Enter a valid API Key in Settings first',
  '获取中...': 'Fetching...',
  '正在获取模型列表...': 'Fetching model list...',
  '未找到可用模型': 'No models found',
  '推理': 'Reasoning',
  '视觉': 'Vision',
  '快速': 'Fast',
  '轻量': 'Lite',
  '请先播放一首歌曲': 'Play a song first',
  '正在分析歌曲主题...': 'Analyzing song theme...',
  '暂无缓存数据可导出': 'No cached data to export',
  '配置文件格式不正确': 'Invalid config file format',
  '导入失败：文件格式错误': 'Import failed: bad file format',
  '清空 AI 分析缓存': 'Clear AI Cache',
  '确定要清空所有 AI 分析缓存吗？操作不可撤销。': 'Clear all AI analysis cache? This cannot be undone.',
  '已缓存 0 首歌曲的分析结果': '0 songs cached',
  '缓存已清空': 'Cache cleared',
  '清空缓存失败': 'Clear cache failed',
  '确定要清空所有歌曲高潮检测缓存吗？操作不可撤销。': 'Clear all chorus cache? This cannot be undone.',
  '已清空': 'Cleared',
  '高潮检测缓存已清空': 'Chorus cache cleared',
  '清空失败': 'Clear failed',
  '连接成功（返回内容为空，但接口可用）': 'Connected (empty response but API works)',
  'AI 正在分析...': 'AI Analyzing...',
  'AI 正在分析…': 'AI Analyzing…',
  '正在生成分析结果…': 'Generating analysis…',
  '正在生成分析结果...': 'Generating analysis...',
  '请求被浏览器拦截（可能是跨域限制或隐私保护）。请更换 API 地址，或改用支持跨域的代理': 'Request blocked (CORS/tracking protection). Try another endpoint or a CORS-friendly proxy',
  '请求失败': 'Request failed',
  'AI 分析失败': 'AI analysis failed',
  'API 密钥无效，请检查设置': 'Invalid API Key, check settings',
  'API 调用频率超限，请稍后再试': 'API rate limited, try later',
  'AI 服务器内部错误': 'AI server internal error',
  '分析失败': 'Analysis failed',
  'AI 返回内容为空': 'AI returned empty content',
  'AI 返回被截断（max_tokens 太小），请尝试减小歌词片段': 'AI response truncated (max_tokens too small)',
  '返回格式异常，无法解析': 'Unexpected response format',
  'AI 返回格式异常，无法解析': 'AI response format error',
  '返回格式异常': 'Unexpected format',
  '返回数据不完整': 'Incomplete response data',
  'AI 返回数据不完整': 'AI response incomplete',

  // AI 服务商与接口（constants/10-config）
  'OpenAI 官方/兼容': 'OpenAI Official/Compatible',
  'DeepSeek (深度求索)': 'DeepSeek',
  'OpenRouter 聚合网关': 'OpenRouter Gateway',
  '智谱 AI (GLM / Z-AI)': 'Zhipu AI (GLM)',
  '阿里云百炼 (通义千问)': 'Alibaba Bailian (Qwen)',
  '阿里云百炼 (通义千问 / Qwen)': 'Alibaba Bailian (Qwen)',
  'MiniMax / 海螺': 'MiniMax',
  '腾讯混元 (Hunyuan)': 'Tencent Hunyuan',
  '自定义 (OpenAI 兼容)': 'Custom (OpenAI-compatible)',
  '简体中文': 'Simplified Chinese',
  'OpenAI API 地址': 'OpenAI API URL',
  '推荐 gpt-4o-mini，极速、准确且性价比极高': 'gpt-4o-mini recommended (fast, accurate, great value)',
  'DeepSeek 官方 API 地址（留空默认官方）': 'DeepSeek API URL (empty = official)',
  '推荐 deepseek-chat (V3)，中文歌词理解极强': 'deepseek-chat (V3) recommended (excellent Chinese)',
  'Gemini API 代理或官方接口（默认反代: https://zsjsll-cf.de5.net）': 'Gemini API proxy or official endpoint (default proxy: https://zsjsll-cf.de5.net)',
  'Gemini API 代理或官方接口（默认反代: ': 'Gemini API proxy or official endpoint (default proxy: ',
  '推荐 gemini-3.5-flash-lite，生成效果佳，速度快': 'gemini-3.5-flash-lite recommended (good quality, fast)',
  'OpenRouter (聚合网关)': 'OpenRouter (Gateway)',
  'OpenRouter 全球模型聚合网关': 'OpenRouter global model gateway',
  '支持多种免费与付费前沿模型免魔法调用': 'Access many free & paid frontier models without a proxy',
  '智谱开放平台 API 地址': 'Zhipu Open Platform API URL',
  '推荐 glm-4-flash，免费调用且速度极快': 'glm-4-flash recommended (free & very fast)',
  '阿里云百炼 DashScope 兼容接口地址': 'Alibaba DashScope-compatible URL',
  '推荐 qwen-plus，中文文学与歌词情绪分析极佳': 'qwen-plus recommended (great Chinese lyric analysis)',
  'MiniMax 官方开放平台 API 接口': 'MiniMax official API URL',
  '推荐 MiniMax-Text-01，大语言模型理解力强': 'MiniMax-Text-01 recommended (strong LLM understanding)',
  '腾讯混元大模型兼容接口地址': 'Tencent Hunyuan-compatible URL',
  '推荐 hunyuan-standard，响应稳定速度快': 'hunyuan-standard recommended (stable & fast)',
  'NVIDIA NIM 大模型托管接口': 'NVIDIA NIM hosted API',
  'NVIDIA 官方开源模型推理加速': 'NVIDIA official open-model acceleration',
  '任何支持 /v1/chat/completions 的自定义 API 地址': 'Any custom API supporting /v1/chat/completions',
  '可手动输入任何兼容的模型名称': 'Type any compatible model name',

  // EQ 预设/风格名
  '流行': 'Pop',
  '摇滚': 'Rock',
  '爵士': 'Jazz',
  '古典': 'Classical',
  '电子': 'Electronic',
  '轻音乐': 'Light Music',
  '人声': 'Vocal',
  '重低音': 'Bass Boost',
  '金属': 'Metal',

  // 性能档位
  '流畅运行所有视效与全量特效': 'All effects at full quality',
  '流畅运行所有特效': 'All effects running smoothly',
  '平衡画质与流畅度，适中资源占用': 'Balanced quality & smoothness',
  '平衡画质与性能': 'Balance quality & performance',
  '大幅降低视觉与内存开销，提升流畅度': 'Greatly reduce visual & memory cost',
  '优先保证流畅度': 'Prioritize smoothness',
  '极低内存与GPU占用，专注极速播放': 'Minimal memory & GPU, pure speed',
  '最低资源占用': 'Minimum resource usage',

  // 字体管理
  '黑体 / 无衬线': 'Hei / Sans-serif',
  '衬线 / 宋体': 'Serif / Song',
  '楷体 / 手写': 'Kai / Handwriting',
  '像素': 'Pixel',
  '等宽': 'Monospace',
  '其他': 'Other',
  '设为全局': 'Set Global',
  '删除字体': 'Delete Font',
  '删除字体失败': 'Font delete failed',
  '默认（跟随全局字体）': 'Default (follow global)',
  '已开启多语言字体匹配：全局字体作为未配置语言的回退字体': 'Per-language fonts on: global font is the fallback',

  // Now Playing / 其他
  '读取失败（服务未启动或地址不对，已自动尝试常见路径）': 'Read failed (service down or wrong URL, common paths tried)',
  '服务已连接，当前播放器没有正在播放的歌曲': 'Connected, but nothing playing in the other player',
  '读取中...': 'Reading...',
  '音乐世界': 'Music World',
  '网格视图': 'Grid view',
  '列表视图': 'List view',
  '当前：宫格视图，点击切回列表': 'Grid view — click for list',
  '当前：列表视图，点击切换宫格': 'List view — click for grid',
  '当前：横向轮播，点击切回网格': 'Carousel — click for grid',
  '当前：网格，点击切换横向轮播': 'Grid — click for carousel',
  '解锁桌面歌词': 'Unlock Desktop Lyrics',
  '正在录音中... 点击停止并分析': 'Recording... click to stop and analyze',
  '1/3 正在提取声学指纹并在 Shazam 比对...': '1/3 Extracting fingerprint, matching on Shazam...',
  '2/3 Shazam 未命中，正在用语音转写的歌词反查曲目…': '2/3 No Shazam match, reverse-searching via transcribed lyrics...',
  '3/3 未能匹配到曲目': '3/3 No match found',
  '建议录制更清晰的人声片段重试': 'Try recording a clearer vocal segment',
  '未能识别出曲目，建议录制更清晰或包含人声高潮的片段重试': 'No track identified; try a clearer clip with vocals',
  '识曲失败': 'Recognition failed',
  '曲库比对失败': 'Library matching failed',
  '已识别歌曲，但三大曲库暂时未匹配到可播放直链': 'Track identified, but no playable link from the three libraries right now',
  '匹配': 'match',
  '登录状态': 'Login status',
  '手动填写 Cookie': 'Manual Cookie',
  '粘贴登录状态，保存后即登录（可选）': 'Paste login state and save to log in (optional)',
  '每日签到领 VIP': 'Daily check-in for VIP',
  '每天可领 2 天概念版 VIP': 'Get 2 days of Lite VIP daily',
  /* —— 2026-09-24 批量补齐（截图点名 UI）—— */
  '本地音乐 · 歌单导入 · 均衡器 · KTL 适配': 'Local music · playlist import · EQ · KTL',
  '字体：思源黑体 / 思源宋体（Noto CJK，SIL OFL）· 霞鹜系列 · Cubic 11　·　© 2026 Aria Lyrics Player': 'Fonts: Noto CJK (SIL OFL) · LXGW · Cubic 11 · © 2026 Aria Lyrics Player',
  'API 密钥只保存在本机浏览器中，不会上传到第三方服务器。': 'Your API Key stays in browser localStorage only — never uploaded to any third party.',
  '当前服务商': 'Current provider',
  '专属密钥': 'dedicated key',
  '日系排版，网点半调赋予，平滑运镜与多层视差': 'Japanese layout with halftone grain, smooth camera and parallax',
  '视觉开销（手动微调）': 'Visual Overhead (manual tuning)',
  '更多硬件细节 ▾': 'More hardware details ▾',
  '像素比': 'Pixel Ratio',
  '性能评分': 'Performance Score',
  '手写': 'Handwriting',
  '支持 .ttf / .otf / .woff / .woff2 格式，将自动复制保存至本地 src/font 并持久化生效': 'Supports .ttf / .otf / .woff / .woff2 — copied to local src/font and persisted',
  '自定义字体': 'Custom Fonts',
  '上传并持久化字体': 'Upload & Persist Fonts',
  '酷狗音乐 · 已登录': 'KuGou · Logged in',
  'QQ音乐 · 已登录': 'QQ Music · Logged in',
  '网易云音乐 · 已登录': 'Netease · Logged in',
  '汽水音乐 · 已登录': 'Soda · Logged in',
  '点击查看我的网易云歌单': 'View my Netease playlists',
  '点击查看我的酷狗歌单': 'View my KuGou playlists',
  '点击查看我的QQ音乐歌单': 'View my QQ playlists',
  '循环播放': 'Repeat',
  '我喜欢的歌': 'Liked Songs',
  '我的歌单': 'My Playlists',
  '切换显示/隐藏': 'Toggle visibility',
  '离线收藏与高音质走自建接口；无 VIP 时自动回退免费源，扫码一次长期有效。各平台启用开关决定哪些功能走自建：酷狗目前仅日推与收藏走自建，需要验证时可改用手机号验证码登录。': 'Offline favorites and hi-res via the self-hosted service; falls back to free sources without VIP. Scan once to stay signed in. Each platform switch decides which features are self-hosted: KuGou serves daily mix and favorites only — if it asks for verification, use SMS login instead.',
  '候选预览': 'Candidate preview',
  '逐字': 'Per-word',
  '逐行': 'Per-line',
  '中文': 'Chinese',
  '英文': 'English',
  '日文': 'Japanese',
  '韩文': 'Korean',
  'Now Playing 服务地址说明': 'Now Playing service address',
  '本机服务地址，默认 http://localhost:9863/query': 'now-playing-service defaults to http://localhost:9863/query; see docs for setup',
  '切换歌曲时音量渐变': 'Volume fade on song change',
  '用于分析歌曲情绪并自动切换主题': 'Analyzes song emotion to auto-switch themes',
  '全部': 'All',
  '最近': 'Recent',
  '统计': 'Stats',
  '歌曲': 'songs',
  '分析完成': 'Analysis Complete',
  '已恢复手动主题': 'Manual theme restored',
  '已分析（缓存）': 'Analyzed (Cached)',
  'AI 分析完成': 'AI Analysis Complete',

  '仅在使用自建反代并开启 Token 鉴权时填写；留空则不发送': 'Fill in when your custom Cloudflare proxy requires token auth (sent via x-proxy-token header); leave empty if not needed',
  'AI 分析经反代接口中转': 'AI Analysis Routed via Reverse Proxy',
  '反代访问令牌已保存': 'Proxy token saved',
  '反代访问令牌已清除': 'Proxy token cleared',
  '重新运行初始设置': 'Run Setup Again',
  '重新运行': 'Run Again',
  '初始设置向导': 'Setup Guide',
  '重新运行初始设置向导，可调整语言、性能与音质偏好': 'Run the setup guide again to adjust language, performance and audio preferences',
  '界面语言 · Language': 'Display Language',
  '选择界面显示语言，可随时在设置中更改': 'Choose display language, changeable in Settings',
  '默认播放音质': 'Default Playback Quality',
  '优先获取无损 FLAC 音质': 'Prioritize lossless FLAC audio',
  '品质与加载速度兼顾': 'Balanced quality and load speed',
  '轻量省流，弱网秒开': 'Lightweight, fast start on slow networks',
  '初始主题色': 'Theme Color',
  '按硬件配置选择画质档位；虚拟机或核显建议选流畅优先': 'Pick a quality tier for your hardware; VMs and iGPUs should use Smooth',
  '按显卡与帧率自动匹配渲染档位': 'Auto-match render tier by GPU and framerate',
  '保留主要动效，帧率与画质兼顾': 'Keep most effects, balanced framerate and quality',
  '开启全部光效、毛玻璃与运镜细节': 'All effects, glass blur and camera details',
  '预烘焙模糊背景，停用复杂滤镜': 'Pre-baked blurred background, no complex filters',
  '为歌词关键词着色并加发光效果': 'Color and glow keyword words in lyrics',
  '选择默认播放音质与界面主题色': 'Choose default audio quality and theme color',
  '接入自建音源服务，扫码登录后可使用官方音质与歌单': 'Connect self-hosted services; scan to log in for official quality and playlists',
  '未启用的音源播放时将自动走多源解析获取。': 'Disabled sources fall back to multi-source resolution during playback.',
  '按步骤选择偏好设置，可随时在设置面板更改': 'Set up preferences step by step; change anytime in Settings',
  '3D 空间粒子流体，随主题色变换景深': '3D particle fluid, depth shifts with theme color',

  /* —— OOBE 文案补漏（2026-09-25 用户反馈：英文模式 OOBE 无翻译）。
     2026-09-24 那批 OOBE 词条对着旧文案加的，重构后新标题/选项标题/按钮漏了 —— */
  '设备与渲染性能': 'Device & Rendering Performance',
  '音质偏好与主题色': 'Audio Quality & Theme Color',
  '自建音乐服务': 'Self-Hosted Music Services',
  '默认语言，界面文案与排版完全本地化': 'Default language, fully localized UI copy and layout',
  '流畅优先（虚拟机/核显推荐）': 'Smooth First (VM / iGPU recommended)',
  'AI 情绪与情感词上色': 'AI Mood & Emotion Coloring',
  '无损品质 (FLAC / Lossless)': 'Lossless (FLAC)',
  '极高音质 (320kbps)': 'Extreme Quality (320kbps)',
  '标准音质 (128kbps)': 'Standard Quality (128kbps)',
  '跳过引导': 'Skip Setup',
  '上一步': 'Back',
  '开始使用': 'Get Started',
  '扫码登录 网易云音乐': 'Scan QR · Netease Music',
  '扫码登录 QQ 音乐': 'Scan QR · QQ Music',
  '扫码登录 酷狗音乐': 'Scan QR · KuGou Music',
  '视觉模式偏好': 'Visual Mode Preferences',

  /* —— 日推兜底提示（2026-09-25 登录≠启用事故：服务端在线+已登录，前端开关关着 →
     日推全灭。文案要指路：设置 → 自建服务 开开关）—— */
  '今日日推暂时不可用（三平台未启用或服务离线）': 'Daily recommendations unavailable (all three sources disabled or offline)',
  '已自动为你打开热门榜单': 'Hot charts opened automatically',
  '登录了却不显示？到 设置 → 自建服务 打开对应平台开关': 'Logged in but not showing? Enable the source in Settings → Self-Hosted Services',
  '日推不可用（三平台未启用或离线）；已登录平台可在 设置 → 自建服务 开启': 'Daily recs unavailable (all disabled or offline); enable logged-in sources in Settings → Self-Hosted Services',

  /* —— 视觉配方 / 可读性 / Next-Up 补漏（2026-09-25 i18n-coverage 棘轮抓到的
     团队新分片漏登记）。带「」的拼接 toast 句这里登记碎片供 translatePhrase /
     审计命中（裸碎片不会作为 DOM 文本出现），运行时整句由 translateTextNode
     的动态正则翻译 —— */
  '视觉配方': 'Visual Recipes',
  '保存 / 分享当前所有视觉参数': 'Save / share all visual parameters',
  '把模式、字号、模糊、摇摆、高亮色与各模式的版式偏好存成命名预设，或复制成一段分享码发给朋友。API 密钥、登录态、本地路径、语言与快捷键都不在内。': 'Save mode, font size, blur, sway, highlight colors and per-mode layout preferences as named presets, or copy a share code for friends. API keys, login sessions, local paths, language and shortcuts are never included.',
  '管理配方': 'Manage Recipes',
  '复制': 'Copy',
  '当前外观': 'Current Look',
  '还没有配方，可粘贴分享码导入创建。': 'No recipes yet — paste a share code below to create one.',
  '导入分享码': 'Import Share Code',
  '校验并导入': 'Validate & Import',
  '导入前会逐条校验版本、校验和与每个参数的取值范围；有任何一项不合格就整份拒绝，不会只导入一半。': 'Before import, version, checksum and every parameter range are validated; any failure rejects the whole recipe — never a partial import.',
  '输入框暂不可用': 'Input dialog not ready',
  '设置暂不可用': 'Settings not ready',
  '名字不能为空': 'Name cannot be empty',
  '保存失败': 'Save failed',
  '已经有同名配方了': 'A recipe with this name already exists',
  '重命名失败': 'Rename failed',
  '复制失败，请手动选中复制': 'Copy failed — select and copy manually',
  '分享码已复制到剪贴板': 'Share code copied to clipboard',
  '先粘贴一段分享码': 'Paste a share code first',
  '分享码被拒绝，详见面板里的逐条原因': 'Share code rejected — see per-entry reasons in the panel',
  '导入失败：配方不合法': 'Import failed: invalid recipe',
  '这份配方不合法，生成不了分享码': 'This recipe is invalid; cannot generate a share code',
  '配方不合法，已拒绝应用': 'Invalid recipe — rejected',
  /* —— 外观 mod 文件（.aria-theme.json）导入导出（2026-10-05）：带插值的整句走动态桶，
     这里只登记真正的静态串（按钮 / 标题 / 短提示）—— */
  '外观 mod 文件': 'Appearance mod file',
  '选择 mod 文件…': 'Choose mod file…',
  '导出当前外观': 'Export current look',
  'mod 文件是一段带名字的配方（.aria-theme.json），与分享码走同一套白名单校验，任何一项不合格就整份拒绝；文件内容只按数据读，不会被当作代码执行。': 'A mod file is a named recipe (.aria-theme.json). It goes through the same whitelist checks as a share code: any invalid entry rejects the whole file. Its contents are read as data only — never executed.',
  '导入 mod 文件失败': 'Failed to import mod file',
  'mod 文件校验通过': 'Mod file validated',
  'mod 文件被拒绝，详见面板里的逐条原因': 'Mod file rejected — see per-entry reasons in the panel',
  '读取 mod 文件失败': 'Failed to read mod file',
  '当前外观不合法，导出失败': 'Current look is invalid; export failed',
  '导出失败：无法创建下载': 'Export failed: could not start the download',
  /* —— 海报：抓帧就绪守卫（hint 出口，复扫不强制登记，一并补上以免英文模式留中文）—— */
  '当前画面还没准备好，等歌词或视觉引擎出现后再试': 'The view is not ready yet — try again once the lyrics or the visual engine shows up',
  '歌词可读性增强已开启': 'Lyric readability boost enabled',
  '切歌前多少秒浮出提示条（3~15 秒）': 'Seconds before track end to pop up the next-up bar (3–15 s)',
  /* 拼接句碎片（见上注释） */
  '已保存配方「': 'Saved recipe "',
  '已重命名为「': 'Renamed to "',
  '已用当前外观覆盖「': 'Overwritten with current look: "',
  '已删除「': 'Deleted "',
  '已应用配方「': 'Applied recipe "',
  '已导入并应用，同时存为配方「': 'Imported & applied, saved as recipe "',
  '粘贴以': 'Paste a share code starting with ',
  '粘贴以 ': 'Paste a share code starting with ',
  '开头的分享码': 'share code',
  /* 292 可自定义工具栏（设置 → 界面 → 界面控件 / 「更多」菜单溢出条目） */
  '界面控件': 'Interface Controls',
  '自定义工具栏': 'Customize Toolbar',
  '调整右上角按钮的顺序，或隐藏不常用的。隐藏的按钮不会消失，会收进「更多」菜单，点它等于点原按钮。': 'Reorder the top-right buttons or hide the ones you rarely use. Hidden buttons do not disappear: they move into the More menu, where activating them is the same as pressing the original button.',
  '恢复默认': 'Restore Defaults',
  '显示': 'Show',
  '隐藏': 'Hide',
  '上移': 'Move Up',
  '下移': 'Move Down',
  '固定显示': 'Pinned',
  '当前没有可设置的按钮': 'No configurable buttons available',
  /* ===== 2026-10-08 文案整改：这批此前是"未登记"存量（在 i18n-coverage 基线里），
     整改时一并登记 —— 它们本来就是用户能看到的句子，登记后才能随语言切换。 */
  '确定要清除所有数据吗？操作不可撤销，包括收藏、歌单、设置、均衡器和自定义字体。':
    'Clear all data? This cannot be undone — favorites, playlists, settings, equalizer and custom fonts are included.',
  '当前走第三方反代（zsjsll-cf.de5.net），API 密钥与歌词将经其中转；可在下方关闭反代改用官方接口 generativelanguage.googleapis.com（大陆网络需代理）。':
    'Requests go through a third-party proxy (zsjsll-cf.de5.net); your API key and lyrics pass through it. Turn it off below to use the official endpoint generativelanguage.googleapis.com (a proxy is required in mainland China).',
  '请先在设置中配置 API 密钥': 'Configure an API key in Settings first',
  '请输入 API 密钥': 'Enter an API key',
  '将清空全部「视觉开销」手动微调并回到高性能档，操作不可撤销。':
    'This clears all manual visual-cost tuning and returns to the high-performance preset. It cannot be undone.',
  /* ===== 自建服务补全（2026-11-15） ===== */
  '共 0 首': '0 tracks',
  '创建云端歌单失败': 'Failed to create cloud playlist',
  '删除云端歌单失败': 'Failed to delete cloud playlist',
  '歌单将直接创建在您的平台账号内': 'The playlist will be created directly in your platform account',
  '移出云端歌单失败': 'Failed to remove track from cloud playlist',
  '输入新歌单名称': 'Enter new playlist name',
  '+ 新建云端歌单': '+ New Cloud Playlist',
  '删除云端歌单': 'Delete cloud playlist',
  '移出云端歌单': 'Remove from cloud playlist',
  '从云端歌单移除': 'Remove from cloud playlist',
  '云端红心操作失败': 'Cloud like operation failed',
  '已取消云端红心': 'Removed cloud like',
  '已红心同步到云端': 'Synced like to cloud',
  '刷新当前列表': 'Refresh list',
  '我喜欢的歌 · 汽水音乐': 'Liked Songs · Soda Music',
  'Cookie 字符串': 'Cookie string',
  'Cookie 导入失败': 'Failed to import Cookie',
  'Cookie 导入成功': 'Cookie imported successfully',
  '保存并登录': 'Save & Sign In',
  '刷新状态': 'Refresh Status',
  '可从已登录的网页版汽水音乐复制 Cookie；保存后写入本机服务':
    'Copy Cookie from a signed-in Soda Music web session; saved locally in the self-hosted service',
  '后端未连接': 'Backend disconnected',
  '启动中…': 'Starting…',
  '启动服务': 'Start Service',
  '导入中…': 'Importing…',
  '服务启动中': 'Service starting',
  '服务启动中…': 'Service starting…',
  '查看收藏': 'View Favorites',
  '检测到非回环端口暴露风险，建议重启服务以应用 127.0.0.1 监听隔离':
    'Non-loopback port exposure detected; restart the service to enforce 127.0.0.1 binding',
  '状态检测中…': 'Checking status…',
  '状态获取失败': 'Failed to fetch status',
  '登录会话由本机服务保管，无需在页面保留 Cookie；可点击上方「扫码登录」或「短信 / Cookie 登录」完成授权':
    'Login session is stored by the local service without saving Cookies in the browser; use QR Scan or SMS / Cookie Login above',
  '短信 / Cookie 登录': 'SMS / Cookie Login',
  '端口暴露风险': 'Port exposed',
  '粘贴完整 Cookie（含 sessionid / passport_csrf_token 等）':
    'Paste full Cookie (including sessionid / passport_csrf_token, etc.)',
  '自建收藏': 'Self-Hosted Favorites',
  '请先粘贴 Cookie': 'Please paste Cookie first',
  '重启': 'Restart',
  /* 设置页重构（导航分组 / Visual Workshop / 分层控制 / Schema 新增串 / AI 分析抽离） */
  '外观与视觉': 'Appearance & Visuals',
  '播放与性能': 'Playback & Performance',
  '服务与数据': 'Services & Data',
  '界面与关于': 'Interface & About',
  '全部 13 种模式 ▾': 'All 13 Modes ▾',
  '全部 14 种模式 ▾': 'All 14 Modes ▾',
  '跟随全局': 'Following Global',
  '已覆写': 'Overridden',
  '恢复跟随全局': 'Reset to Global',
  '已恢复跟随全局设置': 'Reset to global defaults',
  '未改动的项自动跟随「背景」与「字体」全局默认': 'Unmodified fields automatically follow global Background & Fonts defaults',
  '上一个视觉模式': 'Previous visual mode',
  '下一个视觉模式': 'Next visual mode',
  '经典歌词': 'Classic Lyrics',
  '空间粒子': 'Spatial & Particles',
  '动态分镜': 'Kinetic Storyboard',
  '版画建筑': 'Editorial & Architecture',
  '核心参数': 'Core Parameters',
  '进阶与后期处理': 'Advanced & Post-Processing',
  '独立背景与字体覆写': 'Per-Mode Background & Font Overrides',
  '诗镜 · Verse': 'Verse',
  '穿行 · Dimension': 'Dimension',
  '版画 · Tempera': 'Tempera',
  '封面与逐字双排居中/左对齐布局': 'Dual-pane cover art and syllable-synced lyrics',
  '聚焦渐隐排版，沉浸式阅读歌词': 'Minimalist focus typography with gentle fade',
  '逐词飞入浮现与景深渐变层次': 'Word-by-word kinetic entry with depth fog',
  '纵深穿行粒子空间与能量光晕': 'Deep 3D starfield fly-through with energy glow',
  '三维螺旋词云相机追焦漫游': '3D spiral word cloud with tracking camera',
  '蒙德里安几何隧道透视空间': 'Mondrian geometric perspective tunnel',
  '多镜头分镜排版 + 后期胶片特效': 'Multi-shot storyboard layout + film post-FX',
  '平面设计感动态排版与拼贴视效': 'Graphic motion typography & collage VFX',
  '金属铅字与古籍印章留白版式': 'Metal movable type with editorial seal stamps',
  '版画纸墨构图与高反差印刷分镜': 'Printmaking paper-and-ink high-contrast shots',
  '玻璃彩窗建筑光影与圣光浮尘': 'Stained-glass cathedral light shafts & motes',
  '晶体切面折射、光谱色散与焦散': 'Crystal facet refraction, dispersion & caustics',
  '蛋彩构图块与撞色丝网印刷动效': 'Tempera blocks with silkscreen color kinetics',
  '字号': 'Font Size',
  '文字反色块': 'Inverted Text Block',
  '字形动效': 'Glyph Motion',
  '运镜强度': 'Camera Intensity',
  '镜头转场': 'Shot Transitions',
  '显示构图块': 'Composition Blocks',
  '显示角标': 'Corner Badges',
  '显示装饰元素': 'Decorative Elements',
  '版画文字基准大小的倍率': 'Multiplier for Tempera base typography scale',
  '每句背后的开放画框；与「显示巨型背景字与几何构图」不同，后者管的是背景几何层': 'Open frame behind each line; separate from giant background glyphs and geometry',
  '字体管理': 'Font Manager',
  '13 种歌词视觉': '13 Visual Modes',
  '14 种歌词视觉': '14 Visual Modes',
  '逐字 / 圣殿 / 镜幕 / 棱镜 / 画册 / 活字 / 词云…': 'Word-sync / Vitrail / FocalCut / Prism / Folio / Letterpress / WordCloud…',
  '逐字 / PV 分镜 / 活字 / 版画 / 蒙德里安 / 隧道…': 'Karaoke / PV / Movable Type / Woodcut / Mondrian / Tunnel…',
  '情感词×': 'Emotion ×',
  '情绪：': 'Mood:',
  '未配置 Key': 'API Key Not Set',
  '正在准备...': 'Preparing...',
  '速度': 'Speed',
  '风格：': 'Style:',
  '重启中…': 'Restarting…',
  'Aria - 歌词播放器': 'Aria - Lyric Player',
  '定位当前播放曲目': 'Locate Current Track',
  '已恢复播放队列': 'Queue Restored',
  '已清空播放队列': 'Queue Cleared',
  '当前队列为空': 'Queue is empty',
  '确定要清空当前整个播放队列吗？（清空后 15 秒内可撤销）':
    'Clear the entire current queue? (Undoable within 15s)',
  '队列已清空': 'Queue cleared',
  '撤销清空': 'Undo Clear',
  '下一首播放': 'Play Next',
  '已设为下一首播放': 'Playing Next',
  '当前正在播放该曲目': 'Currently playing this track',
  '已经是下一首了': 'Already up next',
  '可尝试更换关键词，或点击顶部切换其他音源':
    'Try a different keyword or switch music sources above',
  '请检查网络连接或切换顶部音源后重试':
    'Check your network connection or switch sources and retry',
  '重新搜索': 'Retry Search',
  '请用汽水音乐 App 扫码授权（或切换上方「手机号 / Cookie」登录）':
    'Scan with the Soda Music app (or switch to Phone / Cookie above)',
  '验证码由汽水/抖音官方短信下发；登录态由本机服务保管':
    'Verification code is sent via Soda / Douyin SMS; login session is kept by the local service',

  /* —— 取链详情 / 平台与默认收藏 / 自建参数 / 歌词海报工坊 —— */
  '未上报': 'Not reported',
  '未知来源': 'Unknown source',
  '未知曲目': 'Untitled Track',
  '默认收藏': 'Default Collection',
  '接口与参数配置': 'API & Parameter Options',
  '按上游 API 自定义': 'Upstream API options',
  '保存并重启': 'Save & Restart',
  '应用': 'Apply',
  '取链音质偏好': 'Playback Quality Preference',
  '对应 /getMusicPlay 的 quality 参数': 'Maps to /getMusicPlay quality parameter',
  '跟随全局音质': 'Follow Global Quality',
  'FLAC 无损': 'FLAC Lossless',
  '无版权音质自动降级': 'Auto Quality Fallback',
  '高音质无直链时自动沿 flac→320→128 回退': 'Fall back flac→320→128 automatically when lossless link is unavailable',
  '每日推荐策略': 'Daily Recommendations Mode',
  '微信账号建议热门聚合；QQ账号可切个性化日推': 'WeChat login suggests popular mix; QQ login supports personalized daily recs',
  '热门歌单聚合': 'Popular Playlist Mix',
  '官方个性化日推': 'Official Personalized',
  '歌词格式化 (isFormat)': 'Lyric Formatting (isFormat)',
  '对应 /getLyric?isFormat 参数（换行整理）': 'Maps to /getLyric?isFormat line formatting',
  '搜索单页条数 (limit)': 'Search Page Size (limit)',
  '对应 /getSearchByKey?limit（上限 60）': 'Maps to /getSearchByKey?limit (max 60)',
  '60 首': '60 items',
  '30 首': '30 items',
  '20 首': '20 items',
  '10 首': '10 items',
  '匿名降级模式 (FALLBACK_MODE)': 'Anonymous Fallback (FALLBACK_MODE)',
  '服务端启用：未携带 Cookie 时允许基础接口匿名请求': 'Server-side: allow basic API requests without cookies',
  '全局兜底 Cookie (USE_GLOBAL_COOKIE)': 'Global Cookie Fallback (USE_GLOBAL_COOKIE)',
  '服务端启用：无显式 Cookie 时使用服务内置全局凭证': 'Server-side: use built-in global credentials when no cookie is given',
  '客户端版本 (platform)': 'Client Edition (platform)',
  '概念版支持签到领 VIP；更改后需重启酷狗服务生效': 'Lite supports daily VIP check-in; restarts KuGou service to apply',
  '酷狗概念版 (lite)': 'KuGou Lite (lite)',
  '手机正式版': 'Mobile Standard',
  '每日推荐客户端': 'Daily Recs Platform',
  '对应 /everyday/recommend?platform 参数': 'Maps to /everyday/recommend?platform',
  'iOS 端算法': 'iOS Algorithm',
  'Android 端算法': 'Android Algorithm',
  '上游代理 (KUGOU_API_PROXY)': 'Upstream Proxy (KUGOU_API_PROXY)',
  '可选 HTTP 代理地址（保存后重启服务生效）': 'Optional HTTP proxy URL (restarts service to apply)',
  '自建取链音质等级 (level)': 'Self-hosted Stream Quality (level)',
  '对应 /song/url/v1?level（支持臻品母带/沉浸环绕）': 'Maps to /song/url/v1?level (Master / Spatial supported)',
  '超清母带 (jymaster)': 'Master (jymaster)',
  '沉浸环绕声 (sky/c51)': 'Immersive Surround (sky/c51)',
  '高清环绕声 (jyeffect)': 'HD Surround (jyeffect)',
  'Hi-Res 无损': 'Hi-Res Lossless',
  '极高音质': 'Extreme (320k)',
  '较高音质': 'Higher (192k)',
  '标准音质': 'Standard (128k)',
  '试听/无版权音质降级': 'Trial / Rights Quality Fallback',
  '返回 30s 试听链时自动下探兼容音质，避免截断': 'Step down quality automatically when a 30s trial link is returned',
  '编码格式 (encodeType)': 'Audio Codec (encodeType)',
  '对应 /song/url/v1?encodeType 参数': 'Maps to /song/url/v1?encodeType',
  'FLAC (默认)': 'FLAC (Default)',
  '歌单曲目拉取上限': 'Playlist Fetch Limit',
  '对应 /playlist/track/all?limit 参数': 'Maps to /playlist/track/all?limit',
  '200 首': '200 tracks',
  '500 首': '500 tracks',
  '1000 首': '1000 tracks',
  '真实 IP (realIP)': 'Real IP (realIP)',
  '海外或代理环境可填国内 IPv4（如 116.25.146.177）': 'For overseas/proxy setups, enter a mainland IPv4 (e.g. 116.25.146.177)',
  '留空自动': 'Leave blank for auto',
  '请求代理 (proxy)': 'Request Proxy (proxy)',
  '可选透传给 Netease API 的代理 URL': 'Optional proxy URL forwarded to Netease API',

  /* —— 歌词海报 & 工坊 —— */
  '实景拾光': 'Live Stage',
  '完整保留视觉画面与氛围': 'Preserve live visual scene & atmosphere',
  '黑胶唱片': 'Vinyl Record',
  '旋转唱片封面 + 完整诗意歌词': 'Spinning vinyl cover + complete lyric lines',
  '极简诗笺': 'Minimalist Editorial',
  '高定杂志留白 + 整句金句排版': 'Magazine whitespace + full lyric typography',
  '光影胶片': 'Cinematic Film',
  '银幕宽画幅画面 + 双语台词字幕': 'Widescreen cinema frame + bilingual subtitles',
  '画报': 'Poster (3:4)',
  '3:4 · 小红书 / 海报': '3:4 · Portrait / Poster',
  '歌词海报工坊': 'Lyric Poster Studio',
  '正在渲染…': 'Rendering…',
  '当前画面暂无快照，已使用封面底图生成': 'No live snapshot available — rendered with cover backdrop',
  '海报渲染失败，请重试': 'Failed to render poster — please retry',
  '海报风格': 'Poster Style',
  '画幅比例': 'Aspect Ratio',
  '画面适配': 'View Fit',
  '完整保留可避免长句被左右裁切': 'Preserve width so long lyric sentences stay unclipped',
  '完整保留': 'Fit Whole',
  '裁切铺满': 'Fill & Crop',
  '纸面色调': 'Paper Tone',
  '深色夜笺': 'Dark Slate',
  '浅色纸笺': 'Warm Ivory',
  '显示译文': 'Show Translation',
  '显示模式角标': 'Show Mode Badge',
  '重新抓取画面': 'Recapture View',
  '挑选金句歌词': 'Select Lyric Lines',
  '实景拾光截取当前画面，切至其他风格可自由选句': 'Live Stage captures the current view; switch styles to pick lines',
  '仅选当前句': 'Current Line Only',
  '当前歌曲暂无歌词，仅展示歌曲封面与元数据': 'No lyrics for this track — showing cover & metadata',
  '复制图片': 'Copy Image',
  '保存高清 PNG': 'Save HD PNG',
  '正在生成…': 'Generating…',
  '至少保留 1 句歌词': 'Keep at least 1 lyric line',
  '最多选择 6 句歌词': 'Select at most 6 lyric lines',
  '海报已复制到剪贴板': 'Poster copied to clipboard',
  '当前环境不支持直接复制图片，请点击保存': 'Clipboard image copy unsupported here — please save instead',
  '海报复制失败': 'Failed to copy poster',
  '登录后日推/收藏/高音质走自建接口；无 VIP 试听链自动回退免费源池。扫码一次长期有效（登录态自动保存）。各平台启用开关决定对应功能是否优先自建：QQ 覆盖日推/收藏/歌单与取播放链接；酷狗覆盖日推/歌单/签到/KRC歌词兜底（播放链接仍走公网）；网易云覆盖日推/红心/云端歌单与高音质播放。':
    'When signed in, daily recs, favorites & lossless playback prioritize your self-hosted API (auto-falling back to public sources if unavailable). Sessions persist locally: QQ covers daily recs / favorites / playlists / links; KuGou covers daily recs / playlists / VIP check-in / KRC lyrics; NetEase covers daily recs / favorites / playlists / lossless audio.',
  '能力范围：搜索 · 逐字歌词 · 日推 · 云端歌单(可建删/编辑) · 红心收藏 · 高音质播放 · 歌手页':
    'Capabilities: Search · Word-by-word Lyrics · Daily Recs · Cloud Playlists (edit) · Favorites · High-Res Audio · Artist Pages',
  '能力范围：搜索 · 逐字歌词 · 日推 · 歌单/收藏(只读) · 高音质播放 · 歌手页':
    'Capabilities: Search · Word-by-word Lyrics · Daily Recs · Playlists & Favorites · High-Res Audio · Artist Pages',
  '能力范围：搜索兜底 · KRC 逐字歌词 · 日推 · 云端歌单(可建删/移除) · 签到领 VIP（播放走公网）':
    'Capabilities: Search Fallback · KRC Lyrics · Daily Recs · Cloud Playlists · Daily VIP Check-In (public audio links)',
  '点击句行切换当前画面定格句；切至其他风格可多句选摘': 'Click a line to capture it live; switch styles to pick lines',
  '开启你的音乐旅程': 'Start Your Listening Journey',
  '搜索想听的歌曲，或探索每日推荐与精选歌单': 'Search for a track, or explore Daily Mix and Playlists',
  '搜索歌曲': 'Search Songs',
  '纯音乐 / 暂无歌词': 'Instrumental / No Lyrics',
  '静享旋律，亦可切换视觉模式沉浸体验': 'Enjoy the music, or switch to a visual mode',
  '切换视觉模式': 'Switch Visual Mode',
  '诗境': 'Sonnet',
  '字缀': 'Jizura',
};

/* ===== i18n key 词条（JS 源码 t('key') 直调用，双语对象形态） ===== */
const KEY_PHRASES = {
  'ai.analyzing': { 'zh-CN': 'AI 正在分析…', 'en-US': 'AI Analyzing…' },
  'ai.generating': { 'zh-CN': '正在生成分析结果…', 'en-US': 'Generating analysis…' },
  'ai.done': { 'zh-CN': '分析完成', 'en-US': 'Analysis Complete' },
  'ai.doneTitle': { 'zh-CN': 'AI 分析完成', 'en-US': 'AI Analysis Complete' },
  'ai.error': { 'zh-CN': 'AI 分析失败', 'en-US': 'AI Analysis Failed' },
  'ai.analysisFailed': { 'zh-CN': 'AI 分析失败', 'en-US': 'AI Analysis Failed' },
  'ai.statusFailed': { 'zh-CN': '分析失败', 'en-US': 'Analysis Failed' },
  'ai.statusDone': { 'zh-CN': '分析完成', 'en-US': 'Analysis Complete' },
  'ai.statusAnalyzing': { 'zh-CN': '正在分析...', 'en-US': 'Analyzing...' },
  'ai.retrying': { 'zh-CN': 'AI 重试中', 'en-US': 'Retrying' },
  'ai.statusNotAnalyzed': { 'zh-CN': '未分析', 'en-US': 'Not Analyzed' },
  'ai.statusRestoredManual': { 'zh-CN': '已恢复手动主题', 'en-US': 'Manual theme restored' },
  'ai.statusCached': { 'zh-CN': '已分析（缓存）', 'en-US': 'Analyzed (Cached)' },
  'ai.moodLabel': { 'zh-CN': '情绪：', 'en-US': 'Mood: ' },
  'ai.styleLabel': { 'zh-CN': '风格：', 'en-US': 'Style: ' },
  'ai.speedLabel': { 'zh-CN': '速度', 'en-US': 'Speed ' },
  'ai.emotionWordsCount': { 'zh-CN': '情感词×', 'en-US': 'Emotion Words ×' },
  'ai.err401': { 'zh-CN': 'API 密钥无效，请检查设置', 'en-US': 'Invalid API Key, please check settings' },
  'ai.err429': { 'zh-CN': 'API 调用频率超限，请稍后再试', 'en-US': 'API rate limit exceeded, please try again later' },
  'ai.err500': { 'zh-CN': 'AI 服务器内部错误', 'en-US': 'AI server internal error' },
  'ai.err404': { 'zh-CN': 'API 地址或模型不存在', 'en-US': 'Endpoint or model not found' },
  'ai.proxyConfirmTitle': { 'zh-CN': 'AI 分析经反代接口中转', 'en-US': 'AI Analysis Routed via Reverse Proxy' },
  'ai.proxyConfirmDesc': {
    'zh-CN': '当前走自建反代接口（zsjsll-cf.de5.net）。\n\nAPI 密钥与歌词内容会经其中转（自建服务不落盘存储，仅转发）。\n\n如不放心，可到「设置 → AI」改回官方接口 generativelanguage.googleapis.com（大陆网络需自备代理）。\n\n继续使用当前接口？',
    'en-US': 'Currently using reverse proxy (zsjsll-cf.de5.net).\n\nAPI Key & lyrics are relayed through it (no data is stored, relay only).\n\nYou can switch back to the official endpoint generativelanguage.googleapis.com in "Settings → AI" at any time.\n\nContinue with current proxy?'
  },
  'ai.proxyWarnText': {
    'zh-CN': '当前走第三方反代（zsjsll-cf.de5.net），API 密钥与歌词将经其中转；可在下方关闭反代改用官方接口 generativelanguage.googleapis.com（大陆网络需代理）。',
    'en-US': 'Currently routing via proxy (zsjsll-cf.de5.net), API Key & lyrics will be relayed. You can disable proxy below to use official endpoint generativelanguage.googleapis.com.'
  },
  'ai.proxyTokenSaved': { 'zh-CN': '反代访问令牌已保存', 'en-US': 'Proxy token saved' },
  'ai.proxyTokenCleared': { 'zh-CN': '反代访问令牌已清除', 'en-US': 'Proxy token cleared' },
  'common.unknown': { 'zh-CN': '未知', 'en-US': 'Unknown' },
  'common.unknownArtist': { 'zh-CN': '未知', 'en-US': 'Unknown' },
  'common.default': { 'zh-CN': '默认', 'en-US': 'Default' },
  /* 关于页 Star/反馈按钮（index.html data-i18n 挂了 key 但词表一直没有 → 英文模式回退中文） */
  'settings.about.star': { 'zh-CN': '在 GitHub 上点个 Star', 'en-US': 'Star on GitHub' },
  'settings.about.issues': { 'zh-CN': '反馈问题', 'en-US': 'Report an Issue' }
};

/** 前缀映射：处理带动态数字/内容的文本（渲染时拼进文本的高频句式） */
const STATIC_PHRASE_PREFIX = [
  ['当前服务商: ', 'Current provider: '],
  ['专属秘钥', 'dedicated key'],
  ['专属密钥', 'dedicated key'],
  ['播放全部（', 'Play All ('],
  ['删除选中(', 'Delete Selected ('],
  ['已加载 ', 'Loaded '],
  ['第 ', 'Page '],
  ['共 ', ''],
  ['正在分析 ', 'Analyzing ']
];

let currentLang = 'zh-CN';

try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && /** @type {Record<string, any>} */ (DICTIONARY)[saved]) {
    currentLang = saved;
  }
} catch (_) { logCatch('i18n', _); }

/** 获取当前语言 */
export function getLanguage() {
  return currentLang;
}

/**
 * 只读查询：按「中文原文」精确取英文，全库唯一词表就是 STATIC_PHRASE_MAP。
 * 语义与 JS 渲染型面板原来的模块内 tx() 一致 —— 非英文模式原样返回（调用方
 * 不必自己判语言），词表没有的也原样返回（**绝不机翻兜底**）。
 * ★ 只 export 查询函数、不 export 词表本体：拿到表就会有人 `Object.keys` 之后
 *   自建第二份映射，284-diagnostics 的私有 PHRASE_EN 就是这么长出来的（2026-09-25）。
 * ★ 适用面：整页由 JS 拼 innerHTML 的面板（诊断页等）——这类面板的文本是英文时
 *   已经落地，i18n 的 DOM 扫描器按「整段文本节点等于中文」匹配，翻不到已经翻过的，
 *   所以必须在渲染前逐条查表；普通 textContent 赋值仍可由 observer 兜住。
 */
/** @param {string} zh @returns {string} */
export function translatePhrase(zh) {
  if (typeof zh !== 'string' || !zh) return zh;
  if (currentLang !== 'en-US') return zh;
  return /** @type {Record<string, string>} */ (STATIC_PHRASE_MAP)[zh] || zh;
}

/** 翻译：先查 KEY_PHRASES（双语对象），再查 DICTIONARY（当前语言词典），最后回退 fallback */
/**
 * @param {string} key
 * @param {string} [fallback]
 * @returns {string}
 */
export function t(key, fallback = '') {
  const kp = /** @type {Record<string, any>} */ (KEY_PHRASES)[key];
  if (kp) return kp[currentLang] || kp['zh-CN'] || fallback || key;
  const dict = /** @type {Record<string, any>} */ (DICTIONARY)[currentLang] || DICTIONARY['zh-CN'];
  if (dict && dict[key] !== undefined) return dict[key];
  return fallback || key;
}

/** 切换语言 */
/** @param {string} lang @returns {void} */
export function setLanguage(lang) {
  if (!/** @type {Record<string, any>} */ (DICTIONARY)[lang]) return;
  currentLang = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
    if (globalThis.appSettings && globalThis.appSettings.interface) {
      globalThis.appSettings.interface.language = lang;
    }
  } catch (_) { logCatch('i18n', _); }
  applyLanguageToDocument();
}

/** 单节点文本翻译：整句匹配 → 数字句式正则 → 前缀匹配（保留尾部数字/括号内容） */
/** @param {string} text @returns {string|null} 无可译内容时 null */
function translateTextNode(text) {
  const t0 = String(text || '').trim();
  if (!t0) return null;
  const _phraseHit = /** @type {Record<string, string>} */ (STATIC_PHRASE_MAP)[t0];
  if (_phraseHit) return _phraseHit;
  /* 动态数字句式（页码/加载计数/级别/核数） */
  let m = /^第\s*(\d+)\s*页\s*·\s*共\s*(\d+)\s*首$/.exec(t0);
  if (m) return `Page ${m[1]} · ${m[2]} songs`;
  m = /^已加载\s*(\d+)\s*首$/.exec(t0);
  if (m) return `Loaded ${m[1]}`;
  m = /^播放全部[（(](\d+)[）)]$/.exec(t0);
  if (m) return `Play All (${m[1]})`;
  m = /^删除选中\((\d+)\)$/.exec(t0);
  if (m) return `Delete Selected (${m[1]})`;
  m = /^(\d+)\s*级$/.exec(t0);
  if (m) return `Level ${m[1]}`;
  m = /^(\d+)\s*核$/.exec(t0);
  if (m) return `${m[1]} cores`;
  m = /^(\d+)\s*首歌曲$/.exec(t0);
  if (m) return `${m[1]} songs`;
  m = /^(\d+)\s*首\s*·\s*点击查看$/.exec(t0);
  if (m) return `${m[1]} songs · tap to view`;
  m = /^共\s*(\d+)\s*首收藏$/.exec(t0);
  if (m) return `${m[1]} favorites`;
  m = /^已缓存\s*(\d+)\s*首歌曲的分析结果$/.exec(t0);
  if (m) return `Cached analysis for ${m[1]} songs`;
  m = /^已登录\s*·\s*uid\s*(\S+)$/.exec(t0);
  if (m) return `Logged in · uid ${m[1]}`;
  m = /^(\d+)\s*个歌单\s*·\s*(\d+)\s*首本地音乐\s*·\s*(\d+)\s*平台$/.exec(t0);
  if (m) return `${m[1]} playlists · ${m[2]} local · ${m[3]} platforms`;
  m = /^已登录\s*·\s*(.+?)\s*\(uid\s*([^)]+)\)$/.exec(t0);
  if (m) return `Logged in · ${m[1]} (uid ${m[2]})`;
  m = /^在线\s*(\d+)\s*\/\s*(\d+)\s*·\s*已登录\s*(\d+)\s*\/\s*(\d+)$/.exec(t0);
  if (m) return `Online ${m[1]}/${m[2]} · Signed in ${m[3]}/${m[4]}`;
  m = /^共\s*(\d+)\s*个歌单\s*·\s*(\d+)\s*首本地音乐\s*·\s*(\d+)\s*平台$/.exec(t0);
  if (m) return `${m[1]} playlists · ${m[2]} local · ${m[3]} platforms`;
  m = /^来自\s*(.+?)\s*·\s*共\s*(\d+)\s*个歌单$/.exec(t0);
  if (m) {
    const rawSrc = m[1] || '';
    const srcEn = /** @type {Record<string, string>} */ (STATIC_PHRASE_MAP)[rawSrc] || rawSrc;
    return `From ${srcEn} · ${m[2]} playlists`;
  }
  m = /^解析池逐源尝试[（(](\d+)\s*级[）)]$/.exec(t0);
  if (m) return `Resolve-pool attempts (${m[1]})`;
  m = /^降级轨迹[（(](\d+)\s*条[）)]$/.exec(t0);
  if (m) return `Fallback trace (${m[1]})`;
  m = /^重试中\s*(\d+)\s*\/\s*(\d+)…?$/.exec(t0);
  if (m) return `Retrying ${m[1]}/${m[2]}…`;
  m = /^共\s*(\d+)\s*首$/.exec(t0);
  if (m) return `${m[1]} songs`;
  m = /^(\d+)\s*首$/.exec(t0);
  if (m) return `${m[1]} songs`;
  m = /^(\d+)\s*首歌$/.exec(t0);
  if (m) return `${m[1]} songs`;
  /* OOBE 步骤角标「步骤 1 / 4」 */
  m = /^步骤\s*(\d+)\s*\/\s*(\d+)$/.exec(t0);
  if (m) return `Step ${m[1]} / ${m[2]}`;
  /* 确认弹窗动态插值句（歌单名/文件夹名嵌中间，前缀映射拼不出来） */
  m = /^确定要删除歌单「(.+)」吗？此操作无法撤销。$/.exec(t0);
  if (m) return `Delete playlist "${m[1]}"? This cannot be undone.`;
  m = /^确定要从本地音乐库中删除「(.+)」吗？文件将被永久移除。$/.exec(t0);
  if (m) return `Remove "${m[1]}" from the local library? The files will be permanently deleted.`;
  m = /^播放全部：/.exec(t0);
  if (m) return 'Play All: ' + t0.slice(5);
  /* 歌手页副标题：平台名 + 作品统计/粉丝数（平台名前缀保持原文，与其它音源标签一致）。
     先匹配三段复合句，再匹配单段——顺序反了会把「x · 44 张专辑 · 568 首歌」截成专辑句。 */
  m = /^(.+?)\s*·\s*(\d+)\s*张专辑\s*·\s*(\d+)\s*首歌$/.exec(t0);
  if (m) return `${m[1]} · ${m[2]} albums · ${m[3]} tracks`;
  m = /^(.+?)\s*·\s*(.+?)\s*粉丝$/.exec(t0);
  if (m) return `${m[1]} · ${m[2]} followers`;
  m = /^(.+?)\s*·\s*(\d+)\s*张专辑$/.exec(t0);
  if (m) return `${m[1]} · ${m[2]} albums`;
  /* 视觉配方 toast 动态插值句（290，配方名嵌中间，碎片前缀拼不出英文引号闭合） */
  m = /^已保存配方「(.+)」$/.exec(t0);
  if (m) return `Saved recipe "${m[1]}"`;
  m = /^已重命名为「(.+)」$/.exec(t0);
  if (m) return `Renamed to "${m[1]}"`;
  m = /^已用当前外观覆盖「(.+)」$/.exec(t0);
  if (m) return `Overwritten with current look: "${m[1]}"`;
  m = /^已删除「(.+)」$/.exec(t0);
  if (m) return `Deleted "${m[1]}"`;
  m = /^已应用配方「(.+)」$/.exec(t0);
  if (m) return `Applied recipe "${m[1]}"`;
  m = /^已导入并应用，同时存为配方「(.+)」$/.exec(t0);
  if (m) return `Imported & applied, saved as recipe "${m[1]}"`;
  m = /^粘贴以\s*(.+?)\s*开头的分享码$/.exec(t0);
  if (m) return `Paste a share code starting with ${m[1]}`;
  for (const [zh, en] of STATIC_PHRASE_PREFIX) {
    if (!zh) continue;
    if (t0.startsWith(zh)) {
      const tail = t0.slice(zh.length);
      /* 前缀为空（如「共 」）时只保留数字尾巴，避免奇怪拼接 */
      return en + tail;
    }
  }
  return null;
}

/** 核心：对指定根扫描并应用翻译（供全量/局部两路复用） */
/**
 * @param {any} root 扫描起点（Document 或子树根）
 * @param {number} [_deadline] 预算截止时刻（performance.now 基准）。本函数**不读**它——
 *   超时判断由调用方（applyLanguageToUiRoots）在每次调用前统一做，这里只保留签名
 * @returns {void}
 */
function _scanI18n(root, _deadline) {
  if (!root) return;
  const isEn = (currentLang === 'en-US');

  // 1. 声明式 data-i18n 属性更新
  /** @type {any[]} */ (root.querySelectorAll?.('[data-i18n]') || []).forEach(el => {
    const k = el.getAttribute('data-i18n');
    if (k) el.textContent = t(k, el.textContent);
  });
  /** @type {any[]} */ (root.querySelectorAll?.('[data-i18n-placeholder]') || []).forEach(el => {
    const k = el.getAttribute('data-i18n-placeholder');
    if (k) el.placeholder = t(k, el.placeholder);
  });
  /** @type {any[]} */ (root.querySelectorAll?.('[data-i18n-title]') || []).forEach(el => {
    const k = el.getAttribute('data-i18n-title');
    if (k) el.title = t(k, el.title);
  });

  // 2. 输入类 placeholder
  /** @type {any[]} */ (root.querySelectorAll?.('input[placeholder]') || []).forEach(el => {
    const ph = (el.placeholder || '').trim();
    if (isEn) {
      if (/** @type {Record<string, string>} */ (STATIC_PHRASE_MAP)[ph]) {
        if (!el.dataset.i18nOriginPh) el.dataset.i18nOriginPh = ph;
        el.placeholder = /** @type {Record<string, string>} */ (STATIC_PHRASE_MAP)[ph];
      }
    } else if (el.dataset.i18nOriginPh) {
      el.placeholder = el.dataset.i18nOriginPh;
    }
  });

  // 3. 静态文本节点全量映射
  const textSel = '.setting-label, .setting-desc, .settings-group-title, .settings-tab span, ' +
    '.settings-nav-group-title, .setting-btn, .favorites-title, .play-all-btn span, ' +
    '.rank-playall, .page-btn, .page-info, .view-mode-name, .status-hint, ' +
    '.search-history-label, .aria-oobe-title, .aria-oobe-desc, .aria-oobe-sub, ' +
    '.setting-dropdown-item, .setting-dropdown-trigger, .search-btn, .search-btn span, ' +
    '.playlist-name, .playlist-meta, .view-mode-title, .view-mode-desc, .lyric-badge, .playlist-tag, ' +
    '.about-feature b, .about-feature span, .about-tagline, .about-version, .settings-header span, ' +
    '.source-btn, #favoritesHint, .plm-btn, .plm-count, .rank-empty, .empty-hint, .favorites-title, ' +
    '.tunnel-ai-confirm-title, .tunnel-ai-confirm-desc, .tunnel-ai-cost-label, .tunnel-ai-cost-value, ' +
    '.tunnel-ai-mode-name, .tunnel-ai-mode-sub, .plm-empty, .stats-empty, .rec-sources-header, ' +
    '.about-fine, .settings-nav-search, #aiStatusText, #aiStatusDetail, .ai-proxy-warn, ' +
    '.view-mode-name, .font-cat-tag, .font-cat-count, .font-upload-text, .font-upload-hint, ' +
    /* ★ OOBE 重构后新类名 + 确认弹窗 + 关于页项目卡（2026-09-25 用户反馈：英文模式
       OOBE/取消确定/关于页 folia 卡全部不翻译——字符串早在词表里，但这些元素的
       类名不在本名单，_scanI18n 永远扫不到。.aria-oobe-sub 是旧版残留死选择器 */
    '.aria-oobe-hero-title, .aria-oobe-hero-sub, .aria-oobe-step-tag, .aria-oobe-btn, ' +
    '.aria-oobe-label, .aria-oobe-scan-btn, .aria-oobe-colorchip span, ' +
    '.aria-dialog-title, .aria-dialog-desc, .aria-dialog-btn, .apc-text small, ' +
    /* 外观设置：分区标题「视图模式」+ 模式分段按钮（词条早就在表里，类名一直不在名单） */
    '.appearance-section-title, .appearance-mode-btn, .lyric-source-title, .selfhost-api-details summary > span, .selfhost-api-details option';
  /** @type {any[]} */ (root.querySelectorAll?.(textSel) || []).forEach(el => {
    /* ★ svg 图标按钮（<svg>…文本）保护：此类节点 children>0，但直接文本子节点
       可安全翻译（如 rank-playall「播放全部（N）」——此前被整节点跳过永不翻译） */
    if (el.children.length > 0) {
      const hasSvgChild = Array.from(el.children).some(c => /^svg$/i.test(c.tagName));
      if (!hasSvgChild) return;
      Array.from(el.childNodes).forEach(n => {
        if (n.nodeType !== 3) return;
        const t = (n.textContent || '').trim();
        if (!t) return;
        if (isEn) {
          const en = translateTextNode(t);
          if (en !== null && en !== t) {
            if (!n.__i18nOrig) n.__i18nOrig = t;
            n.textContent = en;
          }
        } else if (n.__i18nOrig) {
          n.textContent = n.__i18nOrig;
        }
      });
      return;
    }
    const text = (el.textContent || '').trim();
    if (!text) return;
    if (isEn) {
      const en = translateTextNode(text);
      if (en !== null && en !== text) {
        if (!el.dataset.i18nOrigin) el.dataset.i18nOrigin = text;
        el.textContent = en;
      }
    } else if (el.dataset.i18nOrigin) {
      el.textContent = el.dataset.i18nOrigin;
    }
  });

  // 4. title/data-tooltip 属性翻译
  /** @type {any[]} */ (root.querySelectorAll?.('[data-tooltip],[title]') || []).forEach(el => {
    const val = (el.getAttribute('data-tooltip') || el.getAttribute('title') || '').trim();
    if (!val || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return;
    if (isEn) {
      const en = /** @type {Record<string, string>} */ (STATIC_PHRASE_MAP)[val];
      if (en && en !== val) {
        if (!el.dataset.i18nOriginTip) el.dataset.i18nOriginTip = val;
        if (el.hasAttribute('data-tooltip')) el.setAttribute('data-tooltip', en);
        else el.setAttribute('title', en);
      }
    } else if (el.dataset.i18nOriginTip) {
      if (el.hasAttribute('data-tooltip')) el.setAttribute('data-tooltip', el.dataset.i18nOriginTip);
      else el.setAttribute('title', el.dataset.i18nOriginTip);
    }
  });
}

/** UI 弹层容器选择器：所有二级弹窗/面板都在这些根内（歌单/榜单/搜索/每日推荐/统计/
    识曲/导入等全是 .search-overlay；设置面板/右键菜单/AI 浮窗/毛玻璃弹窗/OOBE 各自独立）
    ★ .lyric-source-overlay 是「选择歌词来源 / 取链详情 / 应用诊断 / 下载歌词」四个面板共用的
      类根（index.html 里 5 个元素，#selfhostQrOverlay 本来就单列过），此前不在名单上 →
      这四种面板在英文模式下**完全没人翻译**，只能靠分片自己逐条查词表。补进来之后
      JS 自译（284）与 observer 兜底（275/170）叠加是幂等的：翻成英文的文本不再命中词表。 */
const UI_ROOT_SELECTOR = '.search-overlay, .settings-overlay, .ctx-menu, ' +
  '.ai-status-panel, .aria-dialog-overlay, #ariaOobeOverlay, #welcomeOverlay, #selfhostQrOverlay, #plmPanel, #favoritesOverlay, #rankTabs, ' +
  '.lyric-source-overlay';

/* ★ 轮转游标（2026-09-26 修「英文模式下 OOBE 永远是中文」）：预算原本是**一整轮共享**
   的 6ms，而 .settings-overlay 一个容器就能把它吃光（实测单轮 15ms）。原先每轮都从
   选择器列表的第 1 个容器开始 → 排在后面的 #ariaOobeOverlay / #welcomeOverlay /
   #plmPanel / #favoritesOverlay / .lyric-source-overlay **永远扫不到**：词条在表里、
   类名在名单里，就是没人去翻（实测连扫 12 轮 OOBE 仍是中文，而排在前面的
   .settings-tab 早已翻成英文）。改成从上次停下的位置继续，容器之间互相公平。 */
let _uiScanCursor = 0;

/** ★ 性能路径（2026-09-22）：只扫描 UI 弹层容器，绝不进入歌词区/播放器主 DOM。
    二级弹窗都是这些固定容器内的动态渲染，observer 触发后只扫几百节点而非全文档
    数千节点（此前全文档扫描 5 组 querySelectorAll 在大 DOM 上单轮 10ms+，
    播放时每次歌词重渲染都会触发 → 可感卡顿）。
    @param {string} [scopeSelector] 只翻某一个容器（通常是刚渲染完的那一个）：
      不与他人抢预算、也不会被饿到，比全表扫一遍便宜得多。 */
export function applyLanguageToUiRoots(scopeSelector) {
  if (typeof document === 'undefined') return;
  if (scopeSelector) {
    document.querySelectorAll(scopeSelector).forEach(root => {
      try { _scanI18n(root); } catch (e) { logCatch('i18n', e); }
    });
    return;
  }
  const roots = Array.prototype.slice.call(document.querySelectorAll(UI_ROOT_SELECTOR));
  if (!roots.length) return;
  const deadline = performance.now() + 6; /* 单轮 6ms 预算 */
  let completed = true;
  for (let i = 0; i < roots.length; i++) {
    const idx = (_uiScanCursor + i) % roots.length;
    /* 第一个容器无条件扫（保证有进展），之后每个都要先看预算 */
    if (i && performance.now() > deadline) { completed = false; break; }
    try {
      _scanI18n(roots[idx], deadline);
    } catch (e) {
      logCatch('i18n', e);
    }
    /* 这个容器没扫完（内部撞到 deadline）就把游标留在它身上，下一轮接着扫 */
    const done = performance.now() <= deadline;
    _uiScanCursor = done ? (idx + 1) % roots.length : idx;
    if (!done) { completed = false; break; }
  }
  /* ★ 续扫兜底（用户反馈：弹窗内容翻一半就停）：预算耗尽时若当轮没扫完，
     50ms 后再跑一轮——弹窗渲染后若再无 mutation，此前没人触发二轮，
     残余节点永远停在中文。 */
  if (!completed && currentLang !== 'zh-CN') {
    setTimeout(() => { try { applyLanguageToUiRoots(); } catch (e) { logCatch('i18n', e); } }, 50);
  }
}

/** 全量应用（语言手动切换等一次性场景）：整个文档 */
/* ★ 全文档扫描必须挪出「点击语言」那一个任务（2026-09-27 实测：OOBE 里切英文
   产生 359ms 长任务，300Hz 屏上等于白掉约 100 帧——就是用户说的「切英文之后这么卡」。
   卡的是这一段：约 50 组 querySelectorAll 打在 3300+ 节点的全文档上）。
   做法：看得见的弹层容器**同步**翻（几百节点），其余排到 idle 分片补齐。
   正确性不丢：aria:languagechange 仍在同一帧派发，各分片自译照旧；
   兜底扫描最迟 2 秒后一定跑完（requestIdleCallback 的 timeout）。 */
/** @type {any} */
let _fullScanIdle = null;

/** @param {any} root @returns {void} */
function _scheduleFullScan(root) {
  const clear = () => {
    if (_fullScanIdle === null) return;
    if (typeof cancelIdleCallback === 'function') cancelIdleCallback(_fullScanIdle);
    else clearTimeout(_fullScanIdle);
    _fullScanIdle = null;
  };
  clear();
  const run = () => { _fullScanIdle = null; try { _scanI18n(root); } catch (e) { logCatch('i18n', e); } };
  _fullScanIdle = (typeof requestIdleCallback === 'function')
    ? requestIdleCallback(run, { timeout: 2000 })
    : setTimeout(run, 0);
}

export function applyLanguageToDocument(root = (typeof document !== 'undefined' ? document : null)) {
  if (!root) return;
  if (typeof document !== 'undefined' && root !== document) {
    _scanI18n(root);            // 指定容器：调用方在等这一块变语言，同步做完
  } else {
    applyLanguageToUiRoots();   // 看得见的弹层先翻（几百节点）
    _scheduleFullScan(root);    // 播放器主 DOM 等剩下的排 idle
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('aria:languagechange', { detail: { lang: currentLang } }));
  }
}

// 挂载到全局
if (typeof window !== 'undefined') {
  /** @type {any} */ (globalThis).AriaI18n = {
    getLanguage,
    setLanguage,
    t,
    applyLanguageToDocument,
    applyLanguageToUiRoots   /* OOBE 切步等动态渲染后同步触发弹层翻译，免 50ms 防抖闪中文 */
  };

  /* ★ 全局动态渲染自动翻译（2026-09-22）：二级弹窗都是 JS 动态 innerHTML 渲染，
     时机无法逐个挂点——body 子树观察器 + 250ms 防抖兜底。
     ★ 性能（同日二次收敛）：回调只扫 UI 弹层容器（applyLanguageToUiRoots），
     绝不进歌词区/播放器主 DOM——播放期间每次歌词重渲染虽然仍会触发观察器，
     但扫描范围从全文档数千节点降到弹层几百节点（<1ms），不构成可感开销。
     应用幂等（翻译后的文本不再命中词表 → 不再写 DOM → 不循环）。
     ★ characterData 监听（2026-09-24 用户反馈：续推/已登录/循环播放等
     textContent 动态赋值的文本全部逃过翻译）：观察回调里先过滤——只有变更
     目标落在 UI 弹层根内才安排扫描；歌词区的 textContent 高频变更被
     closest 过滤挡掉，不产生扫描。 */
  try {
    /** @type {any} */
let _i18nTimer = null;
    /* ★ 「这个节点在不在弹层里」按节点缓存（2026-09-27 用户实测：切英文后
       **整页动画持续卡**，中文不卡）。原因就在这段：observer 对每次 DOM 变更都调
       `closest(UI_ROOT_SELECTOR)`，而播放时逐字高亮每帧要写几百个文本节点，
       等于把这笔查询按帧交一遍；中文分支在上一行就 return 了，所以只有英文卡。
       歌词节点是复用的（同一批 .word / fill 反复变更），缓存命中率接近 100%。 */
    const _inUiRoot = new WeakMap();
    /** @param {any} node @returns {boolean} */
    const inUiRoot = (node) => {
      if (!node || !(node.nodeType === 1 ? node.closest : null)) return false;
      const el = node.nodeType === 1 ? node : node.parentElement;
      if (!el) return false;
      let hit = _inUiRoot.get(el);
      if (hit === undefined) {
        hit = !!el.closest(UI_ROOT_SELECTOR);
        _inUiRoot.set(el, hit);
      }
      return hit;
    };
    /** @param {any} muts @returns {boolean} */
    const _mutationRelevant = (muts) => {
      for (const m of muts) {
        if (inUiRoot(m.target)) return true;
        if (m.addedNodes) {
          for (const n of m.addedNodes) {
            if (inUiRoot(n)) return true;
          }
        }
      }
      return false;
    };
    const _i18nObserver = new MutationObserver((muts) => {
      if (_i18nTimer || currentLang === 'zh-CN') return;
      if (!_mutationRelevant(muts)) return;
      _i18nTimer = setTimeout(() => {
        _i18nTimer = null;
        applyLanguageToUiRoots();
      }, 50);
    });
    const _startObserver = () => {
      if (document.body) _i18nObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
      else setTimeout(_startObserver, 300);
    };
    _startObserver();

    /* ★ 启动立即应用（用户反馈：英文模式先闪中文再变英文）：语言非中文时
       DOM 就绪即刻全量翻译一次，不等 observer 防抖——消除首屏中文闪现。
       全文档单轮几 ms，仅启动跑一次。 */
    if (currentLang !== 'zh-CN') {
      const _bootApply = () => {
        try { applyLanguageToDocument(); } catch (e) { /* 静默 */ }
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _bootApply);
      else _bootApply();
    }
  } catch (e) { /* ignore */ }
}
