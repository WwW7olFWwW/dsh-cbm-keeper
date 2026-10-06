/**
 * 控制面的**真 HTTP** 整合測試。
 *
 * 為什麼需要這一支：`routes.test.js` 與 `index.test.js` 都用 `test/helpers/http.js`
 * 那個手寫的假 `req`／`res`。那個替身只要與真的 Node HTTP 物件有一處語意不同
 * （`req.url` 的形式、`for await` 疊代、`writeHead` 之後才能 `end`…），
 * 幾百條斷言可以全綠而真的端點是壞的。這一支把同一組路由掛在**真的
 * `node:http` 伺服器**上，用真的 `fetch` 打過去，讓「假替身與真物件一致」
 * 這件事本身也被測到。
 *
 * 它同時是「實機 REST 檢查」在換代前的代償：新 host 碼要重啟 `dsh web` 才會
 * 上線，但這條路徑可以現在就把新碼用真 HTTP 走一遍——只換掉三個外部邊界
 * （`DSH_HOME`、`cliPath`、`graphUrl`），其餘全是真的。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { apply } from '../lib/index.js';
import { API_PREFIX, STATE_DIR_NAME } from '../lib/constants.js';
import { fakeProject, installFakeCbm } from './helpers/fake-cbm.js';
import { makeTempDir, waitFor } from './helpers/env.js';

/**
 * 掛起一台真的 HTTP 伺服器，上面掛著插件註冊的路由。
 *
 * @param {object} t - node:test 的 TestContext。
 * @param {object} [options] - 情境。
 * @param {object} [options.config] - 覆寫插件設定。
 * @param {boolean} [options.withSettings] - 是否提供 settings 服務。
 * @returns {Promise<object>} { base, routes, settings, dispose, logPath, dir }。
 */
async function mountOverHttp(t, options) {
  const settings = options ?? {};
  const dir = await makeTempDir(t, 'codebase-watcher-http');
  const home = join(dir, 'dsh-home');
  const repo = join(dir, 'repo');
  await mkdir(home, { recursive: true });
  await writeFile(join(home, STATE_DIR_NAME + '.keep'), '', 'utf8');

  const fake = await installFakeCbm(dir, {
    projects: [fakeProject({ name: 'http-fixture', rootPath: repo, graphHead: '3449ba2' })],
    sha: {},
    config: { auto_index: 'false', auto_watch: 'false', ui_enabled: 'false' },
  });

  const config = Object.assign({
    enabled: false,
    cliPath: fake.path,
    mode: 'full',
    scanMinutes: 1440,
    watchEnabled: false,
    autoRebuild: false,
    nice: 0,
    graphUrl: 'http://127.0.0.1:1',
  }, settings.config ?? {});

  /** 已註冊的路由（真的會被 HTTP 伺服器用到）。 */
  const routes = [];
  const disposers = [];
  const mutateCalls = [];

  // 真的 node:http 伺服器：只做「路徑完全相符就交給這條路由」這一件事，
  // 其餘照 Node 的預設行為（未命中回 404）。
  const server = createServer(function (req, res) {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const route = routes.find(function (candidate) { return candidate.path === pathname; });
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    void route.handler(req, res);
  });

  const ctx = {
    logger: { info: function () {} },
    get: function (service) {
      if (service !== 'settings' || settings.withSettings !== true) return undefined;
      return {
        mutate: async function (namespace, ops) { mutateCalls.push({ namespace, ops }); },
      };
    },
    effect: function (fn) {
      const cleanup = fn();
      disposers.push(cleanup);
      return function () {};
    },
    webServer: {
      register: function (route) {
        routes.push(route);
        return function () {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    },
  };

  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(function () {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });

  apply(ctx, config);

  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const base = 'http://127.0.0.1:' + String(address.port);

  t.after(async function () {
    await new Promise(function (resolve) { server.close(resolve); });
  });

  /** 依註冊逆序卸載。 */
  async function dispose() {
    const pending = disposers.slice().reverse();
    disposers.length = 0;
    for (const cleanup of pending) {
      if (typeof cleanup === 'function') await cleanup();
    }
  }

  return { base, routes, settings: { mutateCalls }, dispose, dir };
}

/**
 * 送一個真的 HTTP 請求。
 * @param {string} base - 伺服器來源。
 * @param {string} path - 路徑（可含查詢字串）。
 * @param {object} [init] - fetch 選項。
 * @returns {Promise<{status: number, type: string, json: any, text: string}>} 回應。
 */
async function call(base, path, init) {
  const response = await fetch(base + API_PREFIX + path, init);
  const text = await response.text();
  return {
    status: response.status,
    type: response.headers.get('content-type') ?? '',
    text,
    json: text.length === 0 ? undefined : JSON.parse(text),
  };
}

/**
 * 等到第一次掃描完成。
 * @param {string} base - 伺服器來源。
 * @returns {Promise<void>} 完成。
 */
async function waitForFirstScan(base) {
  await waitFor(async function () {
    const payload = (await call(base, '/state')).json;
    return payload.status.lastRefreshAt !== undefined;
  }, { label: '首次掃描完成', timeoutMs: 20000 });
}

test('真 HTTP：GET /state 回 200、application/json，且欄位與假替身測到的一致', async function (t) {
  const mounted = await mountOverHttp(t);
  await waitForFirstScan(mounted.base);

  const response = await call(mounted.base, '/state');

  assert.equal(response.status, 200);
  assert.match(response.type, /application\/json/);
  assert.equal(response.json.status.enabled, false);
  assert.equal(typeof response.json.status.stats, 'object');
  assert.equal(typeof response.json.status.statsSince, 'string');
  assert.ok(Array.isArray(response.json.projects) && response.json.projects.length >= 1);
  assert.equal(response.json.projects[0].name, 'http-fixture');

  await mounted.dispose();
});

test('真 HTTP：查詢字串真的被解析（?log=0 走的是 req.url 的真實形式）', async function (t) {
  const mounted = await mountOverHttp(t);
  await waitForFirstScan(mounted.base);

  const withLogs = await call(mounted.base, '/state');
  const without = await call(mounted.base, '/state?log=0');

  assert.ok(withLogs.json.log.length > 0, '預設應帶日誌');
  assert.equal(without.json.log.length, 0, '?log=0 應為 0 筆');

  await mounted.dispose();
});

test('真 HTTP：POST 內文真的被讀進來（for await 對真實 IncomingMessage 成立）', async function (t) {
  const mounted = await mountOverHttp(t, { withSettings: true });
  await waitForFirstScan(mounted.base);

  const response = await call(mounted.base, '/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scanMinutes: 10 }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(mounted.settings.mutateCalls.length, 1);
  assert.deepEqual(mounted.settings.mutateCalls[0].ops, [
    { op: 'set', path: ['scanMinutes'], value: 10 },
  ]);

  await mounted.dispose();
});

test('真 HTTP：POST /config 的未知鍵在真實往返中仍被擋下', async function (t) {
  const mounted = await mountOverHttp(t, { withSettings: true });
  await waitForFirstScan(mounted.base);

  const response = await call(mounted.base, '/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scanMs: 5 }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.json.unknown, ['scanMs']);
  assert.equal(mounted.settings.mutateCalls.length, 0);

  await mounted.dispose();
});

test('真 HTTP：不存在的專案 id 回 404，且是真的 HTTP 狀態碼', async function (t) {
  const mounted = await mountOverHttp(t);
  await waitForFirstScan(mounted.base);

  const missing = await call(mounted.base, '/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '/no/such/project' }),
  });
  assert.equal(missing.status, 404);
  assert.match(missing.json.hint, /projects\[\]\.key/);

  // 目標存在時走的是同一條路由的另一個分支——專案鍵要從 /state 拿真的。
  const state = await call(mounted.base, '/state');
  const key = state.json.projects[0].key;
  const existing = await call(mounted.base, '/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: key }),
  });
  assert.notEqual(existing.status, 404, '存在的專案不該回 404');

  await mounted.dispose();
});

test('真 HTTP：七條路由都真的接得上，且未命中的路徑回 404', async function (t) {
  const mounted = await mountOverHttp(t, { withSettings: true });
  await waitForFirstScan(mounted.base);

  assert.equal(mounted.routes.length, 7);

  // 每一條都用真請求摸一次；只斷言「不是 404 也不是 5xx」——
  // 各條的業務語意由 routes.test.js 逐值負責，這裡只管「真的接得上」。
  const calls = [
    ['/log', {}],
    ['/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
    ['/watchers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pause' }) }],
    ['/rebuild', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ staleOnly: true }) }],
  ];
  for (const [path, init] of calls) {
    const response = await call(mounted.base, path, init);
    assert.ok(response.status < 500, path + ' 回了 ' + String(response.status));
    assert.notEqual(response.status, 404, path + ' 接不上');
  }

  const unknown = await fetch(mounted.base + API_PREFIX + '/nope');
  assert.equal(unknown.status, 404, '未命中的路徑應由伺服器回 404');

  await mounted.dispose();
});
