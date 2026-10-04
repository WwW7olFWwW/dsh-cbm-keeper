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
