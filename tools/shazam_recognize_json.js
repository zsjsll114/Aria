/**
 * shazam_recognize_json.js — 综合声学指纹识曲与音频元数据提取器
 * 
 * 识别优先级流水线：
 * 1. Level 1: Shazam 声学指纹云端比对（多时间戳滑动扫描）
 * 2. Level 2: FFmpeg 嵌入式 ID3 / Vorbis / MP4 元数据标签提取 + 封面图提取
 * 3. Level 3: 智能文件名清洗与解析
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const core = require('shazamio-core');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

const ffmpegPath = ffmpegInstaller.path;

function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    }).toUpperCase();
}

/**
 * 截取指定片段为 16kHz 单声道标准 WAV
 */
function extractWavSnippet(inputPath, startSec = 0, durationSec = 10) {
    return new Promise((resolve, reject) => {
        const args = [
            '-ss', String(startSec),
            '-i', inputPath,
            '-t', String(durationSec),
            '-f', 'wav',
            '-ar', '16000',
            '-ac', '1',
            'pipe:1'
        ];

        const proc = spawn(ffmpegPath, args);
        const chunks = [];

        proc.stdout.on('data', chunk => chunks.push(chunk));
        proc.stderr.on('data', () => {});
        proc.on('close', code => {
            if (code === 0) resolve(Buffer.concat(chunks));
            else reject(new Error(`ffmpeg exit code ${code}`));
        });
        proc.on('error', reject);
    });
}

/**
 * 查询 Apple Shazam 官方识别服务器
 */
async function queryShazam(sig) {
    const endpoint = `https://amp.shazam.com/discovery/v5/zh/CN/web/-/tag/${uuidv4()}/${uuidv4()}?sync=true&webv3=true&sampling=true&shazamapiversion=v3`;

    const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        body: JSON.stringify({
            timezone: 'Asia/Shanghai',
            signature: { uri: sig.uri, samplems: sig.samplems },
            timestamp: Date.now(),
            context: {},
            geolocation: {}
        })
    });

    if (!res.ok) return null;
    const text = await res.text();
    if (!text) return null;

    try {
        const data = JSON.parse(text);
        return data?.track || null;
    } catch {
        return null;
    }
}

/**
 * 是否为应用生成的临时录制文件（听歌识曲/上传中转）：文件名本身无意义，
 * 不能退回"文件名清洗"产出的假标题（否则会拿 sample_<时间戳> 当歌名去搜索）。
 * 仅当 Shazam 指纹、ID3 标签都无结果时才会走到这里判断。
 */
function isGeneratedTempName(filePath) {
    const base = path.basename(filePath).replace(/\.\w+$/, '').toLowerCase();
    if (/^(sample|recording|record_|rec_|obj_|_temp_|temp_)/.test(base)) return true;
    if (base === 'song' || base === 'sample' || base === 'audio' || base === 'record') return true;
    return false;
}

/**
 * Level 2: 从音频文件提取嵌入式 ID3 元数据
 */
function extractId3Metadata(filePath) {
    return new Promise((resolve) => {
        const proc = spawn(ffmpegPath, ['-i', filePath, '-f', 'ffmetadata', 'pipe:1']);
        let out = '';
        proc.stdout.on('data', d => out += d.toString());
        proc.stderr.on('data', d => out += d.toString());
        proc.on('close', () => {
            const meta = {};
            const lines = out.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                const eqIdx = trimmed.indexOf('=');
                const colonIdx = trimmed.indexOf(':');
                
                let k = '', v = '';
                if (eqIdx !== -1) {
                    k = trimmed.slice(0, eqIdx).trim().toLowerCase();
                    v = trimmed.slice(eqIdx + 1).trim();
                } else if (colonIdx !== -1 && !trimmed.startsWith('Duration')) {
                    k = trimmed.slice(0, colonIdx).trim().toLowerCase();
                    v = trimmed.slice(colonIdx + 1).trim();
                }
                
                if (k && v && !meta[k]) {
                    meta[k] = v;
                }
            }

            const title = meta.title || meta.song || '';
            const artist = meta.artist || meta.performer || meta.singer || '';
            const album = meta.album || '';

            if (title) {
                resolve({ title, artist: artist || '未知歌手', album });
            } else {
                resolve(null);
            }
        });
        proc.on('error', () => resolve(null));
    });
}

/**
 * Level 2: 提取音频内置封面
 */
function extractEmbeddedCoverBase64(filePath) {
    return new Promise((resolve) => {
        const proc = spawn(ffmpegPath, ['-i', filePath, '-an', '-vcodec', 'copy', '-f', 'image2', 'pipe:1']);
        const chunks = [];
        proc.stdout.on('data', d => chunks.push(d));
        proc.stderr.on('data', () => {});
        proc.on('close', code => {
            if (code === 0 && chunks.length > 0) {
                const buf = Buffer.concat(chunks);
                resolve('data:image/jpeg;base64,' + buf.toString('base64'));
            } else {
                resolve('');
            }
        });
        proc.on('error', () => resolve(''));
    });
}

/**
 * Level 3: 智能文件名清洗
 */
function parseFilename(filePath) {
    const rawName = path.basename(filePath);
    const clean = rawName.replace(/\.[^/.]+$/, '').trim();
    let artist = '未知歌手';
    let title = clean;

    if (clean.includes(' - ')) {
        const parts = clean.split(' - ');
        artist = parts[0].trim();
        title = parts.slice(1).join(' - ').trim();
    } else if (clean.includes('_') && !clean.startsWith('obj_')) {
        const parts = clean.split('_');
        if (parts.length >= 2) {
            artist = parts[0].trim();
            title = parts.slice(1).join(' ').trim();
        }
    }

    title = title.replace(/\[.*?\]|\(.*?\)|\{.*?\}/g, '').trim() || title;
    return { title, artist, album: '' };
}

/**
 * 执行完整识别流水线
 */
async function recognizeAudioFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return { success: false, error: 'File not found' };
    }

    // 1. Level 1: Shazam 声学指纹探测 (开头、20s前奏、45s副歌、75s副歌、100s)
    const offsets = [0, 20, 45, 75, 100];
    for (const offset of offsets) {
        try {
            const wavBuffer = await extractWavSnippet(filePath, offset, 10);
            if (!wavBuffer || wavBuffer.length === 0) continue;

            const decodedSig = core.recognizeBytes(new Uint8Array(wavBuffer));
            const sig = Array.isArray(decodedSig) ? decodedSig[0] : decodedSig;

            if (!sig || !sig.uri) continue;

            const track = await queryShazam(sig);
            if (track && track.title) {
                const title = track.title || '';
                const artist = track.subtitle || '';
                const album = track.sections?.[0]?.metadata?.find(m => m.title === 'Album')?.text || '';
                const year = track.sections?.[0]?.metadata?.find(m => m.title === 'Released')?.text || '';
                const label = track.sections?.[0]?.metadata?.find(m => m.title === 'Label')?.text || '';
                const genre = track.genres?.primary || '';
                
                let coverUrl = track.images?.coverarthq || track.images?.coverart || '';
                if (coverUrl && coverUrl.includes('400x400')) {
                    coverUrl = coverUrl.replace('400x400', '800x800');
                }

                const shazamLyrics = track.sections?.find(s => s.type === 'LYRICS')?.text || [];

                return {
                    success: true,
                    method: 'shazam',
                    title,
                    artist,
                    album,
                    year,
                    genre,
                    label,
                    coverUrl,
                    isrc: track.isrc || '',
                    shazamLyrics,
                    offset
                };
            }
        } catch (e) {
            // 继续下一个 offset
        }
    }

    // 2. Level 2: ID3 标签分析
    try {
        const id3Meta = await extractId3Metadata(filePath);
        if (id3Meta && id3Meta.title) {
            const embeddedCover = await extractEmbeddedCoverBase64(filePath);
            return {
                success: true,
                method: 'id3',
                title: id3Meta.title,
                artist: id3Meta.artist,
                album: id3Meta.album,
                coverBase64: embeddedCover,
                coverUrl: ''
            };
        }
    } catch (e) {}

    // 3. Level 3: 文件名智能解析
    //    若文件是应用生成的临时录制文件，文件名无意义 → 不生成假标题，返回失败
    if (isGeneratedTempName(filePath)) {
        return { success: false, error: 'Generated temp recording (no meaningful filename)' };
    }
    const fnMeta = parseFilename(filePath);
    return {
        success: true,
        method: 'filename',
        title: fnMeta.title,
        artist: fnMeta.artist,
        album: '',
        coverUrl: '',
        coverBase64: ''
    };
}

async function main() {
    const targetFile = process.argv[2];
    if (!targetFile) {
        console.log(JSON.stringify({ success: false, error: 'Missing file argument' }));
        process.exit(1);
    }

    try {
        const res = await recognizeAudioFile(targetFile);
        console.log(JSON.stringify(res));
    } catch (err) {
        console.log(JSON.stringify({ success: false, error: err.message }));
    }
}

main();
