# 安全性政策

## 回報管道

請**不要**開公開 issue。用 GitHub 的
[私人安全回報](https://github.com/WwW7olFWwW/dsh-codebase-watcher/security/advisories/new)，
或寄信到維護者 GitHub 個人檔案上的聯絡信箱。

三天內會收到第一次回覆。修好之前請先不要公開細節。

## 這個插件會做什麼

要判斷安全性影響，先看它的實際行為：

- **會執行子行程。** 重建索引是呼叫外部 CLI：`codebase-memory-mcp cli index_repository`。
  執行檔的路徑來自 `cliPath` 設定，留空時依序找 `CBM_BIN` 環境變數、`PATH`、
  平台常見安裝路徑。子行程以 `nice` 值執行，逾時上限由 `rebuildTimeoutSeconds` 控制。
  **`cliPath` 是可以指向任意執行檔的**——那等同於你在設定頁上授權執行它。
- **會讀取檔案系統。** 對每個已納管的專案建立檔案監看（chokidar，缺席時退回
  `node:fs.watch`），讀取範圍就是那些專案樹，套用 `extensions`／`excludes` 過濾。
  它也會讀取 `~/.cache/codebase-memory-mcp/` 下資料庫的 mtime。
- **會寫入。** 只寫自己的狀態目錄 `~/.dsh/codebase-watcher/`（`state.json` 與輪替的
  `keeper.log`）。不寫專案樹、不改 CBM 設定、不動 profile 的 `cordis.patch.yml`。
- **會開 HTTP 路由。** `/api/codebase-watcher/{state,log,check,rebuild,cancel,watchers,config}`
  掛在 DSH 既有的 `webServer` 上，繼承它 **loopback-only** 的綁定，不另開監聽埠。
  這組路由**沒有自己的身分驗證**，信任邊界就是 DSH 的 web server：能連到那個埠的人
  就能讀設定、觸發重建、取消重建。請不要把 DSH 的 web server 暴露到不可信網路。
- **會對外連線。** 只在探測 CBM 圖譜 UI 時，對 `127.0.0.1` 發一次 GET（1 秒逾時）。
  `graphUrl` 可以覆寫成別的來源，那是你自己的選擇。除此之外不對外連線。

## 不在範圍內

- Codebase Memory 本體與 DSH 本體的安全問題——請回報給各自的上游。
- 「以家目錄為根的專案不被 CBM 監看」這類上游安全政策造成的行為差異。
- 你自己把 DSH web server 或 CBM 圖譜 UI 暴露到公開網路所導致的暴露。

## 支援的版本

只修最新的 minor 版本線。舊版請先升級再回報。
