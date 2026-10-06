/**
 * 對外 API 表面的守門測試（D7）。
 *
 * D7 清掉的是一批死碼——沒有人引用的匯出。刪除本身在語言層不會有編譯器幫忙
 * 記住，所以用一條最小的測試把「這些東西確實不在」寫下來：它們若被誰悄悄加
 * 回來（連同那份維護成本），這裡會紅。
 *
 * 這些符號都已確認在 lib/、tools/、test/ 全域沒有任何引用：
 *   - constants.PLUGIN_NAME／SETTINGS_SECTION_ID：識別碼一律走 PLUGIN_ID 與 API_PREFIX。
 *   - git.isGitWorktree／__gitInternals：沒有任何地方需要「是不是工作樹」的判斷，
 *     也沒有人替換內部 git 執行器（git 探針都以 deps 注入）。
 *   - state.removeProject：狀態是 append-only 的意圖紀錄，沒有任何呼叫端。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as constants from '../lib/constants.js';
import * as git from '../lib/git.js';
import { KeeperState } from '../lib/state.js';

test('D7：已清除的死碼不得悄悄回來', function () {
  assert.equal('PLUGIN_NAME' in constants, false);
  assert.equal('SETTINGS_SECTION_ID' in constants, false);
  // 還在用的識別碼必須留著。
  assert.equal(constants.PLUGIN_ID, 'codebase-watcher');
  assert.equal(constants.API_PREFIX, '/api/codebase-watcher');

  assert.equal('isGitWorktree' in git, false);
  assert.equal('__gitInternals' in git, false);
  assert.equal(typeof git.readLiveHead, 'function');
  assert.equal(typeof git.isWorktreeDirty, 'function');

  assert.equal(typeof KeeperState.prototype.removeProject, 'undefined');
  assert.equal(typeof KeeperState.prototype.setProject, 'function');
});
