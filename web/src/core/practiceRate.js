/**
 * practiceRate.js — 「练习模式变速」的纯逻辑（需求 15）
 *
 * ★ 为什么单独一个文件：项目里纯决策逻辑一律放 `core/`（先例：`core/scatterPick.js`、
 *   `core/hearingGuard.js`），这样能在 node 里直接单测，不必拉起 DOM + 音频分片。
 *   DOM/播放链那半边留在 `app/85-rate-download.js`。
 *
 * 设计要点：
 *  ① **量程 0.5×~2.0×、步进 0.05**（40 档）。比"0.5/0.75/1/1.25/1.5/2"那套预设细得多，
 *     跟练难点时才够用。
 *  ② **必须落回 0.05 网格且不带浮点尾巴**：滑杆值来自 `input[type=range]`，
 *     但菜单预设（1.25 之类）也会写回来。带尾巴的数值会让 nativeDeck 的快照键
 *     （`toFixed(4)`）每轮询都判成"变了"，变成 20Hz 的 IPC 风暴。
 *  ③ **练习模式保音高**（2026-10-06 改，原为"强制关"）：Web 路径走浏览器原生
 *     time-stretch，慢放到 0.5× 也不变调 —— 这是练习模式的意义所在。
 *     独占路径（Rust 线性重采样）**仍会变调**，由 app/85 明确提示用户，
 *     而不是让整个功能为了迁就那条路径而一起牺牲。
 */

export const PRACTICE_MIN = 0.5;
export const PRACTICE_MAX = 2.0;
export const PRACTICE_STEP = 0.05;

/**
 * 夹到量程内并对齐到 0.05 的网格；非法输入回落 1（原速）。
 * @param {unknown} r
 * @returns {number}
 */
export function clampPracticeRate(r) {
	/* ★ 只接受数字与数字字符串（滑杆读出来是字符串）。
	   `null` / `{}` / `true` 这类"配置里没有 / 写坏了"的值必须回落 **1×（原速）**——
	   直接 `Number(r)` 会把 `null` 变成 0，再被"合理地"夹到 0.5×，
	   等于把「配置缺失」悄悄变成「慢放一半」，是最坏的一种失败方式。 */
	if (typeof r !== 'number' && typeof r !== 'string') return 1;
	if (typeof r === 'string' && r.trim() === '') return 1;
	const n = Number(r);
	if (!Number.isFinite(n)) return 1;
	const stepped = Math.round(n / PRACTICE_STEP) * PRACTICE_STEP;
	const clamped = Math.min(PRACTICE_MAX, Math.max(PRACTICE_MIN, stepped));
	return Number(clamped.toFixed(2));
}

/**
 * 练习模式 → 播放链该落什么。**这是全部决策逻辑**，不碰 DOM、不碰元素。
 * @param {boolean} on             练习模式是否开启
 * @param {number} rate            练习速度（仅 on 时有效）
 * @param {boolean} [userPreservesPitch] 用户自己的"保持音高"设置（退出练习模式时还原）
 * @returns {{rate:number, preservesPitch:boolean}}
 */
export function practicePlanFor(on, rate, userPreservesPitch = true) {
	/* ★★ 2026-10-06 改口径：练习模式**不再强制关掉保音高**。
	   用户实测报「练习变速不支持变速不变调」——原来的实现是故意 `preservesPitch:false`，
	   理由写在文件头③：为了与 Rust 独占路径的线性重采样听感一致。
	   但那是**为了迁就实现而牺牲功能本身**：练习模式（跟弹 / 跟唱 / 抠难点）最不能忍的
	   恰恰是变调，慢放一半音低八度就没法跟着弹了。现在：
	     · Web 路径（浏览器原生 time-stretch）→ 保音高，由用户的 preservesPitch 设置决定；
	     · 独占路径（Rust 线性重采样）→ 仍然会变调，由 app/85 提示用户（见那里的注释）。 */
	/* 退出练习模式回 1×：它是"把速度钉住"的模式（需求原文的「固定开关」），
	   留着 0.8× 却显示已关闭只会让人困惑。 */
	const planRate = on ? clampPracticeRate(rate) : 1;
	return { rate: planRate, preservesPitch: userPreservesPitch !== false };
}

/** 把 0.05 网格上的值格式化成滑杆标签（固定两位小数）。 */
export function formatPracticeRate(rate) {
	return `${clampPracticeRate(rate).toFixed(2)}×`;
}
