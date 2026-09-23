const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Shazam } = require('node-shazam');

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

async function testShazam() {
    const shazam = new Shazam();
    const testAudioPath = path.join(__dirname, 'test_sample.mp3');

    console.log('1. 正在获取测试音频样本...');
    // 免费网易云外链音频（ピノキオピー - T氏の話を信じるな）
    const testUrl = 'https://music.163.com/song/media/outer/url?id=2716424334.mp3';

    try {
        await downloadFile(testUrl, testAudioPath);
        console.log(`2. 音频下载完成 (${fs.statSync(testAudioPath).size} 字节)，开始调用 node-shazam 识别...`);

        const result = await shazam.fromFilePath(testAudioPath);
        console.log('\n=== SHAZAM 听歌识曲识别结果 ===');
        console.log('🎵 歌名 (Title):', result?.track?.title);
        console.log('👤 歌手 (Artist):', result?.track?.subtitle);
        console.log('💿 专辑 (Album):', result?.track?.sections?.[0]?.metadata?.find(m => m.title === 'Album')?.text);
        console.log('🖼️ 高清封面 (Cover):', result?.track?.images?.coverarthq || result?.track?.images?.coverart);
        console.log('🏷️ ISRC 编码:', result?.track?.isrc);
        console.log('🆔 Shazam ID:', result?.track?.key);
        
        console.log('\n完整返回对象摘要:');
        console.log(JSON.stringify({
            title: result?.track?.title,
            subtitle: result?.track?.subtitle,
            genres: result?.track?.genres,
            url: result?.track?.url,
            images: result?.track?.images,
        }, null, 2));

        console.log('\n🎉 SUCCESS! node-shazam 测试完全成功！无需任何 API Key，纯开源免费可用！');
    } catch (err) {
        console.error('识别失败:', err);
    } finally {
        if (fs.existsSync(testAudioPath)) {
            fs.unlinkSync(testAudioPath);
        }
    }
}

testShazam();
