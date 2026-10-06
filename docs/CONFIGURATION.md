# 設定與控制面

## 設定欄位

所有欄位都可以寫在 `cordis.patch.yml`，也可以在設定頁改；改完立刻生效，不用重啟。
改過的欄位可以還原：`POST /config` 的 `reset`（或卡片上的「恢復預設」）會把值退回預設。
**它只清掉你改過的那些欄位**（就是 `GET /config` 回報的 `overridden`），沒改過的不動——不是原廠重設。

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
| `dirtySettleSeconds` | `90` | 只因為「有未提交變更」而落後的專案，要**安靜這麼久**才排重建（秒）：一直有存檔就一直往後推，真的停手 90 秒才重建一次。`0`＝關閉 settle 視窗，回到「一有活動就重建」。**真正的 HEAD 落後、人工與強制重建、崩潰恢復都不受此限**，仍然即時。 |
| `autoRebuild` | `true` | 偵測到落後時自動重建。關閉後只回報。 |
| `includeDirty` | `true` | 把未提交變更也算成落後。不過掃描觸發的重建只在該專案自上次成功重建後又有檔案活動時才排入：光是有未提交變更、卻沒有新存檔，不會週期性重跑。 |
| `nice` | `10` | 重建子行程的 nice 值。 |
| `maxLogEntries` | `500` | 記憶體保留的日誌筆數。檔案日誌單檔上限 5 MB，超過會輪替成 `keeper.log.1`（只保留一份）。 |
| `extensions` | `''` | 監看的副檔名白名單，逗號分隔。留空＝內建清單；`*`＝不過濾。 |
| `excludes` | `''` | 監看排除的目錄名，逗號分隔。留空＝內建清單。 |
| `includeProjects` | `''` | 只納管這些專案名。留空＝全部。 |
| `excludeProjects` | `''` | 排除這些專案名。 |
| `graphUrl` | `''` | CBM 圖譜 UI 的來源網址（只收 `http(s)://`）。留空＝由 CBM 的 `ui_port` 推導成 `http://127.0.0.1:<port>`；遠端或反向代理情境在此覆寫。 |

### 什麼情況下該調 `dirtySettleSeconds`

預設 `90` 已經處理掉最常見的壞情況——一邊編輯、一邊被重建追著跑，每一輪都在途中被中止，圖譜永遠追不上。
多數部署不需要動它。會想動通常是這三種：

- **就是要每次存檔都重建**：設 `0`，等於關掉 settle 視窗，回到 0.3.0 的行為。代價是編輯期間的重建會在途中被中止（README 有 A/B 對照）。
- **專案很大、想更省**：調大（例如 `300`）。代價是停手之後要等更久圖譜才追上。
- **想先看數字再決定**：`GET /state` 的 `status.stats` 有 `last24hRebuildsAborted` 與 `last24hRebuildsSucceeded`。

把值設成 `0` 之後，如果插件**實際觀察到**重建在途中被中止（最近 24 小時 ≥ 3 次，且佔已完成嘗試的一半以上），
它會丟一條具名警告 `dirty-chase-detected`，附上你自己的數字。**沒有觀察到就不會出現**，
所以維持預設或調大的部署不會被嘮叨。改壞了就用 `reset` 退回預設（見下面「恢復預設（`reset`）」）。

## 成效統計（`stats`）

`GET /state` 的 `status.stats` 是 **20 個扁平數字**，`status.statsSince` 是它的起算時間。
十個概念各給兩個鍵：

| 概念 | 說明 |
|---|---|
| `RebuildsQueued` | 排進佇列的次數（含人工與強制重建） |
| `RebuildsSucceeded` | 跑完且上游回報成功（含「成功但 HEAD 沒追上」，那另有警告） |
| `RebuildsFailed` | 跑完但失敗，**不含**被中止的 |
| `RebuildsAborted` | 錯誤命中 `aborted_previous_preserved`：「重建途中檔案又變」的直接指標。與 `RebuildsFailed` 互斥，相加才是全部失敗嘗試 |
| `SkippedCooldown` | 冷卻期擋下的自動重建（＝省下的重建） |
| `SkippedGate` | 掃描閘門擋下的次數（沒有活動／尚未靜默），每輪掃描各計一次 |
| `Settled` | 走完 settle 視窗、最後真的排入的重建 |
| `SettleDeferred` | 觸發被往後推（武裝／重排 settle 計時器）的次數 |
| `ChecksShortCircuited` | settle 視窗內只做 HEAD 探測而省下的完整檢查次數 |
| `RebuildMs` | 累計重建 wall time（毫秒，插件自己量的） |

**`sinceStart*` 是「本次行程啟動以來」，不是歷史總計。** 命名是刻意的：日誌檔 5 MB 就輪替、
只保留一份 `.1`，從那種檔案回填出來的「歷史」本身殘缺，標成歷史比標成啟動以來更容易誤導。
`last24h*` 是滾動 24 小時的近似（邊界誤差最多 1 小時），行程剛啟動時它與 `sinceStart*` 相同；
兩者都只在記憶體、不落盤。要看長期趨勢請自己定期抓 `last24h*`。

## 用 curl 讀寫設定

```sh
curl -s http://127.0.0.1:3080/api/codebase-watcher/config
curl -s -X POST http://127.0.0.1:3080/api/codebase-watcher/config -H 'content-type: application/json' -d '{"scanMinutes":10}'
```

`GET /config` 回五個欄位：`config` 是**可以改一改直接 POST 回來**的那一份（欄位名就是上表的名字；清單類欄位填逗號分隔字串），`runtime` 是執行期形狀（`scanMs`、`rebuildTimeoutMs` 等毫秒值，清單已拆成陣列）只供觀測，`upstream` 是 CBM 自己的 `config list`，`defaults` 是每個欄位的預設值，`overridden` 是被你改過的欄位名陣列（沒改過就是空的）。欄位名寫錯（例如把 `scanMinutes` 寫成 `scanMs`）不會生效，啟動時會在日誌留一筆 `config.unknown-keys`。

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

下表是 **7 條路徑、8 個方法端點**——`/config` 同時有 `GET` 與 `POST`，所以看起來多一列。

| 方法 | 路徑 | 說明 |
|---|---|---|
| `GET` | `/api/codebase-watcher/state?log=100` | 全域狀態（含 `stats`／`statsSince`）＋專案表＋不可靠宣告說明＋最近日誌 |
| `GET` | `/api/codebase-watcher/log?limit=200` | 只要日誌 |
| `POST` | `/api/codebase-watcher/check` | `{}`＝整批重掃；`{"id":"<root>"}`＝只檢查一個 |
| `POST` | `/api/codebase-watcher/rebuild` | `{"id":…}` / `{"staleOnly":true}` / `{"mode":"fast"}` / `{"force":true}`；不帶 `id` 且帶 `force:true`＝全部強制重建 |
| `POST` | `/api/codebase-watcher/cancel` | 取消目前正在跑的重建（`{"cancelled":true/false}`） |
| `POST` | `/api/codebase-watcher/watchers` | `{"action":"pause"\|"resume", "id"?:…}` |
| `GET` | `/api/codebase-watcher/config` | 讀取目前設定（`config` 可寫、`runtime` 觀測、`upstream` 是 CBM 的設定、`defaults` 是預設值、`overridden` 是被改過的欄位） |
| `POST` | `/api/codebase-watcher/config` | 寫入設定（上表的欄位名 → 新值；`null` 表示回退該欄位預設），或用 `reset` 恢復預設 |

`check`／`rebuild`／`watchers` 帶不存在的 `id` 會回 **404**；`id` 是專案的絕對路徑（`GET /state` 的 `projects[].key`），不是卡片上顯示的名字。

`rebuild` 預設**不帶 force**：圖譜 HEAD 與工作樹一致時回 `queued: 0`，不產生任何索引工作。要無條件重跑請帶 `force: true`。

### 恢復預設（`reset`）

`POST /config` 除了逐欄賦值，還收一個 `reset`：

```sh
# 全部欄位恢復預設
curl -s -X POST http://127.0.0.1:3080/api/codebase-watcher/config -H 'content-type: application/json' -d '{"reset":true}'

# 只恢復其中一個欄位
curl -s -X POST http://127.0.0.1:3080/api/codebase-watcher/config -H 'content-type: application/json' -d '{"reset":["dirtySettleSeconds"]}'
```

**它是「恢復預設」不是「原廠重設」**：只清掉你改過的欄位，沒改過的不動。實際效果就是讓 `overridden` 重新變成空的。

`reset` 可以跟一般賦值同時出現——host **先 reset 再 set**，所以 `{"reset":true,"scanMinutes":10}` 的結果是
「其他都回預設，`scanMinutes` 是 10」。`reset` 陣列裡有不認識的欄位名會進回應的 `unknown[]`。

卡片上對應的是兩顆按鈕：「全部恢復預設」，以及每個被覆寫欄位旁邊的「恢復預設」。
