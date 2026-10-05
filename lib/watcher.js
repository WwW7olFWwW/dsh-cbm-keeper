/**
 * 每專案檔案監看（FR-6）。
 *
 * 上游 CBM 內建的 watcher 即使註冊成功也不會產生可觀測的重建（P2），所以監
 * 看必須由本插件自己做。兩條後端：
 *   1. `chokidar`（可選相依）——事件量大時較穩、排除規則表達力好；
 *   2. `node:fs.watch` 遞迴模式——chokidar 不可用時的退路（Node ≥ 20 在 Linux
 *      支援 recursive）。
 * 兩者共用同一組排除規則、副檔名白名單與防抖邏輯，因此後端切換不改變語意。
 */

import { watch as fsWatch } from 'node:fs';
import { join } from 'node:path';
import { isExcludedPath, matchesExtensionWhitelist } from './staleness.js';

/**
 * 建立一個專案監看器。
 *
 * @param {object} options - 建構選項。
 * @param {string} options.root - 專案根目錄（絕對路徑）。
 * @param {string[]} options.excludes - 排除的目錄名。
 * @param {string[]} options.extensions - 副檔名白名單（空＝全部）。
 * @param {number} options.debounceMs - 防抖毫秒。
 * @param {(info: {count: number, sample: string[]}) => void} options.onTrigger - 防抖後的觸發回呼。
 * @param {import('./log.js').KeeperLog} options.log - 日誌器。
 * @param {() => Promise<unknown>} [options.loadChokidar] - chokidar 載入器（測試注入）。
 * @returns {Promise<{stop: () => Promise<void>, status: () => string, backend: string, triggers: number, lastTriggerAt: string|undefined}>}
 *   監看器控制把柄。
 */
export async function createProjectWatcher(options) {
  const excludes = options.excludes ?? [];
  const extensions = options.extensions ?? [];
  const debounceMs = Math.max(200, options.debounceMs ?? 3000);
  const log = options.log;
  const loadChokidar = options.loadChokidar ?? defaultLoadChokidar;

  /** @type {Set<string>} 防抖視窗內看過的檔名（去重，避免同一檔多次存檔被算成多次觸發）。 */
  const pending = new Set();
  let timer;
  let triggers = 0;
  let lastTriggerAt;
  let stopped = false;
  let backend = 'none';
  // 執行期錯誤（inotify 用盡、被監看的樹消失…）是非同步送進來的，跟「建立失敗」不同：
  // 以前這裡只寫一行 warn，狀態仍是 watching，於是卡片繼續說「監看中」，而存檔
  // 已經追不上了——那正是本插件要消滅的那種靜默。
  let runtimeError;
  let close = async function () {};

  /**
   * 記錄一次檔案事件；通過過濾才進防抖視窗。
   * @param {string} changedPath - 絕對或相對於 root 的路徑。
   * @returns {void}
   */
  function remember(changedPath) {
    if (stopped) return;
    const relative = String(changedPath ?? '').startsWith(options.root)
      ? String(changedPath).slice(options.root.length).replace(/^\/+/, '')
      : String(changedPath ?? '');
    if (isExcludedPath(relative, excludes)) return;
    if (!matchesExtensionWhitelist(relative, extensions)) return;
    pending.add(relative);
    if (timer !== undefined) return;
    timer = setTimeout(flush, debounceMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  /**
   * 防抖到期：只觸發一次，附上視窗內的變更數與樣本。
   * @returns {void}
   */
  function flush() {
    timer = undefined;
    if (stopped || pending.size === 0) return;
    const sample = Array.from(pending).slice(0, 10);
    const count = pending.size;
    pending.clear();
    triggers += 1;
    lastTriggerAt = new Date().toISOString();
    try {
      options.onTrigger({ count, sample });
    } catch (error) {
      log.warn('watcher.trigger.failed', { root: options.root, error: error instanceof Error ? error.message : String(error) });
    }
  }

  try {
    const chokidar = await loadChokidar();
    if (chokidar !== null && chokidar !== undefined && typeof chokidar.watch === 'function') {
      const watcher = chokidar.watch(options.root, {
        ignoreInitial: true,
        persistent: true,
        followSymlinks: false,
        ignored: function (candidate) {
          return isExcludedPath(String(candidate), excludes);
        },
      });
      watcher.on('all', function (_event, changedPath) { remember(changedPath); });
      watcher.on('error', function (error) {
        runtimeError = error instanceof Error ? error.message : String(error);
        log.warn('watcher.error', { root: options.root, backend: 'chokidar', error: runtimeError });
      });
      backend = 'chokidar';
      close = async function () { await watcher.close(); };
    }
  } catch (error) {
    // chokidar 是 optionalDependency：載入失敗是預期情境，退回 fs.watch 即可。
    log.info('watcher.chokidar.unavailable', {
      root: options.root,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (backend === 'none') {
    try {
      const watcher = fsWatch(options.root, { recursive: true, persistent: true }, function (_event, filename) {
        if (filename === null || filename === undefined) {
          // recursive 模式下少數平台不回檔名；此時無法過濾，保守地當成一次觸發。
          remember(join(options.root, '__unknown__'));
          return;
        }
        remember(join(options.root, String(filename)));
      });
      watcher.on('error', function (error) {
        runtimeError = error instanceof Error ? error.message : String(error);
        log.warn('watcher.error', { root: options.root, backend: 'fs.watch', error: runtimeError });
      });
      backend = 'fs.watch';
      close = async function () { watcher.close(); };
    } catch (error) {
      backend = 'failed';
      log.error('watcher.unavailable', {
        root: options.root,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    backend,
    /**
     * 停止監看並清掉待處理的防抖計時器。
     * @returns {Promise<void>} 關閉完成。
     */
    stop: async function () {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      pending.clear();
      await close();
    },
    /**
     * 目前狀態。
     * @returns {string} watching | failed | stopped。
     */
    status: function () {
      if (stopped) return 'stopped';
      return backend === 'failed' || runtimeError !== undefined ? 'failed' : 'watching';
    },
    /** @returns {number} 累計觸發次數。 */
    get triggers() { return triggers; },
    /** @returns {string|undefined} 上次觸發時間。 */
    get lastTriggerAt() { return lastTriggerAt; },
    /** @returns {string|undefined} 執行期錯誤訊息（有值時 status() 為 failed）。 */
    get lastError() { return runtimeError; },
  };
}

/**
 * 預設的 chokidar 載入器。
 *
 * 動態 import 讓 chokidar 缺席時整個插件仍能載入——這是 optionalDependency 的
 * 意義所在，不是防禦性程式碼。
 *
 * @returns {Promise<unknown>} chokidar 模組，載入失敗時 reject。
 */
async function defaultLoadChokidar() {
  const module = await import('chokidar');
  return module.default ?? module;
}
