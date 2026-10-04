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
import { MAX_TRACKED_PROJECTS, PLUGIN_ID } from './constants.js';
import { countCommitsBetween, isWorktreeDirty, readHeadCommittedAt, readLiveHead } from './git.js';
import {
  buildGraphBase,
  buildGraphUrl,
  canonicalRootPath,
  decideStaleness,
  mergeProjectsByRootPath,
  pickRebuildMode,
  projectIdentityKey,
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
    this.cli = { path: undefined, source: undefined, error: undefined, candidates: [] };
    this.version = { value: undefined, supported: null };
    this.upstreamConfig = {};
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
    const autoWatch = this.upstreamConfig.auto_watch;
    if (autoWatch === 'true' && this.upstreamConfig.watcher_enabled === 'true') {
      warnings.push({
        code: 'upstream-watcher-on',
        message: 'CBM 內建的 watcher（auto_watch／watcher_enabled）仍是 true；實測它不會產生可觀測的重建，但留著沒有壞處，僅供知情。',
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
    for (const project of listed.projects) {
      const key = await this.identityOf(project.rootPath);
      if (key.length === 0) continue;
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
        pendingRebuilds.push(key);
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
    const headCommittedAt = liveHead === undefined ? undefined : await this.deps.readHeadCommittedAt(record.rootPath);
    const dirty = liveHead === undefined ? false : await this.deps.isWorktreeDirty(record.rootPath);

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
    const config = this.config();
    for (const record of this.records.values()) {
      const shouldWatch = config.enabled && config.watchEnabled && record.selected === true
        && record.watcherPaused !== true;
      const existing = this.watchers.get(record.key);
      if (shouldWatch && existing === undefined) {
        await this.startWatcher(record);
      } else if (!shouldWatch && existing !== undefined) {
        await this.stopWatcher(record.key);
      }
    }
  }

  /**
   * 為單一專案建立監看器。
   * @param {object} record - 專案記錄。
   * @returns {Promise<void>} 建立完成。
   */
  async startWatcher(record) {
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
      record.watcher = {
        status: watcher.status(),
        backend: watcher.backend,
        triggers: 0,
        lastTriggerAt: undefined,
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
    if (watcher === undefined) return;
    this.watchers.delete(key);
    try {
      await watcher.stop();
    } catch (error) {
      this.log.warn('watch.stop.failed', { key, error: error instanceof Error ? error.message : String(error) });
    }
    const record = this.records.get(key);
    if (record !== undefined) {
      record.watcher = { status: 'stopped', backend: watcher.backend, triggers: watcher.triggers, lastTriggerAt: watcher.lastTriggerAt };
    }
    this.touch();
  }

  /**
   * 監看觸發後的處理：先重驗落後，仍落後才排重建（FR-3）。
   * @param {object} record - 專案記錄。
   * @returns {Promise<void>} 處理完成。
   */
  async onWatcherTrigger(record) {
    const config = this.config();
    if (!config.enabled) return;
    await this.checkProject(record, true);
    if (record.stale === true && config.autoRebuild) {
      this.enqueue(record.key, 'watch');
    }
    this.touch();
  }

  /**
   * 把專案排進重建佇列（FR-14：全域併發上限 1）。
   * @param {string} key - 身分鍵。
   * @param {string} reason - 排入原因。
   * @param {string} [mode] - 明確指定的模式。
   * @returns {boolean} 是否真的排入（已在佇列或執行中時 false）。
   */
  enqueue(key, reason, mode) {
    const record = this.records.get(key);
    if (record === undefined) return false;
    // 沒被納管（上游已無此專案、或被 include/exclude 排除）就不該重建：
    // 重建會以既有 name 寫回上游，對一棵已經不在射程內的樹做這件事沒有意義。
    if (record.selected !== true) return false;
    if (record.rebuildState === 'queued' || record.rebuildState === 'running') return false;
    if (this.running !== undefined && this.running.key === key) return false;
    this.queue.push({ key, reason, mode, requestedAt: new Date().toISOString() });
    record.rebuildState = 'queued';
    record.rebuildRequestedAt = new Date().toISOString();
    record.rebuildReason = reason;
    this.log.info('rebuild.queued', { project: record.name, reason, queue: this.queue.length });
    // 落盤不阻塞排隊，但必須被追蹤：崩潰恢復（NFR-6）靠的就是這一筆。
    this.trackWrite(this.state.setProject(key, { rebuildState: 'queued', rebuildReason: reason }));
    this.touch();
    void this.drain();
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
    this.drainPromise = this.drainLoop().finally(function () {
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
      } finally {
        this.running = undefined;
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
    const lock = await this.acquireLock();
    if (!lock.ok) {
      record.rebuildState = 'idle';
      record.lastError = lock.error;
      this.log.warn('rebuild.lock-busy', { project: record.name, error: lock.error });
      await this.state.setProject(record.key, { rebuildState: 'idle', lastError: lock.error });
      this.touch();
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

    this.abortController = new AbortController();
    const started = Date.now();
    let result;
    try {
      result = await this.cbm.index({
        rootPath: record.rootPath,
        name: record.name,
        mode: chosen.mode,
        timeoutMs: config.rebuildTimeoutMs,
        signal: this.abortController.signal,
      });
    } finally {
      this.abortController = undefined;
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
   * 對外暴露的專案視圖（FR-8）。
   * @returns {object[]} 依名稱排序的視圖陣列。
   */
  list() {
    const records = Array.from(this.records.values());
    const graphUi = this.graphUi;
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
        watcher: record.watcher,
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
  status() {
    const config = this.config();
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
      graphUi: this.graphUi,
      warnings: this.warnings,
      lastRefreshAt: this.lastRefreshAt,
      lastRefreshError: this.lastRefreshError,
      watching: this.watchers.size,
      running: this.running === undefined ? undefined : { key: this.running.key, reason: this.running.reason },
      queue: this.queue.map(function (job) { return { key: job.key, reason: job.reason, requestedAt: job.requestedAt }; }),
      stateFile: this.state.file,
      config: {
        mode: config.mode,
        scanMs: config.scanMs,
        watchEnabled: config.watchEnabled,
        autoRebuild: config.autoRebuild,
        includeDirty: config.includeDirty,
        debounceMs: config.debounceMs,
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
