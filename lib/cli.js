/**
 * CLI 可執行檔解析（FR-5）與 `codebase-memory-mcp` 的呼叫封裝。
 *
 * 解析順序固定為：明確設定 → `CBM_BIN` 環境變數 → PATH 查找 → 平台常見路徑
 * → 具名報錯。每一層的來源都會被記下來並經 `cli_path`／`cli_source` 暴露到
 * UI 與 REST，讓「CLI 找不到」不再是靜默失敗（P13/P14）。
 */

import { access, constants as fsConstants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  CBM_BIN_NAMES,
  CBM_COMMON_PATHS,
  CBM_VERSION_PATTERN,
} from './constants.js';
import { execFileText, searchPath } from './exec.js';

/** 解析失敗時拋出的具名錯誤，帶完整候選清單供 UI 逐值呈現。 */
export class CliNotFoundError extends Error {
  /**
   * @param {string} message - 人可讀的原因。
   * @param {string[]} candidates - 已嘗試過的每一個路徑。
   */
  constructor(message, candidates) {
    super(message);
    this.name = 'CliNotFoundError';
    this.candidates = candidates;
  }
}

/**
 * 判斷一個路徑是否為可執行的普通檔案。
 * @param {string} candidate - 絕對路徑。
 * @returns {Promise<boolean>} 可執行則 true。
 */
export async function isExecutableFile(candidate) {
  try {
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把 `%s`／`%n` 樣板展開成候選絕對路徑。
 * @param {string} home - 家目錄。
 * @param {string} name - 候選檔名。
 * @returns {string[]} 展開後的絕對路徑。
 */
function expandCommonPaths(home, name) {
  const out = [];
  for (const template of CBM_COMMON_PATHS) {
    out.push(template.split('%s').join(home).split('%n').join(name));
  }
  return out;
}

/**
 * 解析 CBM CLI 的絕對路徑。
 *
 * @param {object} [options] - 解析選項。
 * @param {string} [options.explicit] - 設定頁／Config 指定的路徑（最高優先）。
 * @param {Record<string, string|undefined>} [options.env] - 環境變數表，預設 process.env。
 * @param {string} [options.home] - 家目錄，預設 os.homedir()。
 * @param {(candidate: string) => Promise<boolean>} [options.isExecutable] - 可執行性探針（測試注入）。
 * @returns {Promise<{path: string, source: string}>} 解析結果；找不到時 reject CliNotFoundError。
 */
export async function resolveCliPath(options) {
  const settings = options ?? {};
  const env = settings.env ?? process.env;
  const home = settings.home ?? homedir();
  const probe = settings.isExecutable ?? isExecutableFile;
  const attempted = [];

  if (typeof settings.explicit === 'string' && settings.explicit.trim().length > 0) {
    const explicit = settings.explicit.trim();
    const absolute = isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
    attempted.push(absolute);
    if (await probe(absolute)) return { path: absolute, source: 'config' };
  }

  const fromEnv = env.CBM_BIN;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    const absolute = fromEnv.trim();
    attempted.push(absolute);
    if (await probe(absolute)) return { path: absolute, source: 'env:CBM_BIN' };
  }

  const onPath = await searchPath(CBM_BIN_NAMES, env.PATH ?? '', probe);
  if (onPath !== undefined) return { path: onPath, source: 'PATH' };

  for (const name of CBM_BIN_NAMES) {
    for (const candidate of expandCommonPaths(home, name)) {
      attempted.push(candidate);
      if (await probe(candidate)) return { path: candidate, source: 'common-path' };
    }
  }

  const searchedPath = String(env.PATH ?? '').split(':').filter(function (part) { return part.length > 0; });
  for (const dir of searchedPath) attempted.push(join(dir, CBM_BIN_NAMES[0]));

  throw new CliNotFoundError(
    '找不到 codebase-memory-mcp 執行檔。已依序嘗試設定值、CBM_BIN 環境變數、PATH 與平台常見路徑；'
      + '請在設定頁填入絕對路徑，或設定 CBM_BIN。',
    attempted,
  );
}

/**
 * 讀取 CLI 版本（FR-15）。
 * @param {string} cliPath - 已解析的執行檔路徑。
 * @returns {Promise<string | undefined>} 版本字串；呼叫失敗時 undefined。
 */
export async function readCliVersion(cliPath) {
  const result = await execFileText(cliPath, ['--version'], { timeoutMs: 20000 });
  if (result.code !== 0 || result.spawnError !== undefined) return undefined;
  const match = CBM_VERSION_PATTERN.exec(result.stdout);
  return match === null ? undefined : match[1];
}

/**
 * 解析 `--json` 信封：`{"content":[{"type":"text","text":...}],"isError":bool}`。
 *
 * CBM 的 CLI 在工具層失敗時仍可能以退出碼 1 結束，因此 `isError` 與退出碼
 * 都必須看，缺一不可。
 *
 * @param {string} stdout - 子行程標準輸出。
 * @returns {{ok: boolean, text: string, error: string|undefined, raw: unknown}} 解析結果。
 */
export function parseJsonEnvelope(stdout) {
  const trimmed = String(stdout ?? '').trim();
  if (trimmed.length === 0) {
    return { ok: false, text: '', error: 'CLI 沒有輸出（stdout 為空）', raw: undefined };
  }
  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch (error) {
    return {
      ok: false,
      text: trimmed,
      error: 'CLI 輸出不是合法 JSON：' + (error instanceof Error ? error.message : String(error)),
      raw: undefined,
    };
  }
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  const texts = [];
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && typeof block.text === 'string') texts.push(block.text);
  }
  const text = texts.join('\n');
  if (payload.isError === true) {
    return { ok: false, text, error: extractErrorMessage(text) ?? 'CLI 回報 isError', raw: payload };
  }
  return { ok: true, text, error: undefined, raw: payload };
}

/**
 * 從 CBM 的錯誤文字中取出最有用的一句。
 * @param {string} text - 信封內文。
 * @returns {string | undefined} 錯誤訊息。
 */
function extractErrorMessage(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.error === 'string') {
        return typeof parsed.hint === 'string' ? parsed.error + '（' + parsed.hint + '）' : parsed.error;
      }
    } catch {
      // 不是 JSON：往下走，直接回原文。
    }
  }
  return trimmed.length === 0 ? undefined : trimmed.split('\n')[0];
}

/**
 * 執行一次 CBM CLI 工具呼叫。
 *
 * @param {object} options - 呼叫參數。
 * @param {string} options.cliPath - 執行檔路徑。
 * @param {string[]} options.args - 傳給 CLI 的參數（不含 `cli` 子命令本身）。
 * @param {number} [options.timeoutMs] - 逾時毫秒。
 * @param {number} [options.nice] - nice 值；> 0 時以 `nice -n N` 包裝（FR-14）。
 * @param {AbortSignal} [options.signal] - 取消訊號。
 * @param {Record<string, string>} [options.env] - 環境變數覆寫。
 * @returns {Promise<{ok: boolean, text: string, error: string|undefined, code: number|null, durationMs: number, timedOut: boolean, command: string}>}
 *   呼叫結果；永不 reject。
 */
export async function runCbmTool(options) {
  const args = ['cli', '--quiet', '--json'].concat(options.args);
  const nice = options.nice ?? 0;
  const command = nice > 0 ? 'nice' : options.cliPath;
  const commandArgs = nice > 0 ? ['-n', String(nice), options.cliPath].concat(args) : args;
  const started = Date.now();
  let result = await execFileText(command, commandArgs, {
    timeoutMs: options.timeoutMs ?? 120000,
    signal: options.signal,
    env: options.env,
  });

  // 沒有 nice 的環境（例如精簡容器）就退回直接執行；這不是錯誤，只是少一層讓路。
  if (nice > 0 && result.spawnError !== undefined) {
    result = await execFileText(options.cliPath, args, {
      timeoutMs: options.timeoutMs ?? 120000,
      signal: options.signal,
      env: options.env,
    });
  }

  const durationMs = Date.now() - started;
  if (result.timedOut) {
    return {
      ok: false,
      text: result.stdout,
      error: 'CLI 逾時（' + durationMs + ' ms）：' + options.args[0],
      code: result.code,
      durationMs,
      timedOut: true,
      command: command + ' ' + commandArgs.join(' '),
    };
  }
  if (result.spawnError !== undefined) {
    return {
      ok: false,
      text: '',
      error: 'CLI 啟動失敗：' + result.spawnError,
      code: null,
      durationMs,
      timedOut: false,
      command: command + ' ' + commandArgs.join(' '),
    };
  }

  const envelope = parseJsonEnvelope(result.stdout);
  if (!envelope.ok) {
    const detail = envelope.error ?? '不明錯誤';
    const stderrTail = result.stderr.trim().split('\n').slice(-3).join(' | ');
    return {
      ok: false,
      text: envelope.text,
      error: stderrTail.length > 0 ? detail + ' [' + stderrTail + ']' : detail,
      code: result.code,
      durationMs,
      timedOut: false,
      command: command + ' ' + commandArgs.join(' '),
    };
  }
  return {
    ok: true,
    text: envelope.text,
    error: undefined,
    code: result.code,
    durationMs,
    timedOut: false,
    command: command + ' ' + commandArgs.join(' '),
  };
}
