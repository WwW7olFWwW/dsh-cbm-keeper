# 設定與控制面

## 設定欄位

設定欄位就是 Loader entry 的 Config（`cordis.patch.yml` 可寫，設定頁也改得動）。
每個欄位都是 `volatile`：寫入後就地生效，不重建 fiber、不重啟。

| 欄位 | 預設 | 作用 |
|---|---|---|
| `enabled` | `true` | 總開關。關閉只停自動化（掃描／監看／自動重建），路由與設定頁仍可用。 |
| `cliPath` | `''` | CBM 執行檔絕對路徑。留空＝依序找 `CBM_BIN` → `PATH` → 平台常見路徑。 |
| `mode` | `full` | 重建模式：`fast` / `moderate` / `full`。 |
| `rebuildTimeoutSeconds` | `1800` | 單次重建逾時。 |
| `scanMinutes` | `5` | 掃描上游專案與落後狀態的間隔。 |
| `watchEnabled` | `true` | 是否建立每專案檔案監看。 |
| `debounceMs` | `3000` | 監看防抖；同一批存檔只算一次重建。 |
| `autoRebuild` | `true` | 偵測到落後時自動重建。關閉後只回報。 |
| `includeDirty` | `true` | 把未提交變更也算成落後。 |
| `nice` | `10` | 重建子行程的 nice 值。 |
| `maxLogEntries` | `500` | 記憶體保留的日誌筆數（檔案日誌不受限）。 |
| `extensions` | `''` | 監看的副檔名白名單，逗號分隔。留空＝內建清單；`*`＝不過濾。 |
| `excludes` | `''` | 監看排除的目錄名，逗號分隔。留空＝內建清單。 |
| `includeProjects` | `''` | 只納管這些專案名。留空＝全部。 |
| `excludeProjects` | `''` | 排除這些專案名。 |
| `graphUrl` | `''` | CBM 圖譜 UI 的來源網址（只收 `http(s)://`）。留空＝由 CBM 的 `ui_port` 推導成 `http://127.0.0.1:<port>`；遠端或反向代理情境在此覆寫。 |

## 圖譜 UI 的連結

CBM 自帶一個 HTTP 圖譜介面（`codebase-memory-mcp --ui=true`，預設埠 9749）。卡片會把它接進來，三態如實呈現：

| 狀態 | 卡片顯示 | 連結 |
|---|---|---|
| CBM 的 `ui_enabled=false` | 「CBM 圖譜 UI 未啟用：執行 codebase-memory-mcp --ui=true」 | 不給 |
| 啟用但 `GET /api/ui-config` 沒回應 | 「圖譜 UI 未回應」 | 給（但標明未回應） |
| 啟用且可連 | 標題列的「開啟圖譜」與每個專案列的「圖譜」 | 給 |

專案列的連結是深連結（`?project=<name>&tab=graph`），會直接開到該專案的圖。本插件**不會**替你改 CBM 的 `ui_enabled`——那個開關屬於上游設定。

探測是每輪掃描一次、對 `127.0.0.1` 的一次 GET（1 秒逾時），不會隨 UI 重繪重打。

## REST 控制面

路由與 UI 同源：卡片上的每個動作都能用 curl 打，兩邊看到同一份資料（FR-12）。
全部走 DSH 既有的 `webServer`，繼承它的 loopback-only 綁定，不另開監聽埠。

| 方法 | 路徑 | 說明 |
|---|---|---|
| `GET` | `/api/codebase-watcher/state?log=100` | 全域狀態 + 專案表 + 不可靠宣告說明 + 最近日誌 |
| `GET` | `/api/codebase-watcher/log?limit=200` | 只要日誌 |
| `POST` | `/api/codebase-watcher/check` | `{}`＝整批重掃；`{"id":"<root>"}`＝只檢查一個 |
| `POST` | `/api/codebase-watcher/rebuild` | `{"id":…}` / `{"staleOnly":true}` / `{"mode":"fast"}` / `{"force":true}` |
| `POST` | `/api/codebase-watcher/watchers` | `{"action":"pause"\|"resume", "id"?:…}` |
| `GET` | `/api/codebase-watcher/config` | 讀取目前設定 |
| `POST` | `/api/codebase-watcher/config` | 寫入設定（欄位 → 新值；`null` 表示回退預設） |

`rebuild` 預設**不帶 force**：圖譜 HEAD 與工作樹一致時回 `queued: 0`，不產生任何索引工作
（FR-3 的驗收條件）。要無條件重跑請帶 `force: true`。
