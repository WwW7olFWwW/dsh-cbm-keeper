/**
 * 插件設定（Config）。
 *
 * dsh 0.2 的模型是「Loader entry 的 Config 就是設定命名空間」：同一個 schema
 * 既是組合設定，也是設定頁。每個欄位都是 `volatile()`——Loader 就地更新這些
 * 值並重入 apply()，而不重建 fiber，因此插件持有的參照永遠讀得到最新值，
 * 不需要訂閱、不需要 watcher。
 *
 * 沒有任何可調值是硬編碼在其他模組裡的：部署會變的選擇全部在這裡，並可從
 * cordis.patch.yml 或設定頁修改。
 */

import { createRequire } from 'node:module';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_WATCH_EXCLUDES,
  DEFAULT_WATCH_EXTENSIONS,
} from './constants.js';

/** DSH home：`$DSH_HOME` > `$HOME/.dsh` > `os.homedir()/.dsh`（與 harness 的解析順序一致）。 */
function dshHome(env) {
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0) return env.DSH_HOME;
  const home = typeof env.HOME === 'string' && env.HOME.length > 0 ? env.HOME : homedir();
  return join(home, '.dsh');
}

/** 本插件自己的 package 目錄（由模組 URL 反推）；不是 `file:` URL 時 undefined。 */
function selfPackageDir(moduleUrl) {
  if (typeof moduleUrl !== 'string' || !moduleUrl.startsWith('file:')) return undefined;
  try {
    return dirname(dirname(fileURLToPath(moduleUrl)));
  } catch {
    // 不是合法的 file: URL：沒有自我目錄可比對，退回「不排序」。
    return undefined;
  }
}

/** 讀本插件的 package 名稱（用來認出哪個 profile 把本插件 link 進來）；讀不到時 undefined。 */
function selfPackageName(directory) {
  if (directory === undefined) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    return typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : undefined;
  } catch {
    // package.json 讀不到或不是 JSON：只影響排序，不影響可用性。
    return undefined;
  }
}

/** 這個 profile 的 `node_modules/<本插件>` 是否真的指向本插件自己的目錄。 */
function linksSelf(nodeModulesDir, name, directory) {
  if (name === undefined || directory === undefined) return false;
  try {
    return realpathSync(join(nodeModulesDir, name)) === realpathSync(directory);
  } catch {
    // 該 profile 沒裝本插件：它只是備援解析根，不是「就是這個 profile」。
    return false;
  }
}

/**
 * DSH home 底下 `profiles/*` 的解析根，把「有把本插件 link 進來」的那個 profile 排在最前面。
 *
 * 這是 `link:` 安裝的補位：Node 預設解析符號連結的**真實路徑**，所以插件跑起來之後
 * 只看得到 `~/dsh-cbm-plugin`，看不到 `$DSH_PROFILE_DIR/node_modules/`。而
 * `DSH_PROFILE_DIR` 只由 `dsh-shell-env` 注入**每一次模型 shell 呼叫的子行程**，
 * 宿主行程（載入插件的 `dsh web`）的 `process.env` 裡並沒有這個變數——實測
 * `/proc/<pid>/environ` 完全沒有 `DSH_*`。因此宿主內唯一可靠的線索是 DSH home
 * 底下的 profile 目錄本身。
 *
 * @param {Record<string, string|undefined>} [env] - 環境變數表，預設 process.env。
 * @param {string} [moduleUrl] - 本模組的 URL，預設 import.meta.url。
 * @returns {string[]} profile 的 `package.json` 解析根（沒有 profiles 目錄時為空陣列）。
 */
export function profilePackageRoots(env, moduleUrl) {
  const environment = env ?? process.env;
  const url = moduleUrl ?? import.meta.url;
  const profilesDir = join(dshHome(environment), 'profiles');
  let names;
  try {
    names = readdirSync(profilesDir, { withFileTypes: true })
      .filter(function (entry) { return entry.isDirectory() && !entry.name.startsWith('.'); })
      .map(function (entry) { return entry.name; })
      .filter(function (name) { return name !== 'node_modules'; })
      .sort();
  } catch {
    // 沒有 profiles 目錄（不是 profile 啟動的部署）：沒有備援解析根。
    return [];
  }
  const directory = selfPackageDir(url);
  const name = selfPackageName(directory);
  const linked = [];
  const others = [];
  for (const profile of names) {
    const root = join(profilesDir, profile, 'package.json');
    if (linksSelf(join(profilesDir, profile, 'node_modules'), name, directory)) linked.push(root);
    else others.push(root);
  }
  return linked.concat(others);
}

/**
 * 依序嘗試的 schemastery 解析根。
 *
 * 順序不是隨便排的：本插件以 `link:` 安裝，`import.meta.url` 指向工作區
 * （`~/dsh-cbm-plugin`，那裡沒有 `node_modules`），從那裡往上走**到不了** profile
 * 的 `node_modules`；而 `DSH_PROFILE_DIR` 在宿主行程裡是空的（見
 * {@link profilePackageRoots}），所以真正會命中的是排在最後的 profile 解析根。
 * 前三根保留給「環境有給」、「插件自己裝了相依」、「以 cwd 啟動」這三種正常情形。
 *
 * @param {Record<string, string|undefined>} [env] - 環境變數表，預設 process.env。
 * @param {string} [cwd] - 目前工作目錄，預設 process.cwd()。
 * @param {string} [moduleUrl] - 本模組的 URL，預設 import.meta.url。
 * @returns {string[]} createRequire 的解析根。
 */
export function schemasteryRequireRoots(env, cwd, moduleUrl) {
  const environment = env ?? process.env;
  const url = moduleUrl ?? import.meta.url;
  const roots = [];
  const profileDir = environment.DSH_PROFILE_DIR;
  if (typeof profileDir === 'string' && profileDir.length > 0) {
    roots.push(join(profileDir, 'package.json'));
  }
  roots.push(url);
  roots.push(join(cwd ?? process.cwd(), 'package.json'));
  for (const root of profilePackageRoots(environment, url)) {
    if (!roots.includes(root)) roots.push(root);
  }
  return roots;
}

/**
 * 依序在給定的解析根上取用 schemastery；全部落空時回 null。
 *
 * @param {string[]} roots - createRequire 的解析根。
 * @returns {object|null} schemastery 的 `z`。
 */
export function resolveSchemastery(roots) {
  for (const root of roots) {
    try {
      const require = createRequire(root);
      const loaded = require('@deepseek-ai/schemastery');
      const candidate = loaded !== null && typeof loaded === 'object' && 'default' in loaded ? loaded.default : loaded;
      // 只認真的 schemastery：`z.object` 必須是可呼叫的建構子。
      if (candidate !== null && candidate !== undefined && typeof candidate.object === 'function') return candidate;
    } catch {
      // 這個解析根上沒有 schemastery：換下一個。
    }
  }
  return null;
}

/**
 * 取得 DSH 的 schemastery（`@deepseek-ai/schemastery`，不是 npm 上那個同名套件）。
 *
 * 這支 fork 只在 DSH profile 的解析路徑上，不在 npm 上，所以它既不能列進
 * `dependencies`（pnpm 會去 registry 抓而失敗），也不該讓整支插件在解析不到時
 * 直接載入失敗。取用方式刻意做成 guarded：拿得到就匯出真正的 Config schema
 * （設定頁因此有型別、預設值，而且該 entry 才是「可配置的」）；拿不到就以
 * `undefined` 匯出，插件仍可運作，但設定頁與 REST 的寫入路徑會失效。
 *
 * @returns {object|null} schemastery 的 `z`，取不到時 null。
 */
function loadSchemastery() {
  return resolveSchemastery(schemasteryRequireRoots());
}

/** 本次載入取得的 schemastery；null 表示此部署沒有它。 */
const z = loadSchemastery();

/** 預設值的單一來源：schema 與純函式正規化都從這裡取。 */
export const CONFIG_DEFAULTS = {
  enabled: true,
  cliPath: '',
  mode: 'full',
  rebuildTimeoutSeconds: 1800,
  scanMinutes: 5,
  watchEnabled: true,
  debounceMs: 3000,
  autoRebuild: true,
  includeDirty: true,
  nice: 10,
  maxLogEntries: 500,
  extensions: '',
  excludes: '',
  includeProjects: '',
  excludeProjects: '',
  graphUrl: '',
};

/** Config 的欄位順序＝設定頁列出的順序。 */
export const CONFIG_FIELDS = [
  'enabled',
  'cliPath',
  'mode',
  'rebuildTimeoutSeconds',
  'scanMinutes',
  'watchEnabled',
  'debounceMs',
  'autoRebuild',
  'includeDirty',
  'nice',
  'maxLogEntries',
  'extensions',
  'excludes',
  'includeProjects',
  'excludeProjects',
  'graphUrl',
];

/**
 * 設定 schema。每個欄位都 volatile：設定頁寫入後就地生效，不必重啟 DSH。
 *
 * 沒有 schemastery 的部署（見 {@link loadSchemastery}）匯出 `undefined`，
 * Loader 因此跳過 schema 驗證；`resolveKeeperConfig` 對純物件一樣可用。
 */
export const Config = z === null ? undefined : z.object({
  enabled: z.boolean().default(CONFIG_DEFAULTS.enabled)
    .description('總開關。關閉後停止掃描、監看與自動重建；路由與設定頁仍可用，方便再打開。').volatile(),
  cliPath: z.string().default(CONFIG_DEFAULTS.cliPath)
    .description('codebase-memory-mcp 執行檔的絕對路徑。留空則依序找 CBM_BIN、PATH、平台常見路徑。').volatile(),
  mode: z.union([z.const('fast'), z.const('moderate'), z.const('full')]).default(CONFIG_DEFAULTS.mode)
    .description('重建模式。fast＝僅過濾、moderate＝過濾＋語意、full＝全部＋語意。').volatile(),
  rebuildTimeoutSeconds: z.number().min(30).max(21600).default(CONFIG_DEFAULTS.rebuildTimeoutSeconds)
    .description('單次重建的逾時秒數。sample-repo 實測約 61 秒，預設值留足餘裕。').volatile(),
  scanMinutes: z.number().min(0.5).max(1440).default(CONFIG_DEFAULTS.scanMinutes)
    .description('自動掃描上游專案清單與落後狀態的間隔（分鐘）。').volatile(),
  watchEnabled: z.boolean().default(CONFIG_DEFAULTS.watchEnabled)
    .description('是否為每個已納管專案建立檔案監看；關閉後只剩定時掃描。').volatile(),
  debounceMs: z.number().min(200).max(600000).default(CONFIG_DEFAULTS.debounceMs)
    .description('監看觸發的防抖毫秒；同一批存檔只算一次重建。').volatile(),
  autoRebuild: z.boolean().default(CONFIG_DEFAULTS.autoRebuild)
    .description('偵測到落後時自動排入重建。關閉後只回報落後，一切重建都得手動觸發。').volatile(),
  includeDirty: z.boolean().default(CONFIG_DEFAULTS.includeDirty)
    .description('把未提交的工作樹變更也算成落後。').volatile(),
  nice: z.number().min(0).max(19).default(CONFIG_DEFAULTS.nice)
    .description('重建子行程的 nice 值；0 表示不讓路。').volatile(),
  maxLogEntries: z.number().min(50).max(10000).default(CONFIG_DEFAULTS.maxLogEntries)
    .description('記憶體中保留的日誌筆數（UI 可查）；檔案日誌不受此限。').volatile(),
  extensions: z.string().default(CONFIG_DEFAULTS.extensions)
    .description('監看的副檔名白名單，逗號分隔。留空＝內建清單；填 * ＝不過濾。').volatile(),
  excludes: z.string().default(CONFIG_DEFAULTS.excludes)
    .description('監看排除的目錄名，逗號分隔。留空＝內建清單。').volatile(),
  includeProjects: z.string().default(CONFIG_DEFAULTS.includeProjects)
    .description('只納管這些專案名（逗號分隔）。留空＝全部納管。').volatile(),
  excludeProjects: z.string().default(CONFIG_DEFAULTS.excludeProjects)
    .description('排除這些專案名（逗號分隔）。').volatile(),
  graphUrl: z.string().default(CONFIG_DEFAULTS.graphUrl)
    .description('CBM 圖譜 UI 的來源網址（http/https）。留空＝由 CBM 的 ui_port 推導成 http://127.0.0.1:<port>；遠端或反向代理情境在此覆寫。').volatile(),
});

/**
 * 把逗號分隔的清單字串拆成陣列。
 * @param {string|undefined} value - 原始字串。
 * @returns {string[]} 去空白、去空項的陣列。
 */
function splitList(value) {
  if (typeof value !== 'string') return [];
  return value.split(',').map(function (part) { return part.trim(); }).filter(function (part) { return part.length > 0; });
}

/**
 * 把（可能是 volatile 參照的）設定值正規化成純物件。
 *
 * volatile 欄位在執行期是帶 `.get()` 的參照物件；沒有 volatile 的部署（例如
 * 直接以純物件呼叫 apply 的測試）則直接是值。兩種都要吃。
 *
 * @param {object|undefined} config - Loader 傳入的 config。
 * @returns {object} 正規化後的設定值。
 */
export function readConfigValues(config) {
  const out = {};
  for (const field of CONFIG_FIELDS) {
    const raw = config === undefined ? undefined : config[field];
    let value = raw;
    if (raw !== null && typeof raw === 'object' && typeof raw.get === 'function') {
      value = raw.get();
    }
    if (value === undefined || value === null || value === '') {
      // 空字串要保留語意（＝「用內建清單」），所以只有 undefined/null 才回退預設。
      if (value === '') {
        out[field] = '';
        continue;
      }
      out[field] = CONFIG_DEFAULTS[field];
      continue;
    }
    out[field] = value;
  }
  return out;
}

/**
 * 把數字夾進 schema 宣告的界線內。
 *
 * schema 的 `.min()`／`.max()` 只在值經過 Loader 時生效；`resolveKeeperConfig`
 * 是執行期讀取點，也是唯一會在沒有 settings 服務的部署裡跑到的路徑，所以界線
 * 必須在這裡再套一次——否則一個手改的 `cordis.patch.yml` 就能把掃描間隔設成
 * 99,999 分鐘而不會被擋下。
 *
 * @param {unknown} value - 原始值。
 * @param {number} fallback - 無法解析時的回退值。
 * @param {number} min - 下限。
 * @param {number} max - 上限。
 * @returns {number} 夾住後的值。
 */
function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * 把原始設定正規化成執行期設定（含解析後的清單與數值界線）。
 * @param {object|undefined} config - Loader 傳入的 config。
 * @returns {object} 執行期設定。
 */
export function resolveKeeperConfig(config) {
  const values = readConfigValues(config);
  const extensionList = splitList(values.extensions);
  const excludeList = splitList(values.excludes);
  const wildcard = extensionList.includes('*');
  return {
    enabled: values.enabled === true,
    cliPath: typeof values.cliPath === 'string' && values.cliPath.trim().length > 0 ? values.cliPath.trim() : undefined,
    mode: ['fast', 'moderate', 'full'].includes(values.mode) ? values.mode : 'full',
    rebuildTimeoutMs: clampNumber(values.rebuildTimeoutSeconds, CONFIG_DEFAULTS.rebuildTimeoutSeconds, 30, 21600) * 1000,
    scanMs: clampNumber(values.scanMinutes, CONFIG_DEFAULTS.scanMinutes, 0.5, 1440) * 60000,
    watchEnabled: values.watchEnabled === true,
    debounceMs: clampNumber(values.debounceMs, CONFIG_DEFAULTS.debounceMs, 200, 600000),
    autoRebuild: values.autoRebuild === true,
    includeDirty: values.includeDirty === true,
    nice: clampNumber(values.nice, CONFIG_DEFAULTS.nice, 0, 19),
    maxLogEntries: clampNumber(values.maxLogEntries, CONFIG_DEFAULTS.maxLogEntries, 50, 10000),
    extensions: wildcard ? [] : (extensionList.length > 0 ? extensionList : DEFAULT_WATCH_EXTENSIONS),
    excludes: excludeList.length > 0 ? excludeList : DEFAULT_WATCH_EXCLUDES,
    includeProjects: splitList(values.includeProjects),
    excludeProjects: splitList(values.excludeProjects),
    graphUrl: typeof values.graphUrl === 'string' ? values.graphUrl.trim() : '',
  };
}

/**
 * 判斷一個專案名是否應該被納管（FR-7 的選擇面）。
 * @param {string} name - 上游專案名。
 * @param {object} config - 執行期設定。
 * @returns {boolean} 應納管則 true。
 */
export function isProjectSelected(name, config) {
  if (config.excludeProjects.includes(name)) return false;
  if (config.includeProjects.length === 0) return true;
  return config.includeProjects.includes(name);
}
