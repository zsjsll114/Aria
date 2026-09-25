/* ============================================================
 * 281-osd.js — 音量/进度/倍速的屏幕浮层反馈（渲染与绑定）
 *
 * 合并、累计、驻留计时全在 core/osd.js，本分片只把快照写成文字与一条细刻度条。
 * 与 280-sleep-timer.js 相反：浮层没有宿主控件，#ariaOsd 不在 index.html 里时
 * 本分片自建同款节点，所以「先 import 后补 HTML」也不会静默失效。
 *
 * 文案不交给 i18n observer：这些字符串里嵌着实时数字（65% / +0:05 / 1.25x），
 * 全句匹配词表命中不了，observer 扫描反而会先闪一次中文再翻。沿用 280 的做法——
 * 分片自带中英双串 + 渲染时按当前语言取，语言切换事件到达时原地重写。
 * ============================================================ */
import { formatTime } from '../utils/formatters.js';
import { logCatch } from '../services/log.js';
import {
    OSD_KIND,
    OSD_RATE_MAX,
    OSD_RATE_MIN,
    getOsdState,
    hideOsd,
    onOsdChange,
    showRate,
    showSeek,
    showVolume,
} from '../core/osd.js';

const STR = {
    volume: ['音量', 'Volume'],
    seekFwd: ['快进', 'Forward'],
    seekBack: ['快退', 'Rewind'],
    rate: ['倍速', 'Speed'],
    rateNormal: ['正常', 'Normal'],
};

/* 静态骨架：模板里零插值，外部数据一律走 textContent（无需 esc()） */
const OSD_HTML = `
    <div class="osd-card" data-osd-role="card">
        <div class="osd-label" data-osd-role="label"></div>
        <div class="osd-value" data-osd-role="value"></div>
        <div class="osd-meter"><span class="osd-meter-fill" data-osd-role="fill"></span></div>
        <div class="osd-sub" data-osd-role="sub"></div>
    </div>`;

let _refs = null;
let _pending = null;
let _rafId = 0;
let _fallbackTimer = null;
let _lastRevision = -1;

function langIsEn() {
    try {
        const i18n = (typeof globalThis !== 'undefined' && globalThis.AriaI18n) || null;
        return !!(i18n && typeof i18n.getLanguage === 'function' && i18n.getLanguage() === 'en-US');
    } catch (e) { logCatch('osdUi', e); return false; }
}

function text(entry) {
    return entry[langIsEn() ? 1 : 0];
}

/* 00:05 → 0:05、01:23 → 1:23（与底栏时间文本同一写法，>=10 分钟不动） */
function mmss(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    return formatTime(s * 1000).replace(/^0(?=\d)/, '');
}

function signed(sec) {
    return (sec < 0 ? '-' : '+') + mmss(Math.abs(sec));
}

function ratioToPercent(ratio) {
    const r = Number(ratio);
    if (!Number.isFinite(r)) return '0%';
    return (Math.max(0, Math.min(1, r)) * 100).toFixed(1) + '%';
}

function rateText(rate) {
    const r = Math.round((Number(rate) || 0) * 100) / 100;
    return String(r);
}

/* ---------- 快照 → 三段文本 + 刻度 ---------- */
function compose(snap) {
    const d = snap.data;
    if (!d) return null;
    if (snap.kind === OSD_KIND.VOLUME) {
        return { label: text(STR.volume), value: d.percent + '%', sub: '', ratio: d.ratio };
    }
    if (snap.kind === OSD_KIND.SEEK) {
        const pos = mmss(d.targetSec);
        return {
            label: text(d.deltaSec < 0 ? STR.seekBack : STR.seekFwd),
            value: signed(d.deltaSec),
            sub: d.hasDuration ? (pos + ' / ' + mmss(d.durationSec)) : pos,
            ratio: d.ratio,
        };
    }
    if (snap.kind === OSD_KIND.RATE) {
        const normal = Math.abs((Number(d.rate) || 0) - 1) < 0.005;
        return {
            label: text(STR.rate),
            value: normal ? text(STR.rateNormal) : (rateText(d.rate) + 'x'),
            sub: normal ? '' : (rateText(OSD_RATE_MIN) + 'x ~ ' + rateText(OSD_RATE_MAX) + 'x'),
            ratio: d.ratio,
        };
    }
    return null;
}

/* ---------- 挂载 ---------- */
function ensureRefs() {
    if (_refs && _refs.root.isConnected) return _refs;
    _refs = null;
    if (typeof document === 'undefined' || !document.body) return null;
    let root = document.getElementById('ariaOsd');
    if (!root) {
        root = document.createElement('div');
        root.id = 'ariaOsd';
        root.setAttribute('role', 'status');
        root.setAttribute('aria-live', 'polite');
        root.setAttribute('aria-atomic', 'true');
        document.body.appendChild(root);
    }
    /* 宿主要素可能来自 index.html（首帧就在，更快）也可能自建：两种都补齐骨架与类名 */
    root.className = 'aria-osd';
    if (!root.querySelector('[data-osd-role="card"]')) root.innerHTML = OSD_HTML;
    const pick = (role) => root.querySelector('[data-osd-role="' + role + '"]');
    _refs = {
        root,
        card: pick('card'),
        label: pick('label'),
        value: pick('value'),
        sub: pick('sub'),
        fill: pick('fill'),
    };
    return _refs;
}

/* 同一元素连续两次加同一 class 不会重播 keyframes，必须先摘掉并强制回流 */
function replayEnter(card) {
    if (!card || typeof card.classList === 'undefined') return;
    card.classList.remove('osd-enter');
    const _reflow = card.offsetWidth;
    card.classList.add('osd-enter');
}

function paint(snap) {
    const r = ensureRefs();
    if (!r) return;
    if (!snap || !snap.visible || !snap.kind) {
        r.root.classList.remove('osd-on');
        r.root.setAttribute('aria-hidden', 'true');
        return;
    }
    const c = compose(snap);
    if (!c) return;
    if (snap.revision !== _lastRevision) {
        r.label.textContent = c.label;
        r.value.textContent = c.value;
        r.sub.textContent = c.sub;
        r.fill.style.width = ratioToPercent(c.ratio);
        _lastRevision = snap.revision;
    }
    if (r.root.getAttribute('data-kind') !== snap.kind) r.root.setAttribute('data-kind', snap.kind);
    if (snap.entered) replayEnter(r.card);
    r.root.classList.add('osd-on');
    r.root.setAttribute('aria-hidden', 'false');
}

/* 按住不放时一帧内可能来好几个 keydown：rAF 合批，DOM 写入每帧至多一次。
   rAF 在后台页会被节流 → 再挂一个 64ms setTimeout 兜底，谁先到算谁。 */
function flush() {
    if (_rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(_rafId);
    _rafId = 0;
    if (_fallbackTimer !== null && typeof clearTimeout === 'function') clearTimeout(_fallbackTimer);
    _fallbackTimer = null;
    const snap = _pending;
    _pending = null;
    if (snap) paint(snap);
}

function schedule(snap) {
    _pending = snap;
    if (_rafId || _fallbackTimer !== null) return;
    if (typeof requestAnimationFrame === 'function') _rafId = requestAnimationFrame(flush);
    if (typeof setTimeout === 'function') _fallbackTimer = setTimeout(flush, 64);
    if (!_rafId && _fallbackTimer === null) flush();
}

onOsdChange((snap) => { schedule(snap); });

/* 语言切换：浮层正显示时原地改写成新语言（不重播入场动画） */
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('aria:languagechange', () => {
        try {
            const s = getOsdState();
            if (!s.visible) return;
            _lastRevision = -1;
            paint(s);
        } catch (e) { logCatch('osdUi', e); }
    });
}

/* 语义入口的 app 侧门面：分片只 import 本文件，不必知道 core 的函数名。
   浮层是「锦上添花」，任何意外都不该把调用方的快捷键流程带崩，所以整层兜底留痕。 */
export function osdShowVolume(percent) {
    try { return showVolume(percent); } catch (e) { logCatch('osdUi', e); return false; }
}
export function osdShowSeek(deltaMs, currentTimeSec, durationSec) {
    try { return showSeek(deltaMs, currentTimeSec, durationSec); } catch (e) { logCatch('osdUi', e); return false; }
}
export function osdShowRate(rate) {
    try { return showRate(rate); } catch (e) { logCatch('osdUi', e); return false; }
}
export { hideOsd };
