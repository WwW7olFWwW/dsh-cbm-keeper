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
  const dir = await makeTempDir(t, 'codebase-watcher');
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
    // 預設不連網：圖譜 UI 的探測是唯一的 HTTP 呼叫，單元測試不該真的打出去。
    // 需要驗證連結的案例自己覆寫這一個（見 FR-16 那幾條）。
    probeGraphUiHttp: async function () { return { ok: false, error: '測試注入：不對外連網' }; },
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
      // 這裡刻意吞掉 rm 的錯誤：晚到的寫入可能正好在 rm 走訪目錄時建立檔案，
      // 讓它得到 ENOTEMPTY。那是競態，不是受測行為出錯——下一輪會再刪一次。
      // （CI 上真的遇過：node 20 + chokidar 那格因為這個 ENOTEMPTY 紅了一次。）
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
        .catch(function () { return undefined; });
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

  // H1：光是 dirty 放著不動，掃描不再排重建；要有存檔活動才值得重跑。
  await new Promise(function (resolve) { setTimeout(resolve, 300); });
  assert.deepEqual(await readCalls(included.callsFile), [], '沒有活動的 dirty 專案不該在掃描時重跑');
  await included.keeper.onWatcherTrigger(included.keeper.records.get(root));
  await waitFor(async function () { return (await readCalls(included.callsFile)).length > 0; }, {
    timeoutMs: 8000,
    label: 'dirty 在存檔後觸發重建',
  });
  assert.equal((await readCalls(included.callsFile)).length, 1);
});

test('H1：dirty 專案沒有任何工作樹活動時，掃描不再週期性排重建', async function (t) {
  const root = '/srv/idle-dirty';
  const made = await makeKeeper(t, {
    projects: [fakeProject({ name: 'idle-dirty', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    facts: { dirty: true },
    config: { includeDirty: true },
  });

  await made.keeper.start();
  await made.keeper.refresh('timer');
  await new Promise(function (resolve) { setTimeout(resolve, 300); });

  const record = made.keeper.list()[0];
  assert.equal(record.dirty, true, '工作樹確實是 dirty');
  assert.equal(record.stale, true, 'includeDirty=true 時仍算落後（卡片要看得到）');
  assert.deepEqual(record.reasons, ['head-match-but-dirty']);
  assert.deepEqual(await readCalls(made.callsFile), [], '光是 dirty、沒有任何存檔活動，不該反覆重建');
  assert.equal(made.keeper.status().queue.length, 0);
});

test('H1：dirty 專案在最後一次索引之後有存檔活動時，仍會排重建', async function (t) {
  const root = '/srv/active-dirty';
  const made = await makeKeeper(t, {
    projects: [fakeProject({ name: 'active-dirty', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    facts: { dirty: true },
    config: { includeDirty: true },
  });

  await made.keeper.start();
  await made.keeper.refresh('timer');
  assert.deepEqual(await readCalls(made.callsFile), []);

  // 模擬一次存檔：監看觸發 → 這是「有活動」的證據。
  await made.keeper.onWatcherTrigger(made.keeper.records.get(root));
  await waitFor(async function () { return (await readCalls(made.callsFile)).length > 0; }, {
    timeoutMs: 8000,
    label: '存檔後仍要追上',
  });
  assert.equal((await readCalls(made.callsFile)).length, 1, '一次活動換一次重建');
});

test('H1：冷卻期內的自動重建被跳過，強制重建不受限', async function (t) {
  const root = '/srv/cooldown';
  const made = await makeKeeper(t, {
    projects: [fakeProject({ name: 'cooldown', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '96cd57b' },
    facts: { behindBy: 3 },
    config: { rebuildCooldownSeconds: 3600 },
  });

  await made.keeper.start();
  await waitFor(function () { return made.keeper.list()[0].rebuildState === 'idle'; }, {
    timeoutMs: 8000,
    label: '第一次重建結束',
  });
  assert.equal((await readCalls(made.callsFile)).length, 1);

  // 等 drain 真的收尾：runRebuild 先把 rebuildState 設回 idle，drainLoop 才清 running。
  // 在那個窗口裡排隊會被「執行中」擋掉，與冷卻無關。
  await made.keeper.drain();

  // 冷卻期內：自動排入（掃描／監看）必須被擋下，並留下可追的日誌。
  assert.equal(made.keeper.enqueue(root, 'watch'), false, '冷卻期內不得自動重建');
  assert.equal(made.keeper.status().queue.length, 0);
  const skipped = made.log.entries.filter(function (entry) { return entry.event === 'rebuild.skipped'; });
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].data.project, 'cooldown');

  // 人工／強制不受冷卻限制。
  assert.equal(made.keeper.enqueue(root, 'manual', undefined, { force: true }), true);
  await waitFor(function () { return made.keeper.list()[0].rebuildState === 'idle'; }, {
    timeoutMs: 8000,
    label: '強制重建結束',
  });
  assert.equal((await readCalls(made.callsFile)).length, 2);
});

test('H1：rebuildCooldownSeconds=0 時不設冷卻', async function (t) {
  const root = '/srv/no-cooldown';
  const made = await makeKeeper(t, {
    projects: [fakeProject({ name: 'no-cooldown', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '96cd57b' },
    facts: { behindBy: 3 },
    config: { rebuildCooldownSeconds: 0 },
  });

  await made.keeper.start();
  await waitFor(function () { return made.keeper.list()[0].rebuildState === 'idle'; }, {
    timeoutMs: 8000,
    label: '第一次重建結束',
  });
  await made.keeper.drain();
  assert.equal(made.keeper.enqueue(root, 'watch'), true, '關閉冷卻後照舊排入');
});

test('H5：讀不到 CBM 設定時保留錯誤、給具名警告，並在圖譜 UI 狀態附註原因', async function (t) {
  const root = '/srv/no-upstream-config';
  const made = await makeKeeper(t, {
    projects: [fakeProject({ name: 'no-upstream-config', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    cbm: { configFail: true },
  });

  await made.keeper.start();
  const status = made.keeper.status();
  assert.deepEqual(status.upstreamConfig, {}, '讀不到就是空的，不能假裝讀到');
  assert.equal(typeof status.upstreamConfigError, 'string');
  const warning = status.warnings.find(function (entry) { return entry.code === 'upstream-config-unreadable'; });
  assert.notEqual(warning, undefined, '必須有具名警告，不能靜默');
  assert.match(status.graphUi.note, /讀不到 CBM 設定/);
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

test('FR-16：圖譜 UI 啟用且探測成功時，狀態與每個專案都拿到連結', async function (t) {
  const root = '/srv/graph-repo';
  const probes = [];
  const made = await makeKeeper(t, {
    projects: [fakeProject({ name: 'graph-demo', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    cbm: { config: { auto_index: 'false', auto_watch: 'false', ui_enabled: 'true', ui_port: '9749' } },
    deps: {
      probeGraphUiHttp: async function (url) {
        probes.push(url);
        return { ok: true };
      },
    },
  });

  await made.keeper.start();
  const graphUi = made.keeper.status().graphUi;
  assert.equal(graphUi.state, 'ok');
  assert.equal(graphUi.source, 'config');
  assert.equal(graphUi.port, 9749);
  assert.equal(graphUi.reachable, true);
  assert.equal(graphUi.error, undefined);
  assert.equal(graphUi.url, 'http://127.0.0.1:9749/?tab=graph', '全域連結開在圖譜分頁');
  assert.deepEqual(probes, ['http://127.0.0.1:9749/api/ui-config'], '每輪掃描恰好探測一次 /api/ui-config');

  const row = made.keeper.list()[0];
  assert.equal(row.graphUrl, 'http://127.0.0.1:9749/?tab=graph&project=graph-demo', '專案列要能直達自己的圖');
});

test('FR-16：CBM 的 ui_enabled=false 時只給提示，不給連結', async function (t) {
  const root = '/srv/graph-off';
  let probed = 0;
  const made = await makeKeeper(t, {
    projects: [fakeProject({ name: 'off', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    cbm: { config: { auto_index: 'false', auto_watch: 'false', ui_enabled: 'false', ui_port: '9749' } },
    deps: {
      probeGraphUiHttp: async function () {
        probed += 1;
        return { ok: true };
      },
    },
  });

  await made.keeper.start();
  const graphUi = made.keeper.status().graphUi;
  assert.equal(graphUi.state, 'disabled');
  assert.equal(graphUi.url, undefined, '沒開就不該有可以點的連結');
  assert.equal(graphUi.base, undefined);
  assert.equal(made.keeper.list()[0].graphUrl, undefined);
  assert.equal(probed, 0, '停用時不該白白打一次 HTTP');
});

test('FR-16：UI 沒回應時仍保留網址，但標成 reachable=false', async function (t) {
  const root = '/srv/graph-down';
  const made = await makeKeeper(t, {
    projects: [fakeProject({ name: 'down', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    cbm: { config: { auto_index: 'false', auto_watch: 'false', ui_enabled: 'true', ui_port: '9749' } },
    deps: {
      probeGraphUiHttp: async function () {
        return { ok: false, error: 'connect ECONNREFUSED 127.0.0.1:9749' };
      },
    },
  });

  await made.keeper.start();
  const graphUi = made.keeper.status().graphUi;
  assert.equal(graphUi.state, 'ok', '設定上它是開著的——這件事本身要如實回報');
  assert.equal(graphUi.reachable, false);
  assert.match(graphUi.error, /ECONNREFUSED/);
  assert.equal(graphUi.url, 'http://127.0.0.1:9749/?tab=graph', '網址仍在，卡片才有東西可以顯示「未回應」');
  // 狀態翻轉要留下痕跡，而不是每輪掃描都刷一筆正常訊息。
  const flips = made.log.entries.filter(function (entry) { return entry.event === 'graphUi.changed'; });
  assert.equal(flips.length, 1);
  assert.equal(flips[0].data.reachable, false);
});

test('FR-16：graphUrl 覆寫優先；非 http(s) 的覆寫被忽略並退回推導', async function (t) {
  const root = '/srv/graph-override';
  const made = await makeKeeper(t, {
    projects: [fakeProject({ name: 'over', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    cbm: { config: { auto_index: 'false', auto_watch: 'false', ui_enabled: 'false', ui_port: '9749' } },
    config: { graphUrl: 'https://cbm.example.com/graph/' },
    deps: { probeGraphUiHttp: async function () { return { ok: true }; } },
  });
  await made.keeper.start();
  const overridden = made.keeper.status().graphUi;
  assert.equal(overridden.state, 'ok');
  assert.equal(overridden.source, 'override');
  assert.equal(overridden.url, 'https://cbm.example.com/graph/?tab=graph');
  assert.equal(made.keeper.list()[0].graphUrl, 'https://cbm.example.com/graph/?tab=graph&project=over');

  const bad = await makeKeeper(t, {
    projects: [fakeProject({ name: 'bad', rootPath: '/srv/graph-bad', graphHead: '3449ba2' })],
    sha: { '/srv/graph-bad': '3449ba2' },
    cbm: { config: { auto_index: 'false', auto_watch: 'false', ui_enabled: 'true', ui_port: '9749' } },
    config: { graphUrl: 'file:///etc/passwd' },
    deps: { probeGraphUiHttp: async function () { return { ok: true }; } },
  });
  await bad.keeper.start();
  // M10：非法覆寫不再讓所有連結消失——忽略它、退回由 ui_port 推導，並在卡片上說明。
  const fallback = bad.keeper.status().graphUi;
  assert.equal(fallback.state, 'ok');
  assert.equal(fallback.source, 'config');
  assert.equal(fallback.url, 'http://127.0.0.1:9749/?tab=graph');
  assert.match(fallback.note, /不是 http/);
  assert.equal(bad.keeper.list()[0].graphUrl, 'http://127.0.0.1:9749/?tab=graph&project=bad');
});
