# 已知限制與移除

## 已知限制

- **chokidar 是可選相依。** 以 `link:` 安裝時 pnpm 不會把 optionalDependencies 裝進 profile，此時監看自動退回 `node:fs.watch`（遞迴），行為與語意相同，日誌會記一行 `watcher.chokidar.unavailable` 說明原因。要強制用 chokidar，就在插件目錄執行 `pnpm add chokidar@^4`。
- **以家目錄為根的專案，CBM 不會監看它。** 上游的安全政策會拒絕，這與本插件無關。本插件的監看是自己做的，不受該政策影響，但該專案的 CBM 圖譜仍只在本插件觸發重建時更新。
- **圖譜裡的結構宣告不能當證據。** 設定頁底部固定列出四條「不可作為證據」的宣告，那是標示，不是缺陷。
- **還沒有第一個 commit 的倉庫會顯示「無法判定」**，並附上 git 的原始錯誤訊息。它不會被當成新鮮，也不會被自動重建。
- **上游已經沒有的專案會留在清單上，標成「孤兒」**（`selected=false`、`orphaned=true`、監看停止），不會被靜默移除，這樣你才看得到它不見了。孤兒只存在記憶體，重啟即消失。
- **卸載時正在跑的重建會先收尾。** 插件會 abort 子行程並等它結束（上限 15 秒），所以 `remove_bundle` 之後立刻 `rm -rf ~/.dsh/codebase-watcher` 不會被遲到的落盤還原。被中止的重建留下一筆 `rebuild.abandoned` 日誌，狀態檔停在 `running`／`queued`，下次啟動時重新排入。

## 移除

```bash
dsh plugin --profile web remove dsh-codebase-watcher
rm -rf ~/.dsh/codebase-watcher
rm -f ~/.dsh/profiles/web/node_modules/dsh-codebase-watcher
```

第一行移除 bundle 註冊與套件相依；第二行清掉插件自己的狀態檔與日誌；第三行清的是 pnpm 對 `link:` 套件的已知殘留：`node_modules` 裡的符號連結不會跟著相依移除。

插件不會在卸載時自動刪除狀態目錄，需要你自己刪（就是上面第二行）。除此之外沒有其他落點：不寫專案樹、不改 CBM 設定、不動 `~/.cache/codebase-memory-mcp/`、不動 profile 的 `cordis.patch.yml`（bundle 是以 patch 圖層疊上去的，安裝前後該檔逐位元組相同）。
