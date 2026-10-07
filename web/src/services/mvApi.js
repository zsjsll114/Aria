/* ============================================================
 * services/mvApi.js — MV（音乐视频）数据适配层（三源）
 *
 * 上游能力（2026-10-03 本机 vendor + 公网实测，非文档推断）：
 *
 *   源     关键词搜 MV                        取播放地址
 *   ───────────────────────────────────────────────────────────────────────────
 *   网易   /search?type=1004&keywords=       /mv/url?id=&r=1080
 *          → result.mvs[]（id/name/artistName/cover/duration）
 *   酷狗   /search?type=mv&keywords=         /video/url?hash=
 *          → data.lists[]（MvID/MvName/MvHash/MvHashMark/Pic）
 *   QQ     ✗ 没有「关键词搜 MV」              /getMvPlay?vid=
 *          → 改从**歌曲搜索结果自带的 vid** 取（见下）
 *
 * ★ QQ：用歌曲自带的 vid，而不是歌手维度（2026-10-03 二次修正，★ 推翻上一版结论）
 *   上一版走 /getSingerMv?singermid=（歌手维度），结果**语义错了**：搜
 *   「world.execute(me);」时那一排卡片是 Mili 的《Mirror Mirror》《Lemonade》
 *   《Camelia》—— 全都是该歌手**别的歌**的 MV，用户一眼看出不对（截图确证）。
 *
 *   真正的解法是歌曲搜索报文里那个一直没被注意的字段：**每首歌自带 `vid`**
 *   （实测 `getSearchByKey` → song.list[].vid = "w0026q7f01a"），它就是**这首歌自己的
 *   MV id**。实测 `/getMvPlay?vid=w0026q7f01a` 直出真 mp4。上一版之所以判「QQ 拿不到
 *   歌曲级 MV」，是因为只找名为 `mv` 的字段（实测恒 None）而漏看了 `vid`。
 *   ⇒ QQ 现在直接由「歌曲搜索结果里带 vid 的那些歌」生成卡片：歌名、封面、时长都
 *     来自那首歌本身，量纲天然对齐，且不需要任何额外的歌手 mid 解析。
 *   ⇒ 副作用正收益：这些卡片天然能当「MV 背景跟随播放」的数据源（歌曲对象上就有 vid）。
 *
 *   （公网 vkeys `/music/tencent/search/mv` 仍是全站视频检索——实测 keyword=追光使者
 *   第一条是抖音 UGC 短视频，且 perPage 恒为 1、带 limit 直接风控 110000，不采。）
 *
 * ★ 取址三条链都是 http 直链。**是否升 https 要按 CDN 分辨**（2026-10-04 更正）：
 *   网易 vod(126.net) 与 QQ mv.music.tc.qq.com 替换协议后实测仍 206 + video/mp4 → 升；
 *   **酷狗 fsmvpc.kugou.com 的 443 证书不匹配**（见 upHttps 注释）→ **保留 http**。
 *   早期版本"一律升 https"直接把酷狗 MV 打死（Chromium 里表现为只显示 poster）。
 *
 * ★ 只缓存 id/vid/hash，**绝不缓存播放地址**：网易的 wsTime 有效期 expi=3600s，
 *   酷狗 dis_t 也是带时间戳的签名，缓存 URL 只会拿到 403。
 *
 * 本模块只做数据与归一化，不碰 DOM（渲染在 app/150-search-engine.js，
 * 背景播放由 app/101-mv-background.js 负责）。
 * ============================================================ */
import { API_BASE } from '../config/constants.js';
import { proxyFetch } from './musicApi.js';
import { selfhostKeyOf } from './playSource.js';
import { logCatch, logInfo, logWarn } from './log.js';

const SH_TIMEOUT = 9000;
const enc = encodeURIComponent;

/* MV 时长下限（秒）。低于这个值的候选视为花絮/问候/切片视频，不作为 MV 卡片。
   见 finalizeMvs 里的详细说明——注意 QQ 不给时长（0），不能按"小于阈值就丢"来判。 */
const MV_MIN_DURATION = 45;

/* ★ "这不是 MV"的标题特征（2026-10-03）。网易云的 type=1004 是个**视频**检索，
   把自制访谈节目也当结果返回：实测搜「周杰伦」12 条里 6 条是《超级面对面》访谈
   （428~646 秒）+ 2 条预告片，搜到的"MV"点开是主持人聊天。
   时长下限挡得住预告（36/40 秒），挡不住访谈（400+ 秒），所以标题这层必须有。
   ★ 词表刻意收得很窄：只放"出现在歌名里的概率≈0"的节目词，像"对话""现场"这种
   能当歌名的都**不能**进（《对话》真是一首歌），否则就是用误杀换误放。
   ★ 挨个说明：访谈/专访/预告/花絮/幕后/探班/纪录片/彩排/发布会/记者会 都是节目形态；
   "超级面对面"是网易自制栏目名；"播放次数最多"挡的是 UGC 榜单视频（"XX MV TOP10"）。 */
const MV_TITLE_DENY = /超级面对面|访谈|专访|预告|花絮|幕后|探班|纪录片|彩排|发布会|记者会|播放次数最多/i;

/* ---------------- 基础请求 ---------------- */

/* 自建 vendor 代理（与 artistApi 同一条通道）。平台键必须过 selfhostKeyOf：
   搜索页的 source 是 'tencent'，后端 _SERVICES 的键是 'qq'，直接拼就是 404。 */
async function shGet(source, path, timeout = SH_TIMEOUT) {
    const key = selfhostKeyOf(source);
    if (!key) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
        const res = await fetch(`/api/selfhost/${key}/proxy?path=${enc(path)}`, { signal: ctl.signal });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        logCatch('mvApi', e);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/* WebView2 / https 页面下 http 媒体会被 mixed-content 拦掉（先例见 150 的网易封面），
   所以直链一律想升 https。
   ★★ 2026-10-04 更正：**「统一升 https」是错的 —— 并非所有 CDN 的 https 端点都可用。**
   实测酷狗 MV 的 `fsmvpc.kugou.com` / `fsmvpc.tx.kugou.com` 在 443 上**证书不匹配**
   （curl: `SEC_E_WRONG_PRINCIPAL`，SNI 与证书 CN/SAN 不符）→ TLS 握手阶段就被拒。
   在 Chromium/WebView2 里的两种表现都很糟：
     ① 直接 `MEDIA_ELEMENT_ERROR: Format error`（error 事件，能靠回落救回）；
     ② **连接挂起**——既不 error 也不出帧，`<video>` 永远停在 `readyState 0`，
        只剩 `poster`（=MV 封面，看着就像歌曲封面）→ 用户报的「mv 不播放 只显示封面」。
   同一条链的 **http 版本实测 206 + 可播**：Chromium 的 Matroska demuxer 接受
   H.264/AAC in MKV（`canPlayType('video/x-matroska; codecs="avc1,mp4a"')` → `"probably"`，
   实测 `loadedmetadata` + `play()` 均 OK）。⇒ **MKV 不是问题，我上一版把它当嫌疑是误判。**
   ⇒ 对这批 host 保留 CDN 给出的原协议，不做无脑升级。 */
const HTTPS_UNSUPPORTED = /(^|\.)kugou\.com$/i;
export function upHttps(u) {
    if (typeof u !== 'string' || !u) return '';
    try {
        if (HTTPS_UNSUPPORTED.test(new URL(u).hostname)) return u;
    } catch (e) { /* 非绝对 URL（或环境无 URL）：落到下面的常规替换 */ }
    return u.replace(/^http:\/\//, 'https://');
}

function toSec(v) {
    const n = Number(v) || 0;
    return n > 10000 ? Math.round(n / 1000) : Math.round(n);
}

function fmtCount(n) {
    const v = Number(n) || 0;
    if (v >= 100000000) return String(Math.round(v / 1000000) / 100) + ' 亿';
    if (v >= 10000) return String(Math.round(v / 1000) / 10) + ' 万';
    return v ? String(v) : '';
}

/* ---------------- 能力声明 ---------------- */

/** 该源是否支持搜索出 MV。汽水底层库没有任何 video 方法（见 docs/搜索扩展…§二），一律 false。 */
export function mvSearchSupported(source) {
    const k = selfhostKeyOf(source);
    return k === 'qq' || k === 'netease' || k === 'kugou';
}

/* ---------------- 搜索 ---------------- */

/**
 * 关键词搜 MV。失败 / 不支持一律返回 []（调用方据此隐藏整块，不做报错打扰）。
 *
 * @param {string} source  'tencent' | 'netease' | 'kugou'
 * @param {string} keyword 搜索词
 * @param {Object} [opts]
 * @param {number} [opts.limit=6]  期望条数（上限 12）
 * @param {Array}  [opts.artists]  相关性基准歌手（**必须是歌曲结果里提取的那些**，
 *                                 不是"按关键词搜到的歌手"——见 finalizeMvs 的说明）
 * @param {Array}  [opts.songs]    本次搜索的歌曲结果（QQ 靠它取每首歌自带的 vid）
 * @returns {Promise<Array<{source,mvId,vid,hash,name,singer,cover,duration,playCount}>>}
 */
export async function searchMvs(source, keyword, opts = {}) {
    const kw = String(keyword || '').trim();
    const limit = Math.max(1, Math.min(12, parseInt(opts.limit, 10) || 6));
    const artists = Array.isArray(opts.artists) ? opts.artists : [];
    const songs = Array.isArray(opts.songs) ? opts.songs : [];
    const key = selfhostKeyOf(source);
    if (!key || !mvSearchSupported(source)) return [];

    /* ★ 候选池取 limit 的 3 倍（上限 24）再本地精选：
       上游的排序对"搜歌名"极不友好（实测网易搜「晴天」前三条是高伟/邓天晴的翻唱，
       周杰伦那支根本没进前 3；酷狗还会给出同一首歌的两支同名 MV）。
       只看前 limit 条等于把上游的排序当成自己的排序 —— 多取一点再按下面三条规则
       精排/去重，才是我们要的结果。 */
    const pool = Math.min(24, limit * 3);
    try {
        let raw;
        if (key === 'netease') raw = await searchNeteaseMvs(kw, pool);
        else if (key === 'kugou') raw = await searchKugouMvs(kw, pool);
        /* QQ：不走网络——直接从歌曲结果里挑带 vid 的歌（见文件头「QQ」段）。
           这些卡片就是"搜索结果里这些歌各自的 MV"，不需要关键词检索。 */
        else raw = mvsFromQqSongs(songs, pool);
        return finalizeMvs(raw, kw, artists, limit);
    } catch (e) {
        logCatch('mvApi', e);
        return [];
    }
}

/**
 * 候选池 → 最终列表：去重 + 相关性精选 + 截断。纯函数，可单测。
 *
 * ★ 精选规则（**这是"卡片上不会出现别人的翻唱"的唯一保证**）：
 *   有歌手信息时（歌曲结果里必然有）→ 只留 MV 歌手与之一致的候选；
 *   没有歌手信息时 → 只留名字含关键词的候选。
 *   不做"一条都没命中就退回全量"的兜底 —— 那正是翻唱/无关视频混进来的入口：
 *   实测网易搜「晴天」回的前三条是高伟/邓天晴的翻唱（网易没有周杰伦版权），
 *   退回全量就会把这三张卡当成「《晴天》的 MV」摆给用户，点下去背景是别人的歌。
 *   宁可不显示（搜索页对空 MV 直接不渲染这一排），也不指错。
 *   另加一条**时长下限**：< MV_MIN_DURATION 的候选（网易常见的"艺人独家问候"）
 *   不是 MV，直接丢；时长为 0（QQ 拿不到）不受此限。
 *
 * ★ 传进来的 `artists` 必须是**歌曲搜索结果里提取的歌手**，不能是"按关键词搜到的歌手"
 *   （2026-10-03 定位，这是「网易云没有 MV」的根因）：
 *   此前 150 把 fetchArtistCards 的产物直接喂进来，而那优先是 searchArtists(keyword)
 *   的结果。搜「world.execute(me);」时网易的歌手检索会回一串名字完全无关的歌手，
 *   真正的原唱 Mili 不在里面 → 每条候选都被判"歌手不符"→ **整排丢空**。
 *   可上游其实老老实实返回了 5 条、头两条正是 Mili 的 MV。改用歌曲自带的 artists
 *   做基准后立刻恢复。（同名歌手卡仍可用于**展示**，两者分离。）
 *
 * @param {Array} raw      各源归一化后的原始候选（可能是 limit 的 3 倍）
 * @param {string} keyword 搜索词
 * @param {Array} artists  **歌曲搜索结果里的歌手**（用来判定"原唱"，见上方说明）
 * @param {number} limit   最终条数
 */
export function finalizeMvs(raw, keyword, artists, limit) {
    const seen = new Set();
    const uniq = [];
    for (const mv of (Array.isArray(raw) ? raw : [])) {
        if (!mv || !mv.name) continue;
        /* ★ 时长下限（2026-10-03）：网易的 type=1004 不只回 MV，还回"艺人独家问候"
           这类几秒到几十秒的花絮视频（实测搜「周杰伦」首条是「周杰伦独家问候网易云
           音乐网友」9 秒）。当 MV 卡片摆出来，点下去背景只有 9 秒黑屏 —— 与其这样
           不如不显示。★ 判定必须是 `duration > 0 && < 45`：QQ 的歌曲对象可能没有
           interval（我们填 0），写 `duration < 45` 会把那些卡片整排误杀。 */
        if (mv.duration > 0 && mv.duration < MV_MIN_DURATION) continue;
        /* 节目/访谈类视频不是 MV（见 MV_TITLE_DENY 的说明）。 */
        if (MV_TITLE_DENY.test(mv.name)) continue;
        /* 同歌同歌手的第二支 MV 在 6 张卡片的横排里只会看起来像 bug（实测酷狗会回
           「追光使者」两条同名同歌手），按 名称|歌手 去重。 */
        const k = `${norm(mv.name)}|${norm(mv.singer)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        uniq.push(mv);
    }

    const kw = norm(keyword);
    const names = (Array.isArray(artists) ? artists : []).map(a => norm(a && a.name)).filter(Boolean);
    const artistHit = (mv) => {
        const singer = norm(mv.singer);
        if (!singer) return false;
        /* 双向包含：上游的歌手串可能是 "初音未来;巡音流歌;KAITO" 这种长串，
           MV 只标 "巡音流歌"，两个方向都要认。 */
        return names.some(n => singer.includes(n) || n.includes(singer));
    };
    const keep = names.length
        ? artistHit
        : (mv) => !!kw && norm(mv.name).includes(kw);

    const picked = uniq.filter(keep);
    if (uniq.length && !picked.length) {
        logInfo('mvApi', `[MV] ${uniq.length} 条候选与歌手/关键词都不匹配，全部丢弃（不展示别人的翻唱）`);
    }
    /* 命中歌手的排在名字命中之前，其余保持上游顺序（稳定排序） */
    return picked
        .map((mv, i) => ({ mv, i, s: (kw && norm(mv.name).includes(kw)) ? 1 : 0 }))
        .sort((a, b) => (b.s - a.s) || (a.i - b.i))
        .map(x => x.mv)
        .slice(0, limit);
}

/* 归一化比较用：去空白 + 去括号内容 + 小写（"追光使者(Vsinger Live)" → "追光使者"）。
   括号分两类各写一条正则：合成 `[（(【\[]…[)）】\]]` 时字符类里的 `\[` 会被 eslint
   判为多余转义，且 "（abc]" 这种跨类型配对本就是误匹配，拆开更准。 */
function norm(s) {
    return String(s == null ? '' : s)
        .replace(/[（(【].*?[)）】]/g, '')
        .replace(/\[.*?\]/g, '')
        .replace(/\s+/g, '')
        .toLowerCase();
}

/* 网易：/search?type=1004 → result.mvs[]（一条请求搞定，相关性由本地 finalize 精排） */
async function searchNeteaseMvs(kw, limit) {
    if (!kw) return [];
    const j = await shGet('netease', `/search?type=1004&keywords=${enc(kw)}&limit=${limit}`);
    const arr = (((j || {}).result) || {}).mvs || [];
    return arr.map(mv => ({
        source: 'netease',
        mvId: String(mv.id || ''),
        vid: '', hash: '',
        name: mv.name || '',
        singer: mv.artistName || ((Array.isArray(mv.artists) && mv.artists[0] && mv.artists[0].name) || ''),
        cover: upHttps(mv.cover),
        /* ★ 网易的 MV duration **恒为毫秒**（实测 542060 → 542s；9400 → 9s）。
           别用 toSec 的"大于 10000 当毫秒"启发式：9.4 秒的短片会被读成 9400 秒
           （2 小时 36 分），卡片上直接显示成一个荒谬的时长。 */
        duration: Math.round((Number(mv.duration) || 0) / 1000),
        playCount: fmtCount(mv.playCount),
    })).filter(mv => mv.mvId && mv.name);
}

/* 酷狗：/search?type=mv → data.lists[]
   ★ 取址要的是 MvHash（实测 /video/url?hash=<MvHash> 直出 .mp4），不是 MvID。
   ★ 封面字段 Pic 是**裸文件名**，必须自己拼 imge.kugou.com/mvhdpic/{size}/
     （mvpic 也有 200，但 mvhdpic 同尺寸清晰得多：实测 16KB vs 37KB）。 */
async function searchKugouMvs(kw, limit) {
    if (!kw) return [];
    const j = await shGet('kugou', `/search?keywords=${enc(kw)}&type=mv&page=1&pagesize=${limit}`);
    const arr = (((j || {}).data) || {}).lists || [];
    return arr.map(mv => {
        const pic = String(mv.Pic || '').replace('{size}', '480');
        return {
            source: 'kugou',
            mvId: String(mv.MvID || ''),
            hash: mv.MvHash || '',
            vid: '',
            name: mv.MvName || '',
            singer: mv.SingerName || ((Array.isArray(mv.Singers) && mv.Singers[0] && mv.Singers[0].name) || ''),
            cover: pic ? `https://imge.kugou.com/mvhdpic/480/${pic}` : '',
            duration: toSec(mv.Duration),
            playCount: fmtCount(mv.HistoryHeat),
        };
    }).filter(mv => mv.mvId && mv.hash && mv.name);
}

/* QQ：从**歌曲搜索结果**里挑带 vid 的歌，一首歌 = 一张 MV 卡（见文件头「QQ」段）。
   纯函数、零请求，可单测。
   ★ 字段来源一律是那首歌自己：name=song、cover=歌曲封面、singer=歌曲歌手、duration=interval。
     这样卡片文案与点开后播的视频必然同源，不会出现「卡上是这首、播的是另一首」。
   ★ `mvId` 用 vid 本身（QQ 的 MV 没有单独的对外 id 字段；vid 就是它的身份）。 */
export function mvsFromQqSongs(songs, limit = 18) {
    const out = [];
    const seen = new Set();
    for (const s of (Array.isArray(songs) ? songs : [])) {
        if (!s) continue;
        const vid = String(s.mvVid || s.vid || '').trim();
        if (!vid || seen.has(vid)) continue;
        seen.add(vid);
        out.push({
            source: 'tencent',
            mvId: vid,
            vid,
            hash: '',
            name: s.song || s.name || s.title || '',
            singer: s.singer || s.artist || '',
            cover: s.cover || '',
            /* 歌曲时长当 MV 时长：QQ 的 getMvPlay 报文不给时长，拿歌曲 interval
               是同一支片子最接近的估计（用户看到卡片上的数字与歌曲一致，比空白更可信）。
               0 表示未知，finalizeMvs 的时长下限对 0 不生效。 */
            duration: Math.max(0, Math.round(Number(s.interval) || 0)),
            playCount: '',
        });
        if (out.length >= limit) break;
    }
    return out;
}

/**
 * 采纳 vkeys 公网搜索条目里的 MV 关联字段（原地补 `mvVid` / `mvId`）。
 *
 * ★ 2026-10-04 修的真实缺陷（用户原话：「qq 不会自动匹配 mv 但是网易云和酷狗可以」）：
 *   `150-search-engine.js` 的搜索是「自建 vendor × vkeys 公网」**并发竞速**，那段注释
 *   写明 vkeys 更快（0.7s vs 2.5s）**会赢下竞速**；而它的 vkeys 分支只补了 artists，
 *   **没搬 MV 关联字段** ⇒ QQ 搜索结果的 `item.mvVid` 恒空 ⇒ `resolveMvForSong` 只能
 *   退到「跨源同名 + 歌手」这一级，而 QQ 又被 `if (key !== 'qq')` 排除在「本平台关键词
 *   搜索」之外（QQ 没有关键词搜 MV 的接口）⇒ QQ 几乎匹配不上 MV。
 *   实测 vkeys 的 QQ 条目**自带 `vid`**，且与自建 getSearchByKey 完全一致
 *   （青花瓷 `l00131om505` / 晴天 `w0026q7f01a`）—— 这一路的信息此前白丢了。
 *   ★ 网易的 vkeys 条目确实没有 MV 字段，但它有 /search?type=1004 兜底，故不受影响。
 *
 * @param {Array} list vkeys 搜索条目（**就地修改**）
 * @returns {Array} 同一个 list（便于链式调用）
 */
export function adoptVkeysMvFields(list) {
    for (const it of (Array.isArray(list) ? list : [])) {
        if (!it) continue;
        /* 已有值（自建 vendor 形状）不动，只在空的时候补，避免覆盖更准的值 */
        if (!it.mvVid && typeof it.vid === 'string' && it.vid) it.mvVid = it.vid;
        if (!it.mvId && it.mv != null && String(it.mv) !== '0') it.mvId = String(it.mv);
    }
    return list;
}

/* ---------------- 取播放地址 ---------------- */

/**
 * 取 MV 播放直链（http(s) .mp4）。失败返回 null。
 * @param {{source:string,mvId:string,vid?:string,hash?:string}} mv
 * @returns {Promise<string|null>}
 */
export async function fetchMvUrl(mv) {
    const key = selfhostKeyOf(mv && mv.source);
    if (!key || !mv) return null;
    try {
        if (key === 'netease') {
            if (!mv.mvId) return null;
            const j = await shGet('netease', `/mv/url?id=${enc(mv.mvId)}&r=1080`, 15000);
            const url = (((j || {}).data) || {}).url || '';
            return url.startsWith('http') ? upHttps(url) : null;
        }
        if (key === 'kugou') {
            if (!mv.hash) return null;
            const j = await shGet('kugou', `/video/url?hash=${enc(mv.hash)}`, 15000);
            const data = (j || {}).data || {};
            const rec = data[mv.hash] || data[String(mv.hash).toLowerCase()] || {};
            const url = rec.downurl || (Array.isArray(rec.backupdownurl) ? rec.backupdownurl[0] : '') || '';
            return url.startsWith('http') ? upHttps(url) : null;
        }
        /* QQ：getMvPlay 一次回多档 mp4。★ 挑**可用的最小档**：背景播放不需要 1080P，
           实测同一支 MV 有 26MB / 61MB 两档，选小的省一半带宽且糊起来更均匀。 */
        if (!mv.vid) return null;
        const j = await shGet('tencent', `/getMvPlay?vid=${enc(mv.vid)}`, 15000);
        return pickQqMp4(j);
    } catch (e) {
        logCatch('mvApi', e);
        return null;
    }
}

/** 从 getMvPlay 报文里挑一条可用的最小档 mp4（https 优先）。纯函数，可单测。 */
export function pickQqMp4(j) {
    const data = ((((j || {}).response) || {}).getMVUrl || {}).data;
    if (!data || typeof data !== 'object') return null;
    const key = Object.keys(data)[0];
    if (!key) return null;
    const mp4s = (data[key] && data[key].mp4) || [];
    let best = null;
    for (const item of mp4s) {
        const urls = (Array.isArray(item && item.freeflow_url) ? item.freeflow_url : [])
            .filter(u => typeof u === 'string' && u.startsWith('http'));
        if (!urls.length) continue;
        const https = urls.find(u => u.startsWith('https://')) || urls[0];
        const size = Number((item && item.fileSize) || 0);
        if (!best || (size > 0 && (best.size === 0 || size < best.size))) {
            best = { url: https, size };
        }
    }
    if (!best) logWarn('mvApi', '[MV] getMvPlay 未返回可用 mp4（版权/区域限制）');
    return best ? upHttps(best.url) : null;
}

/* ============================================================
 * 歌曲 → MV 的匹配（2026-10-04 新增）
 *
 * 用户报：「同名（甚至括号里的东西都一样）同作者的 mv 甚至都不匹配上（很多）」
 *
 * 旧实现只有一条路：拿「歌名 歌手」当关键词调 searchMvs，而 searchMvs 内部用
 * finalizeMvs 的**只按歌手筛**——两个方向都会翻车：
 *   ① 上游对该关键词召回差时整排丢空：实测网易搜「起风了 买辣椒也用券」只回 5 条
 *      （正主不在），搜「起风了」回 18 条**全是翻唱**（吴青峰/李赛儿/…）→ 歌手筛后 0 条；
 *   ② 反过来歌手对得上就全放行 → 同歌手**别的歌**的 MV 混进来：实测「平凡之路 朴树」
 *      通过 16 条，里面是《那些花儿》《送别》《No Fear In My Heart》。
 * 而且最准的那条路一直没走：**歌曲对象自带的 MV id**
 *   （网易 /cloudsearch 的 `song.mv`、QQ 的 `song.vid`、酷狗 getSongInfo 的 `mvhash`）。
 *   ★ 网易那个字段是 `mv` 不是 `mvid` —— 旧代码读的是 `mvid`，实测 /cloudsearch
 *     新结构里恒为 undefined，所以一直是 0 命中。
 *
 * 现在按「由准到宽」三级解析，任一级命中即返回：
 *   ① vendor 关联：歌曲自带的 mvId/mvVid/mvHash → 天然同名同歌手，零成本（网易多拉一次详情）；
 *   ② 本平台关键词搜索（先「歌名 歌手」再补「歌名」，两池合并）；
 *   ③ 跨源关键词搜索（网易 MV 库最全 → 酷狗）——**QQ 没有关键词搜 MV 接口，
 *      这是 QQ 歌曲唯一的兜底**，也是「很多歌匹配不上」的主要来源。
 * ②③ 的候选一律过 matchMvFromCandidates 的**歌名 + 歌手双判**：
 *   歌名必须对得上，且（有歌手基准时）歌手必须对得上 —— 宁可没有，也不指错。
 * ============================================================ */

/* 歌手归一化：去括号补充、去分隔符、去空白、小写。
   分隔符要去掉而不是统一：上游写法五花八门（"周杰伦/费玉清"、"A & B"、"A、B"），
   统一成某个字符反而更难比。去掉之后用双向包含判，四种写法都能互相命中。 */
function normSinger(s) {
    return String(s == null ? '' : s)
        .replace(/[（(【].*?[)）】]/g, '')
        .replace(/\[.*?\]/g, '')
        .replace(/[\s&·、,，/|;；:：+]+/g, '')
        .toLowerCase();
}

/**
 * 网易 /mv/detail?mvid= → MV 描述符。失败返回 null。
 * 这是「歌曲自带 mv 字段」的配套：字段只给 id，详情（名称/歌手/封面/时长）得再拉一次。
 * ★ duration 恒为**毫秒**（实测 364290 → 364s），与 searchNeteaseMvs 同口径。
 */
export async function neteaseMvDetail(mvid) {
    const id = String(mvid || '').trim();
    if (!id || id === '0' || id === 'undefined') return null;
    try {
        const j = await shGet('netease', `/mv/detail?mvid=${enc(id)}`);
        const d = (j || {}).data;
        if (!d || !d.id) return null;
        return {
            source: 'netease',
            mvId: String(d.id),
            vid: '', hash: '',
            name: d.name || '',
            singer: d.artistName || ((Array.isArray(d.artists) && d.artists[0] && d.artists[0].name) || ''),
            cover: upHttps(d.cover),
            duration: Math.round((Number(d.duration) || 0) / 1000),
            playCount: fmtCount(d.playCount),
        };
    } catch (e) {
        logCatch('mvApi', e);
        return null;
    }
}

/**
 * 取一个源的**原始** MV 候选（只做字段归一化，不做相关性筛选）。
 * 与 searchMvs 的区别：searchMvs 会经 finalizeMvs **按歌手**筛，而"按歌名搜 MV"
 * 恰恰需要拿原始池自己按「歌名+歌手」判（见 matchMvFromCandidates）。
 * QQ 返回 []：它没有关键词搜 MV 的接口（见文件头）。
 */
export async function fetchMvCandidates(source, keyword, pool = 18) {
    const kw = String(keyword || '').trim();
    const key = selfhostKeyOf(source);
    if (!kw || !key || key === 'qq') return [];
    const n = Math.max(1, Math.min(30, parseInt(pool, 10) || 18));
    try {
        if (key === 'netease') return await searchNeteaseMvs(kw, n);
        if (key === 'kugou') return await searchKugouMvs(kw, n);
        return [];
    } catch (e) {
        logCatch('mvApi', e);
        return [];
    }
}

/**
 * 从候选池里挑"这首歌自己的 MV"。纯函数，可单测。找不到返回 null。
 *
 * 判据（**两条硬条件 + 一条排序**）：
 *   ① 歌名命中：归一化后完全相等（4 分）或互相包含（2 分，短名不作包含以免误杀）；
 *   ② 歌手命中：给了歌手基准就必须命中（否则视为翻唱，直接排除）；
 *      没给基准时降级为"歌名必须完全相等"（两条都不占就没法保证不是别人的歌）；
 *   ③ 同分时优先"歌名完全相等 + 歌手命中"。
 *
 * ★ `strict`（跨源用）：只认**歌名完全相等**的候选。跨源同名同歌手的翻唱/重制太多，
 *   放宽到包含会指错。
 * ★ 时长下限与标题黑名单沿用 finalizeMvs 的口径（花絮/访谈不是 MV）。
 *
 * @param {Array}  cands  fetchMvCandidates 的产物（原始候选）
 * @param {{title?:string,singer?:string}} info 目标歌曲
 * @param {{strict?:boolean}} [opts]
 */
export function matchMvFromCandidates(cands, info, opts = {}) {
    const strict = !!(opts && opts.strict);
    const nt = norm(info && info.title);
    const ns = normSinger(info && info.singer);
    if (!nt) return null;
    let best = null;
    let bestScore = -1;
    for (const mv of (Array.isArray(cands) ? cands : [])) {
        if (!mv || !mv.name) continue;
        if (mv.duration > 0 && mv.duration < MV_MIN_DURATION) continue;
        if (MV_TITLE_DENY.test(mv.name)) continue;
        const nm = norm(mv.name);
        if (!nm) continue;
        const eq = nm === nt;
        const loose = !eq && nt.length >= 2 && (nm.includes(nt) || nt.includes(nm));
        if (!eq && !loose) continue;                        /* ① 歌名对不上 → 排除 */
        if (strict && !eq) continue;
        const s = normSinger(mv.singer);
        let singerScore = 0;
        if (ns) {
            if (!s) continue;                               /* 有基准但候选没写歌手 → 不敢认 */
            if (!(s.includes(ns) || ns.includes(s))) continue;  /* ② 翻唱 → 排除 */
            singerScore = 1;
        } else if (!eq) {
            continue;                                       /* 无歌手基准时歌名必须全等 */
        }
        const score = (eq ? 4 : 2) + singerScore * 3;
        if (score > bestScore) { bestScore = score; best = mv; }
    }
    return best;
}

/**
 * QQ 专用的 vid 反查：没有 `mvVid` 时，用**歌曲搜索**把它找回来。
 *
 * ★ 2026-10-04（用户原话：「qq 不会自动匹配 mv 但是网易云和酷狗可以」）。
 *   为什么只有 QQ 全灭：`mvVid` 只在**搜索结果点播**这一条路上被携带
 *   （150 的 item → 175 的 songInfo → currentSongData），歌单 / 最近播放 / 排行榜 /
 *   歌手页 / 遥控器进来的歌都拿不到它；而 QQ 又**没有「关键词搜 MV」的接口**，
 *   `resolveMvForSong` 对 QQ 跳过了「本平台关键词搜索」那一级 ⇒ 只剩「跨源同名+歌手」
 *   这个最严的兜底。网易/酷狗即使 vendor 字段丢了，也能靠本平台 MV 搜索补回来，所以没事。
 *   而 **QQ 的歌曲搜索 `getSearchByKey` 每首歌都自带 `vid`**（实测青花瓷 l00131om505）
 *   ⇒ 用 songmid 或「歌名 + 歌手」把这首歌自己的 vid 反查出来，就能重新走 vendor 级。
 *
 * 判据：**有 mid 就按 mid 精确命中**（绝不认错歌）；没有 mid 才退到「歌名全等 + 歌手命中」。
 * 成本：仅一次本机 vendor 请求（~200ms），且只在「QQ 且无 mvVid」时才发。
 *
 * @param {string} title  歌名
 * @param {string} [singer] 歌手
 * @param {string} [mid]    QQ songmid（能拿到就最准）
 * @returns {Promise<string>} vid，找不到回空串
 */
async function qqVidBySongSearch(title, singer, mid) {
    const t = String(title || '').trim();
    if (!t) return '';
    const kw = `${t} ${singer || ''}`.trim();
    const info = { title: t, singer, mid };
    /* ① 自建 vendor 的歌曲搜索（最快最准）—— 需要该平台自建服务在线。 */
    try {
        const j = await shGet('tencent', `/getSearchByKey?key=${enc(kw)}&limit=10&page=0`, 8000);
        const list = ((((j || {}).response || {}).data || {}).song || {}).list || [];
        const vid = pickQqVidFromSongs(list, info);
        if (vid) return vid;
    } catch (e) { logCatch('mvApi', e); }
    /* ② 回落到 vkeys 公网歌曲搜索 —— 它的 QQ 条目同样自带 vid（实测青花瓷 l00131om505），
       只是字段名不同（song / mid / singer 字符串）。
       ★ 这条**必须有**：自建开关没开或未登录时 ① 会整条失败，而用户那边「QQ 搜索」本身
         很可能正是 vkeys 赢下竞速的结果 —— 只在一条通道上反查会漏掉一半场景。 */
    try {
        const res = await proxyFetch(`${API_BASE}/tencent?word=${enc(kw)}&num=10&page=1`, { timeout: 6000 });
        const j = await res.json();
        const arr = (j && j.code === 200 && j.data) ? (Array.isArray(j.data) ? j.data : [j.data]) : [];
        const vid = pickQqVidFromSongs(arr.map(it => ({
            songmid: (it && it.mid) || '',
            songname: (it && it.song) || '',
            vid: (it && it.vid) || '',
            singer: [{ name: (it && it.singer) || '' }],
        })), info);
        if (vid) return vid;
    } catch (e) { logCatch('mvApi', e); }
    return '';
}

/**
 * 从 getSearchByKey 的歌曲列表里挑出**这一首**的 vid。纯函数，可单测。找不到回空串。
 *
 * 判据（与 matchMvFromCandidates 同精神：宁可没有，也不指错）：
 *   ① **有 mid 就按 songmid 精确命中** —— mid 是这首歌的唯一身份，有它绝不按歌名猜；
 *   ② 没有 mid 才比歌名，且**必须先严后宽**：先要求 songname 与歌名逐字相等，找不到才
 *      允许"归一化后全等"（容忍「歌名（电视剧《x》主题曲）」这类后缀）。
 *      ★ 顺序不能反：`norm` 会剥掉括号 ⇒「青花瓷 (Live)」归一化后与「青花瓷」全等，
 *        先宽后严会让 Live 版抢走正主、铺上演唱会版的 MV（两者 vid 实测不同）。
 *   ③ 给了歌手基准就必须命中（双向包含，容忍「周杰伦/阿信」与大小写/分隔符写法）；
 *      候选没写歌手时不敢认。
 * @param {Array} list  getSearchByKey → response.data.song.list
 * @param {{title?:string,singer?:string,mid?:string}} info 目标歌曲
 */
export function pickQqVidFromSongs(list, info = {}) {
    const arr = Array.isArray(list) ? list : [];
    const t = String((info && info.title) || '').trim();
    if (!t || !arr.length) return '';
    const mid = String((info && info.mid) || '').trim();
    if (mid) {
        const byMid = arr.find(s => s && String(s.songmid || '') === mid && s.vid);
        if (byMid) return String(byMid.vid);
    }
    const nt = norm(t);
    const ns = normSinger(info.singer);
    /* 歌手必须先过关（没有歌手基准时只判歌名）；歌名分两轮，先严后宽。 */
    const singerOk = (s) => {
        if (!ns) return true;
        const names = Array.isArray(s.singer) ? s.singer.map(x => (x && x.name) || '').join('/') : String(s.singer || '');
        const sx = normSinger(names);
        return !!sx && (sx.includes(ns) || ns.includes(sx));
    };
    /* ★ ① 歌名**逐字相等**优先。必须先严后宽：norm 会剥掉括号，所以「青花瓷 (Live)」
       经 norm 之后与「青花瓷」全等 —— 上来就用 norm 比，Live 版会抢在正主前面被选中，
       铺上的是演唱会版的 MV（实测两者 vid 不同：l00131om505 vs t00226mgu2f）。 */
    const hitStrict = arr.find(s => s && s.vid && String(s.songname || '').trim() === t && singerOk(s));
    if (hitStrict) return String(hitStrict.vid);
    /* ② 再退到归一化全等（容忍「歌名（电视剧《x》主题曲）」这类后缀） */
    const hitLoose = arr.find(s => s && s.vid && norm(s.songname) === nt && singerOk(s));
    return hitLoose ? String(hitLoose.vid) : '';
}

/**
 * 解析"这首歌的 MV"。三级兜底见本段开头。找不到返回 null（调用方回落封面背景）。
 *
 * @param {string} source  当前歌曲来源（'tencent'|'netease'|'kugou'|…）
 * @param {{title?:string,song?:string,name?:string,singer?:string,artist?:string,cover?:string,
 *          mvId?:string,mvVid?:string,vid?:string,mvHash?:string}} info
 * @returns {Promise<Object|null>} mvApi 形状的 MV 描述符（多一个 via 字段：vendor|search|cross）
 */
export async function resolveMvForSong(source, info = {}) {
    const key = selfhostKeyOf(source);
    if (!key || !mvSearchSupported(source)) return null;
    const title = info.title || info.song || info.name || '';
    const singer = info.singer || info.artist || '';
    const cover = info.cover || '';
    if (!title) return null;

    /* ① vendor 关联 —— 歌曲对象自己就有答案，最准也最省 */
    let mvVid = String(info.mvVid || info.vid || '').trim();
    const mvHash = String(info.mvHash || '').trim();
    const mvId = String(info.mvId || info.mvid || '').trim();
    /* ★ QQ 缺 mvVid 时反查（见 qqVidBySongSearch）：这个字段只在"搜索结果点播"那条路上
       被携带，歌单/最近播放/排行榜/歌手页都拿不到；而 QQ 又没有本平台「关键词搜 MV」的
       接口（下面 ② 对它是跳过的），不补这一刀就只剩最严的跨源兜底 ⇒ QQ 几乎匹配不上 MV。
       ★ 只在真正需要时才发这一次本机请求（miss 的歌才付这个成本）。 */
    if (key === 'qq' && !mvVid) {
        try {
            const t0 = Date.now();
            mvVid = await qqVidBySongSearch(title, singer, info.mid);
            /* ★ 2026-10-04：这条链此前**完全静默** —— 找到了 vid、没找到 vid、请求失败，
               三种结果在日志里一模一样（都是空白），用户报「QQ 不会自动匹配 MV」时
               无法区分是「反查没查到」还是「反查到但取址失败」还是「压根没走这条链」。
               现在每次反查都打一行（含耗时），QQ MV 问题一眼可判。 */
            logInfo('mvApi', `[MV] QQ vid 反查${mvVid ? '命中' : '未命中'}「${title}」mid=${info.mid || '-'} → ${mvVid || '(空)'}（${Date.now() - t0}ms）`);
        } catch (e) {
            logWarn('mvApi', `[MV] QQ vid 反查异常「${title}」: ${e && e.message ? e.message : e}`);
            logCatch('mvApi', e);
        }
    }
    if (key === 'qq' && mvVid) {
        return { source, mvId: mvVid, vid: mvVid, hash: '', name: title, singer, cover, duration: 0, playCount: '', via: 'vendor' };
    }
    if (key === 'qq' && !mvVid) {
        /* QQ 走到这里 = 反查没拿到 vid ⇒ 下面 ② 对 QQ 是跳过的、③ 只剩最严的跨源。
           明确记一笔，避免用户以为"匹配逻辑没跑"。 */
        logInfo('mvApi', `[MV] QQ 无 vid 可用（歌名/歌手/mid 均未命中）→ 落跨源兜底「${title}」`);
    }
    if (key === 'kugou' && mvHash) {
        return { source, mvId: mvHash, vid: '', hash: mvHash, name: title, singer, cover, duration: 0, playCount: '', via: 'vendor' };
    }
    if (key === 'netease' && mvId && mvId !== '0') {
        const d = await neteaseMvDetail(mvId);
        if (d) return { ...d, via: 'vendor' };
    }

    /* ② 本平台关键词搜索：先「歌名 歌手」（最准），**命中就不搜第二个词**。
       ★ 必须两池都试：「起风了 买辣椒也用券」只回 5 条、正主那条在里面；单搜「起风了」
       回 18 条翻唱。但无条件搜两遍会平白多一次请求 —— 上游 type=1004 有频率风控
       （实测连发几十次后 code=405），所以按需补搜。 */
    const combo = `${title} ${singer}`.trim();
    const info2 = { title, singer };
    if (key !== 'qq') {
        let pools = await fetchMvCandidates(source, combo, 18);
        let hit = matchMvFromCandidates(pools, info2);
        if (!hit && norm(combo) !== norm(title)) {
            pools = pools.concat(await fetchMvCandidates(source, title, 18));
            hit = matchMvFromCandidates(pools, info2);
        }
        if (hit) return { ...hit, via: 'search' };
    }

    /* ③ 跨源兜底（网易 MV 库最全 → 酷狗）。strict：只认完全同名，跨源不容忍"包含"。 */
    for (const alt of ['netease', 'kugou']) {
        if (alt === key) continue;
        const cands = await fetchMvCandidates(alt, combo, 18);
        if (!cands.length) continue;
        const hit = matchMvFromCandidates(cands, info2, { strict: true });
        if (hit) return { ...hit, via: 'cross' };
    }
    return null;
}

/**
 * 搜索页 MV 用的关键词检索：比 searchMvs 多一层「召回补救」。
 *
 * 上游对**纯歌名**的 MV 检索召回很差：实测网易搜「起风了」回 18 条，前几条全是翻唱
 * （吴青峰 / 李赛儿 / 春升君 / …），而原唱买辣椒也用券那条根本不在里面 →
 * finalizeMvs 按歌手筛后整排为空，搜索页的 MV 区就空着。
 * 这正是用户报的「同名（甚至括号都一样）同作者的 MV 都匹配不上」的一种形态。
 * 补救：主搜索筛完为空时，用「关键词 + 原唱歌手」再搜一次 —— 即"歌名 + 作者"匹配。
 *
 * ★ 补搜结果必须再过一道「歌名含搜索词」：finalizeMvs 只按歌手筛，不设这道会把
 *   该歌手**别的歌**的 MV 一起摆出来（实测「成都 赵雷」会带出《南方姑娘》《理想》）。
 * ★ 搜索词本身就是歌手名时（搜「周杰伦」）不补搜：那本来就是"看这个歌手的 MV"，
 *   空就是真的空。
 */
export async function searchMvsForWord(source, word, opts = {}) {
    const kw = String(word || '').trim();
    if (!kw) return [];
    const limit = Math.max(1, Math.min(12, parseInt(opts.limit, 10) || 6));
    const artists = Array.isArray(opts.artists) ? opts.artists : [];
    const key = selfhostKeyOf(source);
    const primary = await searchMvs(source, kw, opts);
    if (primary.length) return primary;

    const singer = String((artists[0] && artists[0].name) || '').trim();
    const nkw = norm(kw);
    const ns = normSinger(singer);
    /* 补搜「关键词 + 原唱歌手」（搜的本来就是歌手名时不补，那本该是"他的全部 MV"） */
    if (singer && !(ns && nkw.includes(ns))) {
        const extra = await searchMvs(source, `${kw} ${singer}`, { ...opts, limit: 12 });
        const kept = extra.filter(mv => norm(mv.name).includes(nkw)).slice(0, limit);
        if (kept.length) return kept;
    }
    /* 跨源兜底：本平台（尤其网易）的 MV 检索会被上游风控 —— 实测大量请求后
       `/search` **连同 type=1 一起**返回 code=405，这时同一个词换酷狗往往还有结果。
       过滤口径与本平台一致（finalizeMvs 按歌手），**再加一道相关性**：
       歌名要含搜索词，或歌手名被搜索词包含（搜「周杰伦」时后者成立）。
       上游的歌手字段偶尔会标错（实测酷狗搜「成都 赵雷」回了一条
       「高安、郑莉莉 - 我是否也在你心中 / 赵雷」），只按歌手筛会把它放进来。 */
    for (const alt of ['kugou', 'netease', 'tencent']) {
        if (selfhostKeyOf(alt) === key) continue;
        if (!mvSearchSupported(alt)) continue;
        const cands = await fetchMvCandidates(alt, `${kw} ${singer}`.trim(), 18);
        if (!cands.length) continue;
        const picked = finalizeMvs(cands, kw, artists, limit).filter(mv => {
            const nm = norm(mv.name);
            const n2 = normSinger(mv.singer);
            return nm.includes(nkw) || (n2 && nkw.includes(n2));
        });
        if (picked.length) return picked;
    }
    return [];
}

/* ---------------- 公网兜底（QQ 关键词搜 MV） ---------------- */

/**
 * vkeys 公网 QQ MV 搜索。**只作兜底**，见文件头说明：全站视频检索、相关性差，
 * 且 perPage 恒为 1 —— 只能靠多页并发凑条数，条数多时容易撞风控(110000)。
 * @returns {Promise<Array>}
 */
export async function searchMvsViaVkeys(source, keyword, limit = 6) {
    const url = `${API_BASE}/music/tencent/search/mv?keyword=${enc(String(keyword || '').trim())}`;
    if (!keyword) return [];
    const wanted = Math.max(1, Math.min(8, parseInt(limit, 10) || 6));
    const pages = await Promise.all(Array.from({ length: wanted }, (_, i) => (async () => {
        try {
            const res = await proxyFetch(`${url}&page=${i + 1}`, { timeout: 6000 });
            const j = await res.json();
            return (j && j.code === 0 && j.data && Array.isArray(j.data.list)) ? j.data.list : [];
        } catch { return []; }
    })()));
    const seen = new Set();
    const out = [];
    for (const list of pages) {
        for (const mv of list) {
            const vid = mv.vid || '';
            if (!vid || seen.has(vid)) continue;
            seen.add(vid);
            out.push({
                source: 'tencent',
                mvId: String(mv.mvID || vid),
                vid,
                hash: '',
                name: mv.mvName || '',
                singer: mv.singerName || '',
                cover: upHttps(mv.mvPic),
                duration: toSec(mv.duration),
                playCount: fmtCount(mv.playCount),
            });
        }
    }
    return out.filter(mv => mv.name).slice(0, wanted);
}
