/**
 * shazam_cli.js — 本地音频听歌识曲 & 元数据/歌词自动下载工具
 * 
 * 依赖: shazamio-core (WebAssembly 纯本地指纹算法), @ffmpeg-installer/ffmpeg
 * 用法: node tools/shazam_cli.js "D:\你的本地音乐.mp3"
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
 * 截取指定时间段的音频为标准 WAV 格式 (16kHz, 单声道)
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
            else reject(new Error(`ffmpeg conversion failed with code ${code}`));
        });
        proc.on('error', reject);
    });
}

/**
 * 向 Apple Shazam API 发送声学指纹请求
 */
async function queryShazam(sig) {
    const endpoint = `https://amp.shazam.com/discovery/v5/zh/CN/web/-/tag/${uuidv4()}/${uuidv4()}?sync=true&webv3=true&sampling=true&shazamapiversion=v3`;

    const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
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
 * 多时间段滑动扫描听歌识曲
 */
async function recognizeAudioFile(filePath) {
    if (!fs.existsSync(filePath)) {
        console.error(`❌ 文件不存在: ${filePath}`);
        return null;
    }

    const fileSize = fs.statSync(filePath).size;
    console.log(`\n🎧 正在读取音频文件: ${path.basename(filePath)} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

    // 扫描多个关键时间段（开头 0s、副歌高潮 20s、45s、70s）
    const scanOffsets = [0, 20, 45, 70, 95];

    for (const offset of scanOffsets) {
        process.stdout.write(`⚡ 正在提取第 ${offset}s 声学特征指纹并匹配云端... `);
        try {
            const wavBuffer = await extractWavSnippet(filePath, offset, 10);
            if (!wavBuffer || wavBuffer.length === 0) {
                console.log('跳过 (音频不足)');
                break;
            }

            const decodedSig = core.recognizeBytes(new Uint8Array(wavBuffer));
            const sig = Array.isArray(decodedSig) ? decodedSig[0] : decodedSig;

            if (!sig || !sig.uri) {
                console.log('指纹生成失败');
                continue;
            }

            const track = await queryShazam(sig);
            if (track && track.title) {
                console.log('✅ 匹配成功！');
                return track;
            } else {
                console.log('未命中');
            }
        } catch (e) {
            console.log(`出错: ${e.message}`);
        }
    }

    console.log('\n❌ Shazam 官方曲库中未收录此音频指纹');
    return null;
}

/**
 * 自动从免费公共歌词库 (LRCLIB) 检索并下载精准时间轴 LRC 歌词
 */
async function fetchSyncedLyrics(title, artist, album) {
    console.log(`\n📝 正在检索高精度时间轴歌词 (LRCLIB)...`);
    try {
        const query = new URLSearchParams({
            track_name: title,
            artist_name: artist
        });
        if (album) query.append('album_name', album);

        const res = await fetch(`https://lrclib.net/api/get?${query.toString()}`, {
            headers: { 'User-Agent': 'LyricsPlayer/1.0' }
        });

        if (res.ok) {
            const json = await res.json();
            if (json.syncedLyrics) {
                console.log(`✅ 成功获取精准滚动歌词 (LRC)！`);
                return json.syncedLyrics;
            } else if (json.plainLyrics) {
                console.log(`ℹ️ 获取到纯文本歌词 (无时间轴)`);
                return json.plainLyrics;
            }
        }
    } catch (e) {
        console.warn(`⚠️ LRCLIB 查询失败: ${e.message}`);
    }
    return null;
}

// 主入口
async function main() {
    const targetFile = process.argv[2];

    if (!targetFile) {
        console.log('====================================================');
        console.log('    Shazam 听歌识曲 & 元数据/歌词下载工具 (Node.js)  ');
        console.log('====================================================');
        console.log('用法: node tools/shazam_cli.js <你的音频文件路径>');
        console.log('示例: node tools/shazam_cli.js "D:\\Music\\未知歌曲.mp3"');
        console.log('====================================================');
        return;
    }

    try {
        const track = await recognizeAudioFile(targetFile);
        if (!track) return;

        const title = track.title || '未知歌名';
        const artist = track.subtitle || '未知歌手';
        const album = track.sections?.[0]?.metadata?.find(m => m.title === 'Album')?.text || '';
        const year = track.sections?.[0]?.metadata?.find(m => m.title === 'Released')?.text || '';
        const label = track.sections?.[0]?.metadata?.find(m => m.title === 'Label')?.text || '';
        const genre = track.genres?.primary || '';
        const coverUrl = track.images?.coverarthq || track.images?.coverart || '';
        const isrc = track.isrc || '';

        console.log('\n========================================');
        console.log('🎉 识别成功 (Match Found!)');
        console.log('========================================');
        console.log(`🎵 歌名 (Title):     ${title}`);
        console.log(`👤 歌手 (Artist):    ${artist}`);
        console.log(`💿 专辑 (Album):     ${album || '未知'}`);
        console.log(`📅 发行年份 (Year):  ${year || '未知'}`);
        console.log(`🎼 流派 (Genre):     ${genre || '未知'}`);
        console.log(`🏷️ ISRC:             ${isrc || '无'}`);
        console.log(`🏢 发行方 (Label):   ${label || '未知'}`);
        console.log(`🖼️ 高清封面 (Cover): ${coverUrl || '无'}`);

        // 尝试下载歌词并保存为同名 .lrc 文件
        const lrcContent = await fetchSyncedLyrics(title, artist, album);
        if (lrcContent) {
            const lrcPath = targetFile.replace(/\.[^/.]+$/, '') + '.lrc';
            fs.writeFileSync(lrcPath, lrcContent, 'utf-8');
            console.log(`💾 滚动歌词已保存至: ${lrcPath}`);
        } else {
            // 降级使用 Shazam 自带歌词
            const shazamLyrics = track.sections?.find(s => s.type === 'LYRICS')?.text;
            if (shazamLyrics && shazamLyrics.length > 0) {
                const lrcPath = targetFile.replace(/\.[^/.]+$/, '') + '.lrc';
                fs.writeFileSync(lrcPath, shazamLyrics.join('\n'), 'utf-8');
                console.log(`💾 Shazam 纯文本歌词已保存至: ${lrcPath}`);
            }
        }

        console.log('\n✨ 处理全部完成！');

    } catch (err) {
        console.error('❌ 执行出错:', err);
    }
}

main();
