const { spawn } = require('child_process');
const fs = require('fs');
const core = require('shazamio-core');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

const ffmpegPath = ffmpegInstaller.path;

function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    }).toUpperCase();
}

function extractPcmAtOffset(inputPath, startSec = 0, durationSec = 10) {
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
            else reject(new Error(`ffmpeg exited with code ${code}`));
        });
        proc.on('error', reject);
    });
}

async function testMultiOffsetRecognition(filePath) {
    console.log(`\n🎧 正在进行多时间段指纹扫描: ${filePath}`);

    // 测试多个时间偏移点（0s, 20s, 45s, 70s, 100s）
    const offsets = [0, 20, 45, 70, 100];

    for (const offset of offsets) {
        console.log(`\n⏱️ 正在提取第 ${offset} 秒处的声学指纹...`);
        try {
            const wavBuffer = await extractPcmAtOffset(filePath, offset, 10);
            if (wavBuffer.length === 0) continue;

            const decodedSig = core.recognizeBytes(new Uint8Array(wavBuffer));
            const sig = Array.isArray(decodedSig) ? decodedSig[0] : decodedSig;
            if (!sig || !sig.uri) continue;

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

            const data = await res.json();
            if (data.track) {
                console.log(`\n🎉 在第 ${offset} 秒处成功匹配！`);
                console.log('🎵 歌名 (Title):   ', data.track.title);
                console.log('👤 歌手 (Artist):  ', data.track.subtitle);
                console.log('💿 专辑 (Album):   ', data.track.sections?.[0]?.metadata?.find(m => m.title === 'Album')?.text || '未知专辑');
                console.log('🖼️ 封面 (Cover):   ', data.track.images?.coverarthq || data.track.images?.coverart);
                return data.track;
            } else {
                console.log(`   第 ${offset} 秒处未匹配到`);
            }
        } catch (e) {
            console.error(`   第 ${offset} 秒处提取出错:`, e.message);
        }
    }

    console.log('\n❌ 所有时间段均未能匹配到 Shazam 官方数据库中的歌曲');
}

const targetFile = 'D:\\Downloads\\obj_wo3DlMOGwrbDjj7DisKw_15333485374_9a76_c61c_8e90_482bcfa8b1a13f656848f0ee73616c58.mp3';
testMultiOffsetRecognition(targetFile);
