import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('i18n 字典包含完整的反代与 AI 分析弹窗双语翻译', () => {
    const src = fs.readFileSync('web/src/core/i18n.js', 'utf8');
    const requiredKeys = [
        'ai.proxyConfirmTitle',
        'ai.proxyConfirmDesc',
        'ai.proxyWarnText',
        'ai.proxyTokenSaved',
        'ai.proxyTokenCleared',
        'ai.statusAnalyzing',
        'ai.retrying',
        'ai.analysisFailed',
        'ai.statusFailed',
        'ai.statusDone',
        'ai.doneTitle',
        'ai.statusNotAnalyzed',
        'ai.statusRestoredManual',
        'ai.statusCached'
    ];

    requiredKeys.forEach(k => {
        assert.ok(src.includes(`'${k}'`), `i18n 应包含 ${k} 键`);
    });
});

test('扫码弹窗最高层级与纯 CPU 模式 backdrop-filter 彻底禁用验证', () => {
    const css = fs.readFileSync('web/src/styles/modals.css', 'utf8');
    assert.ok(css.includes('#selfhostQrOverlay'), 'modals.css 应定义 #selfhostQrOverlay');
    assert.ok(css.includes('z-index: 2147483647 !important;'), '扫码弹窗应具有最高 z-index 2147483647');
    assert.ok(css.includes('.is-software-renderer *'), 'modals.css 应包含 .is-software-renderer 全局规则');
});
