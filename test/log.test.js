/**
 * log.js 的測試（NFR-4：日誌落檔不得無界成長）。
 *
 * 這裡刻意檢查磁碟上的位元組，而不是只信記憶體：輪替的價值在於「舊檔還在、
 * 新檔接續」，所以 `.1` 的內容、新檔的行數、以及不該出現的 `.2` 都要驗。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KeeperLog } from '../lib/log.js';
import { LOG_MAX_FILE_BYTES } from '../lib/constants.js';
import { makeTempDir } from './helpers/env.js';

/** 一行單字元事件名的 info 日誌：ISO 時間戳 24 + ' level=info msg=' 16 + 事件名 1 + 換行 1。 */
const LINE_BYTES = 42;

/**
 * 建立一個指向暫存目錄的 KeeperLog 並開好檔。
 * @param {string} dir - 暫存目錄。
 * @param {object} [options] - 覆寫的建構選項。
 * @returns {Promise<{log: KeeperLog, file: string, rotated: string}>} 日誌器與現行檔／歷史檔路徑。
 */
async function makeLog(dir, options) {
  const file = join(dir, 'keeper.log');
  const log = new KeeperLog(Object.assign({ file, maxEntries: 100, minLevel: 'info' }, options ?? {}));
  await log.open();
  return { log, file, rotated: file + '.1' };
}

/**
 * 抽出每個日誌行的事件名（`msg=` 後的第一段）。
 * @param {string} text - 檔案內容。
 * @returns {string[]} 事件名陣列，依行序。
 */
function lineEvents(text) {
  return text.split('\n')
    .filter(function (line) { return line.length > 0; })
    .map(function (line) {
      const matched = /msg=(\S+)/.exec(line);
      assert.notEqual(matched, null, '日誌行必須帶 msg= 欄位：' + line);
      return matched[1];
    });
}

test('KeeperLog：超過 maxFileBytes 時輪替，.1 留舊行、新檔只含後續行', async function (t) {
  const dir = await makeTempDir(t, 'log');
  const made = await makeLog(dir, { maxFileBytes: LINE_BYTES * 2 + 10 });

  made.log.info('a');
  made.log.info('b');
  made.log.info('c');
  await made.log.flush();

  assert.deepEqual(lineEvents(await readFile(made.rotated, 'utf8')), ['a', 'b'], '歷史檔保存輪替前的兩行');
  assert.deepEqual(lineEvents(await readFile(made.file, 'utf8')), ['c'], '新檔從輪替後的那一行重新開始');
  assert.equal((await stat(made.file)).size <= LINE_BYTES * 2 + 10, true, '新檔不得超過上限');
});

test('KeeperLog：再次輪替會覆蓋 .1，不產生 .2', async function (t) {
  const dir = await makeTempDir(t, 'log');
  const limit = LINE_BYTES * 2 + 10;
  const made = await makeLog(dir, { maxFileBytes: limit });

  made.log.info('a');
  made.log.info('b');
  made.log.info('c');
  made.log.info('d');
  made.log.info('e');
  await made.log.flush();

  assert.deepEqual(lineEvents(await readFile(made.rotated, 'utf8')), ['c', 'd'], '.1 被後一輪覆蓋');
  assert.deepEqual(lineEvents(await readFile(made.file, 'utf8')), ['e'], '現行檔只有最後一行');
  assert.deepEqual((await readdir(dir)).sort(), ['keeper.log', 'keeper.log.1'], '只保留一份歷史檔');
});

test('KeeperLog：maxFileBytes 很大時完全不輪替', async function (t) {
  const dir = await makeTempDir(t, 'log');
  assert.equal(LOG_MAX_FILE_BYTES, 5 * 1024 * 1024, '預設上限為 5 MiB');
  const made = await makeLog(dir, { maxFileBytes: LOG_MAX_FILE_BYTES });

  for (let index = 0; index < 5; index += 1) made.log.info('e' + index);
  await made.log.flush();

  assert.deepEqual(lineEvents(await readFile(made.file, 'utf8')), ['e0', 'e1', 'e2', 'e3', 'e4']);
  await assert.rejects(readFile(made.rotated, 'utf8'), { code: 'ENOENT' }, '不該出現歷史檔');
});

test('KeeperLog：flush() 之後檔案內容與記憶體條目一致', async function (t) {
  const dir = await makeTempDir(t, 'log');
  const made = await makeLog(dir, { maxFileBytes: LOG_MAX_FILE_BYTES });

  made.log.debug('skipped');
  made.log.info('one', { k: 'v' });
  made.log.warn('two');
  made.log.error('boom', { exitCode: 3 });
  await made.log.flush();

  const lines = (await readFile(made.file, 'utf8')).split('\n').filter(function (line) { return line.length > 0; });
  const entries = made.log.recent(100);
  assert.equal(entries.length, 3, 'debug 低於 minLevel，不進記憶體也不落檔');
  assert.equal(lines.length, entries.length, '落檔行數等於記憶體條目數');
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    assert.equal(
      lines[index].startsWith(entry.at + ' level=' + entry.level + ' msg=' + entry.event),
      true,
      '第 ' + index + ' 行的時間戳／等級／事件名必須與記憶體一致：' + lines[index],
    );
  }
});

test('KeeperLog：open() 以既有檔案大小為基準，不從零起算', async function (t) {
  const dir = await makeTempDir(t, 'log');
  const file = join(dir, 'keeper.log');
  const limit = 100;
  const preexisting = 'x'.repeat(limit - 10);
  await writeFile(file, preexisting, 'utf8');

  const log = new KeeperLog({ file, maxEntries: 100, minLevel: 'info', maxFileBytes: limit });
  await log.open();
  log.info('a');
  await log.flush();

  assert.equal(await readFile(file + '.1', 'utf8'), preexisting, '既有內容必須被輪替到 .1');
  assert.deepEqual(lineEvents(await readFile(file, 'utf8')), ['a']);
});

test('KeeperLog：輪替失敗時吞掉錯誤、記進 fileError，本行仍寫入原檔', async function (t) {
  const dir = await makeTempDir(t, 'log');
  const made = await makeLog(dir, { maxFileBytes: LINE_BYTES * 2 + 10 });
  // 讓 rename 的目標成為非空目錄：rename(檔案, 目錄) 必失敗（EISDIR）。
  await mkdir(join(made.rotated, 'blocker'), { recursive: true });

  made.log.info('a');
  made.log.info('b');
  made.log.info('c');
  await made.log.flush();

  assert.equal(typeof made.log.fileError, 'string');
  assert.equal(made.log.fileError.length > 0, true, '輪替失敗必須留下訊息');
  assert.deepEqual(lineEvents(await readFile(made.file, 'utf8')), ['a', 'b', 'c'], '輪替失敗不得吃掉任何一行');
  assert.equal(made.log.recent(10).length, 3, '記憶體日誌不受影響');
});

test('KeeperLog：單行就超過上限時不輪替空檔、日誌不壞', async function (t) {
  const dir = await makeTempDir(t, 'log');
  const made = await makeLog(dir, { maxFileBytes: 10 });

  made.log.info('a');
  await made.log.flush();

  assert.equal(made.log.fileError, undefined, '沒有東西可輪替時不得當成錯誤');
  assert.deepEqual(lineEvents(await readFile(made.file, 'utf8')), ['a']);
  await assert.rejects(readFile(made.rotated, 'utf8'), { code: 'ENOENT' });
});

test('KeeperLog：file 未給時只留記憶體，不碰磁碟', async function (t) {
  const dir = await makeTempDir(t, 'log');
  const log = new KeeperLog({ maxEntries: 100, minLevel: 'info', maxFileBytes: 10 });
  await log.open();
  log.info('a');
  await log.flush();

  assert.deepEqual(await readdir(dir), [], '記憶體模式不得產生任何檔案');
  assert.equal(log.recent(10).length, 1);
  assert.equal(log.fileError, undefined);
});

test('KeeperLog：open() 建目錄失敗不致命，只記 fileError', async function (t) {
  const dir = await makeTempDir(t, 'log');
  const blocker = join(dir, 'blocker');
  await writeFile(blocker, 'not a dir', 'utf8');

  const log = new KeeperLog({
    file: join(blocker, 'keeper.log'),
    maxEntries: 100,
    minLevel: 'info',
    maxFileBytes: 100,
  });
  await log.open();
  log.info('a');
  await log.flush();

  assert.equal(log.ready, true);
  assert.equal(typeof log.fileError, 'string');
  assert.equal(log.recent(10).length, 1, '記憶體日誌照常');
});
