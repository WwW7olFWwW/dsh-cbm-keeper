/**
 * dsh-codebase-watcher — Host 半邊的插件入口。
 *
 * 掛上三件事，全部經由 `ctx.effect` 註冊並在卸載時收回（模組級 WeakSet 守門在重載時會失效，
 * 這裡不再重複）：
 *   1. `/api/codebase-watcher/*` 這組控制面路由；
 *   2. 一台協調器（掃描、落後判定、條件式重建、每專案監看）；
 *   3. 設定頁寫入路徑（`ctx.settings` 可選，缺席時整支插件仍能運作）。
 *
 * 觀測面（設定頁卡片）由瀏覽器半邊 `./client` 提供，兩者共用同一組路由，
 * 因此 UI 與 curl 看到的永遠是同一份資料。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  LOG_FILE_NAME,
  LOG_MAX_FILE_BYTES,
  PLUGIN_ID,
  STATE_DIR_NAME,
  STATE_FILE_NAME,
} from './constants.js';
import { Config, readConfigValues, resolveKeeperConfig, unknownConfigKeys } from './config.js';
import { CbmKeeper } from './keeper.js';
import { KeeperLog } from './log.js';
import { makeRoutes } from './routes.js';
import { KeeperState } from './state.js';

/** Cordis 插件名（等於 cordis.patch.yml 的 insert id，也是設定命名空間）。 */
export const name = PLUGIN_ID;

/** 這支插件唯一的硬相依：控制面需要一個 HTTP 載體。 */
export const inject = ['webServer'];

export { Config };

/**
 * DSH home 目錄。plugin 的狀態與日誌都寫在這裡（NFR-2：不污染專案樹、不需要提權）。
 * @returns {string} 絕對路徑。
 */
export function dshHomeDir() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  return join(homedir(), '.dsh');
}

/**
 * 掛載 CBM 圖譜保鮮控制面。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host 插件上下文（帶 webServer）。
 * @param {object} [config] - Loader entry 的 Config（volatile 參照）。
 * @returns {void}
 */
export function apply(ctx, config) {
  const home = join(dshHomeDir(), STATE_DIR_NAME);

  /**
   * 讀取目前的執行期設定。每次呼叫都重新解讀 volatile 參照，所以設定頁的寫入
   * 會在下一次使用時就地生效，不需要重建 fiber、不需要重啟。
   * @returns {object} 執行期設定。
   */
  function currentConfig() {
    return resolveKeeperConfig(config);
  }

  const log = new KeeperLog({
    file: join(home, LOG_FILE_NAME),
    maxEntries: currentConfig().maxLogEntries,
    maxFileBytes: LOG_MAX_FILE_BYTES,
    minLevel: 'info',
  });

  const state = new KeeperState({
    file: join(home, STATE_FILE_NAME),
    log,
  });

  const keeper = new CbmKeeper({
    home,
    config: currentConfig,
    log,
    state,
  });

  /**
   * 把設定寫回 settings 命名空間。
   *
   * `undefined` 以 path `unset` 表達（回退到繼承值），而不是寫入字面 undefined；
   * 這與設定頁的重置語意一致。
   *
   * @param {object} patch - 欄位 → 新值。
   * @returns {Promise<void>} 寫入完成。
   */
  async function updateConfig(patch) {
    const settings = ctx.get('settings');
    if (settings === undefined) {
      throw new Error('此部署沒有掛載 settings 服務，設定為唯讀');
    }
    const ops = [];
    for (const field of Object.keys(patch)) {
      const value = patch[field];
      if (value === undefined) ops.push({ op: 'unset', path: [field] });
      else ops.push({ op: 'set', path: [field], value });
    }
    if (ops.length === 0) return;
    await settings.mutate(PLUGIN_ID, ops);
    // volatile 欄位是就地更新的（Loader 不重入 apply），所以這裡主動把「在使用點讀不到」
    // 的幾件事重套一次：記憶體上限、掃描計時器、已建立的監看器、解析過的 CLI 路徑。
    log.setMaxEntries(currentConfig().maxLogEntries);
    await keeper.onConfigChanged();
  }

  // 生命週期：先開日誌、再啟動協調器；卸載時先停協調器、再等日誌落盤。
  ctx.effect(function () {
    let stopping = false;
    void (async function () {
      await log.open();
      log.setMaxEntries(currentConfig().maxLogEntries);
      log.info('plugin.start', {
        home,
        node: process.version,
        cliPath: currentConfig().cliPath ?? '(自動解析)',
      });
      // 打到不存在的欄位名（例如把 scanMinutes 寫成 scanMs）不會有任何效果：
      // schemastery 保留它、readConfigValues 只讀 CONFIG_FIELDS。說出來，否則使用者
      // 只會覺得「我明明設了」。
      const unknown = unknownConfigKeys(config);
      if (unknown.length > 0) {
        log.warn('config.unknown-keys', { keys: unknown.join(',') });
      }
      if (stopping) return;
      await keeper.start();
    })().catch(function (error) {
      log.error('plugin.start.failed', { error: error instanceof Error ? error.message : String(error) });
    });

    return function () {
      stopping = true;
      return keeper.stop()
        .catch(function (error) {
          log.warn('plugin.stop.failed', { error: error instanceof Error ? error.message : String(error) });
        })
        .then(function () {
          log.info('plugin.stop', {});
          return log.flush();
        });
    };
  }, 'dsh-codebase-watcher: keeper lifecycle');

  // 控制面路由。路由永遠掛著（即使總開關關閉），否則使用者關掉之後就再也打不開。
  ctx.effect(function () {
    const disposers = makeRoutes({
      keeper,
      log,
      config: currentConfig,
      // 設定頁那一組「可以寫回去」的值：與 POST /config 吃的是同一組欄位名。
      configValues: function () { return readConfigValues(config); },
      updateConfig,
    }).map(function (route) {
      return ctx.webServer.register(route);
    });
    return function () {
      for (const dispose of disposers) dispose();
    };
  }, 'dsh-codebase-watcher: routes');

  ctx.logger?.info?.('[dsh-codebase-watcher] mounted at /api/codebase-watcher (state, cli=' + (currentConfig().cliPath ?? 'auto') + ')');
}
