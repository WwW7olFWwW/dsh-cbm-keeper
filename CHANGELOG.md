# Changelog

本檔格式依 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，
版本號依 [Semantic Versioning](https://semver.org/lang/zh-TW/)。

## [Unreleased]

## [0.5.1] - 2026-10-07

> 這一版只修一個可發現性缺陷：設定區塊的說明**只說「用 DSH 的插件設定表單」，
> 卻沒說那個表單在哪**。使用者實際回報了這件事——「那麼是要到哪里修改」。

### Fixed

- **設定區塊的說明現在指出確切位置**：改為「要改值請到側邊欄『插件』→ 本插件那一列的
  設定，那裡由 DSH 依 schema 自動產生表單」。原本那句等於叫使用者去一個沒給座標的地方。
  位置是查證來的、不是推測：線上 Config 條目為 `dsh-codebase-watcher`（patch id
  `codebase-watcher`，`status: schema`），承載它的 slot 是 `plugins.row.config`，
  官方描述寫明「the row on the bundle's page gains a configure control that opens the
  entry's page」。英文文案本來就已寫對（`row under Plugins in the sidebar`），
  這一版只是讓中文追上——重拍後英文那張**同尺寸、同位元組數**，即為此事的證據。
- `docs/assets/capture-card.mjs` 兩個會**靜默失效**的缺陷：`parseArgs` 把布林旗標寫成
  特例，導致新增的 `--only-config` 會吃掉下一個參數且完全沒作用（第一次「只裁設定區塊」
  拍出來仍是整張卡）；展開後沒有重新量測，裁切高度停留在展開前的值而把卡片切掉。
  另把探針視窗高度從寫死的 1000 改為 `--probe-height`（預設 1600）——側邊欄工作區一多，
  底部那一列會被推出視窗，命中測試就點不到「设置」。

### Changed

- README 中英兩版各加一張**設定區塊展開**的截圖（`docs/assets/cbm-card-settings.png` /
  `-settings-en.png`），放在「設定」一節；hero 維持收合狀態。展開後整張卡會多出 18 列、
  在 GitHub 的欄寬下要滑好幾屏才看得到專案列，所以拆成兩張而不是塞進同一張。
  圖上是**真機真值**：`overridden` 為空，所以 18 列全部標「（預設）」、沒有任何單欄
  恢復鈕、「全部恢復預設」是停用的——沒有為了讓按鈕入鏡而改動使用者的設定。
  hero 兩張**刻意不重拍**，理由是實證而非目測：探針顯示收合狀態下那句 hint
  `hasHint: false`（根本不在 DOM 裡），hero 不可能拍到它。

### 驗證

- 單元測試 214/214；`tools/verify-client.mjs` 242/242——含一條**加強過的**斷言：
  文案必須同時出現「插件」與「設定」，避免它再被改回模糊版本。
- 獨立探針確認 GUI 語言仍為中文。

## [0.5.0] - 2026-10-07

> 這一版把「讓使用者自行決定」補成完整的三件套：**選項 ＋ 預設值 ＋ 重置**。
> 0.4.0 只做了第一件——`dirtySettleSeconds` 存在，但預設是 `0`，
> 等於那個欄位出現與否對大多數人沒有差別。這一版把它預設成**實測有效的那個值**。

### Changed

- **`dirtySettleSeconds` 的預設值由 `0` 改為 `90`**（行為變更）。升級之後，有未提交變更的
  專案不再「一有活動就重建」，改成**靜默 90 秒後重建一次**——也就是 0.4.0 那份 A/B 實測裡
  完全消除追逐的那個值（編輯期間的重建 10 → 0 次、被中止 10 → 0 次，停手後仍追上）。
  **不受影響的**：真正的 HEAD 落後、人工與強制重建、崩潰恢復，全部維持即時。
- `0` **仍是合法且有意義的值**：它關閉 settle 視窗、回到「一有活動就重建」，也就是 0.3.0 的
  行為。它同時是 `dirty-chase-detected` 警告的觸發條件——換了預設之後，那條警告的語意
  自然變成「**你主動選擇關掉**、而且真的觀察到追逐時才會提醒」。
- README 的設定一節補上「改壞了可以一鍵恢復預設（只清掉你改過的那些）」；
  [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) 的 `dirtySettleSeconds` 一列與
  「什麼情況下該調它」一段重寫（重點從「建議你去開它」變成「什麼情況下你該把它調掉」）。

### Added

- **設定重置**（單欄與全部兩種）：
  - `POST /config` 新增可選的 `reset` 鍵：`{"reset": true}` 恢復全部欄位、`{"reset": ["欄位名"]}`
    只恢復指定欄位；可與一般賦值同時出現（**先 reset 再 set**，所以同一欄位同時出現時賦值勝出）。
    未知欄位名照既有慣例列進回應的 `unknown[]`。實作走既有的 `{op:'unset'}` 路徑——清掉覆寫讓
    欄位落回 schema 的 `default()`，與宿主 `ConfigFormController.unset()` 是同一套語意。
  - `GET /config` 新增 `defaults`（與 `config` **同形狀**的預設值）與 `overridden`
    （目前值 ≠ 預設值的欄位名，排序）。`defaults` 走與 `config` 完全相同的正規化路徑，
    型別不會分岔。
  - 設定頁卡片新增「**設定**」區塊（成效 → 設定 → CLI 與上游）：**預設收起**，收起時也顯示
    「你改過 N 個欄位」徽章；展開後逐列顯示欄位名、目前值、被覆寫者的預設值，以及
    **單欄「恢復預設」**；頂端一顆**「全部恢復預設」**（行內兩段式確認，沒有覆寫時為 disabled）。
    未覆寫的欄位只標「（預設）」、不給按鈕（不給按了沒事的死按鈕）。
    舊 host 沒有 `defaults`／`overridden` 時整塊不渲染。
  - 文案刻意寫成「恢復**預設值**」而不是「原廠重設」——它只清掉你改過的欄位，不動別的。

### Fixed

- **成效區塊的數字會被省略號吃掉**：窄欄下「失敗 7（其中 7 次被中止）」被截成
  「失敗 7（其中 7 次…」，而那塊存在的理由正是那些數字。已讓欄位支援換行不省略。
- **`reset` 這個指令鍵本身一度被當成未知欄位回報**（`unknown: ['nope','reset']`），
  等於每一次重置都會回報一個不存在的問題、UI 會顯示假警告。已排除。

### 驗證

- 單元測試 **204 → 214**，`node --test test/*.test.js` 全綠。
- `tools/verify-keeper.mjs` 23/23；`tools/verify-client.mjs` **212 → 242**。
- `node tools/bench-dirty-chase.mjs --assert --settle 90` 斷言通過——改預設沒有動到 settle 行為本身。

## [0.4.0] - 2026-10-07

> 這一版由一次四維度審查（程式碼品質／效能／UI-UX／產品市場）驅動，共 8 條工作流。
> **最重要的一件事**：0.3.0 的「45 秒冷卻」只把重建風暴壓低頻率，沒有治好它——實測顯示
> 一個正在被編輯的專案仍然每 52 秒燒掉一次完整重建，而且**每一次都在重建途中被中止，
> 圖譜從頭到尾沒有追上過**。這一版給出可重現的量測工具與根治手段。

### 量測：`npm run bench`

新增 `tools/bench-dirty-chase.mjs`——用真的 `CbmKeeper`、真的 `node:fs.watch`、真的計時器，
把 git 探針／CBM CLI／重建本身換成可計數的注入替身，模擬「連續編輯 20 秒、50 次存檔，然後停手」。
時間參數等比壓縮約 1/30（比例不變，可外推），重建替身忠實重現 CBM 的
`aborted_previous_preserved` 行為。零外部相依、可重跑、可進 CI。

同一支工具在 0.3.0 與 0.4.0 上的對照（`node tools/bench-dirty-chase.mjs`）：

| | 0.3.0 | 0.4.0（`dirtySettleSeconds: 90`） |
|---|---|---|
| 編輯期間的重建 | 10 次 | **0 次** |
| 重建成功 | **0 次** | **1 次** |
| 被 `aborted_previous_preserved` 中止 | 10 次 | **0 次** |
| 停手後追上圖譜 | **沒有追上** | 追上 |
| 注入探針呼叫 | 214 | **66**（−69%） |
| 　其中 CBM CLI | 112 | **9**（−92%） |

### Added

- **設定欄位 `dirtySettleSeconds`（預設 `0`＝維持原行為）**：未提交變更的專案要靜默幾秒才重建。
  設成 `90` 可讓「編輯期間的重建」從 10 次降到 0 次、被中止從 10 次降到 0 次，圖譜仍在停手後追上。
  **預設刻意留 0**：這是行為變更，決定權在部署者。
- **具名警告 `dirty-chase-detected`**：當 `dirtySettleSeconds` 還是 `0`、且插件**實際觀察到**重建在途中被中止
  （24 小時內 ≥3 次、且佔已完成嘗試 ≥50%）時，用你自己的統計數字提醒你這個欄位存在。
  **沒有觀察到就不會出現**——新安裝不會被嘮叨，視窗滑出後警告自己消失。
- **`status().stats`：20 個扁平數字 ＋ `statsSince`**。涵蓋排入／成功／失敗／被中止／冷卻跳過／
  閘門跳過／settle 延後與落地／被短路省下的檢查／累計重建毫秒，每個概念都有
  `sinceStart*` 與 `last24h*` 兩鍵。**刻意命名為「本次啟動以來」而非歷史總計**——
  日誌檔 5 MB 輪替只留 `.1`，回填出來的「歷史」本身殘缺，比誠實標示更容易誤導。
  同一組數字也呈現在卡片上的「**成效**」區塊（統計缺席或全 0 時整塊不渲染）。
- **常駐狀態指示**（側邊欄 `sidebar.footer.action`）：有落後專案時顯示 warn 圓點、有重建失敗或
  監看失敗時顯示 error 圓點與數量，**全部新鮮時不渲染任何東西**。輪詢 `?log=0`、30 秒一次、
  頁面隱藏時暫停、失敗退避（約 0.6 MB/h）。導航 API 經查證不存在，因此它是純指示、不可點擊。
- **`SECURITY.md`**、**`docs/PUBLISHING.md`**（npm 發布的可執行清單）、
  **`.github/ISSUE_TEMPLATE/bug_report.yml`**。
- **README 截圖**（`docs/assets/`，中英各一張）：由 `docs/assets/capture-card.mjs` 以零相依 CDP
  驅動真實 DSH GUI 拍攝，資料是當下的真 `/state`。可重跑。
- **辨識碼**：`status().running.startedAt`、`status().logFileError`、`status().stateLoadError`。

### Changed

- **監看路徑的落後複驗不再強制失效圖譜 HEAD 快取**：每次存檔少一次 `query_graph` CLI 呼叫
  （實測 2.18–2.81 s）。配合下一條，50 次存檔的 CBM CLI 呼叫從 112 次降到 9 次。
- **settle 視窗內只做便宜的 HEAD 探測**：視窗內的每次觸發只跑 `git rev-parse HEAD`（2–3 ms），
  HEAD 沒變就只重排計時器、完全不碰 CBM CLI；HEAD 變了（commit／換分支／rebase）則立刻完整複驗
  並重建。**真正的 HEAD 落後永遠不受 settle 約束**，維持立即重建。
- **`includeDirty: false` 時不再執行 `git status`**：這個設定下 `record.dirty` 恆為 `false`，
  語意是「未檢查」而非「乾淨」；卡片在該情況下不顯示髒污標記（沉默，不是斷言乾淨）。
- **`POST /rebuild` 的 `force` 現在真的傳到佇列**：先前人工與強制重建仍會被冷卻擋下，
  與本檔 0.3.0 的敘述「人工與強制重建不受此限」矛盾。
- **`GET /state?log=0` 現在真的回 0 筆**（先前 `recent()` 以 `Math.max(1, …)` 夾住下限）。
- **被 `includeProjects`／`excludeProjects` 排除的專案不再標成孤兒**：孤兒的定義回到
  「上游已經沒有這棵樹」，與 [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) 一致。
- **`POST /config` 加上欄位白名單**：未知欄位名（例如把 `scanMinutes` 打成 `scanMs`）
  不再靜默寫進 Loader config，回應會帶 `unknown` 陣列；若全部欄位都無法辨識則回 400。
- **`engines.node` 由 `>=20` 改為 `>=20.13`**：Linux 的遞迴 `fs.watch` 自 Node 20.13.0 才有
  （[nodejs/node#45098](https://github.com/nodejs/node/pull/45098)），先前 20.0–20.12 會直接落到
  `backend: 'failed'`。CI 的 node 20 格永遠是最新 20.x，測不到這一段。
- **設定頁卡片整塊重寫**（743 → 1707 行）：頂端摘要列、離線與錯誤橫幅置頂、統一的
  `role="status"` 操作回饋、健康區塊（CLI 原因與候選路徑、日誌／狀態檔錯誤）、專案卡兩層與
  chips 過濾、破壞性操作兩段式確認、`relativeTime` 等硬編碼中文收進字典。
  **輪詢成本**：日誌面板收起時由每次 26,428 bytes 降到 5,253 bytes（−80%，約 34.9 → 6.3 MB/h），
  頁面隱藏時為 0。
- **英文介面的警告與「不可作為證據的宣告」改走 `code → 字典`**，未知 code 一律回退顯示 host 原文。

### Fixed

- **`drain()` 的 promise 拒絕無人接手**：`void this.drain()` 沒有 `.catch()`，
  一次重建拋錯就會變成 unhandledRejection，而 Node 的預設行為是**終止行程**——
  等於殺掉整個 DSH 宿主。已改為記錄 `drain.failed`，並加上會讓修法還原就變紅的測試。
- **卸載競態：`stop()` 不等在飛的掃描**：掃描會在 `stop()` 回傳之後才建立監看器，且此後不再被停止
  （實測 `stop()` 回傳後 `watchers.size === 1`）。已讓 `stop()` 等待 `refreshPromise`，
  並在 `reconcileWatchers`／`startWatcher` 入口檢查 `stopped`。
- **卸載時重建子行程可能在背後繼續跑**：`AbortController` 原本在取得重建鎖之後才建立，
  `stop()` 撞上取鎖期間就來不及 abort。已改為先建 controller 再取鎖。
- **監看器的執行期錯誤永遠到不了卡片**：`record.watcher` 是建立當下的快照，全庫沒有任何地方
  重讀 `watcher.status()`／`lastError`——0.3.0 的「inotify 用盡要顯示 failed」修正因此從未生效。
  已改為在 `list()`／`status()` 向監看器取即時狀態。
- **`fs.watch` 沒有檔名時的退路被副檔名白名單丟棄**：該分支用 `'__unknown__'` 當路徑，
  它沒有副檔名，所以一律被白名單擋掉，與註解「保守地當成一次觸發」正好相反。
- **PATH 掃描硬編 `:`**：Windows 的分隔符是 `;`，而同一段邏輯在 `lib/exec.js` 與 `lib/cli.js`
  各有一份。已抽出共用並改用 `path.delimiter`。
- **生成檔不再驅動重建**：`auto-imports.d.ts` 一個檔案就佔了全部監看觸發的 529/920（約 57%）。
  新增 `DEFAULT_WATCH_GENERATED_PATTERNS`（明確清單，**刻意不用廣義 `*.d.ts`**，
  手寫的 `.d.ts` 仍有測試保證會觸發）。
- 清掉一批死碼（`PLUGIN_NAME`、`SETTINGS_SECTION_ID`、`isGitWorktree`、`__gitInternals`、
  `removeProject`、`writeTempFile`、keeper 未使用的兩個匯入），並以 `test/api-surface.test.js`
  守門，避免它們悄悄回來。
- **發佈包從 672 kB 瘦回 124 kB**：`files` 原本收了整個 `docs/`，於是 README 用的兩張截圖
  （566 kB）與開發用的截圖腳本（26 kB）全都進了發佈包——而**市場安裝走的就是這個預覽包**
  （GitHub Release 資產＝`npm pack` 的產物），等於每個安裝者都要下載永遠用不到的圖。
  改成 `docs/*.md`（保留全部文件、排除 `docs/assets/`）。README 的圖仍留在 repo，
  GitHub 與 npm 的 README 呈現都不受影響。
- **CI 的語法檢查不再抄一份檔案清單**：`ci.yml` 原本自己列 `lib/*.js test/*.js
  test/helpers/*.js tools/*.mjs`，與 `package.json` 的 `test:syntax` 是兩份拷貝——而且已經
  漂移過一次（加了 `docs/assets/*.mjs` 卻只改了 `package.json`，截圖腳本因此在 CI 上沒被
  檢查到）。改為直接呼叫 `npm run test:syntax`，單一來源。

### 驗證

- 單元測試 **139 → 204**，`node --test test/*.test.js` 全綠。
- `tools/verify-keeper.mjs` 23/23；`tools/verify-client.mjs` **30 → 212**。
- 新增 `test/http-surface.test.js`：控制面改在**真的 `node:http` 伺服器**上用真的 `fetch`
  打一遍。先前的路由測試全用手寫的假 `req`／`res`——那個替身只要與真的 Node HTTP 物件有
  一處語意不同（`req.url` 的形式、`for await` 疊代、`writeHead` 之後才能 `end`…），
  幾百條斷言可以全綠而真的端點是壞的。這一支把「假替身與真物件一致」本身也變成被測項：
  真的查詢字串解析、真的 POST 內文讀取、真的 HTTP 狀態碼與 `content-type`、七條路由在真
  伺服器上都接得上、未命中的路徑由伺服器回 404。**這也是換代前對新 host 碼的 REST 檢查
  代償**——`dsh web` 要重啟才會上線，但這條路徑現在就能用真 HTTP 走一遍新碼。
- **三條關鍵修法做過突變驗證**（把修法還原→測試必須變紅→還原）：`force` 傳進佇列（2 條測試
  變紅）、`includeDirty: false` 不付 `git status`（2 條）、監看路徑的 idle-settle 閘門
  （**7 條**）。固定的不只是「程式碼有那段」，而是「那段被拿掉時測試會叫」。
- **發佈包實測可安裝可載入**：`npm pack` → 在乾淨目錄 `npm install` → `import` 得到
  `Config, apply, dshHomeDir, inject, name` 五個匯出，`name === 'codebase-watcher'`（與
  `cordis.patch.yml` 的 row id 一致），`cordis.patch.yml` 在包內，`./client` 入口可解析且
  帶 `__ModuleLoader__` 註冊形狀。CI 新增一關守著「`docs/assets` 不得進發佈包、且發佈包
  ≤ 200 kB」，並已實測該關卡會擋住這個回歸。
- 新增 `test/index.test.js`：**插件入口與控制面先前完全沒有測試**，而它正是「UI 依賴的
  對外介面」真正被組出來的地方。這一支用真的 `apply()`，只換掉三個邊界（`DSH_HOME`
  指向暫存目錄、`cliPath` 指向假 CLI、`graphUrl` 指向必然拒絕連線的埠），其餘路徑解析、
  狀態機、佇列、日誌、生命週期順序都是真的在跑。它固定了：七條路由的註冊、生命週期順序
  （`plugin.start` 必須排在 `plugin.stop` 之前）、未宣告的設定鍵會具名警告、`GET /state`
  上卡片依賴的每一個欄位、`?log=0` 真的是 0 筆、`POST /config` 的白名單與命名空間、
  沒有 settings 服務時拒絕寫入、不存在的 id 回 404，以及**卸載後路由被收回且不再產生掃描**。
  另有一條把狀態目錄建成普通檔案，逼出 `logFileError` / `stateLoadError` 的**真實錯誤
  路徑**——否則那兩個欄位只存在於原始碼，線上永遠不會有人看到。
- `node tools/bench-dirty-chase.mjs`（`npm run bench`）可重跑，上表即為它的輸出；
  `--assert` 模式已加進 CI，會擋住「編輯期間重建 > 1 次、或仍有重建被中止、或停手後沒追上」的回歸。
- CI 新增獨立的 `bench` job。`verify-keeper`／`verify-client` **沒有**進 CI——前者需要真的
  `codebase-memory-mcp`，後者需要一個跑著的 GUI，硬塞只會得到永遠紅或永遠 skip 的假訊號。

## [0.3.0] - 2026-10-06

> 這一版把「使用者視角審查」的改動全部落地。**兩個對外行為變了**：`GET /config` 的回應形狀
> （現在分成可寫的 `config` 與觀測用的 `runtime`），以及不存在的專案 `id` 由 502／靜默成功改為
> **404**。有腳本在打這兩條路由的話請看下面 Changed 的第一、二條。

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

[Unreleased]: https://github.com/WwW7olFWwW/dsh-codebase-watcher/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/WwW7olFWwW/dsh-codebase-watcher/releases/tag/v0.5.1
[0.5.0]: https://github.com/WwW7olFWwW/dsh-codebase-watcher/releases/tag/v0.5.0
[0.4.0]: https://github.com/WwW7olFWwW/dsh-codebase-watcher/releases/tag/v0.4.0
[0.3.0]: https://github.com/WwW7olFWwW/dsh-codebase-watcher/releases/tag/v0.3.0
[0.2.0]: https://github.com/WwW7olFWwW/dsh-codebase-watcher/releases/tag/v0.2.0
[0.1.0]: https://github.com/WwW7olFWwW/dsh-codebase-watcher/releases/tag/v0.1.0
