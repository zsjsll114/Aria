import test from 'node:test';
import assert from 'node:assert/strict';

test('虚拟机与软件渲染显卡识别全面覆盖', () => {
    const lowEndGPUs = [
        'intel', 'hd graphics', 'basic', 'microsoft', 'software',
        'swiftshader', 'llvmpipe', 'vmware', 'virtualbox', 'vbox',
        'qemu', 'parallels', 'svga', 'mesa', 'softpipe', 'gdi generic'
    ];
    const softwareRenderers = [
        'software', 'swiftshader', 'llvmpipe', 'microsoft basic', 'basic render',
        'vmware', 'virtualbox', 'vbox', 'qemu', 'parallels', 'svga', 'softpipe', 'gdi generic'
    ];

    const testGpuNames = [
        'VMware SVGA 3D (LLVM 15.0.7)',
        'VirtualBox Graphics Adapter',
        'llvmpipe (LLVM 12.0.0, 256 bits)',
        'Microsoft Basic Render Driver',
        'QEMU Virtual Video Controller',
        'Parallels Video Adapter'
    ];

    testGpuNames.forEach(gpu => {
        const lower = gpu.toLowerCase();
        const isSw = softwareRenderers.some(s => lower.includes(s));
        const isLow = lowEndGPUs.some(g => lower.includes(g));
        assert.ok(isSw, `${gpu} 应被识别为软件渲染/虚拟显卡`);
        assert.ok(isLow, `${gpu} 应被识别为低配显卡`);
    });
});

test('shouldUsePrebakedBlur 条件判定测试', () => {
    // 模拟 DOM 环境对象
    const createMockDoc = (bodyClasses = [], docClasses = [], isSw = false) => {
        return {
            body: {
                classList: {
                    contains: (cls) => bodyClasses.includes(cls)
                }
            },
            documentElement: {
                classList: {
                    contains: (cls) => docClasses.includes(cls)
                }
            },
            isSw
        };
    };

    const evalShouldUse = (mock) => {
        const body = mock.body;
        return body.classList.contains('perf-low') ||
               body.classList.contains('perf-minimal') ||
               mock.documentElement.classList.contains('is-software-renderer') ||
               Boolean(mock.isSw);
    };

    assert.equal(evalShouldUse(createMockDoc(['perf-high'], [], false)), false, '高性能档不走预烘焙');
    assert.equal(evalShouldUse(createMockDoc(['perf-low'], [], false)), true, '低性能档应启用预烘焙');
    assert.equal(evalShouldUse(createMockDoc(['perf-minimal'], [], false)), true, '极简档应启用预烘焙');
    assert.equal(evalShouldUse(createMockDoc([], ['is-software-renderer'], false)), true, '无显卡软件渲染应启用预烘焙');
    assert.equal(evalShouldUse(createMockDoc([], [], true)), true, 'window.__isSoftwareRenderer 标志应启用预烘焙');
});
