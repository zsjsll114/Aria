const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const core = require('shazamio-core');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

const ffmpegPath = ffmpegInstaller.path;

// 1. 下载测试音频辅助函数
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https:') ? https : http;
        client.get(url, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                downloadFile(response.headers.location, dest).then(resolve).catch(reject);
            } else if (response.statusCode === 200) {
                const file = fs.createWriteStream(dest);
                response.pipe(file);
                file.on('finish', () => file.close(resolve));
            } else {
                reject(new Error(`HTTP Status: ${response.statusCode}`));
            }
        }).on('error', reject);
    });
}

// 2. 将任意格式音频转为 16kHz 单声道 s16le PCM（使用 ffmpeg 原生 CLI，无任何兼容问题）
function convertToPcm16(inputPath) {
    return new Promise((resolve, reject) => {
        const args = [
            '-i', inputPath,
            '-t', '10',             // 取前 10 秒音频
            '-f', 's16le',          // 16-bit PCM
            '-acodec', 'pcm_s16le',
            '-ar', '16000',         // 16kHz
            '-ac', '1',             // 单声道
            'pipe:1'                // 输出到标准输出 stdout
        ];

        const proc = spawn(ffmpegPath, args);
        const chunks = [];
        const errChunks = [];

        proc.stdout.on('data', chunk => chunks.push(chunk));
        proc.stderr.on('data', chunk => errChunks.push(chunk));
        proc.on('close', code => {
            if (code === 0) {
                resolve(Buffer.concat(chunks));
            } else {
                const errMsg = Buffer.concat(errChunks).toString('utf-8');
                reject(new Error(`ffmpeg conversion exited with code ${code}:\n${errMsg}`));
            }
        });
        proc.on('error', reject);
    });
}

// 3. 生成随机 UUID
function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    }).toUpperCase();
}

// 4. 调用 Shazam 官方识别接口
async function recognizeAudioFile(audioPath) {
    console.log(`\n🎧 正在提取音频指纹: ${path.basename(audioPath)}...`);
    
    // 步骤 A: 转为 PCM 16kHz
    const pcmBuffer = await convertToPcm16(audioPath);
    console.log(`   PCM 数据获取完成 (${pcmBuffer.length} 字节 / ${(pcmBuffer.length / 32000).toFixed(1)} 秒)`);

    // 步骤 B: 将 Int16 PCM 数组传给 WebAssembly 算法生成 Shazam 指纹
    const samplesArray = [];
    for (let i = 0; i < pcmBuffer.length; i += 2) {
        samplesArray.push(pcmBuffer.readInt16LE(i));
    }

    const decodedSig = core.recognizeBytes(samplesArray);
    const signatureUri = decodedSig.uri();
    const sampleMs = decodedSig.samplems();
    decodedSig.free(); // 释放 WASM 内存

    console.log(`   Shazam 指纹生成成功 (前缀: ${signatureUri.slice(0, 45)}...)`);

    // 步骤 C: 发送 HTTP POST 请求到 Apple Shazam 官方识别集群
    console.log(`🔍 正在向 Apple/Shazam 云端识别歌曲...`);
    const endpointUrl = `https://amp.shazam.com/discovery/v5/zh/CN/web/-/tag/${uuidv4()}/${uuidv4()}?sync=true&webv3=true&sampling=true&shazamapiversion=v3`;

    const requestBody = JSON.stringify({
        timezone: 'Asia/Shanghai',
        signature: {
            uri: signatureUri,
            samplems: sampleMs
        },
        timestamp: Date.now(),
        context: {},
        geolocation: {}
    });

    const response = await fetch(endpointUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        body: requestBody
    });

    if (!response.ok) {
        throw new Error(`Shazam API HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    return result?.track || null;
}

// 5. 完整演示主入口
async function main() {
    const testAudioPath = path.join(__dirname, 'test_sample.mp3');

    console.log('========================================');
    console.log('     Shazam 听歌识曲 Node.js Demo       ');
    console.log('========================================');
    console.log('1. 正在下载测试样本歌曲（周杰伦 - 晴天 演示片段）...');
    
    // 免费网易云歌曲直链（周杰伦 - 晴天）
    const testUrl = 'https://music.163.com/song/media/outer/url?id=186016.mp3';

    try {
        await downloadFile(testUrl, testAudioPath);
        console.log(`   测试音频下载完成 (${fs.statSync(testAudioPath).size} 字节)`);

        // 执行听歌识曲
        const track = await recognizeAudioFile(testAudioPath);

        if (!track) {
            console.log('\n❌ 未能识别该音频');
            return;
        }

        console.log('\n========================================');
        console.log('🎉 识别成功 (Match Found!)');
        console.log('========================================');
        console.log('🎵 歌名 (Title):   ', track.title);
        console.log('👤 歌手 (Artist):  ', track.subtitle);
        console.log('💿 专辑 (Album):   ', track.sections?.[0]?.metadata?.find(m => m.title === 'Album')?.text || '未知专辑');
        console.log('🖼️ 封面 (Cover):   ', track.images?.coverarthq || track.images?.coverart);
        console.log('🏷️ ISRC 编码:      ', track.isrc);
        console.log('🆔 Shazam ID:      ', track.key);
        console.log('🎼 流派 (Genres):  ', track.genres?.primary);
        
        // 查找歌词
        const lyricsSection = track.sections?.find(s => s.type === 'LYRICS');
        if (lyricsSection && lyricsSection.text) {
            console.log('\n📝 Shazam 附带歌词片段:');
            console.log(lyricsSection.text.slice(0, 4).join('\n'));
        }

    } catch (err) {
        console.error('\n❌ 识别过程出错:', err);
    } finally {
        if (fs.existsSync(testAudioPath)) {
            fs.unlinkSync(testAudioPath);
        }
    }
}

main();
