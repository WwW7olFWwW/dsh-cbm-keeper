/**
 * cbm.js 的解析器測試（FR-2／FR-11／FR-15）。
 *
 * 這些字串不是憑空發明的：`projects: 2 …` 的兩列、`indexed_at`、
 * `parse_partial: 29`、`not_indexed: 2043`、`nodes/edges = 128530/154752` 都取自
 * docs/REQUIREMENTS.md 對 sample-repo 的實測記錄（P5／P9／P16／FR-11）。解析器是
 * 整個插件最脆弱的一環，所以每個欄位都逐值斷言。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConfigList,
  parseGraphHead,
  parseIndexStatus,
  parseKeyValueTree,
  parseListProjects,
  parseTable,
  splitTableRow,
} from '../lib/cbm.js';

/**
 * 組出 `list_projects` 的文字表（CBM 0.11.0 的欄位順序）。
 * @param {string[][]} rows - 欄位值。
 * @returns {string} 表文字。
 */
function projectTable(rows) {
  const lines = ['projects: ' + String(rows.length) + '  (cols: name root_path branch)'];
  for (const row of rows) lines.push('  ' + row.join('  '));
  return lines.join('\n');
}

/**
 * 組出 `index_status` 的內文（含縮排子區段）。
 * @param {object} input - 欄位。
 * @returns {string} 內文。
 */
function indexStatusText(input) {
  return [
    'project: ' + input.project,
    'root_path: ' + input.rootPath,
    'status: indexed',
    'nodes: ' + String(input.nodes),
    'edges: ' + String(input.edges),
    'indexed_at: ' + input.indexedAt,
    'parse_partial:',
    '  count: ' + String(input.parsePartialCount),
    'parse_unusable:',
    '  count: ' + String(input.parseUnusableCount ?? 0),
    'skipped:',
    '  count: ' + String(input.skippedCount ?? 0),
    'not_indexed:',
    '  files_count: ' + String(input.notIndexedFilesCount),
    '  dirs_count: ' + String(input.notIndexedDirsCount ?? 0),
  ].join('\n');
}

test('parseListProjects 逐值解析 sample-repo 與 hyper 兩列', function () {
  const text = projectTable([
    ['sample-repo', '/home/user/sample-repo', 'main'],
    ['hyper', '/home/user/hyper', 'master'],
  ]);
  assert.deepEqual(parseListProjects(text), [
    { name: 'sample-repo', rootPath: '/home/user/sample-repo', branch: 'main' },
    { name: 'hyper', rootPath: '/home/user/hyper', branch: 'master' },
  ]);
});

test('parseListProjects 支援 root_path 內含空白（欄位切分啟發式）', function () {
  // 中間欄含空白時啟發式是精確的：首欄吃第一個 token、末欄吃最後一個，
  // 其餘中間 token 全部歸 root_path。
  const text = projectTable([
    ['repo', '/home/user/my project', 'main'],
  ]);
  assert.deepEqual(parseListProjects(text), [
    { name: 'repo', rootPath: '/home/user/my project', branch: 'main' },
  ]);
  // 根部含多個空白詞時同樣要完整保留。
  const wide = projectTable([['repo', '/srv/my big repo', 'dev']]);
  assert.deepEqual(parseListProjects(wide), [
    { name: 'repo', rootPath: '/srv/my big repo', branch: 'dev' },
  ]);
});

test('parseListProjects：name 內含空白時以絕對路徑為錨點切分', function () {
  const text = projectTable([['my project', '/srv/my repo', 'main']]);
  assert.deepEqual(parseListProjects(text), [
    { name: 'my project', rootPath: '/srv/my repo', branch: 'main' },
  ]);
  // 三個空白詞的名字也要整段歸 name，不能只留第一個 token。
  const longer = projectTable([['my big project', '/srv/repo', 'dev']]);
  assert.deepEqual(parseListProjects(longer), [
    { name: 'my big project', rootPath: '/srv/repo', branch: 'dev' },
  ]);
});

test('parseListProjects：projects: 0 回空陣列而不是壞掉', function () {
  assert.deepEqual(parseListProjects('projects: 0  (cols: name root_path branch)'), []);
  assert.deepEqual(parseListProjects(''), []);
  assert.deepEqual(parseListProjects(undefined), []);
});

test('parseListProjects：表名不是 projects 時回空陣列', function () {
  assert.deepEqual(parseListProjects('branches: 1  (cols: name)\n  main'), []);
  // 只有一欄的表：root_path 取不到 → 不猜，回空。
  assert.deepEqual(parseListProjects('projects: 1  (cols: name)\n  lonely'), []);
});

test('parseListProjects：name 欄為空的列被略過，其餘保留', function () {
  const text = projectTable([['', '/srv/anon', 'main'], ['kept', '/srv/kept', 'main']]);
  assert.deepEqual(parseListProjects(text), [
    { name: 'kept', rootPath: '/srv/kept', branch: 'main' },
  ]);
});

test('parseListProjects：root_path 不是絕對路徑的列被略過', function () {
  // 空 name 會讓欄位左移，rootPath 於是接到 'main' 這種非路徑值；以「必須是
  // 絕對路徑」把這種列擋掉，才不會把垃圾當成專案上報。
  const shifted = projectTable([['', '/srv/anon', 'main']]);
  assert.deepEqual(parseListProjects(shifted), []);
  const relative = projectTable([['x', 'not/a/path', 'main']]);
  assert.deepEqual(parseListProjects(relative), []);
  // 合法的絕對路徑仍然照收。
  const mixed = projectTable([['', 'oops', 'main'], ['kept', '/srv/kept', 'main']]);
  assert.deepEqual(parseListProjects(mixed), [
    { name: 'kept', rootPath: '/srv/kept', branch: 'main' },
  ]);
});

test('parseTable 取出表名、計數與欄名', function () {
  const table = parseTable(projectTable([['a', '/a', 'main']]));
  assert.equal(table.name, 'projects');
  assert.equal(table.count, 1);
  assert.deepEqual(table.cols, ['name', 'root_path', 'branch']);
  assert.deepEqual(table.rows, [['a', '/a', 'main']]);

  const empty = parseTable('projects: 0  (cols: name root_path branch)');
  assert.equal(empty.count, 0);
  assert.deepEqual(empty.rows, []);
});

test('parseIndexStatus 逐值解析 sample-repo 的實測數字（FR-11）', function () {
  const status = parseIndexStatus(indexStatusText({
    project: 'sample-repo',
    rootPath: '/home/user/sample-repo',
    nodes: 128530,
    edges: 154752,
    indexedAt: '2026-10-03T20:29:29Z',
    parsePartialCount: 29,
    notIndexedFilesCount: 2043,
    notIndexedDirsCount: 12,
  }));
  assert.equal(status.project, 'sample-repo');
  assert.equal(status.rootPath, '/home/user/sample-repo');
  assert.equal(status.status, 'indexed');
  assert.equal(status.nodes, 128530);
  assert.equal(status.edges, 154752);
  assert.equal(status.indexedAt, '2026-10-03T20:29:29Z');
  assert.equal(status.parsePartialCount, 29);
  assert.equal(status.parseUnusableCount, 0);
  assert.equal(status.notIndexedFilesCount, 2043);
  assert.equal(status.notIndexedDirsCount, 12);
});

test('parseIndexStatus 容忍千分位逗號與缺欄位', function () {
  const withCommas = parseIndexStatus([
    'project: p',
    'nodes: 128,530',
    'edges: 154_752',
    'parse_partial:',
    '  count: 29',
  ].join('\n'));
  assert.equal(withCommas.nodes, 128530);
  assert.equal(withCommas.edges, 154752);
  assert.equal(withCommas.parsePartialCount, 29);
  // 缺欄位一律 undefined，不得變成 0 或 NaN。
  assert.equal(withCommas.indexedAt, undefined);
  assert.equal(withCommas.notIndexedFilesCount, undefined);
  assert.equal(parseIndexStatus('').nodes, undefined);
});

test('parseGraphHead：單列表與零列表', function () {
  assert.equal(parseGraphHead('head: 1  (cols: head)\n  3449ba2'), '3449ba2');
  assert.equal(parseGraphHead('head: 0  (cols: head)'), undefined);
  // 零列表但內文別處有 sha：表格路徑找不到時才會走寬鬆掃描，這裡不該誤判。
  assert.equal(parseGraphHead('head: 0  (cols: head)\n  (no rows)'), undefined);
  assert.equal(parseGraphHead(''), undefined);
  assert.equal(parseGraphHead(undefined), undefined);
  // 沒有表頭的回應格式：縮排的十六進位字串是最後手段。
  assert.equal(parseGraphHead('result:\n  96cd57b\n'), '96cd57b');
  // 非 sha 的縮排內容不得被當成 HEAD。
  assert.equal(parseGraphHead('result:\n  not-a-sha\n'), undefined);
});

test('parseKeyValueTree：純量與縮排子區段分流', function () {
  const tree = parseKeyValueTree([
    'nodes: 10',
    'parse_partial:',
    '  count: 3',
    '  files: a.css',
    'edges: 20',
  ].join('\n'));
  assert.deepEqual(tree.values, { nodes: '10', edges: '20' });
  assert.deepEqual(tree.sections, { parse_partial: { count: '3', files: 'a.css' } });
  // 沒有縮排的鍵不屬於任何子區段：縮排子行會被丟棄（不猜它的父節點）。
  const flat = parseKeyValueTree('a: 1\n  b: 2\nc: 3');
  assert.deepEqual(flat.values, { a: '1', c: '3' });
  assert.deepEqual(flat.sections, {});
});

test('parseConfigList 解析 key = value 文字輸出', function () {
  const parsed = parseConfigList([
    'auto_index = false',
    'auto_watch = true',
    '  ui_port = 9749  ',
    'not a pair',
    '# comment = ignored?',
  ].join('\n'));
  assert.deepEqual(parsed, { auto_index: 'false', auto_watch: 'true', ui_port: '9749' });
  assert.deepEqual(parseConfigList(''), {});
});

test('splitTableRow：單欄、等量、不足與超過的切法', function () {
  assert.deepEqual(splitTableRow('whole line stays', 1), ['whole line stays']);
  assert.deepEqual(splitTableRow('a b c', 3), ['a', 'b', 'c']);
  assert.deepEqual(splitTableRow('a b', 3), ['a', 'b', '']);
  assert.deepEqual(splitTableRow('a', 2), ['a', '']);
  // 超出欄數時：首欄吃第一個 token、末欄吃最後一個 token，其餘全歸第二欄。
  assert.deepEqual(splitTableRow('name /srv/my repo main', 3), ['name', '/srv/my repo', 'main']);
  assert.deepEqual(splitTableRow('a b c d', 2), ['a', 'b c d']);
  assert.deepEqual(splitTableRow('a b c d', 3), ['a', 'b c', 'd']);
  // 多餘空白不影響切分。
  assert.deepEqual(splitTableRow('  a   b   c  ', 3), ['a', 'b', 'c']);
});
