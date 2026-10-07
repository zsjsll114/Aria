/**
 * revealPath.js — 「打开文件所在位置」（桌面壳专用）
 *
 * 需求背景：海报生成 / 歌曲下载完成后，用户想直接跳到那个文件。
 * 这两条路径都走 `<a download>`，落盘在 WebView2 的默认下载目录里，
 * 网页层拿不到路径 —— 但**不需要动 Rust**：
 *   · `plugin:path|resolve_directory` → 拿到系统下载目录（`core:path:default` 已在 capability 里）
 *   · `plugin:opener|reveal_item_in_dir` → 资源管理器里选中它
 *     （`opener:default` 已包含 `allow-reveal-item-in-dir`，见 `gen/schemas/acl-manifests.json`）
 *
 * ★ 浏览器环境（无桌面壳）没有这两个插件，一律安静失败，由调用方决定降级文案。
 * ★ `reveal_item_in_dir` 内部会 `canonicalize`：路径不存在会直接报错，
 *   所以先试「文件全路径」，失败再退回「所在目录」——目录一定存在。
 */

import { call, UNAVAILABLE } from './nativeBridge.js';
import { translatePhrase } from './i18n.js';
import { logInfo, logCatch } from '../services/log.js';

const TAG = 'reveal';
const CALL_TIMEOUT = 4000;

/** 桌面壳里能不能干这事（浏览器版 / 插件被拒都返回 false）。 */
export async function canReveal() {
	try {
		const dir = await downloadsDir();
		return !!dir;
	} catch (e) {
		logCatch(TAG, e);
		return false;
	}
}

/** 系统下载目录（绝对路径）；拿不到返回 null。★ 结果缓存，整会话只问一次。 */
let _dirPromise = null;
export function downloadsDir() {
	if (_dirPromise) return _dirPromise;
	_dirPromise = (async () => {
		/* ★ 参数名各版本不完全一致（`path` / `directory`），两个都试一遍再放弃。 */
		for (const args of [{ path: 'downloadDir' }, { directory: 'downloadDir' }]) {
			try {
				const d = await call('plugin:path|resolve_directory', args, CALL_TIMEOUT);
				if (d && typeof d === 'string') return d;
			} catch (e) {
				if (e && e.message === UNAVAILABLE.NO_SHELL) return null;
				logCatch(TAG, e);
			}
		}
		return null;
	})();
	return _dirPromise;
}

/**
 * 在资源管理器里定位一个刚存下来的文件。
 * @param {string} fileName 只给文件名即可（拼到下载目录下）
 * @returns {Promise<boolean>} 是否真的拉起了一个窗口
 */
export async function revealInExplorer(fileName) {
	try {
		const dir = await downloadsDir();
		if (!dir) return false;
		const sep = dir.includes('\\') ? '\\' : '/';
		const base = dir.replace(/[\\/]+$/, '');
		const name = String(fileName || '').trim();
		const candidates = name ? [`${base}${sep}${name}`, base] : [base];
		for (const p of candidates) {
			try {
				await call('plugin:opener|reveal_item_in_dir', { path: p }, CALL_TIMEOUT);
				logInfo(TAG, '已定位:', p);
				return true;
			} catch (e) {
				logCatch(TAG, e);
			}
		}
		return false;
	} catch (e) {
		logCatch(TAG, e);
		return false;
	}
}

/**
 * 「存好了 → 顺手给一个打开所在位置的入口」。
 *
 * 有桌面壳才弹（浏览器版没有下载目录这个概念，弹了也点不动 → 返回 false，
 * 由调用方决定普通提示文案）。对话框用项目自带的毛玻璃 confirm，
 * 点「打开所在位置」才真的去拉起资源管理器 —— 不打扰只想接着听歌的人。
 *
 * @param {string} fileName 刚落盘的文件名
 * @param {{title?:string, desc?:string}} [opts]
 * @returns {Promise<boolean>} 是否弹出了对话框
 */
export async function offerReveal(fileName, opts = {}) {
	try {
		if (typeof window === 'undefined' || typeof window.showGlassConfirm !== 'function') return false;
		if (!(await canReveal())) return false;
		/* ★ 毛玻璃对话框**不自己翻译**文案（见 021-aria-dialog.js），
		   所以这里必须显式 translatePhrase —— 否则英文界面里会蹦出一句中文。 */
		const ok = await window.showGlassConfirm({
			title: translatePhrase(opts.title || '已保存'),
			desc: (opts.desc ? translatePhrase(opts.desc) + '\n' : '') + String(fileName || ''),
			okText: translatePhrase('打开所在位置'),
			cancelText: translatePhrase('知道了'),
		});
		if (ok) await revealInExplorer(fileName);
		return true;
	} catch (e) {
		logCatch(TAG, e);
		return false;
	}
}
