/**
 * 常數與預設值。
 *
 * 這裡只放「不隨部署改變」的事實：插件識別、CBM CLI 的呼叫契約、上游版本
 * 支援矩陣、以及監看的預設排除集。可調的部署選擇一律進 Config（NFR 的
 * 「no hardcoded tunables」原則），不得在這裡放 DEFAULT_* 當成可配置性的替代。
 */

/** Cordis 插件名（等於 cordis.patch.yml 的 insert id）。 */
export const PLUGIN_ID = 'codebase-watcher';

/** 套件名（等於 package.json 的 name，也是外掛頁與 client module 的鍵）。 */
export const PLUGIN_NAME = 'dsh-codebase-watcher';

/** 這支插件註冊的所有 HTTP 路由前綴。 */
export const API_PREFIX = '/api/codebase-watcher';

/** 設定頁分區 id（settings.section 的 id 選項）。 */
export const SETTINGS_SECTION_ID = 'codebase-watcher';

/** CBM 的 MCP 工具名 → CLI 子命令名。CLI 直接把工具名當子命令用。 */
export const CBM_TOOLS = {
  listProjects: 'list_projects',
  indexStatus: 'index_status',
  queryGraph: 'query_graph',
  indexRepository: 'index_repository',
};

/**
 * 上游已知可用並實測過的 CBM 版本（FR-15）。
 *
 * 0.11.0 是實測基準版本：`cli --json` 的輸出信封、`list_projects` 的三欄表、
 * `query_graph` 的 Branch.head_sha 都以此為準。清單外只警告不阻擋。
 */
export const SUPPORTED_CBM_VERSIONS = ['0.11.0'];

/** `codebase-memory-mcp --version` 的輸出行：`codebase-memory-mcp <semver>`。 */
export const CBM_VERSION_PATTERN = /^codebase-memory-mcp\s+(\S+)\s*$/m;

/** 依序嘗試的 CLI 檔名（PATH 查找與常見路徑共用）。 */
export const CBM_BIN_NAMES = ['codebase-memory-mcp', 'codebase-memory-mcp.exe'];

/** 平台常見安裝路徑樣板；`%s` 由家目錄展開，`%n` 由檔名展開。 */
export const CBM_COMMON_PATHS = [
  '%s/.local/bin/%n',
  '%s/bin/%n',
  '/usr/local/bin/%n',
  '/usr/bin/%n',
  '/opt/%n/%n',
  '/opt/homebrew/bin/%n',
];

/** 監看預設排除的目錄名／路徑片段（FR-6）。 */
export const DEFAULT_WATCH_EXCLUDES = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  '.venv',
  'venv',
  '__pycache__',
  '.codebase-memory',
  '.cache',
  'coverage',
  'target',
  'vendor',
];

/** 監看預設的副檔名白名單（FR-6，可設定覆寫）。空字串＝不過濾，全部副檔名都算。 */
export const DEFAULT_WATCH_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte',
  'py', 'rs', 'go', 'java', 'kt', 'rb', 'php', 'cs', 'c', 'cc', 'cpp', 'h', 'hpp',
  'json', 'yml', 'yaml', 'toml', 'sql', 'sh',
];

/** 專案落後量的上限：避免在斷裂的歷史線上跑出天文數字。 */
export const MAX_BEHIND_BY = 100000;

/** 一次掃描最多納管的專案數（成本護欄，FR-14）。 */
export const MAX_TRACKED_PROJECTS = 64;

/** 狀態檔與日誌的目錄名（相對於 DSH home）。 */
export const STATE_DIR_NAME = PLUGIN_ID;
export const STATE_FILE_NAME = 'state.json';
export const LOG_FILE_NAME = 'keeper.log';

/**
 * 檔案日誌的輪替門檻（bytes）：寫入前若會超過，現行檔改名為 `<file>.1`（只留
 * 一份歷史檔）再開新檔。上限本身不隨部署改變，所以留在常數層，不進 Config。
 */
export const LOG_MAX_FILE_BYTES = 5 * 1024 * 1024;

/** 狀態檔格式版本；欄位或折疊語意改變時遞增。 */
export const STATE_VERSION = 1;

/** 建構 `query_graph` 取圖譜 HEAD 的 Cypher（FR-2）。 */
export const GRAPH_HEAD_QUERY = 'MATCH (b:Branch) RETURN b.head_sha AS head';

/** 日誌等級。 */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
