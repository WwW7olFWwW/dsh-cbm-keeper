/**
 * Codebase Memory CLI 的讀寫封裝（FR-2/FR-4/FR-11/FR-15）。
 *
 * CBM 0.11.0 的 CLI 沒有結構化輸出：`--json` 只把 MCP 信封原樣包出來，內文
 * 仍是以空白對齊的文字表（R1）。因此這裡的解析器是整個插件最脆弱的一環，
 * 全部集中在這一支檔案，並且刻意寫成「解析不到就回 undefined，不猜」——
 * 上層據此降級成 `stale=null` 並在 UI 具名呈現，而不是假裝圖譜是新鮮的。
 */

import {
  CBM_TOOLS,
  GRAPH_HEAD_QUERY,
  SUPPORTED_CBM_VERSIONS,
} from './constants.js';
import { readCliVersion, runCbmTool } from './cli.js';
import { normalizeSha } from './staleness.js';

/** 讀取型工具的逾時：`list_projects`／`index_status` 實測皆在 3 秒內完成。 */
const READ_TIMEOUT_MS = 60000;

/**
 * 解析 `key: value` 形式的兩層文字樹。
 *
 * 例：`parseKeyValueTree('a: 1\ns:\n  n: 2\n')` → `{a: '1', s: {n: '2'}}`。
 *
 * @param {string} text - CLI 內文。
 * @returns {{values: Record<string, string>, sections: Record<string, Record<string, string>>}}
 *   純量欄位與一層子區段。
 */
export function parseKeyValueTree(text) {
  const values = {};
  const sections = {};
  let current;
  const lines = String(text ?? '').split('\n');
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const indented = /^\s+\S/.test(line);
    const match = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1];
    const value = match[2].trim();
    if (indented) {
      if (current !== undefined) current[key] = value;
      continue;
    }
    if (value.length === 0) {
      current = {};
      sections[key] = current;
      continue;
    }
    current = undefined;
    values[key] = value;
  }
  return { values, sections };
}

/**
 * 解析 CBM 的文字表。
 *
 * 表頭形如 `projects: 2  (cols: name root_path branch)`，其後是兩個空白縮排的
 * 資料列。多欄且欄位內含空白時（root_path 可能有空白），採「首欄吃第一個
 * token、末欄吃最後一個 token、其餘中間 token 全部歸第二欄」的切法——這對
 * CBM 現行的 `name root_path branch` 是精確的，因為 name 與 branch 都不含空白。
 *
 * @param {string} text - CLI 內文。
 * @returns {{name: string|undefined, count: number|undefined, cols: string[], rows: string[][]}}
 *   表格解析結果。
 */
export function parseTable(text) {
  const lines = String(text ?? '').split('\n');
  const rows = [];
  let name;
  let count;
  let cols = [];
  for (const line of lines) {
    const header = /^\s*([A-Za-z0-9_-]+)\s*:\s*(\d+)\s*\(cols:\s*([^)]*)\)\s*$/.exec(line);
    if (header !== null) {
      name = header[1];
      count = Number.parseInt(header[2], 10);
      cols = header[3].trim().split(/\s+/).filter(function (part) { return part.length > 0; });
      continue;
    }
    if (/^\s{2,}\S/.test(line) && cols.length > 0) {
      const trimmed = line.trim();
      if (trimmed.length > 0) rows.push(splitTableRow(trimmed, cols.length));
    }
  }
  return { name, count, cols, rows };
}

/**
 * 把一列文字切成固定欄數。
 *
 * 三欄（`name root_path branch`）時採「路徑錨定」：找出第一個看起來像絕對路徑
 * 的 token，它之前的都屬於 name、它到最後一個 token（不含）之間屬於 root_path、
 * 最後一個 token 是 branch。這讓 name 內含空白時仍能正確切分——單純按 token
 * 數量的啟發式在那種情況下會把 root_path 切掉一段。
 *
 * 找不到路徑錨點時退回「首欄吃第一個 token、其餘中間 token 歸第二欄」的切法，
 * 這是 CBM 現行輸出（name／branch 皆無空白）的精確解。
 *
 * @param {string} line - 已去頭尾空白的資料列。
 * @param {number} columnCount - 欄數。
 * @returns {string[]} 欄位值。
 */
export function splitTableRow(line, columnCount) {
  const tokens = line.split(/\s+/).filter(function (part) { return part.length > 0; });
  if (columnCount <= 1) return [line];
  if (columnCount === 3 && tokens.length > 3) {
    const anchor = tokens.findIndex(looksLikeAbsolutePath);
    if (anchor > 0) {
      return [tokens.slice(0, anchor).join(' '), tokens.slice(anchor, tokens.length - 1).join(' '), tokens[tokens.length - 1]];
    }
  }
  if (tokens.length === columnCount) return tokens;
  if (tokens.length < columnCount) {
    const padded = tokens.slice();
    while (padded.length < columnCount) padded.push('');
    return padded;
  }
  const out = [tokens[0]];
  const trailing = columnCount - 2;
  const middleEnd = tokens.length - trailing;
  out.push(tokens.slice(1, middleEnd).join(' '));
  for (let index = middleEnd; index < tokens.length; index += 1) out.push(tokens[index]);
  return out;
}

/**
 * 判斷一個 token 像不像絕對路徑（POSIX `/…` 或 Windows `C:\…`／`C:/…`）。
 * @param {string} token - 待檢查的文字。
 * @returns {boolean} 像絕對路徑則 true。
 */
export function looksLikeAbsolutePath(token) {
  return typeof token === 'string' && (/^\//.test(token) || /^[A-Za-z]:[\\/]/.test(token));
}

/**
 * 解析 `list_projects` 的輸出。
 *
 * 無法確認為路徑的資料列一律丟棄而不是猜：欄位錯位的專案會在後續被當成
 * 「上游有這棵樹」而觸發重建，代價遠高於少一筆記錄。丟棄的數量由呼叫端從
 * 「回報總數 vs 實際解析數」的落差看出來（`parseTable` 的 `count`）。
 *
 * @param {string} text - CLI 內文。
 * @returns {Array<{name: string, rootPath: string, branch: string}>} 專案清單。
 */
export function parseListProjects(text) {
  const table = parseTable(text);
  if (table.name !== 'projects') return [];
  const index = Object.fromEntries(table.cols.map(function (col, position) { return [col, position]; }));
  const out = [];
  for (const row of table.rows) {
    const name = row[index.name ?? 0];
    const rootPath = row[index.root_path ?? 1];
    if (typeof name !== 'string' || name.length === 0) continue;
    if (typeof rootPath !== 'string' || !looksLikeAbsolutePath(rootPath)) continue;
    out.push({
      name,
      rootPath,
      branch: row[index.branch ?? 2] ?? '',
    });
  }
  return out;
}

/**
 * 解析 `index_status` 的輸出（FR-11）。
 * @param {string} text - CLI 內文。
 * @returns {object} 正規化後的索引狀態。
 */
export function parseIndexStatus(text) {
  const tree = parseKeyValueTree(text);
  const values = tree.values;
  const sections = tree.sections;
  return {
    project: values.project,
    rootPath: values.root_path,
    status: values.status,
    nodes: toNumber(values.nodes),
    edges: toNumber(values.edges),
    indexedAt: values.indexed_at,
    parsePartialCount: toNumber((sections.parse_partial ?? {}).count),
    parseUnusableCount: toNumber((sections.parse_unusable ?? {}).count),
    skippedCount: toNumber((sections.skipped ?? {}).count),
    notIndexedFilesCount: toNumber((sections.not_indexed ?? {}).files_count),
    notIndexedDirsCount: toNumber((sections.not_indexed ?? {}).dirs_count),
  };
}

/**
 * 從 `query_graph` 的輸出取出圖譜 HEAD（FR-2）。
 * @param {string} text - CLI 內文。
 * @returns {string|undefined} 正規化後的 sha。
 */
export function parseGraphHead(text) {
  const table = parseTable(text);
  const headIndex = table.cols.indexOf('head');
  for (const row of table.rows) {
    const candidate = headIndex >= 0 ? row[headIndex] : row[0];
    const sha = normalizeSha(candidate);
    if (sha !== undefined) return sha;
  }
  // 有些回應格式不會帶表頭；直接掃 16 進位字串當最後手段。
  const loose = /^\s{2,}([0-9a-fA-F]{7,40})\s*$/m.exec(String(text ?? ''));
  return loose === null ? undefined : normalizeSha(loose[1]);
}

/**
 * 解析 `codebase-memory-mcp config list` 的輸出（R6 偵測用）。
 * @param {string} text - CLI 內文。
 * @returns {Record<string, string>} 設定鍵值。
 */
export function parseConfigList(text) {
  const out = {};
  const lines = String(text ?? '').split('\n');
  for (const line of lines) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match !== null) out[match[1]] = match[2];
  }
  return out;
}

/**
 * 把字串轉成整數；無法解析時 undefined。
 * @param {string|undefined} value - 原始值。
 * @returns {number|undefined} 整數。
 */
function toNumber(value) {
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseInt(value.replace(/[,_]/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * CBM CLI 的客戶端：所有與上游的互動都經由這一支。
 */
export class CbmClient {
  /**
   * @param {object} options - 建構選項。
   * @param {() => {path: string, source: string} | undefined} options.cliPath - 目前解析到的 CLI 路徑供應器（設定可變）。
   * @param {import('./log.js').KeeperLog} options.log - 日誌器。
   * @param {number} [options.nice] - nice 值。
   */
  constructor(options) {
    this.cliPath = options.cliPath;
    this.log = options.log;
    this.nice = options.nice ?? 0;
  }

  /**
   * 實際執行一次 CLI 呼叫；解析不到執行檔時回具名錯誤而不是拋。
   * @param {string[]} args - CLI 參數。
   * @param {number} [timeoutMs] - 逾時。
   * @param {AbortSignal} [signal] - 取消訊號。
   * @returns {Promise<{ok: boolean, text: string, error: string|undefined, durationMs: number}>} 呼叫結果。
   */
  async call(args, timeoutMs, signal) {
    const resolved = this.cliPath();
    if (resolved === undefined) {
      return {
        ok: false,
        text: '',
        error: '尚未解析到 codebase-memory-mcp 執行檔；請在設定頁指定路徑或設定 CBM_BIN。',
        durationMs: 0,
      };
    }
    return runCbmTool({
      cliPath: resolved.path,
      args,
      timeoutMs: timeoutMs ?? READ_TIMEOUT_MS,
      nice: this.nice,
      signal,
    });
  }

  /**
   * 讀取版本（FR-15）。
   * @returns {Promise<{version: string|undefined, supported: boolean|null}>} 版本與相容性。
   */
  async version() {
    const resolved = this.cliPath();
    if (resolved === undefined) return { version: undefined, supported: null };
    const version = await readCliVersion(resolved.path);
    if (version === undefined) return { version: undefined, supported: null };
    return { version, supported: SUPPORTED_CBM_VERSIONS.includes(version) };
  }

  /**
   * 列出上游已知的專案。
   * @returns {Promise<{ok: boolean, projects: Array<object>, error: string|undefined}>} 清單。
   */
  async listProjects() {
    const result = await this.call([CBM_TOOLS.listProjects]);
    if (!result.ok) return { ok: false, projects: [], error: result.error };
    const projects = parseListProjects(result.text);
    if (projects.length === 0 && /projects:\s*0/.test(result.text) === false) {
      return { ok: false, projects: [], error: 'list_projects 的輸出無法解析（上游格式可能已改變）' };
    }
    return { ok: true, projects, error: undefined };
  }

  /**
   * 讀取單一專案的索引狀態。
   * @param {string} projectName - 專案名。
   * @returns {Promise<{ok: boolean, status: object|undefined, error: string|undefined}>} 狀態。
   */
  async indexStatus(projectName) {
    const result = await this.call([CBM_TOOLS.indexStatus, '--project', projectName]);
    if (!result.ok) return { ok: false, status: undefined, error: result.error };
    return { ok: true, status: parseIndexStatus(result.text), error: undefined };
  }

  /**
   * 讀取圖譜內的 HEAD（FR-2 的主判據）。
   * @param {string} projectName - 專案名。
   * @returns {Promise<{ok: boolean, head: string|undefined, error: string|undefined}>} HEAD。
   */
  async graphHead(projectName) {
    const result = await this.call([
      CBM_TOOLS.queryGraph,
      '--project', projectName,
      '--query', GRAPH_HEAD_QUERY,
    ]);
    if (!result.ok) return { ok: false, head: undefined, error: result.error };
    return { ok: true, head: parseGraphHead(result.text), error: undefined };
  }

  /**
   * 讀取 CBM 的全域設定（R6：偵測內建 auto_index／watcher 是否與本插件打架）。
   * @returns {Promise<{ok: boolean, config: Record<string, string>, error: string|undefined}>} 設定。
   */
  async globalConfig() {
    const resolved = this.cliPath();
    if (resolved === undefined) return { ok: false, config: {}, error: 'CLI 路徑未解析' };
    const { execFileText } = await import('./exec.js');
    const result = await execFileText(resolved.path, ['config', 'list'], { timeoutMs: READ_TIMEOUT_MS });
    if (result.code !== 0) {
      return { ok: false, config: {}, error: 'config list 失敗：' + (result.stderr.trim() || 'exit ' + String(result.code)) };
    }
    return { ok: true, config: parseConfigList(result.stdout), error: undefined };
  }

  /**
   * 觸發一次重建（FR-4：走 CLI，不經 MCP 的 60 秒上限）。
   * @param {object} request - 重建請求。
   * @param {string} request.rootPath - repo 絕對路徑。
   * @param {string} request.name - 專案名（必須沿用既有 name，FR-1）。
   * @param {string} request.mode - fast | moderate | full。
   * @param {number} request.timeoutMs - 逾時毫秒。
   * @param {AbortSignal} [request.signal] - 取消訊號。
   * @returns {Promise<{ok: boolean, durationMs: number, error: string|undefined, command: string}>} 結果。
   */
  async index(request) {
    const result = await this.call([
      CBM_TOOLS.indexRepository,
      '--repo-path', request.rootPath,
      '--mode', request.mode,
      '--name', request.name,
    ], request.timeoutMs, request.signal);
    return {
      ok: result.ok,
      durationMs: result.durationMs,
      error: result.error,
      command: result.command ?? '',
    };
  }
}
