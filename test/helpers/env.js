/**
 * 測試共用工具（非測試檔：檔名不含 .test.js，不會被 `node --test test/` 收集）。
 *
 * 這裡只放三種東西：暫存目錄、假日誌器、以及一個「把 Promise 輪詢到條件成立」
 * 的小工具。所有測試都靠它們把自己的副作用限制在 os.tmpdir() 內。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 建立一個帶自動清除的暫存目錄。
 * @param {object} t - node:test 的 TestContext。
 * @param {string} [prefix] - 目錄名前綴。
 * @returns {Promise<string>} 已建立的絕對路徑。
 */
export async function makeTempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), (prefix ?? 'cbm-test-') + '-'));
  t.after(async function () {
    // 受測程式可能在清理途中才落盤（非同步的狀態寫入），讓遞迴刪除撞上
    // ENOTEMPTY。那是競態、不是測試失敗，所以交給 Node 自己退避重試；重試完
    // 仍失敗就吞掉——暫存目錄留在 tmpdir 由系統清，好過讓整個測試檔變紅。
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      .catch(function () { return undefined; });
  });
  return dir;
}

/**
 * 建立一個什麼都不做但會記錄呼叫的日誌器，形狀與 KeeperLog 的取用面一致。
 * @returns {{entries: object[], info: Function, warn: Function, error: Function, debug: Function, recent: Function}}
 *   假日誌器。
 */
export function makeFakeLog() {
  const entries = [];
  /**
   * 記錄一筆。
   * @param {string} level - 等級。
   * @param {string} event - 事件名。
   * @param {object} data - 附加資料。
   * @returns {void}
   */
  function push(level, event, data) {
    entries.push({ level, event, data: data ?? {} });
  }
  return {
    entries,
    info: function (event, data) { push('info', event, data); },
    warn: function (event, data) { push('warn', event, data); },
    error: function (event, data) { push('error', event, data); },
    debug: function (event, data) { push('debug', event, data); },
    recent: function (limit) { return entries.slice(-limit); },
  };
}

/**
 * 反覆讀取一個函式直到回傳真值或逾時；逾時就 reject，讓測試失敗而不是靜靜掛住。
 * @param {() => (boolean|Promise<boolean>)} predicate - 條件。
 * @param {object} [options] - 選項。
 * @param {number} [options.timeoutMs] - 總等待上限。
 * @param {number} [options.intervalMs] - 輪詢間隔。
 * @param {string} [options.label] - 失敗訊息用的標籤。
 * @returns {Promise<void>} 條件成立時解決。
 */
export async function waitFor(predicate, options) {
  const settings = options ?? {};
  const timeoutMs = settings.timeoutMs ?? 5000;
  const intervalMs = settings.intervalMs ?? 5;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) {
      throw new Error('waitFor 逾時：' + (settings.label ?? '條件始終不成立'));
    }
    await new Promise(function (resolve) { setTimeout(resolve, intervalMs); });
  }
}

/**
 * 在暫存目錄內寫一個檔案（含建立父目錄）。
 * @param {string} file - 目標絕對路徑。
 * @param {string} content - 內容。
 * @returns {Promise<void>} 寫入完成。
 */
export async function writeTempFile(file, content) {
  await writeFile(file, content, 'utf8');
}
