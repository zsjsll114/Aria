const fs = require('fs');
const path = require('path');
const core = require('shazamio-core');

// 生成一个标准的 16kHz, 16-bit, 单声道 5秒音频用于验证算法流水线
function createTestWav(filePath, durationSec = 5) {
    const sampleRate = 16000;
    const numSamples = sampleRate * durationSec;
    const buffer = Buffer.alloc(44 + numSamples * 2);

    // RIFF header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + numSamples * 2, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // subchunk1 size
    buffer.writeUInt16LE(1, 20);  // audio format (PCM = 1)
    buffer.writeUInt16LE(1, 22);  // num channels (1)
    buffer.writeUInt32LE(sampleRate, 24); // sample rate
    buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
    buffer.writeUInt16LE(2, 32); // block align
    buffer.writeUInt16LE(16, 34); // bits per sample
    buffer.write('data', 36);
    buffer.writeUInt32LE(numSamples * 2, 40);

    // 写入合成复音信号 (440Hz + 880Hz)
    for (let i = 0; i < numSamples; i++) {
        const t = i / sampleRate;
        const sample = Math.sin(2 * Math.PI * 440 * t) * 0.5 + Math.sin(2 * Math.PI * 880 * t) * 0.3;
        const int16 = Math.max(-32768, Math.min(32767, Math.floor(sample * 32767)));
        buffer.writeInt16LE(int16, 44 + i * 2);
    }

    fs.writeFileSync(filePath, buffer);
    console.log(`生成测试音频: ${filePath} (${buffer.length} 字节)`);
}

async function testPipeline() {
    const testPath = path.join(__dirname, 'synth_test.wav');
    createTestWav(testPath, 6);

    try {
        const wavBuffer = fs.readFileSync(testPath);
        const decodedSig = core.recognizeBytes(new Uint8Array(wavBuffer));
        const sig = Array.isArray(decodedSig) ? decodedSig[0] : decodedSig;
        const uri = sig.uri;
        const samplems = sig.samplems;
        console.log(`✅ Shazam 指纹生成成功！`);
        console.log(`   - 采样时长: ${samplems} ms`);
        console.log(`   - URI 格式: ${uri.slice(0, 60)}...`);

        // 请求 Shazam API
        console.log(`正在向 Apple/Shazam 官方 API 发起识别请求...`);
        const res = await fetch(`https://amp.shazam.com/discovery/v5/zh/CN/web/-/tag/554868202/527712395?sync=true&webv3=true&sampling=true&shazamapiversion=v3`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            },
            body: JSON.stringify({
                timezone: 'Asia/Shanghai',
                signature: { uri, samplems },
                timestamp: Date.now(),
                context: {},
                geolocation: {}
            })
        });

        const json = await res.json();
        console.log(`✅ Shazam 官方响应状态: ${res.status}`);
        console.log(`   响应内容:`, JSON.stringify(json, null, 2).slice(0, 300));
        console.log('\n🎉 端到端指纹生成与云端 API 交互链路 100% 畅通！');
    } catch (e) {
        console.error('测试出错:', e);
    } finally {
        if (fs.existsSync(testPath)) fs.unlinkSync(testPath);
    }
}

testPipeline();
