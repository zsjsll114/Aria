const fs = require('fs');
const path = require('path');
const core = require('shazamio-core');

function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    }).toUpperCase();
}

async function recognizeLocalAudio(filePath) {
    console.log(`\n🎧 正在读取音频文件: ${path.basename(filePath)} (${fs.statSync(filePath).size} 字节)...`);
    
    // 1. 读取音频文件数据
    const audioBuffer = fs.readFileSync(filePath);
    const uint8Data = new Uint8Array(audioBuffer);

    // 2. 使用 shazamio-core (WebAssembly) 生成指纹
    console.log(`⚡ 正在提取音频声学指纹 (WebAssembly 引擎)...`);
    const sigResult = core.recognizeBytes(uint8Data);
    const sig = Array.isArray(sigResult) ? sigResult[0] : sigResult;
    
    if (!sig || !sig.uri) {
        console.error('❌ 指纹生成失败');
        return;
    }

    const uri = sig.uri;
    const samplems = sig.samplems;
    console.log(`✅ 指纹生成成功！采样时长: ${samplems} ms`);
    console.log(`   指纹 URI: ${uri.slice(0, 50)}...`);

    // 3. 请求 Apple Shazam 官方识曲服务
    console.log(`🔍 正在向 Apple/Shazam 官方云端匹配歌曲...`);
    const endpoint = `https://amp.shazam.com/discovery/v5/zh/CN/web/-/tag/${uuidv4()}/${uuidv4()}?sync=true&webv3=true&sampling=true&shazamapiversion=v3`;

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        body: JSON.stringify({
            timezone: 'Asia/Shanghai',
            signature: { uri, samplems },
            timestamp: Date.now(),
            context: {},
            geolocation: {}
        })
    });

    const text = await response.text();
    if (!text || text.trim().length === 0) {
        console.log('ℹ️ Shazam 云端未匹配到该歌曲');
        return;
    }

    const data = JSON.parse(text);
    const track = data?.track;

    if (!track) {
        console.log('ℹ️ 识别完成，无匹配的公开曲目');
        return;
    }

    console.log('\n========================================');
    console.log('🎉 识别成功 (Match Found!)');
    console.log('========================================');
    console.log('🎵 歌名 (Title):   ', track.title);
    console.log('👤 歌手 (Artist):  ', track.subtitle);
    console.log('💿 专辑 (Album):   ', track.sections?.[0]?.metadata?.find(m => m.title === 'Album')?.text || '未知专辑');
    console.log('🖼️ 高清封面 (Cover):', track.images?.coverarthq || track.images?.coverart || '无');
    console.log('🏷️ ISRC:           ', track.isrc || '无');
    console.log('🆔 Shazam ID:      ', track.key);

    return track;
}

const testAudio = path.join(__dirname, 'real_song.mp3');
recognizeLocalAudio(testAudio);
