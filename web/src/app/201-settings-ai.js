/* ============================================================
 * app/201-settings-ai.js — 设置面板「AI 分析」设置页 UI 与绑定
 * ★ 运行时分析/高潮检测/情感词着色服务已抽至 services/aiAnalyzer.js，
 *   此处负责注册运行期回调、兼容全局挂载与 initSettingsAI() 表单交互。
 * ============================================================ */
import { AI_PROVIDERS } from '../config/constants.js';
import { esc } from '../utils/formatters.js';
import { mountSecretInput, mountToggle } from '../ui/settingsPrimitives.js';
import { cleanApiBase, formatGeminiError } from '../services/aiClient.js';
import { aiCacheBulkSet, aiCacheClear, aiCacheCount, aiCacheGetAll, chorusCacheClear, chorusCacheCount } from '../services/aiCache.js';
import {
    setAiRuntimeHooks,
    getLyricsTextForAI,
    testAIConnection,
    analyzeSongWithAI,
    applyEmotionWordColors,
    applyAITheme,
    updateAiSettingsPreview,
    resetAITheme,
    triggerAiAnalysisIfNeeded,
    detectChorus,
    renderChorusMarkers,
    batchAnalyzePlaylist,
} from '../services/aiAnalyzer.js';
import { audio } from './20-lyrics-render.js';
import { aiThemeCache } from './40-playback-state.js';
import { getFavorites } from './120-search-results.js';
import { getPlaylists, playlistsHintEl } from './130-playlists.js';
import { saveSettings } from './180-boot-config.js';
import { applyLyricBlurLevel, applyThemeColor } from './190-settings-fontsize.js';
import { refreshSettingsUI, showSettingsHint } from './220-shortcuts-viewmode.js';
import { logError } from '../services/log.js';
import { t } from '../core/i18n.js';

setAiRuntimeHooks({
    getAudio: () => audio,
    getFavorites,
    getPlaylists,
    getPlaylistsHintEl: () => playlistsHintEl,
    applyLyricBlurLevel,
    applyThemeColor,
    showSettingsHint,
    getChorusState: () => ({
        current: globalThis.currentChorusSegments,
        full: globalThis.fullChorusSegments,
        rhythm: globalThis.audioRhythm,
    }),
    setChorusState: (current, full, rhythm) => {
        globalThis.currentChorusSegments = current;
        globalThis.fullChorusSegments = full;
        globalThis.audioRhythm = rhythm;
    },
    getSelfPlatState: () => globalThis.selfPlatState,
});

globalThis.currentChorusSegments = [];
globalThis.fullChorusSegments = [];
globalThis.audioRhythm = null;
window.triggerAiAnalysisIfNeeded = triggerAiAnalysisIfNeeded;
window.applyEmotionWordColors = applyEmotionWordColors;
window.detectChorus = detectChorus;
window.renderChorusMarkers = renderChorusMarkers;
window.updateAiSettingsPreview = updateAiSettingsPreview;

export function initSettingsAI() {
const playlistAiAnalyzeBtn = typeof document !== 'undefined' ? document.getElementById('playlistAiAnalyzeBtn') : null;
if (playlistAiAnalyzeBtn) {
playlistAiAnalyzeBtn?.addEventListener('click', () => {
batchAnalyzePlaylist();
});
}

            // --- UI Updates: AI 设置面板事件绑定 ---

            /* 确保 providerConfigs 结构完整 */
            if (!appSettings.ai.providerConfigs) {
                appSettings.ai.providerConfigs = {};
            }

            let currentActiveProvider = appSettings.ai.provider || 'openai';
            let firstCall = true;  // 初始化首次调用时，输入框尚未填充，禁止用空值覆盖已保存配置

            /* 根据 provider 更新 UI 控件（输入框值、placeholder、描述、模型预设）并保证严格独立存储 */
            function updateAiProviderUI(newProvider) {
                const targetProv = newProvider || currentActiveProvider || appSettings.ai.provider || 'openai';

                // 1. 先把当前界面的输入框内容保存到上一个激活的供应商配置中
                //    （首次调用时输入框为空，跳过以免清空 localStorage 中已持久化的 key/模型）
                if (currentActiveProvider && !firstCall) {
                    const curKeyInput = typeof document !== 'undefined' ? document.getElementById('setAiApiKey') : null;
                    const curBaseInput = typeof document !== 'undefined' ? document.getElementById('setAiApiBase') : null;
                    const curModelInput = typeof document !== 'undefined' ? document.getElementById('setAiModel') : null;
                    
                    if (!appSettings.ai.providerConfigs[currentActiveProvider]) {
                        appSettings.ai.providerConfigs[currentActiveProvider] = {};
                    }
                    if (curKeyInput) appSettings.ai.providerConfigs[currentActiveProvider].apiKey = curKeyInput.value.trim();
                    if (curBaseInput) appSettings.ai.providerConfigs[currentActiveProvider].apiBase = curBaseInput.value.trim();
                    if (curModelInput && curModelInput.value.trim() !== '') {
                        appSettings.ai.providerConfigs[currentActiveProvider].model = curModelInput.value.trim();
                    }
                }

                // 2. 切换当前供应商标识
                currentActiveProvider = targetProv;
                appSettings.ai.provider = targetProv;

                // 3. 从新供应商的独立配置中提取数据（绝对不读取或继承其他供应商的数据）
                const cfg = AI_PROVIDERS[targetProv] || AI_PROVIDERS.openai;
                if (!appSettings.ai.providerConfigs[targetProv]) {
                    appSettings.ai.providerConfigs[targetProv] = {
                        apiKey: '',
                        apiBase: '',
                        model: cfg.defaultModel || ''
                    };
                }
                const targetSaved = appSettings.ai.providerConfigs[targetProv];

                appSettings.ai.apiKey = targetSaved.apiKey || '';
                appSettings.ai.apiBase = targetSaved.apiBase || '';
                appSettings.ai.model = (targetSaved.model !== undefined && targetSaved.model !== '') ? targetSaved.model : (cfg.defaultModel || '');

                // 4. 刷新 DOM 输入框
                const keyInput = typeof document !== 'undefined' ? document.getElementById('setAiApiKey') : null;
                const baseInput = typeof document !== 'undefined' ? document.getElementById('setAiApiBase') : null;
                const modelInput = typeof document !== 'undefined' ? document.getElementById('setAiModel') : null;
                const keyDesc = typeof document !== 'undefined' ? document.getElementById('setAiKeyDesc') : null;
                const baseDesc = typeof document !== 'undefined' ? document.getElementById('setAiBaseDesc') : null;
                const modelDesc = typeof document !== 'undefined' ? document.getElementById('setAiModelDesc') : null;

                if (keyInput) {
                    keyInput.value = targetSaved.apiKey || '';
                    keyInput.placeholder = cfg.keyPlaceholder || '请输入 API 密钥';
                }
                const isGemini = targetProv === 'gemini';
                if (baseInput) {
                    baseInput.value = targetSaved.apiBase || '';
                    if (isGemini) {
                        const useProxyOn = !(appSettings.ai && appSettings.ai.useProxy === false);
                        baseInput.placeholder = useProxyOn ? 'https://zsjsll-cf.de5.net' : 'https://generativelanguage.googleapis.com';
                    } else {
                        baseInput.placeholder = cfg.defaultBase || '';
                    }
                }
                if (modelInput) {
                    modelInput.value = appSettings.ai.model;
                    modelInput.placeholder = cfg.defaultModel || '';
                }
                if (typeof document !== 'undefined') {
                    const proxyEl = document.getElementById('setAiUseProxy');
                    const proxyRow = proxyEl && proxyEl.closest ? proxyEl.closest('.setting-row') : null;
                    if (proxyRow) proxyRow.style.display = isGemini ? '' : 'none';
                    const tokenEl = document.getElementById('setAiProxyToken');
                    const tokenRow = tokenEl && tokenEl.closest ? tokenEl.closest('.setting-row') : null;
                    if (tokenRow) tokenRow.style.display = isGemini ? '' : 'none';
                }
                if (keyDesc) { const _en = (globalThis.AriaI18n && globalThis.AriaI18n.getLanguage() === 'en-US'); keyDesc.textContent = _en ? `Current provider: ${cfg.name || targetProv} dedicated key` : `当前服务商: ${cfg.name || targetProv} 专属秘钥`; }
                if (baseDesc) baseDesc.textContent = cfg.baseDesc || '接口基础地址';
                /* ★ 隐私标注：Gemini 反代警示（走不走反代由 useProxy 决定，cleanApiBase 会
                   覆盖 apiBase，故不能只看输入框值；开关切换/服务商切换统一走同步函数） */
                syncGeminiProxyWarn();
                if (modelDesc) modelDesc.textContent = cfg.modelDesc || '推荐模型';

                // 5. 同步更新下拉菜单组件显示
                refreshSettingsUI();
                if (!firstCall) {
                    saveSettings();
                }
                firstCall = false;  // 首次调用结束，后续切换 provider 时允许用输入框覆盖旧配置
            }

            // 保持别名与全局可用
            window.updateAiProviderUI = updateAiProviderUI;
            window.updateAIProviderUI = updateAiProviderUI;

            /* ★ Gemini 反代警示同步：useProxy 开（!== false，默认开）即经 zsjsll-cf.de5.net
               中转。此前警示只在服务商切换时按 apiBase 输入框值重建，反代开关切换不刷新，
               导致"关了反代提示还挂着"。 */
            function syncGeminiProxyWarn() {
                const baseDesc = typeof document !== 'undefined' ? document.getElementById('setAiBaseDesc') : null;
                if (!baseDesc) return;
                const old = baseDesc.querySelector('.ai-proxy-warn');
                if (old) old.remove();
                const p = currentActiveProvider || appSettings.ai.provider || 'gemini';
                if (p !== 'gemini') return;
                if (appSettings.ai && appSettings.ai.useProxy === false) return;   /* 已关反代 → 官方接口直连 */
                const warn = document.createElement('span');
                warn.className = 'ai-proxy-warn';
                warn.style.cssText = 'display:block;color:#ffb14d;font-size:11px;opacity:.9;margin-top:4px;';
                warn.textContent = t('ai.proxyWarnText', '当前走第三方反代（zsjsll-cf.de5.net），API 密钥与歌词将经其中转；可在下方关闭反代改用官方接口 generativelanguage.googleapis.com（大陆网络需代理）。');
                baseDesc.appendChild(warn);
            }

            /* 初始化调用一次（优先使用保存的服务商或 gemini） */
            updateAiProviderUI(appSettings.ai.provider || 'gemini');

            /* 反代访问令牌（仅 Gemini 反代使用）：加载已保存值 */
            const aiProxyTokenInput = typeof document !== 'undefined' ? document.getElementById('setAiProxyToken') : null;
            if (aiProxyTokenInput) {
                aiProxyTokenInput.value = (appSettings.ai && appSettings.ai.proxyToken) || '';
                const saveProxyToken = () => {
                    const p = currentActiveProvider || (appSettings.ai && appSettings.ai.provider) || 'gemini';
                    if (p !== 'gemini') return;
                    if (!appSettings.ai) appSettings.ai = {};
                    appSettings.ai.proxyToken = aiProxyTokenInput.value.trim();
                    saveSettings();
                };
                aiProxyTokenInput.addEventListener('input', saveProxyToken);
                aiProxyTokenInput.addEventListener('change', () => {
                    const p = currentActiveProvider || (appSettings.ai && appSettings.ai.provider) || 'gemini';
                    if (p !== 'gemini') return;
                    saveProxyToken();
                    showSettingsHint(appSettings.ai.proxyToken ? t('ai.proxyTokenSaved', '反代访问令牌已保存') : t('ai.proxyTokenCleared', '反代访问令牌已清除'));
                });
            }

            const aiApiKeyInput = typeof document !== 'undefined' ? document.getElementById('setAiApiKey') : null;
            if (aiApiKeyInput) {
                const saveKey = () => {
                    const p = currentActiveProvider || appSettings.ai.provider || 'gemini';
                    if (!appSettings.ai.providerConfigs) appSettings.ai.providerConfigs = {};
                    if (!appSettings.ai.providerConfigs[p]) appSettings.ai.providerConfigs[p] = {};
                    
                    appSettings.ai.apiKey = aiApiKeyInput.value.trim();
                    appSettings.ai.providerConfigs[p].apiKey = appSettings.ai.apiKey;
                    saveSettings();
                };
                aiApiKeyInput.addEventListener('input', saveKey);
                aiApiKeyInput.addEventListener('change', () => {
                    saveKey();
                    showSettingsHint(appSettings.ai.apiKey ? 'API 密钥已保存' : 'API 密钥已清除');
                });
            }

            /* API Key 明密文切换按钮 */
            const toggleKeyVisibilityBtn = typeof document !== 'undefined' ? document.getElementById('setAiToggleKeyVisibility') : null;
            const eyeIconSvg = typeof document !== 'undefined' ? document.getElementById('aiEyeIcon') : null;
            mountSecretInput(aiApiKeyInput, toggleKeyVisibilityBtn, eyeIconSvg);

            /* 启用反向代理开关按钮 */
            const aiUseProxyToggle = typeof document !== 'undefined' ? document.getElementById('setAiUseProxy') : null;
            if (aiUseProxyToggle) {
                aiUseProxyToggle.addEventListener('click', () => {
                    const p = currentActiveProvider || (appSettings.ai && appSettings.ai.provider) || 'gemini';
                    if (p !== 'gemini') return;
                    const isNowOn = !aiUseProxyToggle.classList.contains('on');
                    aiUseProxyToggle.classList.toggle('on', isNowOn);
                    if (!appSettings.ai) appSettings.ai = {};
                    appSettings.ai.useProxy = isNowOn;
                    saveSettings();

                    if (aiApiBaseInput) {
                        aiApiBaseInput.placeholder = isNowOn ? 'https://zsjsll-cf.de5.net' : 'https://generativelanguage.googleapis.com';
                    }
                    syncGeminiProxyWarn();   /* ★ 开关切换即时刷新反代警示（此前残留） */
                    showSettingsHint(isNowOn ? '已启用反向代理（国内直连）' : '已关闭反向代理（官方接口直连）');
                });
            }

            const aiApiBaseInput = typeof document !== 'undefined' ? document.getElementById('setAiApiBase') : null;
            if (aiApiBaseInput) {
                const saveBase = () => {
                    const p = currentActiveProvider || appSettings.ai.provider || 'gemini';
                    if (!appSettings.ai.providerConfigs) appSettings.ai.providerConfigs = {};
                    if (!appSettings.ai.providerConfigs[p]) appSettings.ai.providerConfigs[p] = {};
                    
                    appSettings.ai.apiBase = aiApiBaseInput.value.trim();
                    appSettings.ai.providerConfigs[p].apiBase = appSettings.ai.apiBase;
                    saveSettings();
                };
                aiApiBaseInput.addEventListener('input', saveBase);
                aiApiBaseInput.addEventListener('change', saveBase);
            }

            const aiModelInput = typeof document !== 'undefined' ? document.getElementById('setAiModel') : null;
            if (aiModelInput) {
                const saveModel = () => {
                    const p = currentActiveProvider || appSettings.ai.provider || 'gemini';
                    if (!appSettings.ai.providerConfigs) appSettings.ai.providerConfigs = {};
                    if (!appSettings.ai.providerConfigs[p]) appSettings.ai.providerConfigs[p] = {};
                    
                    const val = aiModelInput.value.trim();
                    appSettings.ai.model = val;
                    appSettings.ai.providerConfigs[p].model = val;
                    saveSettings();
                };
                aiModelInput.addEventListener('input', saveModel);
                aiModelInput.addEventListener('change', saveModel);
            }

            /* 保存 AI 配置按钮 */
            const saveAiConfigBtn = typeof document !== 'undefined' ? document.getElementById('setAiSaveConfigBtn') : null;
            if (saveAiConfigBtn) {
                saveAiConfigBtn.addEventListener('click', () => {
                    const p = currentActiveProvider || appSettings.ai.provider || 'gemini';
                    if (aiApiKeyInput) appSettings.ai.apiKey = aiApiKeyInput.value.trim();
                    if (aiApiBaseInput) appSettings.ai.apiBase = aiApiBaseInput.value.trim();
                    if (aiModelInput) appSettings.ai.model = aiModelInput.value.trim();
                    const _saveProv = currentActiveProvider || (appSettings.ai && appSettings.ai.provider) || 'gemini';
                    const _ptInput = typeof document !== 'undefined' ? document.getElementById('setAiProxyToken') : null;
                    if (_ptInput && _saveProv === 'gemini') appSettings.ai.proxyToken = _ptInput.value.trim();
                    if (!appSettings.ai.providerConfigs) appSettings.ai.providerConfigs = {};
                    if (!appSettings.ai.providerConfigs[p]) appSettings.ai.providerConfigs[p] = {};
                    appSettings.ai.providerConfigs[p].apiKey = appSettings.ai.apiKey;
                    appSettings.ai.providerConfigs[p].apiBase = appSettings.ai.apiBase;
                    appSettings.ai.providerConfigs[p].model = appSettings.ai.model;
                    saveSettings();
                    showSettingsHint('配置已成功保存');
                    saveAiConfigBtn.textContent = '已保存';
                    setTimeout(() => { saveAiConfigBtn.textContent = '保存配置'; }, 2000);
                });
            }

            /* AI 连通性测试结果独立弹窗 */
            const aiTestResultOverlay = typeof document !== 'undefined' ? document.getElementById('aiTestResultOverlay') : null;
            const aiTestModalCloseBtn = typeof document !== 'undefined' ? document.getElementById('aiTestModalCloseBtn') : null;
            const aiTestModalConfirmBtn = typeof document !== 'undefined' ? document.getElementById('aiTestModalConfirmBtn') : null;
            function closeAiTestModal() { if (aiTestResultOverlay) aiTestResultOverlay.classList.remove('visible'); }
            if (aiTestModalCloseBtn) aiTestModalCloseBtn.addEventListener('click', closeAiTestModal);
            if (aiTestModalConfirmBtn) aiTestModalConfirmBtn.addEventListener('click', closeAiTestModal);
            if (aiTestResultOverlay) aiTestResultOverlay.addEventListener('click', (e) => { if (e.target === aiTestResultOverlay) closeAiTestModal(); });

            function showAiTestResultDialog(result, meta = {}) {
                const overlay = document.getElementById('aiTestResultOverlay');
                const titleEl = document.getElementById('aiTestModalTitle');
                const bodyEl = document.getElementById('aiTestModalBody');
                if (!overlay || !bodyEl) return;
                
                const isOk = Boolean(result && result.ok);
                if (titleEl) {
                    /* 状态图标内联 SVG（项目约定：UI 不用 unicode 符号字符） */
                    const icon = isOk
                        ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1.5px"><polyline points="20 6 9 17 4 12"/></svg>'
                        : '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" style="vertical-align:-1.5px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
                    titleEl.innerHTML = isOk
                        ? `<span style="color:#4ade80;">${icon} 连通性测试成功</span>`
                        : `<span style="color:#f87171;">${icon} 连通性测试失败</span>`;
                }
                
                const latencyBadge = (result && result.latency) 
                    ? `<span style="display:inline-block;padding:2px 8px;border-radius:6px;background:rgba(74,222,128,0.15);font-size:12px;color:#4ade80;font-family:monospace;">${result.latency} ms</span>` 
                    : '';
                
                bodyEl.innerHTML = `
                    <div style="margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;">
                        <span style="font-size:14px;font-weight:600;color:${isOk ? '#4ade80' : '#f87171'};">
                            ${isOk ? '接口响应正常' : '连接异常'}
                        </span>
                        ${latencyBadge}
                    </div>
                    <div style="background:rgba(0,0,0,0.28);border:1px solid ${isOk ? 'rgba(74,222,128,0.2)' : 'rgba(248,113,113,0.2)'};border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:13px;word-break:break-word;white-space:pre-wrap;color:${isOk ? '#e2e8f0' : '#fca5a5'};line-height:1.6;">
                        ${esc(result.message || (isOk ? '测试成功' : '未知错误'))}
                    </div>
                    <div style="font-size:11px;color:rgba(255,255,255,0.45);display:flex;flex-direction:column;gap:4px;padding:8px 12px;background:rgba(255,255,255,0.03);border-radius:8px;">
                        <div>服务商: <span style="color:rgba(255,255,255,0.85);">${meta.provider || 'gemini'}</span> | 目标模型: <span style="color:rgba(255,255,255,0.85);">${meta.model || 'gemini-1.5-flash'}</span></div>
                        <div>请求地址: <span style="color:rgba(255,255,255,0.85);word-break:break-all;">${meta.apiBase || '默认'}</span></div>
                    </div>
                `;
                overlay.classList.add('visible');
            }

            /* 测试 AI 连通性 */
            const aiTestConnBtn = typeof document !== 'undefined' ? document.getElementById('setAiTestConn') : null;
            if (aiTestConnBtn) {
                aiTestConnBtn.addEventListener('click', async () => {
                    const originalText = aiTestConnBtn.textContent;
                    aiTestConnBtn.textContent = '测试中...';
                    aiTestConnBtn.disabled = true;
                    const provider = currentActiveProvider || appSettings.ai.provider || 'gemini';
                    const apiKey = (aiApiKeyInput ? aiApiKeyInput.value.trim() : '') || appSettings.ai.apiKey;
                    const apiBase = (aiApiBaseInput ? aiApiBaseInput.value.trim() : '') || appSettings.ai.apiBase;
                    const model = (aiModelInput ? aiModelInput.value.trim() : '') || appSettings.ai.model;
                    try {
                        const result = await testAIConnection();
                        showAiTestResultDialog(result, { provider, apiKey, apiBase, model });
                    } catch (e) {
                        showAiTestResultDialog({ ok: false, message: e.message }, { provider, apiKey, apiBase, model });
                    } finally {
                        aiTestConnBtn.textContent = originalText;
                        aiTestConnBtn.disabled = false;
                    }
                });
            }

            /* 获取模型列表 */
            const aiFetchModelsBtn = typeof document !== 'undefined' ? document.getElementById('setAiFetchModels') : null;
            const aiModelsOverlay = typeof document !== 'undefined' ? document.getElementById('aiModelsOverlay') : null;
            const aiModelsList = typeof document !== 'undefined' ? document.getElementById('aiModelsList') : null;
            const aiModelsCloseBtn = typeof document !== 'undefined' ? document.getElementById('aiModelsCloseBtn') : null;

            function closeAiModelsOverlay() { if (aiModelsOverlay) aiModelsOverlay.classList.remove('visible'); }
            if (aiModelsCloseBtn) aiModelsCloseBtn?.addEventListener('click', closeAiModelsOverlay);
            if (aiModelsOverlay) aiModelsOverlay?.addEventListener('click', (e) => { if (e.target === aiModelsOverlay) closeAiModelsOverlay(); });

            if (aiFetchModelsBtn) {
                aiFetchModelsBtn?.addEventListener('click', async () => {
                    const provider = currentActiveProvider || appSettings.ai.provider || 'gemini';
                    const apiKey = (document.getElementById('setAiApiKey')?.value || '').trim() || appSettings.ai.apiKey;
                    let base = (document.getElementById('setAiApiBase')?.value || '').trim() || appSettings.ai.apiBase;
                    if (!apiKey) { showSettingsHint('请先填写 API 密钥'); return; }

                    aiFetchModelsBtn.textContent = '获取中...';
                    aiFetchModelsBtn.disabled = true;
                    aiModelsList.innerHTML = '<div class="ai-models-loading">正在获取模型列表...</div>';
                    aiModelsOverlay.classList.add('visible');

                    try {
                        let models = [];
                        if (provider === 'gemini') {
                            const useProxy = !(appSettings.ai && appSettings.ai.useProxy === false);
                            const cleanBase = cleanApiBase(base, useProxy);
                            const url = `${cleanBase}/v1beta/models`;
                            const proxyToken = (appSettings.ai && appSettings.ai.proxyToken || '').trim();
                            const resp = await fetch(url, { headers: { 'x-goog-api-key': apiKey, ...(useProxy && proxyToken ? { 'x-proxy-token': proxyToken } : {}) } });
                            if (!resp.ok) {
                                let errDetail = '';
                                try {
                                    const errJson = await resp.json();
                                    errDetail = formatGeminiError(null, resp.status, errJson);
                                } catch (_) {
                                    errDetail = `HTTP ${resp.status}: ${await resp.text()}`;
                                }
                                throw new Error(errDetail);
                            }
                            const data = await resp.json();
                            models = (data.models || [])
                                .filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
                                .map(m => ({
                                    id: m.name.replace(/^models\//, ''),
                                    desc: m.displayName || m.description || '',
                                    tags: []
                                }));
                            /* 标记属性 */
                            models.forEach(m => {
                                if (/thinking|reasoning/i.test(m.id)) m.tags.push({ text: '推理', cls: 'reasoning' });
                                if (/vision|image/i.test(m.id)) m.tags.push({ text: '视觉', cls: 'vision' });
                                if (/flash/i.test(m.id)) m.tags.push({ text: '快速', cls: 'other' });
                                if (/pro/i.test(m.id)) m.tags.push({ text: 'Pro', cls: 'gpt' });
                            });
                        } else {
                            /* OpenAI 兼容 */
                            if (!base) base = 'https://api.openai.com/v1';
                            base = base.replace(/\/+$/, '');
                            const url = `${base}/models`;
                            const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${apiKey}` } });
                            if (!resp.ok) throw new Error(`API 返回 ${resp.status}: ${await resp.text()}`);
                            const data = await resp.json();
                            models = (data.data || []).map(m => ({
                                id: m.id,
                                desc: m.owned_by || '',
                                tags: []
                            }));
                            /* 标记属性 */
                            models.forEach(m => {
                                if (/o1|o3|o4|reason|think|nemotron|deepseek-r1/i.test(m.id)) m.tags.push({ text: '推理', cls: 'reasoning' });
                                if (/vision|image|dall-e/i.test(m.id)) m.tags.push({ text: '视觉', cls: 'vision' });
                                if (/gpt-4|gpt-5/i.test(m.id)) m.tags.push({ text: 'GPT', cls: 'gpt' });
                                if (/mini|flash|nano|small|lite/i.test(m.id)) m.tags.push({ text: '轻量', cls: 'other' });
                            });
                        }

                        if (models.length === 0) {
                            aiModelsList.innerHTML = '<div class="ai-models-loading">未找到可用模型</div>';
                        } else {
                            /* 按模型名排序 */
                            models.sort((a, b) => a.id.localeCompare(b.id));
                            aiModelsList.innerHTML = models.map(m => {
                                const tagsHtml = m.tags.map(t => `<span class="ai-model-item-tag ${t.cls}">${esc(t.text)}</span>`).join('');
                                const descHtml = m.desc ? `<span style="font-size:11px;color:rgba(255,255,255,0.4);margin-left:4px;">${esc(m.desc)}</span>` : '';
                                return `<div class="ai-model-item" data-model-id="${esc(m.id)}">
                                    <span class="ai-model-item-name">${esc(m.id)}${descHtml}</span>
                                    ${tagsHtml}
                                </div>`;
                            }).join('');
                            /* 点击填充模型 */
                            aiModelsList.querySelectorAll('.ai-model-item').forEach(item => {
                                item?.addEventListener('click', () => {
                                    const modelId = item.dataset.modelId;
                                    const modelInputEl = document.getElementById('setAiModel');
                                    if (modelInputEl) modelInputEl.value = modelId;
                                    appSettings.ai.model = modelId;
                                    const p = currentActiveProvider || appSettings.ai.provider || 'gemini';
                                    if (!appSettings.ai.providerConfigs) appSettings.ai.providerConfigs = {};
                                    if (!appSettings.ai.providerConfigs[p]) appSettings.ai.providerConfigs[p] = {};
                                    appSettings.ai.providerConfigs[p].model = modelId;
                                    saveSettings();
                                    closeAiModelsOverlay();
                                    showSettingsHint(`已选择模型: ${modelId}`);
                                });
                            });
                        }
                    } catch (e) {
                        const provCfg = AI_PROVIDERS[provider] || AI_PROVIDERS.openai;
                        if (Array.isArray(provCfg.models) && provCfg.models.length > 0) {
                            aiModelsList.innerHTML = `<div style="font-size:12px;color:rgba(255,255,255,0.6);margin-bottom:8px;padding:0 4px;">未能从服务端动态获取（${esc(e.message)}），已显示【${esc(provCfg.name || provider)}】推荐预置模型：</div>` +
                            provCfg.models.map(m => `
                                    <span class="ai-model-item-tag gpt">推荐</span>
                                </div>
                            `).join('');
                            aiModelsList.querySelectorAll('.ai-model-item').forEach(item => {
                                item?.addEventListener('click', () => {
                                    const modelId = item.dataset.modelId;
                                    const modelInputEl = document.getElementById('setAiModel');
                                    if (modelInputEl) modelInputEl.value = modelId;
                                    appSettings.ai.model = modelId;
                                    const p = currentActiveProvider || appSettings.ai.provider || 'gemini';
                                    if (!appSettings.ai.providerConfigs) appSettings.ai.providerConfigs = {};
                                    if (!appSettings.ai.providerConfigs[p]) appSettings.ai.providerConfigs[p] = {};
                                    appSettings.ai.providerConfigs[p].model = modelId;
                                    saveSettings();
                                    closeAiModelsOverlay();
                                    showSettingsHint(`已选择模型: ${modelId}`);
                                });
                            });
                        } else {
                            aiModelsList.innerHTML = `<div class="ai-models-loading" style="color:#f87171;">获取失败: ${esc(e.message)}</div>`;
                        }
                    }
                });
            }

            mountToggle(document.getElementById('setAiEnabled'), appSettings.ai.enabled, (v) => {
                appSettings.ai.enabled = v;
                saveSettings();
                if (!v) {
                    /* 关闭时恢复手动主题 */
                    resetAITheme();
                } else {
                    /* 开启时立即分析当前歌曲 */
                    if (currentSongData && currentSongData.title) {
                        triggerAiAnalysisIfNeeded();
                    }
                }
            });

            const aiAnalyzeNowBtn = typeof document !== 'undefined' ? document.getElementById('setAiAnalyzeNow') : null;
            if (aiAnalyzeNowBtn) {
                aiAnalyzeNowBtn?.addEventListener('click', async () => {
                    if (!currentSongData || !currentSongData.title) {
                        showSettingsHint('请先播放一首歌曲');
                        return;
                    }
                    if (!appSettings.ai.apiKey) {
                        showSettingsHint('请先输入 API 密钥');
                        return;
                    }
                    showSettingsHint('正在分析歌曲主题...');
                    const lyricsText = getLyricsTextForAI();
                    const themeObj = await analyzeSongWithAI(
                        currentSongData.title,
                        currentSongData.artist || '未知歌手',
                        lyricsText,
                        true  /* forceRefresh: 手动触发无视缓存 */
                    );
                    if (themeObj) {
                        applyAITheme(themeObj);
                        showSettingsHint(`主题分析完成：${themeObj.mood || ''}`);
                    }
                });
            }

const aiResetBtn = typeof document !== 'undefined' ? document.getElementById('setAiResetTheme') : null;
if (aiResetBtn) {
aiResetBtn?.addEventListener('click', () => {
resetAITheme();
showSettingsHint('已恢复手动主题');
});
}

/* ========== AI 缓存管理：导出 / 导入 / 清空 ========== */
const aiExportBtn = typeof document !== 'undefined' ? document.getElementById('setAiExportCache') : null;
if (aiExportBtn) {
aiExportBtn?.addEventListener('click', async () => {
const allCache = await aiCacheGetAll();
const cacheCount = Object.keys(allCache).length;
if (cacheCount === 0) {
showSettingsHint('暂无缓存数据可导出');
return;
}
const exportData = {
exportTime: new Date().toISOString(),
version: '1.0',
count: cacheCount,
cache: allCache
};
const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = `ai_theme_cache_${new Date().toISOString().slice(0,10)}.json`;
a.click();
URL.revokeObjectURL(url);
showSettingsHint(`已导出 ${cacheCount} 条缓存`);
});
}

const aiImportBtn = typeof document !== 'undefined' ? document.getElementById('setAiImportCache') : null;
const aiImportFile = typeof document !== 'undefined' ? document.getElementById('aiCacheImportFile') : null;
if (aiImportBtn && aiImportFile) {
aiImportBtn?.addEventListener('click', () => aiImportFile.click());
aiImportFile?.addEventListener('change', async (e) => {
const file = e.target.files[0];
if (!file) return;
try {
const text = await file.text();
const data = JSON.parse(text);
/* 兼容两种格式：直接的 {key: data} 映射 或 带 cache 字段的对象 */
const entries = data.cache || data;
if (typeof entries !== 'object' || Array.isArray(entries)) {
showSettingsHint('配置文件格式不正确');
return;
}
const count = await aiCacheBulkSet(entries);
/* 同步到内存 */
for (const [key, val] of Object.entries(entries)) {
aiThemeCache[key] = val;
}
const cacheInfoEl = typeof document !== 'undefined' ? document.getElementById('aiCacheInfo') : null;
if (cacheInfoEl) cacheInfoEl.textContent = `已缓存 ${await aiCacheCount()} 首歌曲的分析结果`;
showSettingsHint(`成功导入 ${count} 条缓存`);
} catch (err) {
logError('settingsPanel', '导入缓存失败:', err);
showSettingsHint('导入失败：文件格式错误');
}
aiImportFile.value = ''; /* 重置，允许重复选择同一文件 */
});
}

const aiClearBtn = typeof document !== 'undefined' ? document.getElementById('setAiClearCache') : null;
if (aiClearBtn) {
aiClearBtn?.addEventListener('click', async () => {
if (!(await window.showGlassConfirm({ title: '清空 AI 分析缓存', desc: '确定要清空所有 AI 分析缓存吗？操作不可撤销。', danger: true }))) return;
const ok = await aiCacheClear();
if (ok) {
/* 清空内存缓存 */
Object.keys(aiThemeCache).forEach(k => delete aiThemeCache[k]);
const cacheInfoEl = typeof document !== 'undefined' ? document.getElementById('aiCacheInfo') : null;
if (cacheInfoEl) cacheInfoEl.textContent = '已缓存 0 首歌曲的分析结果';
showSettingsHint('缓存已清空');
} else {
showSettingsHint('清空缓存失败');
}
});
}

/* 清除高潮检测缓存 */
const chorusClearBtn = typeof document !== 'undefined' ? document.getElementById('setClearChorusCache') : null;
if (chorusClearBtn) {
chorusClearBtn?.addEventListener('click', async () => {
if (!(await window.showGlassConfirm({ title: '清空高潮检测缓存', desc: '确定要清空所有歌曲高潮检测缓存吗？操作不可撤销。', danger: true }))) return;
const ok = await chorusCacheClear();
if (ok) {
const infoEl = typeof document !== 'undefined' ? document.getElementById('chorusCacheInfo') : null;
if (infoEl) infoEl.textContent = '已清空';
showSettingsHint('高潮检测缓存已清空');
} else {
showSettingsHint('清空失败');
}
});
/* 初始化时显示缓存数量 */
chorusCacheCount().then(cnt => {
const infoEl = typeof document !== 'undefined' ? document.getElementById('chorusCacheInfo') : null;
if (infoEl) infoEl.textContent = `已缓存 ${cnt} 首歌曲的高潮数据`;
});
}

            /* AI 浮动面板关闭按钮 */
            const aiStatusCloseBtn = typeof document !== 'undefined' ? document.getElementById('aiStatusCloseBtn') : null;
            if (aiStatusCloseBtn) {
                aiStatusCloseBtn?.addEventListener('click', () => {
                    const panel = typeof document !== 'undefined' ? document.getElementById('aiStatusPanel') : null;
                    if (panel) panel.classList.remove('visible');
                });
            }


}
