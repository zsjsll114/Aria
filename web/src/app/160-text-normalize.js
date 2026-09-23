/* ============================================================
 * 160-text-normalize.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 6170-6313 行 | 单元数: 16
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */

/* ========== 听歌识曲模块 (Audio Recognition) ========== */
/* ===== 本地化辅助：isrc 缓存 + 跨 storefront iTunes 查名（借鉴 JiBA 机制） ===== */
const REC_CACHE_KEY = 'rec_isrc_cache';

const ITUNES_SEARCH = 'https://itunes.apple.com/search';

function normLC(s) { return (s || '').toLowerCase().replace(/[\s\-_—·.,/\\()\[\]'`'"（）]/g, ''); }

function isCJK(s) { return /[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(s || ''); }

function detectScript(text) {
            if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return 'jp';
            if (/[\uAC00-\uD7AF]/.test(text)) return 'kr';
            if (/[\u4E00-\u9FFF]/.test(text)) return 'zh';
            return '';
        }

// 由 ISRC 前缀推断发行地（仅供选店排序，不是语言证明）
function inferIsrcRegionCode(isrc) {
            const m = /^[A-Za-z]{2}/.exec(isrc || '');
            if (!m) return '';
            const cc = m[0].toUpperCase();
            if (['JP'].includes(cc)) return 'jp';
            if (['KR'].includes(cc)) return 'kr';
            if (['CN', 'TW', 'HK', 'MO', 'SG', 'MY'].includes(cc)) return 'zh';
            return '';
        }

// 常用繁→简字表：本方案以 iTunes 简体店 cn 为主，仅作 hk/tw 繁体店兜底
const T2S_MAP = {
            '門': '门', '開': '开', '東': '东', '樂': '乐', '國': '国', '為': '为', '灣': '湾', '愛': '爱',
            '來': '来', '還': '还', '兒': '儿', '學': '学', '體': '体', '實': '实', '龍': '龙', '廣': '广',
            '對': '对', '應': '应', '難': '难', '顧': '顾', '據': '据', '機': '机', '雲': '云', '順': '顺',
            '飯': '饭', '飲': '饮', '馬': '马', '鳥': '鸟', '魚': '鱼', '點': '点', '鐘': '钟', '鍾': '钟',
            '長': '长', '間': '间', '陽': '阳', '陰': '阴', '風': '风', '飛': '飞', '無': '无', '萬': '万',
            '與': '与', '於': '于', '獲': '获', '發': '发', '殺': '杀', '獨': '独', '數': '数', '書': '书',
            '畫': '画', '盡': '尽', '藥': '药', '醫': '医', '藝': '艺', '術': '术', '勝': '胜',
            '時': '时', '後': '后', '幾': '几', '總': '总', '腳': '脚', '麼': '么', '這': '这',
            '兩': '两', '個': '个', '關': '关', '內': '内', '敗': '败', '願': '愿', '電': '电',
            '視': '视', '評': '评', '論': '论', '證': '证', '試': '试', '讓': '让', '請': '请', '說': '说',
            '話': '话', '認': '认', '誠': '诚', '謝': '谢', '誰': '谁', '轉': '转', '輕': '轻',
            '較': '较', '邊': '边', '週': '周', '現': '现', '語': '语', '講': '讲', '許': '许', '設': '设',
            '該': '该', '畢': '毕', '顆': '颗', '養': '养', '黃': '黄',
            '黑': '黑', '頁': '页', '頂': '顶', '彈': '弹', '彌': '弥', '張': '张', '強': '强', '歸': '归',
            '當': '当', '連': '连', '遠': '远', '運': '运', '錯': '错', '經': '经', '結': '结',
            '絕': '绝', '網': '网', '線': '线', '紅': '红', '純': '纯', '組': '组', '終': '终', '給': '给',
            '縣': '县', '只': '只', '豐': '丰', '質': '质', '買': '买', '賣': '卖', '辭': '辞', '進': '进',
            '選': '选', '問': '问', '除': '除', '隨': '随', '隱': '隐', '離': '离', '雙': '双',
            '雷': '雷', '飾': '饰', '餘': '余', '魯': '鲁', '鯨': '鲸', '麵': '面'
        };

function t2s(text) {
            if (!text) return text;
            return String(text).replace(/[^\x00-\x7F]/g, ch => T2S_MAP[ch] || ch);
        }

function pickStorefronts(artist, isrc) {
            const s = detectScript(artist);
            if (s === 'jp') return ['jp'];
            if (s === 'kr') return ['kr'];
            if (s === 'zh') return ['cn', 'hk', 'tw'];
            const region = inferIsrcRegionCode(isrc);
            if (region === 'jp') return ['jp', 'cn', 'hk', 'tw'];
            if (region === 'kr') return ['kr', 'cn', 'hk', 'tw'];
            if (region === 'zh') return ['cn', 'hk', 'tw', 'jp'];
            return ['cn', 'jp', 'hk', 'tw', 'kr'];
        }

async function fetchStorefrontLocalizedName(term, artist, country) {
            const url = `${ITUNES_SEARCH}?term=${encodeURIComponent(term)}&entity=song&country=${country}&limit=5`;
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 5000);
            try {
                const resp = await fetch(url, { signal: ctrl.signal });
                if (!resp.ok) return null;
                const j = await resp.json();
                const results = (j.results || []).filter(r => r && r.trackName);
                if (!results.length) return null;
                const normA = normLC(artist);
                const ranked = results.map(r => ({ r, hit: normA && (normLC(r.artistName).includes(normA) || normA.includes(normLC(r.artistName))) }));
                const best = ranked.find(x => x.hit) || ranked[0];
                return { name: best.r.trackName, artistName: best.r.artistName, country };
            } catch (e) { return null; } finally { clearTimeout(timer); }
        }

async function localizeRecognizedName(title, artist, isrc) {
            const sf = pickStorefronts(artist, isrc);
            const settled = await Promise.allSettled(sf.map(c => fetchStorefrontLocalizedName(title, artist, c)));
            const normOrig = normLC(title);
            const normA = normLC(artist);
            // 只接受"确为本地化"的结果：与英文原文不同，且为 CJK，或歌手完全一致；否则跳过继续
            for (let i = 0; i < sf.length; i++) {
                const r = settled[i];
                if (r.status !== 'fulfilled' || !r.value || !r.value.name) continue;
                const name = r.value.name;
                const simplified = sf[i] === 'cn' ? name : t2s(name);
                if (normLC(simplified) === normOrig) continue;
                if (isCJK(simplified)) {
                    return { name: simplified, artistName: r.value.artistName, country: r.value.country };
                }
                if (normA && normLC(r.value.artistName) === normA) {
                    return { name: simplified, artistName: r.value.artistName, country: r.value.country };
                }
            }
            return null;
        }

/* ---- isrc 本地缓存（localStorage 主缓存 + 后端 recognize_cache.json 归档） ---- */
function getIsrcCache() {
            try { return JSON.parse(localStorage.getItem(REC_CACHE_KEY) || '{}') || {}; }
            catch (e) { return {}; }
        }

function persistIsrcCache(cache) {
            try {
                fetch('/api/recognize/cache', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cache) }).catch(() => {});
            } catch (e) {}
        }

function setIsrcCache(cache) {
            try {
                const keys = Object.keys(cache);
                if (keys.length > 2000) {
                    const sorted = keys.sort((a, b) => (cache[b].hits || 0) - (cache[a].hits || 0));
                    sorted.slice(2000).forEach(k => delete cache[k]);
                }
                localStorage.setItem(REC_CACHE_KEY, JSON.stringify(cache));
                persistIsrcCache(cache);
            } catch (e) {}
        }

function rememberIsrcCache(isrc, entry) {
            if (!isrc) return;
            const cache = getIsrcCache();
            const prev = cache[isrc] || { hits: 0 };
            prev.hits = (prev.hits || 0) + 1;
            if (entry.confirmed) {
                if (entry.title !== undefined) prev.title = entry.title;
                if (entry.artist !== undefined) prev.artist = entry.artist;
                ['platform', 'id', 'mid', 'hash', 'cover'].forEach(k => { if (entry[k] !== undefined) prev[k] = entry[k]; });
            } else {
                if (prev.title === undefined && entry.title !== undefined) prev.title = entry.title;
                if (prev.artist === undefined && entry.artist !== undefined) prev.artist = entry.artist;
            }
            cache[isrc] = prev;
            setIsrcCache(cache);
        }

function loadIsrcCacheFromBackend() {
            fetch('/api/recognize/cache', { method: 'GET' })
                .then(r => r.json())
                .then(j => {
                    if (j && typeof j === 'object') {
                        const local = getIsrcCache();
                        const merged = Object.assign({}, j, local);
                        localStorage.setItem(REC_CACHE_KEY, JSON.stringify(merged));
                    }
                })
                .catch(() => {});
        }

export { ITUNES_SEARCH, REC_CACHE_KEY, T2S_MAP, detectScript, fetchStorefrontLocalizedName, getIsrcCache, inferIsrcRegionCode, isCJK, loadIsrcCacheFromBackend, localizeRecognizedName, normLC, persistIsrcCache, pickStorefronts, rememberIsrcCache, setIsrcCache, t2s };
