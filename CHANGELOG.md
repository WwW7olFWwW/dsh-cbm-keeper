# Changelog

本檔格式依 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，
版本號依 [Semantic Versioning](https://semver.org/lang/zh-TW/)。

## [Unreleased]

### Changed

- **重建不再週期性重跑**：`includeDirty` 仍是預設開啟，但掃描觸發的重建只在該專案自上次成功重建後
  又有檔案活動時才排入。先前一個長期有未提交變更的專案會在每一輪掃描被重新索引一次，卻永遠追不上
  （實測 29.6 小時 145 次重建，其中 8 次被 CBM 以「重建途中檔案又變」中止）。
- 新增設定欄位 `rebuildCooldownSeconds`（預設 45）：同一個專案兩次自動重建的最短間隔；`0` 關閉。
  人工與強制重建不受冷卻限制。設定一改，掃描計時器與已建立的監看器會就地重套（不必暫停再恢復）。
- `GET /api/codebase-watcher/config` 改回三個欄位：`config`（可寫，欄位名與 POST 相同）、`runtime`
  （執行期形狀，觀測用）、`upstream`。先前只有執行期形狀，把它 POST 回去不會生效。
- `graphUrl` 填了非 http(s) 的值時，改為忽略該覆寫並退回由 `ui_port` 推導，卡片上會說明原因；
  先前會讓所有圖譜連結消失。

### Added

- `POST /api/codebase-watcher/cancel`：取消目前正在跑的重建；卡片上多了「全部強制重建」與
  「取消重建」兩顆按鈕。
- 日誌檔輪替：`keeper.log` 單檔上限 5 MB，超過輪替成 `keeper.log.1`（只保留一份）。
- 卡片可解釋性：顯示判定依據（`reasons`）、上次掃描失敗原因、監看失敗原因與圖譜 UI 的附註。

### Fixed

- 非 http(s)、或超界、或空字串的設定值不再靜默變成「最小值」或讓整條功能失效；寫錯欄位名會在
  啟動時留下 `config.unknown-keys` 日誌。
- `check`／`rebuild` 帶不存在的 `id` 改回 **404**，不再回 502 或「全部目標都與工作樹一致」的誤導訊息。
- 監看器的執行期錯誤（例如 inotify 用盡）會讓狀態變成 `failed` 並記下 `lastError`，不再停在
  「監看中」而存檔已經追不上。
- 讀不到 CBM 設定時保留錯誤並在卡片上說明；先前會被誤報成「圖譜 UI 未回應」。
- 重建失敗的訊息會攤平 CBM 的 `{status, hint}` 信封，不再把整段 JSON 印到卡片上。

## [0.2.0] - 2026-10-05

### Changed

- **專案更名為 `dsh-codebase-watcher`**（原 `dsh-cbm-keeper`）。**破壞性變更**：bundle patch 的 row id
  （`cbm-keeper` → `codebase-watcher`）、REST 路由前綴（`/api/cbm-keeper` → `/api/codebase-watcher`）、
  狀態目錄（`~/.dsh/cbm-keeper` → `~/.dsh/codebase-watcher`）與 npm 套件名一併更換。既有安裝請改用新
  套件名（見 README 的安裝一節）；狀態目錄換名後會在第一次掃描時重新建立，想保留歷史就先自行改名。
- 對外文檔移除本機調試殘留（精確時間戳、PID、「在 live 生效」這類一次性敘述、樣本倉庫的提交 sha），
  長期技術事實（例如 `link:` 安裝改動 `lib/` 後必須重啟才換代）改寫為通用表述保留。

### Added

- **圖譜 UI 連結**：卡片標題列的「開啟圖譜」與每個專案列的「圖譜」，直達 CBM 自帶的 HTTP 圖譜介面（專案列用 `?project=<name>&tab=graph` 深連結）。三態如實呈現：`ui_enabled=false` 時只顯示 `--ui=true` 的提示、探測不到時標明「UI 未回應」、可連才給連結；本插件不改上游的 `ui_enabled`。
- 新設定欄位 `graphUrl`（留空＝由 CBM 的 `ui_port` 推導）供遠端／反向代理情境覆寫；`GET /api/codebase-watcher/state` 的 `status.graphUi` 與每個專案的 `graphUrl` 對外可見。
- `tools/verify-keeper.mjs`：新增圖譜 UI 連結的四項檢查（共 23 項），並把寫死的專案名改成從真實清單挑樣本（可用 `node tools/verify-keeper.mjs <專案名>` 指定），另加 SKIP 統計。

## [0.1.0] - 2026-10-04

首個公開發布。此版本在一台完整安裝的 DSH 上逐項驗證過（見 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) 的「驗證現況」）。

### Added

- **專案身分以 `realpath(root_path)` 為唯一鍵**：同一棵樹的別名（`list_projects` 的 `name`
  與路徑派生名）合併為一列，不再重複計算落後。
- **落後判定雙判據**：主判據 `Branch.head_sha` 對 `git rev-parse HEAD`（`confidence=head`，
  給精確 `behindBy`）；退路為 `indexed_at`／DB mtime 對 HEAD 提交時間（`confidence=time`）。
  證據不足時 `stale=null`，UI 顯示「無法判定」，不會被誤判為新鮮。
- **條件式重建**：只有落後的專案才排入佇列，全域併發 1；圖譜已對上 HEAD 時
  `POST /rebuild` 回 `queued: 0`，不產生任何索引工作。
- **重建走 CLI 而非 MCP**：以子行程呼叫 `codebase-memory-mcp cli index_repository`，
  不受 MCP 工具 60 秒上限約束。
- **每專案檔案監看**：chokidar 優先，缺席時退回 `node:fs.watch`（recursive），
  防抖後觸發重建。
- **設定頁觀測卡片**（設定 →「CBM 圖譜」）：CLI 路徑／版本、兩個 HEAD、落後量、
  監看狀態、具名警告，以及四條「不可作為證據」的結構宣告。
- **REST 控制面** `/api/codebase-watcher/{state,log,check,rebuild,watchers,config}`，
  與 UI 同源、繼承 DSH `webServer` 的 loopback-only 綁定，不另開監聽埠。
- **可配置欄位**：`enabled`、`cliPath`、`mode`、`rebuildTimeoutSeconds`、`scanMinutes`、
  `watchEnabled`、`debounceMs`、`autoRebuild`、`includeDirty`、`nice`、`maxLogEntries`、
  `extensions`、`excludes`、`includeProjects`、`excludeProjects`（全部 volatile，寫入即生效）。
- **原子狀態檔與崩潰恢復**：`rebuild` 意圖落檔，重啟後 `recoverIntent()` 重新排入。
- **`stop()` 是真正的 join**：卸載時等執行中的重建收尾（先 abort 子行程，上限 15 秒），
  避免遲到的落盤在移除後還原狀態目錄。

### Notes

- 不改 CBM 本體、不改 DSH 本體、不安裝 systemd timer；安裝 bundle 不覆寫 profile 既有的
  `cordis.patch.yml`。
- 單元測試 115 項，`node --test test/*.test.js` 全綠，不需要真的索引；CI 在 Node 20／22／24
  與「有／沒有 chokidar」六種組合上跑，且在沒有安裝 DSH 的機器上也能全綠（解析路徑用夾具驗證）。

[Unreleased]: https://github.com/WwW7olFWwW/dsh-codebase-watcher/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/WwW7olFWwW/dsh-codebase-watcher/releases/tag/v0.1.0
