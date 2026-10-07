/**
 * dsh-codebase-watcher — 瀏覽器半邊（設定頁觀測卡片）。
 *
 * 掛在 `settings.section` 上（設定 →「CBM 圖譜」），顯示每個已索引專案的
 * graph_head／live_head／behind_by／watcher 狀態／lastError，並提供手動操作。
 * 所有資料都來自 Host 半邊的 `/api/codebase-watcher/*`，因此卡片與 curl 逐值一致
 * （FR-8/FR-9/FR-12）。
 *
 * 這是一支手寫的動態 Client 模組：`dsh.client` 只宣告 platform 與資訊性的
 * inject 邊，實際載入走模組表的 lazy factory。樣式只用主題 token
 * （`--dsw-alias-*`），不引入任何 Harness Client 套件，也不碰 DOM 之外的世界。
 *
 * 輪詢成本：日誌面板收起時只抓 `log=0`（比抓 120 筆少一個數量級），頁面切到背景
 * 時整個停掉，連續失敗則指數退避到 30 秒。Host 半邊若還是舊世代（沒有
 * `enabled`／`orphaned`／`cliError`／`running.startedAt` 等欄位），卡片照常成立。
 */

window.__ModuleLoader__.load({
  id: 'dsh-codebase-watcher',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 本地化命名空間。 */
    const NS = 'codebase-watcher';

    /** 正常輪詢間隔（毫秒）。 */
    const POLL_MS = 3000;
    /** 連續失敗時的輪詢上限（毫秒）：指數退避的終點。 */
    const POLL_MAX_MS = 30000;
    /** 日誌面板展開時，一次抓幾筆事件。 */
    const LOG_LINES = 120;
    /** 常駐指示的輪詢間隔（毫秒）：常駐元件不能像卡片那樣每 3 秒打一次。 */
    const BADGE_POLL_MS = 30000;
    /** 常駐指示連續失敗時的輪詢上限（毫秒）。 */
    const BADGE_POLL_MAX_MS = 300000;

    /** 這支卡片的字典。鍵名與 zh 完全對齊。 */
    const zh = {
      'section.label': 'CBM 圖譜',
      'panel.title': 'Codebase Memory 圖譜新鮮度',
      'panel.subtitle': '每個已索引專案的圖譜 HEAD 與工作樹 HEAD 逐項比對；判定為落後才會重建。',
      'action.check': '立即檢查',
      'action.rebuildStale': '重建所有落後',
      'action.rebuildAll': '全部強制重建',
      'action.cancel': '取消重建',
      'action.more': '更多操作',
      'action.confirm': '確定',
      'action.cancelConfirm': '取消',
      'action.pauseAll': '暫停全部監看',
      'action.resumeAll': '恢復全部監看',
      'action.rebuild': '重建',
      'action.forceRebuild': '強制重建',
      'action.pause': '暫停監看',
      'action.resume': '恢復監看',
      'action.refresh': '重新載入',
      'action.showLog': '顯示日誌',
      'action.hideLog': '收起日誌',
      'action.openGraph': '開啟圖譜',
      'action.openProjectGraph': '圖譜',
      'action.details': '詳細',
      'action.copy': '複製',
      'action.copied': '已複製',
      'action.copyFailed': '無法存取剪貼簿，請手動選取複製',
      'hint.rebuildAll': '不管圖譜是否落後，對所有已納管專案重跑一次索引。',
      'hint.cancel': '中止目前正在跑的重建；被中止的專案會在下一次啟動時重新排入。',
      'hint.pauseAll': '暫停所有專案的檔案監看；圖譜不會再因為存檔而自動重建。',
      'hint.forceRebuild': '圖譜 HEAD 與工作樹一致；這會強制重跑一次索引。',
      'hint.orphaned': 'CBM 圖譜裡已經找不到這個專案；請重新索引，或把它移出納管清單。',
      'graph.hint': '在 CBM 的圖譜 UI 開啟',
      'graph.disabled': 'CBM 圖譜 UI 未啟用：執行 codebase-memory-mcp --ui=true',
      'graph.invalid': '圖譜 UI 網址無法解析',
      'graph.unreachable': '圖譜 UI 未回應',
      'state.loading': '載入中…',
      'state.working': '執行中…',
      'state.loadFailed': '載入失敗',
      'state.empty': '目前沒有任何已索引的專案。先在 CBM 索引一個專案，下一輪掃描會自動納管。',
      'state.emptyFiltered': '沒有符合這個條件的專案。',
      'state.stale': '落後',
      'state.fresh': '已同步',
      'state.unknown': '無法判定',
      'state.running': '重建中',
      'state.queued': '排隊中',
      'state.idle': '閒置',
      'state.watching': '監看中',
      'state.paused': '監看已暫停',
      'state.stopped': '已停止',
      'state.failed': '失敗',
      'state.orphaned': '已不在圖譜',
      'notice.offline': '已離線，顯示的是最後一次成功取得的資料',
      'notice.disabled': '自動化已停用：不會自動掃描或重建；下方的手動操作仍可用。',
      'notice.autoRebuildOff': '自動重建已關閉：偵測到落後也不會自己重建，仍可手動觸發。',
      'label.cli': 'CLI',
      'label.cliSource': '來源',
      'label.cliError': 'CLI 問題',
      'label.cliCandidates': '已嘗試的路徑',
      'label.version': '版本',
      'label.command': '診斷指令',
      'label.unresolved': '（未解析）',
      'label.lastScan': '上次掃描',
      'label.dataAt': '資料時間',
      'label.queue': '佇列',
      'label.watching': '監看中',
      'label.root': '根目錄',
      'label.branch': '分支',
      'label.graphHead': '圖譜 HEAD',
      'label.liveHead': '工作樹 HEAD',
      'label.behindBy': '落後提交',
      'label.indexedAt': '索引時點',
      'label.lastIndexedAt': '上次重建',
      'label.lastDuration': '上次耗時',
      'label.watcher': '監看',
      'label.watcherBackend': '監看方式',
      'label.triggers': '觸發次數',
      'label.nodes': '節點',
      'label.edges': '邊',
      'label.parsePartial': '局部解析',
      'label.notIndexed': '未入圖檔',
      'label.confidence': '判據',
      'label.reasons': '判定依據',
      'label.lastError': '上次錯誤',
      'label.lastRefreshError': '上次掃描失敗',
      'label.watcherError': '監看失敗',
      'label.actionError': '動作失敗',
      'badge.label': 'CBM 圖譜',
      'badge.stale': '個專案落後',
      'badge.failed': '個專案失敗',
      'badge.scanFailed': '上次掃描失敗',
      'warning.cli-missing': '找不到 codebase-memory-mcp 執行檔。已依序嘗試設定值、CBM_BIN 環境變數、PATH 與平台常見路徑；請在設定頁填入絕對路徑，或設定 CBM_BIN。',
      'warning.version-unexpected': 'codebase-memory-mcp 版本 {version} 不在實測支援清單內；輸出格式若改變，落後判定可能降級為時間旁證。',
      'warning.auto-index-on': 'CBM 內建的 auto_index 目前是 true：每個 session 都會無條件全量重建，會與本插件重複勞動。建議執行 `codebase-memory-mcp config set auto_index false`。',
      'warning.upstream-watcher-on': 'CBM 內建的 watcher（auto_watch／watcher_enabled）仍是 true；實測它不會產生可觀測的重建，但留著沒有壞處，僅供知情。',
      'warning.upstream-config-unreadable': '讀不到 CBM 設定（{error}）：圖譜 UI 的位置只能改用預設埠推導，下面的連結不保證正確。',
      'warning.dirty-chase-detected': '偵測到圖譜重建正在跟你的編輯賽跑：最近 24 小時內有 {aborted} 次重建在途中被中止（佔 {completed} 次已完成嘗試的 {percent}%）——重建跑到一半檔案又變，那一輪就白跑了，圖譜也沒有前進。實測把設定頁的 dirtySettleSeconds 設成 90（未提交變更的專案靜默 90 秒才重建）可以消除這個現象（A/B：編輯期間的重建 10 次 → 0 次、被中止 10 次 → 0 次，停手後圖譜仍追上）；設 0 則維持現行行為（一有活動就重建）。要不要改、改成幾秒，由你決定。',
      'caveat.route-file-path-empty': '圖譜的 Route 節點 file_path 全為空、且多為非產品路由（CDP 端點、i18n 鍵），不可作為證據引用。',
      'caveat.layers-unreliable': 'layers 宣告（例如「src = api」）與事實不符時有發生；引用前請以原始碼為準。',
      'caveat.parse-partial': 'parse_partial 清單中的檔案有解析缺口，這些範圍的節點可能缺席，引用時得回到 grep。',
      'caveat.gitignored-not-indexed': 'gitignore 內的路徑不會進圖譜；需要那些檔案的工作必須直接讀檔。',
      'label.statsRebuilds': '重建',
      'label.statsSaved': '省下的重建',
      'label.statsChecks': '省下的完整檢查',
      'label.statsRebuildMs': '累計重建耗時',
      'stats.heading': '成效（本次啟動以來，自 {time}）',
      'stats.headingNoTime': '成效（本次啟動以來）',
      'stats.rebuildLine': '排入 {queued} · 成功 {succeeded} · 失敗 {failed}',
      'stats.abortedSuffix': '（其中 {aborted} 次被中止）',
      'stats.savedLine': '冷卻跳過 {cooldown} · 閘門跳過 {gate} · settle 延後 {deferred}',
      'unit.time.one': '次',
      'unit.time.many': '次',
      'unit.hour.one': '小時',
      'unit.hour.many': '小時',
      'label.config': '設定',
      'action.showConfig': '顯示設定',
      'action.hideConfig': '收起設定',
      'action.resetAll': '全部恢復預設',
      'action.resetOne': '恢復預設',
      'confirm.resetAll': '確定要把所有改過的欄位恢復成預設值？',
      'config.hint': '列出可寫欄位與預設值。要改值請到側邊欄「插件」→ 本插件那一列的設定，那裡由 DSH 依 schema 自動產生表單；本卡片不重做編輯器。',
      'config.hintReset': '恢復預設只會把你改過的欄位改回預設值，不動其他設定。',
      'config.allDefaults': '（預設）',
      'config.overriddenCount': '你改過 {count} 個欄位',
      'config.defaultValue': '預設值',
      'value.empty': '（空）',
      'value.emptyList': '（空清單）',
      'feedback.configResetOne': '已恢復 {field} 的預設值',
      'feedback.configResetAll': '已恢復 {count} 個欄位的預設值',
      'feedback.configUnknown': '有欄位沒被接受：{fields}',
      'label.checkError': '檢查時的問題',
      'label.warnings': '警告',
      'label.dirty': '工作樹有未提交變更',
      'label.caveats': '判讀注意：不可作為證據的圖譜宣告',
      'label.log': '最近事件',
      'log.empty': '目前沒有事件。',
      'label.health': 'CLI 與上游',
      'label.upstreamConfig': '上游設定',
      'label.logFileError': '日誌檔問題',
      'label.stateLoadError': '狀態檔讀取問題',
      'label.upstreamConfigError': '上游設定讀取問題',
      'label.automation': '自動化',
      'label.filter': '專案篩選',
      'summary.project.one': '專案',
      'summary.project.many': '專案',
      'summary.stale': '落後',
      'summary.unknown': '無法判定',
      'summary.orphaned': '已不在圖譜',
      'summary.runningFor': '已跑',
      'automation.on': '開',
      'automation.off': '已停用',
      'automation.rebuildOff': '自動重建關閉',
      'filter.all': '全部',
      'filter.stale': '落後',
      'filter.unknown': '無法判定',
      'filter.watcherFailed': '監看失敗',
      'feedback.checkAll': '已重新檢查專案',
      'feedback.checkOne': '已重新檢查這個專案',
      'feedback.queued': '已排入',
      'feedback.queuedNone': '沒有需要重建的專案',
      'feedback.cancelled': '已送出中止訊號',
      'feedback.cancelNone': '目前沒有正在跑的重建',
      'feedback.paused': '已暫停監看',
      'feedback.resumed': '已恢復監看',
      'feedback.none': '沒有需要變更的目標',
      'feedback.done': '已完成',
      'confirm.rebuildAll': '確定要對所有專案強制重建？',
      'confirm.cancel': '確定要中止正在跑的重建？',
      'confirm.pauseAll': '確定要暫停所有監看？',
      'confirm.forceRebuild': '圖譜與工作樹一致，仍要強制重建？',
      'error.notJson': '回應不是合法 JSON',
      'confidence.head': 'HEAD 比對',
      'confidence.time': '時間旁證',
      'confidence.none': '無',
      'reason.head-match': '圖譜與工作樹 HEAD 一致',
      'reason.head-match-but-dirty': 'HEAD 一致，但工作樹有未提交變更（依設定計為落後）',
      'reason.head-advanced': '圖譜落後工作樹',
      'reason.live-head-unavailable': '讀不到工作樹 HEAD',
      'reason.time-fallback-head-newer': '圖譜沒有 Branch 節點，改用時間旁證：疑似落後',
      'reason.time-fallback-head-older': '圖譜沒有 Branch 節點，改用時間旁證：看起來一致',
      'reason.no-evidence': '證據不足，無法判定',
      'unit.second.one': '秒',
      'unit.second.many': '秒',
      'unit.minute.one': '分',
      'unit.minute.many': '分',
      'unit.commit.one': '個提交',
      'unit.commit.many': '個提交',
      'unit.file.one': '檔',
      'unit.file.many': '檔',
      'unit.rebuild.one': '個重建',
      'unit.rebuild.many': '個重建',
      'unit.watcher.one': '個監看',
      'unit.watcher.many': '個監看',
      'time.secondsAgo': '秒前',
      'time.minutesAgo': '分鐘前',
      'time.hoursAgo': '小時前',
      'time.daysAgo': '天前',
    };

    /** 英文對照。 */
    const en = {
      'section.label': 'CBM Graph',
      'panel.title': 'Codebase Memory graph freshness',
      'panel.subtitle': 'Compares each indexed project\u2019s graph HEAD against its worktree HEAD and rebuilds only what is judged stale.',
      'action.check': 'Check now',
      'action.rebuildStale': 'Rebuild stale',
      'action.rebuildAll': 'Force rebuild all',
      'action.cancel': 'Cancel rebuild',
      'action.more': 'More actions',
      'action.confirm': 'Confirm',
      'action.cancelConfirm': 'Dismiss',
      'action.pauseAll': 'Pause all watchers',
      'action.resumeAll': 'Resume all watchers',
      'action.rebuild': 'Rebuild',
      'action.forceRebuild': 'Force rebuild',
      'action.pause': 'Pause watcher',
      'action.resume': 'Resume watcher',
      'action.refresh': 'Reload',
      'action.showLog': 'Show log',
      'action.hideLog': 'Hide log',
      'action.openGraph': 'Open graph',
      'action.openProjectGraph': 'Graph',
      'action.details': 'Details',
      'action.copy': 'Copy',
      'action.copied': 'Copied',
      'action.copyFailed': 'Clipboard unavailable — select the text and copy manually',
      'hint.rebuildAll': 'Re-index every tracked project regardless of staleness.',
      'hint.cancel': 'Abort the running rebuild; the project is re-queued on the next start.',
      'hint.pauseAll': 'Stop watching files for every project; saving a file will no longer trigger a rebuild.',
      'hint.forceRebuild': 'The graph HEAD already matches the worktree; this re-indexes anyway.',
      'hint.orphaned': 'This project is no longer in the CBM graph; re-index it or drop it from tracking.',
      'graph.hint': 'Open in the CBM graph UI',
      'graph.disabled': 'CBM graph UI is off: run codebase-memory-mcp --ui=true',
      'graph.invalid': 'Graph UI URL cannot be resolved',
      'graph.unreachable': 'Graph UI is not responding',
      'state.loading': 'Loading…',
      'state.working': 'working…',
      'state.loadFailed': 'Load failed',
      'state.empty': 'No indexed projects yet. Index one with CBM and the next scan adopts it automatically.',
      'state.emptyFiltered': 'No project matches this filter.',
      'state.stale': 'Stale',
      'state.fresh': 'Up to date',
      'state.unknown': 'Undetermined',
      'state.running': 'Rebuilding',
      'state.queued': 'Queued',
      'state.idle': 'Idle',
      'state.watching': 'Watching',
      'state.paused': 'Watcher paused',
      'state.stopped': 'Stopped',
      'state.failed': 'Failed',
      'state.orphaned': 'Not in graph',
      'notice.offline': 'Offline — showing the last successful snapshot',
      'notice.disabled': 'Automation is disabled: no automatic scan or rebuild. Manual actions below still work.',
      'notice.autoRebuildOff': 'Automatic rebuild is off: staleness is detected but nothing rebuilds on its own.',
      'label.cli': 'CLI',
      'label.cliSource': 'Source',
      'label.cliError': 'CLI problem',
      'label.cliCandidates': 'Paths tried',
      'label.version': 'Version',
      'label.command': 'Diagnostic command',
      'label.unresolved': '(unresolved)',
      'label.lastScan': 'Last scan',
      'label.dataAt': 'Data as of',
      'label.queue': 'Queue',
      'label.watching': 'Watching',
      'label.root': 'Root',
      'label.branch': 'Branch',
      'label.graphHead': 'Graph HEAD',
      'label.liveHead': 'Worktree HEAD',
      'label.behindBy': 'Behind by',
      'label.indexedAt': 'Indexed at',
      'label.lastIndexedAt': 'Last rebuild',
      'label.lastDuration': 'Last duration',
      'label.watcher': 'Watcher',
      'label.watcherBackend': 'Watch backend',
      'label.triggers': 'Triggers',
      'label.nodes': 'Nodes',
      'label.edges': 'Edges',
      'label.parsePartial': 'Partial parses',
      'label.notIndexed': 'Not indexed',
      'label.confidence': 'Evidence',
      'label.reasons': 'Why',
      'label.lastError': 'Last error',
      'label.lastRefreshError': 'Last scan failed',
      'label.watcherError': 'Watcher failed',
      'label.actionError': 'Action failed',
      'badge.label': 'CBM graph',
      'badge.stale': 'stale',
      'badge.failed': 'failed',
      'badge.scanFailed': 'last scan failed',
      'warning.cli-missing': 'The codebase-memory-mcp executable was not found. Tried the configured value, the CBM_BIN environment variable, PATH and the usual platform paths in order; put an absolute path in the settings page or set CBM_BIN.',
      'warning.version-unexpected': 'codebase-memory-mcp version {version} is outside the tested support list; if its output format changes, staleness detection may fall back to time-based evidence.',
      'warning.auto-index-on': 'The built-in CBM auto_index is true: every session re-indexes everything unconditionally, duplicating this plugin. Run `codebase-memory-mcp config set auto_index false`.',
      'warning.upstream-watcher-on': 'The built-in CBM watcher (auto_watch / watcher_enabled) is still true. Measured: it produces no observable rebuilds, so leaving it on does no harm — stated for information only.',
      'warning.upstream-config-unreadable': 'CBM settings could not be read ({error}): the graph UI location is inferred from the default port, so the link below is not guaranteed to be correct.',
      'warning.dirty-chase-detected': 'Graph rebuilds are racing your editor: {aborted} rebuilds were aborted mid-flight in the last 24 hours ({percent}% of {completed} completed attempts) — files changed while the rebuild was running, so that round was wasted and the graph did not move forward. Measured: setting dirtySettleSeconds to 90 in the settings page (wait for 90 quiet seconds on projects with uncommitted changes) removes this (A/B: rebuilds while editing 10 → 0, aborts 10 → 0, and the graph still catches up once you stop). Leaving it at 0 keeps the current behaviour (rebuild on any activity). Whether to change it, and to what, is your call.',
      'caveat.route-file-path-empty': 'Route nodes in the graph all have an empty file_path, and most of them are not product routes (CDP endpoints, i18n keys); do not cite them as evidence.',
      'caveat.layers-unreliable': 'The layers declaration (for example "src = api") has been seen to contradict the code; check the source before relying on it.',
      'caveat.parse-partial': 'Files listed in parse_partial have parsing gaps, so nodes in those areas may be missing; fall back to grep for them.',
      'caveat.gitignored-not-indexed': 'Paths covered by gitignore never enter the graph; work that needs those files must read them directly.',
      'label.statsRebuilds': 'Rebuilds',
      'label.statsSaved': 'Rebuilds saved',
      'label.statsChecks': 'Full checks saved',
      'label.statsRebuildMs': 'Total rebuild time',
      'stats.heading': 'Impact (since this start, from {time})',
      'stats.headingNoTime': 'Impact (since this start)',
      'stats.rebuildLine': 'queued {queued} · succeeded {succeeded} · failed {failed}',
      'stats.abortedSuffix': '({aborted} aborted mid-rebuild)',
      'stats.savedLine': 'cooldown {cooldown} · gate {gate} · settle deferred {deferred}',
      'unit.time.one': 'time',
      'unit.time.many': 'times',
      'unit.hour.one': 'h',
      'unit.hour.many': 'h',
      'label.config': 'Settings',
      'action.showConfig': 'Show settings',
      'action.hideConfig': 'Hide settings',
      'action.resetAll': 'Reset all to defaults',
      'action.resetOne': 'Reset',
      'confirm.resetAll': 'Reset every changed field back to its default?',
      'config.hint': 'Writable fields and their defaults. To change a value, open the settings control on this plugin\u2019s row under Plugins in the sidebar \u2014 DSH generates that form from the schema, and this card does not duplicate it.',
      'config.hintReset': 'Restoring only puts the fields you changed back to their default values; nothing else is touched.',
      'config.allDefaults': '(default)',
      'config.overriddenCount': '{count} fields changed',
      'config.defaultValue': 'default',
      'value.empty': '(empty)',
      'value.emptyList': '(empty list)',
      'feedback.configResetOne': 'Reset {field} to its default',
      'feedback.configResetAll': 'Reset {count} fields to their defaults',
      'feedback.configUnknown': 'Not accepted: {fields}',
      'label.checkError': 'Check problem',
      'label.warnings': 'Warnings',
      'label.dirty': 'Uncommitted worktree changes',
      'label.caveats': 'Read with care: graph declarations not usable as evidence',
      'label.log': 'Recent events',
      'log.empty': 'No events yet.',
      'label.health': 'CLI & upstream',
      'label.upstreamConfig': 'Upstream settings',
      'label.logFileError': 'Log file problem',
      'label.stateLoadError': 'State file problem',
      'label.upstreamConfigError': 'Upstream settings problem',
      'label.automation': 'Automation',
      'label.filter': 'Project filter',
      'summary.project.one': 'project',
      'summary.project.many': 'projects',
      'summary.stale': 'stale',
      'summary.unknown': 'undetermined',
      'summary.orphaned': 'not in graph',
      'summary.runningFor': 'running for',
      'automation.on': 'on',
      'automation.off': 'disabled',
      'automation.rebuildOff': 'auto-rebuild off',
      'filter.all': 'All',
      'filter.stale': 'Stale',
      'filter.unknown': 'Undetermined',
      'filter.watcherFailed': 'Watcher failed',
      'feedback.checkAll': 'Re-checked projects',
      'feedback.checkOne': 'Re-checked this project',
      'feedback.queued': 'Queued rebuilds',
      'feedback.queuedNone': 'Nothing needs a rebuild',
      'feedback.cancelled': 'Abort signal sent',
      'feedback.cancelNone': 'No rebuild is running',
      'feedback.paused': 'Paused watchers',
      'feedback.resumed': 'Resumed watchers',
      'feedback.none': 'Nothing to change',
      'feedback.done': 'Done',
      'confirm.rebuildAll': 'Force-rebuild every project?',
      'confirm.cancel': 'Abort the running rebuild?',
      'confirm.pauseAll': 'Pause every watcher?',
      'confirm.forceRebuild': 'Graph matches the worktree — force a rebuild anyway?',
      'error.notJson': 'response is not valid JSON',
      'confidence.head': 'HEAD comparison',
      'confidence.time': 'Time fallback',
      'confidence.none': 'none',
      'reason.head-match': 'Graph and worktree HEAD match',
      'reason.head-match-but-dirty': 'HEAD matches, but the worktree has uncommitted changes (counted as stale by configuration)',
      'reason.head-advanced': 'Graph is behind the worktree',
      'reason.live-head-unavailable': 'Worktree HEAD cannot be read',
      'reason.time-fallback-head-newer': 'No Branch node in the graph; time-based fallback suggests it is behind',
      'reason.time-fallback-head-older': 'No Branch node in the graph; time-based fallback suggests it matches',
      'reason.no-evidence': 'Not enough evidence to decide',
      'unit.second.one': 's',
      'unit.second.many': 's',
      'unit.minute.one': 'min',
      'unit.minute.many': 'min',
      'unit.commit.one': 'commit',
      'unit.commit.many': 'commits',
      'unit.file.one': 'file',
      'unit.file.many': 'files',
      'unit.rebuild.one': 'rebuild',
      'unit.rebuild.many': 'rebuilds',
      'unit.watcher.one': 'watcher',
      'unit.watcher.many': 'watchers',
      'time.secondsAgo': 's ago',
      'time.minutesAgo': 'min ago',
      'time.hoursAgo': 'h ago',
      'time.daysAgo': 'd ago',
    };

    /** 主題 token 的唯一出口：所有顏色都經過這裡，元件不得寫字面色。 */
    const TOKEN = {
      text: 'var(--dsw-alias-label-primary)',
      textDim: 'var(--dsw-alias-label-tertiary)',
      // caption 是對比最低的一階（亮色主題下約 2:1），只留給「沒有值」的佔位符；
      // 欄位標籤、日誌、次要說明一律用 textDim，否則 11px 文字在亮色主題讀不動。
      textFaint: 'var(--dsw-alias-label-caption)',
      border: 'var(--dsw-alias-border-l2)',
      borderSoft: 'var(--dsw-alias-border-l1)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      surfaceAlt: 'var(--dsw-alias-bg-layer-2)',
      brand: 'var(--dsw-alias-brand-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-label)',
      error: 'var(--dsw-alias-state-error-primary)',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    };

    /**
     * 帶逾時的 JSON 抓取；失敗時拋出帶伺服器訊息的錯誤。
     * @param {string} url - 同源路徑。
     * @param {object|undefined} init - fetch 選項。
     * @param {Function} t - 翻譯函式（錯誤訊息也要走字典）。
     * @returns {Promise<object>} 解析後的回應。
     */
    async function api(url, init, t) {
      const controller = new AbortController();
      const timer = setTimeout(function () { controller.abort(); }, 30000);
      try {
        const response = await fetch(url, Object.assign({ signal: controller.signal }, init ?? {}));
        const text = await response.text();
        let payload;
        try {
          payload = text.length === 0 ? {} : JSON.parse(text);
        } catch {
          throw new Error('HTTP ' + String(response.status) + ': ' + t('error.notJson'));
        }
        if (!response.ok) {
          throw new Error(typeof payload.error === 'string' ? payload.error : 'HTTP ' + String(response.status));
        }
        return payload;
      } finally {
        clearTimeout(timer);
      }
    }

    /**
     * 送出一個 POST。
     * @param {string} path - 路由。
     * @param {object} body - 內文。
     * @param {Function} t - 翻譯函式。
     * @returns {Promise<object>} 回應。
     */
    function post(path, body, t) {
      return api('/api/codebase-watcher' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }, t);
    }

    /**
     * 相對時間：給定 ISO 時間字串，回傳「3 分鐘前」這類字串。
     * @param {string|undefined} iso - ISO 時間。
     * @param {string} fallback - 無值時的替代文字。
     * @param {Function} t - 翻譯函式。
     * @returns {string} 顯示文字。
     */
    function relativeTime(iso, fallback, t) {
      if (typeof iso !== 'string' || iso.length === 0) return fallback;
      const then = Date.parse(iso);
      if (Number.isNaN(then)) return iso;
      const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
      if (seconds < 60) return String(seconds) + ' ' + t('time.secondsAgo');
      if (seconds < 3600) return String(Math.round(seconds / 60)) + ' ' + t('time.minutesAgo');
      if (seconds < 86400) return String(Math.round(seconds / 3600)) + ' ' + t('time.hoursAgo');
      return String(Math.round(seconds / 86400)) + ' ' + t('time.daysAgo');
    }

    /**
     * 已跑多久（重建中的計時）：給 ISO 起點，回傳「1 分 12 秒」這類字串。
     * 起點缺失或無法解析時回 undefined——呼叫端据此省略計時，不猜。
     * @param {unknown} iso - ISO 時間。
     * @param {Function} t - 翻譯函式。
     * @returns {string|undefined} 顯示文字。
     */
    function elapsedText(iso, t) {
      if (typeof iso !== 'string' || iso.length === 0) return undefined;
      const started = Date.parse(iso);
      if (Number.isNaN(started)) return undefined;
      const total = Math.max(0, Math.round((Date.now() - started) / 1000));
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      if (minutes === 0) return String(seconds) + ' ' + t('unit.second.one');
      return String(minutes) + ' ' + t('unit.minute.one') + ' ' + String(seconds) + ' ' + t('unit.second.one');
    }

    /**
     * 時間長度轉人類可讀（累計耗時可能到數小時，「3 小時 47 分」也要讀得懂）。
     * @param {number|undefined} ms - 毫秒。
     * @param {Function} t - 翻譯函式。
     * @returns {string} 顯示文字；非正數回 '—'。
     */
    function formatSpan(ms, t) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
      const total = Math.round(ms / 1000);
      if (total < 60) return (ms / 1000).toFixed(1) + ' ' + t('unit.second.one');
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      if (minutes < 60) {
        return seconds === 0
          ? String(minutes) + ' ' + t('unit.minute.one')
          : String(minutes) + ' ' + t('unit.minute.one') + ' ' + String(seconds) + ' ' + t('unit.second.one');
      }
      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      return rest === 0
        ? String(hours) + ' ' + t('unit.hour.one')
        : String(hours) + ' ' + t('unit.hour.one') + ' ' + String(rest) + ' ' + t('unit.minute.one');
    }

    /**
     * ISO 時間 → 當地時鐘 `HH:MM`（給「自 14:03」這種起算時間用）。
     * @param {unknown} iso - ISO 時間字串。
     * @returns {string|undefined} `HH:MM`；無法解析時 undefined（呼叫端就不顯示）。
     */
    function clockText(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return undefined;
      const at = new Date(iso);
      if (Number.isNaN(at.getTime())) return undefined;
      const pad = function (value) { return value < 10 ? '0' + String(value) : String(value); };
      return pad(at.getHours()) + ':' + pad(at.getMinutes());
    }

    /**
     * 設定值轉顯示文字：布林／數字／字串／陣列都要讀得出來，空字串不能是一片空白。
     * @param {unknown} value - 設定值。
     * @param {Function} t - 翻譯函式。
     * @returns {string} 顯示文字。
     */
    function formatConfigValue(value, t) {
      if (value === undefined || value === null) return '—';
      if (typeof value === 'boolean') return value === true ? 'true' : 'false';
      if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '—';
      if (typeof value === 'string') return value.length === 0 ? t('value.empty') : value;
      if (Array.isArray(value)) return value.length === 0 ? t('value.emptyList') : value.join(', ');
      return '—';
    }

    /**
     * 毫秒轉人類可讀。
     * @param {number|undefined} ms - 毫秒。
     * @param {Function} t - 翻譯函式。
     * @returns {string} 顯示文字。
     */
    function formatDuration(ms, t) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
      return (ms / 1000).toFixed(1) + ' ' + t('unit.second.one');
    }

    /**
     * 數字千分位。
     * @param {number|undefined} value - 數值。
     * @returns {string} 顯示文字。
     */
    function formatNumber(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      return value.toLocaleString('en-US');
    }

    /**
     * 依數量挑單複數鍵。中文的兩個鍵同字，英文才需要分。
     * @param {Function} t - 翻譯函式。
     * @param {number} count - 數量。
     * @param {string} oneKey - 單數鍵。
     * @param {string} manyKey - 複數鍵。
     * @returns {string} 單位字串。
     */
    function unit(t, count, oneKey, manyKey) {
      return t(count === 1 ? oneKey : manyKey);
    }

    /** 判定理由代碼 → 字典鍵。字典沒有的代碼一律原樣顯示代碼本身，不猜語意。 */
    const REASON_KEYS = {
      'head-match': 'reason.head-match',
      'head-match-but-dirty': 'reason.head-match-but-dirty',
      'head-advanced': 'reason.head-advanced',
      'live-head-unavailable': 'reason.live-head-unavailable',
      'time-fallback-head-newer': 'reason.time-fallback-head-newer',
      'time-fallback-head-older': 'reason.time-fallback-head-older',
      'no-evidence': 'reason.no-evidence',
    };

    /** 判據代碼 → 字典鍵。沒見過的值原樣顯示，不會生出 `confidence.xxx` 這種鍵名。 */
    const CONFIDENCE_KEYS = {
      head: 'confidence.head',
      time: 'confidence.time',
      none: 'confidence.none',
    };

    /** 警告 code → 字典鍵。字典沒有的 code 一律 fallback 回 host 的 message。 */
    const WARNING_KEYS = {
      'cli-missing': 'warning.cli-missing',
      'version-unexpected': 'warning.version-unexpected',
      'auto-index-on': 'warning.auto-index-on',
      'upstream-watcher-on': 'warning.upstream-watcher-on',
      'upstream-config-unreadable': 'warning.upstream-config-unreadable',
      'dirty-chase-detected': 'warning.dirty-chase-detected',
    };

    /** 判讀注意 code → 字典鍵。 */
    const CAVEAT_KEYS = {
      'route-file-path-empty': 'caveat.route-file-path-empty',
      'layers-unreliable': 'caveat.layers-unreliable',
      'parse-partial': 'caveat.parse-partial',
      'gitignored-not-indexed': 'caveat.gitignored-not-indexed',
    };

    /**
     * 警告文案裡的佔位符值從哪來。host 目前只給 message，值是狀態裡的同一份事實
     * （cliVersion／upstreamConfigError）；未來 host 若自己在 `data` 帶值，以 data 為準。
     */
    const WARNING_PARAMS = {
      'version-unexpected': function (status) { return { version: status.cliVersion }; },
      'upstream-config-unreadable': function (status) { return { error: status.upstreamConfigError }; },
      // dirty-chase-detected 的三個值（aborted／completed／percent）由 host 直接放在
      // `entry.data`，因此這裡不需要推導；data 缺席時 describeCoded 會退回 host 原文。
    };

    /**
     * 把帶 code 的公告（warning／caveat）翻成人話。
     *
     * 這些 message 是 Host 半邊生成的中文字串，英文介面會整段漏中文；所以照
     * reasons／confidence 的老辦法：code → 字典。但字典在我們這一側——Host 加了
     * 新 code 而 client 還沒跟上時，**寧可顯示 Host 原文（可能是中文），也絕不能
     * 顯示 `warning.xxx` 這種生鍵或空白**。佔位符沒填上（值缺席）時同樣退回原文，
     * 不讓畫面出現 `{version}`。
     * @param {object} entry - `{ code, message, data? }`。
     * @param {object} keys - code → 字典鍵。
     * @param {object} params - 這條文案要用的動態值。
     * @param {Function} t - 翻譯函式。
     * @returns {string} 顯示文字（無值時空字串，由呼叫端決定不畫）。
     */
    function describeCoded(entry, keys, params, t) {
      const message = optionalText(entry?.message);
      const code = optionalText(entry?.code);
      const key = code === undefined ? undefined : keys[code];
      if (key === undefined) return message ?? '';
      const data = entry !== null && typeof entry.data === 'object' && entry.data !== null ? entry.data : {};
      const values = {};
      for (const name of Object.keys(params ?? {})) {
        if (params[name] !== undefined && params[name] !== null) values[name] = params[name];
      }
      for (const name of Object.keys(data)) {
        if (data[name] !== undefined && data[name] !== null) values[name] = data[name];
      }
      const text = t(key, values);
      if (/\{\w+\}/.test(text)) return message ?? text;
      return text;
    }

    /**
     * 警告 → 顯示文字（動態值取自 status）。
     * @param {object} entry - 警告。
     * @param {object} status - `/state` 的 status。
     * @param {Function} t - 翻譯函式。
     * @returns {string} 顯示文字。
     */
    function describeWarning(entry, status, t) {
      const code = optionalText(entry?.code);
      const derive = code !== undefined && WARNING_PARAMS[code] !== undefined ? WARNING_PARAMS[code] : undefined;
      return describeCoded(entry, WARNING_KEYS, derive === undefined ? {} : derive(status ?? {}), t);
    }

    /**
     * 判讀注意 → 顯示文字（這幾條都是靜態文案，沒有動態值）。
     * @param {object} entry - 判讀注意。
     * @param {Function} t - 翻譯函式。
     * @returns {string} 顯示文字。
     */
    function describeCaveat(entry, t) {
      return describeCoded(entry, CAVEAT_KEYS, {}, t);
    }

    /**
     * 取一個可選字串欄位：非字串或空字串都算「沒有值」。
     * Host 半邊可能是舊世代（沒有 reasons／lastRefreshError／graphUi.note／
     * watcher.lastError），卡片必須照常成立，因此所有新欄位都經過這裡。
     * @param {unknown} value - 待檢查的值。
     * @returns {string|undefined} 可用的字串。
     */
    function optionalText(value) {
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    }

    /**
     * 把判定理由代碼翻成人話。
     * @param {unknown} code - 理由代碼。
     * @param {Function} t - 翻譯函式。
     * @returns {string} 顯示文字；空字串代表這個代碼不值得顯示。
     */
    function describeReason(code, t) {
      if (typeof code !== 'string' || code.length === 0) return '';
      const key = REASON_KEYS[code];
      return key === undefined ? code : t(key);
    }

    /**
     * 把判據代碼翻成人話（含未知值的退路）。
     * @param {unknown} code - 判據代碼。
     * @param {Function} t - 翻譯函式。
     * @returns {string} 顯示文字。
     */
    function describeConfidence(code, t) {
      if (typeof code !== 'string' || code.length === 0) return t('confidence.none');
      const key = CONFIDENCE_KEYS[code];
      return key === undefined ? code : t(key);
    }

    /**
     * 錯誤物件轉訊息字串。
     * @param {unknown} failure - 攔到的錯誤。
     * @returns {string} 訊息。
     */
    function messageOf(failure) {
      return failure instanceof Error ? failure.message : String(failure);
    }

    /** 瀏覽器的 document；在沒有 DOM 的環境（驗證器）裡是 undefined。 */
    function pageDocument() {
      return typeof document === 'undefined' ? undefined : document;
    }

    /** 頁面是否在背景：背景時暫停輪詢，省下沒人看的流量。 */
    function pageHidden() {
      const doc = pageDocument();
      return doc !== undefined && doc.hidden === true;
    }

    /**
     * 複製文字到剪貼簿。瀏覽器不給用（非安全來源、無 API）時回 false，
     * 由呼叫端改成提示手動複製——不丟例外、不讓卡片壞掉。
     * @param {string} text - 要複製的文字。
     * @returns {Promise<boolean>} 是否真的寫入剪貼簿。
     */
    function copyText(text) {
      const nav = typeof navigator === 'undefined' ? undefined : navigator;
      if (nav === undefined || nav.clipboard === undefined || typeof nav.clipboard.writeText !== 'function') {
        return Promise.resolve(false);
      }
      return nav.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
    }

    /**
     * 訊息行（可帶標籤）。顏色與字級集中在這裡，a11y 的 role 由呼叫端指定。
     * @param {object} props - label/tone/role/fontSize/children。
     * @returns {object} React 元素。
     */
    function Note(props) {
      const color = props.tone === 'error' ? TOKEN.error
        : props.tone === 'warn' ? TOKEN.warn
          : props.tone === 'brand' ? TOKEN.brand : TOKEN.textDim;
      return h('div', {
        role: props.role,
        style: {
          color, fontSize: props.fontSize ?? '12px', lineHeight: '1.6',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        },
      },
      props.label !== undefined
        ? h('span', { style: { fontWeight: 600, marginRight: '6px' } }, props.label)
        : null,
      props.children);
    }

    /** 小徽章。 @param {object} props - label/tone。 @returns {object} React 元素。 */
    function Badge(props) {
      const tone = props.tone ?? 'neutral';
      const color = tone === 'error' ? TOKEN.error
        : tone === 'warn' ? TOKEN.warn
          : tone === 'success' ? TOKEN.success
            : tone === 'brand' ? TOKEN.brand
              : TOKEN.textDim;
      return h('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '4px',
          padding: '1px 7px', borderRadius: '999px', fontSize: '11px', lineHeight: '18px',
          border: '1px solid ' + TOKEN.border, color, background: TOKEN.surfaceAlt, whiteSpace: 'nowrap',
        },
      }, props.children ?? props.label);
    }

    /**
     * 按鈕。忙碌中的按鈕自己顯示「執行中…」並帶 aria-busy，其他按鈕不受影響。
     * @param {object} props - onClick/label/tone/disabled/busy/title/pressed/attrs。
     *   `attrs` 是穩定的測試鉤子（`data-dsw-*`），給 tools/verify-client.mjs 認按鈕用；
     *   蓋不掉 button 自己的屬性。
     * @returns {object} React 元素。
     */
    function Button(props) {
      const [hover, setHover] = React.useState(false);
      const busy = props.busy === true;
      const disabled = props.disabled === true || busy;
      const pressed = props.pressed === true;
      const color = props.tone === 'danger' ? TOKEN.error : props.tone === 'brand' ? TOKEN.brand : TOKEN.text;
      const label = busy ? props.label + ' ' + (props.busyLabel ?? '…') : props.label;
      return h('button', Object.assign({}, props.attrs ?? {}, {
        type: 'button',
        title: props.title,
        disabled,
        'aria-busy': busy ? true : undefined,
        'aria-pressed': props.pressed === undefined ? undefined : pressed,
        onClick: props.onClick,
        onMouseEnter: function () { setHover(true); },
        onMouseLeave: function () { setHover(false); },
        style: {
          font: 'inherit', fontSize: '12px', lineHeight: '20px', padding: '2px 10px',
          borderRadius: '6px', cursor: disabled ? 'not-allowed' : 'pointer',
          color: disabled ? TOKEN.textDim : (pressed ? TOKEN.brand : color),
          border: '1px solid ' + (pressed ? TOKEN.brand : TOKEN.border),
          background: (hover && !disabled) || pressed ? TOKEN.surfaceAlt : TOKEN.surface,
          opacity: disabled ? 0.6 : 1,
        },
      }), label);
    }

    /**
     * 破壞性動作的兩段式確認：第一次點擊只把動作「上膛」，第二次才真的送出去。
     * 不用 window.confirm——那會擋住整個頁面，也測不到。
     * @param {object} props - label/tone/title/confirmText/disabled/t/onConfirm。
     * @returns {object} React 元素。
     */
    function ConfirmButton(props) {
      const [armed, setArmed] = React.useState(false);
      const t = props.t;
      if (props.disabled === true) {
        return h(Button, { label: props.label, title: props.title, disabled: true, attrs: props.attrs });
      }
      if (armed !== true) {
        return h(Button, {
          label: props.label,
          tone: props.tone,
          title: props.title,
          attrs: props.attrs,
          busy: props.busy,
          busyLabel: t('state.working'),
          onClick: function () { setArmed(true); },
        });
      }
      const owner = props.attrs ?? {};
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
        h('span', { style: { color: TOKEN.warn, fontSize: '11px' } }, props.confirmText),
        h(Button, {
          label: t('action.confirm'), tone: 'danger',
          attrs: Object.assign({}, owner, { 'data-dsw-action': owner['data-dsw-action'] + ':confirm' }),
          onClick: function () { setArmed(false); props.onConfirm(); },
        }),
        h(Button, {
          label: t('action.cancelConfirm'),
          attrs: Object.assign({}, owner, { 'data-dsw-action': owner['data-dsw-action'] + ':dismiss' }),
          onClick: function () { setArmed(false); },
        }));
    }

    /**
     * 連結按鈕：與 Button 同外觀，但用 `<a>` 開新分頁——圖譜 UI 是另一個來源
     * （CBM 的 HTTP 服務），不能在這裡用 fetch 取代。
     * @param {object} props - href/label/tone/title。 @returns {object} React 元素。
     */
    function LinkButton(props) {
      const [hover, setHover] = React.useState(false);
      const color = props.tone === 'brand' ? TOKEN.brand : TOKEN.text;
      return h('a', {
        href: props.href,
        target: '_blank',
        rel: 'noreferrer noopener',
        title: props.title ?? props.href,
        onMouseEnter: function () { setHover(true); },
        onMouseLeave: function () { setHover(false); },
        style: {
          font: 'inherit', fontSize: '12px', lineHeight: '20px', padding: '2px 10px',
          borderRadius: '6px', cursor: 'pointer', color,
          border: '1px solid ' + TOKEN.border,
          background: hover ? TOKEN.surfaceAlt : TOKEN.surface,
          textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px',
        },
      }, props.label);
    }

    /**
     * 複製鈕：成功與失敗都在原地回報，不往外丟狀態。
     * @param {object} props - text/t/tone。 @returns {object} React 元素。
     */
    function CopyButton(props) {
      const t = props.t;
      const [state, setState] = React.useState('idle');
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
        h(Button, {
          label: state === 'done' ? t('action.copied') : t('action.copy'),
          tone: props.tone,
          onClick: function () {
            void copyText(props.text).then(function (ok) {
              setState(ok === true ? 'done' : 'failed');
            });
          },
        }),
        state === 'failed' ? h('span', { style: { color: TOKEN.warn, fontSize: '11px' } }, t('action.copyFailed')) : null);
    }

    /**
     * 一列 key/value。
     *
     * mono 的值（路徑、HEAD）不截斷、可換行，完整內容直接看得見——鍵盤使用者不必
     * 去 hover 一個 title 屬性；非 mono 的短值才用省略號，title 只是滑鼠的方便。
     * @param {object} props - label/value/mono/wrap/tone/title。 @returns {object} React 元素。
     */
    function Field(props) {
      const value = props.value;
      const empty = value === undefined || value === null || value === '';
      const text = empty ? '—' : String(value);
      const mono = props.mono === true;
      // wrap：長句（例：成效區塊那三行數字）要換行顯示；省略號會把數字吃掉。
      const wrap = mono || props.wrap === true;
      return h('div', { style: { display: 'flex', gap: '6px', alignItems: 'baseline', minWidth: 0 } },
        h('span', { style: { color: TOKEN.textDim, fontSize: '11px', flex: '0 0 auto' } }, props.label),
        h('span', {
          title: props.title ?? text,
          style: {
            color: props.tone === 'error' ? TOKEN.error : (empty ? TOKEN.textFaint : TOKEN.text),
            fontSize: '12px',
            fontFamily: mono ? TOKEN.mono : 'inherit',
            minWidth: 0,
            ...(wrap
              ? { wordBreak: 'break-all' }
              : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
          },
        }, text));
    }

    /**
     * 排序權重：孤兒永遠最後，其餘落後 → 無法判定 → 已同步（P1-8）。
     * @param {object} project - 專案。 @returns {number} 權重。
     */
    function projectRank(project) {
      if (project.orphaned === true) return 3;
      if (project.stale === true) return 0;
      if (project.stale === false) return 2;
      return 1;
    }

    /**
     * 依權重排序（同權重按名稱），回傳新陣列，不動 Host 給的順序。
     * @param {object[]} projects - 專案清單。 @returns {object[]} 排序後清單。
     */
    function sortProjects(projects) {
      return projects.slice().sort(function (left, right) {
        const diff = projectRank(left) - projectRank(right);
        if (diff !== 0) return diff;
        return String(left.name ?? '').localeCompare(String(right.name ?? ''));
      });
    }

    /**
     * 單一專案的卡片（FR-8）：預設只露名稱／狀態／上次重建與三顆按鈕，
     * 其餘欄位收進 details。
     *
     * 忙碌鎖只鎖「這個專案」的三顆按鈕：面板上的其他動作不受影響（P1-5），
     * 而被按下那一顆自己顯示「執行中…」。
     * @param {object} props - project/t/busyKey/onAction。
     * @returns {object} React 元素。
     */
    function ProjectCard(props) {
      const project = props.project;
      const t = props.t;
      const busyKey = typeof props.busyKey === 'string' ? props.busyKey : undefined;
      const prefix = 'project:' + String(project.key) + ':';
      const locked = busyKey !== undefined && busyKey.indexOf(prefix) === 0;
      const isBusy = function (action) { return busyKey === prefix + action; };
      const onAction = props.onAction;
      const watcher = project.watcher ?? {};
      const watcherError = optionalText(watcher.lastError);
      const reasons = Array.isArray(project.reasons) ? project.reasons : [];
      const orphaned = project.orphaned === true;
      const watcherFailed = watcher.status === 'failed';
      const staleTone = project.stale === true ? 'error' : (project.stale === false ? 'success' : 'warn');
      const staleLabel = project.stale === true ? t('state.stale')
        : (project.stale === false ? t('state.fresh') : t('state.unknown'));
      const behind = project.behindBy === null || project.behindBy === undefined
        ? '—'
        : String(project.behindBy) + ' ' + unit(t, project.behindBy, 'unit.commit.one', 'unit.commit.many');
      // 只有「落後且確實有落後提交數」才配紅色；behindBy 為 0 時（例如只因為
      // 工作樹 dirty 才判定落後）用一般色，否則會出現紅色的「落後 0 個提交」。
      const behindTone = project.stale === true && typeof project.behindBy === 'number' && project.behindBy > 0
        ? 'error' : undefined;
      const watcherLabel = watcher.status === 'watching' ? t('state.watching')
        : watcher.status === 'failed' ? t('state.failed') : t('state.stopped');
      const rebuildLabel = project.rebuildState === 'running' ? t('state.running')
        : project.rebuildState === 'queued' ? t('state.queued') : t('state.idle');
      const reasonText = reasons
        .map(function (code) { return describeReason(code, t); })
        .filter(function (text) { return text.length > 0; })
        .join(' · ');
      const force = project.stale !== true;

      return h('div', {
        style: {
          border: '1px solid ' + (orphaned || project.stale === true ? TOKEN.error : TOKEN.borderSoft),
          borderRadius: '10px', padding: '12px 14px', background: TOKEN.surface,
          display: 'flex', flexDirection: 'column', gap: '8px',
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        h('span', { style: { color: TOKEN.text, fontSize: '14px', fontWeight: 600 } }, project.name),
        orphaned ? h(Badge, { label: t('state.orphaned'), tone: 'error' }) : null,
        h(Badge, { label: staleLabel, tone: staleTone }),
        project.rebuildState !== 'idle' && project.rebuildState !== undefined
          ? h(Badge, { label: rebuildLabel, tone: 'brand' })
          : null,
        project.watcherPaused === true ? h(Badge, { label: t('state.paused'), tone: 'warn' }) : null,
        watcherFailed ? h(Badge, { label: t('state.failed'), tone: 'error' }) : null,
        h('span', { style: { color: TOKEN.textDim, fontSize: '11px' } },
          t('label.lastIndexedAt') + ' ' + relativeTime(project.lastIndexedAt, '—', t)),
        h('div', { style: { flex: '1 1 auto' } }),
        h(Button, {
          label: t('action.check'), disabled: locked,
          busy: isBusy('check'), busyLabel: t('state.working'),
          attrs: { 'data-dsw-action': 'project:check', 'data-dsw-project': String(project.key) },
          onClick: function () { onAction('check', project); },
        }),
        force
          ? h(ConfirmButton, {
            label: t('action.forceRebuild'), tone: 'brand', t,
            confirmText: t('confirm.forceRebuild'),
            title: t('hint.forceRebuild'),
            disabled: locked,
            attrs: { 'data-dsw-action': 'project:rebuild', 'data-dsw-project': String(project.key) },
            busy: isBusy('rebuild'), busyLabel: t('state.working'),
            onConfirm: function () { onAction('rebuild', project); },
          })
          : h(Button, {
            label: t('action.rebuild'), tone: 'brand', disabled: locked,
            busy: isBusy('rebuild'), busyLabel: t('state.working'),
            attrs: { 'data-dsw-action': 'project:rebuild', 'data-dsw-project': String(project.key) },
            onClick: function () { onAction('rebuild', project); },
          }),
        h(Button, {
          label: watcher.status === 'watching' ? t('action.pause') : t('action.resume'),
          disabled: locked,
          busy: isBusy('watchers'), busyLabel: t('state.working'),
          attrs: { 'data-dsw-action': 'project:watchers', 'data-dsw-project': String(project.key) },
          onClick: function () { onAction(watcher.status === 'watching' ? 'pause' : 'resume', project); },
        }),
      ),
      orphaned ? h(Note, { tone: 'error' }, t('hint.orphaned')) : null,
      watcherError !== undefined
        ? h(Note, { tone: 'error', label: t('label.watcherError') }, watcherError)
        : null,

      h('details', null,
        h('summary', { style: { cursor: 'pointer', color: TOKEN.textDim, fontSize: '12px' } }, t('action.details')),
        h('div', {
          style: {
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '4px 18px', borderTop: '1px solid ' + TOKEN.borderSoft, paddingTop: '8px', marginTop: '6px',
          },
        },
        h(Field, { label: t('label.root'), value: project.rootPath, mono: true, title: project.rootPath }),
        h(Field, { label: t('label.branch'), value: project.branch }),
        h(Field, { label: t('label.graphHead'), value: project.graphHead ?? '—', mono: true, title: project.graphHead ?? '' }),
        h(Field, { label: t('label.liveHead'), value: project.liveHead ?? '—', mono: true, title: project.liveHead ?? '' }),
        h(Field, { label: t('label.behindBy'), value: behind, tone: behindTone }),
        h(Field, { label: t('label.confidence'), value: describeConfidence(project.confidence, t) }),
        h(Field, { label: t('label.indexedAt'), value: relativeTime(project.indexedAt, '—', t), title: project.indexedAt ?? '' }),
        h(Field, { label: t('label.lastIndexedAt'), value: relativeTime(project.lastIndexedAt, '—', t), title: project.lastIndexedAt ?? '' }),
        h(Field, { label: t('label.lastDuration'), value: formatDuration(project.lastDurationMs, t) }),
        h(Field, { label: t('label.watcher'), value: watcherLabel }),
        h(Field, { label: t('label.watcherBackend'), value: watcher.backend }),
        h(Field, { label: t('label.triggers'), value: formatNumber(watcher.triggers) }),
        h(Field, { label: t('label.nodes'), value: formatNumber(project.nodes) }),
        h(Field, { label: t('label.edges'), value: formatNumber(project.edges) }),
        h(Field, { label: t('label.parsePartial'), value: formatNumber(project.parsePartialCount) }),
        h(Field, {
          label: t('label.notIndexed'),
          value: typeof project.notIndexedFilesCount === 'number'
            ? formatNumber(project.notIndexedFilesCount) + ' ' + unit(t, project.notIndexedFilesCount, 'unit.file.one', 'unit.file.many')
            : undefined,
        }),
        ),
        reasonText.length > 0
          ? h(Note, { label: t('label.reasons') }, reasonText)
          : null,
        project.dirty === true ? h(Note, { tone: 'warn' }, t('label.dirty')) : null,
        project.graphUrl !== undefined
          ? h('div', { style: { marginTop: '4px' } },
            h(LinkButton, {
              href: project.graphUrl, label: t('action.openProjectGraph'),
              title: t('graph.hint') + ' ' + project.graphUrl,
            }))
          : null,
        optionalText(project.lastError) !== undefined
          ? h(Note, { tone: 'error', label: t('label.lastError') }, String(project.lastError))
          : null,
        optionalText(project.lastCheckedError) !== undefined
          ? h(Note, { tone: 'warn', label: t('label.checkError') }, String(project.lastCheckedError))
          : null,
      ));
    }

    /**
     * CLI／上游健康區塊：把「為什麼 CLI 找不到」「上游設定長怎樣」攤開來，
     * 並給一條可以直接複製的診斷指令。
     * @param {object} props - status/warnings/caveats/t。
     * @returns {object} React 元素。
     */
    function HealthBlock(props) {
      const t = props.t;
      const status = props.status;
      const warnings = props.warnings;
      const caveats = props.caveats;
      const cliPath = optionalText(status.cliPath);
      const cliError = optionalText(status.cliError);
      const cliCandidates = Array.isArray(status.cliCandidates) ? status.cliCandidates : [];
      const logFileError = optionalText(status.logFileError);
      const stateLoadError = optionalText(status.stateLoadError);
      const upstreamConfigError = optionalText(status.upstreamConfigError);
      const upstream = status.upstreamConfig ?? {};
      const upstreamText = Object.keys(upstream)
        .map(function (key) { return key + '=' + String(upstream[key]); })
        .join(' · ');
      const command = cliPath !== undefined ? cliPath + ' --version' : 'command -v codebase-memory-mcp';

      return h('section', {
        style: {
          border: '1px solid ' + (cliPath === undefined ? TOKEN.error : TOKEN.borderSoft),
          borderRadius: '10px', padding: '10px 14px', background: TOKEN.surfaceAlt,
          display: 'flex', flexDirection: 'column', gap: '6px',
        },
      },
      h('h3', { style: { margin: 0, color: TOKEN.text, fontSize: '12px', fontWeight: 600 } }, t('label.health')),
      h('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '4px 18px' },
      },
      h(Field, {
        label: t('label.cli'),
        value: cliPath ?? t('label.unresolved'),
        mono: true, tone: cliPath === undefined ? 'error' : undefined, title: cliPath ?? '',
      }),
      h(Field, { label: t('label.cliSource'), value: status.cliSource }),
      h(Field, { label: t('label.version'), value: status.cliVersion, tone: status.cliVersionSupported === false ? 'error' : undefined }),
      h(Field, { label: t('label.lastScan'), value: relativeTime(status.lastRefreshAt, '—', t), title: status.lastRefreshAt ?? '' }),
      h(Field, { label: t('label.queue'), value: formatNumber(Array.isArray(status.queue) ? status.queue.length : undefined) }),
      h(Field, { label: t('label.watching'), value: formatNumber(status.watching) }),
      ),
      cliError !== undefined ? h(Note, { tone: 'error', label: t('label.cliError') }, cliError) : null,
      cliCandidates.length > 0
        ? h('div', null,
          h('div', { style: { color: TOKEN.textDim, fontSize: '11px' } }, t('label.cliCandidates')),
          h('ul', { style: { margin: '2px 0 0', paddingLeft: '18px' } },
            cliCandidates.map(function (candidate, index) {
              return h('li', {
                key: 'candidate' + String(index),
                style: { fontFamily: TOKEN.mono, fontSize: '11px', color: TOKEN.text, wordBreak: 'break-all' },
              }, String(candidate));
            })))
        : null,
      logFileError !== undefined ? h(Note, { tone: 'error', label: t('label.logFileError') }, logFileError) : null,
      stateLoadError !== undefined ? h(Note, { tone: 'error', label: t('label.stateLoadError') }, stateLoadError) : null,
      upstreamConfigError !== undefined
        ? h(Note, { tone: 'error', label: t('label.upstreamConfigError') }, upstreamConfigError)
        : null,
      upstreamText.length > 0
        ? h(Field, { label: t('label.upstreamConfig'), value: upstreamText, mono: true })
        : null,
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        h(Field, { label: t('label.command'), value: command, mono: true }),
        h(CopyButton, { text: command, t })),
      warnings.length > 0
        ? h('div', null,
          h('div', { style: { color: TOKEN.warn, fontSize: '12px', fontWeight: 600 } }, t('label.warnings')),
          warnings.map(function (warning, index) {
            const text = describeWarning(warning, status, t);
            if (text.length === 0) return null;
            return h('div', {
              key: 'warning' + String(index),
              style: { color: TOKEN.text, fontSize: '12px', whiteSpace: 'pre-wrap' },
            }, '· ' + text);
          }))
        : null,
      caveats.length > 0
        ? h('details', { open: true },
          h('summary', { style: { cursor: 'pointer', color: TOKEN.textDim, fontSize: '12px' } }, t('label.caveats')),
          h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px', color: TOKEN.textDim, fontSize: '12px', lineHeight: '1.6' } },
            caveats.map(function (caveat, index) {
              const text = describeCaveat(caveat, t);
              if (text.length === 0) return null;
              return h('li', { key: 'caveat' + String(index) }, text);
            })))
        : null);
    }

    /**
     * 設定區塊：看得見預設值 ＋ 一鍵恢復預設。
     *
     * 職責刻意只有這兩件事：18 個可寫欄位的**編輯**在 DSH 自己的插件設定表單裡，
     * 這裡再重做一份編輯器只會多出第二個會隨時間漂移的真實來源。
     *
     * 兩個邊界：
     *   - `defaults`／`overridden` 缺席（舊 host）→ **整個區塊不渲染**（與 `stats` 缺席同一規則），
     *     不留一排按了也沒用的按鈕；
     *   - 預設**收起**，卡片一開始不會被 18 列欄位撐長。
     *
     * 未覆寫的欄位不顯示「恢復預設」按鈕（沒有事可做），只標「（預設）」；因為
     * `overridden` 的定義就是「目前值 ≠ 預設值」，所以不另外印一次預設值也不會漏資訊。
     * @param {object} props - t/payload/busy/onResetAll/onResetField。
     * @returns {object|null} React 元素。
     */
    function ConfigBlock(props) {
      const t = props.t;
      const [open, setOpen] = React.useState(false);
      const payload = props.payload;
      const config = payload !== undefined && payload.config !== null && typeof payload.config === 'object' ? payload.config : undefined;
      const defaults = payload !== undefined && payload.defaults !== null && typeof payload.defaults === 'object' ? payload.defaults : undefined;
      const overridden = payload !== undefined && Array.isArray(payload.overridden) ? payload.overridden : undefined;
      if (config === undefined || defaults === undefined || overridden === undefined) return null;
      const busy = props.busy === true;
      const overriddenCount = overridden.length;

      return h('section', {
        'data-dsw-config': '1',
        style: {
          border: '1px solid ' + TOKEN.borderSoft, borderRadius: '10px', padding: '10px 14px',
          background: TOKEN.surface, display: 'flex', flexDirection: 'column', gap: '6px',
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        h('h3', { style: { margin: 0, color: TOKEN.text, fontSize: '12px', fontWeight: 600 } }, t('label.config')),
        h(Button, {
          label: open ? t('action.hideConfig') : t('action.showConfig'),
          pressed: open,
          attrs: { 'data-dsw-action': 'panel:config' },
          onClick: function () { setOpen(!open); },
        }),
        // 收起來也要看得到「你改過幾個欄位」——不然沒人會知道這裡可以恢復。
        overriddenCount > 0
          ? h(Badge, { label: t('config.overriddenCount', { count: String(overriddenCount) }), tone: 'warn' })
          : null,
        open
          ? h(ConfirmButton, {
            label: t('action.resetAll'), t, tone: 'danger',
            confirmText: t('confirm.resetAll'),
            disabled: busy || overriddenCount === 0,
            busy: busy, busyLabel: t('state.working'),
            attrs: { 'data-dsw-action': 'config:resetAll' },
            onConfirm: function () { props.onResetAll(); },
          })
          : null),
      open
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h(Note, { fontSize: '11px' }, t('config.hint')),
          h(Note, { fontSize: '11px' }, t('config.hintReset')),
          h('div', { style: { display: 'flex', flexDirection: 'column', marginTop: '2px' } },
            Object.keys(config).map(function (field) {
              const over = overridden.indexOf(field) !== -1;
              return h('div', {
                key: 'cfg:' + field,
                'data-dsw-config-field': field,
                style: {
                  display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap',
                  padding: '3px 0', borderTop: '1px solid ' + TOKEN.borderSoft,
                },
              },
              h('span', {
                style: { fontFamily: TOKEN.mono, fontSize: '11px', color: TOKEN.text, flex: '0 0 auto', minWidth: '196px' },
              }, field),
              h('span', {
                style: {
                  fontSize: '12px', color: TOKEN.text, flex: '1 1 auto', minWidth: 0,
                  wordBreak: 'break-all',
                },
              }, formatConfigValue(config[field], t)),
              over
                ? h('span', { style: { fontSize: '11px', color: TOKEN.warn, flex: '0 0 auto' } },
                  t('config.defaultValue') + ' ' + formatConfigValue(defaults[field], t))
                : null,
              over
                ? h(Button, {
                  label: t('action.resetOne'), disabled: busy,
                  busy: busy, busyLabel: t('state.working'),
                  attrs: { 'data-dsw-action': 'config:reset:' + field },
                  onClick: function () { props.onResetField(field); },
                })
                : h('span', { style: { fontSize: '11px', color: TOKEN.textDim, flex: '0 0 auto' } }, t('config.allDefaults')));
            })))
        : null);
    }

    /**
     * 成效區塊（WS5 的 `status().stats`）。
     *
     * **措辭是最重要的部分**：這些數字是「本次啟動以來」，不是歷史總計（行程記憶體
     * 內、不落盤、不回填日誌）。Host 刻意用 `sinceStart*`／`last24h*` 前綴防誤讀，
     * 卡片這邊照樣只講「本次啟動以來（自 …）」，並且只顯示 `sinceStart*`——`last24h*`
     * 是它的子集，兩個並排只會讓人以為有兩份總計。
     *
     * 兩個邊界都選擇「不畫」：
     *   - `stats` 缺席（舊 host）→ 不畫，否則一排 0 會讓舊 host 看起來像什麼都沒做；
     *   - 全部為 0（剛啟動、還沒發生任何事）→ 也不畫。安靜是預設，與側邊欄指示一致；
     *     而且這裡沒有「剛剛啟動」以外的解讀，畫出來只是每次啟動的一行噪音。
     * @param {object} props - status/t。
     * @returns {object|null} React 元素。
     */
    function StatsBlock(props) {
      const t = props.t;
      const status = props.status;
      const stats = status.stats !== null && typeof status.stats === 'object' ? status.stats : undefined;
      if (stats === undefined) return null;
      const num = function (key) {
        const value = stats[key];
        return typeof value === 'number' && Number.isFinite(value) ? value : 0;
      };
      const queued = num('sinceStartRebuildsQueued');
      const succeeded = num('sinceStartRebuildsSucceeded');
      const aborted = num('sinceStartRebuildsAborted');
      // RebuildsFailed 與 RebuildsAborted 互斥（Host 的語意），相加才是全部失敗嘗試。
      const failed = num('sinceStartRebuildsFailed') + aborted;
      const cooldown = num('sinceStartSkippedCooldown');
      const gate = num('sinceStartSkippedGate');
      const deferred = num('sinceStartSettleDeferred');
      const checks = num('sinceStartChecksShortCircuited');
      const rebuildMs = num('sinceStartRebuildMs');
      if (queued + succeeded + failed + cooldown + gate + deferred + checks + rebuildMs === 0) return null;

      const clock = clockText(status.statsSince);
      const heading = clock === undefined ? t('stats.headingNoTime') : t('stats.heading', { time: clock });
      const rebuildLine = t('stats.rebuildLine', {
        queued: String(queued), succeeded: String(succeeded), failed: String(failed),
      }) + (aborted > 0 ? ' ' + t('stats.abortedSuffix', { aborted: String(aborted) }) : '');

      return h('section', {
        style: {
          border: '1px solid ' + TOKEN.borderSoft, borderRadius: '10px', padding: '10px 14px',
          background: TOKEN.surface, display: 'flex', flexDirection: 'column', gap: '6px',
        },
      },
      h('h3', { style: { margin: 0, color: TOKEN.text, fontSize: '12px', fontWeight: 600 } }, heading),
      h('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '4px 18px' },
      },
      h(Field, { label: t('label.statsRebuilds'), value: rebuildLine, wrap: true }),
      h(Field, {
        label: t('label.statsSaved'),
        value: t('stats.savedLine', {
          cooldown: String(cooldown), gate: String(gate), deferred: String(deferred),
        }),
        wrap: true,
      }),
      h(Field, {
        label: t('label.statsChecks'),
        value: checks === 0 ? '—' : String(checks) + ' ' + unit(t, checks, 'unit.time.one', 'unit.time.many'),
      }),
      h(Field, { label: t('label.statsRebuildMs'), value: formatSpan(rebuildMs, t) }),
      ));
    }

    /**
     * 設定頁內容：整塊觀測面（FR-8/9/10/12）。
     * @param {object} props - t（由註冊處閉包帶入的翻譯函式）。
     * @returns {object} React 元素。
     */
    function Panel(props) {
      const t = props.t;
      const [snapshot, setSnapshot] = React.useState(undefined);
      const [snapshotAt, setSnapshotAt] = React.useState(undefined);
      const [error, setError] = React.useState(undefined);
      const [busy, setBusy] = React.useState(undefined);
      const [feedback, setFeedback] = React.useState(undefined);
      const [showLog, setShowLog] = React.useState(false);
      const [filter, setFilter] = React.useState('all');
      const [configPayload, setConfigPayload] = React.useState(undefined);

      // reload 的識別隨 showLog 改變：展開日誌時輪詢改抓 log=120，並立刻補一次。
      const reload = React.useCallback(function () {
        const query = showLog === true ? '?log=' + String(LOG_LINES) : '?log=0';
        return api('/api/codebase-watcher/state' + query, undefined, t)
          .then(function (payload) {
            setSnapshot(payload);
            setSnapshotAt(new Date().toISOString());
            setError(undefined);
            return true;
          })
          .catch(function (failure) {
            // 失敗時刻意保留舊 snapshot，但連同「取到的時間」一起標記成過期。
            // error 每次都是新物件，React 才會重畫，相對時間不會凍住。
            setError({ kind: 'poll', message: messageOf(failure), at: new Date().toISOString() });
            return false;
          });
      }, [showLog, t]);

      /**
       * 讀 `/config`：設定區塊要的 `defaults`／`overridden` 都在這裡。
       * 它只是輔助資訊——抓不到就維持「這台 host 不支援」的樣子（區塊不渲染），
       * 不彈錯誤蓋掉主要狀態；真正的連線問題由 `/state` 的離線橫幅講。
       * @returns {Promise<boolean>} 是否成功。
       */
      const loadConfig = React.useCallback(function () {
        return api('/api/codebase-watcher/config', undefined, t)
          .then(function (payload) {
            setConfigPayload(payload);
            return true;
          })
          .catch(function () { return false; });
      }, [t]);

      React.useEffect(function () {
        void loadConfig();
      }, [loadConfig]);

      React.useEffect(function () {
        let alive = true;
        let timer;
        let delay = POLL_MS;

        function clearTimer() {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
        }

        function schedule(wait) {
          clearTimer();
          if (!alive) return;
          timer = setTimeout(tick, wait);
        }

        function applyResult(ok) {
          delay = ok === true ? POLL_MS : Math.min(delay * 2, POLL_MAX_MS);
          schedule(delay);
        }

        function tick() {
          timer = undefined;
          if (!alive) return;
          if (pageHidden() === true) {
            delay = POLL_MS;
            schedule(POLL_MS);
            return;
          }
          void reload().then(function (ok) {
            if (alive) applyResult(ok);
          });
        }

        function onVisibility() {
          if (!alive) return;
          if (pageHidden() === true) {
            clearTimer();
            return;
          }
          delay = POLL_MS;
          clearTimer();
          tick();
        }

        void reload().then(function (ok) {
          if (alive) applyResult(ok);
        });

        const doc = pageDocument();
        if (doc !== undefined && typeof doc.addEventListener === 'function') {
          doc.addEventListener('visibilitychange', onVisibility);
        }
        return function () {
          alive = false;
          clearTimer();
          if (doc !== undefined && typeof doc.removeEventListener === 'function') {
            doc.removeEventListener('visibilitychange', onVisibility);
          }
        };
      }, [reload]);

      /**
       * 執行一個會改變狀態的動作：忙碌期間只鎖定這個動作的按鈕，結束後立刻重讀。
       * @param {string} busyKey - 忙碌鍵（`panel:xxx` 或 `project:<key>`）。
       * @param {string} path - 路由。
       * @param {object} body - 內文。
       * @param {Function} describe - 由回應組出回饋訊息。
       * @returns {Promise<void>} 完成。
       */
      const run = React.useCallback(function (busyKey, path, body, describe) {
        setBusy(busyKey);
        setFeedback(undefined);
        return post(path, body, t)
          .then(function (payload) {
            setFeedback(describe(payload));
            return reload();
          })
          .catch(function (failure) {
            // 動作失敗：走同一條過期標記，卡片不會若無其事地留著舊資料；
            // 但訊息要說「動作失敗」而不是「已離線」——輪詢其實還活著。
            setError({ kind: 'action', message: messageOf(failure), at: new Date().toISOString() });
          })
          .finally(function () { setBusy(undefined); });
      }, [reload, t]);

      if (snapshot === undefined) {
        return h('div', {
          role: error === undefined ? undefined : 'alert',
          style: { color: error === undefined ? TOKEN.textDim : TOKEN.error, fontSize: '13px', padding: '12px' },
        }, error === undefined ? t('state.loading') : t('state.loadFailed') + ': ' + error.message);
      }

      const status = snapshot.status ?? {};
      const config = status.config ?? {};
      const projects = Array.isArray(snapshot.projects) ? snapshot.projects : [];
      const caveats = Array.isArray(snapshot.caveats) ? snapshot.caveats : [];
      const log = Array.isArray(snapshot.log) ? snapshot.log : [];
      const warnings = Array.isArray(status.warnings) ? status.warnings : [];
      // Host 半邊是舊世代時這幾個欄位不存在；undefined 就整段不畫。
      const refreshError = optionalText(status.lastRefreshError);
      const graphUi = status.graphUi ?? {};
      const graphUiNote = optionalText(graphUi.note);
      const running = status.running !== null && typeof status.running === 'object' ? status.running : undefined;

      // 摘要列（IA-1）：一眼看到總量、落後、無法判定與自動化狀態。
      const healthy = projects.filter(function (project) { return project.orphaned !== true; });
      const staleCount = healthy.filter(function (project) { return project.stale === true; }).length;
      const unknownCount = healthy.filter(function (project) {
        return project.stale !== true && project.stale !== false;
      }).length;
      const watcherFailedCount = projects.filter(function (project) {
        return (project.watcher ?? {}).status === 'failed';
      }).length;
      const orphanCount = projects.length - healthy.length;
      const summaryParts = [
        String(projects.length) + ' ' + unit(t, projects.length, 'summary.project.one', 'summary.project.many'),
      ];
      // 一個專案都沒有時，「0 落後 · 0 無法判定」只是噪音，留總數與自動化狀態就夠。
      if (projects.length > 0) {
        summaryParts.push(String(staleCount) + ' ' + t('summary.stale'));
        summaryParts.push(String(unknownCount) + ' ' + t('summary.unknown'));
      }
      summaryParts.push(t('label.lastScan') + ' ' + relativeTime(status.lastRefreshAt, '—', t));
      if (orphanCount > 0) summaryParts.push(String(orphanCount) + ' ' + t('summary.orphaned'));

      const automationLabel = status.enabled === false ? t('automation.off')
        : (config.autoRebuild === false ? t('automation.rebuildOff') : t('automation.on'));
      const automationTone = status.enabled === false ? 'error' : (config.autoRebuild === false ? 'warn' : 'neutral');
      const runningProject = running === undefined
        ? undefined
        : projects.find(function (project) { return project.key === running.key; });
      const runningName = running === undefined
        ? undefined
        : (runningProject !== undefined && runningProject.name !== undefined ? runningProject.name : running.key);
      const runningElapsed = running === undefined ? undefined : elapsedText(running.startedAt, t);
      const runningText = runningName === undefined
        ? undefined
        : t('state.running') + ': ' + String(runningName)
          + (runningElapsed === undefined ? '' : ' (' + t('summary.runningFor') + ' ' + runningElapsed + ')');

      const sorted = sortProjects(projects);
      const filtered = sorted.filter(function (project) {
        if (filter === 'stale') return project.stale === true && project.orphaned !== true;
        if (filter === 'unknown') return project.stale !== true && project.stale !== false && project.orphaned !== true;
        if (filter === 'watcherFailed') return (project.watcher ?? {}).status === 'failed';
        return true;
      });
      const chips = [
        { id: 'all', label: t('filter.all'), count: projects.length },
        { id: 'stale', label: t('filter.stale'), count: staleCount },
        { id: 'unknown', label: t('filter.unknown'), count: unknownCount },
        { id: 'watcherFailed', label: t('filter.watcherFailed'), count: watcherFailedCount },
      ];

      // 面板層級的動作互相排他（避免同時按下兩個衝突的 POST），但專案卡上的
      // 單一動作只鎖自己那張卡——8 顆按鈕一起變灰才是原本的「像當機」。
      const panelBusy = typeof busy === 'string' && busy.indexOf('panel:') === 0;
      const lockOther = function (key) { return panelBusy && busy !== key; };
      const projectBusyKey = function (project, action) {
        return 'project:' + String(project.key) + ':' + String(action);
      };
      const handleAction = function (action, target) {
        if (action === 'check') {
          void run(projectBusyKey(target, 'check'), '/check', { id: target.key }, function (payload) {
            const count = Array.isArray(payload.projects) ? payload.projects.length : 0;
            return { tone: 'ok', text: t('feedback.checkOne') + ' (' + String(count) + ')' };
          });
          return;
        }
        if (action === 'rebuild') {
          void run(projectBusyKey(target, 'rebuild'), '/rebuild', { id: target.key, force: target.stale !== true }, function (payload) {
            return rebuildFeedback(payload, t);
          });
          return;
        }
        void run(projectBusyKey(target, 'watchers'), '/watchers', { id: target.key, action }, function (payload) {
          const affected = typeof payload.affected === 'number' ? payload.affected : 0;
          if (affected === 0) return { tone: 'warn', text: t('feedback.none') };
          return {
            tone: 'ok',
            text: (action === 'pause' ? t('feedback.paused') : t('feedback.resumed'))
              + ' ' + String(affected) + ' ' + unit(t, affected, 'unit.watcher.one', 'unit.watcher.many'),
          };
        });
      };

      /**
       * 恢復預設：打 `POST /config {reset}`，成功後重讀 `/config` 讓按鈕消失。
       * @param {boolean|string[]} fields - true＝全部、陣列＝指定欄位。
       * @param {Function} describe - 由回應組出回饋訊息。
       * @returns {Promise<void>} 完成。
       */
      const resetConfig = function (fields, describe) {
        return run('panel:config', '/config', { reset: fields }, describe)
          .then(function () { return loadConfig(); });
      };
      const unknownFields = function (payload) {
        return Array.isArray(payload.unknown) ? payload.unknown : [];
      };
      const handleResetField = function (field) {
        void resetConfig([field], function (payload) {
          const unknown = unknownFields(payload);
          if (unknown.length > 0) return { tone: 'warn', text: t('feedback.configUnknown', { fields: unknown.join(', ') }) };
          if (typeof payload.note === 'string' && payload.note.length > 0) return { tone: 'ok', text: payload.note };
          return { tone: 'ok', text: t('feedback.configResetOne', { field }) };
        });
      };
      const handleResetAll = function () {
        // 數量從「重置前有幾個覆寫」與回應裡的 overridden 推導，不寫死。
        const before = Array.isArray(configPayload?.overridden) ? configPayload.overridden.length : 0;
        void resetConfig(true, function (payload) {
          const unknown = unknownFields(payload);
          if (unknown.length > 0) return { tone: 'warn', text: t('feedback.configUnknown', { fields: unknown.join(', ') }) };
          if (typeof payload.note === 'string' && payload.note.length > 0) return { tone: 'ok', text: payload.note };
          const after = Array.isArray(payload.overridden) ? payload.overridden.length : undefined;
          const count = after === undefined ? before : Math.max(0, before - after);
          return { tone: 'ok', text: t('feedback.configResetAll', { count: String(count) }) };
        });
      };

      return h('div', {
        'aria-busy': busy === undefined ? undefined : true,
        style: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 2px 24px' },
      },
      h('div', null,
        h('h3', { style: { margin: 0, color: TOKEN.text, fontSize: '15px', fontWeight: 600 } }, t('panel.title')),
        h('div', { style: { color: TOKEN.textDim, fontSize: '12px', marginTop: '2px' } }, t('panel.subtitle')),
      ),

      // P0-3：錯誤與過期資料置頂，紅字不再埋在按鈕底下。
      error !== undefined
        ? h('div', {
          role: 'alert',
          style: {
            border: '1px solid ' + TOKEN.error, borderRadius: '10px', padding: '10px 14px',
            background: TOKEN.surface, display: 'flex', flexDirection: 'column', gap: '4px',
          },
        },
        error.kind === 'action'
          ? h(Note, { tone: 'error', label: t('label.actionError') }, error.message)
          : h(Note, { tone: 'error', label: t('notice.offline') },
            t('label.dataAt') + ' ' + relativeTime(snapshotAt, '—', t) + ' — ' + error.message),
        error.kind === 'action'
          ? null
          : h(Note, { fontSize: '11px' }, t('label.lastScan') + ' ' + relativeTime(status.lastRefreshAt, '—', t)))
        : null,

      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        h('span', { style: { color: TOKEN.textDim, fontSize: '12px' } }, summaryParts.join(' · ')),
        h(Badge, { label: t('label.automation') + ' ' + automationLabel, tone: automationTone }),
        runningText !== undefined
          ? h('span', { style: { color: TOKEN.brand, fontSize: '12px', fontWeight: 600 } }, runningText)
          : null),
      status.enabled === false ? h(Note, { tone: 'error' }, t('notice.disabled')) : null,
      status.enabled !== false && config.autoRebuild === false
        ? h(Note, { tone: 'warn' }, t('notice.autoRebuildOff'))
        : null,
      refreshError !== undefined
        ? h(Note, { role: 'alert', tone: 'error', label: t('label.lastRefreshError') }, refreshError)
        : null,

      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
        h(Button, {
          label: t('action.check'), tone: 'brand',
          busy: busy === 'panel:check', busyLabel: t('state.working'),
          disabled: lockOther('panel:check'),
          attrs: { 'data-dsw-action': 'panel:check' },
          onClick: function () {
            void run('panel:check', '/check', {}, function (payload) {
              const count = Array.isArray(payload.projects) ? payload.projects.length : 0;
              return { tone: 'ok', text: t('feedback.checkAll') + ' (' + String(count) + ')' };
            });
          },
        }),
        h(Button, {
          label: t('action.rebuildStale'),
          busy: busy === 'panel:rebuild', busyLabel: t('state.working'),
          disabled: lockOther('panel:rebuild'),
          attrs: { 'data-dsw-action': 'panel:rebuildStale' },
          onClick: function () {
            void run('panel:rebuild', '/rebuild', { staleOnly: true }, function (payload) {
              return rebuildFeedback(payload, t);
            });
          },
        }),
        h(Button, {
          label: showLog ? t('action.hideLog') : t('action.showLog'),
          pressed: showLog,
          attrs: { 'data-dsw-action': 'panel:log' },
          onClick: function () { setShowLog(!showLog); },
        }),
        h(Button, {
          label: t('action.refresh'),
          attrs: { 'data-dsw-action': 'panel:refresh' },
          onClick: function () { void reload(); },
        }),

        h('details', null,
          h('summary', { style: { cursor: 'pointer', color: TOKEN.textDim, fontSize: '12px' } }, t('action.more')),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '6px' } },
            h(ConfirmButton, {
              label: t('action.rebuildAll'), t,
              tone: 'danger',
              title: t('hint.rebuildAll'),
              confirmText: t('confirm.rebuildAll'),
              busy: busy === 'panel:rebuild', busyLabel: t('state.working'),
              disabled: lockOther('panel:rebuild'),
              attrs: { 'data-dsw-action': 'panel:rebuildAll' },
              onConfirm: function () {
                void run('panel:rebuild', '/rebuild', { force: true }, function (payload) {
                  return rebuildFeedback(payload, t);
                });
              },
            }),
            h(ConfirmButton, {
              label: t('action.cancel'), t,
              tone: 'danger',
              title: t('hint.cancel'),
              confirmText: t('confirm.cancel'),
              busy: busy === 'panel:cancel', busyLabel: t('state.working'),
              disabled: lockOther('panel:cancel') || running === undefined,
              attrs: { 'data-dsw-action': 'panel:cancel' },
              onConfirm: function () {
                void run('panel:cancel', '/cancel', {}, function (payload) {
                  if (payload.cancelled === true) return { tone: 'ok', text: t('feedback.cancelled') };
                  return { tone: 'warn', text: t('feedback.cancelNone') };
                });
              },
            }),
            h(ConfirmButton, {
              label: t('action.pauseAll'), t,
              title: t('hint.pauseAll'),
              confirmText: t('confirm.pauseAll'),
              busy: busy === 'panel:watchers', busyLabel: t('state.working'),
              disabled: lockOther('panel:watchers'),
              attrs: { 'data-dsw-action': 'panel:pauseAll' },
              onConfirm: function () {
                void run('panel:watchers', '/watchers', { action: 'pause' }, function (payload) {
                  return watchersFeedback(payload, 'pause', t);
                });
              },
            }),
            h(Button, {
              label: t('action.resumeAll'),
              busy: busy === 'panel:watchers', busyLabel: t('state.working'),
              disabled: lockOther('panel:watchers'),
              attrs: { 'data-dsw-action': 'panel:resumeAll' },
              onClick: function () {
                void run('panel:watchers', '/watchers', { action: 'resume' }, function (payload) {
                  return watchersFeedback(payload, 'resume', t);
                });
              },
            }),
            graphUi.url !== undefined
              ? h(LinkButton, {
                href: graphUi.url, label: t('action.openGraph'), tone: 'brand',
                title: t('graph.hint') + ' ' + graphUi.url,
              })
              : null,
            graphUi.state === 'disabled' ? h(Badge, { label: t('graph.disabled'), tone: 'neutral' }) : null,
            graphUi.state === 'invalid' ? h(Badge, { label: t('graph.invalid'), tone: 'warn' }) : null,
            graphUi.url !== undefined && graphUi.reachable === false
              ? h(Badge, { label: t('graph.unreachable'), tone: 'warn' })
              : null,
            graphUiNote !== undefined ? h('span', { style: { color: TOKEN.warn, fontSize: '11px' } }, graphUiNote) : null)),
      ),

      // P1-4：所有 POST 的結果都落在同一個 live region。
      feedback !== undefined
        ? h('div', {
          role: 'status',
          style: {
            color: feedback.tone === 'warn' ? TOKEN.warn : TOKEN.text,
            fontSize: '12px', minHeight: '18px',
          },
        }, feedback.text)
        : null,

      h(StatsBlock, { status, t }),

      h(ConfigBlock, {
        t,
        payload: configPayload,
        busy: busy === 'panel:config',
        onResetAll: handleResetAll,
        onResetField: handleResetField,
      }),

      h(HealthBlock, { status, warnings, caveats, t }),

      projects.length > 0
        ? h('div', { role: 'group', 'aria-label': t('label.filter'), style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
          chips.map(function (chip) {
            return h(Button, {
              key: 'chip:' + chip.id,
              label: chip.label + ' ' + String(chip.count),
              pressed: filter === chip.id,
              attrs: { 'data-dsw-action': 'chip:' + chip.id },
              onClick: function () { setFilter(chip.id); },
            });
          }))
        : null,

      projects.length === 0
        ? h('div', { style: { color: TOKEN.textDim, fontSize: '13px' } }, t('state.empty'))
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          filtered.length === 0
            ? h('div', { style: { color: TOKEN.textDim, fontSize: '13px' } }, t('state.emptyFiltered'))
            : null,
          filtered.map(function (project) {
            return h(ProjectCard, {
              key: project.key,
              project,
              t,
              busyKey: busy,
              onAction: handleAction,
            });
          })),

      showLog
        ? h('div', {
          style: {
            border: '1px solid ' + TOKEN.borderSoft, borderRadius: '10px', padding: '10px 12px',
            maxHeight: '320px', overflow: 'auto', background: TOKEN.surfaceAlt,
          },
        },
        h('div', { style: { color: TOKEN.textDim, fontSize: '12px', marginBottom: '6px' } }, t('label.log')),
        log.length === 0
          ? h('div', { style: { color: TOKEN.textDim, fontSize: '12px' } }, t('log.empty'))
          : null,
        log.slice().reverse().map(function (entry, index) {
          const event = entry ?? {};
          const tone = event.level === 'error' ? TOKEN.error : (event.level === 'warn' ? TOKEN.warn : TOKEN.textDim);
          let detail = '';
          if (event.detail !== undefined && event.detail !== null) {
            try {
              detail = JSON.stringify(event.detail) ?? '';
            } catch {
              detail = String(event.detail);
            }
          }
          return h('div', {
            key: 'log:' + String(event.seq ?? index),
            style: { fontFamily: TOKEN.mono, fontSize: '11px', color: TOKEN.textDim, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
          },
          h('span', { style: { color: tone } }, String(event.at) + ' ' + String(event.level) + ' ' + String(event.event)),
          detail.length > 2 ? ' ' + detail : '');
        }))
        : null,
      );
    }

    /**
     * 把一份 `/state` 收斂成「值不值得打擾使用者」。
     *
     * 只認兩種訊號：已確認落後（warn）與失敗（error：孤兒、上次重建錯誤、
     * 監看 failed、上次掃描失敗）。`stale === null` 的「無法判定」不算——那在
     * 非 git 專案上是常態，拿它常駐一個黃點只是製造噪音。
     * @param {object} payload - `/state` 回應。
     * @param {Function} t - 翻譯函式。
     * @returns {{tone: string, stale: number, failed: number, scanFailed: boolean, label: string, text: string}|undefined}
     *   沒有問題時回 undefined（＝什麼都不畫）。
     */
    function summarizeGraphState(payload, t) {
      const status = payload?.status ?? {};
      const projects = Array.isArray(payload?.projects) ? payload.projects : [];
      let stale = 0;
      let failed = 0;
      for (const project of projects) {
        if (project.orphaned === true
          || optionalText(project.lastError) !== undefined
          || (project.watcher ?? {}).status === 'failed') {
          failed += 1;
        } else if (project.stale === true) {
          stale += 1;
        }
      }
      const scanFailed = optionalText(status.lastRefreshError) !== undefined;
      if (stale === 0 && failed === 0 && scanFailed !== true) return undefined;
      const parts = [];
      if (stale > 0) parts.push(String(stale) + ' ' + t('badge.stale'));
      if (failed > 0) parts.push(String(failed) + ' ' + t('badge.failed'));
      if (scanFailed === true) parts.push(t('badge.scanFailed'));
      const total = stale + failed;
      return {
        tone: failed > 0 || scanFailed === true ? 'error' : 'warn',
        stale,
        failed,
        scanFailed,
        label: t('badge.label') + ': ' + parts.join(' · '),
        text: total > 0 ? String(total) : '!',
      };
    }

    /**
     * 常駐狀態指示：掛在 `sidebar.footer.action`（kind=list、replaceRisk=none）。
     *
     * **安靜是預設**：全部新鮮時不渲染任何東西，不常駐一個綠點。
     * **非互動**：DSH 沒有把「開啟設定並跳到某個 section」開放給這個 slot——
     * `openSettings`／`openSection` 只是 `settings.launcher`／`settings.onboarding`
     * 的 owner prop（packages/client/ui-settings/src/client/contract/slots.ts:140,152），
     * 而本 slot 的 owner prop 只有 `wide`。因此不自己造跳轉，改把具體數字放進
     * title／aria-label。
     * @param {object} props - t（翻譯）與 wide（owner prop：側邊欄是否展開）。
     * @returns {object|null} React 元素。
     */
    function StatusIndicator(props) {
      const t = props.t;
      const [state, setState] = React.useState(undefined);

      React.useEffect(function () {
        let alive = true;
        let timer;
        let delay = BADGE_POLL_MS;

        function clearTimer() {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
        }

        function schedule(wait) {
          clearTimer();
          if (!alive) return;
          timer = setTimeout(tick, wait);
        }

        function apply(ok) {
          delay = ok === true ? BADGE_POLL_MS : Math.min(delay * 2, BADGE_POLL_MAX_MS);
          schedule(delay);
        }

        function load() {
          return api('/api/codebase-watcher/state?log=0', undefined, t)
            .then(function (payload) {
              setState(summarizeGraphState(payload, t));
              return true;
            })
            .catch(function () {
              // 抓不到就維持上一次的判斷：連線抖動不該讓常駐指示自己製造噪音。
              return false;
            });
        }

        function tick() {
          timer = undefined;
          if (!alive) return;
          if (pageHidden() === true) {
            delay = BADGE_POLL_MS;
            schedule(BADGE_POLL_MS);
            return;
          }
          void load().then(function (ok) {
            if (alive) apply(ok);
          });
        }

        function onVisibility() {
          if (!alive) return;
          if (pageHidden() === true) {
            clearTimer();
            return;
          }
          delay = BADGE_POLL_MS;
          clearTimer();
          tick();
        }

        void load().then(function (ok) {
          if (alive) apply(ok);
        });

        const doc = pageDocument();
        if (doc !== undefined && typeof doc.addEventListener === 'function') {
          doc.addEventListener('visibilitychange', onVisibility);
        }
        return function () {
          alive = false;
          clearTimer();
          if (doc !== undefined && typeof doc.removeEventListener === 'function') {
            doc.removeEventListener('visibilitychange', onVisibility);
          }
        };
      }, [t]);

      if (state === undefined) return null;
      const tone = state.tone === 'error' ? TOKEN.error : TOKEN.warn;
      // 側邊欄兩種寬度都要成立：展開時是一顆藥丸（圓點＋數字），收合成 56px
      // 軌道時只留圓點——軌道的控制盒是 36×36、同排還有別的住戶，數字塞不下，
      // 完整句子仍在 title／aria-label 裡。`flex: 0 0 auto` 讓它不被壓扁。
      const wide = props.wide === true;
      return h('span', {
        role: 'status',
        'aria-live': 'polite',
        'aria-label': state.label,
        title: state.label,
        'data-dsw-indicator': state.tone,
        style: wide
          ? {
            display: 'inline-flex', alignItems: 'center', gap: '5px', flex: '0 0 auto',
            height: '26px', padding: '0 9px', borderRadius: '999px',
            border: '1px solid ' + TOKEN.border, background: TOKEN.surfaceAlt,
            color: TOKEN.text, fontSize: '11px', lineHeight: '1', whiteSpace: 'nowrap',
          }
          : {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            flex: '0 0 auto', width: '20px', height: '36px',
          },
      },
      h('span', {
        'aria-hidden': 'true',
        style: {
          width: wide ? '8px' : '10px', height: wide ? '8px' : '10px',
          borderRadius: '50%', background: tone, flex: '0 0 auto',
        },
      }),
      wide ? h('span', null, state.text) : null);
    }

    /**
     * /rebuild 的回應 → 回饋訊息。回應沒有 note 時，用 queued／requested 自己組。
     * @param {object} payload - 回應。
     * @param {Function} t - 翻譯函式。
     * @returns {{text: string, tone: string}} 回饋。
     */
    function rebuildFeedback(payload, t) {
      if (typeof payload.note === 'string' && payload.note.length > 0) {
        return { tone: 'ok', text: payload.note };
      }
      const queued = typeof payload.queued === 'number' ? payload.queued : undefined;
      const requested = typeof payload.requested === 'number' ? payload.requested : undefined;
      if (queued === undefined) return { tone: 'ok', text: t('feedback.done') };
      if (queued === 0) return { tone: 'warn', text: t('feedback.queuedNone') };
      const suffix = requested === undefined ? '' : ' / ' + String(requested);
      return {
        tone: 'ok',
        text: t('feedback.queued') + ' ' + String(queued) + ' ' + unit(t, queued, 'unit.rebuild.one', 'unit.rebuild.many') + suffix,
      };
    }

    /**
     * /watchers 的回應 → 回饋訊息。
     * @param {object} payload - 回應。
     * @param {string} action - pause 或 resume。
     * @param {Function} t - 翻譯函式。
     * @returns {{text: string, tone: string}} 回饋。
     */
    function watchersFeedback(payload, action, t) {
      const affected = typeof payload.affected === 'number' ? payload.affected : 0;
      if (affected === 0) return { tone: 'warn', text: t('feedback.none') };
      return {
        tone: 'ok',
        text: (action === 'pause' ? t('feedback.paused') : t('feedback.resumed'))
          + ' ' + String(affected) + ' ' + unit(t, affected, 'unit.watcher.one', 'unit.watcher.many'),
      };
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(function () {
          return ctx.locale.register(NS, { zh, en });
        }, 'dsh-codebase-watcher: dictionaries');
        const t = ctx.locale.bind(NS);

        ctx.effect(function () {
          return ctx.slots.inject('settings.section', function () {
            return ctx.slots.register({
              name: 'settings.section',
              id: 'codebase-watcher',
              order: 14,
              label: function () { return t('section.label'); },
              locale: NS,
              inject: function () { return {}; },
            }, function Section() {
              return h(Panel, { t });
            });
          });
        }, 'dsh-codebase-watcher: settings section');

        // 常駐狀態指示：sidebar footer 的 list slot，replaceRisk=none（不會蓋掉
        // 既有條目；同一個 list 上的既有住戶是 ui-cordis 的 cordis-panel）。
        ctx.effect(function () {
          return ctx.slots.inject('sidebar.footer.action', function () {
            return ctx.slots.register({
              name: 'sidebar.footer.action',
              id: 'codebase-watcher-status',
              order: 20,
              locale: NS,
              inject: function () { return {}; },
            }, function StatusEntry(props) {
              return h(StatusIndicator, { t, wide: props.wide === true });
            });
          });
        }, 'dsh-codebase-watcher: sidebar status indicator');
      },
    };
  },
});
