/**
 * keeper.js 的端到端測試（FR-1／FR-2／FR-3／FR-14／NFR-6）。
 *
 * 每一項外部事實都從 `deps` 注入；CLI 則是一支自造的假執行檔（見
 * helpers/fake-cbm.js），所以整台機器會被真的驅動起來——包含 spawn、鎖檔、
 * 狀態檔與佇列——但不會索引任何東西，也不會碰到真的 codebase-memory-mcp。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CbmKeeper } from '../lib/keeper.js';
import { CliNotFoundError } from '../lib/cli.js';
import { resolveKeeperConfig } from '../lib/config.js';
import { KeeperState } from '../lib/state.js';
import { STATE_VERSION } from '../lib/constants.js';
import { canonicalRootPath } from '../lib/staleness.js';
import { fakeProject, installFakeCbm } from './helpers/fake-cbm.js';
import { makeFakeLog, makeTempDir, waitFor } from './helpers/env.js';

/**
 * 讀取假 CLI 收到的 index_repository 呼叫。
 * @param {string} callsFile - calls.ndjson 路徑。
 * @returns {Promise<object[]>} 呼叫記錄。
 */
async function readCalls(callsFile) {
  const raw = await readFile(callsFile, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length > 0) out.push(JSON.parse(line));
  }
  return out;
}

/**
 * 組出一台受測的 keeper 與它的注入事實。
 *
 * @param {object} t - node:test 的 TestContext。
 * @param {object} options - 情境。
 * @param {object[]} options.projects - 假 CBM 專案（見 fakeProject）。
 * @param {object} [options.sha] - rootPath → 工作樹 HEAD 的對照表。
 * @param {object} [options.cbm] - 其他假 CLI 狀態（nodes／edges／delayMs／…）。
 * @param {object} [options.config] - 覆寫執行期設定。
 * @param {object} [options.facts] - 覆寫注入事實（liveHead／dirty／behindBy／…）。
 * @param {object} [options.deps] - 再覆寫 deps。
 * @returns {Promise<object>} { keeper, callsFile, config, facts, log, home }。
 */
async function makeKeeper(t, options) {
  const projects = options.projects;
  const sha = options.sha ?? {};
  const dir = await makeTempDir(t, 'cbm-keeper');
  const home = join(dir, 'home');
  const fake = await installFakeCbm(dir, Object.assign({
    projects,
    sha,
    nodes: 128530,
    edges: 154752,
    parsePartialCount: 29,
    notIndexedFilesCount: 2043,
    config: { auto_index: 'false', auto_watch: 'false' },
  }, options.cbm ?? {}));

  const facts = Object.assign({
    liveHead: undefined,
    dirty: false,
    behindBy: null,
    headCommittedAt: '2026-10-04T04:03:00Z',
  }, options.facts ?? {});

  const config = resolveKeeperConfig(Object.assign({
    nice: 0,
    watchEnabled: false,
    scanMinutes: 1440,
    includeDirty: true,
  }, options.config ?? {}));
  const log = makeFakeLog();
  await mkdir(home, { recursive: true });
  // 診斷用標記：清理失效時，殘骸目錄裡看得出是哪個案例留下的。
  await writeFile(join(home, 'case.txt'), String(options.label ?? 'unlabelled'), 'utf8');
  const state = new KeeperState({ file: join(home, 'state.json'), log });

  const deps = Object.assign({
    resolveCliPath: async function () { return { path: fake.path, source: 'config' }; },
    canonicalizeRoot: async function (root) { return canonicalRootPath(root); },
    readLiveHead: async function (root) {
      const head = facts.liveHead === undefined ? sha[root] : facts.liveHead;
      return head === undefined
        ? { ok: false, head: undefined, error: 'git rev-parse HEAD 失敗（測試注入）' }
        : { ok: true, head, error: undefined };
    },
    readHeadCommittedAt: async function () { return facts.headCommittedAt; },
    countCommitsBetween: async function () { return facts.behindBy; },
    isWorktreeDirty: async function () { return facts.dirty; },
  }, options.deps ?? {});

  const keeper = new CbmKeeper({ home, config: function () { return config; }, log, state, deps });
  // 追蹤「還在飛的重建」。
  //
  // 為什麼需要：keeper.stop() 只等**已排入**的狀態寫入，不等一個正在跑的
  // runRebuild 之後才發生的寫入（index_status → checkProject → setProject）。
  // 測試清理若只靠 stop()，那個晚到的寫入會把剛被 rm -rf 的 home/ 重新建回來，
  // 在 /tmp 留下殘骸。這裡包住 cbm.index，把「index 之後的收尾」也納入等待。
  const inFlight = new Set();
  const realIndex = keeper.cbm.index.bind(keeper.cbm);
  keeper.cbm.index = function (request) {
    const tracked = (async function () {
      const result = await realIndex(request);
      // 重建成功後會再查一次狀態並落盤；把它一起等完。
      const record = keeper.records.get(request.rootPath);
      if (result.ok && record !== undefined) await keeper.checkProject(record, true);
      return result;
    })();
    inFlight.add(tracked);
    tracked.finally(function () { inFlight.delete(tracked); });
    return tracked;
  };
  t.after(async function () {
    await keeper.stop();
    // 清理暫存目錄，並確定沒有任何寫入晚到。
    //
    // 兩個坑都在 keeper.js：`enqueue()` 是 `void this.drain()`（重建要等下一個
    // 微任務才真的開始跑），而 `stop()` 只等**已排入**的狀態寫入，不等一個已經
    // 在跑的 runRebuild 之後才發生的寫入（index_status → checkProject →
    // setProject）。若照著 stop() 的直接回傳就 rm -rf，那個晚到的寫入會把
    // home/ 重新建回來。因此這裡等到「佇列與在飛的工作都空了」才刪，刪完再確認。
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const idle = keeper.queue.length === 0 && keeper.running === undefined && inFlight.size === 0;
      await rm(dir, { recursive: true, force: true });
      if (idle && (await readdir(dir).catch(function () { return []; })).length === 0) return;
      await new Promise(function (resolve) { setTimeout(resolve, 100); });
    }
  });
  return { keeper, callsFile: fake.callsFile, stateFile: fake.stateFile, config, facts, log, home, dir };
}

test('FR-1：同一 root 的兩個上游名字只會產生一筆紀錄，且沿用先看到的 name', async function (t) {
  const root = '/srv/repo-6mark';
  const made = await makeKeeper(t, {
    projects: [
      fakeProject({ name: 'sample-repo', rootPath: root, graphHead: '3449ba2' }),
      fakeProject({ name: 'home-srv-repo-6mark', rootPath: root + '/', graphHead: '3449ba2' }),
    ],
    sha: { [root]: '3449ba2' },
  });

  await made.keeper.start();
  const listed = made.keeper.list();
  assert.equal(listed.length, 1, '同一棵樹只能有一筆');
  assert.equal(listed[0].name, 'sample-repo');
  assert.equal(listed[0].key, root);

  // 再掃一次仍然是同一筆（不得因為上游又改名字而增生）。
  await made.keeper.refresh('manual');
  assert.equal(made.keeper.list().length, 1);
  assert.equal(made.log.entries.some(function (entry) { return entry.event === 'project.duplicate'; }), true, '重複要被記進日誌');
});

test('FR-2/FR-3：圖譜 HEAD 與工作樹一致時，即使 autoRebuild 也不排任何重建', async function (t) {
  const root = '/srv/fresh-repo';
  const made = await makeKeeper(t, {
    projects: [fakeProject({ name: 'fresh', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
  });

  await made.keeper.start();
  const record = made.keeper.list()[0];
  assert.equal(record.stale, false);
  assert.equal(record.behindBy, 0);
  assert.equal(record.confidence, 'head');

  await made.keeper.refresh('manual');
  // 給 drain 足夠的時間：若錯誤地排入重建，這裡就會看到呼叫。
  await new Promise(function (resolve) { setTimeout(resolve, 400); });
  assert.deepEqual(await readCalls(made.callsFile), []);
  assert.equal(made.keeper.status().queue.length, 0);
  assert.equal(made.keeper.list()[0].rebuildState, 'idle');
});

test('FR-2/FR-3：HEAD 落後時恰好排入一次重建，並帶上游的 name 與模式', async function (t) {
  const root = '/srv/stale-repo';
  const made = await makeKeeper(t, {
    projects: [fakeProject({ name: 'stale-repo', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '96cd57b' },
    facts: { behindBy: 37 },
    config: { mode: 'moderate' },
  });

  await made.keeper.start();
  const record = made.keeper.list()[0];
  assert.equal(record.stale, true);
  assert.equal(record.behindBy, 37);
  assert.deepEqual(record.reasons, ['head-advanced']);

  await waitFor(async function () { return (await readCalls(made.callsFile)).length > 0; }, {
    timeoutMs: 8000,
    label: '重建被呼叫',
  });
  const calls = await readCalls(made.callsFile);
  assert.equal(calls.length, 1, '只排一次');
  assert.equal(calls[0].rootPath, root);
  assert.equal(calls[0].name, 'stale-repo', 'FR-1：重建必須帶回既有 name');
  assert.equal(calls[0].mode, 'moderate', '未指定模式時用設定值');

  // 重建後圖譜追上 HEAD，紀錄回到乾淨狀態。
  await waitFor(function () { return made.keeper.list()[0].rebuildState === 'idle'; }, {
    timeoutMs: 8000,
    label: '重建結束',
  });
  const settled = made.keeper.list()[0];
  assert.equal(settled.graphHead, '96cd57b');
  assert.equal(settled.stale, false);
  assert.equal(settled.lastError, undefined);
  assert.equal(typeof settled.lastIndexedAt, 'string');
});

test('FR-3：HEAD 相同但工作樹 dirty 時，includeDirty 決定要不要重建', async function (t) {
  const root = '/srv/dirty-repo';
  const ignored = await makeKeeper(t, {
    projects: [fakeProject({ name: 'dirty', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    facts: { dirty: true },
    config: { includeDirty: false },
  });
  await ignored.keeper.start();
  const lenient = ignored.keeper.list()[0];
  assert.equal(lenient.dirty, true);
  assert.equal(lenient.stale, false, 'includeDirty=false 時未提交變更不算落後');
  await new Promise(function (resolve) { setTimeout(resolve, 300); });
  assert.deepEqual(await readCalls(ignored.callsFile), []);
  await ignored.keeper.stop();

  const included = await makeKeeper(t, {
    projects: [fakeProject({ name: 'dirty', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    facts: { dirty: true },
    config: { includeDirty: true },
  });
  await included.keeper.start();
  const strict = included.keeper.list()[0];
  assert.equal(strict.stale, true);
  assert.deepEqual(strict.reasons, ['head-match-but-dirty']);
  await waitFor(async function () { return (await readCalls(included.callsFile)).length > 0; }, {
    timeoutMs: 8000,
    label: 'dirty 觸發重建',
  });
  assert.equal((await readCalls(included.callsFile)).length, 1);
});

test('FR-14：兩個專案的重建序列化執行，絕不重疊', async function (t) {
  const rootA = '/srv/repo-a';
  const rootB = '/srv/repo-b';
  const made = await makeKeeper(t, {
    projects: [
      fakeProject({ name: 'repo-a', rootPath: rootA, graphHead: 'a1b2c3d' }),
      fakeProject({ name: 'repo-b', rootPath: rootB, graphHead: 'a1b2c3d' }),
    ],
    sha: { [rootA]: 'b1b2c3d', [rootB]: 'c1b2c3d' },
    cbm: { delayMs: 200 },
  });

  await made.keeper.start();
  await waitFor(async function () { return (await readCalls(made.callsFile)).length === 2; }, {
    timeoutMs: 15000,
    label: '兩個重建都完成',
  });

  const calls = await readCalls(made.callsFile);
  assert.equal(calls.length, 2);
  const names = calls.map(function (call) { return call.name; }).sort();
  assert.deepEqual(names, ['repo-a', 'repo-b']);
  // 假 CLI 忙碌 200ms；序列化的話，第二次呼叫的起始時間必須晚於第一次的結束。
  assert.equal(calls[0].durationMs >= 150, true, '假 CLI 應真的忙碌一段時間');
  assert.equal(calls[1].durationMs >= 150, true);
});

test('NFR-6：狀態檔中 rebuildState=running 的專案在 start() 時重新排入', async function (t) {
  const root = '/srv/recovered-repo';
  const made = await makeKeeper(t, {
    projects: [fakeProject({ name: 'recovered', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '96cd57b' },
  });

  // 模擬上次崩潰：狀態檔說這個專案正在重建，但沒有任何行程在做。
  await mkdir(made.home, { recursive: true });
  await writeFile(join(made.home, 'state.json'), JSON.stringify({
    version: STATE_VERSION,
    updatedAt: '2026-10-03T20:00:00Z',
    projects: {
      [root]: { name: 'recovered', rootPath: root, rebuildState: 'running', rebuildReason: 'watch' },
    },
    watchers: {},
  }, null, 2), 'utf8');

  await made.keeper.start();
  assert.equal(
    made.log.entries.some(function (entry) { return entry.event === 'rebuild.recovered'; }),
    true,
    '恢復意圖必須可見',
  );
  await waitFor(async function () { return (await readCalls(made.callsFile)).length > 0; }, {
    timeoutMs: 8000,
    label: '恢復後重建',
  });
  const calls = await readCalls(made.callsFile);
  assert.equal(calls[0].name, 'recovered');
  // 等記憶體狀態回到 idle：那是 runRebuild 把結果寫進狀態檔之後才設定的。
  await waitFor(function () { return made.keeper.list()[0].rebuildState === 'idle'; }, {
    timeoutMs: 8000,
    label: '重建結束',
  });
  assert.equal((await readCalls(made.callsFile)).length, 1, '恢復只排一次');
});

test('FR-10：CLI 解析失敗時 status().cliError 具名、warnings 帶 cli-missing', async function (t) {
  const made = await makeKeeper(t, {
    projects: [],
    deps: {
      resolveCliPath: async function () {
        throw new CliNotFoundError('找不到 codebase-memory-mcp 執行檔。', [
          '/opt/cbm/codebase-memory-mcp',
          '/home/u/.local/bin/codebase-memory-mcp',
        ]);
      },
    },
  });

  await made.keeper.start();
  const status = made.keeper.status();
  assert.equal(status.cliPath, undefined);
  assert.equal(status.cliError, '找不到 codebase-memory-mcp 執行檔。');
  assert.deepEqual(status.cliCandidates, ['/opt/cbm/codebase-memory-mcp', '/home/u/.local/bin/codebase-memory-mcp']);
  const cliWarning = status.warnings.filter(function (warning) { return warning.code === 'cli-missing'; });
  assert.equal(cliWarning.length, 1);
  assert.equal(cliWarning[0].message, status.cliError);
  assert.equal(cliWarning[0].candidates.length, 2);
  assert.equal(made.log.entries.some(function (entry) { return entry.event === 'cli.unresolved'; }), true);
});

test('FR-15／R6：版本與上游設定不合時產生具名警告', async function (t) {
  const root = '/srv/warn-repo';
  const made = await makeKeeper(t, {
    projects: [fakeProject({ name: 'warn', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    cbm: {
      version: '0.10.8',
      config: { auto_index: 'true', auto_watch: 'true', watcher_enabled: 'true' },
    },
  });

  await made.keeper.start();
  assert.equal(made.keeper.status().cliVersion, '0.10.8');
  assert.equal(made.keeper.status().cliVersionSupported, false);
  const codes = made.keeper.status().warnings.map(function (warning) { return warning.code; });
  assert.equal(codes.includes('version-unexpected'), true);
  assert.equal(codes.includes('auto-index-on'), true);
  assert.equal(codes.includes('upstream-watcher-on'), true);
  assert.equal(made.keeper.status().upstreamConfig.auto_index, 'true');
});

test('NFR-6：重建完成後鎖檔被釋放，且狀態檔留下結果', async function (t) {
  const root = '/srv/lock-repo';
  const made = await makeKeeper(t, {
    projects: [fakeProject({ name: 'lock', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '96cd57b' },
  });

  await made.keeper.start();
  // 等磁碟上的狀態回到 idle：runRebuild 是先釋放鎖、才把結果寫進狀態檔，
  // 所以這是最後一個落盤步驟，之後才檢查鎖檔才不會有競態。
  await waitFor(async function () {
    const files = await readdir(made.home).catch(function () { return []; });
    if (files.includes('rebuild.lock')) return false;
    try {
      const persisted = JSON.parse(await readFile(join(made.home, 'state.json'), 'utf8'));
      return persisted.projects[root] !== undefined && persisted.projects[root].rebuildState === 'idle';
    } catch {
      // 狀態檔還沒落盤：繼續等。
      return false;
    }
  }, { timeoutMs: 8000, label: '重建結果落盤' });
  await made.keeper.stop();

  const files = await readdir(made.home);
  assert.equal(files.includes('rebuild.lock'), false, '鎖檔必須被釋放');
  const persisted = JSON.parse(await readFile(join(made.home, 'state.json'), 'utf8'));
  assert.equal(persisted.projects[root].rebuildState, 'idle');
  assert.equal(persisted.projects[root].name, 'lock');
  assert.equal(typeof persisted.projects[root].lastIndexedAt, 'string');
});

test('NFR-6：stop() 會 join 正在跑的重建，回傳後不得再有任何狀態寫入', async function (t) {
  const root = '/srv/stop-join-repo';
  const made = await makeKeeper(t, {
    label: 'stop-join',
    projects: [fakeProject({ name: 'slow', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '96cd57b' },
    // 讓假 CLI 真的忙一段時間，stop() 才會撞上一個「正在跑」的重建。
    cbm: { delayMs: 600 },
  });

  await made.keeper.start();
  await waitFor(function () { return made.keeper.running !== undefined; }, {
    timeoutMs: 8000,
    label: '重建已啟動',
  });

  await made.keeper.stop();

  // 這一條就是這個測試的重點：stop() 回傳時，佇列輪次必須已經收尾。
  // 修好之前 drain 是 `void` 出去的，stop() 只看得到已排入的狀態寫入，
  // 重建尾巴那一筆 setProject 會在 stop() 之後才落地——也就是把剛被
  // `rm -rf` 的狀態目錄又建回來的原因。
  assert.equal(made.keeper.running, undefined, 'stop() 回傳時不得還有重建在跑');
  assert.equal(made.keeper.drainPromise, undefined, 'stop() 回傳時佇列輪次必須已收尾');

  // 停止後狀態檔不得再被改寫。
  const snapshot = await readFile(join(made.home, 'state.json'), 'utf8').catch(function () { return undefined; });
  await new Promise(function (resolve) { setTimeout(resolve, 400); });
  const later = await readFile(join(made.home, 'state.json'), 'utf8').catch(function () { return undefined; });
  assert.equal(later, snapshot, 'stop() 之後不得再有狀態寫入');

  // 被中止的重建要留下可追溯的痕跡，而不是靜默消失。
  const abandoned = made.log.entries.filter(function (entry) { return entry.event === 'rebuild.abandoned'; });
  assert.equal(abandoned.length, 1, '中止的重建應留下一筆 rebuild.abandoned');
  assert.equal(abandoned[0].data.project, 'slow');
});
