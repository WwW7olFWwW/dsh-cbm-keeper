/**
 * git.js 的測試（FR-2 的探針面）。
 *
 * 這些函式直接 shell out 到 git，沒有可注入的執行器，所以測試用**真的**暫存倉庫
 * 與**真的** git（不是 codebase-memory-mcp）。所有寫入都限制在 os.tmpdir() 內，
 * 並以 GIT_CONFIG_* 環境變數隔離使用者的 ~/.gitconfig。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { countCommitsBetween, isWorktreeDirty, readHeadCommittedAt, readLiveHead } from '../lib/git.js';
import { makeTempDir } from './helpers/env.js';

/**
 * 在指定目錄跑一次 git 並等它結束。
 * @param {string} cwd - 工作目錄。
 * @param {string[]} args - git 參數。
 * @returns {Promise<string>} stdout。
 */
async function git(cwd, args) {
  const env = Object.assign({}, process.env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'CBM Test',
    GIT_AUTHOR_EMAIL: 'cbm@example.invalid',
    GIT_COMMITTER_NAME: 'CBM Test',
    GIT_COMMITTER_EMAIL: 'cbm@example.invalid',
  });
  return new Promise(function (resolve, reject) {
    const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', function (chunk) { out += String(chunk); });
    child.stderr.on('data', function (chunk) { err += String(chunk); });
    child.on('error', reject);
    child.on('close', function (code) {
      if (code === 0) {
        resolve(out);
        return;
      }
      reject(new Error('git ' + args.join(' ') + ' 失敗（' + String(code) + '）：' + err.trim()));
    });
  });
}

/**
 * 建立一個真的暫存 git 倉庫。
 * @param {object} t - node:test 的 TestContext。
 * @returns {Promise<{dir: string}>} 倉庫根目錄。
 */
async function makeRepo(t) {
  const dir = await makeTempDir(t, 'cbm-git');
  await git(dir, ['init', '--initial-branch=main']);
  return { dir };
}

/**
 * 產生一個提交。
 * @param {string} dir - 倉庫根目錄。
 * @param {string} name - 檔名。
 * @param {string} content - 內容。
 * @param {string} message - 提交訊息。
 * @returns {Promise<string>} 新的 HEAD sha。
 */
async function commit(dir, name, content, message) {
  await writeFile(join(dir, name), content, 'utf8');
  await git(dir, ['add', name]);
  await git(dir, ['commit', '-m', message]);
  return (await git(dir, ['rev-parse', 'HEAD'])).trim();
}

test('readLiveHead：讀出目前 HEAD，並正規化 git 的補零輸出', async function (t) {
  const repo = await makeRepo(t);
  const first = await commit(repo.dir, 'a.txt', 'a\n', 'first');

  const result = await readLiveHead(repo.dir);
  assert.equal(result.ok, true);
  assert.equal(result.head, first.toLowerCase());
  assert.match(result.head, /^[0-9a-f]{40}$/, 'git 輸出補零到 40 位，必須能通過 sha 驗證');
  assert.equal(result.error, undefined);
});

test('readLiveHead：不是倉庫時回 ok:false 並帶第一行錯誤', async function (t) {
  const dir = await makeTempDir(t, 'cbm-git-norepo');
  const result = await readLiveHead(dir);
  assert.equal(result.ok, false);
  assert.equal(result.head, undefined);
  assert.equal(typeof result.error, 'string');
  assert.equal(result.error.length > 0, true);
});

test('countCommitsBetween：數出落後幾個提交，相同 sha 直接回 0', async function (t) {
  const repo = await makeRepo(t);
  const base = await commit(repo.dir, 'a.txt', 'a\n', 'base');
  const second = await commit(repo.dir, 'b.txt', 'b\n', 'second');
  const third = await commit(repo.dir, 'c.txt', 'c\n', 'third');

  assert.equal(await countCommitsBetween(repo.dir, base, third), 2);
  assert.equal(await countCommitsBetween(repo.dir, third, base), 0, 'from..to 沒有新提交');
  assert.equal(await countCommitsBetween(repo.dir, base, base), 0, '相同 sha 不必呼叫 git');
  // 讀不到 sha 時：git 失敗 → null（呼叫端顯示「無法計算」而不是 0）。
  assert.equal(await countCommitsBetween(repo.dir, 'deadbeefdeadbeef', third), null);
  assert.equal(await countCommitsBetween(repo.dir, base, second), 1);
});

test('isWorktreeDirty：追蹤檔的未提交變更為 dirty，未追蹤檔不算', async function (t) {
  const repo = await makeRepo(t);
  await commit(repo.dir, 'a.txt', 'a\n', 'base');
  assert.equal(await isWorktreeDirty(repo.dir), false);

  // 未追蹤檔不列入（--untracked-files=no）：避免把剛 clone 的雜物當成落後。
  await writeFile(join(repo.dir, 'untracked.txt'), 'x\n', 'utf8');
  assert.equal(await isWorktreeDirty(repo.dir), false);

  await writeFile(join(repo.dir, 'a.txt'), 'changed\n', 'utf8');
  assert.equal(await isWorktreeDirty(repo.dir), true);
});

test('readHeadCommittedAt：回 ISO 時間，非倉庫時 undefined', async function (t) {
  const repo = await makeRepo(t);
  await commit(repo.dir, 'a.txt', 'a\n', 'base');
  const committedAt = await readHeadCommittedAt(repo.dir);
  assert.equal(typeof committedAt, 'string');
  assert.equal(Number.isNaN(Date.parse(committedAt)), false, '要能被 parseTimestamp 解析');

  const plain = await makeTempDir(t, 'cbm-git-plain2');
  assert.equal(await readHeadCommittedAt(plain), undefined);
});
