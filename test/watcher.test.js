/**
 * watcher.js 的測試（FR-6）。
 *
 * 兩條後端都要驗：chokidar 用假的模組注入（不裝真的相依），退路則是真的
 * `fs.watch` —— 所以需要一個真的暫存目錄與真的寫檔，防抖視窗用 300ms。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createProjectWatcher } from '../lib/watcher.js';
import { makeFakeLog, makeTempDir, waitFor } from './helpers/env.js';

/**
 * 造一個會 reject 的 chokidar 載入器（模擬 optionalDependency 缺席）。
 * @returns {() => Promise<unknown>} 載入器。
 */
function failingLoader() {
  return async function () { throw new Error('Cannot find module chokidar'); };
}

/**
 * 造一個假的 chokidar 模組，記錄註冊與關閉。
 * @returns {{load: () => Promise<object>, watcher: object, events: string[]}} 載入器與其副作用。
 */
function makeFakeChokidar() {
  const events = [];
  const handlers = {};
  const watcher = {
    on: function (event, handler) {
      handlers[event] = handler;
      events.push('on:' + event);
      return watcher;
    },
    close: async function () { events.push('close'); },
  };
  return {
    events,
    watcher,
    handlers,
    load: async function () { return { watch: function (root, options) { events.push('watch:' + root + ':' + String(options.ignoreInitial)); return watcher; } }; },
  };
}

/**
 * 建立一個受測的監看器（chokidar 一律注入為失敗，走 fs.watch 退路）。
 * @param {object} options - 覆寫選項。
 * @returns {Promise<object>} 監看器。
 */
async function makeWatcher(options) {
  const settings = options ?? {};
  return createProjectWatcher({
    root: settings.root,
    excludes: settings.excludes ?? ['node_modules', '.git'],
    extensions: settings.extensions ?? ['ts', 'vue'],
    generatedPatterns: settings.generatedPatterns,
    debounceMs: settings.debounceMs ?? 300,
    onTrigger: settings.onTrigger ?? function () {},
    log: settings.log ?? makeFakeLog(),
    loadChokidar: settings.loadChokidar ?? failingLoader(),
    watch: settings.watch,
  });
}

test('H3：chokidar 的執行期錯誤會讓狀態變成 failed，並留下 lastError', async function (t) {
  const dir = await makeTempDir(t, 'cbm-watch-error');
  const log = makeFakeLog();
  const fake = makeFakeChokidar();
  const watcher = await makeWatcher({ root: dir, log, loadChokidar: fake.load });
  try {
    assert.equal(watcher.backend, 'chokidar');
    assert.equal(watcher.status(), 'watching');

    // inotify 用盡（ENOSPC）之類的錯誤是非同步送進來的：以前只寫一行 warn，
    // 狀態仍是 watching，卡片繼續說「監看中」，但存檔已經追不上了。
    fake.handlers.error(new Error('ENOSPC: System limit for number of file watchers reached'));

    assert.equal(watcher.status(), 'failed', '執行期錯誤不得讓狀態停在 watching');
    assert.match(watcher.lastError, /ENOSPC/);
    assert.equal(log.entries.some(function (entry) { return entry.event === 'watcher.error'; }), true);
  } finally {
    await watcher.stop();
  }
});

test('createProjectWatcher：chokidar 載入失敗時退到 fs.watch（或明確回報 failed）', async function (t) {
  const dir = await makeTempDir(t, 'cbm-watch-backend');
  const log = makeFakeLog();
  const watcher = await makeWatcher({ root: dir, log });
  try {
    assert.equal(['fs.watch', 'failed'].includes(watcher.backend), true, '不得停在 none');
    if (watcher.backend === 'failed') {
      assert.equal(watcher.status(), 'failed');
    } else {
      assert.equal(watcher.status(), 'watching');
    }
    assert.equal(log.entries.some(function (entry) { return entry.event === 'watcher.chokidar.unavailable'; }), true, '退路要留下可見痕跡');
  } finally {
    await watcher.stop();
  }
});

test('createProjectWatcher：chokidar 可用時走 chokidar，並套用排除規則', async function (t) {
  const dir = await makeTempDir(t, 'cbm-watch-chokidar');
  const fake = makeFakeChokidar();
  const triggers = [];
  const watcher = await makeWatcher({
    root: dir,
    loadChokidar: fake.load,
    onTrigger: function (info) { triggers.push(info); },
  });
  try {
    assert.equal(watcher.backend, 'chokidar');
    assert.equal(fake.events.includes('on:all'), true);
    assert.equal(fake.events.includes('on:error'), true);
    // 觸發路徑經過同一組過濾：白名單外的副檔名與被排除的目錄都不進防抖。
    fake.handlers.all('change', join(dir, 'src/app.css'));
    fake.handlers.all('change', join(dir, 'node_modules/pkg/index.ts'));
    fake.handlers.all('change', join(dir, 'src/app.vue'));
    await waitFor(function () { return triggers.length > 0; }, { timeoutMs: 5000, label: 'chokidar 觸發' });
    assert.equal(triggers.length, 1, '同一批事件只算一次');
    assert.deepEqual(triggers[0].sample, ['src/app.vue']);
    assert.equal(watcher.triggers, 1);
  } finally {
    await watcher.stop();
    assert.equal(fake.events.includes('close'), true, 'stop 必須關掉 chokidar');
  }
});

test('createProjectWatcher：寫一個 .ts 檔恰好觸發一次', async function (t) {
  const dir = await makeTempDir(t, 'cbm-watch-trigger');
  await mkdir(join(dir, 'src'), { recursive: true });
  const triggers = [];
  const watcher = await makeWatcher({
    root: dir,
    onTrigger: function (info) { triggers.push(info); },
  });
  try {
    if (watcher.backend === 'failed') {
      t.skip('此平台沒有可用的 fs.watch 後端');
      return;
    }
    await new Promise(function (resolve) { setTimeout(resolve, 150); });
    await writeFile(join(dir, 'src', 'app.ts'), 'export const a = 1;\n', 'utf8');
    await waitFor(function () { return triggers.length > 0; }, { timeoutMs: 6000, label: '.ts 寫入觸發' });
    assert.equal(triggers.length, 1);
    assert.equal(triggers[0].count, 1, '同一批只算一次變更');
    assert.deepEqual(triggers[0].sample, ['src/app.ts']);
    assert.equal(watcher.triggers, 1);
    assert.equal(typeof watcher.lastTriggerAt, 'string');

    // 防抖視窗內不得冒出第二次觸發。
    await new Promise(function (resolve) { setTimeout(resolve, 600); });
    assert.equal(triggers.length, 1, '防抖後只觸發一次');
  } finally {
    await watcher.stop();
  }
});

test('createProjectWatcher：排除目錄與白名單外的副檔名都不觸發', async function (t) {
  const dir = await makeTempDir(t, 'cbm-watch-filter');
  await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(join(dir, 'src'), { recursive: true });
  const triggers = [];
  const watcher = await makeWatcher({
    root: dir,
    onTrigger: function (info) { triggers.push(info); },
  });
  try {
    if (watcher.backend === 'failed') {
      t.skip('此平台沒有可用的 fs.watch 後端');
      return;
    }
    await new Promise(function (resolve) { setTimeout(resolve, 150); });
    await writeFile(join(dir, 'node_modules', 'pkg', 'index.ts'), 'x\n', 'utf8');
    await writeFile(join(dir, 'src', 'styles.css'), 'body{}\n', 'utf8');
    await writeFile(join(dir, 'src', 'notes.md'), '# hi\n', 'utf8');
    // 給防抖視窗兩倍時間：若過濾失效，這裡會觀察到觸發。
    await new Promise(function (resolve) { setTimeout(resolve, 800); });
    assert.deepEqual(triggers, [], 'excludes 與 extensions 必須在進防抖前就擋掉');
    assert.equal(watcher.triggers, 0);
  } finally {
    await watcher.stop();
  }
});

test('createProjectWatcher：stop 之後不再觸發且狀態為 stopped', async function (t) {
  const dir = await makeTempDir(t, 'cbm-watch-stop');
  const triggers = [];
  const watcher = await makeWatcher({
    root: dir,
    onTrigger: function (info) { triggers.push(info); },
  });
  if (watcher.backend === 'failed') {
    await watcher.stop();
    t.skip('此平台沒有可用的 fs.watch 後端');
    return;
  }
  await new Promise(function (resolve) { setTimeout(resolve, 150); });
  await writeFile(join(dir, 'a.ts'), '1\n', 'utf8');
  await waitFor(function () { return triggers.length > 0; }, { timeoutMs: 6000, label: '首次觸發' });
  const seen = triggers.length;
  await watcher.stop();
  assert.equal(watcher.status(), 'stopped');
  await writeFile(join(dir, 'b.ts'), '2\n', 'utf8');
  await new Promise(function (resolve) { setTimeout(resolve, 700); });
  assert.equal(triggers.length, seen, 'stop 之後不得再回呼');
  // 重複 stop 是安全的。
  await watcher.stop();
});

test('createProjectWatcher：onTrigger 拋錯不得打斷監看', async function (t) {
  const dir = await makeTempDir(t, 'cbm-watch-throw');
  const log = makeFakeLog();
  let calls = 0;
  const watcher = await makeWatcher({
    root: dir,
    log,
    onTrigger: function () { calls += 1; throw new Error('consumer exploded'); },
  });
  try {
    if (watcher.backend === 'failed') {
      t.skip('此平台沒有可用的 fs.watch 後端');
      return;
    }
    await new Promise(function (resolve) { setTimeout(resolve, 150); });
    await writeFile(join(dir, 'a.ts'), '1\n', 'utf8');
    await waitFor(function () { return calls > 0; }, { timeoutMs: 6000, label: '觸發回呼' });
    assert.equal(log.entries.some(function (entry) { return entry.event === 'watcher.trigger.failed'; }), true);
    // 第二次仍然照常運作：例外沒有殺死防抖計時器。
    await writeFile(join(dir, 'b.ts'), '2\n', 'utf8');
    await waitFor(function () { return calls > 1; }, { timeoutMs: 6000, label: '第二次觸發' });
  } finally {
    await watcher.stop();
  }
});

test('B4：fs.watch 沒回檔名時仍然觸發一次，不再被白名單擋掉', async function (t) {
  const dir = await makeTempDir(t, 'cbm-watch-null-name');
  const triggers = [];
  let listener;
  const watcher = await makeWatcher({
    root: dir,
    debounceMs: 200,
    onTrigger: function (info) { triggers.push(info); },
    // 注入 fs.watch：要驗的是「沒有檔名」這條分支，不是平台的 inotify 行為。
    watch: function (_root, _options, handler) {
      listener = handler;
      return { on: function () {}, close: function () {} };
    },
  });
  try {
    assert.equal(watcher.backend, 'fs.watch');
    listener('change', null);

    // 以前這裡拿 '__unknown__' 去問副檔名白名單：那個字串沒有副檔名，
    // matchesExtensionWhitelist 一律回 false，於是「保守地當成一次觸發」的註解
    // 與行為正好相反——那些平台上的存檔永遠追不上。
    await waitFor(function () { return triggers.length > 0; }, {
      timeoutMs: 5000,
      label: '無檔名事件必須觸發',
    });
    assert.equal(triggers.length, 1);
    assert.equal(triggers[0].count, 1);
    assert.deepEqual(triggers[0].sample, ['__unknown__'], '樣本仍要能顯示這是一次無檔名事件');
    assert.equal(watcher.triggers, 1);

    // 沒有檔名時沒有東西可過濾，這是刻意的；但第二次事件仍照常觸發。
    listener('change', undefined);
    await waitFor(function () { return triggers.length > 1; }, {
      timeoutMs: 5000,
      label: '第二次無檔名事件',
    });
  } finally {
    await watcher.stop();
  }
});

test('C5：生成檔不觸發，手寫的 .d.ts 仍然觸發', async function (t) {
  const dir = await makeTempDir(t, 'cbm-watch-generated');
  const fake = makeFakeChokidar();
  const triggers = [];
  const watcher = await makeWatcher({
    root: dir,
    loadChokidar: fake.load,
    // 白名單放寬到涵蓋所有被測副檔名：這樣擋下來的一定是「生成檔」規則本身，
    // 而不是碰巧被白名單擋掉。
    extensions: ['ts', 'vue', 'dart', 'go', 'cs'],
    onTrigger: function (info) { triggers.push(info); },
  });
  try {
    fake.handlers.all('change', join(dir, 'auto-imports.d.ts'));
    fake.handlers.all('change', join(dir, 'src/components.d.ts'));
    fake.handlers.all('change', join(dir, 'src/api.gen.ts'));
    fake.handlers.all('change', join(dir, 'lib/model.g.dart'));
    fake.handlers.all('change', join(dir, 'proto/svc.pb.go'));
    // 給防抖視窗兩倍時間：若生成檔規則失效，這裡會觀察到觸發。
    await new Promise(function (resolve) { setTimeout(resolve, 700); });
    assert.deepEqual(triggers, [], 'C5：生成檔不得算成「有活動」');
    assert.equal(watcher.triggers, 0);

    // 手寫的型別宣告是原始碼，不能被廣義的 *.d.ts 誤殺。
    fake.handlers.all('change', join(dir, 'src/types/api.d.ts'));
    await waitFor(function () { return triggers.length > 0; }, { timeoutMs: 5000, label: '手寫 .d.ts 觸發' });
    assert.deepEqual(triggers[0].sample, ['src/types/api.d.ts']);
  } finally {
    await watcher.stop();
  }
});
