/* ============================================================
 * core/vfxRecipe.js — 「视觉配方」的编解码与校验（纯逻辑，零 DOM 依赖）
 *
 * 干什么（todos #9）：把当前所有视觉参数（模式、字号、模糊、摇摆、高亮色、版式偏好）
 * 收成一个可命名保存 / 可复制成分享码发给朋友导入的「配方」。
 *
 * 为什么单独成 core：编解码与校验是全库唯一事实源——分片只管列 UI 和把值落到
 * appSettings，「哪些键算视觉参数」「什么值合法」必须由一张表说了算，否则
 * UI 加一个滑杆就得记得改两处（收集 + 校验），漏一处就是「保存了但没生效」。
 *
 * 三条硬规矩（外部输入入口，按 AGENTS 约束 8 对待）：
 *  1. **白名单收集**：只从 SCHEMA 里点名的路径读值。所以任何没被点名的键
 *     （token / 登录态 / 本地路径 / 音质 / 快捷键 / 语言）在编码侧就进不来，
 *     不是「编码后再过滤」——那种「先泄露再补救」的写法只要漏一个过滤点就完蛋。
 *     FORBIDDEN_KEYS 那份表是**第二道**：解码遇到它们时报的是「含敏感键」而不是
 *     「未知键」，让用户看得见为什么被拒。
 *  2. **拒绝而不是静默写入**：解码时任何未知键 / 类型不符 / 超范围值 / 版本不符 /
 *     校验和不对 → 整份配方作废并逐条给出原因。半收半弃会让用户以为自己那根
 *     滑杆坏了（值没落上去，但界面看起来「导入成功」）。
 *  3. **只回读、不回写解析结果**：validateRecipe 产出的对象是按 SCHEMA 逐个
 *     重建的新对象，键名来自本模块的常量表而非输入，所以 `__proto__` /
 *     `constructor` 这类键既进不了结果也污染不了原型（见 tests/js 的原型污染用例）。
 *
 * 分享码格式：`AriaVFX<schemaVersion>.<base64url(json)>.<checksum8>`
 *  · 版本号同时出现在前缀与 payload 的 sv 字段里，两处不一致也拒（手改前缀的
 *    典型症状就是只改了一处）。
 *  · json 走 canonicalJSON（键排序 + 无空白）→ 校验和稳定可复现。
 *  · checksum 是 FNV-1a-32 的十六进制：够抓「复制少了一段 / 中间粘错字符」，
 *    **不是**防伪签名——配方本来就是用户主动导入的第三方文本，真正的防线是白名单校验。
 * ============================================================ */

/** 当前 schema 版本。加/删/改字段语义时 +1，并同步 CODE_PREFIX。 */
export const SCHEMA_VERSION = 1;
/** 分享码前缀（不含版本数字）。 */
export const CODE_PREFIX = 'AriaVFX';
/** 一份分享码最多允许这么多字符，超了直接拒——防止粘贴一大段垃圾把面板卡住。 */
export const MAX_CODE_CHARS = 20000;
/** 解码后的 payload 最多这么多字节。 */
export const MAX_PAYLOAD_BYTES = 64 * 1024;
/** 命名预设上限：再多列表就没法看了，而且它会随 appSettings 一起进 user_config.json。 */
export const MAX_PRESETS = 50;
/** 预设名最长多少字符。 */
export const MAX_NAME_CHARS = 24;

/* ---------- 值类型 ---------- */

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
/* rgba() 是 highlightInactiveColor 的默认值形状（'rgba(255,255,255,0.6)'），必须收；
   但逗号/百分号之外的字符一律不收——这些值会直接落进 style.textContent 的模板里。 */
const FUNC_COLOR_RE = /^(?:rgb|rgba|hsl|hsla)\(\s*[\d.]+%?\s*(?:,\s*[\d.]+%?\s*){2,3}\s*\)$/;
const NAMED_COLOR_RE = /^[a-z]{3,20}$/;
/**
 * 可分享的内置字体键 —— 与 10-config-state.js 的 FONT_FAMILY_MAP 的键一致，
 * 外加 resolveFontFamily 认的 'inherit'（= 跟随全局）。
 * 名单外的一律不进配方：自定义字体是 IndexedDB 里的字体文件引用，换台机器就是死链；
 * 外观面板有时把整条 CSS stack（"'Noto Sans SC', sans-serif"）当值存进来，
 * 那玩意儿会直接落进 style.textContent 的模板——收进来等于开一个 CSS 注入面。
 */
export const BUILTIN_FONTS = ['default', 'inherit', 'serif', 'kai', 'hei', 'fangsong', 'mono'];

const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

/**
 * 校验单个值。返回 `{ ok, value }`（value 是归一化后的值）或 `{ ok:false, code, expect }`。
 * 归一化只做「数字字符串 → 数字」这一件事：设置面板的滑块写进 modeSettings 的
 * 往往是 '12' 而非 12，不归一化会把真实用户配置当非法值拒掉。
 */
export function validateValue(spec, raw) {
    if (spec === undefined || spec === null) return { ok: false, code: 'unknown-field' };
    switch (spec.type) {
        case 'bool': {
            if (typeof raw === 'boolean') return { ok: true, value: raw };
            if (raw === 'true' || raw === 'false') return { ok: true, value: raw === 'true' };
            return { ok: false, code: 'bad-type', expect: 'true / false' };
        }
        case 'int':
        case 'number': {
            let n;
            if (typeof raw === 'number') n = raw;
            else if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) n = Number(raw);
            else return { ok: false, code: 'bad-type', expect: 'number' };
            if (!Number.isFinite(n)) return { ok: false, code: 'bad-number', expect: '有限数值' };
            if (spec.type === 'int') {
                if (!Number.isInteger(n)) return { ok: false, code: 'not-integer', expect: '整数' };
            }
            if (n < spec.min || n > spec.max) {
                return { ok: false, code: 'out-of-range', expect: `${spec.min} ~ ${spec.max}` };
            }
            return { ok: true, value: n };
        }
        case 'enum': {
            if (typeof raw !== 'string' || spec.values.indexOf(raw) < 0) {
                return { ok: false, code: 'bad-enum', expect: spec.values.join(' / ') };
            }
            return { ok: true, value: raw };
        }
        case 'color': {
            if (typeof raw !== 'string') return { ok: false, code: 'bad-type', expect: '颜色' };
            const s = raw.trim();
            const shapeOk = HEX_COLOR_RE.test(s) || FUNC_COLOR_RE.test(s)
                || (spec.allowNamed === true && NAMED_COLOR_RE.test(s.toLowerCase()));
            if (!shapeOk) return { ok: false, code: 'bad-color', expect: '#rgb / #rrggbb / rgb() / rgba()' };
            return { ok: true, value: s };
        }
        case 'font': {
            if (typeof raw !== 'string') return { ok: false, code: 'bad-type', expect: '内置字体键' };
            /* 只认 FONT_FAMILY_MAP 那七个内置键：
               · 自定义字体是 IndexedDB 里的字体文件引用，换台机器就是死链，不能分享；
               · 外观面板有时把整条 CSS stack（"'Noto Sans SC', sans-serif"）当值存进来，
                 那玩意儿会直接落进 style.textContent 的模板——收进来等于开一个 CSS 注入面。
               编码侧遇到这两种值时 pickInto 会安静跳过（不分享 ≠ 静默写入非法值），
               导入侧则严格拒绝，因为分享码里出现它只可能是伪造的。 */
            if (BUILTIN_FONTS.indexOf(raw) < 0) {
                return { ok: false, code: 'bad-font-key', expect: BUILTIN_FONTS.join(' / ') };
            }
            return { ok: true, value: raw };
        }
        case 'id': {
            if (typeof raw !== 'string' || !ID_RE.test(raw)) {
                return { ok: false, code: 'bad-id', expect: '字母开头的标识符' };
            }
            return { ok: true, value: raw };
        }
        default:
            return { ok: false, code: 'bad-spec' };
    }
}

const tBool = () => ({ type: 'bool' });
const tInt = (min, max) => ({ type: 'int', min, max });
const tNum = (min, max) => ({ type: 'number', min, max });
const tEnum = (...values) => ({ type: 'enum', values });
const tColor = (opts) => ({ type: 'color', ...(opts || {}) });
const tFont = () => ({ type: 'font' });

/* ---------- 视图模式清单 ---------- */

/** 与 index.html 的 .view-mode-card[data-mode] 九个卡片一致；220 的 switchView 只认这些。 */
export const VIEW_MODES = [
    'cover', 'lyrics', 'flyin', 'wordcloud', 'pv', 'tunnel', 'dimension', 'letterpress', 'neon',
];

/* ---------- 命名空间字段表 ---------- */

/** 全局歌词排版（appSettings.lyrics）。 */
export const LYRICS_FIELDS = {
    fontSize: tNum(0.2, 3),
    blurLevel: tInt(0, 8),
    highlightColor: tColor(),
    highlightInactiveColor: tColor(),
    inactiveColor: tColor(),
    align: tEnum('left', 'center', 'right'),
    showTranslation: tBool(),
    showRomaji: tBool(),
    autoScroll: tBool(),
};

/** 背景（appSettings.background）。blur/brightness 与「背景」分栏同源。 */
export const BACKGROUND_FIELDS = {
    dynamicBg: tBool(),
    swayEnabled: tBool(),
    swayAmp: tInt(0, 60),
    swayDuration: tInt(2, 120),
    blur: tInt(0, 200),
    brightness: tNum(0.01, 1),
};

/**
 * 界面里属于「观感」的那几个（appSettings.interface）。
 * 刻意是子集：interface 还住着 language / advancedFonts / desktopLyrics，
 * 它们分别是「语言偏好 / 本机字体库引用 / 另一扇窗的握手状态」，见 FORBIDDEN_KEYS。
 * lyricWidth 收不进来是它有键无实现（全库只有 defaults.js 写过它，没人读），
 * lyricRadius 只被未接线的 core/themeEngine.js 读，活路径（190 applyInterfaceSettings）不读——
 * 收进配方等于给用户一个「导了没反应」的假开关。
 */
export const INTERFACE_FIELDS = {
    glassStrength: tInt(0, 100),
    compactMode: tBool(),
    themeColor: tColor(),
    fontFamily: tFont(),
};

/** 分模式版式里所有出现过的可调项（各模式再各自挑自己那份子集）。 */
export const MODE_FIELD_POOL = {
    align: tEnum('left', 'center', 'right'),
    fontSize: tNum(0.2, 3),
    blurLevel: tInt(0, 8),
    highlightColor: tColor(),
    highlightInactiveColor: tColor(),
    inactiveColor: tColor(),
    showTranslation: tBool(),
    showRomaji: tBool(),
    themeColor: tColor(),
    graphicColor: tColor(),
    bgColor: tColor(),
    bgBlur: tInt(0, 200),
    bgBrightness: tNum(0.01, 1),
    swayEnabled: tBool(),
    swayAmp: tInt(0, 60),
    swayDuration: tInt(2, 120),
    fontFamily: tFont(),
    /* 202 的 ensureEmotionGlowSliders 会把这根滑杆注进每一个 [data-mode-section]，所以全员可用 */
    emotionGlow: tInt(0, 40),
    /* 飞入 */
    flyinTranslateY: tInt(0, 80),
    flyinScale: tNum(0.1, 1.5),
    flyinGlow: tInt(0, 60),
    flyinTransSize: tInt(0, 60),
    flyinTransBottom: tInt(0, 80),
    /* 词云：面板用的是 wc* 这套键名（56/57/200 读的都是它）；
       defaults.js 里那组 wordcloud* 名字当前无人读，收了也不生效 → 一起留着，
       等哪天接上就不用改 schema（改 schema = 版本 bump = 老分享码全废）。 */
    wcFontMin: tNum(0.1, 12),
    wcFontMax: tNum(0.1, 24),
    wcDensity: tInt(1, 120),
    wcLerpFactor: tNum(0.001, 1),
    wcDimBlur: tNum(0, 24),
    wcDimOpacity: tNum(0, 1),
    wordcloudFov: tInt(1, 179),
    wordcloudMinFont: tInt(4, 200),
    wordcloudMaxFont: tInt(4, 400),
    wordcloudDepth: tInt(50, 4000),
    /* PV / 隧道 */
    preset: tEnum('dream', 'anime', 'cyber', 'minimal'),
    cameraSpeed: tNum(0.05, 10),
    cameraZoom: tNum(0.1, 10),
    cameraDamping: tNum(0.001, 1),
    transitDuration: tInt(50, 4000),
    rowGap: tInt(10, 400),
    halftoneSize: tInt(1, 40),
    showHud: tBool(),
    showParticles: tBool(),
    showDecorations: tBool(),
    showStreaks: tBool(),
    showEcho: tBool(),
    aiColorSync: tBool(),
    mosaicTilt: tBool(),
};

/**
 * 每个模式实际可调的键（来源：index.html 各 [data-mode-section] 里的 data-var
 * + defaults.js modeSettings + 190 applyModeSettings 兜底表 的并集）。
 * 不在表里的键不收集，是为了不让配方里堆一串没人读的键。
 */
export const MODE_FIELDS_BY_MODE = {
    cover: ['fontSize', 'blurLevel', 'highlightColor', 'highlightInactiveColor', 'inactiveColor',
        'align', 'showTranslation', 'showRomaji', 'themeColor', 'bgBlur', 'bgBrightness',
        'swayEnabled', 'swayAmp', 'swayDuration', 'fontFamily', 'emotionGlow'],
    lyrics: ['fontSize', 'blurLevel', 'highlightColor', 'highlightInactiveColor', 'inactiveColor',
        'align', 'showTranslation', 'showRomaji', 'themeColor', 'bgBlur', 'bgBrightness',
        'swayEnabled', 'swayAmp', 'swayDuration', 'fontFamily', 'emotionGlow'],
    flyin: ['align', 'fontSize', 'blurLevel', 'flyinTranslateY', 'flyinScale', 'flyinGlow',
        'flyinTransSize', 'flyinTransBottom', 'highlightColor', 'showTranslation', 'showRomaji',
        'graphicColor', 'themeColor', 'bgBlur', 'bgBrightness', 'swayEnabled', 'swayAmp',
        'swayDuration', 'fontFamily', 'emotionGlow'],
    wordcloud: ['align', 'fontSize', 'blurLevel',
        'wcFontMin', 'wcFontMax', 'wcDensity', 'wcLerpFactor', 'wcDimBlur', 'wcDimOpacity',
        'wordcloudFov', 'wordcloudMinFont', 'wordcloudMaxFont', 'wordcloudDepth',
        'highlightColor', 'showTranslation', 'showRomaji', 'themeColor', 'bgBlur', 'bgBrightness',
        'swayEnabled', 'swayAmp', 'swayDuration', 'fontFamily', 'emotionGlow'],
    pv: ['align', 'fontSize', 'blurLevel', 'cameraZoom', 'cameraSpeed', 'cameraDamping',
        'halftoneSize', 'preset', 'showHud', 'showDecorations', 'showParticles', 'aiColorSync',
        'highlightColor', 'showTranslation', 'showRomaji', 'graphicColor', 'themeColor',
        'bgBlur', 'bgBrightness', 'swayEnabled', 'swayAmp', 'swayDuration', 'fontFamily', 'emotionGlow'],
    tunnel: ['align', 'fontSize', 'blurLevel', 'cameraSpeed', 'cameraDamping', 'transitDuration',
        'rowGap', 'emotionGlow', 'mosaicTilt', 'showStreaks', 'showEcho', 'aiColorSync',
        'highlightColor', 'showTranslation', 'showRomaji', 'graphicColor', 'themeColor',
        'bgBlur', 'bgBrightness', 'swayEnabled', 'swayAmp', 'swayDuration', 'fontFamily'],
    dimension: ['fontSize', 'highlightColor', 'showTranslation', 'showRomaji', 'bgColor',
        'themeColor', 'fontFamily', 'emotionGlow'],
    letterpress: ['fontSize', 'highlightColor', 'showTranslation', 'themeColor', 'fontFamily', 'emotionGlow'],
    neon: ['fontSize', 'highlightColor', 'showTranslation', 'themeColor', 'fontFamily', 'emotionGlow'],
};

/** 配方的四个组，UI 说明与统计共用这一份顺序。 */
export const RECIPE_GROUPS = [
    { key: 'mode', label: '视觉模式', desc: '当前处于哪一个歌词视图（封面 / 歌词 / 飞入 / 词云 / PV / 隧道 / 浮空 / 活字 / 霓虹）' },
    { key: 'lyrics', label: '歌词排版', desc: '字号、行模糊、高亮色与三种文字颜色、对齐、翻译/罗马音、自动滚动' },
    { key: 'background', label: '背景', desc: '动态背景开关、模糊半径、亮度、呼吸摇摆的开关/幅度/周期' },
    { key: 'interface', label: '界面观感', desc: '主题色、毛玻璃强度、紧凑模式、界面字体（只这几个，语言与本机字体库不含）' },
    { key: 'modeSettings', label: '各模式版式偏好', desc: '每个视觉模式独立记住的那套参数（镜头、阻尼、行距、词云字号区间、发光强度…）' },
];

/**
 * 明确「不进配方」的键（编码侧本就收不到，这里留一份表是为了：
 * ① 解码遇到同名键时能给出「含敏感键」而不是含糊的「未知键」；
 * ② UI 里能原样告诉用户为什么分享码里没有他的 API Key。）
 * 每一项都是「绝不能进」或「进了会伤人」，理由一并写在这里，UI 文案与测试共用。
 */
export const FORBIDDEN_KEYS = [
    { key: 'ai', reason: 'AI 的 apiKey / apiBase / providerConfigs 全是凭据，落进分享码等于把 key 发给朋友' },
    { key: 'apiKey', reason: '第三方服务访问密钥' },
    { key: 'apiBase', reason: '自建反代地址，常带个人域名与鉴权参数' },
    { key: 'providerConfigs', reason: '按平台分装的 API Key 集合，比单个 apiKey 泄漏面更大' },
    { key: 'selfhost', reason: 'QQ / 酷狗 / 网易云的登录态（q36 / musicu / QDone 之类），泄漏即可被冒用' },
    { key: 'token', reason: '任何形状的会话令牌' },
    { key: 'cookie', reason: '任何形状的会话 Cookie' },
    { key: 'session', reason: '登录会话标识，换台机器或被别人拿到即可直接冒用账号' },
    { key: 'password', reason: '任何形式的口令，出现即视为凭据泄漏' },
    { key: 'secret', reason: '签名/加密密钥，与 apiKey 同级' },
    { key: 'nowPlaying', reason: '含本机 Now Playing 查询地址（localhost + 端口 = 本地拓扑）' },
    { key: 'localMusic', reason: '本地音乐目录是绝对路径' },
    { key: 'path', reason: '任何路径类键：别人机器上没有这个目录' },
    { key: 'url', reason: '任何 URL 类键：可能内嵌签名或指向内网' },
    { key: 'language', reason: '语言是人的偏好不是外观，朋友的一句分享不该把你的界面改成英文' },
    { key: 'advancedFonts', reason: '指向本机 IndexedDB 里字体文件的引用与文件名，换台机器就是死链' },
    { key: 'desktopLyrics', reason: '桌面歌词是另一扇窗的运行时状态，要走 250 的 postMessage 握手才生效；单写 appSettings 会出现「导了没反应」' },
    { key: 'lyricWidth', reason: '全库只有 defaults.js 写过它，无人读取（有键无实现）' },
    { key: 'lyricRadius', reason: '只被未接线的 core/themeEngine.js 读，活路径 190 applyInterfaceSettings 不读' },
    { key: 'quality', reason: '音质不是视觉，且各账号可用音质不同' },
    { key: 'playback', reason: '音量 / 播放模式 / 倍速属音频行为，且会当场改变正在放的歌' },
    { key: 'audio', reason: '默认 EQ 预设属音效；EQ 有自己的分享码（AriaEQ1.）' },
    { key: 'shortcuts', reason: '快捷键是各人的肌肉记忆，导入别人的会把你的键位抢掉' },
    { key: 'vfxRecipes', reason: '配方清单自身——递归进去会随导入次数指数膨胀' },
    { key: 'readability', reason: '可读性增强是「当前这屏看不清」的临时应对，不是想要的观感；且它靠 283 自己的开关写' },
    { key: 'zen', reason: '专注模式的开关与空闲秒数是使用习惯不是外观' },
    { key: 'favorites', reason: '收藏列表是内容不是外观，且能反映你在听什么' },
    { key: 'playlist', reason: '歌单内容是私人数据，配方只该带观感' },
    { key: 'recent', reason: '最近播放历史 = 听歌记录，属隐私' },
    { key: 'performance', reason: '性能档位绑硬件；高配机器导给低配朋友会当场卡死' },
    { key: 'perfVfxOverrides', reason: '同上：视觉开销覆盖是「我这台机器跑不动」的产物' },
];

const FORBIDDEN_SET = new Set(FORBIDDEN_KEYS.map(f => String(f.key).toLowerCase()));
/* 兜底敏感名：这些词只要作为一个完整词元出现就该拦 */
const SENSITIVE_WORD_RE = /(?:^|[^a-z])(token|cookie|secret|password|passwd|credential|q36|musicu|authorization)(?:[^a-z]|$)/;

/** 这个键名是否命中敏感名单（大小写不敏感，含子串命中 token/cookie/secret/password 这一类） */
export function isForbiddenKey(name) {
    const s = String(name == null ? '' : name).trim().toLowerCase();
    if (!s) return false;
    if (FORBIDDEN_SET.has(s)) return true;
    return SENSITIVE_WORD_RE.test(s);
}

/* ---------- canonical JSON + base64url + FNV ---------- */

function utf8Encode(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
        let c = str.charCodeAt(i);
        if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
            const lo = str.charCodeAt(i + 1);
            if (lo >= 0xDC00 && lo <= 0xDFFF) {
                c = 0x10000 + ((c - 0xD800) << 10) + (lo - 0xDC00);
                i++;
            }
        }
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
}

function utf8Decode(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length;) {
        const b = bytes[i++];
        let cp;
        if (b < 0x80) cp = b;
        else if (b < 0xE0) cp = ((b & 31) << 6) | (bytes[i++] & 63);
        else if (b < 0xF0) cp = ((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
        else cp = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
        if (cp > 0x10FFFF) return null;
        if (cp < 0x10000) out += String.fromCharCode(cp);
        else {
            const v = cp - 0x10000;
            out += String.fromCharCode(0xD800 + (v >> 10), 0xDC00 + (v & 1023));
        }
    }
    return out;
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Uint8Array / number[] → base64url（无填充）。自己实现是为了在 Node 测试里也不依赖 btoa。 */
export function base64urlEncode(bytes) {
    let out = '';
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63]
            + B64_ALPHABET[(n >> 6) & 63] + B64_ALPHABET[n & 63];
    }
    const rest = bytes.length - i;
    if (rest === 1) {
        const n = bytes[i] << 16;
        out += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63];
    } else if (rest === 2) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
        out += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63] + B64_ALPHABET[(n >> 6) & 63];
    }
    return out;
}

/** base64url → number[]；遇到字母表外的字符即判非法（不做「宽容跳过」）。 */
export function base64urlDecode(text) {
    const clean = String(text).replace(/=+$/, '');
    if (!clean) return [];
    const rev = {};
    for (let i = 0; i < B64_ALPHABET.length; i++) rev[B64_ALPHABET[i]] = i;
    const out = [];
    let acc = 0;
    let bits = 0;
    for (let i = 0; i < clean.length; i++) {
        const v = rev[clean[i]];
        if (v === undefined) return null;
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((acc >> bits) & 255);
        }
    }
    return out;
}

/** FNV-1a 32 位；只用于抓复制截断/串错字符，不是签名。 */
export function checksum32(str) {
    let h = 0x811c9dc5;
    const bytes = utf8Encode(str);
    for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i];
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

/** 键排序 + 无空白的 JSON。校验和要稳定，序列化就不能依赖对象的插入顺序。 */
export function canonicalJSON(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const k of keys) {
        if (value[k] === undefined) continue;
        parts.push(JSON.stringify(k) + ':' + canonicalJSON(value[k]));
    }
    return '{' + parts.join(',') + '}';
}

/* ---------- 收集（编码侧） ---------- */

function pickInto(source, fields, target) {
    if (!source || typeof source !== 'object') return 0;
    let n = 0;
    for (const key of Object.keys(fields)) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        const r = validateValue(fields[key], source[key]);
        if (r.ok) { target[key] = r.value; n++; }
    }
    return n;
}

/**
 * 从 appSettings（+ 当前视图模式）收集一份配方。
 * 只读 SCHEMA 点名的路径 → 敏感键在结构上就进不来。
 * 空组不写键，这样「只改了背景」的配方不会带一堆默认值把朋友的其他设置冲掉。
 * @param {Object} settings appSettings
 * @param {string} [mode] 当前视图模式（不在 VIEW_MODES 里则不写 mode）
 * @param {string[]} [modes] 要收集哪几个模式的版式偏好。
 *   **默认全收**：「保存当前所有视觉参数」就该把用户调过的每个模式都带上，
 *   只收当前模式会让朋友拿到一个「切到 PV 就掉回默认」的半份配方。
 */
export function collectRecipe(settings, mode, modes) {
    const s = (settings && typeof settings === 'object') ? settings : {};
    const recipe = { sv: SCHEMA_VERSION };
    if (VIEW_MODES.indexOf(mode) >= 0) recipe.mode = mode;

    const lyrics = {};
    if (pickInto(s.lyrics, LYRICS_FIELDS, lyrics)) recipe.lyrics = lyrics;

    const bg = {};
    if (pickInto(s.background, BACKGROUND_FIELDS, bg)) recipe.background = bg;

    const iface = {};
    if (pickInto(s.interface, INTERFACE_FIELDS, iface)) recipe.interface = iface;

    const wanted = (Array.isArray(modes) && modes.length ? modes : VIEW_MODES).filter(m => VIEW_MODES.indexOf(m) >= 0);
    const ms = (s.modeSettings && typeof s.modeSettings === 'object') ? s.modeSettings : null;
    if (ms) {
        const out = {};
        for (const m of wanted) {
            const list = MODE_FIELDS_BY_MODE[m];
            if (!list) continue;
            const fields = {};
            for (const key of list) fields[key] = MODE_FIELD_POOL[key];
            const one = {};
            if (pickInto(ms[m], fields, one)) out[m] = one;
        }
        if (Object.keys(out).length) recipe.modeSettings = out;
    }
    return recipe;
}

/* ---------- 校验（解码侧） ---------- */

function fail(errors, path, code, expect, got) {
    errors.push({ path, code, expect: expect || '', got: got === undefined ? '' : String(got).slice(0, 40) });
}

/** 输入必须是「对象字面量」形状，不能是数组/Date/函数这类带原型的活对象 */
function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 严格校验一份配方：任何未知键 / 敏感键 / 非法值都会产出错误项。
 * @returns {{ok:true, recipe:Object}|{ok:false, errors:Array}}
 */
export function validateRecipe(input) {
    const errors = [];
    if (!isPlainObject(input)) {
        fail(errors, '$', 'bad-shape', '一个 JSON 对象', Array.isArray(input) ? 'array' : typeof input);
        return { ok: false, errors };
    }

    for (const key of Object.keys(input)) {
        if (key !== 'sv' && key !== 'mode' && key !== 'lyrics' && key !== 'background'
            && key !== 'interface' && key !== 'modeSettings') {
            fail(errors, key, isForbiddenKey(key) ? 'forbidden-key' : 'unknown-field',
                isForbiddenKey(key) ? '不允许出现（见「配方不含哪些设置」）' : 'sv / mode / lyrics / background / interface / modeSettings', key);
        }
    }

    const sv = input.sv;
    if (sv !== undefined && (typeof sv !== 'number' || !Number.isInteger(sv) || sv < 1)) {
        fail(errors, 'sv', 'bad-schema-version', '正整数版本号', sv);
    } else if (typeof sv === 'number' && sv !== SCHEMA_VERSION) {
        fail(errors, 'sv', 'schema-version-mismatch', '本版本支持 sv=' + SCHEMA_VERSION, sv);
    }

    const out = { sv: SCHEMA_VERSION };

    if (input.mode !== undefined) {
        const r = validateValue(tEnum.apply(null, VIEW_MODES), input.mode);
        if (r.ok) out.mode = r.value;
        else fail(errors, 'mode', r.code, r.expect, input.mode);
    }

    /* 三个平铺命名空间 */
    const spaces = [
        ['lyrics', LYRICS_FIELDS],
        ['background', BACKGROUND_FIELDS],
        ['interface', INTERFACE_FIELDS],
    ];
    for (const [name, fields] of spaces) {
        if (input[name] === undefined) continue;
        const src = input[name];
        if (!isPlainObject(src)) { fail(errors, name, 'bad-shape', '一个对象', typeof src); continue; }
        const target = {};
        for (const key of Object.keys(src)) {
            if (!Object.prototype.hasOwnProperty.call(fields, key)) {
                fail(errors, name + '.' + key, isForbiddenKey(key) ? 'forbidden-key' : 'unknown-field',
                    isForbiddenKey(key) ? '不允许出现' : Object.keys(fields).join(' / '), key);
                continue;
            }
            const r = validateValue(fields[key], src[key]);
            if (r.ok) target[key] = r.value;
            else fail(errors, name + '.' + key, r.code, r.expect, src[key]);
        }
        if (Object.keys(target).length) out[name] = target;
    }

    /* modeSettings：两层，第二层的允许键集按模式走 */
    if (input.modeSettings !== undefined) {
        const src = input.modeSettings;
        if (!isPlainObject(src)) fail(errors, 'modeSettings', 'bad-shape', '一个对象', typeof src);
        else {
            const target = {};
            for (const modeKey of Object.keys(src)) {
                if (VIEW_MODES.indexOf(modeKey) < 0) {
                    fail(errors, 'modeSettings.' + modeKey, 'unknown-mode', VIEW_MODES.join(' / '), modeKey);
                    continue;
                }
                const inner = src[modeKey];
                if (!isPlainObject(inner)) {
                    fail(errors, 'modeSettings.' + modeKey, 'bad-shape', '一个对象', typeof inner);
                    continue;
                }
                const list = MODE_FIELDS_BY_MODE[modeKey] || [];
                const one = {};
                for (const key of Object.keys(inner)) {
                    if (list.indexOf(key) < 0 || !MODE_FIELD_POOL[key]) {
                        fail(errors, 'modeSettings.' + modeKey + '.' + key,
                            isForbiddenKey(key) ? 'forbidden-key' : 'unknown-field',
                            isForbiddenKey(key) ? '不允许出现' : '该模式的版式参数名', key);
                        continue;
                    }
                    const r = validateValue(MODE_FIELD_POOL[key], inner[key]);
                    if (r.ok) one[key] = r.value;
                    else fail(errors, 'modeSettings.' + modeKey + '.' + key, r.code, r.expect, inner[key]);
                }
                if (Object.keys(one).length) target[modeKey] = one;
            }
            if (Object.keys(target).length) out.modeSettings = target;
        }
    }

    if (errors.length) return { ok: false, errors };
    /* 全空配方没意义：明确拒掉，免得 UI 显示「导入成功」却什么都没变 */
    if (Object.keys(out).length <= 1) return { ok: false, errors: [{ path: '$', code: 'empty', expect: '至少一项视觉参数', got: '' }] };
    return { ok: true, recipe: out };
}

/* ---------- 编解码 ---------- */

/** 配方 → 分享码。 */
export function encodeRecipe(recipe) {
    const v = validateRecipe(recipe);
    if (!v.ok) {
        const e = new Error('配方不合法：' + v.errors.map(x => x.path + '(' + x.code + ')').join(', '));
        e.code = 'invalid-recipe';
        e.errors = v.errors;
        throw e;
    }
    const json = canonicalJSON(v.recipe);
    const code = CODE_PREFIX + SCHEMA_VERSION + '.' + base64urlEncode(utf8Encode(json)) + '.' + checksum32(json);
    if (code.length > MAX_CODE_CHARS) {
        const e = new Error('配方过大（' + code.length + ' 字符 > ' + MAX_CODE_CHARS + '）');
        e.code = 'too-large';
        throw e;
    }
    return code;
}

/** 人读的错误码 → 中文说明。UI 展示与测试都查这张表。 */
export const ERROR_TEXT = {
    'bad-shape': '格式不对',
    'bad-schema-version': '版本号不是整数',
    'schema-version-mismatch': '配方版本与本程序不一致',
    'version-prefix-mismatch': '分享码版本与本程序不一致',
    'bad-prefix': '不是 Aria 视觉配方分享码',
    'bad-structure': '分享码结构不完整',
    'bad-base64': '分享码含非法字符',
    'too-large': '分享码超长',
    'checksum-mismatch': '校验和不符（复制不完整或被改过）',
    'bad-json': '内容不是有效 JSON',
    'bad-utf8': '内容编码非法',
    'unknown-field': '含本程序不认识的参数',
    'unknown-mode': '含不存在的视觉模式',
    'forbidden-key': '含不允许分享的敏感参数',
    'bad-type': '取值类型不对',
    'bad-number': '取值不是有效数字',
    'not-integer': '取值需为整数',
    'out-of-range': '取值超出允许范围',
    'bad-enum': '取值不在候选清单内',
    'bad-color': '颜色写法不被允许',
    'bad-font-key': '字体写法不被允许',
    'bad-id': '标识写法不被允许',
    'bad-spec': '内部校验规则缺失',
    'unknown': '无法解析',
    empty: '配方里没有任何视觉参数',
};

/**
 * 分享码 → 配方。**只返回结果，绝不写任何东西**（写入是调用方在 ok 之后做的事）。
 * @param {string} code
 * @returns {{ok:true, recipe:Object}|{ok:false, errors:Array<{path,code,expect,got}>}}
 */
export function decodeRecipe(code) {
    const errors = [];
    const raw = String(code == null ? '' : code).replace(/[\r\n\t ]+/g, '');
    if (!raw) {
        fail(errors, '$', 'bad-prefix', CODE_PREFIX + SCHEMA_VERSION + '.…', '');
        return { ok: false, errors };
    }
    if (raw.length > MAX_CODE_CHARS) {
        fail(errors, '$', 'too-large', '≤ ' + MAX_CODE_CHARS + ' 字符', raw.length);
        return { ok: false, errors };
    }
    const prefix = CODE_PREFIX + SCHEMA_VERSION + '.';
    if (raw.indexOf(prefix) !== 0) {
        /* 前缀里的版本号与本程序不同 → 明确的「版本不符」，而不是笼统的「不是分享码」：
           用户拿到 v2 分享码时必须知道是「程序该升级」，不是「朋友发错了」。
           手数字符而不是正则：省掉一层转义，也避开「前缀改名忘改正则」。 */
        if (raw.indexOf(CODE_PREFIX) === 0) {
            let i = CODE_PREFIX.length;
            let digits = '';
            while (i < raw.length && raw[i] >= '0' && raw[i] <= '9') { digits += raw[i]; i++; }
            if (digits && raw[i] === '.') {
                fail(errors, '$', 'version-prefix-mismatch', '需要 v' + SCHEMA_VERSION + ' 的分享码', 'v' + digits);
                return { ok: false, errors };
            }
        }
        fail(errors, '$', 'bad-prefix', prefix + '…', raw.slice(0, 16));
        return { ok: false, errors };
    }
    const body = raw.slice(prefix.length);
    const dot = body.lastIndexOf('.');
    if (dot <= 0 || dot === body.length - 1) {
        fail(errors, '$', 'bad-structure', 'payload 与校验和两段', body.slice(0, 16));
        return { ok: false, errors };
    }
    const b64 = body.slice(0, dot);
    const sum = body.slice(dot + 1).toLowerCase();
    if (!/^[0-9a-f]{8}$/.test(sum)) {
        fail(errors, '$', 'bad-structure', '8 位十六进制校验和', sum);
        return { ok: false, errors };
    }
    const bytes = base64urlDecode(b64);
    if (bytes === null) {
        fail(errors, '$', 'bad-base64', 'base64url 字符集', '');
        return { ok: false, errors };
    }
    if (bytes.length > MAX_PAYLOAD_BYTES) {
        fail(errors, '$', 'too-large', '≤ ' + MAX_PAYLOAD_BYTES + ' 字节', bytes.length);
        return { ok: false, errors };
    }
    const json = utf8Decode(bytes);
    if (json === null) {
        fail(errors, '$', 'bad-utf8', 'UTF-8', '');
        return { ok: false, errors };
    }
    if (checksum32(json) !== sum) {
        fail(errors, '$', 'checksum-mismatch', '原样粘贴整段分享码', '');
        return { ok: false, errors };
    }
    let parsed;
    try { parsed = JSON.parse(json); } catch {
        fail(errors, '$', 'bad-json', 'JSON', '');
        return { ok: false, errors };
    }
    return validateRecipe(parsed);
}

/* ---------- 落到 appSettings ---------- */

/**
 * 190 的 applyModeSettings 在运行时是「分模式设置覆盖全局设置」：当前模式的
 * fontSize / blurLevel / 三种颜色 / align / show* 会盖掉 lyrics.*，
 * bgBlur / bgBrightness / sway* 会盖掉 background.*。
 * 于是「配方里同时存了 lyrics.fontSize=1.55 和 modeSettings.cover.fontSize=1.6」时，
 * 用户实际看到的是 1.6 —— 全局那项等于白存。这里在写入时就把这个优先级算清楚：
 * 以「当前生效的那个模式」的分模式值为准回写全局，让存储状态和屏幕上看到的一致。
 * （用户从设置里改过某个模式后、又没碰全局滑块时，两边本来就会不同步；
 *   不归一的话，导回来的配方会「有一半不生效」且没有任何提示。）
 */
const MODE_TO_LYRICS = {
    align: 'align', fontSize: 'fontSize', blurLevel: 'blurLevel',
    highlightColor: 'highlightColor', highlightInactiveColor: 'highlightInactiveColor',
    inactiveColor: 'inactiveColor', showTranslation: 'showTranslation', showRomaji: 'showRomaji',
};
const MODE_TO_BACKGROUND = {
    bgBlur: 'blur', bgBrightness: 'brightness',
    swayEnabled: 'swayEnabled', swayAmp: 'swayAmp', swayDuration: 'swayDuration',
};
/* 注意 themeColor 不在这张表里：190 的 applyModeSettings 走的是
   applyThemeColor(appSettings.interface.themeColor) —— 主题色是**全局赢**，
   和上面那批「分模式赢」的方向正好相反。写进这张表会把界面主题色
   改成配方里那个模式的值、反而偏离用户当时屏幕上的样子。
   （200 的两个入口平时会把 interface.themeColor 与 modeSettings[m].themeColor
     一起改，所以两者相同；不一致时以 interface 为准才对得上活实现。） */

/**
 * 把配方写进 settings（就地改），返回统计供 UI 播报。
 * 不做任何「智能合并」：配方里有的键就覆盖，没有的键保持原样——
 * 「只存了背景」的配方不该动用户的字号。
 * @param {Object} settings appSettings（调用方负责随后 saveSettings + 重绘）
 * @param {Object} recipe validateRecipe 通过后的配方
 * @param {string} [activeMode] 应用后真正处于视觉模式；缺省取 recipe.mode。
 *   该模式的分模式参数会回写全局（见上表说明）。
 */
export function applyRecipeToSettings(settings, recipe, activeMode) {
    const v = validateRecipe(recipe);
    if (!v.ok) return { ok: false, errors: v.errors, counts: {}, mode: null };
    const r = v.recipe;
    const s = settings;
    const counts = {};
    if (!s || typeof s !== 'object') return { ok: false, errors: [{ path: '$', code: 'bad-shape' }], counts, mode: null };

    if (r.lyrics) {
        if (!isPlainObject(s.lyrics)) s.lyrics = {};
        Object.assign(s.lyrics, r.lyrics);
        counts.lyrics = Object.keys(r.lyrics).length;
    }
    if (r.background) {
        if (!isPlainObject(s.background)) s.background = {};
        Object.assign(s.background, r.background);
        counts.background = Object.keys(r.background).length;
    }
    if (r.interface) {
        if (!isPlainObject(s.interface)) s.interface = {};
        Object.assign(s.interface, r.interface);
        counts.interface = Object.keys(r.interface).length;
    }
    if (r.modeSettings) {
        if (!isPlainObject(s.modeSettings)) s.modeSettings = {};
        let n = 0;
        for (const m of Object.keys(r.modeSettings)) {
            if (!isPlainObject(s.modeSettings[m])) s.modeSettings[m] = {};
            Object.assign(s.modeSettings[m], r.modeSettings[m]);
            n += Object.keys(r.modeSettings[m]).length;
        }
        counts.modeSettings = n;
    }

    /* 优先级归一：当前模式的版式偏好 > 全局配方值（与 190 运行时的判定一致） */
    const active = VIEW_MODES.indexOf(activeMode) >= 0 ? activeMode : r.mode;
    const ms = active && isPlainObject(s.modeSettings) ? s.modeSettings[active] : null;
    let shadowed = 0;
    if (isPlainObject(ms)) {
        shadowed = shadowInto(s.lyrics, ms, MODE_TO_LYRICS)
            + shadowInto(s.background, ms, MODE_TO_BACKGROUND);
    }

    counts.mode = r.mode ? 1 : 0;
    return { ok: true, errors: [], counts, mode: r.mode || null, shadowedByMode: shadowed };
}

/** 把 ms[src] 抄到 dst[map[src]]；只在 src 存在时动。返回覆盖条数。 */
function shadowInto(dst, ms, map) {
    if (!isPlainObject(dst)) return 0;
    let n = 0;
    for (const src of Object.keys(map)) {
        if (!Object.prototype.hasOwnProperty.call(ms, src)) continue;
        const v = ms[src];
        if (v === undefined || v === null) continue;
        dst[map[src]] = (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) ? Number(v) : v;
        n++;
    }
    return n;
}

/* ---------- 配方摘要（UI 里「这份配方会改什么」） ---------- */

/** 数一数配方各组的条目数，供列表与确认弹窗展示。 */
export function summarizeRecipe(recipe) {
    const v = validateRecipe(recipe);
    const r = v.ok ? v.recipe : (isPlainObject(recipe) ? recipe : {});
    const groups = {};
    for (const g of RECIPE_GROUPS) groups[g.key] = 0;
    if (r.mode) groups.mode = 1;
    for (const key of ['lyrics', 'background', 'interface']) {
        if (isPlainObject(r[key])) groups[key] = Object.keys(r[key]).length;
    }
    if (isPlainObject(r.modeSettings)) {
        let n = 0;
        for (const m of Object.keys(r.modeSettings)) {
            if (isPlainObject(r.modeSettings[m])) n += Object.keys(r.modeSettings[m]).length;
        }
        groups.modeSettings = n;
    }
    const total = Object.keys(groups).reduce((a, k) => a + groups[k], 0);
    return { groups, total, modes: isPlainObject(r.modeSettings) ? Object.keys(r.modeSettings) : [] };
}

/* ---------- 预设名 / 清单纯函数（存储由分片负责，这里只管形状） ---------- */

/**
 * 清洗预设名：去控制字符与尖括号花括号、折叠空白、截断。
 * 渲染侧仍必须 esc()（约束 8）——这里是「不让脏名字进存储」，不是「让 UI 省掉转义」。
 */
export function sanitizeRecipeName(input) {
    let s = String(input == null ? '' : input);
    s = s.replace(/[\u0000-\u001f\u007f]/g, ' ');
    s = s.replace(/[{}<>"'`\\]/g, '');
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length > MAX_NAME_CHARS) s = s.slice(0, MAX_NAME_CHARS).trim();
    return s;
}

/** 生成预设 id（可注入 now/rand 以便测试稳定） */
export function newPresetId(now, rand) {
    const t = (typeof now === 'number' ? now : Date.now()).toString(36);
    const r = Math.floor((typeof rand === 'number' ? rand : Math.random()) * 1296).toString(36).padStart(2, '0');
    return 'vr' + t + r;
}

/**
 * 新增/覆盖预设（同名 = 覆盖，符合用户「保存到我的配方」的直觉）。
 * @returns {{list:Array, action:'added'|'overwritten'|'rejected', reason?:string}}
 */
export function upsertPreset(list, preset) {
    if (!isPlainObject(preset)) return { list: Array.isArray(list) ? list : [], action: 'rejected', reason: 'bad-shape' };
    const name = sanitizeRecipeName(preset.name);
    if (!name) return { list: Array.isArray(list) ? list : [], action: 'rejected', reason: 'empty-name' };
    const v = validateRecipe(preset.recipe);
    if (!v.ok) return { list: Array.isArray(list) ? list : [], action: 'rejected', reason: 'invalid-recipe' };

    const items = (Array.isArray(list) ? list : []).slice();
    const id = typeof preset.id === 'string' && preset.id ? preset.id : newPresetId();
    const at = (typeof preset.updatedAt === 'number' && Number.isFinite(preset.updatedAt)) ? preset.updatedAt : Date.now();
    const idx = items.findIndex(p => p && p.name === name);
    const entry = {
        id: idx >= 0 ? items[idx].id : id,
        name,
        recipe: v.recipe,
        createdAt: idx >= 0 && typeof items[idx].createdAt === 'number' ? items[idx].createdAt : at,
        updatedAt: at,
    };
    if (idx >= 0) {
        items[idx] = entry;
        return { list: items, action: 'overwritten' };
    }
    if (items.length >= MAX_PRESETS) return { list: items, action: 'rejected', reason: 'too-many' };
    items.push(entry);
    return { list: items, action: 'added' };
}

/** 重命名（目标名已存在则拒绝，避免悄悄合并两份配方） */
export function renamePreset(list, id, nextName) {
    const items = (Array.isArray(list) ? list : []).slice();
    const i = items.findIndex(p => p && p.id === id);
    if (i < 0) return { list: items, action: 'rejected', reason: 'not-found' };
    const name = sanitizeRecipeName(nextName);
    if (!name) return { list: items, action: 'rejected', reason: 'empty-name' };
    if (items.some((p, j) => j !== i && p && p.name === name)) return { list: items, action: 'rejected', reason: 'duplicate-name' };
    items[i] = { ...items[i], name, updatedAt: Date.now() };
    return { list: items, action: 'renamed' };
}

/** 删除 */
export function removePreset(list, id) {
    const items = (Array.isArray(list) ? list : []);
    const next = items.filter(p => p && p.id !== id);
    return { list: next, action: next.length === items.length ? 'rejected' : 'removed' };
}

/**
 * 从 appSettings 里读出的清单做一次防御性归一化：
 * 存储文件是用户可直接编辑的（user_config.json），坏条目要能安静丢掉而不是让面板崩。
 */
export function normalizePresetList(raw) {
    const out = [];
    const usedNames = new Set();
    const usedIds = new Set();
    const arr = Array.isArray(raw) ? raw : [];
    for (const p of arr) {
        if (!isPlainObject(p)) continue;
        const name = sanitizeRecipeName(p.name);
        if (!name || usedNames.has(name)) continue;
        const v = validateRecipe(p.recipe);
        if (!v.ok) continue;
        let id = (typeof p.id === 'string' && p.id) ? p.id : '';
        /* 存储文件用户可直接编辑：脏 id（__proto__ 这类）一律换成新生成的。
           刻意要求首字符是字母数字——newPresetId 产出的就是 'vr…' 形状。 */
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(id) || usedIds.has(id)) id = newPresetId();
        usedNames.add(name);
        usedIds.add(id);
        out.push({
            id,
            name,
            recipe: v.recipe,
            createdAt: Number.isFinite(p.createdAt) ? p.createdAt : 0,
            updatedAt: Number.isFinite(p.updatedAt) ? p.updatedAt : 0,
        });
        if (out.length >= MAX_PRESETS) break;
    }
    return out;
}
