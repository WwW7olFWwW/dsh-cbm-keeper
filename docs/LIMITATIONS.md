# 已知限制與移除

## 已知限制

- **chokidar 是可選相依**。以 `link:` 方式安裝時 pnpm 不會把它的 optionalDependencies 裝進
  profile，此時監看自動退回 `node:fs.watch`（recursive），行為與語意相同，日誌會記一行
  `watcher.chokidar.unavailable` 說明原因。要強制使用 chokidar 就在插件目錄執行
  `pnpm add chokidar@^4`。
- **以家目錄為根的專案不支援 CBM 監看**（R5）：上游的安全政策會拒絕，這與本插件無關；
  本插件的監看是自己做的，不受該政策影響，但該專案的 CBM 圖譜仍只在本插件觸發重建時更新。
- **圖譜的結構宣告不可靠**（P8/P9/P16）。設定頁底部固定列出四條「不可作為證據」的宣告，
  這是刻意的標示而非功能缺陷。
- **尚無提交的倉庫**（`git` 還沒有第一個 commit）會被列為「無法判定」並附上 git 的原始錯誤訊息，不會被
  誤判為新鮮，也不會被自動重建。
- **上游消失的專案會留在清單上，標成「孤兒」**（`selected=false`、`orphaned=true`、監看停止），
  而不是被靜默移除——這樣你才看得到「它不見了」。孤兒只存在於記憶體，重啟即消失。
- **`stop()` 是真正的 join**：卸載時它會等正在跑的重建收尾（先 abort 子行程，上限 15 秒），
  所以 `remove_bundle` 之後立刻 `rm -rf ~/.dsh/cbm-keeper` 不會被遲到的落盤還原。
  中止的重建會留下一筆 `rebuild.abandoned` 日誌，狀態檔刻意停在 `running`／`queued`，
  讓下次啟動的 `recoverIntent()` 把它重新排入。
- **`@deepseek-ai/schemastery` 的解析路徑（兩個陷阱疊在一起）**：本插件以 `link:` 安裝時
  `import.meta.url` 指向這個目錄，從這裡往上走的 `node_modules` 鏈**到不了** profile；而
  `DSH_PROFILE_DIR` 只由 `dsh-shell-env` 注入**每一次模型 shell 呼叫的子行程**，載入插件的
  宿主行程裡並沒有它（實測 `dsh web` 的 `/proc/<pid>/environ` 完全沒有 `DSH_*`）。所以
  `lib/config.js` 的解析根順序是「環境有給的 profile → 自己 → cwd → **DSH home 底下的
  `profiles/*`（把真的 link 了本插件的那個排前面）**」，見 `schemasteryRequireRoots()` 與
  `profilePackageRoots()`。全部落空時 `Config` 會匯出成 `undefined`——插件照常運作，但該 entry
  不再「可配置」：設定頁與 `POST /config` 回 `No configurable plugin entry`，官方探針
  （`cordis_inspect_query`，provider `Config`、`method listConfigs`）回 `status: absent` 即是此症。
  設定服務只要求 `Config` 有 `toJSON` 且欄位是 volatile，而 volatile 參照用
  `Symbol.for('cosmokit.volatile.write')` 跨副本識別，因此用 profile 那一份編出來的 schema
  在 harness 自己的設定服務上完全可用（本機逐條驗過三道門：schema 可列舉、欄位可寫入、
  寫入後設定服務讀得到新值）。

## 移除

```bash
dsh plugin --profile web remove dsh-cbm-keeper
rm -rf ~/.dsh/cbm-keeper
rm -f ~/.dsh/profiles/web/node_modules/dsh-cbm-keeper   # 若殘留（見下）
```

第一行移除 bundle 註冊與套件相依；第二行清掉插件自己的狀態檔與日誌；第三行處理
pnpm 對 `link:` 套件的一個已知行為——它會把 `node_modules` 裡的符號連結留下，
即使 `package.json` 的相依已經移除。插件**不會**在卸載時自動刪除狀態目錄：
那只會讓每次重啟都丟掉歷史，代價比殘留大。

除此之外沒有其他落點：不寫專案樹、不改 CBM 設定、不動 `~/.cache/codebase-memory-mcp/`、
不動 profile 的 `cordis.patch.yml`（bundle 是以 patch 圖層疊上去的，安裝前後該檔逐位元組相同）。
