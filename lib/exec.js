/**
 * 子行程執行原語。
 *
 * 唯一職責：把 `spawn` 包成一個「一定會解決」的 Promise，並把逾時、找不到
 * 執行檔、非零退出碼全部變成回傳值而不是例外——呼叫端（CLI 解析、git 探針、
 * 重建）才能把失敗當資料處理並寫進 UI（FR-10），而不是讓整支插件掛掉。
 */

import { spawn } from 'node:child_process';
import { delimiter } from 'node:path';

/**
 * 執行一支外部命令並收集輸出。
 *
 * 逾時以 SIGTERM → 寬限 → SIGKILL 升級；`killedBy` 指出是哪一種結束方式。
 *
 * @param {string} command - 執行檔絕對路徑或 PATH 上的名字。
 * @param {string[]} args - 參數。
 * @param {object} [options] - 執行選項。
 * @param {string} [options.cwd] - 工作目錄。
 * @param {Record<string, string>} [options.env] - 環境變數（整份取代，呼叫端自行繼承）。
 * @param {number} [options.timeoutMs] - 逾時毫秒；0 或未給＝不設逾時。
 * @param {number} [options.killGraceMs] - SIGTERM 後等待 SIGKILL 的寬限，預設 5000。
 * @param {AbortSignal} [options.signal] - 外部取消。
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean, aborted: boolean, spawnError: string|undefined}>}
 *   永遠解決；spawn 失敗時 code 為 null 且 spawnError 帶訊息。
 */
export function execFileText(command, args, options) {
  const settings = options ?? {};
  const timeoutMs = settings.timeoutMs ?? 0;
  const killGraceMs = settings.killGraceMs ?? 5000;

  return new Promise(function (resolve) {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let killTimer;
    let timeoutTimer;
    let child;

    const stdoutChunks = [];
    const stderrChunks = [];

    /**
     * 只解決一次；後續的 close/error 事件一律忽略。
     * @param {object} value - 結果物件。
     * @returns {void}
     */
    function finish(value) {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve(value);
    }

    /**
     * 先 SIGTERM，寬限期後仍活著才 SIGKILL。
     * @returns {void}
     */
    function terminate() {
      if (child === undefined) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // 行程已消失：沒有可終止的目標，close 事件會接手。
        return;
      }
      killTimer = setTimeout(function () {
        try {
          child.kill('SIGKILL');
        } catch {
          // 同上：已經結束就不再處理。
        }
      }, killGraceMs);
      if (typeof killTimer.unref === 'function') killTimer.unref();
    }

    try {
      child = spawn(command, args, {
        cwd: settings.cwd,
        env: settings.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      finish({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: false,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    child.stdout.on('data', function (chunk) { stdoutChunks.push(chunk); });
    child.stderr.on('data', function (chunk) { stderrChunks.push(chunk); });

    child.on('error', function (error) {
      finish({
        code: null,
        signal: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
        aborted,
        spawnError: error instanceof Error ? error.message : String(error),
      });
    });

    child.on('close', function (code, signal) {
      finish({
        code,
        signal: signal ?? null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
        aborted,
        spawnError: undefined,
      });
    });

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(function () {
        timedOut = true;
        terminate();
      }, timeoutMs);
      if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();
    }

    if (settings.signal !== undefined) {
      if (settings.signal.aborted) {
        aborted = true;
        terminate();
      } else {
        settings.signal.addEventListener('abort', function () {
          aborted = true;
          terminate();
        }, { once: true });
      }
    }
  });
}

/**
 * 把 PATH 字串切成目錄清單。
 *
 * D5：分隔符用 `path.delimiter`（POSIX ':'、Windows ';'），不要硬編 ':'；
 * 硬編會讓 Windows 上整條 PATH 被當成**一個**目錄，於是 CLI 永遠找不到。
 * cli.js 的候選清單與這裡的查找共用同一份切法，兩邊不會再各自漂移。
 *
 * @param {string|undefined} pathValue - PATH 的內容。
 * @returns {string[]} 去空項的目錄清單。
 */
export function splitPathDirs(pathValue) {
  return String(pathValue ?? '').split(delimiter).filter(function (part) { return part.length > 0; });
}

/**
 * 在 PATH 上尋找可執行檔。
 *
 * 不 spawn `which`：PATH 掃描是純檔案系統操作，可注入、可單元測試（NFR-7）。
 *
 * @param {string[]} names - 候選檔名，依序嘗試。
 * @param {string} pathValue - PATH 內容（平台分隔符）。
 * @param {(candidate: string) => Promise<boolean>} isExecutable - 可執行性探針。
 * @returns {Promise<string | undefined>} 第一個命中的絕對路徑。
 */
export async function searchPath(names, pathValue, isExecutable) {
  const dirs = splitPathDirs(pathValue);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = dir.replace(/\/+$/, '') + '/' + name;
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}
