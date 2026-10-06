/**
 * state.js 的測試（NFR-6：崩潰後能恢復意圖，且落盤是原子的）。
 *
 * 這裡刻意檢查磁碟上的位元組，而不是只信記憶體中的物件：狀態檔的價值在於
 * 「下一個行程讀得到」，所以 JSON 合法性與暫存檔不留殘骸都要驗。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KeeperState } from '../lib/state.js';
import { STATE_VERSION } from '../lib/constants.js';
import { makeFakeLog, makeTempDir } from './helpers/env.js';

/**
 * 建立一份指向暫存目錄的 KeeperState。
 * @param {string} dir - 暫存目錄。
 * @param {object} [log] - 假日誌器。
 * @returns {{state: KeeperState, file: string}} 狀態物件與檔案路徑。
 */
function makeState(dir, log) {
  const file = join(dir, 'nested', 'state.json');
  return { state: new KeeperState({ file, log: log ?? makeFakeLog() }), file };
}

test('KeeperState.load：檔案不存在時回 loaded:false 且不拋、不記錯誤', async function (t) {
  const dir = await makeTempDir(t, 'cbm-state-missing');
  const log = makeFakeLog();
  const made = makeState(dir, log);
  const result = await made.state.load();
  assert.deepEqual(result, { loaded: false, error: undefined });
  assert.equal(made.state.loadError, undefined);
  assert.deepEqual(made.state.data.projects, {}, '回退到空狀態');
  assert.equal(made.state.data.version, STATE_VERSION);
  assert.equal(log.entries.length, 0, '第一次啟動不該產生警告');
});

test('KeeperState.load：檔案損毀時回 loaded:false 並記錄 loadError', async function (t) {
  const dir = await makeTempDir(t, 'cbm-state-broken');
  const made = makeState(dir);
  await mkdir(join(dir, 'nested'), { recursive: true });
  await writeFile(made.file, '{ "projects": ', 'utf8');

  const log = makeFakeLog();
  made.state.log = log;
  const result = await made.state.load();
  assert.equal(result.loaded, false);
  assert.equal(typeof result.error, 'string');
  assert.equal(result.error.length > 0, true);
  assert.equal(made.state.loadError, result.error);
  assert.equal(log.entries.some(function (entry) { return entry.event === 'state.load.failed'; }), true);
  assert.deepEqual(made.state.data.projects, {}, '損毀時回空狀態，不半信半疑地載入');

  // 合法 JSON 但不是物件（陣列）：同樣走損毀路徑，不得讓 data.projects 變成陣列。
  await writeFile(made.file, '[1,2,3]', 'utf8');
  const arrayPayload = await made.state.load();
  assert.equal(arrayPayload.loaded, false, '頂層是陣列＝損毀');
  assert.match(String(arrayPayload.error), /不是 JSON 物件/);

  // 頂層物件但 projects 不是鍵值表：折成空表，且不拋。
  await writeFile(made.file, JSON.stringify({ version: STATE_VERSION, projects: ['oops'], watchers: 'nope' }), 'utf8');
  const badShape = await made.state.load();
  assert.equal(badShape.loaded, true);
  assert.deepEqual(made.state.data.projects, {}, 'projects 不是物件時折成空表');
  assert.deepEqual(made.state.data.watchers, {});
  assert.deepEqual(made.state.project('anything'), {});
});

test('KeeperState：setProject → 重新載入的往返，且磁碟上是合法 JSON', async function (t) {
  const dir = await makeTempDir(t, 'cbm-state-roundtrip');
  const made = makeState(dir);
  await made.state.setProject('/srv/repo', {
    name: 'repo',
    rebuildState: 'queued',
    lastIndexedAt: '2026-10-03T20:29:29Z',
  });

  const raw = await readFile(made.file, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, STATE_VERSION);
  assert.equal(parsed.projects['/srv/repo'].name, 'repo');
  assert.equal(parsed.projects['/srv/repo'].rebuildState, 'queued');
  assert.equal(typeof parsed.projects['/srv/repo'].updatedAt, 'string');
  // 2 空白縮排：狀態檔是給人看的。
  assert.equal(raw.includes('\n  "version"'), true);

  const reloaded = new KeeperState({ file: made.file, log: makeFakeLog() });
  const result = await reloaded.load();
  assert.deepEqual(result, { loaded: true, error: undefined });
  assert.equal(reloaded.project('/srv/repo').rebuildState, 'queued');
  assert.equal(reloaded.project('/srv/repo').lastIndexedAt, '2026-10-03T20:29:29Z');
  assert.deepEqual(reloaded.project('/srv/absent'), {}, '不存在的專案回空物件，不是 undefined');
});

test('KeeperState.save：落盤後不留下 .tmp- 兄弟檔', async function (t) {
  const dir = await makeTempDir(t, 'cbm-state-tmp');
  const made = makeState(dir);
  const targetDir = join(dir, 'nested');
  await made.state.setProject('/srv/repo', { name: 'repo' });
  await made.state.setProject('/srv/repo2', { name: 'repo2' });

  const names = await readdir(targetDir);
  assert.deepEqual(names, ['state.json'], '原子寫入的暫存檔必須被 rename 掉');
  assert.equal(names.some(function (name) { return name.startsWith('state.json.tmp-'); }), false);
});

test('KeeperState：多次更新同一鍵會合併，snapshot 是深拷貝', async function (t) {
  const dir = await makeTempDir(t, 'cbm-state-merge');
  const made = makeState(dir);
  await made.state.setProject('/srv/repo', { name: 'repo', lastError: 'boom' });
  await made.state.setProject('/srv/repo', { lastError: undefined, rebuildState: 'idle' });
  const record = made.state.project('/srv/repo');
  assert.equal(record.name, 'repo', '舊欄位保留');
  assert.equal(record.rebuildState, 'idle');

  const snapshot = made.state.snapshot();
  snapshot.projects['/srv/repo'].name = 'mutated';
  assert.equal(made.state.project('/srv/repo').name, 'repo', 'snapshot 必須是深拷貝');
});
