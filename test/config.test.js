/**
 * config.js 的測試。
 *
 * 兩個入口都要吃：Loader 直接傳純物件（測試／無 volatile 的部署），以及每個欄位
 * 都是 `{get()}` 參照的 volatile 形態。數值界線與清單語意（`*` 萬用字元、空字串
 * 代表內建清單）是設定頁的實際契約，逐值驗證。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CONFIG_DEFAULTS,
  CONFIG_FIELDS,
  isProjectSelected,
  profilePackageRoots,
  readConfigValues,
  resolveKeeperConfig,
  resolveSchemastery,
  schemasteryRequireRoots,
} from '../lib/config.js';
import { DEFAULT_WATCH_EXCLUDES, DEFAULT_WATCH_EXTENSIONS } from '../lib/constants.js';

/** 本插件的 package 目錄（測試夾具要假裝 profile 把它 link 進去）。 */
const PLUGIN_DIR = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));
/** 不存在的家目錄：讓解析根推導保持封閉，不會掃到真機的 ~/.dsh。 */
const ISOLATED_HOME = '/nonexistent-home-for-tests';

test('schemastery 的解析根：環境有給 profile 時排第一，且順序穩定', function () {
  const roots = schemasteryRequireRoots(
    { DSH_PROFILE_DIR: '/p/web', HOME: ISOLATED_HOME },
    '/work',
    'file:///work/dsh-codebase-watcher/lib/config.js',
  );
  // 插件以 link: 安裝時 import.meta.url 指向工作區，從那裡往上是找不到
  // @deepseek-ai/schemastery 的；環境有給 profile 目錄時必須排第一。
  assert.equal(roots[0], '/p/web/package.json');
  assert.equal(roots[1], 'file:///work/dsh-codebase-watcher/lib/config.js');
  assert.equal(roots[2], '/work/package.json');
  assert.equal(roots.length, 3, '孤立的家目錄下不該再長出 profile 解析根');

  // 沒有 DSH_PROFILE_DIR 時不得產生一個 undefined 的解析根。
  const bare = schemasteryRequireRoots({ HOME: ISOLATED_HOME }, '/work', 'file:///work/x.js');
  assert.deepEqual(bare, ['file:///work/x.js', '/work/package.json']);
  const blank = schemasteryRequireRoots({ DSH_PROFILE_DIR: '', HOME: ISOLATED_HOME }, '/work', 'file:///work/x.js');
  assert.deepEqual(blank, ['file:///work/x.js', '/work/package.json']);
});

test('profilePackageRoots：把真的 link 了本插件的 profile 排在前面', function () {
  const home = mkdtempSync(join(tmpdir(), 'codebase-watcher-home-'));
  try {
    // web 把本插件 link 進來；headless 沒有。字母序 headless 在前，排序必須把它壓後。
    mkdirSync(join(home, 'profiles', 'headless'), { recursive: true });
    mkdirSync(join(home, 'profiles', 'web', 'node_modules'), { recursive: true });
    symlinkSync(PLUGIN_DIR, join(home, 'profiles', 'web', 'node_modules', 'dsh-codebase-watcher'), 'dir');

    const roots = profilePackageRoots(
      { DSH_HOME: home },
      pathToFileURL(join(PLUGIN_DIR, 'lib', 'config.js')).href,
    );
    assert.deepEqual(roots, [
      join(home, 'profiles', 'web', 'package.json'),
      join(home, 'profiles', 'headless', 'package.json'),
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  // 沒有 profiles 目錄的部署（不是 profile 啟動）→ 沒有備援解析根。
  assert.deepEqual(profilePackageRoots({ DSH_HOME: join(ISOLATED_HOME, '.dsh') }), []);
});

test('resolveSchemastery：宿主行程條件下（process.env 沒有 DSH_PROFILE_DIR）仍走 profile 解析根', function () {
  // 這條是「POST /config 可寫」的真正守門：dsh-shell-env 只把 DSH_PROFILE_DIR 注入
  // 每一次模型 shell 呼叫的子行程，載入插件的宿主行程裡沒有它（實測 /proc/<pid>/environ
  // 完全沒有 DSH_* 變數）。少了這一條，重啟後 Config 仍然是 undefined。
  //
  // 夾具自備一個假的 DSH home 與假的 @deepseek-ai/schemastery，所以這條在任何機器上
  // 都可重現（CI 上沒有安裝 DSH 也照樣跑）；真機路徑由下一條測試負責。
  const home = mkdtempSync(join(tmpdir(), 'codebase-watcher-host-'));
  try {
    const fixture = join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'schemastery');
    mkdirSync(fixture, { recursive: true });
    writeFileSync(
      join(fixture, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/schemastery', version: '0.0.0-fixture', main: 'index.js' }),
    );
    writeFileSync(
      join(fixture, 'index.js'),
      "module.exports = { fixtureMarker: 'dsh-codebase-watcher-fixture', object: function object() { return {}; } };\n",
    );
    // web 把本插件 link 進來，排序上必須排在沒有 link 的 profile 前面（見上一條測試）。
    symlinkSync(PLUGIN_DIR, join(home, 'profiles', 'web', 'node_modules', 'dsh-codebase-watcher'), 'dir');

    const hostLike = { ...process.env, HOME: home, DSH_HOME: home };
    delete hostLike.DSH_PROFILE_DIR;
    const roots = schemasteryRequireRoots(
      hostLike,
      join(home, 'cwd'),
      pathToFileURL(join(PLUGIN_DIR, 'lib', 'config.js')).href,
    );
    assert.ok(
      roots.includes(join(home, 'profiles', 'web', 'package.json')),
      '宿主條件下的解析根必須包含 profile 的 package.json',
    );
    const z = resolveSchemastery(roots);
    assert.notEqual(z, null, '宿主條件下必須仍解析得到 @deepseek-ai/schemastery');
    assert.equal(typeof z.object, 'function');
    assert.equal(z.fixtureMarker, 'dsh-codebase-watcher-fixture', '必須命中 profile 的解析根，而不是別的來源');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('resolveSchemastery：真機宿主條件下取得 schemastery（需要本機裝過 DSH）', function (t) {
  const hostLike = { ...process.env };
  delete hostLike.DSH_PROFILE_DIR;
  const z = resolveSchemastery(schemasteryRequireRoots(hostLike, ISOLATED_HOME, import.meta.url));
  if (z === null) {
    // 這台機器沒有 DSH profile，沒有「真機解析根」可驗；上一條夾具測試已守住同一段程式碼。
    t.skip('本機找不到 @deepseek-ai/schemastery（未安裝 DSH），跳過真機解析根驗證');
    return;
  }
  assert.equal(typeof z.object, 'function');
});

test('resolveSchemastery：全部解析根都落空時回 null 且不拋', function () {
  assert.equal(resolveSchemastery(['/nonexistent-a/package.json', '/nonexistent-b/package.json']), null);
  assert.equal(resolveSchemastery([]), null);
});

test('resolveSchemastery：在真實 profile 上取得 schemastery（Config 匯出成 schema 的前提）', function (t) {
  const profileDir = process.env.DSH_PROFILE_DIR;
  if (typeof profileDir !== 'string' || profileDir.length === 0) {
    t.skip('這個環境沒有 DSH_PROFILE_DIR，無法驗證真實 profile 的解析路徑');
    return;
  }
  const z = resolveSchemastery(schemasteryRequireRoots());
  // 這條斷言是「設定頁與 POST /config 可寫」的守門：解析不到時 Config 會是
  // undefined，Loader 就不把這個 entry 當成可配置的（官方探針回 status: absent）。
  assert.notEqual(z, null, 'profile 上必須解析得到 @deepseek-ai/schemastery');
  assert.equal(typeof z.object, 'function');
});

test('resolveKeeperConfig()：無設定時回到預設值', function () {
  const resolved = resolveKeeperConfig(undefined);
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.cliPath, undefined);
  assert.equal(resolved.mode, 'full');
  assert.equal(resolved.rebuildTimeoutMs, CONFIG_DEFAULTS.rebuildTimeoutSeconds * 1000);
  assert.equal(resolved.scanMs, CONFIG_DEFAULTS.scanMinutes * 60000);
  assert.equal(resolved.watchEnabled, true);
  assert.equal(resolved.debounceMs, CONFIG_DEFAULTS.debounceMs);
  assert.equal(resolved.autoRebuild, true);
  assert.equal(resolved.includeDirty, true);
  assert.equal(resolved.nice, CONFIG_DEFAULTS.nice);
  assert.equal(resolved.maxLogEntries, CONFIG_DEFAULTS.maxLogEntries);
  assert.deepEqual(resolved.extensions, DEFAULT_WATCH_EXTENSIONS);
  assert.deepEqual(resolved.excludes, DEFAULT_WATCH_EXCLUDES);
  assert.deepEqual(resolved.includeProjects, []);
  assert.deepEqual(resolved.excludeProjects, []);
});

test('resolveKeeperConfig：純物件（非 volatile）逐欄生效', function () {
  const resolved = resolveKeeperConfig({
    enabled: false,
    cliPath: '  /opt/cbm/codebase-memory-mcp  ',
    mode: 'fast',
    rebuildTimeoutSeconds: 600,
    scanMinutes: 30,
    watchEnabled: false,
    debounceMs: 1000,
    autoRebuild: false,
    includeDirty: false,
    nice: 0,
    maxLogEntries: 100,
    extensions: 'ts, vue',
    excludes: 'node_modules, .git',
    includeProjects: 'sample-repo, hyper',
    excludeProjects: 'legacy',
  });
  assert.equal(resolved.enabled, false);
  assert.equal(resolved.cliPath, '/opt/cbm/codebase-memory-mcp', '設定值要去空白');
  assert.equal(resolved.mode, 'fast');
  assert.equal(resolved.rebuildTimeoutMs, 600000);
  assert.equal(resolved.scanMs, 1800000);
  assert.equal(resolved.watchEnabled, false);
  assert.equal(resolved.debounceMs, 1000);
  assert.equal(resolved.autoRebuild, false);
  assert.equal(resolved.includeDirty, false);
  assert.equal(resolved.nice, 0);
  assert.equal(resolved.maxLogEntries, 100);
  assert.deepEqual(resolved.extensions, ['ts', 'vue']);
  assert.deepEqual(resolved.excludes, ['node_modules', '.git']);
  assert.deepEqual(resolved.includeProjects, ['sample-repo', 'hyper']);
  assert.deepEqual(resolved.excludeProjects, ['legacy']);
});

test('resolveKeeperConfig：volatile 參照物件（Loader 的實際形態）', function () {
  const values = {
    enabled: true,
    cliPath: '/usr/local/bin/codebase-memory-mcp',
    mode: 'moderate',
    rebuildTimeoutSeconds: 900,
    scanMinutes: 10,
    watchEnabled: true,
    debounceMs: 5000,
    autoRebuild: true,
    includeDirty: false,
    nice: 5,
    maxLogEntries: 200,
    extensions: 'py',
    excludes: 'venv',
    includeProjects: '',
    excludeProjects: '',
  };
  const config = {};
  for (const field of CONFIG_FIELDS) {
    config[field] = { get: function () { return values[field]; } };
  }
  const resolved = resolveKeeperConfig(config);
  assert.equal(resolved.cliPath, '/usr/local/bin/codebase-memory-mcp');
  assert.equal(resolved.mode, 'moderate');
  assert.equal(resolved.scanMs, 600000);
  assert.equal(resolved.includeDirty, false);
  assert.equal(resolved.nice, 5);
  assert.deepEqual(resolved.extensions, ['py']);
  assert.deepEqual(resolved.excludes, ['venv']);
});

test('readConfigValues：空字串保留語意，undefined／null 才回退預設', function () {
  const values = readConfigValues({ excludes: '', cliPath: '', nice: undefined, mode: null });
  assert.equal(values.excludes, '', '空字串＝用內建清單，不能被換成字串預設');
  assert.equal(values.cliPath, '');
  assert.equal(values.nice, CONFIG_DEFAULTS.nice, 'undefined 才回退');
  assert.equal(values.mode, CONFIG_DEFAULTS.mode, 'null 也回退');
  // volatile 參照回傳 undefined 時同樣回退。
  const viaRef = readConfigValues({ mode: { get: function () { return undefined; } } });
  assert.equal(viaRef.mode, CONFIG_DEFAULTS.mode);
});

test('resolveKeeperConfig：extensions 萬用字元 * 代表不過濾', function () {
  const wildcard = resolveKeeperConfig({ extensions: '*' });
  assert.deepEqual(wildcard.extensions, [], '空白名單＝全部副檔名都算');

  const mixed = resolveKeeperConfig({ extensions: 'ts, *, vue' });
  assert.deepEqual(mixed.extensions, [], '清單中含 * 就整份失效');
});

test('resolveKeeperConfig：自訂 excludes 取代內建清單', function () {
  const custom = resolveKeeperConfig({ excludes: 'node_modules' });
  assert.deepEqual(custom.excludes, ['node_modules']);
  assert.equal(custom.excludes.includes('dist'), false, '自訂清單不與內建聯集');

  const blank = resolveKeeperConfig({ excludes: '' });
  assert.deepEqual(blank.excludes, DEFAULT_WATCH_EXCLUDES, '留空才回內建清單');
});

test('resolveKeeperConfig：數值界線上下都夾住（nice／scanMinutes／debounceMs）', function () {
  const tooBig = resolveKeeperConfig({ nice: 30, scanMinutes: 99999, debounceMs: 9999999 });
  assert.equal(tooBig.nice, 19);
  assert.equal(tooBig.scanMs, 1440 * 60000, 'schema 宣告的 1440 分鐘上限必須在純函式路徑也生效');
  assert.equal(tooBig.debounceMs, 600000);

  const tooSmall = resolveKeeperConfig({ nice: -4, scanMinutes: 0.01, debounceMs: 1 });
  assert.equal(tooSmall.nice, 0);
  assert.equal(tooSmall.scanMs, 0.5 * 60000);
  assert.equal(tooSmall.debounceMs, 200);

  // 非數字（含 NaN）：一律回退該欄位的預設值（nice 的預設是 10，不是 0）。
  const junk = resolveKeeperConfig({ nice: 'fast', scanMinutes: 'soon', debounceMs: 'later' });
  assert.equal(junk.nice, CONFIG_DEFAULTS.nice);
  assert.equal(junk.scanMs, CONFIG_DEFAULTS.scanMinutes * 60000);
  assert.equal(junk.debounceMs, CONFIG_DEFAULTS.debounceMs);
  assert.equal(resolveKeeperConfig({ debounceMs: Number.NaN }).debounceMs, CONFIG_DEFAULTS.debounceMs);

  // rebuildTimeoutSeconds 上下限 30–21600 秒，且以毫秒對外。
  assert.equal(resolveKeeperConfig({ rebuildTimeoutSeconds: 1 }).rebuildTimeoutMs, 30000);
  assert.equal(resolveKeeperConfig({ rebuildTimeoutSeconds: 999999 }).rebuildTimeoutMs, 21600 * 1000);
  assert.equal(resolveKeeperConfig({ maxLogEntries: 1 }).maxLogEntries, 50);
});

test('resolveKeeperConfig：非法的 mode 字串退回 full', function () {
  assert.equal(resolveKeeperConfig({ mode: 'turbo' }).mode, 'full');
  assert.equal(resolveKeeperConfig({ mode: 'moderate' }).mode, 'moderate');
});

test('isProjectSelected：exclude 優先，include 留空＝全選', function () {
  const base = resolveKeeperConfig({});
  assert.equal(isProjectSelected('anything', base), true);

  const only = resolveKeeperConfig({ includeProjects: 'sample-repo, hyper' });
  assert.equal(isProjectSelected('sample-repo', only), true);
  assert.equal(isProjectSelected('other', only), false);

  const excluded = resolveKeeperConfig({ excludeProjects: 'legacy' });
  assert.equal(isProjectSelected('legacy', excluded), false);
  assert.equal(isProjectSelected('hyper', excluded), true);

  // 同時列出時 exclude 勝出。
  const both = resolveKeeperConfig({ includeProjects: 'a, b', excludeProjects: 'b' });
  assert.equal(isProjectSelected('a', both), true);
  assert.equal(isProjectSelected('b', both), false);
});

test('resolveKeeperConfig：graphUrl 去空白；留空＝由 CBM 的 ui_port 自動推導', function () {
  assert.equal(resolveKeeperConfig(undefined).graphUrl, '', '沒有設定時是空字串，不是 undefined');
  assert.equal(resolveKeeperConfig({ graphUrl: '  https://cbm.example.com/graph/  ' }).graphUrl, 'https://cbm.example.com/graph/');
  assert.equal(resolveKeeperConfig({ graphUrl: '   ' }).graphUrl, '');
  assert.equal(resolveKeeperConfig({ graphUrl: 42 }).graphUrl, '', '非字串一律回空字串，不讓後續拼字串時中毒');
});

test('CONFIG_FIELDS：graphUrl 是設定頁的一員', function () {
  assert.equal(CONFIG_FIELDS.includes('graphUrl'), true);
  assert.equal(CONFIG_DEFAULTS.graphUrl, '');
});
