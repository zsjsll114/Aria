const fs = require('fs');
const path = require('path');
const core = require('shazamio-core');

function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    }).toUpperCase();
}

async function testUserFile() {
    const p = 'D:\\Downloads\\obj_wo3DlMOGwrbDjj7DisKw_15333485374_9a76_c61c_8e90_482bcfa8b1a13f656848f0ee73616c58.mp3';
    if (!fs.existsSync(p)) {
        console.log('File does not exist');
        return;
    }

    const fullBuffer = fs.readFileSync(p);
    console.log('Full file size:', fullBuffer.length, 'bytes');

    // 生成指纹列表
    const sigs = core.recognizeBytes(new Uint8Array(fullBuffer));
    console.log('Generated signatures count:', sigs.length);

    for (let i = 0; i < Math.min(sigs.length, 3); i++) {
        const sig = sigs[i];
        console.log(`\n--- Querying Shazam with Signature #${i + 1} (samplems: ${sig.samplems}) ---`);

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
            console.log('🎉 MATCH FOUND on sig #' + (i + 1) + '!');
            console.log('Title:', data.track.title);
            console.log('Artist:', data.track.subtitle);
            console.log('Album:', data.track.sections?.[0]?.metadata?.find(m => m.title === 'Album')?.text);
            console.log('Cover:', data.track.images?.coverart);
            return;
        } else {
            console.log('Sig #' + (i + 1) + ' matches:', data.matches?.length || 0);
        }
    }
}

testUserFile();
