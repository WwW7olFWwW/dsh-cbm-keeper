# Changelog

本檔格式依 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，
版本號依 [Semantic Versioning](https://semver.org/lang/zh-TW/)。

## [Unreleased]

## [0.1.0] - 2026-10-04

首個公開發布。此版本在本機完整安裝環境上逐項驗證過（見 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) 的「驗證現況」）。

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
- **REST 控制面** `/api/cbm-keeper/{state,log,check,rebuild,watchers,config}`，
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
- 單元測試 106 項，`node --test "test/*.test.js"` 全綠，不需要真的索引；CI 在 Node 20／22／24
  與「有／沒有 chokidar」六種組合上跑，且在沒有安裝 DSH 的機器上也能全綠（解析路徑用夾具驗證）。

[Unreleased]: https://github.com/WwW7olFWwW/dsh-cbm-keeper/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/WwW7olFWwW/dsh-cbm-keeper/releases/tag/v0.1.0
