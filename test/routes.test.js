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
import { CONFIG_FIELDS, CONFIG_DEFAULTS, defaultConfigValues } from '../lib/config.js';
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
  assert.deepEqual(freshFixture.keeper.enqueued, [{ key: '/srv/a', reason: 'manual', mode: 'fast', force: true }]);
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

test('C6：POST /rebuild 的 force 會傳進 enqueue（冷卻閘門不再擋掉人工重建）', async function (t) {
  const fixture = makeFixture({
    keeper: { listPayload: [{ key: '/srv/a', name: 'a', selected: true, stale: true }] },
  });

  // 沒帶 force：照舊（options.force 為 false，keeper 端仍受冷卻限制）。
  await call(fixture.byPath[API_PREFIX + '/rebuild'], {
    method: 'POST',
    url: API_PREFIX + '/rebuild',
    body: JSON.stringify({ id: '/srv/a' }),
  });
  assert.deepEqual(fixture.keeper.enqueued, [{ key: '/srv/a', reason: 'manual', mode: undefined }]);

  // 帶 force：必須把 force=true 傳下去，否則冷卻會擋掉它，而設定說明說它不受限。
  await call(fixture.byPath[API_PREFIX + '/rebuild'], {
    method: 'POST',
    url: API_PREFIX + '/rebuild',
    body: JSON.stringify({ id: '/srv/a', force: true }),
  });
  assert.equal(fixture.keeper.enqueued[1].force, true, 'C6：force 必須傳到 enqueue');
});

test('D2：POST /config 只寫已知欄位，未知鍵具名回報且不寫入', async function (t) {
  const written = [];
  let current = { mode: 'fast', scanMinutes: 5 };
  const fixture = makeFixture({
    config: function () { return current; },
    updateConfig: async function (patch) {
      written.push(patch);
      current = Object.assign({}, current, patch);
    },
  });

  const mixed = await call(fixture.byPath[API_PREFIX + '/config'], {
    method: 'POST',
    url: API_PREFIX + '/config',
    // scanMs 是 runtime 形狀的鍵名（GET /config 的 runtime 那一份），原樣 POST 回來
    // 是最常見的誤用；以前它會被靜默寫進 Loader config。
    body: JSON.stringify({ scanMinutes: 10, scanMs: 600000 }),
  });
  assert.equal(mixed.status, 200);
  assert.deepEqual(written, [{ scanMinutes: 10 }], 'D2：未知鍵不得進 updateConfig');
  const payload = mixed.json();
  assert.equal(payload.ok, true, '成功回應仍維持 {ok:true, …}');
  assert.deepEqual(payload.unknown, ['scanMs']);
  assert.equal(payload.config.scanMinutes, 10);

  // 全部都是未知鍵：回 400，不假裝寫入成功。
  const none = await call(fixture.byPath[API_PREFIX + '/config'], {
    method: 'POST',
    url: API_PREFIX + '/config',
    body: JSON.stringify({ scanMs: 1, nope: true }),
  });
  assert.equal(none.status, 400);
  assert.equal(none.json().error, '沒有可辨識的設定欄位');
  assert.deepEqual(none.json().unknown, ['nope', 'scanMs']);
  assert.equal(written.length, 1, 'D2：整批未知時不得呼叫 updateConfig');
});

test('D6：/check 與 /rebuild 對不存在的 id 回同一份 404', async function () {
  const fixture = makeFixture({
    keeper: { listPayload: [{ key: '/srv/a', name: 'a', selected: true, stale: true }] },
  });
  const fromCheck = await call(fixture.byPath[API_PREFIX + '/check'], {
    method: 'POST', url: API_PREFIX + '/check', body: JSON.stringify({ id: '/srv/nope' }),
  });
  const fromRebuild = await call(fixture.byPath[API_PREFIX + '/rebuild'], {
    method: 'POST', url: API_PREFIX + '/rebuild', body: JSON.stringify({ id: '/srv/nope' }),
  });
  assert.equal(fromCheck.status, 404);
  assert.equal(fromRebuild.status, 404);
  assert.deepEqual(fromCheck.json(), fromRebuild.json(), 'D6：兩條路由的錯誤必須逐字一致');
  assert.deepEqual(fromCheck.json().error, '找不到這個專案：/srv/nope');
  assert.equal(typeof fromCheck.json().hint, 'string');
  assert.deepEqual(fixture.keeper.enqueued, []);
});

test('WS5：GET /state?log=0 與 /log?limit=0 回 0 筆（面板收起時不再白抓一筆）', async function () {
  const fixture = makeFixture();
  fixture.log.info('a', {});
  fixture.log.info('b', {});
  fixture.log.info('c', {});

  const zero = await call(fixture.byPath[API_PREFIX + '/state'], { url: API_PREFIX + '/state?log=0' });
  assert.equal(zero.status, 200);
  assert.deepEqual(zero.json().log, [], '0 是真的 0 筆');
  assert.equal(zero.json().projects.length, 0, '其他欄位照常');

  const negative = await call(fixture.byPath[API_PREFIX + '/state'], { url: API_PREFIX + '/state?log=-3' });
  assert.deepEqual(negative.json().log, [], '負數不可能回得比 0 更少');

  const junk = await call(fixture.byPath[API_PREFIX + '/state'], { url: API_PREFIX + '/state?log=abc' });
  assert.equal(junk.json().log.length, 3, '非數字仍回預設（不是 0 筆）');

  const logZero = await call(fixture.byPath[API_PREFIX + '/log'], { url: API_PREFIX + '/log?limit=0' });
  assert.deepEqual(logZero.json().entries, []);

  const logOne = await call(fixture.byPath[API_PREFIX + '/log'], { url: API_PREFIX + '/log?limit=1' });
  assert.deepEqual(logOne.json().entries.map(function (entry) { return entry.event; }), ['c']);
});

// ---------------------------------------------------------------------------
// WS12：GET /config 的 defaults／overridden 與 POST /config 的 reset
// ---------------------------------------------------------------------------

test('WS12：defaults 與 config 同鍵集、同型別；全新部署的 overridden 是空陣列', async function () {
  const fixture = makeFixture({
    // 全新部署＝可寫設定就是一份預設值。
    configValues: function () { return defaultConfigValues(); },
    config: function () { return { mode: 'full', scanMs: 300000 }; },
    keeper: { statusPayload: { revision: 1, queue: [], upstreamConfig: { ui_port: '9749' } } },
  });
  const response = await call(fixture.byPath[API_PREFIX + '/config']);
  assert.equal(response.status, 200);
  const payload = response.json();

  assert.deepEqual(Object.keys(payload.defaults).sort(), Object.keys(payload.config).sort(), '鍵集必須一致');
  for (const field of Object.keys(payload.defaults)) {
    assert.equal(typeof payload.defaults[field], typeof payload.config[field], field + ' 的型別必須一致');
  }
  assert.equal(payload.defaults.dirtySettleSeconds, 90, 'WS12：預設 90 秒');
  assert.equal(CONFIG_DEFAULTS.dirtySettleSeconds, 90);
  assert.deepEqual(payload.overridden, [], '全是預設值時沒有被覆寫的欄位');

  // 原有的三個鍵一個都不能少、也不能換形狀。
  assert.equal(payload.config.mode, 'full');
  assert.equal(payload.runtime.scanMs, 300000);
  assert.deepEqual(payload.upstream, { ui_port: '9749' });
});

test('WS12：overridden 只列與預設不同的欄位（排序），reset 之後回到空', async function () {
  const defaults = defaultConfigValues();
  let current = Object.assign({}, defaults, { scanMinutes: 30, nice: 0 });
  const written = [];
  const fixture = makeFixture({
    configValues: function () { return current; },
    // 模擬宿主：undefined 就是 unset（清掉覆寫、落回 schema 的 default()）。
    updateConfig: async function (patch) {
      written.push(patch);
      for (const field of Object.keys(patch)) {
        if (patch[field] === undefined) current[field] = defaults[field];
        else current[field] = patch[field];
      }
    },
  });

  const before = (await call(fixture.byPath[API_PREFIX + '/config'])).json();
  assert.deepEqual(before.overridden, ['nice', 'scanMinutes'], '兩個被改過的欄位（排序）');

  const reset = await call(fixture.byPath[API_PREFIX + '/config'], {
    method: 'POST',
    url: API_PREFIX + '/config',
    body: JSON.stringify({ reset: ['scanMinutes', 'nice'] }),
  });
  assert.equal(reset.status, 200);
  assert.deepEqual(written, [{ scanMinutes: undefined, nice: undefined }], 'undefined＝unset（沿用既有那條路徑）');
  assert.deepEqual(reset.json().reset, ['scanMinutes', 'nice'], '回應說得出重置了哪些欄位');

  const after = (await call(fixture.byPath[API_PREFIX + '/config'])).json();
  assert.deepEqual(after.overridden, [], '重置後不再是被覆寫的欄位');
});

test('WS12：{"reset": true} 對所有可寫欄位發 unset', async function () {
  const written = [];
  const fixture = makeFixture({
    configValues: function () { return Object.assign({}, defaultConfigValues(), { nice: 0 }); },
    updateConfig: async function (patch) { written.push(patch); },
  });
  const response = await call(fixture.byPath[API_PREFIX + '/config'], {
    method: 'POST',
    url: API_PREFIX + '/config',
    body: JSON.stringify({ reset: true }),
  });
  assert.equal(response.status, 200);
  assert.equal(written.length, 1);
  assert.deepEqual(Object.keys(written[0]).sort(), CONFIG_FIELDS.slice().sort(), '每一個可寫欄位都要被重置');
  for (const field of CONFIG_FIELDS) {
    assert.equal(written[0][field], undefined, field + ' 必須是 undefined（＝unset）');
  }
  assert.deepEqual(response.json().reset, CONFIG_FIELDS, '回應列出全部欄位');
});

test('WS12：reset 陣列裡的未知欄位名進 unknown；reset 型別不對回 400', async function () {
  const written = [];
  const fixture = makeFixture({
    configValues: function () { return defaultConfigValues(); },
    updateConfig: async function (patch) { written.push(patch); },
  });

  const mixed = await call(fixture.byPath[API_PREFIX + '/config'], {
    method: 'POST',
    url: API_PREFIX + '/config',
    body: JSON.stringify({ reset: ['nope'], scanMinutes: 10 }),
  });
  assert.equal(mixed.status, 200, '已知鍵照常寫入，不因為 reset 裡有未知鍵就整批拒絕');
  assert.deepEqual(mixed.json().unknown, ['nope'], '未知欄位名不得被靜默忽略');
  assert.deepEqual(written, [{ scanMinutes: 10 }]);

  const bad = await call(fixture.byPath[API_PREFIX + '/config'], {
    method: 'POST',
    url: API_PREFIX + '/config',
    body: JSON.stringify({ reset: 'all' }),
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json().error, /reset 必須是 true/);
  assert.equal(written.length, 1, '型別錯誤時不得寫入');

  // reset: false 是「不要重置」，不是錯誤。
  const noop = await call(fixture.byPath[API_PREFIX + '/config'], {
    method: 'POST',
    url: API_PREFIX + '/config',
    body: JSON.stringify({ reset: false, mode: 'fast' }),
  });
  assert.equal(noop.status, 200);
  assert.deepEqual(noop.json().reset, []);
  assert.deepEqual(written[1], { mode: 'fast' });
});

test('WS12：同一欄位同時 reset 與賦值時，賦值勝出（只發一個 set）', async function () {
  const written = [];
  const fixture = makeFixture({
    configValues: function () { return defaultConfigValues(); },
    updateConfig: async function (patch) { written.push(patch); },
  });
  const response = await call(fixture.byPath[API_PREFIX + '/config'], {
    method: 'POST',
    url: API_PREFIX + '/config',
    body: JSON.stringify({ reset: ['scanMinutes'], scanMinutes: 10 }),
  });
  assert.equal(response.status, 200);
  // 「先 reset 再 set」的結果就是賦值勝出：同一個路徑上 unset 立刻被覆蓋，
  // 送兩個 op 只是多一次往返，語意完全一樣。
  assert.deepEqual(written, [{ scanMinutes: 10 }]);
  assert.deepEqual(response.json().reset, ['scanMinutes'], '它確實被列進 reset，只是值由賦值決定');
});
