/**
 * git 探針（FR-2）。
 *
 * 只讀、不寫：`rev-parse`／`rev-list`／`status` 三個子命令，全部以注入的
 * 執行函式呼叫，因此單元測試可以餵假 git 而不需要真的倉庫（NFR-7）。
 */

import { execFileText } from './exec.js';
import { normalizeBehindBy, normalizeSha } from './staleness.js';

/** git 探針的預設逾時：倉庫指標讀取不該拖慢掃描。 */
const GIT_TIMEOUT_MS = 15000;

/**
 * 執行一次 git 子命令。
 * @param {string} dir - 工作目錄（repo 根）。
 * @param {string[]} args - git 參數。
 * @param {number} [timeoutMs] - 逾時。
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>} 原始結果。
 */
async function git(dir, args, timeoutMs) {
  const result = await execFileText('git', ['-C', dir].concat(args), {
    timeoutMs: timeoutMs ?? GIT_TIMEOUT_MS,
    env: Object.assign({}, process.env, { GIT_OPTIONAL_LOCKS: '0' }),
  });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

/**
 * 讀取工作樹的 HEAD。
 * @param {string} dir - repo 根。
 * @returns {Promise<{ok: boolean, head: string|undefined, error: string|undefined}>} 讀取結果。
 */
export async function readLiveHead(dir) {
  const result = await git(dir, ['rev-parse', 'HEAD']);
  if (result.code !== 0) {
    return { ok: false, head: undefined, error: firstLine(result.stderr) ?? 'git rev-parse HEAD 失敗' };
  }
  const head = normalizeSha(result.stdout);
  if (head === undefined) {
    return { ok: false, head: undefined, error: 'git rev-parse HEAD 回傳了無法解析的值' };
  }
  return { ok: true, head, error: undefined };
}

/**
 * 讀取 HEAD 的提交時間（時間旁證，R2）。
 * @param {string} dir - repo 根。
 * @returns {Promise<string|undefined>} ISO 時間；無法讀取時 undefined。
 */
export async function readHeadCommittedAt(dir) {
  const result = await git(dir, ['log', '-1', '--format=%cI', 'HEAD']);
  if (result.code !== 0) return undefined;
  const value = result.stdout.trim();
  return value.length === 0 ? undefined : value;
}

/**
 * 計算 from..to 之間的提交數（FR-2 的 behind_by）。
 *
 * `to` 不在 `from` 的歷史上（rebase／force-push／換分支）時，`rev-list --count`
 * 仍會回一個數字，但語意是「to 有幾個提交不在 from 上」——這正是使用者想看的
 * 「圖譜落後多少」，所以在該情況下不做特殊處理，只把 confidence 交給上層。
 *
 * @param {string} dir - repo 根。
 * @param {string} from - 基準 sha（圖譜 HEAD）。
 * @param {string} to - 目標 sha（工作樹 HEAD）。
 * @returns {Promise<number|null>} 提交數；無法計算時 null。
 */
export async function countCommitsBetween(dir, from, to) {
  if (from === to) return 0;
  const result = await git(dir, ['rev-list', '--count', from + '..' + to]);
  if (result.code !== 0) return null;
  return normalizeBehindBy(result.stdout.trim());
}

/**
 * 判斷工作樹是否有未提交變更。
 * @param {string} dir - repo 根。
 * @returns {Promise<boolean>} 有變更則 true；讀取失敗時 false（寧可漏報，不得誤報）。
 */
export async function isWorktreeDirty(dir) {
  const result = await git(dir, ['status', '--porcelain', '--untracked-files=no']);
  if (result.code !== 0) return false;
  return result.stdout.trim().length > 0;
}

/**
 * 判斷路徑是否為 git 工作樹。
 * @param {string} dir - 候選路徑。
 * @returns {Promise<boolean>} 是則 true。
 */
export async function isGitWorktree(dir) {
  const result = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  return result.code === 0 && result.stdout.trim() === 'true';
}

/**
 * 取一行錯誤訊息。
 * @param {string} text - 原始輸出。
 * @returns {string|undefined} 第一行非空內容。
 */
function firstLine(text) {
  const lines = String(text ?? '').split('\n');
  for (const line of lines) {
    if (line.trim().length > 0) return line.trim();
  }
  return undefined;
}

/** 匯出內部 git 執行器供測試替換。 */
export const __gitInternals = { git };
