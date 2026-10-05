/**
 * routes.js 的測試（FR-12：UI 與 REST 同源）。
 *
 * 不開真的 HTTP 伺服器：處理函式直接以假的 IncomingMessage／ServerResponse
 * 驅動，斷言狀態碼、標頭與 JSON 內文。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRoutes } from '../lib/routes.js';
import { API_PREFIX } from '../lib/constants.js';
import { makeFakeLog } from './helpers/env.js';
import { makeExchange, makeStubKeeper } from './helpers/http.js';

/** 文件記載的七條路由。 */
const DOCUMENTED_PATHS = [
  '/state',
  '/log',
  '/check',
  '/rebuild',
  '/cancel',
  '/watchers',
  '/config',
];

/**
 * 建立一組路由與查表。
 * @param {object} [options] - 情境。
 * @param {object} [options.keeper] - keeper 替身覆寫。
 * @param {Function} [options.config] - 設定供應器。
 * @param {Function} [options.updateConfig] - 設定寫入器。
 * @returns {{routes: object[], byPath: Record<string, object>, keeper: object, log: object}} 路由表與替身。
 */
function makeFixture(options) {
  const settings = options ?? {};
  const keeper = makeStubKeeper(settings.keeper);
  const log = makeFakeLog();
  const deps = {
    keeper,
    log,
    config: settings.config ?? function () { return { mode: 'full', scanMs: 300000 }; },
  };
  if (settings.updateConfig !== undefined) deps.updateConfig = settings.updateConfig;
  if (settings.configValues !== undefined) deps.configValues = settings.configValues;
  const routes = makeRoutes(deps);
  const byPath = {};
  for (const route of routes) byPath[route.path] = route;
  return { routes, byPath, keeper, log };
}

/**
 * 呼叫一條路由的處理函式。
 * @param {object} route - 路由。
 * @param {object} [options] - 請求選項。
 * @returns {Promise<{status: number, headers: object, body: string, json: Function}>} 回應。
 */
async function call(route, options) {
  const exchange = makeExchange(options);
  await route.handler(exchange.req, exchange.res);
  return exchange.read();
}

test('makeRoutes 只註冊文件記載的七條 exact 路由', function () {
  const fixture = makeFixture();
  const paths = fixture.routes.map(function (route) { return route.path; });
  assert.deepEqual(paths, DOCUMENTED_PATHS.map(function (suffix) { return API_PREFIX + suffix; }));
  for (const route of fixture.routes) {
    assert.equal(route.kind, 'exact');
    assert.equal(typeof route.handler, 'function');
  }
});

test('GET /config 分別回可寫的 config 與執行期 runtime，POST 吃的是 config 的那組欄位名', async function () {
  const fixture = makeFixture({
    config: function () { return { mode: 'full', scanMs: 300000, rebuildTimeoutMs: 1800000, extensions: ['ts'] }; },
    configValues: function () { return { mode: 'full', scanMinutes: 5, rebuildTimeoutSeconds: 1800, extensions: '' }; },
    keeper: { statusPayload: { revision: 1, queue: [], upstreamConfig: { ui_port: '9749' } } },
  });
  const got = await call(fixture.byPath[API_PREFIX + '/config'], { method: 'GET' });

  assert.equal(got.status, 200);
  const payload = got.json();
  // config 就是「可以原樣改一改 POST 回來」的那一份：欄位名與 schema 一致。
  assert.deepEqual(payload.config, { mode: 'full', scanMinutes: 5, rebuildTimeoutSeconds: 1800, extensions: '' });
  // runtime 是執行期形狀（毫秒、展開後的陣列），只供觀測，不要拿來 POST。
  assert.equal(payload.runtime.scanMs, 300000);
  assert.deepEqual(payload.runtime.extensions, ['ts']);
  assert.deepEqual(payload.upstream, { ui_port: '9749' });
});

test('POST /check：帶不存在的 id 回 404，不再回 502「檢查失敗」', async function () {
  const fixture = makeFixture({
    keeper: { listPayload: [{ key: '/srv/a', name: 'a', selected: true }] },
  });
  const missing = await call(fixture.byPath[API_PREFIX + '/check'], {
    method: 'POST', body: JSON.stringify({ id: '/srv/nope' }),
  });
  assert.equal(missing.status, 404);
  assert.match(missing.json().error, /找不到/);
  assert.deepEqual(fixture.keeper.checkCalls, [], '不存在的 id 不該往下打 CLI');
});

test('POST /rebuild：帶不存在的 id 回 404，不再回「已對上 HEAD」的誤導訊息', async function () {
  const fixture = makeFixture({
    keeper: { listPayload: [{ key: '/srv/a', name: 'a', selected: true, stale: false }] },
  });
  const missing = await call(fixture.byPath[API_PREFIX + '/rebuild'], {
    method: 'POST', body: JSON.stringify({ id: '/srv/nope' }),
  });
  assert.equal(missing.status, 404);
  assert.match(missing.json().error, /找不到/);
  assert.equal(fixture.keeper.enqueued.length, 0);
});

test('POST /cancel：轉呼叫 keeper.cancelRunning，並回報有沒有真的取消', async function () {
  const fixture = makeFixture({
    keeper: {
      cancelRunning: function () { return true; },
      statusPayload: { revision: 2, queue: [], running: { key: '/srv/a', reason: 'manual' } },
    },
  });
  const cancelled = await call(fixture.byPath[API_PREFIX + '/cancel'], { method: 'POST', body: '{}' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json().cancelled, true);

  const idle = makeFixture();
  const none = await call(idle.byPath[API_PREFIX + '/cancel'], { method: 'POST', body: '{}' });
  assert.equal(none.json().cancelled, false, '沒有在跑的重建時要說沒有，而不是假裝成功');
});

test('GET /state 回狀態、專案、caveats 與日誌，並支援 log 查詢參數', async function () {
  const fixture = makeFixture({
    keeper: {
      statusPayload: { revision: 7, queue: [] },
      listPayload: [{ key: '/srv/a', name: 'a', stale: true }],
    },
  });
  fixture.log.info('seed.one', {});
  fixture.log.info('seed.two', {});

  const response = await call(fixture.byPath[API_PREFIX + '/state']);
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['content-length'], Buffer.byteLength(response.body));
  const payload = response.json();
  assert.equal(payload.status.revision, 7);
  assert.equal(payload.projects.length, 1);
  assert.equal(payload.caveats.length, 1);
  assert.equal(payload.log.length, 2);

  const limited = await call(fixture.byPath[API_PREFIX + '/state'], { url: API_PREFIX + '/state?log=1' });
  assert.equal(limited.json().log.length, 1);
  // 非數字的 limit 不得讓路由爆掉。
  const junk = await call(fixture.byPath[API_PREFIX + '/state'], { url: API_PREFIX + '/state?log=abc' });
  assert.equal(junk.json().log.length, 2);
});

test('GET /log 回日誌並套用 limit', async function () {
  const fixture = makeFixture();
  fixture.log.info('a', {});
  fixture.log.info('b', {});
  fixture.log.info('c', {});

  const all = await call(fixture.byPath[API_PREFIX + '/log']);
  assert.equal(all.json().entries.length, 3);

  const tail = await call(fixture.byPath[API_PREFIX + '/log'], { url: API_PREFIX + '/log?limit=2' });
  assert.deepEqual(tail.json().entries.map(function (entry) { return entry.event; }), ['b', 'c']);
});

test('POST /check 帶 id 只檢查該專案，失敗時回 502', async function () {
  const fixture = makeFixture({ keeper: { listPayload: [{ key: '/srv/a', name: 'a', selected: true }] } });
  const ok = await call(fixture.byPath[API_PREFIX + '/check'], {
    method: 'POST',
    url: API_PREFIX + '/check',
    body: JSON.stringify({ id: '/srv/a' }),
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(fixture.keeper.checkCalls, ['/srv/a']);

  const wholeScan = await call(fixture.byPath[API_PREFIX + '/check'], { method: 'POST', url: API_PREFIX + '/check' });
  assert.equal(wholeScan.status, 200);
  assert.deepEqual(fixture.keeper.checkCalls, ['/srv/a', undefined]);

  fixture.keeper.checkResult = { ok: false, error: 'CLI 啟動失敗' };
  const broken = await call(fixture.byPath[API_PREFIX + '/check'], { method: 'POST', url: API_PREFIX + '/check' });
  assert.equal(broken.status, 502);
  assert.deepEqual(broken.json(), { error: 'CLI 啟動失敗' });
});

test('POST /rebuild 帶 staleOnly 且全部新鮮時排入 0 筆', async function () {
  const fixture = makeFixture({
    keeper: {
      listPayload: [
        { key: '/srv/a', name: 'a', selected: true, stale: false },
        { key: '/srv/b', name: 'b', selected: true, stale: false },
      ],
    },
  });
  const response = await call(fixture.byPath[API_PREFIX + '/rebuild'], {
    method: 'POST',
    url: API_PREFIX + '/rebuild',
    body: JSON.stringify({ staleOnly: true }),
  });
  assert.equal(response.status, 200);
  const payload = response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.queued, 0);
  assert.match(payload.note, /沒有落後的專案/);
  assert.deepEqual(fixture.keeper.enqueued, [], '新鮮的專案不得被排入');
  assert.equal(fixture.log.entries.some(function (entry) { return entry.event === 'route.rebuild.queued'; }), false);
});

test('POST /rebuild 只排入落後且被選取的專案，未帶 force 時跳過新鮮的', async function () {
  const staleFixture = makeFixture({
    keeper: {
      listPayload: [
        { key: '/srv/a', name: 'a', selected: true, stale: true },
        { key: '/srv/b', name: 'b', selected: true, stale: false },
        { key: '/srv/c', name: 'c', selected: false, stale: true },
      ],
    },
  });
  const response = await call(staleFixture.byPath[API_PREFIX + '/rebuild'], {
    method: 'POST',
    url: API_PREFIX + '/rebuild',
    body: JSON.stringify({}),
  });
  const payload = response.json();
  // 未選取（c）與新鮮（b）的專案都不會被排入；requested 是**實際排入的目標數**，
  // 因此帶 force 與否會讓同一個請求得到不同的 requested。
  assert.equal(payload.queued, 1);
  assert.equal(payload.requested, 1);
  assert.deepEqual(staleFixture.keeper.enqueued, [{ key: '/srv/a', reason: 'manual', mode: undefined }]);

  // 帶 force：目標是「全部被選取的專案」（a 與 b），不受 stale 篩選。
  const forcedAll = await call(staleFixture.byPath[API_PREFIX + '/rebuild'], {
    method: 'POST',
    url: API_PREFIX + '/rebuild',
    body: JSON.stringify({ force: true }),
  });
  assert.equal(forcedAll.json().queued, 2);
  assert.equal(forcedAll.json().requested, 2, 'force 時 requested 反映未經 stale 篩選的目標數');

  // 全部新鮮又沒帶 force：什麼都不做，並說明原因。
  const freshFixture = makeFixture({
    keeper: { listPayload: [{ key: '/srv/a', name: 'a', selected: true, stale: false }] },
  });
  const skipped = await call(freshFixture.byPath[API_PREFIX + '/rebuild'], {
    method: 'POST',
    url: API_PREFIX + '/rebuild',
    body: JSON.stringify({ id: '/srv/a' }),
  });
  assert.equal(skipped.json().queued, 0);
  assert.equal(skipped.json().skipped, 1);
  assert.match(skipped.json().note, /force=true/);

  // 帶 force 就照排，並把 mode 傳下去。
  const forced = await call(freshFixture.byPath[API_PREFIX + '/rebuild'], {
    method: 'POST',
    url: API_PREFIX + '/rebuild',
    body: JSON.stringify({ id: '/srv/a', force: true, mode: 'fast' }),
  });
  assert.equal(forced.json().queued, 1);
  assert.deepEqual(freshFixture.keeper.enqueued, [{ key: '/srv/a', reason: 'manual', mode: 'fast' }]);
});

test('POST /watchers 只接受 pause／resume，找不到專案回 404', async function () {
  const fixture = makeFixture();
  const invalid = await call(fixture.byPath[API_PREFIX + '/watchers'], {
    method: 'POST',
    url: API_PREFIX + '/watchers',
    body: JSON.stringify({ action: 'drop' }),
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.json().error, /pause/);

  const paused = await call(fixture.byPath[API_PREFIX + '/watchers'], {
    method: 'POST',
    url: API_PREFIX + '/watchers',
    body: JSON.stringify({ action: 'pause', id: '/srv/a' }),
  });
  assert.equal(paused.status, 200);
  assert.deepEqual(fixture.keeper.watcherCalls, [{ key: '/srv/a', action: 'pause' }]);

  fixture.keeper.watcherResult = { ok: false, affected: 0, error: '找不到專案：/srv/x' };
  const missing = await call(fixture.byPath[API_PREFIX + '/watchers'], {
    method: 'POST',
    url: API_PREFIX + '/watchers',
    body: JSON.stringify({ action: 'resume', id: '/srv/x' }),
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json().error, '找不到專案：/srv/x');
});

test('GET /config 讀設定；沒有 settings 服務時寫入回 503', async function () {
  const fixture = makeFixture({ config: function () { return { mode: 'fast' }; } });
  const read = await call(fixture.byPath[API_PREFIX + '/config']);
  assert.equal(read.status, 200);
  assert.equal(read.json().config.mode, 'fast');

  const blocked = await call(fixture.byPath[API_PREFIX + '/config'], {
    method: 'POST',
    url: API_PREFIX + '/config',
    body: JSON.stringify({ mode: 'full' }),
  });
  assert.equal(blocked.status, 503);
  assert.match(blocked.json().error, /唯讀/);
});

test('POST /config 寫入時呼叫 updateConfig 並回新值', async function () {
  const written = [];
  let current = { mode: 'fast' };
  const fixture = makeFixture({
    config: function () { return current; },
    updateConfig: async function (patch) {
      written.push(patch);
      current = Object.assign({}, current, patch);
    },
  });
  const response = await call(fixture.byPath[API_PREFIX + '/config'], {
    method: 'POST',
    url: API_PREFIX + '/config?note=test',
    body: JSON.stringify({ mode: 'full' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(written, [{ mode: 'full' }]);
  assert.equal(response.json().config.mode, 'full');
  assert.equal(response.json().note, 'test');
});

test('內文不是 JSON 物件時回 400 並留下路由標籤', async function () {
  const fixture = makeFixture();
  const response = await call(fixture.byPath[API_PREFIX + '/rebuild'], {
    method: 'POST',
    url: API_PREFIX + '/rebuild',
    body: '[1,2,3]',
  });
  assert.equal(response.status, 400);
  assert.equal(response.json().route, 'rebuild');
  assert.match(response.json().error, /JSON 物件/);
  assert.equal(fixture.log.entries.some(function (entry) { return entry.event === 'route.failed'; }), true);

  const empty = await call(fixture.byPath[API_PREFIX + '/rebuild'], { method: 'POST', url: API_PREFIX + '/rebuild' });
  assert.equal(empty.status, 200, '空內文視為空物件，不是錯誤');
});
