/**
 * cli.js 的測試（FR-5 的解析順序、FR-10 的具名失敗、信封解析）。
 *
 * 解析器探針以注入的 `isExecutable` 取代真實檔案系統權限檢查；最後一組測試才
 * 真的 spawn 一支自己的假 CLI（不是 codebase-memory-mcp），驗證信封端到端。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeTempDir } from './helpers/env.js';
import { installFakeCbm } from './helpers/fake-cbm.js';
import { CliNotFoundError, parseJsonEnvelope, readCliVersion, resolveCliPath, runCbmTool } from '../lib/cli.js';

/**
 * 造一個只認得特定路徑的探針。
 * @param {string[]} executable - 視為可執行的路徑清單。
 * @returns {{probe: (candidate: string) => Promise<boolean>, seen: string[]}} 探針與呼叫記錄。
 */
function makeProbe(executable) {
  const seen = [];
  return {
    seen,
    probe: async function (candidate) {
      seen.push(candidate);
      return executable.includes(candidate);
    },
  };
}

test('resolveCliPath：明確設定優先於 CBM_BIN、PATH 與常見路徑', async function () {
  const made = makeProbe(['/opt/explicit/cbm', '/opt/env/cbm', '/env/bin/codebase-memory-mcp', '/home/u/.local/bin/codebase-memory-mcp']);
  const resolved = await resolveCliPath({
    explicit: '/opt/explicit/cbm',
    env: { CBM_BIN: '/opt/env/cbm', PATH: '/env/bin' },
    home: '/home/u',
    isExecutable: made.probe,
  });
  assert.deepEqual(resolved, { path: '/opt/explicit/cbm', source: 'config' });
  assert.deepEqual(made.seen, ['/opt/explicit/cbm'], '命中第一層就不該再往下試');
});

test('resolveCliPath：CBM_BIN 優先於 PATH 與常見路徑', async function () {
  const made = makeProbe(['/opt/env/cbm', '/env/bin/codebase-memory-mcp']);
  const resolved = await resolveCliPath({
    env: { CBM_BIN: '/opt/env/cbm', PATH: '/env/bin' },
    home: '/home/u',
    isExecutable: made.probe,
  });
  assert.deepEqual(resolved, { path: '/opt/env/cbm', source: 'env:CBM_BIN' });
  // 設定值這一層沒通過時仍要留下嘗試痕跡（可觀測性）。
  assert.equal(made.seen[0], '/opt/env/cbm');
});

test('resolveCliPath：PATH 命中時來源標為 PATH', async function () {
  const made = makeProbe(['/env/bin/codebase-memory-mcp']);
  const resolved = await resolveCliPath({
    env: { PATH: '/env/bin' },
    home: '/home/u',
    isExecutable: made.probe,
  });
  assert.deepEqual(resolved, { path: '/env/bin/codebase-memory-mcp', source: 'PATH' });
});

test('resolveCliPath：PATH 落空後才試平台常見路徑', async function () {
  const made = makeProbe(['/home/u/.local/bin/codebase-memory-mcp']);
  const resolved = await resolveCliPath({
    env: { PATH: '/env/bin' },
    home: '/home/u',
    isExecutable: made.probe,
  });
  assert.deepEqual(resolved, { path: '/home/u/.local/bin/codebase-memory-mcp', source: 'common-path' });
  assert.equal(made.seen.includes('/env/bin/codebase-memory-mcp'), true, 'PATH 要被試過');
});

test('resolveCliPath：全部落空時拋 CliNotFoundError 並帶完整候選清單', async function () {
  const made = makeProbe([]);
  let thrown;
  try {
    await resolveCliPath({
      explicit: '/opt/explicit/cbm',
      env: { CBM_BIN: '/opt/env/cbm', PATH: '/env/bin:/env/bin2' },
      home: '/home/u',
      isExecutable: made.probe,
    });
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown instanceof CliNotFoundError, true);
  assert.equal(thrown.name, 'CliNotFoundError');
  assert.equal(Array.isArray(thrown.candidates), true);
  assert.equal(thrown.candidates.length > 0, true, '候選清單不得為空');
  assert.equal(thrown.candidates.includes('/opt/explicit/cbm'), true);
  assert.equal(thrown.candidates.includes('/opt/env/cbm'), true);
  assert.equal(thrown.candidates.includes(join('/env/bin', 'codebase-memory-mcp')), true, 'PATH 目錄也要進候選');
  assert.equal(thrown.candidates.includes('/home/u/.local/bin/codebase-memory-mcp'), true, '常見路徑也要進候選');
  assert.match(thrown.message, /codebase-memory-mcp/);
});

test('resolveCliPath：空白設定值與空白 CBM_BIN 視同未設定', async function () {
  const made = makeProbe(['/env/bin/codebase-memory-mcp']);
  const resolved = await resolveCliPath({
    explicit: '   ',
    env: { CBM_BIN: '  ', PATH: '/env/bin' },
    home: '/home/u',
    isExecutable: made.probe,
  });
  assert.equal(resolved.source, 'PATH');
  assert.equal(made.seen.includes('/env/bin/codebase-memory-mcp'), true);
});

test('resolveCliPath：相對路徑以 cwd 展開後才探測', async function () {
  const expected = join(process.cwd(), 'bin/cbm');
  const made = makeProbe([expected]);
  const resolved = await resolveCliPath({
    explicit: 'bin/cbm',
    env: {},
    home: '/home/u',
    isExecutable: made.probe,
  });
  assert.deepEqual(resolved, { path: expected, source: 'config' });
});

test('parseJsonEnvelope：合法文字信封', function () {
  const parsed = parseJsonEnvelope(JSON.stringify({ content: [{ type: 'text', text: 'projects: 0' }] }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.text, 'projects: 0');
  assert.equal(parsed.error, undefined);
});

test('parseJsonEnvelope：isError 且內文是 JSON 錯誤物件時取出 error 與 hint', function () {
  const payload = {
    content: [{
      type: 'text',
      text: JSON.stringify({
        error: 'project not found or not indexed',
        hint: 'Use list_projects to see all indexed projects',
      }),
    }],
    isError: true,
  };
  const parsed = parseJsonEnvelope(JSON.stringify(payload));
  assert.equal(parsed.ok, false);
  assert.equal(
    parsed.error,
    'project not found or not indexed（Use list_projects to see all indexed projects）',
  );
});

test('parseJsonEnvelope：CBM 的 {status,hint} 中止信封要攤平成一句可讀的錯誤', function () {
  // 實測（keeper.log 有 8 筆 rebuild.failed）CBM 的索引中止信封只有 status 與 hint，
  // 沒有 error 欄位；舊版只認 {error}，於是整段 JSON 被原樣印到卡片上。
  const inner = JSON.stringify({
    project: 'sample-repo',
    status: 'aborted_previous_preserved',
    hint: 'Indexing aborted before publication; the previous index is intact and still serving.',
  });
  const parsed = parseJsonEnvelope(JSON.stringify({ isError: true, content: [{ type: 'text', text: inner }] }));

  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /aborted_previous_preserved/);
  assert.match(parsed.error, /Indexing aborted before publication/);
  assert.doesNotMatch(parsed.error, /\{"project"/, '不得把整段 JSON 原樣當訊息');
});

test('parseJsonEnvelope：isError 但內文不是 JSON 時取第一行', function () {
  const parsed = parseJsonEnvelope(JSON.stringify({
    content: [{ type: 'text', text: 'index supervisor failed\nsecond line' }],
    isError: true,
  }));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, 'index supervisor failed');
  // 內文是 JSON 但沒有 error 欄位時，不能吐出整個物件。
  const shapeless = parseJsonEnvelope(JSON.stringify({
    content: [{ type: 'text', text: '{"code":42}' }],
    isError: true,
  }));
  assert.equal(shapeless.error, '{"code":42}');
  // isError 且完全沒有內文：給固定訊息而不是 undefined。
  const empty = parseJsonEnvelope(JSON.stringify({ content: [], isError: true }));
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'CLI 回報 isError');
});

test('parseJsonEnvelope：空 stdout 與非 JSON stdout', function () {
  const empty = parseJsonEnvelope('');
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'CLI 沒有輸出（stdout 為空）');
  assert.equal(parseJsonEnvelope('   \n  ').ok, false);

  const broken = parseJsonEnvelope('warning: something\nnot json at all');
  assert.equal(broken.ok, false);
  assert.match(broken.error, /不是合法 JSON/);
  assert.equal(broken.text, 'warning: something\nnot json at all');
});

test('parseJsonEnvelope：多個 content block 以換行串接，非文字 block 略過', function () {
  const parsed = parseJsonEnvelope(JSON.stringify({
    content: [
      { type: 'text', text: 'first' },
      { type: 'image', data: 'zzz' },
      { type: 'text', text: 'second' },
      { type: 'text' },
    ],
  }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.text, 'first\nsecond');
});

test('readCliVersion：解析 --version 輸出，失敗時 undefined', async function (t) {
  const dir = await makeTempDir(t, 'cbm-cli-version');
  const fake = await installFakeCbm(dir, { projects: [] });
  assert.equal(await readCliVersion(fake.path), '0.11.0');
  // 不存在的執行檔：spawnError，不得拋。
  const missing = await readCliVersion(join(dir, 'no-such-binary'));
  assert.equal(missing, undefined);
});

test('runCbmTool：端到端跑假 CLI 並回傳解析後的內文', async function (t) {
  const dir = await makeTempDir(t, 'cbm-cli-run');
  const fake = await installFakeCbm(dir, {
    projects: [{ name: 'sample-repo', rootPath: '/srv/sample-repo', branch: 'main', graphHead: '3449ba2' }],
  });
  const ok = await runCbmTool({ cliPath: fake.path, args: ['list_projects'], timeoutMs: 15000 });
  assert.equal(ok.ok, true);
  assert.match(ok.text, /projects: 1/);
  assert.match(ok.command, /codebase-memory-mcp|fake-cbm/);

  // 上游回報 isError：ok=false 且錯誤文字含 stderr 尾巴。
  const failed = await runCbmTool({
    cliPath: fake.path,
    args: ['index_status', '--project', 'absent'],
    timeoutMs: 15000,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.timedOut, false);

  // 執行檔不存在：spawnError 走「CLI 啟動失敗」，永不 reject。
  const noBinary = await runCbmTool({ cliPath: join(dir, 'missing'), args: ['list_projects'], timeoutMs: 5000 });
  assert.equal(noBinary.ok, false);
  assert.match(noBinary.error, /CLI 啟動失敗/);
  assert.equal(noBinary.timedOut, false);
});
