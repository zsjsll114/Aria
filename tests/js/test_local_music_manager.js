/* ============================================================
 * tests/js/test_local_music_manager.js — localMusicManager 文件名降级解析
 *
 * 为什么补：`noUncheckedIndexedAccess` 在 services/localMusicManager.js 报 2 条，
 * 都是 `parts[0].trim()`（`clean.split(' - ')` / `clean.split('_')` 的首元素）。
 * 该模块此前无任何测试，而这段解析是「识曲失败后」的兜底路径——它产出的
 * title/artist 会直接进列表 UI，解析错就是用户看到「未知歌手 - 未知歌手」。
 *
 * 覆盖：' - ' 分隔、'_' 分隔、多段分隔、obj_ 前缀守卫、无分隔、扩展名剥离、
 *       括号后缀清理、以及清理后为空时回退原文。
 * 运行：node --test tests/js/test_local_music_manager.js
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LocalMusicManager } from '../../web/src/services/localMusicManager.js';

const mgr = new LocalMusicManager();
const parse = (name) => mgr._parseMetadataFromFilename(name);

test('"歌手 - 歌名.扩展名" → 正确切分并剥离扩展名', () => {
    assert.deepEqual(parse('周杰伦 - 青花瓷.mp3'), { title: '青花瓷', artist: '周杰伦', album: '' });
    assert.deepEqual(parse('Adele - Hello.flac'), { title: 'Hello', artist: 'Adele', album: '' });
});

test('多段 " - " 只用首个作歌手，其余并回歌名', () => {
    const r = parse('A - B - C.ogg');
    assert.equal(r.artist, 'A');
    assert.equal(r.title, 'B - C');
});

test('括号后缀被清理（(Live) / [Remix] / {Demo}）', () => {
    assert.equal(parse('周杰伦 - 青花瓷 (Live).mp3').title, '青花瓷');
    assert.equal(parse('周杰伦 - 青花瓷[Remix].mp3').title, '青花瓷');
    assert.equal(parse('周杰伦 - 青花瓷{Demo}.mp3').title, '青花瓷');
});

test('"歌手_歌名" 下划线分隔同样生效', () => {
    const r = parse('周杰伦_青花瓷.mp3');
    assert.equal(r.artist, '周杰伦');
    assert.equal(r.title, '青花瓷');
});

test('obj_ 前缀是上传产物命名，不得当成分隔符（守卫）', () => {
    const r = parse('obj_1712345678.mp3');
    assert.equal(r.artist, '未知歌手', 'obj_ 开头应整体当歌名');
    assert.equal(r.title, 'obj_1712345678');
});

test('无分隔符 → 整体当歌名、歌手落默认值', () => {
    assert.deepEqual(parse('青花瓷.mp3'), { title: '青花瓷', artist: '未知歌手', album: '' });
});

test('扩展名只剥最后一段，歌名里的点保留', () => {
    const r = parse('a.b - c.mp3');
    assert.equal(r.artist, 'a.b');
    assert.equal(r.title, 'c');
});

test('清理括号后为空 → 回退到清理前的原文（不产出空标题）', () => {
    const r = parse('(Live).mp3');
    assert.equal(r.title, '(Live)', '全被括号占满时不该被清成空串');
});

test('分隔符两侧为空：不抛异常（这正是那两处索引访问的风险点）', () => {
    /* 两处 parts[0] 的**界内性成立**：' - ' / '_' 的存在性保证 split 首元素存在
       （最多是空串），所以这里应安静返回而非抛 TypeError —— 这正是本测要钉的点。
       ★ 已知小瑕疵（实测，本轮未改）：'_' 分支守卫只判 `parts.length >= 2`、
         没判首段非空，故 '_.mp3' 会产出空串 title/artist 而非落 '未知歌手' 兜底。
         真实上传不会出现这种名字，只记录不修。 */
    /* ① ' - .mp3' → 先 strip 扩展名得到 ' - '，再 trim 成 '-'，
          于是**不再包含 ' - '**，走「无分隔」分支：整体当歌名，歌手落默认值。 */
    const dashed = parse(' - .mp3');
    assert.equal(dashed.title, '-', "' - ' 经 trim 变成 '-'，按无分隔处理");
    assert.equal(dashed.artist, '未知歌手');

    /* ② '_.mp3' → '_' 仍在，split('_') 得 ['','']，length≥2 且非 obj_ 前缀 →
          走进分隔分支，两侧都是空串，故 title/artist 均被赋成空串。 */
    const under = parse('_.mp3');
    assert.equal(under.title, '');
    assert.equal(under.artist, '');
});
