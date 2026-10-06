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
import { CbmKeeper, RebuildStats } from '../lib/keeper.js';
import { CliNotFoundError } from '../lib/cli.js';
import { resolveKeeperConfig } from '../lib/config.js';
import { KeeperLog } from '../lib/log.js';
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
  // C3：includeDirty=false 時連 `git status` 都不打，dirty 直接是 false
  // （＝「沒有把它算進落後判定」，不是「工作樹是乾淨的」）。
  assert.equal(lenient.dirty, false);
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

// ---------------------------------------------------------------------------
// WS1（A/B 段）：崩潰與卸載正確性
// ---------------------------------------------------------------------------

test('A1：重建拋錯不得變成 unhandledRejection，且 keeper 仍可繼續重建', async function (t) {
  const root = '/srv/crash-repo';
  const made = await makeKeeper(t, {
    label: 'a1-drain-crash',
    projects: [fakeProject({ name: 'crash', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '96cd57b' },
    facts: { behindBy: 2 },
  });

  // 沒有這個 listener 時，Node 的預設行為是「unhandledRejection → 終止行程」，
  // 整個測試檔會直接死掉——那正是這個 bug 在真實宿主上的症狀。
  const unhandled = [];
  /**
   * 記錄未被處理的 rejection。
   * @param {unknown} reason - 例外原因。
   * @returns {void}
   */
  function onUnhandled(reason) { unhandled.push(reason); }
  process.on('unhandledRejection', onUnhandled);

  let phase = 'boom';
  const realIndex = made.keeper.cbm.index.bind(made.keeper.cbm);
  made.keeper.cbm.index = async function (request) {
    if (phase === 'boom') throw new Error('index exploded');
    return realIndex(request);
  };

  try {
    await made.keeper.start();
    await waitFor(function () {
      return made.keeper.queue.length === 0 && made.keeper.running === undefined;
    }, { timeoutMs: 8000, label: '失敗的佇列輪次收尾' });

    assert.deepEqual(unhandled, [], 'A1：不得產生 unhandledRejection');
    assert.equal(
      made.log.entries.some(function (entry) { return entry.event === 'drain.failed'; }),
      true,
      'A1：失敗必須留下 drain.failed 日誌，不能靜默',
    );
    assert.equal(made.keeper.list()[0].rebuildState, 'idle', '失敗後不得卡在 running／queued');

    // keeper 仍可用：換成正常的 index，下一次重建照樣跑完。
    phase = 'ok';
    assert.equal(made.keeper.enqueue(root, 'manual', undefined, { force: true }), true);
    await waitFor(async function () { return (await readCalls(made.callsFile)).length === 1; }, {
      timeoutMs: 8000,
      label: '崩潰後仍能重建',
    });
    await waitFor(function () { return made.keeper.list()[0].rebuildState === 'idle'; }, {
      timeoutMs: 8000,
      label: '第二次重建結束',
    });
    assert.deepEqual(unhandled, [], 'A1：整段過程都不得產生 unhandledRejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('B1：stop() 等在飛的掃描收尾，之後不得留下任何監看器', async function (t) {
  const root = '/srv/stop-refresh-repo';
  let created = 0;
  let releaseProbe;
  const probeGate = new Promise(function (resolve) { releaseProbe = resolve; });
  let probeEntered = false;

  const made = await makeKeeper(t, {
    label: 'b1-stop-refresh',
    projects: [fakeProject({ name: 'slow-scan', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    config: { watchEnabled: true },
    deps: {
      // 把掃描卡在「探測圖譜 UI」這一步，stop() 才有可能撞上一個在飛的掃描。
      probeGraphUiHttp: async function () {
        probeEntered = true;
        await probeGate;
        return { ok: false, error: '測試注入' };
      },
      createWatcher: async function () {
        created += 1;
        return {
          backend: 'fake',
          stop: async function () {},
          status: function () { return 'watching'; },
          triggers: 0,
          lastTriggerAt: undefined,
          lastError: undefined,
        };
      },
    },
  });

  const starting = made.keeper.start();
  await waitFor(function () { return probeEntered; }, { timeoutMs: 8000, label: '掃描進入探測階段' });

  const stopping = made.keeper.stop();
  releaseProbe();
  await stopping;
  await starting.catch(function () { return undefined; });

  // 修好之前：stop() 不等 refreshPromise，掃描在 stop() 之後才走到
  // reconcileWatchers()，於是建立了一個永遠不會被停掉的監看器（watchers.size === 1）。
  assert.equal(created, 0, 'B1：停止流程中不得再建立監看器');
  assert.equal(made.keeper.watchers.size, 0, 'B1：stop() 回傳後不得留下監看器');
});

test('B2：取鎖期間被卸載時不啟動子行程，且鎖會被釋放', async function (t) {
  const root = '/srv/stop-lock-repo';
  let releaseLock;
  const lockGate = new Promise(function (resolve) { releaseLock = resolve; });
  let lockCalls = 0;
  let releases = 0;
  let indexCalls = 0;

  const made = await makeKeeper(t, {
    label: 'b2-stop-lock',
    projects: [fakeProject({ name: 'locked', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '96cd57b' },
    facts: { behindBy: 1 },
  });

  const realIndex = made.keeper.cbm.index.bind(made.keeper.cbm);
  made.keeper.cbm.index = async function (request) {
    indexCalls += 1;
    return realIndex(request);
  };
  made.keeper.acquireLock = async function () {
    lockCalls += 1;
    await lockGate;
    return {
      ok: true,
      release: async function () { releases += 1; },
    };
  };

  await made.keeper.start();
  await waitFor(function () { return lockCalls === 1; }, { timeoutMs: 8000, label: '重建進入取鎖階段' });

  // stop() 撞上「取鎖中」的窗口：控制器必須已經存在（B2 先建再取鎖），且取到鎖之後
  // 要立刻發現自己已經被卸載——不然重建子行程會在卸載後照跑。
  const stopping = made.keeper.stop();
  releaseLock();
  await stopping;

  assert.equal(indexCalls, 0, 'B2：被卸載後不得啟動重建子行程');
  assert.equal(releases, 1, 'B2：取到的鎖必須被放掉，不能留下殘骸');
  assert.equal(made.keeper.abortController, undefined, 'B2：控制器必須被清掉');
  assert.equal(made.keeper.status().queue.length, 0);
  const abandoned = made.log.entries.filter(function (entry) { return entry.event === 'rebuild.abandoned'; });
  assert.equal(abandoned.length, 1);
  assert.equal(abandoned[0].data.phase, 'lock-wait');
});

test('B3：list()／status() 取監看器的即時狀態，而不是建立當下的快照', async function (t) {
  const root = '/srv/live-watcher-repo';
  let runtimeError;
  const made = await makeKeeper(t, {
    label: 'b3-live-watcher',
    projects: [fakeProject({ name: 'live', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    config: { watchEnabled: true },
    deps: {
      createWatcher: async function () {
        return {
          backend: 'fs.watch',
          stop: async function () {},
          status: function () { return runtimeError === undefined ? 'watching' : 'failed'; },
          triggers: 0,
          lastTriggerAt: undefined,
          get lastError() { return runtimeError; },
        };
      },
    },
  });

  await made.keeper.start();
  assert.equal(made.keeper.list()[0].watcher.status, 'watching');
  assert.equal(made.keeper.list()[0].watcher.backend, 'fs.watch');

  // inotify 用盡之類的錯誤是非同步送進來的：record.watcher 是建立當下的快照，
  // 只有向監看器本身取才看得到 failed。
  runtimeError = 'ENOSPC: System limit for number of file watchers reached';
  const row = made.keeper.list()[0];
  assert.equal(row.watcher.status, 'failed', 'B3：H3 的 failed 必須到得了 UI');
  assert.match(row.watcher.lastError, /ENOSPC/);
  assert.equal(made.keeper.status().watching, 1);
});

test('C2：監看觸發的重驗走圖譜 HEAD 快取，不再每存一次檔打一次 query_graph', async function (t) {
  const root = '/srv/watch-head-cache';
  const made = await makeKeeper(t, {
    label: 'c2-watch-head-cache',
    projects: [fakeProject({ name: 'cached', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    facts: { dirty: true },
    // 關掉自動重建：這一條驗的是「重驗落後的成本」，不是重建本身。
    config: { includeDirty: true, autoRebuild: false },
  });

  let headQueries = 0;
  const realGraphHead = made.keeper.cbm.graphHead.bind(made.keeper.cbm);
  made.keeper.cbm.graphHead = async function (name) {
    headQueries += 1;
    return realGraphHead(name);
  };

  await made.keeper.start();
  assert.equal(headQueries, 1, '首次檢查會問一次圖譜 HEAD');

  await made.keeper.onWatcherTrigger(made.keeper.records.get(root));
  assert.equal(headQueries, 1, 'C2：存檔路徑必須命中 indexedAt 快取，不得再問一次');
  assert.equal(made.keeper.records.get(root).stale, true, '重驗仍然要更新落後狀態');
});

test('C3：includeDirty=false 時完全不探測工作樹髒污（省一次 git status）', async function (t) {
  const root = '/srv/no-dirty-probe';
  let lenientProbes = 0;
  const lenient = await makeKeeper(t, {
    label: 'c3-no-dirty-probe',
    projects: [fakeProject({ name: 'nodirty', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    config: { includeDirty: false },
    deps: {
      isWorktreeDirty: async function () { lenientProbes += 1; return true; },
    },
  });

  await lenient.keeper.start();
  assert.equal(lenientProbes, 0, 'C3：includeDirty=false 不該 spawn git status');
  assert.equal(lenient.keeper.list()[0].dirty, false);
  assert.equal(lenient.keeper.list()[0].stale, false);

  let strictProbes = 0;
  const strict = await makeKeeper(t, {
    label: 'c3-dirty-probe-on',
    projects: [fakeProject({ name: 'dirty-on', rootPath: '/srv/dirty-probe-on', graphHead: '3449ba2' })],
    sha: { '/srv/dirty-probe-on': '3449ba2' },
    config: { includeDirty: true },
    deps: {
      isWorktreeDirty: async function () { strictProbes += 1; return false; },
    },
  });

  await strict.keeper.start();
  assert.equal(strictProbes > 0, true, 'C3：includeDirty=true 時照樣探測');
  assert.equal(strict.keeper.list()[0].dirty, false);
});

test('C4：只有圖譜 HEAD 缺席（時間旁證）時才讀 headCommittedAt', async function (t) {
  let knownReads = 0;
  const known = await makeKeeper(t, {
    label: 'c4-head-known',
    projects: [fakeProject({ name: 'known', rootPath: '/srv/head-known', graphHead: '3449ba2' })],
    sha: { '/srv/head-known': '3449ba2' },
    deps: {
      readHeadCommittedAt: async function () {
        knownReads += 1;
        return '2026-10-04T04:03:00Z';
      },
    },
  });

  await known.keeper.start();
  assert.equal(knownReads, 0, 'C4：圖譜有 HEAD 時不該付一次 git log -1');
  assert.equal(known.keeper.list()[0].confidence, 'head');

  let fallbackReads = 0;
  const missing = await makeKeeper(t, {
    label: 'c4-head-missing',
    // 不給 graphHead：假 CLI 的 query_graph 回空表，走時間旁證那條退路。
    projects: [fakeProject({ name: 'missing', rootPath: '/srv/head-missing' })],
    sha: { '/srv/head-missing': '96cd57b' },
    deps: {
      readHeadCommittedAt: async function () {
        fallbackReads += 1;
        return '2026-10-04T04:03:00Z';
      },
    },
  });

  await missing.keeper.start();
  assert.equal(fallbackReads > 0, true, 'C4：時間旁證要用 headCommittedAt，必須讀');
  assert.equal(missing.keeper.list()[0].confidence, 'time');
});

// ---------------------------------------------------------------------------
// WS1（C1 段）：idle-settle 視窗——兩條路徑的閘門
// ---------------------------------------------------------------------------

test('C1：dirty-only ＋ settle>0 ＋ 持續活動時，完全不排重建', async function (t) {
  const root = '/srv/settle-active';
  const made = await makeKeeper(t, {
    label: 'c1-settle-active',
    projects: [fakeProject({ name: 'settle-active', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    facts: { dirty: true },
    config: { includeDirty: true, dirtySettleSeconds: 2 },
  });

  await made.keeper.start();
  const record = made.keeper.records.get(root);
  assert.deepEqual(record.reasons, ['head-match-but-dirty']);

  // 連續兩次「存檔」：第二次把計時器往後推，視窗永遠不到期。
  // （真實路徑由監看器的 onTrigger 回呼先寫 lastTriggerAt 再叫 onWatcherTrigger；
  //  這裡直接呼叫，所以要自己補上那次觸發的痕跡。）
  record.watcher.lastTriggerAt = new Date().toISOString();
  await made.keeper.onWatcherTrigger(record);
  assert.notEqual(record.settleTimer, undefined, 'C1：dirty-only 應改為武裝 settle 計時器');
  await new Promise(function (resolve) { setTimeout(resolve, 300); });
  record.watcher.lastTriggerAt = new Date().toISOString();
  await made.keeper.onWatcherTrigger(record);
  await new Promise(function (resolve) { setTimeout(resolve, 300); });

  assert.deepEqual(await readCalls(made.callsFile), [], 'C1：靜默視窗內不得排任何重建');
  assert.equal(
    made.log.entries.filter(function (entry) { return entry.event === 'watch.settle.armed'; }).length,
    2,
    'C1：每次觸發都要重排（這就是「靜默 N 秒」的語意）',
  );
});

test('C1：dirty-only ＋ settle>0 ＋ 活動停止超過視窗時，恰好排一次', async function (t) {
  const root = '/srv/settle-quiet';
  const made = await makeKeeper(t, {
    label: 'c1-settle-quiet',
    projects: [fakeProject({ name: 'settle-quiet', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    facts: { dirty: true },
    config: { includeDirty: true, dirtySettleSeconds: 0.3 },
  });

  await made.keeper.start();
  assert.deepEqual(await readCalls(made.callsFile), [], '掃描不會為沒有活動的 dirty 專案排重建');

  const record = made.keeper.records.get(root);
  record.watcher.lastTriggerAt = new Date().toISOString();
  await made.keeper.onWatcherTrigger(record);
  await waitFor(async function () { return (await readCalls(made.callsFile)).length > 0; }, {
    timeoutMs: 8000,
    label: '靜默視窗到期後排入重建',
  });

  await waitFor(function () { return made.keeper.list()[0].rebuildState === 'idle'; }, {
    timeoutMs: 8000,
    label: '重建結束',
  });
  await new Promise(function (resolve) { setTimeout(resolve, 400); });
  const calls = await readCalls(made.callsFile);
  assert.equal(calls.length, 1, 'C1：一次靜默只換一次重建');
  assert.equal(
    made.log.entries.some(function (entry) { return entry.data !== undefined && entry.data.reason === 'watch:settled'; }),
    true,
    'C1：排入原因要看得出來自 settle 到期',
  );
});

test('C1：真正的 HEAD 落後（head-advanced）不受 settle 視窗延遲', async function (t) {
  const root = '/srv/settle-head-advanced';
  const made = await makeKeeper(t, {
    label: 'c1-head-advanced-immediate',
    projects: [fakeProject({ name: 'advanced', rootPath: root, graphHead: '3449ba2' })],
    // 啟動時是乾淨的：先讓 keeper 進入穩態，再讓 HEAD 前進，
    // 這樣「下面那次重建」就只可能來自本條要驗的路徑。
    sha: { [root]: '3449ba2' },
    facts: { dirty: true, behindBy: 4 },
    // 視窗開到 60 秒：若這條路徑被延遲，下面在時限內就看不到任何重建。
    config: { includeDirty: true, dirtySettleSeconds: 60, rebuildCooldownSeconds: 0 },
  });

  await made.keeper.start();
  assert.deepEqual(await readCalls(made.callsFile), [], '啟動時圖譜 HEAD 與工作樹一致，不該有重建');

  // 模擬一次 commit：工作樹 HEAD 前進，圖譜落後。
  made.facts.liveHead = '96cd57b';
  const record = made.keeper.records.get(root);
  record.watcher.lastTriggerAt = new Date().toISOString();
  await made.keeper.onWatcherTrigger(record);
  assert.deepEqual(record.reasons, ['head-advanced']);

  await waitFor(async function () { return (await readCalls(made.callsFile)).length > 0; }, {
    timeoutMs: 8000,
    label: 'HEAD 落後必須立即重建',
  });
  assert.equal(record.settleTimer, undefined, 'C1：HEAD 落後不該走 settle 路徑');
});

test('C1／B1：stop() 之後已武裝的 settle 計時器不得再排入任何重建', async function (t) {
  const root = '/srv/settle-stop';
  const made = await makeKeeper(t, {
    label: 'c1-settle-stop',
    projects: [fakeProject({ name: 'settle-stop', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    facts: { dirty: true },
    config: { includeDirty: true, dirtySettleSeconds: 0.3 },
  });

  await made.keeper.start();
  const record = made.keeper.records.get(root);
  await made.keeper.onWatcherTrigger(record);
  assert.notEqual(record.settleTimer, undefined, '計時器已武裝');

  await made.keeper.stop();
  assert.equal(record.settleTimer, undefined, 'B1：stop() 必須熄掉已武裝的計時器');

  // 給它遠超過視窗的時間：若計時器還活著，這裡就會看到重建被排入。
  await new Promise(function (resolve) { setTimeout(resolve, 900); });
  assert.deepEqual(await readCalls(made.callsFile), [], '卸載後不得再排任何重建');
  assert.equal(made.keeper.status().queue.length, 0);
});

// ---------------------------------------------------------------------------
// WS1（D 段）：語意一致性與錯誤出口
// ---------------------------------------------------------------------------

test('D1：被設定排除但上游仍回報的專案不是孤兒；上游不再回報才是', async function (t) {
  const keptRoot = '/srv/kept-repo';
  const excludedRoot = '/srv/excluded-repo';
  const made = await makeKeeper(t, {
    label: 'd1-orphan-semantics',
    projects: [
      fakeProject({ name: 'kept', rootPath: keptRoot, graphHead: '3449ba2' }),
      fakeProject({ name: 'excluded', rootPath: excludedRoot, graphHead: '3449ba2' }),
    ],
    sha: { [keptRoot]: '3449ba2', [excludedRoot]: '3449ba2' },
    config: { excludeProjects: 'excluded' },
  });

  await made.keeper.start();
  const rows = made.keeper.list();
  const excluded = rows.find(function (row) { return row.name === 'excluded'; });
  assert.equal(excluded.selected, false, '被排除＝不納管');
  assert.equal(excluded.orphaned, false, 'D1：上游還回報它，只是被設定排除，不是孤兒');
  assert.equal(
    made.log.entries.some(function (entry) { return entry.event === 'project.orphaned'; }),
    false,
    'D1：不得記 project.orphaned',
  );

  // 第二輪：上游真的不再回報這棵樹 → 這才是孤兒。
  const persisted = JSON.parse(await readFile(made.stateFile, 'utf8'));
  persisted.projects = persisted.projects.filter(function (project) { return project.name !== 'excluded'; });
  await writeFile(made.stateFile, JSON.stringify(persisted), 'utf8');

  await made.keeper.refresh('manual');
  const gone = made.keeper.list().find(function (row) { return row.name === 'excluded'; });
  assert.equal(gone.orphaned, true, 'D1：上游不再回報才是孤兒');
  assert.equal(gone.selected, false);
  const orphanLogs = made.log.entries.filter(function (entry) { return entry.event === 'project.orphaned'; });
  assert.equal(orphanLogs.length, 1);
  assert.equal(orphanLogs[0].data.name, 'excluded');
});

test('D3：日誌落檔失敗與狀態載入失敗都會出現在 status()', async function (t) {
  const dir = await makeTempDir(t, 'cbm-status-error-outlets');
  const home = join(dir, 'home');
  await mkdir(home, { recursive: true });

  // 讓日誌檔不可能被打開：把它的父路徑做成一個普通檔案（mkdir 會 EEXIST）。
  const blocker = join(dir, 'blocker');
  await writeFile(blocker, 'not a directory\n', 'utf8');
  const log = new KeeperLog({ file: join(blocker, 'keeper.log'), maxEntries: 50, minLevel: 'info' });
  await log.open();
  assert.equal(typeof log.fileError, 'string', '前提：日誌檔真的開不了');

  // 讓狀態檔損毀：載入失敗必須留住原因。
  const state = new KeeperState({ file: join(home, 'state.json'), log });
  await writeFile(state.file, '{ "projects": ', 'utf8');
  await state.load();
  assert.equal(typeof state.loadError, 'string', '前提：狀態檔真的讀不回來');

  const broken = new CbmKeeper({
    home,
    config: function () { return resolveKeeperConfig({}); },
    log,
    state,
  });
  const status = broken.status();
  assert.equal(status.logFileError, log.fileError, 'D3：日誌錯誤必須有出口');
  assert.equal(status.stateLoadError, state.loadError, 'D3：狀態載入錯誤必須有出口');
  assert.equal(typeof status.logFileError, 'string');

  // 健康的情況是 undefined（不是空字串），UI 才能用 truthy 判斷。
  const healthyLog = new KeeperLog({ file: join(home, 'ok.log'), maxEntries: 50, minLevel: 'info' });
  await healthyLog.open();
  const healthyState = new KeeperState({ file: join(home, 'ok-state.json'), log: healthyLog });
  await healthyState.load();
  const healthy = new CbmKeeper({
    home,
    config: function () { return resolveKeeperConfig({}); },
    log: healthyLog,
    state: healthyState,
  });
  assert.equal(healthy.status().logFileError, undefined);
  assert.equal(healthy.status().stateLoadError, undefined);
});

test('E：status().running 帶 startedAt（介面凍結）', async function (t) {
  const root = '/srv/running-shape';
  const made = await makeKeeper(t, {
    label: 'e-running-shape',
    projects: [fakeProject({ name: 'running-shape', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '96cd57b' },
    cbm: { delayMs: 600 },
  });

  assert.equal(made.keeper.status().running, undefined, '閒置時 running 是 undefined');

  void made.keeper.start();
  await waitFor(function () {
    const running = made.keeper.status().running;
    return running !== undefined && typeof running.startedAt === 'string';
  }, { timeoutMs: 8000, label: 'running 帶 startedAt' });

  const running = made.keeper.status().running;
  assert.equal(running.key, root);
  assert.equal(typeof running.reason, 'string');
  assert.equal(Number.isNaN(Date.parse(running.startedAt)), false, 'startedAt 必須是 ISO 時間');
  assert.equal(typeof made.keeper.list()[0].rebuildStartedAt, 'string');
});

test('D4：upstreamConfigError 在建構子就有定義（尚未探測上游時是 undefined）', function () {
  const log = makeFakeLog();
  const keeper = new CbmKeeper({
    home: '/tmp/cbm-never-written',
    config: function () { return resolveKeeperConfig({}); },
    log,
    state: new KeeperState({ file: '/tmp/cbm-never-written/state.json', log }),
  });

  // 以前這個欄位只等到 probeUpstream() 才長出來：在那之前讀它拿到 undefined 是
  // 僥倖（`in`／列舉會看到一個時有時無的鍵）。
  assert.equal(Object.prototype.hasOwnProperty.call(keeper, 'upstreamConfigError'), true);
  assert.equal(keeper.upstreamConfigError, undefined);
  assert.equal(keeper.graphUiNote(), undefined, '沒有異常時不該生出一句說明');
  assert.equal(keeper.status().upstreamConfigError, undefined);
});

// ---------------------------------------------------------------------------
// WS5：重建成效統計（stats）
// ---------------------------------------------------------------------------

/** 介面凍結的 stats 鍵集：每個概念兩個鍵（本次啟動以來／最近 24 小時）。 */
const STATS_FIELDS = [
  'rebuildsQueued', 'rebuildsSucceeded', 'rebuildsFailed', 'rebuildsAborted',
  'skippedCooldown', 'skippedGate', 'settled', 'settleDeferred',
  'checksShortCircuited', 'rebuildMs',
];

test('WS5：stats 是扁平的數字物件，每個鍵都有值（0 而不是 undefined）', async function (t) {
  const made = await makeKeeper(t, {
    label: 'ws5-stats-shape',
    projects: [fakeProject({ name: 'shape', rootPath: '/srv/stats-shape', graphHead: '3449ba2' })],
    sha: { '/srv/stats-shape': '3449ba2' },
  });

  const status = made.keeper.status();
  const expected = [];
  for (const field of STATS_FIELDS) {
    expected.push('sinceStart' + field.charAt(0).toUpperCase() + field.slice(1));
    expected.push('last24h' + field.charAt(0).toUpperCase() + field.slice(1));
  }
  assert.deepEqual(Object.keys(status.stats).sort(), expected.slice().sort(), '鍵集是介面凍結的一部分');
  for (const key of Object.keys(status.stats)) {
    assert.equal(typeof status.stats[key], 'number', key + ' 必須是數字（缺值用 0，不是 undefined）');
    assert.equal(status.stats[key], 0, key + ' 還沒發生過就是 0');
  }
  // 統計的起算點要說得出來：UI 才能顯示「本次啟動以來（自 …）」。
  assert.equal(typeof status.statsSince, 'string');
  assert.equal(Number.isNaN(Date.parse(status.statsSince)), false);
});

test('WS5：RebuildStats 的 24 小時滾動視窗（小時桶）與累計的分野', function () {
  const t0 = Date.parse('2026-10-07T00:30:00Z');
  const hour = 60 * 60 * 1000;
  const stats = new RebuildStats({ now: t0 });
  assert.equal(stats.startedAt, new Date(t0).toISOString());

  stats.count('rebuildsQueued', 1, t0);
  stats.count('rebuildMs', 1500, t0);
  // 非數字的累加量視為 1（呼叫端忘了給量的時候不該把統計變成 NaN）。
  stats.count('rebuildsFailed', Number.NaN, t0);
  assert.equal(stats.snapshot(t0).sinceStartRebuildsQueued, 1);
  assert.equal(stats.snapshot(t0).sinceStartRebuildMs, 1500);
  assert.equal(stats.snapshot(t0).sinceStartRebuildsFailed, 1);

  // 23 小時後還在視窗內；25 小時後滑出視窗，但 sinceStart 是累計、不受影響。
  assert.equal(stats.snapshot(t0 + 23 * hour).last24hRebuildsQueued, 1);
  assert.equal(stats.snapshot(t0 + 25 * hour).last24hRebuildsQueued, 0, '滑出 24 小時視窗');
  assert.equal(stats.snapshot(t0 + 25 * hour).sinceStartRebuildsQueued, 1, 'sinceStart 是累計');

  // 未知欄位不得長出鍵、也不得打爆統計。
  stats.count('notAField', 1, t0);
  assert.equal('sinceStartNotAField' in stats.snapshot(t0), false);
  // 舊桶會被清掉，記憶體不隨時間成長。
  stats.count('rebuildsQueued', 1, t0 + 48 * hour);
  assert.equal(stats.buckets.size <= 2, true);
});

test('WS5：成功、失敗、被中止各計一次，且失敗與被中止互斥', async function (t) {
  const root = '/srv/stats-outcomes';
  const made = await makeKeeper(t, {
    label: 'ws5-stats-outcomes',
    projects: [fakeProject({ name: 'outcomes', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    // 關掉自動重建：這一條要自己控制每一次重建的結果。
    config: { autoRebuild: false, rebuildCooldownSeconds: 0 },
  });

  await made.keeper.start();
  assert.equal(made.keeper.status().stats.sinceStartRebuildsQueued, 0, '乾淨起步');

  let measuredMs = 0;

  /**
   * 排一次強制重建並等它收尾。
   * @param {() => Promise<object>} indexImpl - 這次要用的假 index 實作。
   * @returns {Promise<void>} 該輪結束。
   */
  async function rebuildWith(indexImpl) {
    made.keeper.cbm.index = indexImpl;
    assert.equal(made.keeper.enqueue(root, 'manual', undefined, { force: true }), true);
    await waitFor(function () {
      return made.keeper.list()[0].rebuildState === 'idle' && made.keeper.running === undefined;
    }, { timeoutMs: 8000, label: '這一輪重建收尾' });
    // 累計耗時量的是**這一輪的 wall time**（runRebuild 自己量的），不是假 CLI 宣稱的值。
    measuredMs += made.keeper.list()[0].lastDurationMs;
  }

  await rebuildWith(async function () {
    return { ok: true, durationMs: 7, error: undefined, command: 'fake index' };
  });
  await rebuildWith(async function () {
    return { ok: false, durationMs: 9, error: 'CLI 逾時（90000 ms）：index_repository', command: 'fake index' };
  });
  await rebuildWith(async function () {
    return {
      ok: false,
      durationMs: 11,
      error: 'aborted_previous_preserved：索引被新的一輪取代，先前的圖譜已保留。',
      command: 'fake index',
    };
  });

  const stats = made.keeper.status().stats;
  assert.equal(stats.sinceStartRebuildsQueued, 3);
  assert.equal(stats.sinceStartRebuildsSucceeded, 1);
  assert.equal(stats.sinceStartRebuildsFailed, 1);
  assert.equal(stats.sinceStartRebuildsAborted, 1);
  assert.equal(stats.sinceStartRebuildMs, measuredMs, '累計重建耗時＝三輪 wall time 的和');
  assert.equal(stats.last24hRebuildsAborted, 1, '剛發生的事一定要落在 24 小時視窗內');
});

test('WS5：冷卻擋下的重建計入 skippedCooldown，且統計不受 stop() 影響', async function (t) {
  const root = '/srv/stats-skipped';
  const made = await makeKeeper(t, {
    label: 'ws5-stats-skipped',
    projects: [fakeProject({ name: 'skipped', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '96cd57b' },
    facts: { behindBy: 1 },
    config: { autoRebuild: false, rebuildCooldownSeconds: 3600 },
  });

  await made.keeper.start();
  made.keeper.enqueue(root, 'manual', undefined, { force: true });
  await waitFor(function () {
    return made.keeper.list()[0].rebuildState === 'idle' && made.keeper.running === undefined;
  }, { timeoutMs: 8000, label: '第一次重建結束' });
  await made.keeper.drain();

  // 冷卻期內：兩次自動排入都該被擋下並計數。
  assert.equal(made.keeper.enqueue(root, 'watch'), false);
  assert.equal(made.keeper.enqueue(root, 'watch'), false);
  assert.equal(made.keeper.status().stats.sinceStartSkippedCooldown, 2);
  assert.equal(made.keeper.status().stats.sinceStartRebuildsQueued, 1, '被擋下的不算排入');

  const before = made.keeper.status().stats;
  assert.equal(typeof made.keeper.status().statsSince, 'string');
  await made.keeper.stop();

  // stop() 不得把統計歸零：它描述的是「本次啟動以來」，不是「目前有沒有在跑」。
  const after = made.keeper.status().stats;
  assert.deepEqual(after, before, 'stop() 之後統計必須原封不動');
  assert.equal(after.sinceStartSkippedCooldown, 2);
});

test('WS5：掃描閘門擋下的重建計入 skippedGate（省下來的工作）', async function (t) {
  const root = '/srv/stats-gate';
  const made = await makeKeeper(t, {
    label: 'ws5-stats-gate',
    projects: [fakeProject({ name: 'gate', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    facts: { dirty: true },
    config: { includeDirty: true },
  });

  await made.keeper.start();
  const afterStart = made.keeper.status().stats.sinceStartSkippedGate;
  assert.equal(afterStart >= 1, true, '啟動掃描就被閘門擋下一次（沒有任何檔案活動）');

  await made.keeper.refresh('timer');
  assert.equal(made.keeper.status().stats.sinceStartSkippedGate, afterStart + 1, '每一輪掃描各計一次');
  assert.equal(made.keeper.status().stats.sinceStartRebuildsQueued, 0, '閘門擋下＝沒有排重建');
  assert.deepEqual(await readCalls(made.callsFile), []);
});

test('WS5：settle 延後與最終排入各有計數', async function (t) {
  const root = '/srv/stats-settle';
  const made = await makeKeeper(t, {
    label: 'ws5-stats-settle',
    projects: [fakeProject({ name: 'settle', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    facts: { dirty: true },
    config: { includeDirty: true, dirtySettleSeconds: 0.3 },
  });

  await made.keeper.start();
  const record = made.keeper.records.get(root);
  record.watcher.lastTriggerAt = new Date().toISOString();
  await made.keeper.onWatcherTrigger(record);

  assert.equal(made.keeper.status().stats.sinceStartSettleDeferred, 1, '被延後一次');
  assert.equal(made.keeper.status().stats.sinceStartSettled, 0, '還沒真的排入');

  await waitFor(function () { return made.keeper.status().stats.sinceStartSettled === 1; }, {
    timeoutMs: 8000,
    label: 'settle 到期後排入',
  });
  assert.equal(made.keeper.status().stats.sinceStartRebuildsQueued, 1, '延後之後只排一次');
});

// ---------------------------------------------------------------------------
// WS6：settle 視窗內只做便宜的 HEAD 探測
// ---------------------------------------------------------------------------

/**
 * 包住 CBM 與 git 探針，數出「這一輪觸發花了幾次子行程」。
 * @param {object} keeper - 受測的協調器。
 * @returns {{calls: object, restore: () => void}} 計數器與還原函式。
 */
function countProbes(keeper) {
  const calls = { indexStatus: 0, graphHead: 0, readLiveHead: 0, readHeadCommittedAt: 0, isWorktreeDirty: 0 };
  const realStatus = keeper.cbm.indexStatus.bind(keeper.cbm);
  const realGraphHead = keeper.cbm.graphHead.bind(keeper.cbm);
  const realLive = keeper.deps.readLiveHead;
  const realCommitted = keeper.deps.readHeadCommittedAt;
  const realDirty = keeper.deps.isWorktreeDirty;
  keeper.cbm.indexStatus = async function (name) { calls.indexStatus += 1; return realStatus(name); };
  keeper.cbm.graphHead = async function (name) { calls.graphHead += 1; return realGraphHead(name); };
  keeper.deps.readLiveHead = async function (dir) { calls.readLiveHead += 1; return realLive(dir); };
  keeper.deps.readHeadCommittedAt = async function (dir) { calls.readHeadCommittedAt += 1; return realCommitted(dir); };
  keeper.deps.isWorktreeDirty = async function (dir) { calls.isWorktreeDirty += 1; return realDirty(dir); };
  return {
    calls,
    restore: function () {
      keeper.cbm.indexStatus = realStatus;
      keeper.cbm.graphHead = realGraphHead;
      keeper.deps.readLiveHead = realLive;
      keeper.deps.readHeadCommittedAt = realCommitted;
      keeper.deps.isWorktreeDirty = realDirty;
    },
  };
}

test('WS6：settle 視窗內 HEAD 未變 → 完全不碰 CBM CLI，只重排計時器', async function (t) {
  const root = '/srv/short-circuit-repo';
  const made = await makeKeeper(t, {
    label: 'ws6-short-circuit',
    projects: [fakeProject({ name: 'short', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    facts: { dirty: true },
    config: { includeDirty: true, dirtySettleSeconds: 30 },
  });

  await made.keeper.start();
  const record = made.keeper.records.get(root);
  assert.deepEqual(record.reasons, ['head-match-but-dirty']);

  // 第一次觸發：進入視窗（完整檢查一次、武裝計時器）。
  record.watcher.lastTriggerAt = new Date().toISOString();
  await made.keeper.onWatcherTrigger(record);
  assert.notEqual(record.settleTimer, undefined, '視窗已武裝');
  const firstTimer = record.settleTimer;

  const probes = countProbes(made.keeper);
  try {
    // 視窗內再存兩次檔。
    for (let index = 0; index < 2; index += 1) {
      record.watcher.lastTriggerAt = new Date().toISOString();
      await made.keeper.onWatcherTrigger(record);
    }

    assert.equal(probes.calls.indexStatus, 0, 'WS6：視窗內不得呼叫 index_status（2 秒以上）');
    assert.equal(probes.calls.graphHead, 0, 'WS6：視窗內不得讀圖譜 HEAD');
    assert.equal(probes.calls.readLiveHead, 2, 'WS6：只做便宜的 git rev-parse HEAD');
    assert.equal(probes.calls.readHeadCommittedAt, 0, 'WS6：時間旁證也不需要');
    assert.equal(probes.calls.isWorktreeDirty, 0, 'WS6：髒污狀態沒變，不必再問 git status');
  } finally {
    probes.restore();
  }

  assert.notEqual(record.settleTimer, undefined, '計時器要重排，不是熄掉');
  assert.notEqual(record.settleTimer, firstTimer, '重排＝新的計時器（靜默視窗往後推）');
  const stats = made.keeper.status().stats;
  assert.equal(stats.sinceStartChecksShortCircuited, 2, '省下的完整檢查要算得出來');
  assert.equal(stats.sinceStartRebuildsQueued, 0, '視窗內不得排重建');
  assert.equal(stats.sinceStartSettleDeferred, 3, '三次觸發都往後推了一次');
  assert.equal(record.stale, true, '狀態照舊：仍然是 dirty 落後');
});

test('WS6：視窗內 HEAD 變了 → 立刻完整檢查並排重建（不受 settle 延遲）', async function (t) {
  const root = '/srv/short-circuit-head';
  const made = await makeKeeper(t, {
    label: 'ws6-head-changed',
    projects: [fakeProject({ name: 'head-change', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    facts: { dirty: true, behindBy: 3 },
    // 視窗開到 60 秒：若這條路徑被延遲，下面在時限內就看不到重建。
    config: { includeDirty: true, dirtySettleSeconds: 60, rebuildCooldownSeconds: 0 },
  });

  await made.keeper.start();
  const record = made.keeper.records.get(root);
  record.watcher.lastTriggerAt = new Date().toISOString();
  await made.keeper.onWatcherTrigger(record);
  assert.notEqual(record.settleTimer, undefined);
  assert.deepEqual(await readCalls(made.callsFile), []);

  // 使用者 commit 了：工作樹 HEAD 前進，圖譜落後。
  made.facts.liveHead = '96cd57b';
  const probes = countProbes(made.keeper);
  try {
    record.watcher.lastTriggerAt = new Date().toISOString();
    await made.keeper.onWatcherTrigger(record);
    // 兩次：一次是便宜的探測（發現 HEAD 變了），一次是完整 checkProject 自己讀的。
    assert.equal(probes.calls.readLiveHead, 2, '先做一次便宜的探測，再進完整檢查');
    assert.equal(probes.calls.indexStatus, 1, 'HEAD 變了就要付完整檢查的代價');
  } finally {
    probes.restore();
  }

  assert.deepEqual(record.reasons, ['head-advanced']);
  await waitFor(async function () { return (await readCalls(made.callsFile)).length === 1; }, {
    timeoutMs: 8000,
    label: 'HEAD 落後必須立即重建',
  });
  assert.equal(made.keeper.status().stats.sinceStartChecksShortCircuited, 0, '這一輪沒有被短路');
});

test('WS6：dirtySettleMs＝0 時行為與現行逐值相同（每次觸發都完整檢查）', async function (t) {
  const root = '/srv/short-circuit-off';
  const made = await makeKeeper(t, {
    label: 'ws6-settle-off',
    projects: [fakeProject({ name: 'off', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    facts: { dirty: true },
    // autoRebuild 關掉：這一條只看「每次觸發做了哪一種檢查」，不看重建。
    config: { includeDirty: true, dirtySettleSeconds: 0, autoRebuild: false },
  });

  await made.keeper.start();
  const record = made.keeper.records.get(root);
  const probes = countProbes(made.keeper);
  try {
    for (let index = 0; index < 2; index += 1) {
      record.watcher.lastTriggerAt = new Date().toISOString();
      await made.keeper.onWatcherTrigger(record);
    }
    assert.equal(probes.calls.indexStatus, 2, 'settle 關閉＝每次觸發都完整檢查');
    // 圖譜 HEAD 走 indexedAt 快取（C2）：indexed_at 沒變就不必再問一次 query_graph。
    assert.equal(probes.calls.graphHead, 0, '快取命中：同一個 indexedAt 不重問圖譜 HEAD');
    assert.equal(probes.calls.isWorktreeDirty, 2, 'includeDirty=true 時每次都探測髒污');
  } finally {
    probes.restore();
  }
  assert.equal(record.settleTimer, undefined, 'settle 關閉時不武裝計時器');
  assert.equal(made.keeper.status().stats.sinceStartChecksShortCircuited, 0);
  assert.equal(made.keeper.status().stats.sinceStartSettleDeferred, 0);
});

test('WS6：視窗內 HEAD 探測失敗 → 退回完整檢查，不讓狀態卡住', async function (t) {
  const root = '/srv/short-circuit-fail';
  const made = await makeKeeper(t, {
    label: 'ws6-probe-failed',
    projects: [fakeProject({ name: 'probe-fail', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    facts: { dirty: true },
    // autoRebuild 保持開啟：關掉它的話 onWatcherTrigger 會直接清掉 settle 計時器
    // （那條規則本身是對的），這一條就測不到視窗內的行為了。dirty-only ＋ 長視窗
    // 本身就不會在測試期間排重建。
    config: { includeDirty: true, dirtySettleSeconds: 60 },
  });

  await made.keeper.start();
  const record = made.keeper.records.get(root);
  record.watcher.lastTriggerAt = new Date().toISOString();
  await made.keeper.onWatcherTrigger(record);
  assert.notEqual(record.settleTimer, undefined, '先進入 settle 視窗');

  // git 探測失敗（unborn HEAD／不是工作樹／git 不在）：不能因為省成本就當成「HEAD 沒變」。
  const realLive = made.keeper.deps.readLiveHead;
  made.keeper.deps.readLiveHead = async function () {
    return { ok: false, head: undefined, error: "fatal: ambiguous argument 'HEAD'" };
  };
  const probes = countProbes(made.keeper);
  try {
    record.watcher.lastTriggerAt = new Date().toISOString();
    await made.keeper.onWatcherTrigger(record);
    assert.equal(probes.calls.indexStatus, 1, '探測失敗 → 必須完整檢查');
    // 圖譜 HEAD 由 indexedAt 快取供給（C2）：舊圖譜沒重建過，indexed_at 沒變。
    assert.equal(probes.calls.graphHead, 0, '快取命中：不必重問圖譜 HEAD');
    assert.equal(probes.calls.readLiveHead, 2, '一次便宜探測（失敗）＋完整檢查自己再讀一次');
  } finally {
    probes.restore();
    made.keeper.deps.readLiveHead = realLive;
  }
  assert.equal(made.keeper.status().stats.sinceStartChecksShortCircuited, 0, '沒有被短路');
  assert.match(String(record.lastCheckedError), /unborn HEAD|尚無提交/);
  // 探測不到 HEAD ＝ 證據不足：stale 是 null（本插件永不把「不知道」當成新鮮），
  // 因此也不再維持 settle 視窗——沒有「已知的 dirty-only 落後」就沒有要等的靜默。
  assert.equal(record.stale, null);
  assert.equal(record.settleTimer, undefined, '證據不足時收起視窗');

  // git 恢復之後，下一次觸發會重新完整檢查並重新武裝視窗（狀態不會卡住）。
  record.watcher.lastTriggerAt = new Date().toISOString();
  await made.keeper.onWatcherTrigger(record);
  assert.equal(record.stale, true);
  assert.deepEqual(record.reasons, ['head-match-but-dirty']);
  assert.notEqual(record.settleTimer, undefined, '恢復後重新進入視窗');
});

// ---------------------------------------------------------------------------
// WS7：偵測到重建追逐時主動建議 dirtySettleSeconds
// ---------------------------------------------------------------------------

/**
 * 取出 dirty-chase 警告（沒有就 undefined）。
 * @param {object} keeper - 受測協調器。
 * @returns {object|undefined} 警告物件。
 */
function dirtyChaseOf(keeper) {
  return keeper.status().warnings.find(function (warning) { return warning.code === 'dirty-chase-detected'; });
}

test('WS7：新安裝、統計全 0 時絕不出現 dirty-chase 警告（跑幾輪掃描也一樣）', async function (t) {
  const root = '/srv/ws7-fresh';
  const made = await makeKeeper(t, {
    label: 'ws7-fresh-install',
    projects: [fakeProject({ name: 'fresh', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    facts: { dirty: true },
    // 預設值：dirtySettleSeconds=0、includeDirty=true——正是警告的適用對象，
    // 但什麼都還沒發生，所以不該出聲。
  });

  await made.keeper.start();
  assert.deepEqual(made.keeper.status().warnings, [], '全新安裝的警告清單必須是空的');
  assert.equal(dirtyChaseOf(made.keeper), undefined);

  await made.keeper.refresh('timer');
  await made.keeper.refresh('timer');
  assert.equal(dirtyChaseOf(made.keeper), undefined, '沒有追逐證據就不該嘮叨');
  assert.equal(made.keeper.status().stats.last24hRebuildsAborted, 0);
});

test('WS7：dirtySettleMs > 0 或 includeDirty=false 時不出現（即使有中止）', async function (t) {
  const settled = await makeKeeper(t, {
    label: 'ws7-settle-set',
    projects: [fakeProject({ name: 'settled', rootPath: '/srv/ws7-settle-set', graphHead: '3449ba2' })],
    sha: { '/srv/ws7-settle-set': '3449ba2' },
    config: { includeDirty: true, dirtySettleSeconds: 90 },
  });
  settled.keeper.stats.count('rebuildsAborted', 5);
  settled.keeper.rebuildWarnings();
  assert.equal(dirtyChaseOf(settled.keeper), undefined, '使用者已經填了欄位就不必再建議');

  const ignored = await makeKeeper(t, {
    label: 'ws7-include-dirty-off',
    projects: [fakeProject({ name: 'ignored', rootPath: '/srv/ws7-include-dirty-off', graphHead: '3449ba2' })],
    sha: { '/srv/ws7-include-dirty-off': '3449ba2' },
    config: { includeDirty: false, dirtySettleSeconds: 0 },
  });
  ignored.keeper.stats.count('rebuildsAborted', 5);
  ignored.keeper.rebuildWarnings();
  // includeDirty=false 的部署不會有 dirty-only 的落後，settle 視窗幫不上忙；
  // 給了建議反而是誤導。
  assert.equal(dirtyChaseOf(ignored.keeper), undefined);
});

test('WS7：門檻（3 次且佔一半以上）與訊息內容；掃描會重算警告', async function (t) {
  const root = '/srv/ws7-threshold';
  const made = await makeKeeper(t, {
    label: 'ws7-threshold',
    projects: [fakeProject({ name: 'threshold', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
  });
  const keeper = made.keeper;

  // 2 次：偶發，不提醒。
  keeper.stats.count('rebuildsAborted', 2);
  keeper.rebuildWarnings();
  assert.equal(dirtyChaseOf(keeper), undefined, '2 次可能是巧合，不該打擾使用者');

  // 3 次中止、但只佔 8 次完成重建的 38%：不是「多數重建都白跑」。
  keeper.stats.count('rebuildsAborted', 1); // 中止 3
  keeper.stats.count('rebuildsSucceeded', 5); // 完成 8
  keeper.rebuildWarnings();
  assert.equal(dirtyChaseOf(keeper), undefined, '佔比不到一半不算追逐');

  // 再 4 次成功＋4 次中止：中止 7、完成 16、佔比 44%，仍在一半以下。
  keeper.stats.count('rebuildsSucceeded', 4); // 完成 12
  keeper.stats.count('rebuildsAborted', 4); // 中止 7
  keeper.rebuildWarnings();
  assert.equal(dirtyChaseOf(keeper), undefined, '44% 仍在門檻下');

  // 再 2 次中止：中止 9、完成 18、剛好 50% → 成立（門檻含等於）。
  keeper.stats.count('rebuildsAborted', 2);

  // 掃描路徑會重算警告：不必手動呼叫 rebuildWarnings()。
  await keeper.refresh('timer');
  const warning = dirtyChaseOf(keeper);
  assert.notEqual(warning, undefined, '9/18＝50% 達到門檻（含邊界）');
  assert.equal(warning.code, 'dirty-chase-detected');
  // 結構化參數：客戶端（尤其英文介面）靠這一組在地化，message 只是 fallback。
  // 鍵名已凍結，改動等於破壞 client 的 WARNING_PARAMS。
  assert.deepEqual(warning.data, { aborted: 9, completed: 18, percent: 50 });
  assert.deepEqual(Object.keys(warning.data).sort(), ['aborted', 'completed', 'percent']);

  // 訊息必須帶真實數字、欄位名、A/B 實測值，並把決定權留給使用者。
  assert.match(warning.message, /9 次重建在途中被中止/);
  assert.match(warning.message, /18 次已完成嘗試的 50%/);
  assert.match(warning.message, /dirtySettleSeconds/);
  assert.match(warning.message, /設成 90/);
  assert.match(warning.message, /實測/);
  assert.match(warning.message, /10 次 → 0 次/);
  assert.match(warning.message, /設 0 則維持現行行為/);
  assert.match(warning.message, /由你決定/);
  assert.equal(warning.message.includes('你應該'), false, '不得替使用者做決定');
});

test('WS7：數字滑出 24 小時視窗後，警告跟著消失', async function (t) {
  const root = '/srv/ws7-window';
  const made = await makeKeeper(t, {
    label: 'ws7-window-slide',
    projects: [fakeProject({ name: 'window', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
  });
  const keeper = made.keeper;
  const past = Date.now() - 25 * 60 * 60 * 1000;

  // 25 小時前的中止：進得了 sinceStart，進不了 24 小時視窗。
  keeper.stats.count('rebuildsAborted', 6, past);
  keeper.rebuildWarnings();
  assert.equal(dirtyChaseOf(keeper), undefined, '舊症狀不該持續嘮叨');
  assert.equal(keeper.status().stats.sinceStartRebuildsAborted, 6, 'sinceStart 仍留著紀錄');

  // 現在又發生一次（累計 7 次，視窗內 1 次）→ 仍未達 3 次的門檻。
  keeper.stats.count('rebuildsAborted', 1);
  keeper.rebuildWarnings();
  assert.equal(dirtyChaseOf(keeper), undefined);

  // 視窗內累積到 3 次 → 警告出現。
  keeper.stats.count('rebuildsAborted', 2);
  keeper.rebuildWarnings();
  assert.notEqual(dirtyChaseOf(keeper), undefined, '視窗內 3 次才成立');
  assert.match(dirtyChaseOf(keeper).message, /3 次重建在途中被中止/);
});

test('WS7：真的發生 3 次被中止的重建後，警告自動出現（不必等下一輪掃描）', async function (t) {
  const root = '/srv/ws7-real-chase';
  const made = await makeKeeper(t, {
    label: 'ws7-real-chase',
    projects: [fakeProject({ name: 'chase', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    config: { autoRebuild: false, rebuildCooldownSeconds: 0 },
  });
  await made.keeper.start();
  assert.equal(dirtyChaseOf(made.keeper), undefined, '還沒發生任何事');

  made.keeper.cbm.index = async function () {
    return {
      ok: false,
      durationMs: 12,
      error: 'aborted_previous_preserved：索引被新的一輪取代，先前的圖譜已保留。',
      command: 'fake index',
    };
  };

  for (let round = 1; round <= 3; round += 1) {
    assert.equal(made.keeper.enqueue(root, 'manual', undefined, { force: true }), true);
    await waitFor(function () {
      return made.keeper.list()[0].rebuildState === 'idle' && made.keeper.running === undefined;
    }, { timeoutMs: 8000, label: '第 ' + String(round) + ' 次中止的重建收尾' });
  }

  // runRebuild 的尾端會重算警告：第 3 次中止一落地就該看得到，不必等掃描。
  const warning = dirtyChaseOf(made.keeper);
  assert.notEqual(warning, undefined, 'WS7：三次被中止就該主動說出來');
  assert.match(warning.message, /3 次重建在途中被中止/);
  assert.match(warning.message, /3 次已完成嘗試的 100%/);
  assert.equal(made.keeper.status().stats.sinceStartRebuildsAborted, 3);
});

test('WS7：警告順序——dirty-chase 排在 auto-index-on 之後、純資訊之前', async function (t) {
  const root = '/srv/ws7-order';
  const made = await makeKeeper(t, {
    label: 'ws7-warning-order',
    projects: [fakeProject({ name: 'order', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
    // 讓上游設定同時觸發另外兩條警告，才看得出順序。
    cbm: { config: { auto_index: 'true', auto_watch: 'true', watcher_enabled: 'true' } },
  });
  // 上游設定要探測過才進得了 warnings（start() 會跑 probeUpstream）。
  await made.keeper.start();
  made.keeper.stats.count('rebuildsAborted', 4);
  made.keeper.rebuildWarnings();

  const codes = made.keeper.status().warnings.map(function (warning) { return warning.code; });
  assert.deepEqual(codes, ['auto-index-on', 'dirty-chase-detected', 'upstream-watcher-on']);
});

test('WS7：data 與 message 說同一件事，且百分比是四捨五入（6/7 → 86%）', async function (t) {
  const root = '/srv/ws7-data-rounding';
  const made = await makeKeeper(t, {
    label: 'ws7-data-rounding',
    projects: [fakeProject({ name: 'rounding', rootPath: root, graphHead: '3449ba2' })],
    sha: { [root]: '3449ba2' },
  });
  made.keeper.stats.count('rebuildsAborted', 6);
  made.keeper.stats.count('rebuildsSucceeded', 1);
  made.keeper.rebuildWarnings();

  const warning = dirtyChaseOf(made.keeper);
  assert.notEqual(warning, undefined);
  // 6/7＝85.7%：取四捨五入才是 86（9/18 那條剛好是整數，驗不出進位規則）。
  assert.deepEqual(warning.data, { aborted: 6, completed: 7, percent: 86 });
  // fallback 文案與結構化參數必須一致，否則在地化後的卡片會和中文卡片說不同的事。
  assert.match(warning.message, /6 次重建在途中被中止/);
  assert.match(warning.message, /7 次已完成嘗試的 86%/);
});
