/**
 * 純決策層：專案身分鍵、落後判定、重建模式選擇。
 *
 * 這一層刻意不碰檔案系統與子行程（NFR-7）：所有外部事實都以參數傳入，因此
 * 可以用假 git／假圖譜在單元測試裡逐值驗證，不需要真的索引任何東西。
 */

import { MAX_BEHIND_BY } from './constants.js';

/**
 * 把使用者／上游給的 repo 根路徑正規化為身分鍵（FR-1）。
 *
 * 只做字串層級的正規化：去除尾斜線、把重複斜線收斂、保留大小寫（Linux 上
 * 大小寫有別）。符號連結的解析屬於檔案系統層，由 `resolveRootPath` 負責。
 *
 * @param {string} rootPath - 原始路徑。
 * @returns {string} 正規化後的身分鍵。
 */
export function canonicalRootPath(rootPath) {
  const raw = String(rootPath ?? '').trim();
  if (raw.length === 0) return '';
  const collapsed = raw.replace(/\/{2,}/g, '/');
  const withoutTrailing = collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
  return withoutTrailing.length === 0 ? '/' : withoutTrailing;
}

/**
 * 專案身分鍵。同一棵樹的兩種名字必須映到同一個鍵（FR-1）。
 * @param {string} rootPath - repo 根路徑。
 * @returns {string} 身分鍵。
 */
export function projectIdentityKey(rootPath) {
  return canonicalRootPath(rootPath);
}

/**
 * 依身分鍵把上游 `list_projects` 的結果併進既有的專案表。
 *
 * 這是 FR-1 的執行點：同一個 root_path 已存在時沿用它既有的 `name`，不因
 * 上游換了名字而新建一筆。回傳值同時報告「新增了哪些」與「改名了哪些」，
 * 讓呼叫端能把改名寫進日誌（可見性，而不是靜默）。
 *
 * @param {Array<{name: string, rootPath: string, branch?: string}>} existing - 既有專案。
 * @param {Array<{name: string, rootPath: string, branch?: string}>} incoming - 上游回報的專案。
 * @returns {{projects: Array<object>, added: string[], renamed: Array<{key: string, from: string, to: string}>, duplicates: Array<{key: string, names: string[]}>}}
 *   併入結果。
 */
export function mergeProjectsByRootPath(existing, incoming) {
  const byKey = new Map();
  for (const project of existing ?? []) {
    const key = projectIdentityKey(project.rootPath);
    if (key.length > 0) byKey.set(key, { ...project, rootPath: canonicalRootPath(project.rootPath) });
  }

  const added = [];
  const renamed = [];
  const incomingKeys = new Map();
  for (const project of incoming ?? []) {
    const key = projectIdentityKey(project.rootPath);
    if (key.length === 0) continue;
    if (!incomingKeys.has(key)) incomingKeys.set(key, []);
    incomingKeys.get(key).push(project.name);
    const current = byKey.get(key);
    if (current === undefined) {
      byKey.set(key, {
        ...project,
        rootPath: canonicalRootPath(project.rootPath),
      });
      added.push(project.name);
      continue;
    }
    if (project.name !== current.name) {
      renamed.push({ key, from: current.name, to: project.name });
    }
    // 既有 name 是權威：重建時一律帶這個名字回上游，避免同名不同樹或同樹不同名。
    byKey.set(key, {
      ...current,
      branch: project.branch ?? current.branch,
      upstreamName: project.name,
    });
  }

  const duplicates = [];
  for (const [key, names] of incomingKeys) {
    if (names.length > 1) duplicates.push({ key, names });
  }

  return { projects: Array.from(byKey.values()), added, renamed, duplicates };
}

/**
 * 量測圖譜與工作樹之間的落差。
 *
 * 主判據是 HEAD 比對（FR-2）；`Branch.head_sha` 缺席時退回時間旁證（R2），
 * 並在 `confidence` 上明確標示用了哪一種——UI 必須能區分「確定落後」與
 * 「只能推測」（FR-9）。
 *
 * @param {object} input - 判定輸入。
 * @param {string|undefined} input.graphHead - 圖譜內的 HEAD（`Branch.head_sha`）。
 * @param {string|undefined} input.liveHead - 工作樹實際 HEAD（`git rev-parse HEAD`）。
 * @param {number|undefined} input.behindBy - `git rev-list --count graph..live`。
 * @param {boolean} input.dirty - 工作樹是否有未提交變更。
 * @param {boolean} input.includeDirty - 是否把未提交變更也算落後（FR-3）。
 * @param {string|undefined} input.indexedAt - 圖譜的 `indexed_at`。
 * @param {string|undefined} input.dbMtime - 圖譜 DB 檔的 mtime（旁證）。
 * @param {string|undefined} input.headCommittedAt - 工作樹 HEAD 的提交時間。
 * @returns {{stale: boolean|null, behindBy: number|null, confidence: 'head'|'time'|'none', reasons: string[]}}
 *   判定結果；`stale` 為 null 表示證據不足，呼叫端不得把它當成「新鮮」。
 */
export function decideStaleness(input) {
  const reasons = [];
  const graphHead = normalizeSha(input.graphHead);
  const liveHead = normalizeSha(input.liveHead);
  const behindBy = normalizeBehindBy(input.behindBy);

  if (graphHead !== undefined && liveHead !== undefined) {
    if (graphHead === liveHead) {
      if (input.dirty === true && input.includeDirty === true) {
        reasons.push('head-match-but-dirty');
        return { stale: true, behindBy: 0, confidence: 'head', reasons };
      }
      reasons.push('head-match');
      return { stale: false, behindBy: 0, confidence: 'head', reasons };
    }
    reasons.push('head-advanced');
    return { stale: true, behindBy, confidence: 'head', reasons };
  }

  if (graphHead !== undefined && liveHead === undefined) {
    reasons.push('live-head-unavailable');
    return { stale: null, behindBy: null, confidence: 'none', reasons };
  }

  // 圖譜沒有 Branch 節點（R2）：只能用時間旁證，並明確降級。
  const graphTime = parseTimestamp(input.indexedAt) ?? parseTimestamp(input.dbMtime);
  const headTime = parseTimestamp(input.headCommittedAt);
  if (graphTime !== undefined && headTime !== undefined) {
    if (headTime > graphTime) {
      reasons.push('time-fallback-head-newer');
      return { stale: true, behindBy: null, confidence: 'time', reasons };
    }
    reasons.push('time-fallback-head-older');
    return { stale: false, behindBy: null, confidence: 'time', reasons };
  }

  reasons.push('no-evidence');
  return { stale: null, behindBy: null, confidence: 'none', reasons };
}

/**
 * 這組落後理由是不是「只因為未提交變更」（C1）。
 *
 * `head-match-but-dirty` 是唯一**不會自己消失**的落後：未提交變更只要不 commit
 * 就一直存在。正在編輯時「有沒有活動」的答案永遠是有，所以這種落後不值得跟
 * 編輯器賽跑——它需要的是靜默視窗，不是更快的重跑。真正的 HEAD 落後
 * （`head-advanced`／`time-fallback-head-newer`）不算在內，必須維持立即重建。
 *
 * @param {string[]|undefined} reasons - {@link decideStaleness} 給的理由碼。
 * @returns {boolean} 只因為 dirty 而落後則 true。
 */
export function isDirtyOnlyStale(reasons) {
  const list = Array.isArray(reasons) ? reasons : [];
  return list.includes('head-match-but-dirty') && !list.includes('head-advanced');
}

/**
 * dirty-only 的落後是否已經「靜默」足夠久，值得重跑（C1）。
 *
 * 三個條件缺一不可：有過檔案活動、距最後一次活動已達 `settleMs`、且那次活動
 * 發生在最後一次索引之後（沒有活動的 dirty 專案放著就好）。`settleMs` 為 0 時
 * 退化成現行行為（有活動就排）——預設值就是 0，所以不改動既有語意。
 *
 * @param {object} input - 判定輸入。
 * @param {string|undefined} input.lastTriggerAt - 監看器最後一次觸發時間（ISO）。
 * @param {string|undefined} input.lastIndexedAt - 這個專案最後一次成功重建時間（ISO）。
 * @param {number} input.settleMs - 靜默視窗毫秒。
 * @param {number} [input.now] - 現在的 epoch 毫秒（測試注入；預設 Date.now()）。
 * @returns {boolean} 可以排重建則 true。
 */
export function isDirtySettled(input) {
  const triggerAt = parseTimestamp(input.lastTriggerAt);
  if (triggerAt === undefined) return false;
  const settleMs = typeof input.settleMs === 'number' && Number.isFinite(input.settleMs) && input.settleMs > 0
    ? input.settleMs
    : 0;
  const now = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now();
  if (now - triggerAt < settleMs) return false;
  const indexedAt = parseTimestamp(input.lastIndexedAt);
  if (indexedAt === undefined) return true;
  return triggerAt > indexedAt;
}

/**
 * 依請求與設定挑選重建模式（FR-14）。
 *
 * 明確請求永遠優先；其次專案規模：超過 autoIndexLimit 的樹用 `full`，否則
 * 沿用設定的預設值。這裡不做 I/O，只做選擇。
 *
 * @param {object} input - 選擇輸入。
 * @param {string|undefined} input.requested - 呼叫端明確要求的模式。
 * @param {string} input.configured - 設定檔的預設模式。
 * @param {number|undefined} input.fileCount - 專案檔案數（可選）。
 * @param {number} [input.largeProjectFileCount] - 視為大型專案的門檻。
 * @returns {{mode: string, reason: string}} 模式與理由。
 */
export function pickRebuildMode(input) {
  const allowed = new Set(['fast', 'moderate', 'full']);
  if (typeof input.requested === 'string' && allowed.has(input.requested)) {
    return { mode: input.requested, reason: 'requested' };
  }
  const threshold = input.largeProjectFileCount ?? 10000;
  if (typeof input.fileCount === 'number' && input.fileCount > threshold) {
    return { mode: 'full', reason: 'large-project' };
  }
  if (allowed.has(input.configured)) {
    return { mode: input.configured, reason: 'configured' };
  }
  return { mode: 'full', reason: 'default' };
}

/**
 * 正規化 commit sha：只接受 7–40 位十六進位，其餘視為「沒有」。
 * @param {string|undefined} value - 原始值。
 * @returns {string|undefined} 小寫 sha。
 */
export function normalizeSha(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * 把落後提交數夾進合理範圍；非數字回傳 null。
 * @param {number|string|undefined} value - 原始值。
 * @returns {number|null} 正規化後的數量。
 */
export function normalizeBehindBy(value) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.min(Math.floor(parsed), MAX_BEHIND_BY);
}

/**
 * 解析時間戳為毫秒；無法解析時 undefined。
 * @param {string|number|undefined} value - ISO 字串或 epoch 毫秒。
 * @returns {number|undefined} epoch 毫秒。
 */
export function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const parsed = Date.parse(value.trim());
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * 依監看設定判斷一個檔名是否值得觸發重建（FR-6）。
 * @param {string} filePath - 變更的檔案路徑。
 * @param {string[]} extensions - 副檔名白名單；空陣列＝不過濾。
 * @returns {boolean} 是否納入。
 */
export function matchesExtensionWhitelist(filePath, extensions) {
  if (!Array.isArray(extensions) || extensions.length === 0) return true;
  const name = String(filePath ?? '');
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  return extensions.some(function (candidate) { return String(candidate).toLowerCase() === ext; });
}

/**
 * 判斷一個路徑是否落在排除集內（FR-6）。
 * @param {string} filePath - 相對或絕對路徑。
 * @param {string[]} excludes - 排除的目錄名片段。
 * @returns {boolean} 應排除則 true。
 */
export function isExcludedPath(filePath, excludes) {
  const parts = String(filePath ?? '').split('/');
  for (const part of parts) {
    for (const exclude of excludes) {
      if (part === exclude) return true;
    }
  }
  return false;
}

/** 樣式 → 正規表達式的快取（樣式是常數，重複比對不必重建）。 */
const GENERATED_PATTERN_CACHE = new Map();

/**
 * 把一個生成檔樣式編成正規表達式。
 *
 * 只支援 `*`（比對檔名內任意長度的字元；路徑分隔不在檔名裡，所以不會跨目錄）。
 * 這是刻意的：完整的 glob 會讓「這個樣式到底比對什麼」變得要查文件才知道。
 *
 * @param {string} pattern - 樣式（如 `*.gen.*`）。
 * @returns {RegExp} 錨定的正規表達式。
 */
function compileGeneratedPattern(pattern) {
  const cached = GENERATED_PATTERN_CACHE.get(pattern);
  if (cached !== undefined) return cached;
  const body = String(pattern)
    .split('*')
    .map(function (part) { return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); })
    .join('[^/]*');
  const compiled = new RegExp('^' + body + '$');
  GENERATED_PATTERN_CACHE.set(pattern, compiled);
  return compiled;
}

/**
 * 判斷一個檔案是不是「生成檔」（C5）：工具自動產生、改它不代表原始碼有變。
 *
 * 只比對**檔名**（不含目錄），因為生成檔的目錄各專案不同（`src/`、`.nuxt/`…），
 * 而檔名是穩定的。純函式、不做 I/O，所以可以逐值驗證。
 *
 * @param {string} filePath - 相對或絕對路徑。
 * @param {string[]} patterns - 生成檔樣式（見 constants.DEFAULT_WATCH_GENERATED_PATTERNS）。
 * @returns {boolean} 是生成檔則 true。
 */
export function isGeneratedPath(filePath, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  const text = String(filePath ?? '').replace(/\/+$/, '');
  const slash = text.lastIndexOf('/');
  const name = slash < 0 ? text : text.slice(slash + 1);
  if (name.length === 0) return false;
  for (const pattern of patterns) {
    if (compileGeneratedPattern(pattern).test(name)) return true;
  }
  return false;
}

/** CBM 圖譜 UI 的預設埠（上游 `--port` 的預設值）。 */
export const DEFAULT_GRAPH_UI_PORT = 9749;

/** CBM 圖譜 UI 認得的分頁（前端讀 `?tab=`；清單外的值一律退回 graph）。 */
export const GRAPH_UI_TABS = ['graph', 'stats', 'control'];

/**
 * 把埠正規化為 1–65535 的整數；空值＝回預設埠，其餘非法值回 undefined。
 * @param {number|string|undefined} value - CBM 的 `ui_port`。
 * @returns {number|undefined} 埠號。
 */
function normalizePort(value) {
  if (value === undefined || value === null || String(value).trim().length === 0) return DEFAULT_GRAPH_UI_PORT;
  const text = String(value).trim();
  // 只收純數字：`parseInt` 會把 `80; rm -rf /` 讀成 80，這裡不留那種寬容。
  if (!/^[0-9]+$/.test(text)) return undefined;
  const parsed = Number.parseInt(text, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) return undefined;
  return parsed;
}

/**
 * 只接受 http/https 的絕對網址，並去掉尾斜線（保留路徑，供反向代理掛子路徑）。
 * @param {string} value - 候選網址。
 * @returns {string|undefined} 正規化後的來源。
 */
function parseHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  return url.origin + url.pathname.replace(/\/+$/, '');
}

/**
 * 組出 CBM 圖譜 UI 的來源（base）；純函式，不做任何網路存取。
 *
 * 這個字串會被放進卡片的 href，所以只接受兩種來源：設定頁給的 `http(s)://`
 * 覆寫，或由整數埠推導出的 `http://127.0.0.1:<port>`。推導不出來時回
 * `state: 'invalid'` 且不給 base——寧可沒有連結，也不要給指向不明位置的連結。
 *
 * @param {object} [input] - 輸入。
 * @param {string} [input.override] - 設定頁的 `graphUrl`（遠端／反向代理情境）。
 * @param {string} [input.uiEnabled] - CBM 的 `ui_enabled`（字串 'true'／'false'）。
 * @param {number|string} [input.uiPort] - CBM 的 `ui_port`。
 * @returns {{state: 'ok'|'disabled'|'invalid', base: string|undefined, port: number|undefined, source: 'override'|'config'|undefined}} 結果。
 */
export function buildGraphBase(input) {
  const options = input ?? {};
  const override = typeof options.override === 'string' ? options.override.trim() : '';
  if (override.length > 0) {
    const parsed = parseHttpUrl(override);
    if (parsed === undefined) return { state: 'invalid', base: undefined, port: undefined, source: undefined };
    const port = new URL(parsed).port;
    return {
      state: 'ok',
      base: parsed,
      port: port.length === 0 ? undefined : Number.parseInt(port, 10),
      source: 'override',
    };
  }
  if (options.uiEnabled === 'false') {
    return { state: 'disabled', base: undefined, port: undefined, source: undefined };
  }
  const port = normalizePort(options.uiPort);
  if (port === undefined) return { state: 'invalid', base: undefined, port: undefined, source: undefined };
  return { state: 'ok', base: 'http://127.0.0.1:' + String(port), port, source: 'config' };
}

/**
 * 把 base 接上 CBM UI 認得的查詢參數（`?tab=`、`?project=`）。
 * @param {string|undefined} base - {@link buildGraphBase} 給的來源。
 * @param {object} [options] - 查詢選項。
 * @param {string} [options.project] - 專案名（CBM 的 name）；留空＝不帶。
 * @param {string} [options.tab] - 分頁；不在 {@link GRAPH_UI_TABS} 內一律用 graph。
 * @returns {string|undefined} 完整網址；沒有 base 時 undefined。
 */
export function buildGraphUrl(base, options) {
  if (typeof base !== 'string' || base.length === 0) return undefined;
  const settings = options ?? {};
  const tab = GRAPH_UI_TABS.includes(settings.tab) ? settings.tab : 'graph';
  const params = new URLSearchParams();
  params.set('tab', tab);
  const project = typeof settings.project === 'string' ? settings.project.trim() : '';
  if (project.length > 0) params.set('project', project);
  return base + '/?' + params.toString();
}
