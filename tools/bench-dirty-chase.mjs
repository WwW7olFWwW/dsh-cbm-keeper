/**
 * A/B 量測：一個「正在被編輯」的專案，會不會把重建當成跑步機。
 *
 * 這支工具回答一個問題，而且只回答這一個：
 *   `dirtySettleSeconds` 這個設定，值不值得存在？值多少？
 *
 * 背景（實測，見 CHANGELOG 0.4.0）：v0.3.0 加了掃描閘門與 45 秒冷卻之後，重建速率
 * 從 27.4 次/時降到 4.8 次/時——但那是**平均**。把日誌按時間軸攤開，活動時段仍是
 * 每 56–74 秒一次重建（= 45 秒冷卻 + 約 7 秒重建），而每次重建都有約 13% 的機率
 * 被 CBM 以 `aborted_previous_preserved` 中止，因為重建途中檔案又變了。也就是說：
 * 冷卻只是把「跟編輯器賽跑」的頻率壓低，沒有讓它停下來。
 *
 * 量測方法：
 *   用真的 `CbmKeeper`、真的 `node:fs.watch` 監看、真的計時器，但把三個外部事實
 *   換成可計數的注入替身——git 探針、CBM CLI、以及重建本身。於是整條
 *   「存檔 → 監看觸發 → 落後判定 → 排入 → 重建」的鏈路都是真的在跑，只是不會
 *   真的去索引任何東西。注入探針的呼叫次數就等於真實世界的子行程次數。
 *
 * 時間尺度：為了讓單次量測在數十秒內完成，時間參數等比縮小（見 SCALE）。
 * 這是**比例模型**，不是真實秒數；報告裡的「次數」是可直接外推的，「延遲」要乘回
 * 去。真實世界的對應值寫在 SCALE 的註解裡。
 *
 * 用法：
 *   node tools/bench-dirty-chase.mjs                 # 預設 A/B 兩組都跑
 *   node tools/bench-dirty-chase.mjs --settle 90     # 只跑單一 settle 值（真實秒數）
 *   node tools/bench-dirty-chase.mjs --json          # 機器可讀輸出
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CbmKeeper } from '../lib/keeper.js';
import { resolveKeeperConfig } from '../lib/config.js';
import { KeeperState } from '../lib/state.js';

/** 圖譜與工作樹共用的 HEAD：兩者一致，落後只能來自「未提交變更」。 */
const BENCH_HEAD = 'a'.repeat(40);

/**
 * 時間尺度。
 *
 * 真實世界（實測）：debounce 3000 ms、冷卻 45 s、重建 5.4–9.3 s、編輯間隔約 3–7 s。
 * 這裡等比縮到約 1/150，好讓一輪量測在 30 秒內跑完。**比例維持不變**，所以
 * 「每輪編輯期間產生幾次重建」這個比值可以直接外推回真實世界。
 */
const SCALE = {
  /** 存檔間隔（真實：一個正在編輯的人每 3–7 秒存一次檔）。 */
  editIntervalMs: 400,
  /** 模擬的編輯持續時間。 */
  editPhaseMs: 20000,
  /** 編輯停止後再觀察多久，讓 settle 視窗有機會到期。 */
  quietPhaseMs: 12000,
  /** 監看防抖（真實：3000 ms）。 */
  debounceMs: 300,
  /** 兩次自動重建的最短間隔（真實：45000 ms）。 */
  cooldownMs: 1500,
  /** 一次重建的耗時（真實：實測 p50 6.97 s）。 */
  rebuildMs: 250,
};

/**
 * 時間壓縮倍率：bench 的 1 毫秒代表真實世界的 {@link TIME_COMPRESSION} 毫秒。
 *
 * 這個數字**必須**用在每一個「使用者給的秒數」上——`dirtySettleSeconds` 也不例外。
 * 少了這一步，一個真實 90 秒的視窗在 32 秒的情境裡永遠不會到期，量到的
 * 「0 次重建」就不是「成功抑制」，而是「什麼都沒發生」——兩者在報表上長得一樣，
 * 卻是最容易騙過自己的那種錯。因此本檔一律用 {@link toBenchMs} 換算。
 */
const TIME_COMPRESSION = 45000 / SCALE.cooldownMs;

/**
 * 把真實世界的毫秒換算成 bench 的毫秒。
 * @param {number} realMs - 真實毫秒。
 * @returns {number} bench 毫秒。
 */
function toBenchMs(realMs) {
  return realMs / TIME_COMPRESSION;
}

/**
 * 一個什麼都不做、只記錄事件的日誌器；形狀與 KeeperLog 的取用面一致。
 * @returns {object} 假日誌器。
 */
function makeQuietLog() {
  const entries = [];
  /**
   * 記錄一筆。
   * @param {string} level - 等級。
   * @param {string} event - 事件名。
   * @param {object} data - 附加資料。
   * @returns {void}
   */
  function push(level, event, data) {
    entries.push({ level, event, data: data ?? {}, at: Date.now() });
  }
  return {
    entries,
    info: function (event, data) { push('info', event, data); },
    warn: function (event, data) { push('warn', event, data); },
    error: function (event, data) { push('error', event, data); },
    debug: function (event, data) { push('debug', event, data); },
    recent: function (limit) { return entries.slice(-limit); },
  };
}

/**
 * 讓出一個時間片（給計時器與微任務跑）。
 * @param {number} ms - 毫秒。
 * @returns {Promise<void>} 時間到即解決。
 */
function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/**
 * 建立一個受測的專案目錄與一些看起來像原始碼的檔案。
 * @param {string} dir - 父目錄。
 * @returns {Promise<string>} 專案根目錄。
 */
async function makeProjectDir(dir) {
  const root = join(dir, 'bench-repo');
  await mkdir(join(root, 'src'), { recursive: true });
  for (let index = 0; index < 5; index += 1) {
    await writeFile(join(root, 'src', 'file' + String(index) + '.ts'), 'export const v' + String(index) + ' = 0;\n', 'utf8');
  }
  return root;
}

/**
 * 跑一輪情境：真的啟動 keeper、真的編輯、然後收統計。
 *
 * @param {object} options - 情境參數。
 * @param {number} options.settleSeconds - 受測的 `dirtySettleSeconds`（真實秒數）。
 * @param {number} [options.cooldownMs] - 冷卻（縮放後的毫秒）。
 * @param {boolean} [options.verbose] - 是否把事件時間軸印出來。
 * @returns {Promise<object>} 統計結果。
 */
async function runScenario(options) {
  const dir = await mkdtemp(join(tmpdir(), 'cbm-bench-'));
  const home = join(dir, 'home');
  const root = await makeProjectDir(dir);
  await mkdir(home, { recursive: true });

  const log = makeQuietLog();
  const state = new KeeperState({ file: join(home, 'state.json'), log });

  /** 注入探針的呼叫計數（每個 = 真實世界的一次子行程）。 */
  const calls = {
    readLiveHead: 0,
    readHeadCommittedAt: 0,
    isWorktreeDirty: 0,
    countCommitsBetween: 0,
    indexStatus: 0,
    graphHead: 0,
    index: 0,
  };

  /**
   * 每次檔案寫入遞增；重建途中若它變了，就模擬 CBM 的 aborted_previous_preserved。
   * 這不是編出來的：日誌裡的 34 次重建失敗全部是這個字串。
   */
  let writeSeq = 0;

  const config = resolveKeeperConfig({
    nice: 0,
    watchEnabled: true,
    scanMinutes: 1440,
    autoRebuild: true,
    includeDirty: true,
    debounceMs: SCALE.debounceMs,
    rebuildCooldownSeconds: (options.cooldownMs ?? SCALE.cooldownMs) / 1000,
    rebuildTimeoutSeconds: 60,
    // 注意：這裡填的是**壓縮後**的秒數（見 toBenchMs）。真實世界的等價值另外記在
    // 結果的 settleSecondsReal，報表兩者都印，避免把壓縮值誤讀成真實秒數。
    dirtySettleSeconds: toBenchMs(options.settleSeconds * 1000) / 1000,
  });

  const deps = {
    resolveCliPath: async function () { return { path: '/bench/fake-cbm', source: 'bench' }; },
    canonicalizeRoot: async function (candidate) { return String(candidate); },
    readLiveHead: async function () {
      calls.readLiveHead += 1;
      return { ok: true, head: BENCH_HEAD, error: undefined };
    },
    readHeadCommittedAt: async function () {
      calls.readHeadCommittedAt += 1;
      return '2026-01-01T00:00:00Z';
    },
    isWorktreeDirty: async function () {
      calls.isWorktreeDirty += 1;
      return true;
    },
    countCommitsBetween: async function () {
      calls.countCommitsBetween += 1;
      return null;
    },
    probeGraphUiHttp: async function () { return { ok: false, error: 'bench：不對外連網' }; },
  };

  const keeper = new CbmKeeper({ home, config: function () { return config; }, log, state, deps });

  // CBM CLI 的替身：HEAD 與工作樹一致，所以落後只會是 head-match-but-dirty。
  keeper.cbm = {
    nice: 0,
    version: async function () { return { version: '0.11.0', supported: true }; },
    globalConfig: async function () { return { ok: true, config: { auto_index: 'false', auto_watch: 'false' }, error: undefined }; },
    listProjects: async function () {
      return { ok: true, projects: [{ name: 'bench-repo', rootPath: root, branch: 'main' }], error: undefined };
    },
    indexStatus: async function () {
      calls.indexStatus += 1;
      return {
        ok: true,
        error: undefined,
        status: {
          project: 'bench-repo',
          indexedAt: new Date().toISOString(),
          nodes: 1000,
          edges: 2000,
          parsePartialCount: 0,
          notIndexedFilesCount: 10,
        },
      };
    },
    graphHead: async function () {
      calls.graphHead += 1;
      return { ok: true, head: BENCH_HEAD, error: undefined };
    },
    index: async function (request) {
      calls.index += 1;
      const seqAtStart = writeSeq;
      await sleep(SCALE.rebuildMs);
      if (writeSeq !== seqAtStart && request.signal?.aborted !== true) {
        // 重建途中檔案又變了：CBM 會中止該輪並保留舊圖譜。
        return { ok: false, durationMs: SCALE.rebuildMs, error: 'aborted_previous_preserved：bench', command: 'bench' };
      }
      return { ok: true, durationMs: SCALE.rebuildMs, error: undefined, command: 'bench' };
    },
  };

  // 重建次數直接從排入事件算，並記下時間軸。
  const timeline = [];
  const originalEnqueue = keeper.enqueue.bind(keeper);
  keeper.enqueue = function (key, reason, mode, opts) {
    const accepted = originalEnqueue(key, reason, mode, opts);
    if (accepted) timeline.push({ at: Date.now(), reason: reason });
    return accepted;
  };

  const startedAt = Date.now();
  await keeper.start();

  // 編輯階段：每 editIntervalMs 改一個檔案，輪流寫，模擬真實的存檔節奏。
  let editCount = 0;
  const editDeadline = Date.now() + SCALE.editPhaseMs;
  while (Date.now() < editDeadline) {
    const index = editCount % 5;
    writeSeq += 1;
    editCount += 1;
    await writeFile(
      join(root, 'src', 'file' + String(index) + '.ts'),
      'export const v' + String(index) + ' = ' + String(editCount) + ';\n',
      'utf8',
    );
    await sleep(SCALE.editIntervalMs);
  }
  const editStoppedAt = Date.now();
  await sleep(SCALE.quietPhaseMs);

  await keeper.stop();

  const triggers = log.entries.filter(function (entry) { return entry.event === 'watch.triggered'; }).length;
  const rebuildDone = log.entries.filter(function (entry) { return entry.event === 'rebuild.done'; }).length;
  const rebuildFailed = log.entries.filter(function (entry) { return entry.event === 'rebuild.failed'; }).length;
  const rebuildSkipped = log.entries.filter(function (entry) { return entry.event === 'rebuild.skipped'; }).length;
  const aborted = log.entries.filter(function (entry) {
    return entry.event === 'rebuild.failed' && String(entry.data.error ?? '').includes('aborted_previous_preserved');
  }).length;

  // 最後一次重建的完成時間（用來算「編輯停止後多久追上」）。
  const lastDone = log.entries.filter(function (entry) { return entry.event === 'rebuild.done'; }).pop();

  // 判定這輪量測是否「有效」。
  //
  // 一個沒到期的 settle 視窗與一個成功抑制的 settle 視窗，在「重建次數」上長得
  // 一模一樣（都是 0）。差別在於：成功的抑制，活動停止後仍會發生**恰好一次**追上。
  // 所以判準是「靜默後有沒有追上」，不是「重建變少了」。
  const settleWindowFits = (config.dirtySettleMs ?? 0) <= SCALE.quietPhaseMs;
  const caughtUpMs = lastDone === undefined ? null : lastDone.at - editStoppedAt;

  let verdict;
  if (!settleWindowFits) {
    verdict = 'invalid：視窗（' + String(Math.round((config.dirtySettleMs ?? 0) / 1000)) + ' s）比觀察期（'
      + String(Math.round(SCALE.quietPhaseMs / 1000)) + ' s）長，量到的 0 次不代表抑制成功';
  } else if (options.settleSeconds === 0) {
    verdict = caughtUpMs === null
      ? 'baseline：活動期間 0 次成功追上'
      : 'baseline：靜默後 ' + String(Math.round(caughtUpMs / 1000)) + ' s 追上';
  } else if (rebuildDone === 0) {
    verdict = 'fail：活動停止後仍未追上';
  } else {
    verdict = 'ok：活動期間 ' + String(timeline.filter(function (item) { return item.reason === 'watch:settled'; }).length)
      + ' 次 settle 重建，靜默後 ' + String(Math.round(caughtUpMs / 1000)) + ' s 追上';
  }

  const result = {
    settleSeconds: options.settleSeconds,
    settleSecondsBench: Math.round((config.dirtySettleMs ?? 0) / 1000),
    dirtySettleSupported: config.dirtySettleMs !== undefined,
    settleWindowFits,
    verdict,
    edits: editCount,
    triggers,
    rebuilds: timeline.length,
    rebuildDone,
    rebuildFailed,
    aborted,
    rebuildSkipped,
    settledRebuilds: timeline.filter(function (item) { return item.reason === 'watch:settled'; }).length,
    calls,
    totalSpawns: calls.readLiveHead + calls.readHeadCommittedAt + calls.isWorktreeDirty
      + calls.countCommitsBetween + calls.indexStatus + calls.graphHead + calls.index,
    caughtUpAfterEditMs: caughtUpMs,
    /** 編輯期間發生的重建次數（真正在「賽跑」的那一段）。 */
    rebuildsDuringEdit: timeline.filter(function (item) { return item.at <= editStoppedAt; }).length,
    timeline: timeline.map(function (item) { return { offsetMs: item.at - startedAt, reason: item.reason }; }),
    editPhaseMs: editStoppedAt - startedAt,
    quietPhaseMs: SCALE.quietPhaseMs,
  };

  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(function () { return undefined; });
  return result;
}

/**
 * 把一輪結果印成人看得懂的區塊。
 * @param {object} result - runScenario 的回傳值。
 * @returns {void}
 */
function printScenario(result) {
  const rows = [
    ['存檔次數', String(result.edits)],
    ['監看觸發', String(result.triggers)],
    ['排入重建', String(result.rebuilds)],
    ['　其中在編輯期間', String(result.rebuildsDuringEdit)],
    ['　其中 settle 到期', String(result.settledRebuilds)],
    ['重建成功', String(result.rebuildDone)],
    ['重建失敗', String(result.rebuildFailed)],
    ['　其中被中止', String(result.aborted)],
    ['冷卻跳過', String(result.rebuildSkipped)],
    ['注入探針總呼叫', String(result.totalSpawns)],
    ['　git 探針', String(result.calls.readLiveHead + result.calls.readHeadCommittedAt + result.calls.isWorktreeDirty + result.calls.countCommitsBetween)],
    ['　CBM 呼叫', String(result.calls.indexStatus + result.calls.graphHead + result.calls.index)],
    ['編輯停止後追上', result.caughtUpAfterEditMs === null ? '（沒追上）' : (result.caughtUpAfterEditMs / 1000).toFixed(1) + ' s'],
    ['判定', result.verdict],
  ];
  const width = rows.reduce(function (max, row) { return Math.max(max, row[0].length); }, 0);
  for (const row of rows) {
    process.stdout.write('  ' + row[0].padEnd(width, ' ') + '  ' + row[1] + '\n');
  }
}

/**
 * 回歸斷言：這個結果是否還符合「settle 視窗有效」的定義。
 *
 * 刻意寫得寬鬆——CI runner 是共用機器，事件迴圈被餓到就可能讓一次編輯的間隔超過
 * 視窗，那是排程抖動不是迴歸。真正要擋住的是 0.3.0 那種「編輯期間 10 次重建、
 * 10 次全被中止、圖譜一次都沒追上」的行為，那在任何機器上都不會是抖動。
 *
 * @param {object} result - runScenario 的回傳值。
 * @returns {string[]} 違反的條件（空陣列＝通過）。
 */
function checkAssertions(result) {
  const failures = [];
  if (!result.settleWindowFits) {
    failures.push('觀察期比 settle 視窗短，這輪量測無效');
  }
  if (result.rebuildsDuringEdit > 1) {
    failures.push('編輯期間仍排入 ' + String(result.rebuildsDuringEdit) + ' 次重建（應為 0，容許 1 次排程抖動）');
  }
  if (result.aborted > 0) {
    failures.push('仍有 ' + String(result.aborted) + ' 次重建被 aborted_previous_preserved 中止（應為 0）');
  }
  if (result.rebuildDone < 1 && result.settleWindowFits) {
    failures.push('活動停止後沒有任何成功的重建（圖譜沒有追上）');
  }
  return failures;
}

/**
 * 進入點。
 * @returns {Promise<void>} 完成。
 */
async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const asAssert = argv.includes('--assert');
  const settleIndex = argv.indexOf('--settle');
  const explicitSettle = settleIndex >= 0 ? Number(argv[settleIndex + 1]) : undefined;

  if (settleIndex >= 0 && !Number.isFinite(explicitSettle)) {
    process.stderr.write('--settle 需要一個數字（秒）\n');
    process.exitCode = 2;
    return;
  }

  // --assert 只跑一組（要斷言的那一組），預設 90 秒；沒給 --settle 就用 90。
  const settleValues = asAssert
    ? [explicitSettle === undefined ? 90 : explicitSettle]
    : (explicitSettle === undefined ? [0, 90] : [explicitSettle]);
  const results = [];

  for (const settleSeconds of settleValues) {
    if (!asJson) {
      process.stdout.write('\n=== dirtySettleSeconds = ' + String(settleSeconds) + ' ===\n');
      process.stdout.write('  （量測中，約 ' + String(Math.round((SCALE.editPhaseMs + SCALE.quietPhaseMs) / 1000)) + ' 秒）\n');
    }
    const result = await runScenario({ settleSeconds });
    results.push(result);
    if (!asJson) printScenario(result);
  }

  if (asAssert) {
    let failed = 0;
    for (const result of results) {
      const failures = checkAssertions(result);
      if (failures.length === 0) {
        process.stdout.write('\n斷言通過：settle=' + String(result.settleSeconds)
          + ' 編輯期間 ' + String(result.rebuildsDuringEdit) + ' 次重建、'
          + String(result.rebuildDone) + ' 次成功、' + String(result.aborted) + ' 次被中止\n');
        continue;
      }
      failed += 1;
      process.stderr.write('\n斷言失敗：settle=' + String(result.settleSeconds) + '\n');
      for (const failure of failures) process.stderr.write('  - ' + failure + '\n');
    }
    process.exitCode = failed === 0 ? 0 : 1;
    return;
  }

  if (asJson) {
    process.stdout.write(JSON.stringify({ scale: SCALE, results }, null, 2) + '\n');
    return;
  }

  // A/B 對照：只有在真的跑了 0 與非 0 兩組時才有意義。
  if (results.length === 2) {
    const base = results[0];
    const fixed = results[1];
    const drop = base.rebuilds === 0 ? 0 : Math.round((1 - fixed.rebuilds / base.rebuilds) * 100);
    process.stdout.write('\n=== A/B 對照 ===\n');
    process.stdout.write('  編輯期間重建    ' + String(base.rebuildsDuringEdit) + ' → ' + String(fixed.rebuildsDuringEdit) + '\n');
    process.stdout.write('  總重建          ' + String(base.rebuilds) + ' → ' + String(fixed.rebuilds) + '（' + String(drop) + '% 降幅）\n');
    process.stdout.write('  被中止          ' + String(base.aborted) + ' → ' + String(fixed.aborted) + '\n');
    process.stdout.write('  探針呼叫        ' + String(base.totalSpawns) + ' → ' + String(fixed.totalSpawns) + '\n');
  }

  if (results.some(function (item) { return item.dirtySettleSupported === false; })) {
    process.stdout.write('\n注意：lib/config.js 目前沒有 dirtySettleMs，代表這份程式碼還沒有 settle 視窗；\n');
    process.stdout.write('      非 0 的組別跑出來會與 0 相同，這是預期結果，不是量測失敗。\n');
  }
}

await main();
