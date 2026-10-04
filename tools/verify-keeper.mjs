/**
 * Host 半邊對「真實 CBM CLI」的驗證器。
 *
 * 為什麼不能只用單元測試：`lib/keeper.js` 的納管與孤兒判定是與上游清單的互動
 * 行為，注入假資料能驗證程式碼路徑，卻驗不出「上游真的回報了什麼」。這支腳本
 * 用**真的 codebase-memory-mcp** 跑一次掃描，再用一個替換過的 CbmClient 驗證
 * 上游刪除專案時的收斂。
 *
 * 它不寫入 CBM：只呼叫 list_projects／index_status／query_graph 三個讀取工具，
 * 且以 `autoRebuild:false`、`watchEnabled:false` 建構協調器。
 *
 * 用法：
 *   node tools/verify-keeper.mjs
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeeperLog } from '../lib/log.js';
import { CbmKeeper } from '../lib/keeper.js';
import { KeeperState } from '../lib/state.js';

/** 收集斷言結果。 */
class Checks {
  constructor() {
    this.passed = 0;
    this.failures = [];
  }

  /**
   * @param {string} label - 檢查項。
   * @param {boolean} ok - 是否通過。
   * @param {string} [detail] - 失敗細節。
   * @returns {void}
   */
  ok(label, ok, detail) {
    if (ok) {
      this.passed += 1;
      console.log('  PASS  ' + label);
      return;
    }
    this.failures.push(label + (detail === undefined ? '' : ' — ' + detail));
    console.log('  FAIL  ' + label + (detail === undefined ? '' : ' — ' + detail));
  }
}

/**
 * 建立一台以真實 CLI 為後端、但不做任何寫入的協調器。
 * @param {string} home - 暫存的插件狀態目錄。
 * @returns {Promise<{keeper: CbmKeeper, log: KeeperLog}>} 協調器與日誌器。
 */
async function createReadOnlyKeeper(home) {
  const log = new KeeperLog({ file: undefined, maxEntries: 500, minLevel: 'info' });
  await log.open();
  const state = new KeeperState({ file: join(home, 'state.json'), log });
  const keeper = new CbmKeeper({
    home,
    log,
    state,
    config: function () {
      return {
        enabled: true,
        cliPath: undefined,
        mode: 'fast',
        rebuildTimeoutMs: 60000,
        scanMs: 600000,
        watchEnabled: false,
        debounceMs: 3000,
        autoRebuild: false,
        includeDirty: true,
        nice: 0,
        maxLogEntries: 500,
        extensions: [],
        excludes: [],
        includeProjects: [],
        excludeProjects: [],
      };
    },
  });
  return { keeper, log };
}

/**
 * 主流程。
 * @returns {Promise<void>} 有失敗時以非零碼結束。
 */
async function main() {
  const checks = new Checks();
  const home = await mkdtemp(join(tmpdir(), 'cbm-keeper-verify-'));
  const { keeper, log } = await createReadOnlyKeeper(home);

  try {
    console.log('階段 A — 對真實 CBM CLI 掃描（唯讀）');
    await keeper.resolveCli();
    await keeper.probeUpstream();
    const status = keeper.status();
    checks.ok('CLI 由 PATH 解析', typeof status.cliPath === 'string' && status.cliPath.length > 0, String(status.cliPath));
    checks.ok('CLI 版本可讀', typeof status.cliVersion === 'string', String(status.cliVersion));
    checks.ok('版本落在支援矩陣內', status.cliVersionSupported === true, String(status.cliVersionSupported));

    const scan = await keeper.refresh('verify');
    checks.ok('掃描成功', scan.ok === true, String(scan.error));

    const projects = keeper.list();
    checks.ok('納管了至少兩個專案', projects.length >= 2, String(projects.length));

    const names = projects.map(function (project) { return project.name; });
    checks.ok('沒有殘留已刪除的 cbm-keeper-e2e', !names.includes('cbm-keeper-e2e'), names.join(','));

    const mark = projects.find(function (project) { return project.name === 'sample-repo'; });
    checks.ok('sample-repo 被納管', mark !== undefined);
    if (mark !== undefined) {
      checks.ok('sample-repo 的圖譜 HEAD 可讀', typeof mark.graphHeadShort === 'string', String(mark.graphHeadShort));
      checks.ok('sample-repo 的判據是 HEAD 比對', mark.confidence === 'head', String(mark.confidence));
      checks.ok('落後量是數字', typeof mark.behindBy === 'number', String(mark.behindBy));
    }

    const hyper = projects.find(function (project) { return project.name === 'hyper'; });
    if (hyper !== undefined) {
      checks.ok('無提交的專案不被宣稱新鮮（stale 為 null）', hyper.stale === null, String(hyper.stale));
      checks.ok('無提交的專案有一句人話解釋',
        typeof hyper.lastCheckedError === 'string' && hyper.lastCheckedError.includes('unborn HEAD'),
        String(hyper.lastCheckedError).slice(0, 80));
    }

    console.log('階段 B — 上游刪除專案時的收斂（替換 CbmClient）');
    const fakeRoot = '/tmp/cbm-keeper-verify-ghost';
    keeper.cbm = {
      nice: 0,
      listProjects: async function () {
        return { ok: true, projects: [{ name: 'ghost', rootPath: fakeRoot, branch: 'main' }], error: undefined };
      },
      indexStatus: async function () {
        return {
          ok: true,
          error: undefined,
          status: { project: 'ghost', indexedAt: '2026-01-01T00:00:00Z', nodes: 1, edges: 0, parsePartialCount: 0, notIndexedFilesCount: 0 },
        };
      },
      graphHead: async function () { return { ok: true, head: undefined, error: undefined }; },
      globalConfig: async function () { return { ok: true, config: {}, error: undefined }; },
      version: async function () { return { version: 'test', supported: true }; },
      // 這個替身不得真的索引任何東西；回一個可辨識的失敗而不是拋，避免 drain()
      // 產生未處理的 rejection 蓋掉真正的斷言結果。
      index: async function () { return { ok: false, durationMs: 0, error: 'verify-stub: 不執行索引', command: '' }; },
    };

    await keeper.refresh('verify-adopt');
    const adopted = keeper.list().find(function (project) { return project.name === 'ghost'; });
    checks.ok('上游新專案被納管', adopted !== undefined && adopted.selected === true);
    checks.ok('新專案未被標為孤兒', adopted !== undefined && adopted.orphaned === false);

    keeper.cbm.listProjects = async function () { return { ok: true, projects: [], error: undefined }; };
    await keeper.refresh('verify-orphan');
    const orphan = keeper.list().find(function (project) { return project.name === 'ghost'; });
    checks.ok('上游刪除後不再被納管', orphan !== undefined && orphan.selected === false, String(orphan?.selected));
    checks.ok('上游刪除後被標為孤兒', orphan !== undefined && orphan.orphaned === true, String(orphan?.orphaned));

    const orphanEvents = log.recent(500).filter(function (entry) {
      return entry.event === 'project.orphaned' && entry.detail.name === 'ghost';
    });
    checks.ok('孤兒收斂有寫進日誌', orphanEvents.length === 1, String(orphanEvents.length));

    console.log('階段 C — 未納管的專案不得被排入重建');
    const blocked = keeper.enqueue('/tmp/cbm-keeper-verify-ghost', 'verify');
    checks.ok('孤兒不得被排入重建', blocked === false, String(blocked));
    checks.ok('佇列因此保持空的', keeper.queue.length === 0, String(keeper.queue.length));
  } finally {
    await keeper.stop();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  console.log('');
  console.log('通過 ' + String(checks.passed) + ' 項，失敗 ' + String(checks.failures.length) + ' 項');
  if (checks.failures.length > 0) {
    for (const failure of checks.failures) console.log('  - ' + failure);
    process.exitCode = 1;
  }
}

await main();
