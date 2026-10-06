/**
 * staleness.js 的單元測試（FR-1／FR-2／FR-3／FR-14 的決策面）。
 *
 * 這一層是純函式，所以測試不需要任何 I/O；每個案例都直接餵值並逐欄比對。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WATCH_GENERATED_PATTERNS, MAX_BEHIND_BY } from '../lib/constants.js';
import {
  buildGraphBase,
  buildGraphUrl,
  canonicalRootPath,
  decideStaleness,
  isDirtyOnlyStale,
  isDirtySettled,
  isExcludedPath,
  isGeneratedPath,
  matchesExtensionWhitelist,
  mergeProjectsByRootPath,
  normalizeBehindBy,
  normalizeSha,
  parseTimestamp,
  pickRebuildMode,
  projectIdentityKey,
} from '../lib/staleness.js';

test('canonicalRootPath 收斂尾斜線、重複斜線與根目錄', function () {
  assert.equal(canonicalRootPath('/home/user/sample-repo/'), '/home/user/sample-repo');
  assert.equal(canonicalRootPath('/home/user/sample-repo///'), '/home/user/sample-repo');
  assert.equal(canonicalRootPath('/home//user///sample-repo'), '/home/user/sample-repo');
  assert.equal(canonicalRootPath('/home/user/sample-repo'), '/home/user/sample-repo');
  // 根目錄只有一個斜線，去尾斜線後不能變成空字串。
  assert.equal(canonicalRootPath('/'), '/');
  assert.equal(canonicalRootPath('///'), '/');
  assert.equal(canonicalRootPath(''), '');
  assert.equal(canonicalRootPath('   '), '');
  assert.equal(canonicalRootPath(undefined), '');
  assert.equal(canonicalRootPath(null), '');
  // 大小寫在 Linux 上有別：不做折疊。
  assert.equal(canonicalRootPath('/Home/Repo'), '/Home/Repo');
});

test('projectIdentityKey 對同一棵樹的兩種寫法給同一個鍵', function () {
  assert.equal(projectIdentityKey('/srv/repo/'), projectIdentityKey('/srv/repo'));
  assert.equal(projectIdentityKey('/srv//repo'), projectIdentityKey('/srv/repo/'));
  assert.notEqual(projectIdentityKey('/srv/repo'), projectIdentityKey('/srv/repo2'));
});

test('mergeProjectsByRootPath 收養新專案', function () {
  const merged = mergeProjectsByRootPath([], [
    { name: 'sample-repo', rootPath: '/home/user/sample-repo/', branch: 'main' },
    { name: 'hyper', rootPath: '/home/user/hyper', branch: 'master' },
  ]);
  assert.equal(merged.projects.length, 2);
  assert.deepEqual(merged.added, ['sample-repo', 'hyper']);
  assert.deepEqual(merged.renamed, []);
  assert.deepEqual(merged.duplicates, []);
  // rootPath 被正規化後才進表。
  assert.equal(merged.projects[0].rootPath, '/home/user/sample-repo');
});

test('mergeProjectsByRootPath：上游改名時沿用既有 name（FR-1 的核心）', function () {
  const existing = [{ name: 'sample-repo', rootPath: '/home/user/sample-repo', branch: 'main' }];
  const merged = mergeProjectsByRootPath(existing, [
    { name: 'home-user-sample-repo', rootPath: '/home/user/sample-repo', branch: 'main' },
  ]);
  assert.equal(merged.projects.length, 1, '同一棵樹不得變成兩筆');
  assert.equal(merged.projects[0].name, 'sample-repo', '既有 name 是權威');
  assert.equal(merged.projects[0].upstreamName, 'home-user-sample-repo');
  assert.deepEqual(merged.added, []);
  assert.deepEqual(merged.renamed, [
    { key: '/home/user/sample-repo', from: 'sample-repo', to: 'home-user-sample-repo' },
  ]);
});

test('mergeProjectsByRootPath：尾斜線等價不產生第二筆（FR-1 驗收條件）', function () {
  const existing = [{ name: 'repo', rootPath: '/srv/repo', branch: 'main' }];
  const merged = mergeProjectsByRootPath(existing, [{ name: 'repo', rootPath: '/srv/repo/' }]);
  assert.equal(merged.projects.length, 1);
  assert.equal(merged.projects[0].rootPath, '/srv/repo');
  assert.deepEqual(merged.added, []);
  assert.deepEqual(merged.renamed, []);
});

test('mergeProjectsByRootPath：上游同一輪回報兩個名字時列入 duplicates', function () {
  const merged = mergeProjectsByRootPath([], [
    { name: 'alpha', rootPath: '/srv/repo', branch: 'main' },
    { name: 'beta', rootPath: '/srv/repo/', branch: 'main' },
  ]);
  assert.equal(merged.projects.length, 1);
  assert.deepEqual(merged.added, ['alpha']);
  assert.equal(merged.duplicates.length, 1);
  assert.deepEqual(merged.duplicates[0].names, ['alpha', 'beta']);
  assert.equal(merged.duplicates[0].key, '/srv/repo');
});

test('mergeProjectsByRootPath：空 rootPath 的專案被略過，branch 缺席時保留舊值', function () {
  const existing = [{ name: 'repo', rootPath: '/srv/repo', branch: 'release' }];
  const merged = mergeProjectsByRootPath(existing, [
    { name: 'nobody', rootPath: '' },
    { name: 'repo', rootPath: '/srv/repo' },
  ]);
  assert.equal(merged.projects.length, 1);
  assert.deepEqual(merged.added, []);
  assert.equal(merged.projects[0].branch, 'release');
});

test('decideStaleness：HEAD 相同即新鮮（confidence=head）', function () {
  const decision = decideStaleness({
    graphHead: '3449ba2',
    liveHead: '3449ba2',
    behindBy: 0,
    dirty: false,
    includeDirty: true,
  });
  assert.equal(decision.stale, false);
  assert.equal(decision.behindBy, 0);
  assert.equal(decision.confidence, 'head');
  assert.deepEqual(decision.reasons, ['head-match']);
});

test('decideStaleness：HEAD 不同即落後並帶 behindBy', function () {
  const decision = decideStaleness({
    graphHead: '3449ba2',
    liveHead: '96cd57b',
    behindBy: 37,
    dirty: false,
    includeDirty: true,
  });
  assert.equal(decision.stale, true);
  assert.equal(decision.behindBy, 37);
  assert.equal(decision.confidence, 'head');
  assert.deepEqual(decision.reasons, ['head-advanced']);
});

test('decideStaleness：dirty 只在 includeDirty 時才算落後（FR-3）', function () {
  const included = decideStaleness({
    graphHead: '3449ba2', liveHead: '3449ba2', dirty: true, includeDirty: true,
  });
  assert.equal(included.stale, true);
  assert.equal(included.behindBy, 0);
  assert.equal(included.confidence, 'head');
  assert.deepEqual(included.reasons, ['head-match-but-dirty']);

  const excluded = decideStaleness({
    graphHead: '3449ba2', liveHead: '3449ba2', dirty: true, includeDirty: false,
  });
  assert.equal(excluded.stale, false);
  assert.deepEqual(excluded.reasons, ['head-match']);
});

test('decideStaleness：圖譜沒有 HEAD 時退回時間旁證並降級 confidence', function () {
  const newer = decideStaleness({
    graphHead: undefined,
    liveHead: '96cd57b',
    indexedAt: '2026-10-02T11:07:52Z',
    headCommittedAt: '2026-10-04T04:03:00Z',
  });
  assert.equal(newer.stale, true);
  assert.equal(newer.behindBy, null, '時間旁證推不出提交數，必須是 null');
  assert.equal(newer.confidence, 'time');
  assert.deepEqual(newer.reasons, ['time-fallback-head-newer']);

  const older = decideStaleness({
    graphHead: undefined,
    liveHead: '96cd57b',
    indexedAt: '2026-10-04T11:07:52Z',
    headCommittedAt: '2026-10-02T04:03:00Z',
  });
  assert.equal(older.stale, false);
  assert.equal(older.confidence, 'time');
  assert.equal(older.behindBy, null);
});

test('decideStaleness：dbMtime 可當第二順位的時間旁證', function () {
  const decision = decideStaleness({
    graphHead: undefined,
    liveHead: '96cd57b',
    dbMtime: '2026-10-01T00:00:00Z',
    headCommittedAt: '2026-10-02T00:00:00Z',
  });
  assert.equal(decision.stale, true);
  assert.equal(decision.confidence, 'time');
});

test('decideStaleness：證據不足時 stale 是 null，不得被當成 false', function () {
  const decision = decideStaleness({});
  assert.equal(decision.stale, null);
  assert.notEqual(decision.stale, false, 'null 不能被壓成 false：呼叫端據此顯示「無法判定」');
  assert.equal(decision.behindBy, null);
  assert.equal(decision.confidence, 'none');
  assert.deepEqual(decision.reasons, ['no-evidence']);

  // 有圖譜 HEAD 但讀不到工作樹 HEAD：同樣是無法判定，不是「新鮮」。
  const halfEvidence = decideStaleness({ graphHead: '3449ba2', liveHead: undefined });
  assert.equal(halfEvidence.stale, null);
  assert.equal(halfEvidence.confidence, 'none');
  assert.deepEqual(halfEvidence.reasons, ['live-head-unavailable']);

  // 只有時間、沒有可解析的時間戳：仍然無法判定。
  const timeOnly = decideStaleness({ indexedAt: 'not-a-date', headCommittedAt: 'also-not-a-date' });
  assert.equal(timeOnly.stale, null);
  assert.equal(timeOnly.confidence, 'none');
});

test('pickRebuildMode：明確請求優先，其次大型專案，再次設定值', function () {
  assert.deepEqual(
    pickRebuildMode({ requested: 'fast', configured: 'full', fileCount: 999999 }),
    { mode: 'fast', reason: 'requested' },
  );
  assert.deepEqual(
    pickRebuildMode({ configured: 'moderate' }),
    { mode: 'moderate', reason: 'configured' },
  );
  // 非法請求不得生效，要落到設定值（不是直接失敗）。
  assert.deepEqual(
    pickRebuildMode({ requested: 'turbo', configured: 'fast' }),
    { mode: 'fast', reason: 'configured' },
  );
  assert.deepEqual(
    pickRebuildMode({ requested: 'turbo', configured: 'nonsense' }),
    { mode: 'full', reason: 'default' },
  );
  // 超過門檻的大型專案即使設定值是 fast 也升級成 full。
  assert.deepEqual(
    pickRebuildMode({ configured: 'fast', fileCount: 10001, largeProjectFileCount: 10000 }),
    { mode: 'full', reason: 'large-project' },
  );
  assert.deepEqual(
    pickRebuildMode({ configured: 'fast', fileCount: 10000, largeProjectFileCount: 10000 }),
    { mode: 'fast', reason: 'configured' },
    '剛好等於門檻不算大型',
  );
});

test('normalizeSha：只接受 7–40 位十六進位並轉小寫', function () {
  assert.equal(normalizeSha('3449BA2'), '3449ba2');
  assert.equal(normalizeSha('  96cd57b\n'), '96cd57b');
  assert.equal(normalizeSha('a'.repeat(40)), 'a'.repeat(40));
  assert.equal(normalizeSha('abc123'), undefined, '6 位太短');
  assert.equal(normalizeSha('a'.repeat(41)), undefined, '41 位太長');
  assert.equal(normalizeSha('zzzzzzz'), undefined, '非十六進位');
  assert.equal(normalizeSha('3449ba2 extra'), undefined);
  assert.equal(normalizeSha(''), undefined);
  assert.equal(normalizeSha(undefined), undefined);
  assert.equal(normalizeSha(1234567), undefined, '非字串一律視為沒有');
});

test('normalizeBehindBy：夾住上限、拒絕負數與非數字', function () {
  assert.equal(normalizeBehindBy(0), 0);
  assert.equal(normalizeBehindBy(37), 37);
  assert.equal(normalizeBehindBy('37'), 37);
  assert.equal(normalizeBehindBy(37.9), 37);
  assert.equal(normalizeBehindBy(-1), null);
  assert.equal(normalizeBehindBy(MAX_BEHIND_BY + 1), MAX_BEHIND_BY);
  assert.equal(normalizeBehindBy('many'), null);
  assert.equal(normalizeBehindBy(Number.NaN), null);
  assert.equal(normalizeBehindBy(Number.POSITIVE_INFINITY), null);
  assert.equal(normalizeBehindBy(undefined), null);
});

test('parseTimestamp：接受 ISO 與 epoch 毫秒，其餘 undefined', function () {
  assert.equal(parseTimestamp('2026-10-03T20:29:29Z'), Date.parse('2026-10-03T20:29:29Z'));
  assert.equal(parseTimestamp(1700000000000), 1700000000000);
  assert.equal(parseTimestamp(''), undefined);
  assert.equal(parseTimestamp('   '), undefined);
  assert.equal(parseTimestamp('yesterday'), undefined);
  assert.equal(parseTimestamp(undefined), undefined);
});

test('matchesExtensionWhitelist：空白名單等於不過濾，否則比對最後一段副檔名', function () {
  assert.equal(matchesExtensionWhitelist('src/app.vue', []), true, '空陣列＝全部納入');
  assert.equal(matchesExtensionWhitelist('src/app.vue', undefined), true);
  assert.equal(matchesExtensionWhitelist('src/app.vue', ['vue']), true);
  assert.equal(matchesExtensionWhitelist('src/app.VUE', ['vue']), true, '比對不分大小寫');
  assert.equal(matchesExtensionWhitelist('src/app.ts', ['vue', 'ts']), true);
  assert.equal(matchesExtensionWhitelist('src/app.css', ['vue', 'ts']), false);
  assert.equal(matchesExtensionWhitelist('src/Makefile', ['vue']), false, '沒有副檔名');
  assert.equal(matchesExtensionWhitelist('src/app.', ['vue']), false, '只有一個尾點不算副檔名');
  // 只看最後一段：tar.gz 的副檔名是 gz。
  assert.equal(matchesExtensionWhitelist('a/b.tar.gz', ['gz']), true);
  assert.equal(matchesExtensionWhitelist('a/b.tar.gz', ['tar']), false);
});

test('isExcludedPath：逐段精確比對目錄名', function () {
  const excludes = ['node_modules', '.git', 'dist'];
  assert.equal(isExcludedPath('node_modules/react/index.js', excludes), true);
  assert.equal(isExcludedPath('packages/app/node_modules/x.js', excludes), true);
  assert.equal(isExcludedPath('dist/main.js', excludes), true);
  assert.equal(isExcludedPath('src/app.js', excludes), false);
  assert.equal(isExcludedPath('src/dist.js', excludes), false, '子字串不算命中');
  assert.equal(isExcludedPath('src/node_modules_extra/x.js', excludes), false);
  assert.equal(isExcludedPath('', excludes), false);
  // 空排除集不排除任何東西。
  assert.equal(isExcludedPath('node_modules/x.js', []), false);
});

test('buildGraphBase：由 ui_port 推導、ui_enabled=false 停用、非法埠不給連結', function () {
  // 正常情形：設定頁的覆寫留空，埠由 CBM 的 ui_port 推導，來源永遠是 loopback。
  const derived = buildGraphBase({ override: '', uiEnabled: 'true', uiPort: '9749' });
  assert.deepEqual(derived, { state: 'ok', base: 'http://127.0.0.1:9749', port: 9749, source: 'config' });
  // 埠留空＝上游的預設值（9749），不是「沒有埠」。
  assert.equal(buildGraphBase({ uiEnabled: 'true' }).port, 9749);
  // 只有明確的 'false' 才算停用——undefined（上游沒回這一項）不該讓連結消失。
  assert.equal(buildGraphBase({ uiEnabled: 'false', uiPort: '9749' }).state, 'disabled');
  assert.equal(buildGraphBase({ uiEnabled: undefined, uiPort: '9749' }).state, 'ok');
  // 非法埠一律不給 base：這個字串會被放進 href，寧可沒有連結。
  assert.equal(buildGraphBase({ uiPort: '0' }).state, 'invalid');
  assert.equal(buildGraphBase({ uiPort: '65536' }).state, 'invalid');
  assert.equal(buildGraphBase({ uiPort: 'abc' }).state, 'invalid');
  assert.equal(buildGraphBase({ uiPort: '80; rm -rf /' }).state, 'invalid');
});

test('buildGraphBase：覆寫只接受 http(s)，並去掉尾斜線但保留子路徑', function () {
  const over = buildGraphBase({ override: ' https://cbm.example.com/graph/ ', uiEnabled: 'false', uiPort: '9749' });
  assert.deepEqual(over, { state: 'ok', base: 'https://cbm.example.com/graph', port: undefined, source: 'override' });
  // 覆寫優先於 ui_enabled=false：使用者明確指到別台機器時，我們不替他判斷那台的開關。
  assert.equal(buildGraphBase({ override: 'http://10.0.0.5:9749', uiEnabled: 'false' }).state, 'ok');
  // 非 http(s) 一律視為非法，不讓 file:// 之類的字串進到 href。
  assert.equal(buildGraphBase({ override: 'file:///etc/passwd' }).state, 'invalid');
  assert.equal(buildGraphBase({ override: 'javascript:alert(1)' }).state, 'invalid');
  assert.equal(buildGraphBase({ override: 'not a url' }).state, 'invalid');
});

test('buildGraphUrl：帶上 tab 與 project，沒有 base 就沒有網址', function () {
  const base = 'http://127.0.0.1:9749';
  assert.equal(buildGraphUrl(base), 'http://127.0.0.1:9749/?tab=graph', '預設分頁是 graph');
  assert.equal(buildGraphUrl(base, { tab: 'stats' }), 'http://127.0.0.1:9749/?tab=stats');
  assert.equal(buildGraphUrl(base, { tab: 'nonsense' }), 'http://127.0.0.1:9749/?tab=graph', '清單外的分頁退回 graph');
  assert.equal(buildGraphUrl(base, { project: 'sample-repo' }), 'http://127.0.0.1:9749/?tab=graph&project=sample-repo');
  // 專案名一律走 URL 編碼，避免名字裡的 & 或 # 把查詢字串截斷。
  assert.equal(
    buildGraphUrl(base, { project: 'a&b#c d' }),
    'http://127.0.0.1:9749/?tab=graph&project=a%26b%23c+d',
  );
  assert.equal(buildGraphUrl(base, { project: '   ' }), 'http://127.0.0.1:9749/?tab=graph', '空專案名不帶參數');
  assert.equal(buildGraphUrl(undefined, { project: 'x' }), undefined);
  assert.equal(buildGraphUrl('', {}), undefined);
});

test('C1：isDirtyOnlyStale 只認「未提交變更」那一種落後', function () {
  assert.equal(isDirtyOnlyStale(['head-match-but-dirty']), true);
  assert.equal(isDirtyOnlyStale([]), false);
  assert.equal(isDirtyOnlyStale(undefined), false);
  assert.equal(isDirtyOnlyStale(['head-match']), false);
  // HEAD 前進是真的落後，必須立即重建，不能被 settle 視窗延後。
  assert.equal(isDirtyOnlyStale(['head-advanced']), false);
  assert.equal(isDirtyOnlyStale(['head-advanced', 'head-match-but-dirty']), false);
  assert.equal(isDirtyOnlyStale(['time-fallback-head-newer']), false);
});

test('C1：isDirtySettled 的三個條件（有活動／已靜默／活動在索引之後）', function () {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const at = function (seconds) { return new Date(now - seconds * 1000).toISOString(); };

  // 沒有任何活動：放著不動的 dirty 專案不值得重跑。
  assert.equal(isDirtySettled({ lastTriggerAt: undefined, lastIndexedAt: undefined, settleMs: 0, now }), false);
  // 有活動、時間可解析、沒有索引紀錄：值得。
  assert.equal(isDirtySettled({ lastTriggerAt: at(60), lastIndexedAt: undefined, settleMs: 0, now }), true);
  // settleMs＝0 退化成現行行為：只要有活動就算（不看靜默時間）。
  assert.equal(isDirtySettled({ lastTriggerAt: at(0), lastIndexedAt: undefined, settleMs: 0, now }), true);
  // 靜默視窗還沒到：不排。
  assert.equal(isDirtySettled({ lastTriggerAt: at(5), lastIndexedAt: undefined, settleMs: 30000, now }), false);
  // 剛好到期：排（邊界值算已靜默）。
  assert.equal(isDirtySettled({ lastTriggerAt: at(30), lastIndexedAt: undefined, settleMs: 30000, now }), true);
  // 活動在最後一次索引之前：那次活動早就被索引涵蓋了，不必重跑。
  assert.equal(isDirtySettled({
    lastTriggerAt: at(120),
    lastIndexedAt: at(60),
    settleMs: 0,
    now,
  }), false);
  // 活動在索引之後：值得。
  assert.equal(isDirtySettled({
    lastTriggerAt: at(10),
    lastIndexedAt: at(600),
    settleMs: 0,
    now,
  }), true);
  // 時間戳無法解析＝沒有可用證據，不得當成「已靜默」。
  assert.equal(isDirtySettled({ lastTriggerAt: 'not-a-time', lastIndexedAt: undefined, settleMs: 0, now }), false);
  // 非法的 settleMs 視為 0（不因為壞設定就把重建全鎖住）。
  assert.equal(isDirtySettled({ lastTriggerAt: at(1), lastIndexedAt: undefined, settleMs: Number.NaN, now }), true);
});

test('C5：isGeneratedPath 只殺生成檔，手寫的 .d.ts 不受影響', function () {
  const patterns = DEFAULT_WATCH_GENERATED_PATTERNS;
  assert.equal(patterns.includes('auto-imports.d.ts'), true);
  assert.equal(patterns.includes('components.d.ts'), true);
  assert.equal(patterns.includes('*.d.ts'), false, '不可用廣義 .d.ts：手寫型別宣告是原始碼');

  assert.equal(isGeneratedPath('auto-imports.d.ts', patterns), true);
  assert.equal(isGeneratedPath('src/auto-imports.d.ts', patterns), true);
  assert.equal(isGeneratedPath('src/components.d.ts', patterns), true);
  assert.equal(isGeneratedPath('src/api.gen.ts', patterns), true);
  assert.equal(isGeneratedPath('lib/model.g.dart', patterns), true);
  assert.equal(isGeneratedPath('proto/svc.pb.go', patterns), true);
  assert.equal(isGeneratedPath('ui/Form.designer.cs', patterns), true);

  // 手寫的檔案一律不得被誤殺。
  assert.equal(isGeneratedPath('src/types/api.d.ts', patterns), false);
  assert.equal(isGeneratedPath('src/app.ts', patterns), false);
  assert.equal(isGeneratedPath('src/gen.ts', patterns), false, 'gen 不是 *.gen.* 的形狀');
  assert.equal(isGeneratedPath('src/generator.ts', patterns), false);
  assert.equal(isGeneratedPath('', patterns), false);
  assert.equal(isGeneratedPath('src/app.ts', []), false);
  // 只比對檔名：目錄名裡出現關鍵字不算。
  assert.equal(isGeneratedPath('auto-imports.d.ts.bak/app.ts', patterns), false);
});
