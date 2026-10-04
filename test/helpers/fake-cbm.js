/**
 * 假 CBM CLI（NFR-7）。
 *
 * 「不 spawn 真的 codebase-memory-mcp」的做法是：產生一支 **Node 腳本**當作
 * 執行檔，讓 lib 用真的 spawn 去跑它。這樣 keeper.js 完全不必為了測試而改造，
 * 但它跑到的仍然是假的 CLI——只是輸出格式照著 CBM 0.11.0 實測結果寫。
 *
 * 腳本讀同一目錄的 cbm-state.json（專案清單與各自的 graph head），並把
 * index_repository 的呼叫追加到 calls.ndjson，測試據此斷言「排了幾次、用什麼
 * 名字與模式」。
 */

import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 假 CLI 的原始碼。
 *
 * 用法：`fake-cbm.mjs cli --quiet --json <tool> [--flag value]`，另有 `--version`
 * 與 `config list` 兩個非工具子命令。檔頭帶 shebang，因此 lib 可以直接 spawn
 * 這個路徑（不必經由 node）。
 *
 * @returns {string} 可直接寫成檔案的 ESM 原始碼。
 */
function fakeCbmSource() {
  return [
    '#!/usr/bin/env node',
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    '',
    "const here = dirname(fileURLToPath(import.meta.url));",
    "const stateFile = join(here, 'cbm-state.json');",
    "const callsFile = join(here, 'calls.ndjson');",
    '',
    'function readState() {',
    '  try {',
    "    return JSON.parse(readFileSync(stateFile, 'utf8'));",
    '  } catch {',
    "    return { projects: [], sha: {}, config: {} };",
    '  }',
    '}',
    '',
    '/** 依序讀取多個 --flag 的值。',
    ' * @param {string[]} argv - 參數列。',
    ' * @param {string} flag - 旗標名。',
    ' * @returns {string|undefined} 第一個值。',
    ' */',
    'function flagValue(argv, flag) {',
    '  const at = argv.indexOf(flag);',
    '  return at >= 0 ? argv[at + 1] : undefined;',
    '}',
    '',
    '/** 送出一份 MCP 信封。',
    ' * @param {object} payload - 內文物件。',
    ' * @param {boolean} isError - 是否為錯誤。',
    ' * @returns {void}',
    ' */',
    'function envelope(payload, isError) {',
    "  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);",
    "  process.stdout.write(JSON.stringify({ content: [{ type: 'text', text }], isError: isError === true }) + '\\n');",
    '}',
    '',
    '/** 產生 CBM 的空白對齊文字表。',
    ' * @param {string} name - 表名。',
    ' * @param {string[]} cols - 欄名。',
    ' * @param {string[][]} rows - 資料列。',
    ' * @returns {string} 表文字。',
    ' */',
    'function table(name, cols, rows) {',
    "  const lines = [name + ': ' + String(rows.length) + '  (cols: ' + cols.join(' ') + ')'];",
    '  for (const row of rows) lines.push("  " + row.join("  "));',
    "  return lines.join('\\n');",
    '}',
    '',
    'const argv = process.argv.slice(2);',
    '',
    "if (argv.includes('--version') && argv[0] === '--version') {",
    '  const versionState = readState();',
    "  process.stdout.write('codebase-memory-mcp ' + String(versionState.version ?? '0.11.0') + '\\n');",
    '  process.exit(0);',
    '}',
    '',
    "if (argv[0] === 'config') {",
    '  const state = readState();',
    "  if (state.configFail === true) { process.stderr.write('config unavailable\\n'); process.exit(3); }",
    '  const keys = Object.keys(state.config ?? {});',
    "  const lines = keys.map(function (key) { return key + ' = ' + state.config[key]; });",
    "  process.stdout.write(lines.join('\\n') + (lines.length > 0 ? '\\n' : ''));",
    '  process.exit(0);',
    '}',
    '',
    'const state = readState();',
    'const tool = argv[argv.indexOf(\'--quiet\') + 2];',
    '',
    'if (tool === \'list_projects\') {',
    "  if (state.listFail === true) { envelope({ error: 'upstream list broken' }, true); process.exit(1); }",
    '  if (state.emptyList === true) {',
    "    process.stdout.write('projects: 0  (cols: name root_path branch)\\n');",
    '    process.exit(0);',
    '  }',
    '  const rows = (state.projects ?? []).map(function (project) {',
    '    return [project.name, project.rootPath, project.branch];',
    '  });',
    "  envelope(table('projects', ['name', 'root_path', 'branch'], rows), false);",
    '  process.exit(0);',
    '}',
    '',
    "if (tool === 'index_status') {",
    "  const name = flagValue(argv, '--project');",
    '  const project = (state.projects ?? []).find(function (entry) { return entry.name === name; });',
    '  if (project === undefined) {',
    "    envelope({ error: 'project not found or not indexed', hint: 'run list_projects first' }, true);",
    '    process.exit(1);',
    '  }',
    "  const lines = ['project: ' + project.name, 'root_path: ' + project.rootPath, 'status: indexed'];",
    "  lines.push('nodes: ' + String(state.nodes ?? 0));",
    "  lines.push('edges: ' + String(state.edges ?? 0));",
    "  lines.push('indexed_at: ' + String(project.indexedAt ?? ''));",
    "  lines.push('parse_partial: ' + String(state.parsePartialCount ?? 0) + ' files');",
    "  lines.push('not_indexed: ' + String(state.notIndexedFilesCount ?? 0) + ' files');",
    "  envelope(lines.join('\\n'), false);",
    '  process.exit(0);',
    '}',
    '',
    "if (tool === 'query_graph') {",
    "  const name = flagValue(argv, '--project');",
    '  const project = (state.projects ?? []).find(function (entry) { return entry.name === name; });',
    '  const head = project === undefined ? undefined : project.graphHead;',
    '  if (head === undefined) {',
    "    process.stdout.write('head: 0  (cols: head)\\n');",
    '    process.exit(0);',
    '  }',
    "  envelope(table('head', ['head'], [[head]]), false);",
    '  process.exit(0);',
    '}',
    '',
    "if (tool === 'index_repository') {",
    "  const rootPath = flagValue(argv, '--repo-path');",
    "  const mode = flagValue(argv, '--mode');",
    "  const name = flagValue(argv, '--name');",
    '  const startedAt = Date.now();',
    '  if (Number.isFinite(state.delayMs) && state.delayMs > 0) {',
    '    const until = Date.now() + state.delayMs;',
    '    while (Date.now() < until) { /* 忙等：模擬長時間索引，讓併發計數觀測得到。 */ }',
    '  }',
    "  writeFileSync(callsFile, JSON.stringify({ tool: tool, rootPath: rootPath, mode: mode, name: name, durationMs: Date.now() - startedAt }) + '\\n', { flag: 'a' });",
    '  for (const project of state.projects ?? []) {',
    '    if (project.rootPath === rootPath) {',
    '      project.graphHead = state.sha[rootPath];',
    "      project.indexedAt = new Date().toISOString();",
    '    }',
    '  }',
    "  writeFileSync(stateFile, JSON.stringify(state), 'utf8');",
    "  envelope({ indexed: true, project: name, mode: mode }, false);",
    '  process.exit(0);',
    '}',
    '',
    "process.stderr.write('unknown tool: ' + String(tool) + '\\n');",
    'process.exit(2);',
    '',
  ].join('\n');
}

/**
 * 在暫存目錄內安裝假 CLI 與它的狀態檔。
 *
 * @param {string} dir - 暫存目錄。
 * @param {object} state - 假 CLI 狀態（projects／sha／nodes／edges／…）。
 * @returns {Promise<{path: string, stateFile: string, callsFile: string, state: object}>} 執行檔路徑與檔案位置。
 */
export async function installFakeCbm(dir, state) {
  const path = join(dir, 'fake-cbm.mjs');
  const stateFile = join(dir, 'cbm-state.json');
  const callsFile = join(dir, 'calls.ndjson');
  await writeFile(path, fakeCbmSource(), 'utf8');
  // 0700：lib 對它做的是「直接 spawn 執行檔」，不是「用 node 跑腳本」。
  await chmod(path, 0o700);
  await writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8');
  await writeFile(callsFile, '', 'utf8');
  return { path, stateFile, callsFile, state };
}

/**
 * 建立一筆假 CBM 專案。
 * @param {object} input - 欄位。
 * @param {string} input.name - 專案名。
 * @param {string} input.rootPath - repo 根路徑。
 * @param {string} [input.branch] - 分支。
 * @param {string} [input.graphHead] - 圖譜內的 HEAD。
 * @param {string} [input.indexedAt] - 索引時間。
 * @returns {object} 專案物件。
 */
export function fakeProject(input) {
  return {
    name: input.name,
    rootPath: input.rootPath,
    branch: input.branch ?? 'main',
    graphHead: input.graphHead,
    indexedAt: input.indexedAt ?? '2026-10-03T20:29:29Z',
  };
}

/** 一組語法合法、彼此可區辨的假 sha（7–40 位十六進位）。 */
export const FAKE_SHAS = {
  graphOld: '3449ba2',
  liveNew: '96cd57b',
  secondGraph: 'a1b2c3d',
  secondLive: 'e4f5a6b',
};
