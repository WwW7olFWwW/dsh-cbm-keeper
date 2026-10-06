/**
 * exec.js 的測試（NFR-7：子行程原語「一定會解決」）。
 *
 * 逾時與找不到執行檔都必須是回傳值，不是例外——上層才可能把它們寫進 UI。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { delimiter, join } from 'node:path';
import { execFileText, searchPath, splitPathDirs } from '../lib/exec.js';

test('searchPath：先目錄後檔名，命中即回傳', async function () {
  const seen = [];
  /**
   * 記錄探測順序的假探針。
   * @param {string} candidate - 候選路徑。
   * @returns {Promise<boolean>} 是否視為可執行。
   */
  async function probe(candidate) {
    seen.push(candidate);
    return candidate.endsWith('/codebase-memory-mcp');
  }
  const found = await searchPath(['codebase-memory-mcp', 'codebase-memory-mcp.exe'], '/a:/b', probe);
  assert.equal(found, '/a/codebase-memory-mcp');
  assert.deepEqual(seen, ['/a/codebase-memory-mcp'], '第一個目錄命中就不該再探測');
});

test('searchPath：同目錄內先試第一個檔名，落空才試第二個', async function () {
  const seen = [];
  /**
   * 只認 .exe 的假探針。
   * @param {string} candidate - 候選路徑。
   * @returns {Promise<boolean>} 是否視為可執行。
   */
  async function probe(candidate) {
    seen.push(candidate);
    return candidate.endsWith('.exe');
  }
  const found = await searchPath(['cbm', 'cbm.exe'], '/only', probe);
  assert.equal(found, '/only/cbm.exe');
  assert.deepEqual(seen, ['/only/cbm', '/only/cbm.exe']);
});

test('searchPath：全部落空回 undefined，並容納多餘斜線與空目錄項', async function () {
  const seen = [];
  /**
   * 什麼都不認的假探針。
   * @param {string} candidate - 候選路徑。
   * @returns {Promise<boolean>} 永遠 false。
   */
  async function probe(candidate) {
    seen.push(candidate);
    return false;
  }
  const found = await searchPath(['cbm'], '/a//:/b/', probe);
  assert.equal(found, undefined);
  assert.deepEqual(seen, ['/a/cbm', '/b/cbm'], '空目錄項與尾斜線都要被收斂');
  assert.equal(await searchPath(['cbm'], '', probe), undefined);
  assert.equal(await searchPath(['cbm'], undefined, probe), undefined);
});

test('execFileText：捕捉 stdout、stderr 與退出碼', async function () {
  const result = await execFileText(process.execPath, [
    '-e',
    'process.stdout.write("out-line");process.stderr.write("err-line");process.exit(7);',
  ], { timeoutMs: 20000 });
  assert.equal(result.stdout, 'out-line');
  assert.equal(result.stderr, 'err-line');
  assert.equal(result.code, 7);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
  assert.equal(result.spawnError, undefined);
});

test('execFileText：逾時會解決而不是 reject，且 timedOut 為 true', async function () {
  const result = await execFileText(process.execPath, ['-e', 'setTimeout(function () {}, 60000);'], {
    timeoutMs: 300,
    killGraceMs: 200,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
  assert.equal(result.code !== 0 || result.signal !== null, true, '逾時的子行程不該是正常結束');
});

test('execFileText：找不到執行檔時 spawnError 有值且 Promise 照樣解決', async function () {
  const missing = join('/nonexistent-cbm-dir', 'definitely-not-here');
  const result = await execFileText(missing, [], { timeoutMs: 5000 });
  assert.equal(typeof result.spawnError, 'string');
  assert.equal(result.spawnError.length > 0, true);
  assert.equal(result.code, null);
  assert.equal(result.stdout, '');
  assert.equal(result.timedOut, false);
});

test('execFileText：AbortSignal 取消時 aborted 為 true 且不 reject', async function () {
  const controller = new AbortController();
  const pending = execFileText(process.execPath, ['-e', 'setTimeout(function () {}, 60000);'], {
    timeoutMs: 30000,
    killGraceMs: 200,
    signal: controller.signal,
  });
  controller.abort();
  const result = await pending;
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
});

test('D5：splitPathDirs 用平台分隔符切 PATH（Windows 是分號）', function () {
  assert.deepEqual(splitPathDirs(['/a', '/b'].join(delimiter)), ['/a', '/b']);
  assert.deepEqual(splitPathDirs(''), []);
  assert.deepEqual(splitPathDirs(undefined), []);
  assert.deepEqual(splitPathDirs(delimiter + '/a' + delimiter + delimiter), ['/a'], '空目錄項要濾掉');
  // 另一個平台的符號不得被當成分隔符：'a:b' 在 POSIX 上是兩個目錄，
  // 在 Windows 上必須是**一個**（目錄名裡有冒號）。這條斷言跟著平台走。
  const other = delimiter === ':' ? ';' : ':';
  assert.deepEqual(
    splitPathDirs('/a' + other + '/b'),
    delimiter === ':' ? ['/a' + other + '/b'] : ['/a', '/b'],
    '只有本平台的分隔符能切開 PATH',
  );
});
