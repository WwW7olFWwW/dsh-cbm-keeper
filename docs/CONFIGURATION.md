# 設定與控制面

## 設定欄位

所有欄位都可以寫在 `cordis.patch.yml`，也可以在設定頁改；改完立刻生效，不用重啟。

| 欄位 | 預設 | 作用 |
|---|---|---|
| `enabled` | `true` | 總開關。關閉只停自動化（掃描／監看／自動重建），路由與設定頁仍可用。 |
| `cliPath` | `''` | CBM 執行檔絕對路徑。留空＝依序找 `CBM_BIN` → `PATH` → 平台常見路徑。 |
| `mode` | `full` | 重建模式：`fast` / `moderate` / `full`。 |
| `rebuildTimeoutSeconds` | `1800` | 單次重建逾時。 |
| `scanMinutes` | `5` | 掃描上游專案與落後狀態的間隔。 |
| `watchEnabled` | `true` | 是否建立每專案檔案監看。 |
| `debounceMs` | `3000` | 監看防抖；同一批存檔只算一次重建。 |
| `rebuildCooldownSeconds` | `45` | 同一個專案兩次自動重建之間的最短間隔（秒）；`0` 關閉冷卻。人工與強制重建不受此限。 |
| `autoRebuild` | `true` | 偵測到落後時自動重建。關閉後只回報。 |
| `includeDirty` | `true` | 把未提交變更也算成落後。不過掃描觸發的重建只在該專案自上次成功重建後又有檔案活動時才排入：光是有未提交變更、卻沒有新存檔，不會週期性重跑。 |
| `nice` | `10` | 重建子行程的 nice 值。 |
| `maxLogEntries` | `500` | 記憶體保留的日誌筆數。檔案日誌單檔上限 5 MB，超過會輪替成 `keeper.log.1`（只保留一份）。 |
| `extensions` | `''` | 監看的副檔名白名單，逗號分隔。留空＝內建清單；`*`＝不過濾。 |
| `excludes` | `''` | 監看排除的目錄名，逗號分隔。留空＝內建清單。 |
| `includeProjects` | `''` | 只納管這些專案名。留空＝全部。 |
| `excludeProjects` | `''` | 排除這些專案名。 |
| `graphUrl` | `''` | CBM 圖譜 UI 的來源網址（只收 `http(s)://`）。留空＝由 CBM 的 `ui_port` 推導成 `http://127.0.0.1:<port>`；遠端或反向代理情境在此覆寫。 |

## 用 curl 讀寫設定

```sh
curl -s http://127.0.0.1:3080/api/codebase-watcher/config
curl -s -X POST http://127.0.0.1:3080/api/codebase-watcher/config -H 'content-type: application/json' -d '{"scanMinutes":10}'
```

`GET /config` 回三個欄位：`config` 是**可以改一改直接 POST 回來**的那一份（欄位名就是上表的名字；清單類欄位填逗號分隔字串），`runtime` 是執行期形狀（`scanMs`、`rebuildTimeoutMs` 等毫秒值，清單已拆成陣列）只供觀測，`upstream` 是 CBM 自己的 `config list`。欄位名寫錯（例如把 `scanMinutes` 寫成 `scanMs`）不會生效，啟動時會在日誌留一筆 `config.unknown-keys`。

## 圖譜 UI 的連結

CBM 自帶一個 HTTP 圖譜介面（`codebase-memory-mcp --ui=true`，預設埠 9749）。卡片會把它接進來，依上游狀態顯示三種結果：

| 狀態 | 卡片顯示 | 連結 |
|---|---|---|
| CBM 的 `ui_enabled=false` | 「CBM 圖譜 UI 未啟用：執行 codebase-memory-mcp --ui=true」 | 不給 |
| 啟用但 `GET /api/ui-config` 沒回應 | 「圖譜 UI 未回應」 | 給（但標明未回應） |
| 啟用且可連 | 標題列的「開啟圖譜」與每個專案列的「圖譜」 | 給 |

專案列的連結是深連結（`?project=<name>&tab=graph`），會直接開到該專案的圖。本插件不會代改 CBM 的 `ui_enabled`，那個開關屬於上游設定。

探測是每輪掃描一次、對 `127.0.0.1` 的一次 GET（1 秒逾時），不會隨 UI 重繪重打。

## REST 控制面

路由與 UI 同源：卡片上的每個動作都能用 curl 打，兩邊看到同一份資料。
全部走 DSH 既有的 `webServer`，繼承它的 loopback-only 綁定，不另開監聽埠。

| 方法 | 路徑 | 說明 |
|---|---|---|
| `GET` | `/api/codebase-watcher/state?log=100` | 全域狀態 + 專案表 + 不可靠宣告說明 + 最近日誌 |
| `GET` | `/api/codebase-watcher/log?limit=200` | 只要日誌 |
| `POST` | `/api/codebase-watcher/check` | `{}`＝整批重掃；`{"id":"<root>"}`＝只檢查一個 |
| `POST` | `/api/codebase-watcher/rebuild` | `{"id":…}` / `{"staleOnly":true}` / `{"mode":"fast"}` / `{"force":true}`；不帶 `id` 且帶 `force:true`＝全部強制重建 |
| `POST` | `/api/codebase-watcher/cancel` | 取消目前正在跑的重建（`{"cancelled":true/false}`） |
| `POST` | `/api/codebase-watcher/watchers` | `{"action":"pause"\|"resume", "id"?:…}` |
| `GET` | `/api/codebase-watcher/config` | 讀取目前設定（`config` 可寫、`runtime` 觀測、`upstream` 是 CBM 的設定） |
| `POST` | `/api/codebase-watcher/config` | 寫入設定（上表的欄位名 → 新值；`null` 表示回退預設） |

`check`／`rebuild`／`watchers` 帶不存在的 `id` 會回 **404**；`id` 是專案的絕對路徑（`GET /state` 的 `projects[].key`），不是卡片上顯示的名字。

`rebuild` 預設**不帶 force**：圖譜 HEAD 與工作樹一致時回 `queued: 0`，不產生任何索引工作。要無條件重跑請帶 `force: true`。
