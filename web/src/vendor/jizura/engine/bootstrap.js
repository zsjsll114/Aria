/* ============================================================
 * bootstrap.js — JIZURA 引擎装配（唯一决定加载顺序的地方）
 *
 * ★ 顺序 = 上游 build.py 的 sorted(glob(src/*.js))，不能改。三处加载期副作用
 *   依赖它（方案 §5）：
 *   ① 08_planner.js 的 J.CORE_ORDER 是**加载期快照**，必须在所有 pack 注册之前；
 *   ② 11q_sets.js 遍历全部 group/order 打 extra/wa/set 标记，必须在所有 pack 之后；
 *   ③ 08b_omakase.js 给核心 def 追加 mood tags，依赖 06/05/07 已注册。
 * ★ 引擎实例必须**进程内单例**：② ③ 是"只跑一次"的副作用，重复实例化会让
 *   部件集/随机候选漂移。
 * ============================================================ */
import { createJizuraRoot } from './01_util.js';
import i02_fonts from './02_fonts.js';
import i02b_lang from './02b_lang.js';
import i03_text from './03_text.js';
import i04_styles from './04_styles.js';
import i05_anim from './05_anim.js';
import i05b_registry from './05b_registry.js';
import i06_layouts from './06_layouts.js';
import i07_decor from './07_decor.js';
import i08_planner from './08_planner.js';
import i08b_omakase from './08b_omakase.js';
import i09_render from './09_render.js';
import i10_audio from './10_audio.js';
import i11_export from './11_export.js';
import i11p_bgcamB from './11p_bgcamB.js';
import i11p_decor from './11p_decor.js';
import i11p_decorB from './11p_decorB.js';
import i11p_enter from './11p_enter.js';
import i11p_enterB from './11p_enterB.js';
import i11p_exit from './11p_exit.js';
import i11p_exitB from './11p_exitB.js';
import i11p_fxB from './11p_fxB.js';
import i11p_horror1 from './11p_horror1.js';
import i11p_horror2 from './11p_horror2.js';
import i11p_horror3 from './11p_horror3.js';
import i11p_kinetic1 from './11p_kinetic1.js';
import i11p_kinetic2 from './11p_kinetic2.js';
import i11p_kinetic3 from './11p_kinetic3.js';
import i11p_layoutsA from './11p_layoutsA.js';
import i11p_layoutsB from './11p_layoutsB.js';
import i11p_layoutsC from './11p_layoutsC.js';
import i11p_layoutsD from './11p_layoutsD.js';
import i11p_looks from './11p_looks.js';
import i11p_styles from './11p_styles.js';
import i11p_treattrans from './11p_treattrans.js';
import i11p_typo1 from './11p_typo1.js';
import i11p_typo2 from './11p_typo2.js';
import i11p_typo3 from './11p_typo3.js';
import i11q_sets from './11q_sets.js';

export const JIZURA_ENGINE_VERSION = '0.10.1-port';

/** 建一个 JIZURA 引擎（拿到 J 即可 J.plan / new J.Renderer() / J.omakase …） */
export function createJizuraEngine() {
    const J = createJizuraRoot();
    i02_fonts(J);
    i02b_lang(J);
    i03_text(J);
    i04_styles(J);
    i05_anim(J);
    i05b_registry(J);
    i06_layouts(J);
    i07_decor(J);
    i08_planner(J);
    i08b_omakase(J);
    i09_render(J);
    i10_audio(J);
    i11_export(J);
    i11p_bgcamB(J);
    i11p_decor(J);
    i11p_decorB(J);
    i11p_enter(J);
    i11p_enterB(J);
    i11p_exit(J);
    i11p_exitB(J);
    i11p_fxB(J);
    i11p_horror1(J);
    i11p_horror2(J);
    i11p_horror3(J);
    i11p_kinetic1(J);
    i11p_kinetic2(J);
    i11p_kinetic3(J);
    i11p_layoutsA(J);
    i11p_layoutsB(J);
    i11p_layoutsC(J);
    i11p_layoutsD(J);
    i11p_looks(J);
    i11p_styles(J);
    i11p_treattrans(J);
    i11p_typo1(J);
    i11p_typo2(J);
    i11p_typo3(J);
    i11q_sets(J);
    return J;
}
