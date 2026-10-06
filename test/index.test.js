/**
 * index.js 的整合測試（插件入口與控制面掛載）。
 *
 * 這一支先前完全沒有測試，而它正是「UI 依賴的對外介面」真正被組出來的地方：
 * `apply()` 建立 keeper、掛生命週期、註冊七條路由。keeper 的單元測試顧不到
 * 「這些欄位到底有沒有出現在 `GET /state` 的回應裡」——而那正是設定頁卡片
 * 唯一看得到的東西，也是換代時最容易無聲斷掉的一條線。
 *
 * 做法：用真的 `apply()`，只把三個外部邊界換掉——
 *   1. `DSH_HOME` 指向暫存目錄（狀態檔與日誌都落在裡面，測試結束即刪）；
 *   2. `cliPath` 指向 `test/helpers/fake-cbm.js` 產生的假執行檔（不 spawn 真的
 *      codebase-memory-mcp）；
 *   3. `graphUrl` 指向 `127.0.0.1:1`（一個必然拒絕連線的埠），讓圖譜 UI 的探測
 *      立刻失敗而不是去打真的 CBM UI，也不會有 1 秒逾時的等待。
 *
 * 其餘——路徑解析、狀態機、佇列、日誌輪替、生命週期順序——都是真的在跑。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { apply, dshHomeDir, inject, name } from '../lib/index.js';
import { API_PREFIX, LOG_FILE_NAME, PLUGIN_ID, STATE_DIR_NAME } from '../lib/constants.js';
import { CONFIG_FIELDS, defaultConfigValues } from '../lib/config.js';
import { fakeProject, installFakeCbm } from './helpers/fake-cbm.js';
import { makeTempDir, waitFor } from './helpers/env.js';
import { makeExchange } from './helpers/http.js';

/** 文件記載的七條路由（與 routes.test.js 的 DOCUMENTED_PATHS 對齊）。 */
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
 * 掛載一次插件，並回傳驅動它所需的一切。
 *
 * @param {object} t - node:test 的 TestContext。
 * @param {object} [options] - 情境。
 * @param {object} [options.config] - 覆寫插件設定。
 * @param {boolean} [options.withSettings] - 是否提供 settings 服務。
 * @param {boolean} [options.poisonStateDir] - 把狀態目錄先建成一個「檔案」，讓日誌與狀態都開不起來。
 * @returns {Promise<object>} { ctx, routes, byPath, call, logPath, settings, home, dispose }。
 */
async function mount(t, options) {
  const settings = options ?? {};
  const dir = await makeTempDir(t, 'codebase-watcher-index');
  const home = join(dir, 'dsh-home');
  const repo = join(dir, 'repo');
  const fake = await installFakeCbm(dir, {
    projects: [fakeProject({ name: 'index-fixture', rootPath: repo, graphHead: '3449ba2' })],
    sha: {},
    config: { auto_index: 'false', auto_watch: 'false', ui_enabled: 'false' },
  });

  if (settings.poisonStateDir === true) {
    // 把「應該是指標目錄」的路徑先建成一個普通檔案：mkdir 會得到 ENOTDIR，
    // 於是 log.open() 與 state.load() 都走進各自的錯誤分支。這是唯一能讓
    // `status().logFileError` / `stateLoadError` 真的帶值的方法。
    await mkdir(home, { recursive: true });
    await writeFile(join(home, STATE_DIR_NAME), 'not a directory\n', 'utf8');
  }

  const config = Object.assign({
    enabled: false,
    cliPath: fake.path,
    mode: 'full',
    scanMinutes: 1440,
    watchEnabled: false,
    autoRebuild: false,
    nice: 0,
    // 必然拒絕連線的埠：探測立刻失敗，不打真的 CBM UI，也沒有逾時等待。
    graphUrl: 'http://127.0.0.1:1',
  }, settings.config ?? {});

  const routes = [];
  const disposers = [];
  const loggerLines = [];
  const mutateCalls = [];

  const ctx = {
    logger: {
      info: function (line) { loggerLines.push(line); },
    },
    get: function (service) {
      if (service !== 'settings') return undefined;
      if (settings.withSettings !== true) return undefined;
      return {
        mutate: async function (namespace, ops) { mutateCalls.push({ namespace, ops }); },
      };
    },
    effect: function (fn) {
      const cleanup = fn();
      disposers.push(cleanup);
      return function () {
        const index = disposers.indexOf(cleanup);
        if (index >= 0) disposers.splice(index, 1);
      };
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

  const byPath = {};
  for (const route of routes) byPath[route.path] = route;

  /**
   * 呼叫一條路由。
   *
   * `path` 可以帶查詢字串（`'/state?log=0'`）：查表用的是去掉查詢字串的路徑，
   * 送給 handler 的仍是完整的 URL。
   *
   * @param {string} path - 路由路徑（API_PREFIX 之後的部分，可帶查詢字串）。
   * @param {object} [request] - 請求選項。
   * @returns {Promise<object>} 回應讀取器。
   */
  async function call(path, request) {
    const bare = path.split('?')[0];
    const route = byPath[API_PREFIX + bare];
    if (route === undefined) throw new Error('沒有這條路由：' + bare);
    const exchange = makeExchange(Object.assign({ url: path }, request ?? {}));
    await route.handler(exchange.req, exchange.res);
    return exchange.read();
  }

  /** 依註冊逆序卸載（模擬 Cordis 收回 fiber 的順序）。 */
  async function dispose() {
    const pending = disposers.slice().reverse();
    disposers.length = 0;
    for (const cleanup of pending) {
      if (typeof cleanup === 'function') await cleanup();
    }
  }

  return {
    ctx,
    routes,
    byPath,
    call,
    settings: { mutateCalls },
    loggerLines,
    home,
    dir,
    config,
    logPath: join(home, STATE_DIR_NAME, LOG_FILE_NAME),
    dispose,
  };
}

/**
 * 讀出插件日誌的全文（檔案不存在時回空字串）。
 * @param {string} logPath - 日誌檔路徑。
 * @returns {Promise<string>} 內容。
 */
async function readLog(logPath) {
  return readFile(logPath, 'utf8').catch(function () { return ''; });
}

/**
 * 等到第一次掃描完成（`lastRefreshAt` 有值）。
 * @param {object} mounted - mount 的回傳值。
 * @returns {Promise<void>} 完成。
 */
async function waitForFirstScan(mounted) {
  await waitFor(async function () {
    const payload = (await mounted.call('/state')).json();
    return payload.status.lastRefreshAt !== undefined;
  }, { label: '首次掃描完成', timeoutMs: 20000 });
}

test('index.js：對外識別碼與注入面與 manifest 一致', function () {
  assert.equal(name, PLUGIN_ID, '插件名必須等於 cordis.patch.yml 的 insert id');
  assert.deepEqual(inject, ['webServer'], '控制面唯一的硬相依是 webServer');
  assert.equal(typeof apply, 'function');
});

test('index.js：dshHomeDir 以 DSH_HOME 為優先，未設時回 ~/.dsh', function (t) {
  const previous = process.env.DSH_HOME;
  t.after(function () {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  });

  process.env.DSH_HOME = '/tmp/dsh-home-fixture';
  assert.equal(dshHomeDir(), '/tmp/dsh-home-fixture');

  // 空字串與純空白都視為「沒設」，不可讓它變成相對路徑的根。
  process.env.DSH_HOME = '   ';
  assert.match(dshHomeDir(), /\.dsh$/, '空白的 DSH_HOME 應退回 ~/.dsh');

  delete process.env.DSH_HOME;
  assert.match(dshHomeDir(), /\.dsh$/);
});

test('index.js：掛載後註冊文件記載的七條路由，且路徑都在 API_PREFIX 之下', async function (t) {
  const mounted = await mount(t);

  assert.equal(mounted.routes.length, DOCUMENTED_PATHS.length, '路由數量應與文件一致');
  for (const path of DOCUMENTED_PATHS) {
    assert.ok(mounted.byPath[API_PREFIX + path] !== undefined, '缺少路由：' + path);
    assert.equal(mounted.byPath[API_PREFIX + path].kind, 'exact');
  }
  await mounted.dispose();
});

test('index.js：生命週期真的跑起來，且日誌依序留下 plugin.start 與 plugin.stop', async function (t) {
  const mounted = await mount(t);
  await waitForFirstScan(mounted);

  const started = await readLog(mounted.logPath);
  assert.match(started, /msg=plugin\.start/, '啟動應留下 plugin.start');
  assert.match(started, /msg=scan\.done/, '首次掃描應完成');
  assert.doesNotMatch(started, /msg=plugin\.stop/, '卸載前不該有 plugin.stop');

  await mounted.dispose();

  await waitFor(async function () {
    return /msg=plugin\.stop/.test(await readLog(mounted.logPath));
  }, { label: '卸載收尾', timeoutMs: 10000 });

  const stopped = await readLog(mounted.logPath);
  assert.ok(
    stopped.indexOf('msg=plugin.start') < stopped.indexOf('msg=plugin.stop'),
    'plugin.start 必須排在 plugin.stop 之前',
  );
});

test('index.js：未宣告的設定鍵會在啟動時具名警告', async function (t) {
  const mounted = await mount(t, { config: { scanMs: 5 } });
  await waitForFirstScan(mounted);

  const log = await readLog(mounted.logPath);
  assert.match(log, /msg=config\.unknown-keys/, '打錯欄位名（scanMs）必須留下痕跡');
  assert.match(log, /scanMs/, '警告要指出是哪個鍵');
  await mounted.dispose();
});

test('GET /state：帶出設定頁卡片依賴的每一個欄位（換代時最容易無聲斷掉的契約）', async function (t) {
  const mounted = await mount(t);
  await waitForFirstScan(mounted);

  const payload = (await mounted.call('/state')).json();
  const status = payload.status;

  // 卡片直接讀的狀態欄位。缺一個，UI 就會靜默少一塊而不是報錯。
  for (const key of [
    'enabled',
    'cliPath',
    'cliVersion',
    'warnings',
    'graphUi',
    'watching',
    'queue',
    'stats',
    'statsSince',
  ]) {
    assert.ok(Object.hasOwn(status, key) === true, 'status 缺少欄位：' + key);
  }

  // `logFileError` / `stateLoadError` 不在此清單：它們的值是 undefined 時會被
  // `JSON.stringify` 整個丟掉，所以「正常時不在回應裡」就是它們的線上編碼。
  // 真正要守的是「有問題時必須帶著訊息出現」——見下一條。
  assert.ok(!('logFileError' in status) || typeof status.logFileError === 'string');
  assert.ok(!('stateLoadError' in status) || typeof status.stateLoadError === 'string');

  assert.equal(status.enabled, false, 'enabled 必須如實反映設定');
  assert.equal(typeof status.statsSince, 'string', 'statsSince 應是 ISO 字串');
  assert.equal(status.stats.constructor, Object, 'stats 應是扁平物件');

  // 成效統計的鍵必須齊全且是數字（UI 直接格式化，缺鍵會顯示 undefined）。
  for (const key of Object.keys(status.stats)) {
    assert.equal(typeof status.stats[key], 'number', 'stats.' + key + ' 應是數字');
  }
  assert.ok(Object.keys(status.stats).length >= 20, 'stats 應至少 20 個鍵');
  assert.equal(typeof status.stats.sinceStartRebuildsQueued, 'number');
  assert.equal(typeof status.stats.last24hRebuildsAborted, 'number');

  // 專案列：這些是**無條件**會出現的（值可能是 null，但鍵一定在）。
  assert.ok(Array.isArray(payload.projects));
  assert.ok(payload.projects.length >= 1, '假 CLI 回報的專案應被納管');
  const project = payload.projects[0];
  for (const key of [
    'key',
    'name',
    'rootPath',
    'branch',
    'selected',
    'orphaned',
    'behindBy',
    'stale',
    'confidence',
    'reasons',
    'dirty',
    'rebuildState',
    'watcherPaused',
    'watcher',
  ]) {
    assert.ok(Object.hasOwn(project, key) === true, 'project 缺少欄位：' + key);
  }
  assert.equal(project.orphaned, false, '上游回報過的專案不該是孤兒');
  assert.ok(Array.isArray(project.reasons));
  assert.equal(project.watcher.constructor, Object);

  // 其餘是**條件式**的：值為 undefined 時 JSON 會把鍵整個丟掉，所以 UI 一律以
  // 「鍵不在」等於「沒有這個資訊」來讀。這裡把它固定成契約，避免日後有人
  // 為了讓某個鍵「一定在」而改成塞 null——那會讓卡片把「未知」畫成「有值」。
  for (const key of ['graphHead', 'liveHead', 'rebuildStartedAt', 'lastError', 'lastIndexedAt']) {
    assert.ok(
      !(key in project) || project[key] !== null,
      key + ' 若要出現就不該是 null（未知一律以「鍵不在」表達）',
    );
  }

  assert.ok(Array.isArray(payload.caveats) && payload.caveats.length > 0, 'caveats 應有內容');
  assert.ok(Array.isArray(payload.log), 'log 應是陣列');

  await mounted.dispose();
});

test('GET /state?log=0：真的回 0 筆日誌（卡片收起日誌面板時送的就是這個）', async function (t) {
  const mounted = await mount(t);
  await waitForFirstScan(mounted);

  const withLogs = (await mounted.call('/state')).json();
  const without = (await mounted.call('/state?log=0')).json();

  assert.ok(withLogs.log.length > 0, '預設應帶出日誌');
  assert.equal(without.log.length, 0, 'log=0 應為 0 筆');

  await mounted.dispose();
});

test('POST /config：未知欄位不寫入、列進 unknown，且部分是未知時仍回 200', async function (t) {
  const mounted = await mount(t, { withSettings: true });
  await waitForFirstScan(mounted);

  const rejected = (await mounted.call('/config', {
    method: 'POST',
    body: JSON.stringify({ scanMs: 5 }),
  })).json();
  assert.equal(rejected.error !== undefined, true, '全部未知時應回錯誤');
  assert.deepEqual(rejected.unknown, ['scanMs']);
  assert.equal(mounted.settings.mutateCalls.length, 0, '未知鍵不得寫入');

  const partial = (await mounted.call('/config', {
    method: 'POST',
    body: JSON.stringify({ scanMinutes: 10, nope: 1 }),
  })).json();
  assert.equal(partial.ok, true, '部分未知時仍應套用已知鍵');
  assert.deepEqual(partial.unknown, ['nope']);
  assert.equal(mounted.settings.mutateCalls.length, 1);
  assert.deepEqual(mounted.settings.mutateCalls[0].ops, [
    { op: 'set', path: ['scanMinutes'], value: 10 },
  ]);

  await mounted.dispose();
});

test('POST /config：寫入目標必須是插件自己的命名空間', async function (t) {
  const mounted = await mount(t, { withSettings: true });
  await waitForFirstScan(mounted);

  await mounted.call('/config', {
    method: 'POST',
    body: JSON.stringify({ graphUrl: '' }),
  });

  assert.equal(mounted.settings.mutateCalls.length, 1);
  assert.equal(mounted.settings.mutateCalls[0].namespace, PLUGIN_ID);
  assert.deepEqual(mounted.settings.mutateCalls[0].ops, [
    { op: 'set', path: ['graphUrl'], value: '' },
  ]);

  await mounted.dispose();
});

test('POST /config：空內文不觸發任何寫入（settings.mutate 不被呼叫）', async function (t) {
  const mounted = await mount(t, { withSettings: true });
  await waitForFirstScan(mounted);

  const response = await mounted.call('/config', { method: 'POST', body: '{}' });

  // 空 patch 走的是「讀取」分支（routes.js 以 Object.keys(body).length === 0 判斷），
  // 所以回的是設定內容而不是 ok:true；重點是不得產生任何寫入。
  assert.equal(response.json().config !== undefined, true);
  assert.equal(mounted.settings.mutateCalls.length, 0);

  await mounted.dispose();
});

test('狀態目錄開不起來時：logFileError / stateLoadError 帶著訊息出現在 /state 上', async function (t) {
  // 這一條驗的是「有問題時必須看得見」——那正是這兩個欄位存在的理由。
  // 沒有這一條，它們只在原始碼裡存在，線上永遠不會有人看到。
  const mounted = await mount(t, { poisonStateDir: true });
  await waitForFirstScan(mounted);

  const status = (await mounted.call('/state')).json().status;

  assert.equal(typeof status.logFileError, 'string', '日誌開不起來時必須具名回報');
  assert.ok(status.logFileError.length > 0);
  assert.equal(typeof status.stateLoadError, 'string', '狀態檔開不起來時必須具名回報');
  assert.ok(status.stateLoadError.length > 0);

  // 而且插件仍然活著：診斷資訊要能送出來，不能因為狀態目錄壞了就整個沉默。
  assert.ok(mounted.routes.length > 0, '路由必須仍在');
  assert.equal(typeof status.revision, 'number');

  await mounted.dispose();
});

test('POST /config：沒有 settings 服務時拒絕寫入，並說出原因', async function (t) {
  const mounted = await mount(t);
  await waitForFirstScan(mounted);

  const response = await mounted.call('/config', {
    method: 'POST',
    body: JSON.stringify({ scanMinutes: 10 }),
  });

  // routes.js 另有一條「deps.updateConfig 不是函式 → 503」的分支，但 index.js
  // 一定會把 updateConfig 傳進去，所以線上走的是「它拋錯 → wrap() 收成 400」。
  // 兩條路的訊息相同、都不假裝成功；這裡固定實際行為，避免日後有人照著
  // routes.js 的 503 去寫客戶端。
  assert.equal(response.status, 400);
  assert.match(response.json().error, /settings/);

  await mounted.dispose();
});

test('POST /check 帶不存在的 id：回 404 並附提示（不是 502）', async function (t) {
  const mounted = await mount(t);
  await waitForFirstScan(mounted);

  const response = await mounted.call('/check', {
    method: 'POST',
    body: JSON.stringify({ id: '/no/such/project' }),
  });
  assert.equal(response.status, 404);
  assert.match(response.json().hint, /projects\[\]\.key/);

  await mounted.dispose();
});

test('卸載後：路由被收回，且 keeper 不再接受新的工作', async function (t) {
  const mounted = await mount(t);
  await waitForFirstScan(mounted);

  const before = (await mounted.call('/state')).json();
  assert.ok(before.status.revision > 0, '卸載前應有活動');

  await mounted.dispose();

  assert.equal(mounted.routes.length, 0, 'route 的 disposer 應把路由收回');

  // 卸載後不該再有任何新的掃描寫進日誌。
  const afterDispose = await readLog(mounted.logPath);
  const scansBefore = (afterDispose.match(/msg=scan\.done/g) ?? []).length;
  await new Promise(function (resolve) { setTimeout(resolve, 300); });
  const scansAfter = ((await readLog(mounted.logPath)).match(/msg=scan\.done/g) ?? []).length;
  assert.equal(scansAfter, scansBefore, '卸載後不得再產生掃描');
});

// ---------------------------------------------------------------------------
// WS12：重置功能（op 層——這裡才是真的把 undefined 映射成 unset 的地方）
// ---------------------------------------------------------------------------

test('WS12：POST /config {"reset": true} 對所有可寫欄位發 unset op', async function (t) {
  const mounted = await mount(t, { withSettings: true });
  await waitForFirstScan(mounted);

  const response = await mounted.call('/config', {
    method: 'POST',
    body: JSON.stringify({ reset: true }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.json().ok, true);
  assert.equal(mounted.settings.mutateCalls.length, 1);
  const call = mounted.settings.mutateCalls[0];
  assert.equal(call.namespace, PLUGIN_ID);
  assert.equal(call.ops.length, CONFIG_FIELDS.length, '每一個可寫欄位都要被 unset');
  for (const op of call.ops) {
    assert.equal(op.op, 'unset', '恢復預設＝unset（清掉覆寫、落回 schema 的 default）');
    assert.equal(op.path.length, 1);
    assert.equal('value' in op, false, 'unset 不帶值');
  }
  assert.deepEqual(call.ops.map(function (op) { return op.path[0]; }), CONFIG_FIELDS);
  // 回應不得把 reset 這個指令鍵本身當成未知欄位回報。
  assert.deepEqual(response.json().unknown, []);
  assert.deepEqual(response.json().reset, CONFIG_FIELDS);

  await mounted.dispose();
});

test('WS12：POST /config {"reset": ["dirtySettleSeconds"]} 只 unset 那一個欄位', async function (t) {
  const mounted = await mount(t, { withSettings: true });
  await waitForFirstScan(mounted);

  const response = await mounted.call('/config', {
    method: 'POST',
    body: JSON.stringify({ reset: ['dirtySettleSeconds'] }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(mounted.settings.mutateCalls[0].ops, [
    { op: 'unset', path: ['dirtySettleSeconds'] },
  ]);
  assert.deepEqual(response.json().reset, ['dirtySettleSeconds']);

  await mounted.dispose();
});

test('WS12：reset 與賦值同時出現時，所有 unset 都排在 set 之前', async function (t) {
  const mounted = await mount(t, { withSettings: true });
  await waitForFirstScan(mounted);

  const response = await mounted.call('/config', {
    method: 'POST',
    body: JSON.stringify({ reset: ['nice'], scanMinutes: 10 }),
  });

  assert.equal(response.status, 200);
  // 順序語意：先 reset（unset），再套用一般賦值（set）。ops 是依序套用的，
  // 所以 unset 必須全部排在前面。
  assert.deepEqual(mounted.settings.mutateCalls[0].ops, [
    { op: 'unset', path: ['nice'] },
    { op: 'set', path: ['scanMinutes'], value: 10 },
  ]);
  assert.deepEqual(response.json().unknown, []);

  await mounted.dispose();
});

test('WS12：GET /config 在真插件入口上就帶 defaults 與 overridden', async function (t) {
  const mounted = await mount(t);
  await waitForFirstScan(mounted);

  const payload = (await mounted.call('/config')).json();
  assert.deepEqual(payload.defaults, defaultConfigValues(), 'defaults 就是可寫形狀的預設值');
  assert.equal(payload.defaults.dirtySettleSeconds, 90);

  // mount 的預設 config 手動開了一堆欄位 → overridden 必須誠實列出來。
  assert.equal(Array.isArray(payload.overridden), true);
  assert.equal(payload.overridden.includes('cliPath'), true, 'cliPath 被測試設定覆寫過');
  assert.equal(payload.overridden.includes('enabled'), true, 'enabled=false 與預設 true 不同');
  assert.equal(payload.overridden.includes('dirtySettleSeconds'), false, '沒被改過的欄位不該出現');
  assert.deepEqual(payload.overridden.slice().sort(), payload.overridden, '必須排序');

  await mounted.dispose();
});
