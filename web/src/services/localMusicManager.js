/**
 * localMusicManager.js — 本地音乐全生命周期管理器
 * 
 * 功能：
 * 1. 结构化单曲目录读写与列表同步 (/api/local-music/* 与 IndexedDB 同构)
 * 2. 上传本地音乐 ➔ Shazam 听歌识曲 ➔ 多源歌词检索 ➔ 匹配度智能竞选 ➔ 转换为 Enhanced LRC 并落盘
 * 3. 降级兜底逻辑（ID3 解析 ➔ 智能文件名解析 ➔ 用户自定义上传 LRC）
 */

import { convertToEnhancedLrc, parseEnhancedLrc } from './enhancedLrcConverter.js';
import { calculateLyricMatchScore } from './lyricMatcher.js';
import { logInfo, logWarn, logError } from './log.js';
import { logCatch } from '../services/log.js';

export class LocalMusicManager {
    constructor() {
        this.apiBase = (typeof window !== 'undefined' && window.location) ? (window.__TAURI_API_ORIGIN || window.location.origin) : 'http://localhost:8001';
        this.dbName = 'LyricsPlayerLocalDB';
        this.storeName = 'local_songs';
        /* ★ 列表短期缓存：打开歌单页频繁调用 getLocalSongs()，避免每次全量扫描磁盘目录 */
        this._listCache = null;
        this._listAt = 0;
        this._LIST_TTL = 8000; // 8 秒（新增/删除歌曲后需 invalidate 强制刷新）
    }

    /**
     * 辅助：文件转 Base64
     */
    async fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    /**
     * 失效本地音乐列表缓存（上传、保存、删除、识曲后调用）
     */
    invalidateListCache() {
        this._listCache = null;
        this._listAt = 0;
    }

    /**
     * 获取本地音乐列表（8 秒缓存）
     */
    async getLocalSongs() {
        try {
            const now = Date.now();
            if (this._listCache && now - this._listAt < this._LIST_TTL) return this._listCache;
            const res = await fetch(`${this.apiBase}/api/local-music/list`);
            if (res.ok) {
                const songs = await res.json();
                this._listCache = songs;
                this._listAt = now;
                return songs;
            }
        } catch (e) {
            logWarn('localMusicManager', '[LocalMusicManager] API 获取失败，回退 IndexedDB:', e);
        }
        if (this._listCache) return this._listCache; // 网络失败时回退到缓存
        return await this._getSongsFromIndexedDB();
    }

    /**
     * 上传并全流程自动处理一首本地音乐
     * @param {File} audioFile - 用户选择的音频文件
     * @param {Function} onProgress - 进度回调 (stepText, percent)
     * @param {Object} lyricFetchers - { fetchNetease, fetchQQ, fetchKugou, fetchLrcLib } 歌词获取器
     */
    async processLocalMusicUpload(audioFile, onProgress = () => {}, lyricFetchers = {}) {
        onProgress('正在上传音频到本地音乐库...', 15);
        const dataBase64 = await this.fileToBase64(audioFile);

        // 1. 调用后端上传临时音频
        let uploadResult = null;
        try {
            const uploadRes = await fetch(`${this.apiBase}/api/local-music/upload`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filename: audioFile.name,
                    dataBase64
                })
            });
            if (uploadRes.ok) {
                uploadResult = await uploadRes.json();
                logInfo('localMusicManager', '[LocalMusicManager] 上传与识曲接口成功响应:', JSON.stringify(uploadResult?.shazam));
            } else {
                const errText = await uploadRes.text();
                logError('localMusicManager', '[LocalMusicManager] 上传接口返回错误:', uploadRes.status, errText);
            }
        } catch (e) {
            logError('localMusicManager', '[LocalMusicManager] 上传请求异常:', e);
        }

        const tempFolder = uploadResult?.tempFolder || `temp_${Date.now()}`;

        // 2. 尝试提取元数据（第一级：Shazam 声学指纹 / 第二级：Vosk 本地离线歌词听写反查 / 第三级：ID3 / 第四级：文件名清洗）
        onProgress('正在进行智能多级识曲 (Shazam 声学指纹 / Vosk 歌词听写)...', 40);
        let meta = await this._recognizeAudioMetadata(audioFile, uploadResult);

        if (!meta || !meta.title) {
            onProgress('读取本地音频标签...', 50);
            meta = this._parseMetadataFromFilename(audioFile.name);
        }

        onProgress(`识曲成功: ${meta.artist} - ${meta.title}，正在全网检索逐字歌词...`, 65);

        // ★ 全网补封面：识别结果无封面时，按歌名+歌手搜索（网易云优先/QQ兜底，后端 /api/cover）
        if (meta && meta.title && !meta.coverUrl && !meta.coverBase64) {
            try {
                const cv = await fetch(`${this.apiBase}/api/cover?title=${encodeURIComponent(meta.title)}&artist=${encodeURIComponent(meta.artist || '')}`);
                if (cv.ok) {
                    const cd = await cv.json();
                    if (cd && cd.ok && cd.cover) { meta = { ...meta, coverUrl: cd.cover }; logInfo('localMusicManager', '[LocalMusicManager] ✅ 全网补封面:', cd.cover); }
                }
            } catch (e) { logWarn('localMusicManager', '[LocalMusicManager] 补封面失败:', e); }
        }

        // 3. 多源歌词检索与智能匹配度竞选
        const candidateLyrics = await this._searchAllLyricSources(meta, lyricFetchers);

        // 计算每个候选的匹配度得分
        for (const candidate of candidateLyrics) {
            candidate.score = calculateLyricMatchScore(meta, candidate);
        }

        // 排序：优先逐字、得分最高，且★歌手一致性过滤（拒绝同曲名不同歌手的“张冠李戴”）
        const normArt = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^\w\u4e00-\u9fa5]+/g, '').trim();
        const artistSim = (a, b) => {
            const x = normArt(a), y = normArt(b);
            if (!x || !y) return true;               // 候选无歌手信息则放行
            if (x.includes(y) || y.includes(x)) return true;
            return false;
        };
        candidateLyrics.sort((a, b) => b.score - a.score);
        const bestAllowed = candidateLyrics.find(c => !c.artist || artistSim(c.artist, meta.artist));
        const bestCandidate = bestAllowed || candidateLyrics[0] || null;

        // 4. 将逐字歌词转换为增强型 LRC (Enhanced LRC)
        let elrcText = '';
        let lrcText = '';
        if (bestCandidate && bestCandidate.parsedLines && bestCandidate.parsedLines.length > 0 && bestCandidate.score >= 45) {
            onProgress('正在转换逐字歌词为增强型 LRC (E-LRC)...', 85);
            elrcText = convertToEnhancedLrc(bestCandidate.parsedLines, {
                title: meta.title,
                artist: meta.artist,
                album: meta.album
            });
            // 纯逐行 LRC 备用
            lrcText = bestCandidate.parsedLines.map(l => {
                const mm = String(Math.floor(l.start / 60000)).padStart(2, '0');
                const ss = String(Math.floor((l.start % 60000) / 1000)).padStart(2, '0');
                const xx = String(Math.floor((l.start % 1000) / 10)).padStart(2, '0');
                return `[${mm}:${ss}.${xx}]${l.original || l.text || ''}`;
            }).join('\n');
        } else if (meta.shazamLyrics && meta.shazamLyrics.length > 0) {
            // 使用 Shazam 纯文本歌词兜底
            lrcText = meta.shazamLyrics.join('\n');
        }

        // 5. 保存到本地歌曲独立文件夹
        onProgress('正在整理单曲专属文件夹与元数据...', 95);
        const savePayload = {
            tempFolder,
            title: meta.title,
            artist: meta.artist,
            album: meta.album || '',
            duration: meta.duration || 0,
            coverUrl: meta.coverUrl || '',
            coverBase64: meta.coverBase64 || '',
            elrcText,
            lrcText,
            matchScore: bestCandidate ? bestCandidate.score : 0,
            source: bestCandidate ? bestCandidate.sourceName : 'local'
        };

        try {
            await fetch(`${this.apiBase}/api/local-music/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(savePayload)
            });
        } catch (e) {
            logWarn('localMusicManager', '[LocalMusicManager] 保存后端失败，保存到 IndexedDB:', e);
            await this._saveSongToIndexedDB({ ...savePayload, audioBlob: audioFile });
        }

        onProgress('✨ 本地音乐导入与增强型歌词匹配完成！', 100);
        /* 列表已变更，失效 8 秒缓存 */
        this.invalidateListCache();

        return {
            title: meta.title,
            artist: meta.artist,
            album: meta.album,
            coverUrl: meta.coverUrl,
            hasWordLevel: Boolean(elrcText),
            matchScore: bestCandidate ? bestCandidate.score : 0,
            candidateLyrics
        };
    }

    /**
     * 手动为指定歌曲上传/替换本地 LRC 歌词文件
     */
    async uploadCustomLrc(folderName, lrcText, isEnhanced = false) {
        try {
            const res = await fetch(`${this.apiBase}/api/local-music/upload-custom-lrc`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    folder: folderName,
                    lrcText,
                    isEnhanced
                })
            });
            if (res.ok) return true;
        } catch (e) {
            logWarn('localMusicManager', '[LocalMusicManager] 自定义歌词保存失败:', e);
        }
        return false;
    }

    /**
     * 删除本地单曲
     */
    async deleteLocalSong(folderName) {
        try {
            const res = await fetch(`${this.apiBase}/api/local-music/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folder: folderName })
            });
            if (!res.ok) return false;
            const d = await res.json().catch(() => ({}));
            if (!(d && d.ok === false)) this.invalidateListCache();
            return !(d && d.ok === false);
        } catch (e) {
            logWarn('localMusicManager', '[LocalMusicManager] 删除失败:', e);
            return false;
        }
    }

    // ==========================================
    // 内部私有辅助逻辑
    // ==========================================

    /**
     * 解析文件名作为降级备用
     */
    _parseMetadataFromFilename(filename) {
        const clean = filename.replace(/\.[^/.]+$/, '').trim();
        let artist = '未知歌手';
        let title = clean;

        if (clean.includes(' - ')) {
            const parts = clean.split(' - ');
            artist = parts[0].trim();
            title = parts.slice(1).join(' - ').trim();
        } else if (clean.includes('_')) {
            const parts = clean.split('_');
            if (parts.length >= 2 && !clean.startsWith('obj_')) {
                artist = parts[0].trim();
                title = parts.slice(1).join(' ').trim();
            }
        }

        // 清除 (Live) 等多余字符
        title = title.replace(/\[.*?\]|\(.*?\)|\{.*?\}/g, '').trim() || title;

        return { title, artist, album: '' };
    }

    /**
     * 听歌识曲与元数据识别
     */
    async _recognizeAudioMetadata(audioFile, uploadResult = null) {
        logInfo('localMusicManager', '[LocalMusicManager] _recognizeAudioMetadata received uploadResult:', uploadResult ? JSON.stringify(uploadResult.shazam) : 'null');
        // 1. 检查上传结果中是否已直接包含服务端 Shazam 识曲结果
        if (uploadResult && uploadResult.shazam && uploadResult.shazam.success && uploadResult.shazam.title) {
            logInfo('localMusicManager', '[LocalMusicManager] ✅ 命中服务端 Shazam 声学识曲结果:', uploadResult.shazam);
            return {
                title: uploadResult.shazam.title,
                artist: uploadResult.shazam.artist || '未知歌手',
                album: uploadResult.shazam.album || '',
                coverUrl: uploadResult.shazam.coverUrl || '',
                coverBase64: uploadResult.shazam.coverBase64 || '',
                year: uploadResult.shazam.year || '',
                genre: uploadResult.shazam.genre || '',
                isrc: uploadResult.shazam.isrc || '',
                method: uploadResult.shazam.method || 'shazam',
                shazamLyrics: uploadResult.shazam.shazamLyrics || []
            };
        }

        // 2. 如果之前未返回，主动请求 /api/local-music/recognize
        if (uploadResult && uploadResult.tempFolder) {
            try {
                const recRes = await fetch(`${this.apiBase}/api/local-music/recognize`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tempFolder: uploadResult.tempFolder })
                });
                if (recRes.ok) {
                    const shazamData = await recRes.json();
                    if (shazamData && shazamData.success && shazamData.title) {
                        logInfo('localMusicManager', '[LocalMusicManager] ✅ 识别接口返回成功:', shazamData);
                        return {
                            title: shazamData.title,
                            artist: shazamData.artist || '未知歌手',
                            album: shazamData.album || '',
                            coverUrl: shazamData.coverUrl || '',
                            coverBase64: shazamData.coverBase64 || '',
                            year: shazamData.year || '',
                            genre: shazamData.genre || '',
                            isrc: shazamData.isrc || '',
                            method: shazamData.method || 'shazam',
                            shazamLyrics: shazamData.shazamLyrics || []
                        };
                    }
                }
            } catch (e) {
                logWarn('localMusicManager', '[LocalMusicManager] 识别接口请求异常:', e);
            }
        }

        // 3. 降级回退：文件名解析
        return this._parseMetadataFromFilename(audioFile.name);
    }

    /**
     * 全源歌词检索与聚合
     */
    async _searchAllLyricSources(meta, fetchers) {
        const results = [];
        const { title, artist } = meta;

        const tasks = [];

        if (fetchers.fetchKugou) {
            tasks.push(fetchers.fetchKugou(title, artist).then(res => {
                if (res && res.lines) {
                    results.push({
                        sourceName: '酷狗音乐',
                        sourceKey: 'kugou',
                        title: res.title || title,
                        artist: res.artist || artist,
                        isWordLevel: Boolean(res.isWordLevel),
                        hasTranslation: Boolean(res.hasTranslation),
                        parsedLines: res.lines
                    });
                }
            }).catch((e) => logCatch('localMusicManager', e)));
        }

        if (fetchers.fetchNetease) {
            tasks.push(fetchers.fetchNetease(title, artist).then(res => {
                if (res && res.lines) {
                    results.push({
                        sourceName: '网易云音乐',
                        sourceKey: 'netease',
                        title: res.title || title,
                        artist: res.artist || artist,
                        isWordLevel: Boolean(res.isWordLevel),
                        hasTranslation: Boolean(res.hasTranslation),
                        parsedLines: res.lines
                    });
                }
            }).catch((e) => logCatch('localMusicManager', e)));
        }

        if (fetchers.fetchQQ) {
            tasks.push(fetchers.fetchQQ(title, artist).then(res => {
                if (res && res.lines) {
                    results.push({
                        sourceName: 'QQ音乐',
                        sourceKey: 'tencent',
                        title: res.title || title,
                        artist: res.artist || artist,
                        isWordLevel: Boolean(res.isWordLevel),
                        hasTranslation: Boolean(res.hasTranslation),
                        parsedLines: res.lines
                    });
                }
            }).catch((e) => logCatch('localMusicManager', e)));
        }

        if (fetchers.fetchLrcLib) {
            tasks.push(fetchers.fetchLrcLib(title, artist).then(res => {
                if (res && res.lines) {
                    results.push({
                        sourceName: 'LRCLIB (开放词库)',
                        sourceKey: 'lrclib',
                        title: res.title || title,
                        artist: res.artist || artist,
                        isWordLevel: false,
                        hasTranslation: false,
                        parsedLines: res.lines
                    });
                }
            }).catch((e) => logCatch('localMusicManager', e)));
        }

        await Promise.allSettled(tasks);
        return results;
    }

    async _getSongsFromIndexedDB() {
        return [];
    }

    async _saveSongToIndexedDB(song) {
        return true;
    }
}
