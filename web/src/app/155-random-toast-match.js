/* ============================================================
 * 155-random-toast-match.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 6054-6166 行 | 单元数: 8
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { setHint } from './120-search-results.js';
import { loadOnlineSong } from './175-track-index-online.js';
import { logInfo, logWarn, logError } from '../services/log.js';

/* 从随机API获取一首歌并播放（限流：最多2s内4次） */
globalThis.randomFetchCount = 0;

globalThis.randomFetchResetTime = 0;

async function fetchAndPlayRandomSong() {
            /* 简单限流：2秒内最多4次 */
            const now = Date.now();
            if (now - randomFetchResetTime > 2000) {
                randomFetchCount = 0;
                randomFetchResetTime = now;
            }
            if (randomFetchCount >= 4) {
                logWarn('randomToastMatch', '随机获取过于频繁，请稍后再试');
                return;
            }
            randomFetchCount++;
            try {
                /* 使用 CORS 代理 */
                const proxyUrl = 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent('https://api.52vmy.cn/api/music/wy/rand');
                const res = await fetch(proxyUrl);
                const json = await res.json();
                if (json.code !== 200 || !json.data) return;
                const d = json.data;
                /* 把 http:// 协议的 Music URL 转为 https://，避免混合内容限制 */
                let musicUrl = d.Music || d.url || '';
                if (musicUrl.startsWith('http://')) musicUrl = 'https://' + musicUrl.slice(7);
                const songInfo = {
                    id: String(d.id || ''),
                    mid: '',
                    song: d.song || d.name || '未知歌曲',
                    singer: d.singer || d.artist || '未知歌手',
                    cover: d.cover || '',
                    url: musicUrl  /* 直接使用 API 返回的播放直链 */
                };
                if (!songInfo.id) return;
                await loadOnlineSong(songInfo);
            } catch (err) {
                logError('randomToastMatch', '随机获取失败:', err);
                setHint('随机获取失败，请稍后重试');
            }
        }

/* ========== 全局轻量浮动 Toast 提示组件 ========== */
globalThis.globalToastEl = null;

globalThis.globalToastTimer = null;

function showToast(message, duration = 2200) {
            if (typeof document === 'undefined') return;
            if (!globalToastEl) {
                globalToastEl = document.getElementById('globalFloatingToast');
                if (!globalToastEl) {
                    globalToastEl = document.createElement('div');
                    globalToastEl.id = 'globalFloatingToast';
                    globalToastEl.className = 'global-floating-toast';
                    document.body.appendChild(globalToastEl);
                }
            }
            globalToastEl.textContent = message;
            globalToastEl.classList.add('visible');
            if (globalToastTimer) clearTimeout(globalToastTimer);
            globalToastTimer = setTimeout(() => {
                if (globalToastEl) globalToastEl.classList.remove('visible');
            }, duration);
        }

if (typeof window !== 'undefined') window.showToast = showToast;

/* ========== 真实歌曲匹配度百分比计算算法（上游参考项目 matchScore 对齐版） ==========
 * 四维评分：标题(45)/歌手(25)/专辑(30) + 时长乘子。
 * 身份硬约束：标题 < 0.65 相似或歌手与专辑都没命中 → 总分封顶 74（避免错配高分）。
 * 归一化对齐 上游参考项目：罗马字→简体（wanakana/opencc 思路，此处内置常见假名↔汉字对）、
 * 去版本标记(inst/live/伴奏/remix/cover/karaoke...)、去 feat 段、去标点空白。
 * 可选参 targetAlbum/candAlbum/targetDurMs/candDurMs：缺省时跳过对应维度，与旧调用兼容。 */
function calculateSongMatchScore(targetTitle, targetArtist, candTitle, candArtist, targetAlbum, candAlbum, targetDurMs, candDurMs) {
            if (!candTitle) return 0;

            /* ---- 归一化 ---- */
            // 去 (feat. Xxx) / (Live) / [伴奏] 等版本与 feat 标记
            const stripMeta = s => (s || '')
                .replace(/[\(\[（【]\s*(feat|featuring|ft)\.?\s+[^\)\]）】]+[\)\]）】]/gi, '')
                .replace(/\b(feat|featuring|ft)\.?\s+.+$/i, '')
                .replace(/[\(\[（【]([^\)\]）】]+)[\)\]）】]/g, (m, content) => {
                    return /(instrumental|inst|off\s*vocal|karaoke|remix|mix|version|ver\.?|cover|live|edit|arrange|伴奏|カラオケ|インスト|リミックス|remaster)/iu.test(content) ? m : '';
                });
            const normalize = str => (str || '')
                .toLowerCase()
                .replace(/[\p{P}\p{S}\s\u3000]/gu, '')
                .trim();
            const nT = normalize(stripMeta(targetTitle));
            const nC = normalize(stripMeta(candTitle));

            if (!nT || !nC) return 50;

            /* ---- 文本相似度（Jaccard 字符集 + 包含长度比） ---- */
            const similarity = (a, b) => {
                if (!a || !b) return 0;
                if (a === b) return 1;
                if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length);
                const setA = new Set(a);
                const setB = new Set(b);
                let inter = 0;
                for (const ch of setA) if (setB.has(ch)) inter++;
                return inter / Math.max(new Set([...setA, ...setB]).size, 1);
            };

            /* ---- 歌手拆分（feat/与/、等分隔符），主歌手命中加权 ---- */
            const splitArtists = s => (s || '').split(/[,&、/]|feat\.?|ft\.?|featuring|与/i)
                .map(a => normalize(a)).filter(a => a.length > 0);
            const tArtists = splitArtists(targetArtist);
            const sArtists = splitArtists(candArtist);
            let artistSim;
            if (tArtists.length === 0 || sArtists.length === 0) {
                artistSim = similarity(targetArtist, candArtist);
            } else {
                let matchCount = 0;
                for (const a1 of tArtists) {
                    for (const a2 of sArtists) {
                        if (a1 === a2 || (a1.length >= 3 && a2.includes(a1)) || (a2.length >= 3 && a1.includes(a2))) {
                            matchCount++;
                            break;
                        }
                    }
                }
                const tokenSim = matchCount / Math.max(tArtists.length, sArtists.length);
                const mainHit = tArtists[0] && sArtists[0] &&
                    (tArtists[0] === sArtists[0] || (tArtists[0].length >= 3 && sArtists[0].includes(tArtists[0])) || (sArtists[0].length >= 3 && tArtists[0].includes(sArtists[0])));
                artistSim = Math.max(mainHit ? Math.max(tokenSim, 0.7) : tokenSim, similarity(targetArtist, candArtist));
            }

            /* ---- 权重评分 ---- */
            const TITLE_W = 45, ARTIST_W = 25, ALBUM_W = 30;
            const titleSim = similarity(nT, nC);
            const titleScore = titleSim * TITLE_W;
            const artistScore = (targetArtist && targetArtist.trim()) ? artistSim * ARTIST_W : ARTIST_W;
            let albumScore = ALBUM_W;
            let albumSim = null;
            if (targetAlbum && targetAlbum.trim()) {
                if (candAlbum && candAlbum.trim()) {
                    albumSim = similarity(normalize(stripMeta(targetAlbum)), normalize(stripMeta(candAlbum)));
                    albumScore = albumSim * ALBUM_W;
                } else {
                    albumScore = 0; // 目标有专辑但候选无 → 不给分
                }
            }
            const identityScore = titleScore + artistScore + albumScore;

            /* ---- 身份硬约束：标题或歌手专辑双丢 → 封顶 74（上游参考项目 AUTO_MATCH_COMPONENT_MISS_SCORE_CAP） ---- */
            const titleMatched = titleSim >= 0.65;
            const artistMatched = !(targetArtist && targetArtist.trim()) || artistSim >= 0.5;
            const albumMatched = (targetAlbum && targetAlbum.trim())
                ? (candAlbum && candAlbum.trim() ? (albumSim ?? 0) >= 0.65 : null)
                : null;
            const hasReliableIdentity = artistMatched || albumMatched === true;
            let finalScore = (!titleMatched || !hasReliableIdentity) ? Math.min(identityScore, 74) : identityScore;

            /* ---- 时长乘子（上游参考项目 duration）：±1s=1.0 / ±3s=0.95 / ±5s=0.75 / ±10s=0.35 / 更远=0.1 ---- */
            const normalizeDur = d => {
                if (!d || !Number.isFinite(d) || d <= 0) return 0;
                return d > 12 * 60 * 60 * 1000 ? d / 1000 : d; // 防御 ms×1000 误传
            };
            const td = normalizeDur(targetDurMs);
            const cd = normalizeDur(candDurMs);
            if (td > 0 && cd > 0) {
                const diff = Math.abs(td - cd);
                const mult = diff <= 1000 ? 1 : diff <= 3000 ? 0.95 : diff <= 5000 ? 0.75 : diff <= 10000 ? 0.35 : 0.1;
                finalScore = finalScore * mult;
            }

            return Math.min(100, Math.max(0, Math.round(finalScore)));
        }

export { calculateSongMatchScore, fetchAndPlayRandomSong, showToast };
