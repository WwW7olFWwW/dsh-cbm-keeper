/**
 * 協調器：把「上游專案清單、落後判定、條件式重建、每專案監看」串成一台機器。
 *
 * 設計要點：
 *  - 身分鍵是 realpath(root_path)（FR-1）。同一個 root 只會有一筆記錄，name
 *    只是顯示標籤；重建時一律帶回上游既有的 name，避免 daemon 依路徑派生新名。
 *  - 只有 `stale` 才重建（FR-3）。HEAD 沒動就重跑不產生任何索引工作。
 *  - 重建一律走 CLI 子行程（FR-4），全域併發上限 1（FR-14）。
 *  - 每個外部事實（CLI、git、圖譜、檔案系統）都經由可注入的介面取得，決策本身
 *    留在純函式層，因此整台機器可以被單元測試驅動而不真的索引任何東西。
 */

import { mkdir, open, realpath, rm, stat as fsStat } from 'node:fs/promises';
import { join } from 'node:path';
import { CbmClient } from './cbm.js';
import { CliNotFoundError, resolveCliPath } from './cli.js';
import { isProjectSelected } from './config.js';
import { MAX_TRACKED_PROJECTS } from './constants.js';
import { countCommitsBetween, isWorktreeDirty, readHeadCommittedAt, readLiveHead } from './git.js';
import {
  buildGraphBase,
  buildGraphUrl,
  canonicalRootPath,
  decideStaleness,
  isDirtyOnlyStale,
  isDirtySettled,
  mergeProjectsByRootPath,
  pickRebuildMode,
} from './staleness.js';
import { createProjectWatcher } from './watcher.js';

/** 重建鎖的檔名（相對於狀態目錄）。 */
const REBUILD_LOCK_NAME = 'rebuild.lock';

/** 超過這個年齡的鎖檔視為崩潰殘留，可強制接管。 */
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

/**
 * `stop()` 等待正在跑的重建收尾的上限。
 *
 * 子行程在上一步已經被 abort，正常情況不會走到這裡；這個上限只保證關機不會被
 * 一個卡死的子行程永久擋住。
 */
const STOP_JOIN_TIMEOUT_MS = 15000;

/**
 * 探測 CBM 圖譜 UI 的逾時。
 *
 * 它掛在掃描路徑上，所以刻意短：UI 沒開時我們只想盡快知道「沒開」，
 * 不想讓一輪掃描被一個不會回應的 loopback 位址拖住。
 */
const GRAPH_UI_PROBE_TIMEOUT_MS = 1000;

/** 統計欄位的單一來源：總計與 24 小時滾動視窗共用同一組（WS5）。 */
const STATS_FIELDS = [
  'rebuildsQueued',
  'rebuildsSucceeded',
  'rebuildsFailed',
  'rebuildsAborted',
  'skippedCooldown',
  'skippedGate',
  'settled',
  'settleDeferred',
  'checksShortCircuited',
  'rebuildMs',
];

/** 滾動視窗的小時桶數（＝ 24 小時）。 */
const STATS_WINDOW_BUCKETS = 24;

/**
 * 「重建正在跟編輯器賽跑」的判定門檻（WS7 的警告）。
 *
 * 訊號是 `RebuildsAborted`：CBM 以 `aborted_previous_preserved` 中止該輪，代表
 * 重建跑到一半檔案又變了——那一輪的索引工作整個白費，圖譜也沒有前進。這是
 * 「追逐」唯一直接、可觀測的證據（`SkippedCooldown` 只是被冷卻擋下，不是白跑）。
 *
 * 為什麼是這兩個數字：
 *   - **3 次**：一兩次中止可能是巧合（安裝依賴、產生器、格式化工具剛好在那段時間
 *     寫檔），三次以上才是「一直在追」的模式；
 *   - **一半**：中止數要佔「已完成的重建」一半以上，才叫「多數重建都白跑」；
 *     偶爾被中止不該被勸去改設定。
 * A/B 實測（`node tools/bench-dirty-chase.mjs`，50 次存檔的連續編輯情境）在
 * `dirtySettleSeconds=0` 時是 10 次重建全部被中止（100%＝10/10），設 90 秒後
 * 是 0 次——這組門檻把兩邊乾淨分開（10/10 觸發、0/1 不觸發），又不會被一次
 * 偶發中止觸發。
 */
const DIRTY_CHASE_MIN_ABORTED = 3;
const DIRTY_CHASE_MIN_ABORTED_SHARE = 0.5;

/** 一個小時桶的毫秒數。 */
const STATS_BUCKET_MS = 60 * 60 * 1000;

/**
 * 產生一份全零的計數。
 * @returns {Record<string, number>} 每個欄位都是 0。
 */
function createStatsCounters() {
  const counters = {};
  for (const field of STATS_FIELDS) counters[field] = 0;
  return counters;
}

/**
 * 把欄位名改成輸出用的駝峰（`rebuildsQueued` → `RebuildsQueued`）。
 * @param {string} field - 欄位名。
 * @returns {string} 首字大寫的欄位名。
 */
function statsKeySuffix(field) {
  return field.charAt(0).toUpperCase() + field.slice(1);
}

/**
 * 重建成效的累計統計（WS5）。
 *
 * **生命週期＝本次啟動以來**（行程記憶體內，不落盤、不回填日誌檔）。選這條路的
 * 理由有三個，都不是妥協：
 *   1. keeper.log 是**人可讀**格式（`k=v`，值含空白時用 JSON.stringify 跳脫），
 *      把它當機器格式回填，等於在最脆弱的一環再複製一份解析器；
 *   2. 日誌檔有 5 MB 輪替且只留 `.1`，回填出來的「歷史」本身殘缺——那比誠實的
 *      「本次啟動以來」更容易誤導；
 *   3. `status()` 是 UI 每 3 秒輪詢的路徑，回填要讀最多 10 MB 的檔案。
 * 因此欄位名一律帶 `sinceStart*`／`last24h*` 前綴：呼叫端不可能把它誤讀成歷史總計。
 *
 * `last24h*` 是「本次啟動以來、且落在最近 24 小時內」的**子集**，以整點小時桶
 * 近似（邊界誤差最多 1 小時）；行程剛啟動時它與 `sinceStart*` 相同。它**不是**
 * 跨重啟的歷史數字。
 *
 * 不計入任何計數的情況（刻意，免得數字看起來比事實更滿）：
 *   - 被鎖檔擋下、根本沒啟動的重建（`rebuild.lock-busy`）：它沒跑，不算成功也不算失敗；
 *   - 卸載途中被放棄的重建（`rebuild.abandoned`）：那一輪沒有結果可言；
 *   - 未納管（上游已無此專案／被 include／exclude 排除）而排不進佇列的請求。
 *
 * 十個欄位（每個都有 `sinceStart*` 與 `last24h*` 兩個鍵）：
 *   - `RebuildsQueued`：排進佇列的次數（含人工／強制重建）。
 *   - `RebuildsSucceeded`：跑完且上游回報成功的次數（含「成功但 HEAD 沒追上」，那另有警告）。
 *   - `RebuildsFailed`：跑完但失敗的次數，**不含**被中止的（見下）。
 *   - `RebuildsAborted`：錯誤訊息命中 `aborted_previous_preserved` 的次數——「重建途中
 *     檔案又變」的直接指標。它與 `RebuildsFailed` **互斥**，相加才是全部的失敗嘗試。
 *   - `SkippedCooldown`：冷卻期擋下的自動重建次數（＝省下的重建）。
 *   - `SkippedGate`：掃描閘門擋下的次數（沒有活動／尚未靜默），每輪掃描各計一次。
 *   - `Settled`：走完 settle 視窗、最後真的排入的重建次數。
 *   - `SettleDeferred`：觸發被往後推（武裝／重排 settle 計時器）的次數。
 *   - `ChecksShortCircuited`：settle 視窗內只做 HEAD 探測、而省下的完整檢查次數（WS6）。
 *   - `RebuildMs`：累計重建 wall time（毫秒；`runRebuild` 自己量的，不是 CLI 宣稱的值）。
 */
export class RebuildStats {
  /**
   * @param {object} [options] - 建構選項。
   * @param {number} [options.now] - 起始時刻的 epoch 毫秒（測試注入）。
   */
  constructor(options) {
    const settings = options ?? {};
    const now = typeof settings.now === 'number' && Number.isFinite(settings.now) ? settings.now : Date.now();
    /** @type {string} 統計的起算時間（ISO）。 */
    this.startedAt = new Date(now).toISOString();
    /** @type {Record<string, number>} 本次啟動以來的總計。 */
    this.totals = createStatsCounters();
    /** @type {Map<number, Record<string, number>>} 小時桶索引 → 該小時的計數。 */
    this.buckets = new Map();
  }

  /**
   * 桶索引（整點小時）。
   * @param {number} now - epoch 毫秒。
   * @returns {number} 桶索引。
   */
  bucketIndex(now) {
    return Math.floor(now / STATS_BUCKET_MS);
  }

  /**
   * 取得（必要時建立）現在所屬的小時桶，順手丟掉視窗外的舊桶。
   * @param {number} now - epoch 毫秒。
   * @returns {Record<string, number>} 該小時的計數。
   */
  bucket(now) {
    const index = this.bucketIndex(now);
    let current = this.buckets.get(index);
    if (current === undefined) {
      current = createStatsCounters();
      this.buckets.set(index, current);
      const oldest = index - (STATS_WINDOW_BUCKETS - 1);
      for (const key of Array.from(this.buckets.keys())) {
        if (key < oldest) this.buckets.delete(key);
      }
    }
    return current;
  }

  /**
   * 累加一個計數（同時進總計與現在的小時桶）。
   * @param {string} field - {@link STATS_FIELDS} 之一；未知欄位會被忽略。
   * @param {number} [amount] - 累加量（次數給 1、耗時給毫秒）；非數字時視為 1。
   * @param {number} [now] - 現在的 epoch 毫秒（測試注入）。
   * @returns {void}
   */
  count(field, amount, now) {
    if (!Object.prototype.hasOwnProperty.call(this.totals, field)) return;
    const value = typeof amount === 'number' && Number.isFinite(amount) ? amount : 1;
    this.totals[field] += value;
    const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    this.bucket(at)[field] += value;
  }

  /**
   * 最近 24 小時的同一組計數（小時桶加總；未來的桶不算）。
   * @param {number} now - epoch 毫秒。
   * @returns {Record<string, number>} 視窗內的計數。
   */
  windowCounters(now) {
    const out = createStatsCounters();
    const newest = this.bucketIndex(now);
    const oldest = newest - (STATS_WINDOW_BUCKETS - 1);
    for (const entry of this.buckets) {
      const index = entry[0];
      if (index < oldest || index > newest) continue;
      for (const field of STATS_FIELDS) out[field] += entry[1][field];
    }
    return out;
  }

  /**
   * 對外快照：**扁平的數字物件**，每個欄位都有值（沒發生過就是 0），UI 可直接格式化。
   *
   * 每個概念有兩個鍵：`sinceStart<名>`（本次啟動以來）與 `last24h<名>`（其中落在
   * 最近 24 小時內的部分）。語意見類別說明。
   *
   * @param {number} [now] - 現在的 epoch 毫秒（測試注入）。
   * @returns {Record<string, number>} 統計快照。
   */
  snapshot(now) {
    const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    const recent = this.windowCounters(at);
    const out = {};
    for (const field of STATS_FIELDS) {
      out['sinceStart' + statsKeySuffix(field)] = this.totals[field];
      out['last24h' + statsKeySuffix(field)] = recent[field];
    }
    return out;
  }
}

/**
 * 監看器的參數指紋：排除規則、副檔名白名單與防抖在建立時就固定了，
 * 設定一改就得把監看器換掉，否則「改了設定卻只有暫停再恢復才生效」。
 * @param {object} config - 執行期設定。
 * @returns {string} 指紋字串。
 */
function watcherKey(config) {
  return JSON.stringify([config.debounceMs, config.extensions, config.excludes]);
}

/**
 * 一個會自己解決的計時器，用來給等待加上限。
 * @param {number} ms - 毫秒。
 * @returns {Promise<void>} 時間到即解決。
 */
function delayMs(ms) {
  return new Promise(function (resolve) {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * 把 root 正規化為 realpath 形式的身分鍵。
 * @param {string} root - 原始路徑。
 * @returns {Promise<string>} 正規化後的路徑；解析失敗時退回字串正規化。
 */
export async function canonicalizeRoot(root) {
  const normalized = canonicalRootPath(root);
  if (normalized.length === 0) return normalized;
  try {
    return canonicalRootPath(await realpath(normalized));
  } catch {
    // 路徑不存在（專案已搬走／權限不足）：字串正規化仍是可用的身分鍵。
    return normalized;
  }
}

/**
 * 預設的圖譜 UI 探測：對 CBM UI 的 `/api/ui-config` 發一次 GET（1 秒逾時）。
 *
 * 只讀、只走 loopback；逾時刻意短，因為它掛在掃描路徑上。
 *
 * @param {string} url - 要探測的網址。
 * @returns {Promise<{ok: boolean, error?: string}>} 結果。
 */
async function probeGraphUiHttp(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(GRAPH_UI_PROBE_TIMEOUT_MS) });
    return response.ok === true ? { ok: true } : { ok: false, error: 'HTTP ' + String(response.status) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * CBM 圖譜保鮮的協調器。
 */
export class CbmKeeper {
  /**
   * @param {object} options - 建構選項。
   * @param {string} options.home - 插件狀態目錄（絕對路徑）。
   * @param {() => object} options.config - 讀取執行期設定的供應器。
   * @param {import('./log.js').KeeperLog} options.log - 日誌器。
   * @param {import('./state.js').KeeperState} options.state - 狀態。
   * @param {object} [options.deps] - 可注入的協作對象（測試用）。
   */
  constructor(options) {
    this.home = options.home;
    this.config = options.config;
    this.log = options.log;
    this.state = options.state;
    /** @type {Map<string, object>} 身分鍵 → 專案記錄。 */
    this.records = new Map();
    /** @type {Map<string, object>} 身分鍵 → 監看器。 */
    this.watchers = new Map();
    /** @type {Map<string, {indexedAt: string|undefined, head: string|undefined}>} 圖譜 HEAD 快取。 */
    this.graphHeadCache = new Map();
    /** @type {Array<{key: string, reason: string, requestedAt: string, mode?: string}>} 重建佇列。 */
    this.queue = [];
    /** @type {Promise<void>|undefined} 目前那一輪佇列消耗；`stop()` 靠它做真正的 join。 */
    this.drainPromise = undefined;
    /** @type {Set<Promise<void>>} 尚未落盤的狀態寫入。 */
    this.pendingWrites = new Set();
    this.running = undefined;
    this.abortController = undefined;
    this.scanTimer = undefined;
    this.stopped = true;
    this.revision = 0;
    /** @type {RebuildStats} 重建成效統計（WS5；本次啟動以來）。 */
    this.stats = new RebuildStats();
    this.cli = { path: undefined, source: undefined, error: undefined, candidates: [] };
    this.version = { value: undefined, supported: null };
    this.upstreamConfig = {};
    // D4：這裡必須先給 undefined。少了這一行，「還沒探測過上游設定」的實例在
    // `graphUiNote()`／`rebuildWarnings()` 讀它時拿到 undefined 是僥倖（V8 的
    // 隱藏類別也因為這個欄位後來才長出來而分歧），而任何以 `in`／列舉做的檢查
    // 會看到一個時有時無的鍵。
    this.upstreamConfigError = undefined;
    this.warnings = [];
    this.lastRefreshAt = undefined;
    this.lastRefreshError = undefined;
    this.refreshPromise = undefined;
    /** @type {{state: string, base: string|undefined, url: string|undefined, port: number|undefined, source: string|undefined, reachable: boolean|undefined, checkedAt: string|undefined, error: string|undefined}} 圖譜 UI 的可見狀態。 */
    this.graphUi = {
      state: 'unknown', base: undefined, url: undefined, port: undefined, source: undefined,
      reachable: undefined, checkedAt: undefined, error: undefined,
    };
    this.deps = {
      resolveCliPath,
      createWatcher: createProjectWatcher,
      readLiveHead,
      readHeadCommittedAt,
      countCommitsBetween,
      isWorktreeDirty,
      canonicalizeRoot,
      probeGraphUiHttp,
      ...(options.deps ?? {}),
    };
    this.cbm = new CbmClient({
      cliPath: function () { return this.cli.path === undefined ? undefined : { path: this.cli.path, source: this.cli.source }; }.bind(this),
      log: options.log,
      nice: 0,
    });
  }

  /**
   * 標記狀態已變更（讓 UI 能以一個整數判斷是否需要重繪）。
   * @returns {void}
   */
  touch() {
    this.revision += 1;
  }

  /**
   * 啟動自動化：載入狀態、解析 CLI、探測上游、首次掃描、建立掃描計時器。
   * @returns {Promise<void>} 啟動完成。
   */
  async start() {
    this.stopped = false;
    const loaded = await this.state.load();
    if (loaded.loaded) {
      this.log.info('state.loaded', { file: this.state.file, projects: Object.keys(this.state.data.projects).length });
    }
    await this.resolveCli();
    await this.probeUpstream();
    await this.refresh('startup');
    this.recoverIntent();
    this.scheduleScan();
    this.touch();
  }

  /**
   * 停止所有自動化並釋放資源。
   * @returns {Promise<void>} 停止完成。
   */
  async stop() {
    this.stopped = true;
    if (this.scanTimer !== undefined) {
      clearTimeout(this.scanTimer);
      this.scanTimer = undefined;
    }
    if (this.abortController !== undefined) {
      this.abortController.abort();
      this.abortController = undefined;
    }
    // B1：掃描也可能正在飛（start()／計時器／路由都會進來）。不等它收尾就直接拆
    // 監看器，它會在 stop() 之後才走到 reconcileWatchers()，建出一個**永遠不會被
    // 停掉**的監看器——實測 stop() 回傳後 watchers.size 仍是 1，卸載後還在監看。
    // CLI 讀取沒有可取消的訊號，所以這裡只加上限護欄，不讓關機被拖住。
    if (this.refreshPromise !== undefined) {
      await Promise.race([
        this.refreshPromise.catch(function () { return undefined; }),
        delayMs(STOP_JOIN_TIMEOUT_MS),
      ]);
    }
    // C1：已武裝的 idle-settle 計時器必須在這裡熄掉，否則它會在卸載後才醒來並排入
    // 一次重建（那正是 B1 要消滅的那種「stop() 之後還有東西在動」）。
    this.clearSettleTimers();
    const keys = Array.from(this.watchers.keys());
    for (const key of keys) {
      await this.stopWatcher(key);
    }
    this.queue = [];
    // 真正的 join：等正在跑的重建收尾。少了這一步，卸載後立刻 `rm -rf` 狀態目錄
    // 會被重建尾巴那一次 `setProject` 落盤把目錄又建回來。上面已經 abort 了子行程，
    // 所以正常情況是毫秒級；逾時只是護欄，不讓關機被一個卡住的子行程永久擋住。
    if (this.drainPromise !== undefined) {
      await Promise.race([this.drainPromise, delayMs(STOP_JOIN_TIMEOUT_MS)]);
    }
    // 排隊寫入的狀態不阻塞呼叫端，但停止時必須等它們落地，否則行程結束後
    // 狀態檔會停在一個半完成的樣子，崩潰恢復就失去依據。
    await Promise.all(Array.from(this.pendingWrites));
    this.log.info('keeper.stopped', {});
  }

  /**
   * 從狀態檔恢復上次崩潰時仍在佇列上的重建意圖（NFR-6）。
   * @returns {void}
   */
  recoverIntent() {
    const projects = this.state.data.projects ?? {};
    let recovered = 0;
    for (const key of Object.keys(projects)) {
      const persisted = projects[key];
      const phase = persisted === null || typeof persisted !== 'object' ? undefined : persisted.rebuildState;
      if (phase === 'queued' || phase === 'running') {
        recovered += 1;
        this.enqueue(key, 'crash-recovery');
      }
    }
    if (recovered > 0) {
      this.log.warn('rebuild.recovered', { count: recovered });
    }
  }

  /**
   * 建立下一次掃描的計時器。
   * @returns {void}
   */
  scheduleScan() {
    if (this.stopped) return;
    const config = this.config();
    if (this.scanTimer !== undefined) clearTimeout(this.scanTimer);
    // 計時器一律重排：`enabled` 只決定這一輪要不要真的掃描，不決定還要不要再來。
    // 兩者混在一起會讓「關掉再打開」需要重啟才生效，那不是 volatile 設定的語意。
    this.scanTimer = setTimeout(function () {
      this.scanTimer = undefined;
      const current = this.config();
      if (current.enabled) {
        void this.refresh('timer').finally(function () { this.scheduleScan(); }.bind(this));
        return;
      }
      this.scheduleScan();
    }.bind(this), config.scanMs);
    if (typeof this.scanTimer.unref === 'function') this.scanTimer.unref();
  }

  /**
   * 解析 CLI 執行檔並更新可見狀態（FR-5）。
   * @returns {Promise<boolean>} 解析成功則 true。
   */
  async resolveCli() {
    const config = this.config();
    try {
      const resolved = await this.deps.resolveCliPath({
        explicit: config.cliPath,
        env: process.env,
      });
      const changed = this.cli.path !== resolved.path;
      this.cli = { path: resolved.path, source: resolved.source, error: undefined, candidates: [] };
      if (changed) this.log.info('cli.resolved', { path: resolved.path, source: resolved.source });
      return true;
    } catch (error) {
      if (error instanceof CliNotFoundError) {
        this.cli = { path: undefined, source: undefined, error: error.message, candidates: error.candidates };
      } else {
        this.cli = {
          path: undefined,
          source: undefined,
          error: error instanceof Error ? error.message : String(error),
          candidates: [],
        };
      }
      this.log.error('cli.unresolved', { error: this.cli.error, tried: this.cli.candidates.length });
      return false;
    }
  }

  /**
   * 讀取上游版本與全域設定，產生 R6／FR-15 的警告。
   * @returns {Promise<void>} 探測完成。
   */
  async probeUpstream() {
    if (this.cli.path === undefined) {
      this.version = { value: undefined, supported: null };
      this.upstreamConfig = {};
      this.rebuildWarnings();
      return;
    }
    this.cbm.nice = this.config().nice;
    const version = await this.cbm.version();
    this.version = { value: version.version, supported: version.supported };
    const config = await this.cbm.globalConfig();
    this.upstreamConfig = config.ok ? config.config : {};
    // 讀不到就留住原因：以前這裡吞掉錯誤，於是圖譜 UI 的埠只能靠預設值推導，
    // 探測失敗後卡片卻說「圖譜 UI 未回應」——把「讀不到設定」誤報成「UI 掛了」。
    this.upstreamConfigError = config.ok ? undefined : (config.error ?? '讀不到 CBM 設定');
    if (version.version !== undefined && version.supported === false) {
      this.log.warn('cli.version.unexpected', { version: version.version });
    }
    this.rebuildWarnings();
  }

  /**
   * 探測 CBM 的圖譜 UI 是否可用。
   *
   * 只讀：不對 CBM 設定做任何寫入，UI 的開關仍由使用者用
   * `codebase-memory-mcp --ui=true` 決定。三態是刻意的——沒開就說沒開、
   * 開了但連不上就說連不上，只有真的可用才給連結，免得卡片上出現一個
   * 點進去 404 的按鈕。
   *
   * @returns {Promise<void>} 探測完成（結果寫進 `this.graphUi`）。
   */
  /**
   * 圖譜 UI 這條線的「為什麼會這樣」：設定的覆寫被忽略、或讀不到上游設定。
   * @returns {string|undefined} 給卡片顯示的一句話；沒有異常時 undefined。
   */
  graphUiNote() {
    const notes = [];
    if (this.config().graphUrlInvalid === true) {
      notes.push('設定的 graphUrl 不是 http(s) 網址，已忽略並改用推導值。');
    }
    if (this.upstreamConfigError !== undefined) {
      notes.push('讀不到 CBM 設定，圖譜 UI 的埠改用預設值推導。');
    }
    return notes.length === 0 ? undefined : notes.join(' ');
  }

  async probeGraphUi() {
    const config = this.config();
    const previous = this.graphUi;
    const base = buildGraphBase({
      override: config.graphUrl,
      uiEnabled: this.upstreamConfig.ui_enabled,
      uiPort: this.upstreamConfig.ui_port,
    });
    if (base.state !== 'ok') {
      this.graphUi = {
        ...base,
        url: undefined,
        reachable: undefined,
        checkedAt: new Date().toISOString(),
        error: undefined,
        note: this.graphUiNote(),
      };
      return;
    }
    const probed = await this.deps.probeGraphUiHttp(base.base + '/api/ui-config');
    this.graphUi = {
      ...base,
      url: buildGraphUrl(base.base, { tab: 'graph' }),
      reachable: probed.ok === true,
      checkedAt: new Date().toISOString(),
      error: probed.ok === true ? undefined : (probed.error ?? 'UI 沒有回應'),
      note: this.graphUiNote(),
    };
    // 只在狀態翻轉時說話：這條每輪掃描都會跑，成功也記一筆就只是噪音。
    if (previous.reachable !== this.graphUi.reachable) {
      this.log.info('graphUi.changed', {
        source: base.source,
        port: base.port,
        reachable: this.graphUi.reachable,
        error: this.graphUi.error,
      });
    }
  }

  /**
   * 這個部署是不是正在用重建追著編輯器跑？（WS7）
   *
   * 只在「使用者還沒填 `dirtySettleSeconds`」時才提醒，而且要有**最近的**證據：
   * 判準走 `last24h*`（本次啟動以來、且落在 24 小時視窗內），所以症狀消失之後
   * 警告會自己跟著消失。統計全 0 的新安裝永遠不會觸發——第一次掃描就被嘮叨是
   * 最糟的體驗，這一條必須等到「真的觀察到追逐」才出現。
   *
   * `includeDirty === false` 時也不提醒：那種部署不會產生 dirty-only 的落後，
   * settle 視窗幫不上忙，給了建議反而是誤導。
   *
   * @returns {{code: string, message: string, data: {aborted: number, completed: number, percent: number}}|undefined}
   *   警告物件；`data` 是給 UI 在地化用的結構化參數（沒有徵兆時整條 undefined）。
   */
  dirtyChaseWarning() {
    const config = this.config();
    if (config.dirtySettleMs > 0 || config.includeDirty !== true) return undefined;
    const stats = this.stats.snapshot();
    const aborted = stats.last24hRebuildsAborted;
    if (aborted < DIRTY_CHASE_MIN_ABORTED) return undefined;
    // 分母是「已完成的重建」：排入但還沒跑完的不算，被鎖擋下的也不算（它沒跑）。
    const completed = aborted + stats.last24hRebuildsSucceeded + stats.last24hRebuildsFailed;
    if (completed <= 0 || aborted / completed < DIRTY_CHASE_MIN_ABORTED_SHARE) return undefined;
    const percent = Math.round((aborted / completed) * 100);
    return {
      code: 'dirty-chase-detected',
      message: '偵測到圖譜重建正在跟你的編輯賽跑：最近 24 小時內有 ' + String(aborted) + ' 次重建在途中被中止'
        + '（佔 ' + String(completed) + ' 次已完成嘗試的 ' + String(percent) + '%）——重建跑到一半檔案又變，'
        + '那一輪就白跑了，圖譜也沒有前進。實測把設定頁的 dirtySettleSeconds 設成 90'
        + '（未提交變更的專案靜默 90 秒才重建）可以消除這個現象（A/B：編輯期間的重建 10 次 → 0 次、'
        + '被中止 10 次 → 0 次，停手後圖譜仍追上）；設 0 則維持現行行為（一有活動就重建）。'
        + '要不要改、改成幾秒，由你決定。',
      // 結構化參數：`message` 是 fallback（舊 client、未知 code、佔位符沒填上時都會用到），
      // 卡片要在地化就得靠這一組。鍵名**已凍結**——client 的 WARNING_PARAMS 認這三個名字。
      data: { aborted: aborted, completed: completed, percent: percent },
    };
  }

  /**
   * 依目前事實重建警告清單（FR-10：失敗與風險都必須具名可見）。
   * @returns {void}
   */
  rebuildWarnings() {
    const warnings = [];
    if (this.cli.error !== undefined) {
      warnings.push({ code: 'cli-missing', message: this.cli.error, candidates: this.cli.candidates });
    }
    if (this.version.value !== undefined && this.version.supported === false) {
      warnings.push({
        code: 'version-unexpected',
        message: 'codebase-memory-mcp 版本 ' + this.version.value + ' 不在實測支援清單內；輸出格式若改變，落後判定可能降級為時間旁證。',
      });
    }
    const autoIndex = this.upstreamConfig.auto_index;
    if (autoIndex === 'true') {
      warnings.push({
        code: 'auto-index-on',
        message: 'CBM 內建的 auto_index 目前是 true：每個 session 都會無條件全量重建，會與本插件重複勞動。建議執行 `codebase-memory-mcp config set auto_index false`。',
      });
    }
    // WS7：也是「你可以改一個設定」的建議，排在另一條同類建議之後、純資訊之前。
    const chase = this.dirtyChaseWarning();
    if (chase !== undefined) warnings.push(chase);
    const autoWatch = this.upstreamConfig.auto_watch;
    if (autoWatch === 'true' && this.upstreamConfig.watcher_enabled === 'true') {
      warnings.push({
        code: 'upstream-watcher-on',
        message: 'CBM 內建的 watcher（auto_watch／watcher_enabled）仍是 true；實測它不會產生可觀測的重建，但留著沒有壞處，僅供知情。',
      });
    }
    if (this.upstreamConfigError !== undefined) {
      warnings.push({
        code: 'upstream-config-unreadable',
        message: '讀不到 CBM 設定（' + this.upstreamConfigError + '）：圖譜 UI 的位置只能改用預設埠推導，下面的連結不保證正確。',
      });
    }
    this.warnings = warnings;
  }

  /**
   * 掃描上游專案、更新落後狀態、調整監看器，並在需要時排入重建。
   *
   * 併發呼叫會被合併到同一次掃描：UI 連續點「立即檢查」不該產生 N 次 CLI 往返。
   *
   * @param {string} reason - 觸發原因（startup | timer | manual | watcher）。
   * @returns {Promise<{ok: boolean, error: string|undefined, projects: number}>} 掃描結果。
   */
  async refresh(reason) {
    if (this.refreshPromise !== undefined) return this.refreshPromise;
    this.refreshPromise = this.runRefresh(reason).finally(function () { this.refreshPromise = undefined; }.bind(this));
    return this.refreshPromise;
  }

  /**
   * 實際執行一次掃描（由 refresh 獨佔）。
   * @param {string} reason - 觸發原因。
   * @returns {Promise<{ok: boolean, error: string|undefined, projects: number}>} 掃描結果。
   */
  async runRefresh(reason) {
    const config = this.config();
    if (this.cli.path === undefined) {
      await this.resolveCli();
      if (this.cli.path === undefined) {
        this.lastRefreshError = this.cli.error ?? 'CLI 未解析';
        this.rebuildWarnings();
        this.touch();
        return { ok: false, error: this.lastRefreshError, projects: 0 };
      }
    }
    this.cbm.nice = config.nice;
    await this.probeGraphUi();
    this.log.info('scan.start', { reason, projects: this.records.size });

    const listed = await this.cbm.listProjects();
    if (!listed.ok) {
      this.lastRefreshError = listed.error;
      this.log.error('scan.failed', { reason, error: listed.error });
      this.touch();
      return { ok: false, error: listed.error, projects: this.records.size };
    }
    this.lastRefreshError = undefined;

    const existing = Array.from(this.records.values()).map(function (record) {
      return { name: record.name, rootPath: record.rootPath, branch: record.branch };
    });
    const merged = mergeProjectsByRootPath(existing, listed.projects);
    for (const rename of merged.renamed) {
      this.log.info('project.renamed', { key: rename.key, from: rename.from, to: rename.to });
    }
    for (const duplicate of merged.duplicates) {
      this.log.warn('project.duplicate', { key: duplicate.key, names: duplicate.names.join(',') });
    }

    // 納管迴圈的權威是「上游這次回報了什麼」，不是既有的 union 表。
    // mergeProjectsByRootPath 只做併入與改名偵測，它會保留上游已經沒有的專案——
    // 拿它來決定誰該被納管，會讓已刪除的專案永遠停在 selected。
    const seen = new Set();
    // D1：上游這次回報過的鍵（不論有沒有被選取）。孤兒的定義是「上游已經沒有
    // 這棵樹」（docs/LIMITATIONS.md）；被 includeProjects／excludeProjects 排除的
    // 專案樹還在上游，只是不納管，不能標成孤兒。
    const reported = new Set();
    for (const project of listed.projects) {
      const key = await this.identityOf(project.rootPath);
      if (key.length === 0) continue;
      reported.add(key);
      const selected = isProjectSelected(project.name, config);
      let record = this.records.get(key);
      if (record === undefined) {
        if (this.records.size >= MAX_TRACKED_PROJECTS) {
          this.log.warn('project.limit-reached', { limit: MAX_TRACKED_PROJECTS, skipped: project.name });
          continue;
        }
        record = this.createRecord(key, project);
        this.records.set(key, record);
        this.log.info('project.adopted', { name: project.name, root: key });
      } else {
        // FR-1：既有的 name 是權威。上游改了名字只記一筆日誌，不新建、不改名。
        record.rootPath = key;
        record.branch = project.branch ?? record.branch;
      }
      record.selected = selected;
      record.orphaned = false;
      if (selected) seen.add(key);
    }

    for (const record of this.records.values()) {
      if (seen.has(record.key)) continue;
      // D1：上游這次仍回報它，只是被設定排除：selected=false 但不孤兒。
      // 上一輪迴圈已經把它設成 selected=false／orphaned=false，這裡不做事。
      if (reported.has(record.key)) continue;
      if (record.selected === false && record.orphaned === true) continue;
      record.selected = false;
      record.orphaned = true;
      this.log.info('project.orphaned', { name: record.name, root: record.key });
    }

    const keys = Array.from(seen);
    const pendingRebuilds = [];
    for (const key of keys) {
      const record = this.records.get(key);
      if (record === undefined) continue;
      await this.checkProject(record, false);
      if (config.autoRebuild && record.stale === true) {
        if (this.shouldAutoRebuild(record)) {
          pendingRebuilds.push(key);
        } else {
          // WS5：閘門擋下的重建就是「省下來的工作」，要算得出來才說得出口。
          this.stats.count('skippedGate');
        }
      }
    }
    await this.reconcileWatchers();
    for (const key of pendingRebuilds) this.enqueue(key, 'stale:' + String(reason));

    this.lastRefreshAt = new Date().toISOString();
    this.log.info('scan.done', {
      reason,
      projects: keys.length,
      stale: Array.from(this.records.values()).filter(function (record) { return record.stale === true; }).length,
      queued: pendingRebuilds.length,
    });
    // WS7：每輪掃描重算警告。dirty-chase 的證據來自統計，統計會在掃描之間變動，
    // 只在啟動時算一次的話，那條警告永遠看不到。
    this.rebuildWarnings();
    this.touch();
    return { ok: true, error: undefined, projects: keys.length };
  }

  /**
   * 建立一筆新的專案記錄。
   * @param {string} key - 身分鍵（正規化後的 root）。
   * @param {{name: string, rootPath: string, branch?: string}} project - 上游專案。
   * @returns {object} 記錄。
   */
  createRecord(key, project) {
    const persisted = this.state.project(key);
    return {
      key,
      name: project.name,
      rootPath: key,
      branch: project.branch ?? '',
      selected: true,
      orphaned: false,
      graphHead: undefined,
      liveHead: undefined,
      behindBy: null,
      stale: null,
      confidence: 'none',
      reasons: [],
      dirty: false,
      indexedAt: undefined,
      nodes: undefined,
      edges: undefined,
      parsePartialCount: undefined,
      notIndexedFilesCount: undefined,
      lastCheckAt: undefined,
      lastCheckedError: undefined,
      lastIndexedAt: persisted.lastIndexedAt,
      lastDurationMs: persisted.lastDurationMs,
      lastError: persisted.lastError,
      rebuildState: 'idle',
      rebuildRequestedAt: undefined,
      rebuildStartedAt: undefined,
      rebuildReason: undefined,
      // 監看意圖是使用者決策，不是這次行程的暫時狀態：暫停過的專案重啟後仍應保持暫停。
      watcherPaused: persisted.watcherPaused === true,
      watcher: { status: 'stopped', backend: 'none', triggers: 0, lastTriggerAt: undefined },
    };
  }

  /**
   * 取得（必要時解析）root 的身分鍵。
   * @param {string} rootPath - 原始路徑。
   * @returns {Promise<string>} 身分鍵。
   */
  async identityOf(rootPath) {
    return this.deps.canonicalizeRoot(rootPath);
  }

  /**
   * 更新單一專案的落後狀態（FR-2）。
   * @param {object} record - 專案記錄。
   * @param {boolean} force - 是否略過圖譜 HEAD 快取。
   * @returns {Promise<void>} 更新完成。
   */
  async checkProject(record, force) {
    const config = this.config();
    record.lastCheckAt = new Date().toISOString();
    record.lastCheckedError = undefined;

    const live = await this.deps.readLiveHead(record.rootPath);
    const liveHead = live.ok ? live.head : undefined;
    // C3：includeDirty=false 時未提交變更根本不算落後，那就不該付一次 `git status`
    // ——每個專案每輪掃描一次，活躍專案每小時數十次。dirty 直接給 false＝「沒有把
    // 它算進落後判定」，與判定的語意一致（不宣稱工作樹是乾淨的）。
    const dirty = config.includeDirty !== true || liveHead === undefined
      ? false
      : await this.deps.isWorktreeDirty(record.rootPath);

    const status = await this.cbm.indexStatus(record.name);
    let graphHead;
    let indexedAt;
    if (status.ok && status.status !== undefined) {
      indexedAt = status.status.indexedAt;
      record.nodes = status.status.nodes ?? record.nodes;
      record.edges = status.status.edges ?? record.edges;
      record.parsePartialCount = status.status.parsePartialCount ?? record.parsePartialCount;
      record.notIndexedFilesCount = status.status.notIndexedFilesCount ?? record.notIndexedFilesCount;
      const cached = this.graphHeadCache.get(record.key);
      if (!force && cached !== undefined && cached.indexedAt === indexedAt) {
        graphHead = cached.head;
      } else {
        const head = await this.cbm.graphHead(record.name);
        graphHead = head.ok ? head.head : undefined;
        this.graphHeadCache.set(record.key, { indexedAt, head: graphHead });
      }
    } else {
      record.lastCheckedError = status.error;
      graphHead = undefined;
    }
    record.indexedAt = indexedAt;

    // C4：headCommittedAt 只有時間旁證那條退路（圖譜沒有 Branch 節點）會用到。
    // 以前它無條件先讀，於是每次檢查都多付一次 `git log -1`，而結果九成被丟掉。
    const headCommittedAt = graphHead === undefined && liveHead !== undefined
      ? await this.deps.readHeadCommittedAt(record.rootPath)
      : undefined;

    let behindBy = null;
    if (graphHead !== undefined && liveHead !== undefined && graphHead !== liveHead) {
      behindBy = await this.deps.countCommitsBetween(record.rootPath, graphHead, liveHead);
    }

    const decision = decideStaleness({
      graphHead,
      liveHead,
      behindBy,
      dirty,
      includeDirty: config.includeDirty,
      indexedAt,
      headCommittedAt,
    });

    record.graphHead = graphHead;
    record.liveHead = liveHead;
    record.behindBy = decision.behindBy;
    record.stale = decision.stale;
    record.confidence = decision.confidence;
    record.reasons = decision.reasons;
    record.dirty = dirty;
    if (liveHead === undefined && live.error !== undefined) {
      record.lastCheckedError = record.lastCheckedError ?? describeGitHeadFailure(live.error);
    }
    this.touch();
  }

  /**
   * 依設定同步監看器：需要的有、不需要的停（FR-6/FR-7）。
   *
   * 「使用者按過暫停」與「設定關掉了監看」是兩種不同的不該監看：前者是 per-project
   * 的使用者意圖（會落盤），後者是全域設定。兩者都在這裡收斂，但只有後者會因為
   * 設定改回來而自動恢復。
   *
   * @returns {Promise<void>} 同步完成。
   */
  async reconcileWatchers() {
    // B1：掃描可能在 stop() 之後才走到這裡（我們在 stop() 會等它，但不是無限期）。
    // 進了停止流程就不該再建任何監看器——那會是卸載後還在跑的殘骸。
    if (this.stopped) return;
    const config = this.config();
    const key = watcherKey(config);
    for (const record of this.records.values()) {
      const shouldWatch = config.enabled && config.watchEnabled && record.selected === true
        && record.watcherPaused !== true;
      // 排除規則、副檔名白名單與防抖在建立時就固定了：設定一改就把監看器換掉，
      // 否則「改了 debounceMs／excludes 卻只有暫停再恢復（或重啟）才生效」。
      if (shouldWatch && this.watchers.get(record.key) !== undefined && record.watcherKey !== key) {
        await this.stopWatcher(record.key);
      }
      const existing = this.watchers.get(record.key);
      if (shouldWatch && existing === undefined) {
        await this.startWatcher(record);
      } else if (!shouldWatch && existing !== undefined) {
        await this.stopWatcher(record.key);
      }
      // C1：不再監看的專案（被排除、變成孤兒、被暫停）不得留著已武裝的 settle
      // 計時器；它醒來時會排入一次沒有人要的重建。
      if (!shouldWatch) this.clearSettleTimer(record);
    }
  }

  /**
   * 熄掉一個專案的 idle-settle 計時器（C1）。
   * @param {object|undefined} record - 專案記錄。
   * @returns {void}
   */
  clearSettleTimer(record) {
    if (record === undefined || record.settleTimer === undefined) return;
    clearTimeout(record.settleTimer);
    record.settleTimer = undefined;
  }

  /**
   * 熄掉所有專案的 idle-settle 計時器（C1；卸載與整批停止時用）。
   * @returns {void}
   */
  clearSettleTimers() {
    for (const record of this.records.values()) this.clearSettleTimer(record);
  }

  /**
   * 為單一專案建立監看器。
   * @param {object} record - 專案記錄。
   * @returns {Promise<void>} 建立完成。
   */
  async startWatcher(record) {
    // B1：與 reconcileWatchers 同一個理由——停止流程中不再建新的監看器。
    if (this.stopped) return;
    const config = this.config();
    const self = this;
    try {
      const watcher = await this.deps.createWatcher({
        root: record.rootPath,
        excludes: config.excludes,
        extensions: config.extensions,
        debounceMs: config.debounceMs,
        log: this.log,
        onTrigger: function (info) {
          record.watcher.triggers = watcher.triggers;
          record.watcher.lastTriggerAt = watcher.lastTriggerAt;
          self.log.info('watch.triggered', {
            project: record.name,
            count: info.count,
            sample: info.sample.join(','),
          });
          void self.onWatcherTrigger(record);
        },
      });
      this.watchers.set(record.key, watcher);
      record.watcherKey = watcherKey(config);
      record.watcher = {
        status: watcher.status(),
        backend: watcher.backend,
        triggers: 0,
        lastTriggerAt: undefined,
        lastError: watcher.lastError,
      };
      this.log.info('watch.started', { project: record.name, backend: watcher.backend, root: record.rootPath });
    } catch (error) {
      record.watcher = { status: 'failed', backend: 'none', triggers: 0, lastTriggerAt: undefined };
      record.lastError = error instanceof Error ? error.message : String(error);
      this.log.error('watch.start.failed', { project: record.name, error: record.lastError });
    }
    this.touch();
  }

  /**
   * 停止單一專案的監看器。
   * @param {string} key - 身分鍵。
   * @returns {Promise<void>} 停止完成。
   */
  async stopWatcher(key) {
    const watcher = this.watchers.get(key);
    const record = this.records.get(key);
    // C1：計時器與監看器是同一件事的兩半，一起收掉；早退的分支（沒有監看器）
    // 也要清，否則「暫停監看」之後那個計時器還會自己醒來排重建。
    this.clearSettleTimer(record);
    if (watcher === undefined) return;
    this.watchers.delete(key);
    try {
      await watcher.stop();
    } catch (error) {
      this.log.warn('watch.stop.failed', { key, error: error instanceof Error ? error.message : String(error) });
    }
    if (record !== undefined) {
      record.watcher = { status: 'stopped', backend: watcher.backend, triggers: watcher.triggers, lastTriggerAt: watcher.lastTriggerAt };
    }
    this.touch();
  }

  /**
   * 設定變更後就地重套（volatile 的語意：寫入即生效，不必重啟）。
   *
   * 掃描間隔、落後判定條件、重建模式都在使用點即時讀取，這裡只補三件「讀不到」的：
   * 已經解析好的 CLI 路徑、已經建立的監看器（參數在建立時固定）、以及掃描計時器
   * （它在一輪掃描結束才重排，不改的話「1440 分鐘改回 0.5 分鐘」最壞要等 24 小時）。
   *
   * @returns {Promise<void>} 重套完成。
   */
  async onConfigChanged() {
    const before = this.cli.path;
    await this.resolveCli();
    if (this.cli.path !== before) await this.probeUpstream();
    await this.reconcileWatchers();
    this.scheduleScan();
    this.touch();
  }

  /**
   * 這一輪監看觸發可不可以只做便宜的 HEAD 探測？（WS6）
   *
   * 條件全部成立才走短路：settle 視窗開著、計時器已武裝（＝我們正處於視窗內）、
   * 上次的判定就是 dirty-only 的落後、而且已經有可比較的 `liveHead`。
   * 任何一項不成立就退回完整檢查——第一次觸發、視窗關閉、非 dirty-only、HEAD
   * 還沒量過，都必須完整檢查才知道發生什麼事。
   *
   * @param {object} record - 專案記錄。
   * @param {object} config - 執行期設定。
   * @returns {boolean} 可只探測 HEAD 則 true。
   */
  canShortCircuitCheck(record, config) {
    return config.dirtySettleMs > 0
      && record.settleTimer !== undefined
      && record.stale === true
      && isDirtyOnlyStale(record.reasons)
      && record.liveHead !== undefined;
  }

  /**
   * 監看觸發後的處理：先重驗落後，仍落後才排重建（FR-3）。
   *
   * C1 的 idle-settle 閘門就在這裡——**這才是重建風暴的主要入口**：實測 23 次
   * 重建有 17 次來自 `reason=watch`。dirty-only 的落後在靜默視窗內不排重建，
   * 改成武裝一次性計時器；真正的 HEAD 落後照舊立即排。
   *
   * WS6：視窗內只做便宜的 HEAD 探測。settle 擋掉了重建，卻擋不掉「每次存檔都跑
   * 一次完整 checkProject」——那是 3 次 git 探針＋1–2 次 CBM CLI（每次 2 秒以上）。
   * 而 `git rev-parse HEAD` 是落後判定的**主判據**，便宜到可以每次都做：HEAD 沒動
   * 時，圖譜相對 HEAD 的關係不可能變差，所以只需要重排計時器。HEAD 真的動了
   * （commit／換分支／rebase）才付出完整檢查的代價。
   *
   * @param {object} record - 專案記錄。
   * @returns {Promise<void>} 處理完成。
   */
  async onWatcherTrigger(record) {
    const config = this.config();
    if (!config.enabled) return;
    if (this.canShortCircuitCheck(record, config)) {
      const live = await this.deps.readLiveHead(record.rootPath);
      const liveHead = live.ok ? live.head : undefined;
      if (liveHead !== undefined && liveHead === record.liveHead) {
        // 只是未提交的改動：不碰 CBM CLI（那是這裡唯一昂貴的東西）。
        this.stats.count('checksShortCircuited');
        this.log.debug('watch.head-unchanged', {
          project: record.name,
          head: shortSha(record.liveHead),
          settleMs: config.dirtySettleMs,
        });
        // 監看器的 onTrigger 回呼通常已經寫過這個欄位；這裡再寫一次是為了讓
        // 「直接呼叫 onWatcherTrigger」的路徑（測試、未來的其他呼叫端）也看得到活動。
        record.watcher.lastTriggerAt = new Date().toISOString();
        this.armSettleTimer(record);
        this.touch();
        return;
      }
      // HEAD 變了，或探測失敗（unborn HEAD／不是工作樹／git 不在）：往下走完整檢查。
      // 省成本不可以省到讓狀態卡住。
    }
    // C2：force=false。快取鍵是 indexedAt，重建後已由 runRebuild 失效，語意足夠；
    // 每次存檔都 force 會讓 graphHeadCache 永遠不命中，每存一次檔多付一次
    // query_graph（實測 2.18–2.81 s）。
    await this.checkProject(record, false);
    if (record.stale !== true || config.autoRebuild !== true) {
      // 已經追上（或關掉了自動重建）：不該留著先前武裝的計時器。
      this.clearSettleTimer(record);
      this.touch();
      return;
    }
    if (isDirtyOnlyStale(record.reasons) && config.dirtySettleMs > 0) {
      this.armSettleTimer(record);
      this.touch();
      return;
    }
    this.enqueue(record.key, 'watch');
    this.touch();
  }

  /**
   * 武裝（或重排）一個專案的 idle-settle 計時器（C1）。
   *
   * 「靜默 N 秒」的語意靠**重排**實現：每一次新的監看觸發都把計時器往後推，
   * 只有真的安靜下來才會到期。計時器 unref，不擋行程結束。
   *
   * @param {object} record - 專案記錄。
   * @returns {void}
   */
  armSettleTimer(record) {
    this.clearSettleTimer(record);
    const settleMs = this.config().dirtySettleMs;
    const self = this;
    const timer = setTimeout(function () {
      record.settleTimer = undefined;
      void self.onSettleElapsed(record);
    }, settleMs);
    if (typeof timer.unref === 'function') timer.unref();
    record.settleTimer = timer;
    // WS5：每一次「把觸發往後推」都算一次延後——這正是省下來的一次立即重建。
    this.stats.count('settleDeferred');
    this.log.info('watch.settle.armed', { project: record.name, settleMs });
  }

  /**
   * idle-settle 視窗到期：重新確認一次，仍然值得才排重建（C1）。
   *
   * 到期前每一次存檔都會重排計時器，所以走到這裡代表「安靜了 settleMs」。
   * 仍然要重驗，是因為視窗內可能已經 commit（HEAD 前進）或被別的途徑重建過。
   *
   * @param {object} record - 專案記錄。
   * @returns {Promise<void>} 處理完成。
   */
  async onSettleElapsed(record) {
    // 卸載／暫停之後甦醒的計時器什麼都不該做：stop() 之後排重建就是 B1 要消滅
    // 的那種殘骸（子行程在卸載後才啟動）。
    if (this.stopped) return;
    const config = this.config();
    if (!config.enabled || config.autoRebuild !== true) return;
    if (record.watcherPaused === true || record.selected !== true) return;
    await this.checkProject(record, false);
    if (record.stale !== true || !isDirtyOnlyStale(record.reasons)) return;
    if (!isDirtySettled({
      lastTriggerAt: this.watcherView(record).lastTriggerAt,
      lastIndexedAt: record.lastIndexedAt,
      settleMs: config.dirtySettleMs,
      now: Date.now(),
    })) {
      // 視窗內又有活動：讓下一次觸發重新武裝，這裡不排。
      this.log.debug('watch.settle.not-settled', { project: record.name });
      return;
    }
    // WS5：走完 settle 視窗、最後真的排入的重建。
    this.stats.count('settled');
    this.enqueue(record.key, 'watch:settled');
    this.touch();
  }

  /**
   * 這個專案是否仍在冷卻期內（只約束自動重建；人工與強制重建走 options.force）。
   * @param {object} record - 專案記錄。
   * @returns {boolean} 冷卻中則 true。
   */
  inCooldown(record) {
    const cooldownMs = this.config().rebuildCooldownMs;
    if (cooldownMs === undefined || cooldownMs <= 0) return false;
    if (record.lastRebuildFinishedAt === undefined) return false;
    const elapsed = Date.now() - Date.parse(record.lastRebuildFinishedAt);
    return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < cooldownMs;
  }

  /**
   * 掃描路徑的第二道閘門：這一種落後值不值得現在重跑？
   *
   * `head-match-but-dirty` 是唯一「不會自己消失」的落後——未提交變更只要不 commit
   * 就一直存在。若每一輪掃描都排重建，圖譜會在每一輪被重新索引卻永遠追不上，而
   * 重建途中還在改檔會讓 CBM 中止該輪。
   *
   * C1 之後這裡有兩個條件：上次索引之後**真的有**檔案活動，而且那份活動已經
   * **靜默**達 `dirtySettleMs`。少了後半，編輯中的專案每輪掃描都還是會排重建
   * （`dirtySettleMs` 預設 0＝維持現行行為，此時後半恆真）。
   *
   * 真正的 HEAD 落後不受這道閘門約束（立即重建是本插件的核心價值）。
   *
   * @param {object} record - 專案記錄。
   * @returns {boolean} 值得排入則 true。
   */
  shouldAutoRebuild(record) {
    if (!isDirtyOnlyStale(record.reasons)) return true;
    return isDirtySettled({
      lastTriggerAt: this.watcherView(record).lastTriggerAt,
      lastIndexedAt: record.lastIndexedAt,
      settleMs: this.config().dirtySettleMs,
      now: Date.now(),
    });
  }

  /**
   * 把專案排進重建佇列（FR-14：全域併發上限 1）。
   * @param {string} key - 身分鍵。
   * @param {string} reason - 排入原因。
   * @param {string} [mode] - 明確指定的模式。
   * @param {{force?: boolean}} [options] - `force: true` 時略過冷卻（人工／強制重建）。
   * @returns {boolean} 是否真的排入（已在佇列、執行中或冷卻期內時 false）。
   */
  enqueue(key, reason, mode, options) {
    const record = this.records.get(key);
    if (record === undefined) return false;
    // 沒被納管（上游已無此專案、或被 include/exclude 排除）就不該重建：
    // 重建會以既有 name 寫回上游，對一棵已經不在射程內的樹做這件事沒有意義。
    if (record.selected !== true) return false;
    if (record.rebuildState === 'queued' || record.rebuildState === 'running') return false;
    if (this.running !== undefined && this.running.key === key) return false;
    // 冷卻期：同一個專案剛重建完就不再自動重跑。少了這道閘門，一個長期 dirty、
    // 或生成檔被工具不斷改寫的專案會一輪接一輪地重建（實測 29.6 小時 145 次），
    // 而 CBM 對「重建途中檔案又變」的回應是中止該輪（aborted_previous_preserved）。
    if ((options === undefined || options.force !== true) && this.inCooldown(record)) {
      this.log.info('rebuild.skipped', { project: record.name, reason, cooldownMs: this.config().rebuildCooldownMs });
      // WS5：冷卻擋下的重建＝省下的一次重建。
      this.stats.count('skippedCooldown');
      return false;
    }
    this.queue.push({ key, reason, mode, requestedAt: new Date().toISOString() });
    record.rebuildState = 'queued';
    record.rebuildRequestedAt = new Date().toISOString();
    record.rebuildReason = reason;
    // WS5：排入就算一次——包含人工／強制重建（它們一樣會佔用子行程）。
    this.stats.count('rebuildsQueued');
    this.log.info('rebuild.queued', { project: record.name, reason, queue: this.queue.length });
    // 落盤不阻塞排隊，但必須被追蹤：崩潰恢復（NFR-6）靠的就是這一筆。
    this.trackWrite(this.state.setProject(key, { rebuildState: 'queued', rebuildReason: reason }));
    this.touch();
    // A1：`.catch()` 是必要的，不是裝飾。少了它，`drain()` 一旦 reject 就是
    // unhandledRejection，而 Node 的預設行為是**終止行程**——那會殺掉整個 DSH 宿主。
    void this.drain().catch(function (error) {
      this.log.error('drain.failed', { error: error instanceof Error ? error.message : String(error) });
    }.bind(this));
    return true;
  }

  /**
   * 追蹤一筆未完成的狀態寫入，讓 {@link stop} 能等到它們落地。
   * @param {Promise<void>} write - 狀態寫入。
   * @returns {Promise<void>} 同一個 promise，已掛上錯誤吞除。
   */
  trackWrite(write) {
    const tracked = write.catch(function () {}).finally(function () {
      this.pendingWrites.delete(tracked);
    }.bind(this));
    this.pendingWrites.add(tracked);
    return tracked;
  }

  /**
   * 依序把佇列消耗完；同一時間只允許一個重建在跑。
   *
   * 重入時回傳同一個 promise：`stop()` 要能 join 到正在跑的這一輪，否則
   * 「卸載後刪狀態目錄」會被重建尾巴的落盤還原。
   *
   * @returns {Promise<void>} 佇列清空後解決。
   */
  drain() {
    if (this.drainPromise !== undefined) return this.drainPromise;
    this.drainPromise = this.drainLoop().catch(function (error) {
      // A1：這一輪佇列的失敗必須被吞下。單一專案的例外已在 drainLoop 內逐筆接住，
      // 這裡是最後一道防線；`stop()` 也會 await 這個 promise，它不能以 rejected 收場。
      this.log.error('drain.failed', { error: error instanceof Error ? error.message : String(error) });
    }.bind(this)).finally(function () {
      this.drainPromise = undefined;
    }.bind(this));
    return this.drainPromise;
  }

  /**
   * 佇列消耗的實際迴圈。
   * @returns {Promise<void>} 佇列清空後解決。
   */
  async drainLoop() {
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      const record = this.records.get(next.key);
      if (record === undefined) continue;
      this.running = next;
      try {
        await this.runRebuild(record, next);
      } catch (error) {
        // A1：一個專案的重建拋錯不得帶走整輪佇列（其他專案會永遠卡在 queued），
        // 更不得變成 unhandledRejection 殺掉宿主行程。記下來、把狀態歸零、換下一筆。
        record.rebuildState = 'idle';
        record.lastError = error instanceof Error ? error.message : String(error);
        this.log.error('drain.failed', {
          project: record.name,
          reason: next.reason,
          error: record.lastError,
        });
        this.touch();
      } finally {
        this.running = undefined;
        // 冷卻期的起算點是「這一輪結束」，不是「這一輪開始」：重建本身要跑數秒到
        // 數十秒，從開始算會讓冷卻在重建還在跑的時候就過期。
        record.lastRebuildFinishedAt = new Date().toISOString();
      }
    }
  }

  /**
   * 執行一次重建。
   * @param {object} record - 專案記錄。
   * @param {{key: string, reason: string, mode?: string}} job - 佇列項目。
   * @returns {Promise<void>} 重建完成。
   */
  async runRebuild(record, job) {
    const config = this.config();
    const chosen = pickRebuildMode({
      requested: job.mode,
      configured: config.mode,
      fileCount: record.notIndexedFilesCount,
    });
    // B2：控制器必須在取鎖**之前**建立。acquireLock() 是非同步的（mkdir ＋ open），
    // stop() 撞進那個窗口時 abortController 還是 undefined，中止訊號就送不出去，
    // 重建子行程會在卸載後繼續跑完。先建好，stop() 才一定找得到它。
    const controller = new AbortController();
    this.abortController = controller;
    const lock = await this.acquireLock();
    if (!lock.ok) {
      if (this.abortController === controller) this.abortController = undefined;
      record.rebuildState = 'idle';
      record.lastError = lock.error;
      this.log.warn('rebuild.lock-busy', { project: record.name, error: lock.error });
      await this.state.setProject(record.key, { rebuildState: 'idle', lastError: lock.error });
      this.touch();
      return;
    }
    // B2：取鎖期間被卸載。立刻放掉鎖、不啟動子行程、不落盤——狀態留在 queued／
    // running 正好讓下次啟動的 recoverIntent() 重新排入（NFR-6）。
    if (this.stopped) {
      if (this.abortController === controller) this.abortController = undefined;
      record.rebuildState = 'idle';
      await lock.release();
      this.log.info('rebuild.abandoned', {
        project: record.name,
        reason: job.reason,
        durationMs: 0,
        ok: false,
        phase: 'lock-wait',
      });
      return;
    }

    record.rebuildState = 'running';
    record.rebuildStartedAt = new Date().toISOString();
    await this.state.setProject(record.key, { rebuildState: 'running' });
    this.touch();
    this.log.info('rebuild.start', {
      project: record.name,
      mode: chosen.mode,
      modeReason: chosen.reason,
      reason: job.reason,
      root: record.rootPath,
      timeoutMs: config.rebuildTimeoutMs,
    });

    const started = Date.now();
    let result;
    try {
      result = await this.cbm.index({
        rootPath: record.rootPath,
        name: record.name,
        mode: chosen.mode,
        timeoutMs: config.rebuildTimeoutMs,
        signal: controller.signal,
      });
    } finally {
      // 只有還是「這一個」控制器時才清掉：`cancelRunning()` 讀的就是這個欄位。
      if (this.abortController === controller) this.abortController = undefined;
      await lock.release();
    }
    const durationMs = Date.now() - started;

    // 已經在停止流程中：不複查、不落盤。跳過落盤是刻意的——狀態檔停在
    // running／queued 正好讓下次啟動的 recoverIntent() 把這個沒做完的重建
    // 重新排入（NFR-6），而寫下去反而會把剛被刪掉的狀態目錄又建回來。
    if (this.stopped) {
      record.rebuildState = 'idle';
      this.log.info('rebuild.abandoned', {
        project: record.name,
        reason: job.reason,
        durationMs,
        ok: result.ok,
      });
      return;
    }

    if (result.ok) {
      await this.checkProject(record, true);
      record.lastIndexedAt = new Date().toISOString();
      record.lastDurationMs = durationMs;
      record.lastError = undefined;
      // WS5：成功的一次（含「成功但 HEAD 沒追上」——那一輪真的跑完了，另有警告）。
      this.stats.count('rebuildsSucceeded');
      this.stats.count('rebuildMs', durationMs);
      this.log.info('rebuild.done', {
        project: record.name,
        mode: chosen.mode,
        durationMs,
        graphHead: record.graphHead,
        liveHead: record.liveHead,
        caughtUp: record.graphHead === record.liveHead,
        nodes: record.nodes,
        edges: record.edges,
      });
      if (record.graphHead !== record.liveHead) {
        // 重建成功但 HEAD 仍未追上：這是必須看得見的異常，不是靜默的成功。
        record.lastError = '重建回報成功，但圖譜 HEAD（' + String(record.graphHead) + '）仍與工作樹 HEAD（'
          + String(record.liveHead) + '）不同；請確認上游是否寫入了不同的專案名。';
        this.log.warn('rebuild.head-mismatch', {
          project: record.name,
          graphHead: record.graphHead,
          liveHead: record.liveHead,
        });
      }
    } else {
      record.lastDurationMs = durationMs;
      record.lastError = result.error;
      // WS5：失敗與「被 CBM 中止」分開算，而且**互斥**——aborted 不重複計入 failed，
      // 相加才是全部的失敗嘗試。aborted（aborted_previous_preserved）是「重建途中
      // 檔案又變」的直接指標，跟真正的錯誤（逾時、CLI 壞掉）不是同一件事。
      if (/aborted_previous_preserved/i.test(String(result.error ?? ''))) {
        this.stats.count('rebuildsAborted');
      } else {
        this.stats.count('rebuildsFailed');
      }
      this.stats.count('rebuildMs', durationMs);
      this.log.error('rebuild.failed', { project: record.name, durationMs, error: result.error });
    }

    record.rebuildState = 'idle';
    this.graphHeadCache.delete(record.key);
    await this.state.setProject(record.key, {
      rebuildState: 'idle',
      lastIndexedAt: record.lastIndexedAt,
      lastDurationMs: record.lastDurationMs,
      lastError: record.lastError,
      name: record.name,
      rootPath: record.rootPath,
    });
    // WS7：這一輪的結果（成功／失敗／被中止）剛進了統計，警告跟著重算，
    // 不必等下一輪掃描或下一次探測。
    this.rebuildWarnings();
    this.touch();
  }

  /**
   * 取得跨行程的重建鎖（NFR-6）。
   *
   * 主鎖是記憶體中的 `this.running`；這裡再加一層檔案鎖，避免同一台機器上兩個
   * DSH profile 同時重建同一棵樹。超過 {@link LOCK_STALE_MS} 未更新的鎖視為
   * 崩潰殘留並接管。
   *
   * @returns {Promise<{ok: boolean, error?: string, release: () => Promise<void>}>} 鎖把柄。
   */
  async acquireLock() {
    const file = join(this.home, REBUILD_LOCK_NAME);
    const noop = async function () {};
    try {
      await mkdir(this.home, { recursive: true });
      const handle = await open(file, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8');
      return {
        ok: true,
        release: async function () {
          try {
            await handle.close();
          } catch {
            // 已關閉：沒有別的事要做。
          }
          await rm(file, { force: true });
        },
      };
    } catch (error) {
      const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code !== 'EEXIST') {
        return { ok: false, error: '無法建立重建鎖：' + (error instanceof Error ? error.message : String(error)), release: noop };
      }
      try {
        const info = await fsStat(file);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(file, { force: true });
          this.log.warn('rebuild.lock-stale', { file });
          return this.acquireLock();
        }
      } catch {
        // 鎖檔在檢查途中消失：直接回報忙碌，下一輪掃描會再試。
      }
      return { ok: false, error: '另一個行程正在重建（鎖檔 ' + file + '）', release: noop };
    }
  }

  /**
   * 監看器的即時視圖（B3）。
   *
   * `record.watcher` 是**建立當下**的快照，之後只由 onTrigger 更新觸發次數。但
   * 「inotify 用盡」這類執行期錯誤是後來才發生的，狀態會從 watching 變成 failed
   * ——全庫沒有任何地方重讀 `watcher.status()`，H3 的修正就到不了 UI，卡片會繼續
   * 說「監看中」而存檔已經追不上。所以對外輸出一律向監看器本身取。
   *
   * 沒有監看器時（未建立／已停止）回既有的快照物件，形狀完全相同。
   *
   * @param {object} record - 專案記錄。
   * @returns {{status: string, backend: string, triggers: number, lastTriggerAt: string|undefined, lastError?: string|undefined}}
   *   監看狀態視圖。
   */
  watcherView(record) {
    const watcher = this.watchers.get(record.key);
    if (watcher === undefined) {
      // 未建立／已停止：回既有的快照；連快照都沒有時給一個形狀完整的空狀態，
      // 讓呼叫端不必為了「沒有監看器」寫第二套分支。
      return record.watcher ?? { status: 'stopped', backend: 'none', triggers: 0, lastTriggerAt: undefined };
    }
    return {
      status: watcher.status(),
      backend: watcher.backend,
      triggers: watcher.triggers,
      lastTriggerAt: watcher.lastTriggerAt,
      lastError: watcher.lastError,
    };
  }

  /**
   * 對外暴露的專案視圖（FR-8）。
   * @returns {object[]} 依名稱排序的視圖陣列。
   */
  list() {
    const records = Array.from(this.records.values());
    const graphUi = this.graphUi;
    const self = this;
    records.sort(function (left, right) {
      if (left.selected !== right.selected) return left.selected ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    return records.map(function (record) {
      return {
        key: record.key,
        name: record.name,
        rootPath: record.rootPath,
        branch: record.branch,
        selected: record.selected,
        orphaned: record.orphaned,
        graphHead: record.graphHead,
        liveHead: record.liveHead,
        graphHeadShort: shortSha(record.graphHead),
        liveHeadShort: shortSha(record.liveHead),
        behindBy: record.behindBy,
        stale: record.stale,
        confidence: record.confidence,
        reasons: record.reasons,
        dirty: record.dirty,
        indexedAt: record.indexedAt,
        nodes: record.nodes,
        edges: record.edges,
        parsePartialCount: record.parsePartialCount,
        notIndexedFilesCount: record.notIndexedFilesCount,
        lastCheckAt: record.lastCheckAt,
        lastCheckedError: record.lastCheckedError,
        lastIndexedAt: record.lastIndexedAt,
        lastDurationMs: record.lastDurationMs,
        lastError: record.lastError,
        rebuildState: record.rebuildState,
        rebuildReason: record.rebuildReason,
        rebuildRequestedAt: record.rebuildRequestedAt,
        rebuildStartedAt: record.rebuildStartedAt,
        watcherPaused: record.watcherPaused === true,
        // B3：即時狀態，不是建立當下的快照。
        watcher: self.watcherView(record),
        // 圖譜 UI 可直達單一專案（上游前端讀 ?project= 與 ?tab=）；
        // 沒得連時留 undefined，卡片就不畫那顆按鈕。
        graphUrl: graphUi.state === 'ok'
          ? buildGraphUrl(graphUi.base, { project: record.name, tab: 'graph' })
          : undefined,
      };
    });
  }

  /**
   * 全域狀態視圖（FR-5/FR-10/FR-15）。
   * @returns {object} 狀態物件。
   */
  /**
   * 取消目前正在跑的重建（沒有在跑就回 false）。
   *
   * 中止的重建會留下 `rebuild.abandoned` 日誌，狀態刻意停在 running／queued，
   * 讓下一次啟動的 `recoverIntent()` 重新排入——取消不是放棄，是等一下再跑。
   *
   * @returns {boolean} 是否真的送出了中止訊號。
   */
  cancelRunning() {
    if (this.running === undefined || this.abortController === undefined) return false;
    this.abortController.abort();
    return true;
  }

  /**
   * 目前狀態。
   * @returns {object} 對外狀態快照。
   */
  status() {
    const config = this.config();
    const runningRecord = this.running === undefined ? undefined : this.records.get(this.running.key);
    return {
      revision: this.revision,
      enabled: config.enabled,
      cliPath: this.cli.path,
      cliSource: this.cli.source,
      cliError: this.cli.error,
      cliCandidates: this.cli.candidates,
      cliVersion: this.version.value,
      cliVersionSupported: this.version.supported,
      upstreamConfig: this.upstreamConfig,
      upstreamConfigError: this.upstreamConfigError,
      graphUi: this.graphUi,
      warnings: this.warnings,
      lastRefreshAt: this.lastRefreshAt,
      lastRefreshError: this.lastRefreshError,
      // WS5：重建成效的累計統計。欄位名一律帶 `sinceStart`／`last24h` 前綴，
      // 語意見 {@link RebuildStats}；`statsSince` 是它的起算時間（本次啟動）。
      // 形狀是**扁平的數字物件**，每個鍵都有值（沒發生過就是 0），UI 可直接格式化。
      stats: this.stats.snapshot(),
      statsSince: this.stats.startedAt,
      // D3：兩個原本沒有任何出口的失敗。日誌檔寫不進去、狀態檔讀不回來都會讓
      // 「看起來一切正常」的卡片騙人，所以把它們放進狀態視圖讓 UI 說出來。
      logFileError: this.log.fileError,
      stateLoadError: this.state.loadError,
      watching: this.watchers.size,
      running: this.running === undefined ? undefined : {
        key: this.running.key,
        reason: this.running.reason,
        // E：介面凍結——重建的開始時間取自記錄，UI 才能顯示「已經跑了多久」。
        startedAt: runningRecord === undefined ? undefined : runningRecord.rebuildStartedAt,
      },
      queue: this.queue.map(function (job) { return { key: job.key, reason: job.reason, requestedAt: job.requestedAt }; }),
      stateFile: this.state.file,
      config: {
        mode: config.mode,
        scanMs: config.scanMs,
        watchEnabled: config.watchEnabled,
        autoRebuild: config.autoRebuild,
        includeDirty: config.includeDirty,
        debounceMs: config.debounceMs,
        rebuildCooldownMs: config.rebuildCooldownMs,
        dirtySettleMs: config.dirtySettleMs,
        nice: config.nice,
        rebuildTimeoutMs: config.rebuildTimeoutMs,
        extensions: config.extensions,
        excludes: config.excludes,
      },
    };
  }

  /**
   * 手動觸發檢查（FR-12）。
   * @param {string|undefined} key - 只檢查單一專案；未給則整批掃描。
   * @returns {Promise<{ok: boolean, error?: string}>} 結果。
   */
  async check(key) {
    await this.resolveCli();
    await this.probeUpstream();
    if (key === undefined) {
      const result = await this.refresh('manual');
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    }
    const record = this.records.get(key);
    if (record === undefined) return { ok: false, error: '找不到專案：' + key };
    await this.checkProject(record, true);
    return { ok: true };
  }

  /**
   * 暫停或恢復監看（FR-12）。
   * @param {string|undefined} key - 目標專案；未給則全部。
   * @param {'pause'|'resume'} action - 動作。
   * @returns {Promise<{ok: boolean, affected: number, error?: string}>} 結果。
   */
  async watcherAction(key, action) {
    const config = this.config();
    const targets = key === undefined
      ? Array.from(this.records.values())
      : [this.records.get(key)].filter(function (record) { return record !== undefined; });
    if (targets.length === 0) return { ok: false, affected: 0, error: '找不到專案：' + String(key) };
    let affected = 0;
    for (const record of targets) {
      if (action === 'pause') {
        if (this.watchers.has(record.key)) {
          await this.stopWatcher(record.key);
          affected += 1;
        }
        // C1：暫停監看也要熄掉 settle 計時器，否則它會在「已暫停」的專案上排重建。
        this.clearSettleTimer(record);
        record.watcherPaused = true;
        await this.state.setProject(record.key, { watcherPaused: true });
      } else {
        record.watcherPaused = false;
        await this.state.setProject(record.key, { watcherPaused: false });
        if (config.enabled && config.watchEnabled && record.selected && !this.watchers.has(record.key)) {
          await this.startWatcher(record);
          affected += 1;
        }
      }
    }
    this.log.info('watch.action', { action, affected, key: key ?? 'all' });
    this.touch();
    return { ok: true, affected };
  }

  /**
   * 建立一筆供 UI 顯示的關聯資訊（不可靠宣告的標示，FR-13）。
   * @returns {object[]} 說明列。
   */
  caveats() {
    return [
      {
        code: 'route-file-path-empty',
        message: '圖譜的 Route 節點 file_path 全為空、且多為非產品路由（CDP 端點、i18n 鍵），不可作為證據引用。',
      },
      {
        code: 'layers-unreliable',
        message: 'layers 宣告（例如「src = api」）與事實不符時有發生；引用前請以原始碼為準。',
      },
      {
        code: 'parse-partial',
        message: 'parse_partial 清單中的檔案有解析缺口，這些範圍的節點可能缺席，引用時得回到 grep。',
      },
      {
        code: 'gitignored-not-indexed',
        message: 'gitignore 內的路徑不會進圖譜；需要那些檔案的工作必須直接讀檔。',
      },
    ];
  }
}

/**
 * 取短 sha。
 * @param {string|undefined} sha - 完整 sha。
 * @returns {string|undefined} 前 8 位。
 */
function shortSha(sha) {
  if (typeof sha !== 'string' || sha.length === 0) return undefined;
  return sha.slice(0, 8);
}

/**
 * 把 git 的 HEAD 讀取失敗翻譯成使用者看得懂的一句話。
 *
 * 「已索引但尚無提交」的倉庫（`git` 還沒有第一個 commit）會得到 `fatal: ambiguous argument 'HEAD'`，
 * 直接把原文丟到 UI 只會讓人以為插件壞了。這裡只加一句說明並保留原始訊息，
 * 不改變判定結果——`stale` 仍然是 `null`（不宣稱新鮮）。
 *
 * @param {string} raw - git 的原始錯誤訊息。
 * @returns {string} 給 UI 的訊息。
 */
export function describeGitHeadFailure(raw) {
  const text = String(raw ?? '').trim();
  if (text.length === 0) return text;
  const looksUnborn = /ambiguous argument|unknown revision|does not have any commits|有歧义|未知的版本|bad revision|Not a valid object name/i.test(text);
  if (!looksUnborn) return text;
  return '這個專案尚無提交（unborn HEAD）或不是 git 工作樹，取不到工作樹 HEAD 可與圖譜比對；'
    + '圖譜只會顯示為「無法判定」，不會被當成新鮮。git 原始訊息：' + text;
}
