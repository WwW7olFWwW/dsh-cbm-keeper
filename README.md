# dsh-cbm-keeper

[![CI](https://github.com/WwW7olFWwW/dsh-cbm-keeper/actions/workflows/ci.yml/badge.svg)](https://github.com/WwW7olFWwW/dsh-cbm-keeper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-105%20pass-brightgreen.svg)](test)

DSH × Codebase Memory 圖譜保鮮插件 —— **English: [`README.en.md`](README.en.md)**

需求規格：[`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) ｜ 貢獻指南：[`CONTRIBUTING.md`](CONTRIBUTING.md) ｜ 變更記錄：[`CHANGELOG.md`](CHANGELOG.md)

**一句話**：讓 CBM 的知識圖譜在任何已索引的專案上自動跟上該專案的 git HEAD，並把「哪些專案過期、差多少、為什麼失敗」變成看得見的東西。

---

## 它解決什麼

DSH 只用一行手動 MCP row 接上 Codebase Memory 時，**查詢可用，但「圖譜保持新鮮」整體失效**：實測曾經落後 33 小時／37 個提交／988 個新增檔，而所有當事人都以為它是新的。三個獨立缺陷疊加：

1. DSH 的 MCP `cwd` 是 profile 級常數 ⇒ CBM 的監看與 auto-index 落在錯的樹（P1）；
2. CBM 內建 watcher 即使註冊成功也不產生可觀測的重建（P2）；
3. MCP 工具 `index_repository` 有 60 秒上限，而本專案索引需 60,980 ms ⇒ 每次都被殺掉（P4）。

本插件把「專案解析、落後偵測、條件式重建、可見性」四件事用 DSH 自己的插件機制做對，**不改 CBM 本體、不改 DSH 本體、不用 systemd timer**。

## 架構

```
瀏覽器（設定 →「CBM 圖譜」）
   │  settings.section slot，純 fetch
   ▼
/api/cbm-keeper/{state,log,check,rebuild,watchers,config}      ← Host 半邊（lib/routes.js）
   ▼
CbmKeeper 協調器（lib/keeper.js）
   ├── 掃描：list_projects → 依 realpath(root) 併入專案表（FR-1）
   ├── 落後判定：Branch.head_sha vs git rev-parse HEAD（FR-2）
   ├── 條件式重建：只有 stale 才排入，全域併發 1（FR-3 / FR-14）
   ├── 重建執行：`codebase-memory-mcp cli index_repository`（FR-4，不經 MCP）
   └── 每專案監看：chokidar，缺席時退回 node:fs.watch（FR-6）
```

| 檔案 | 職責 |
|---|---|
| [`lib/index.js`](lib/index.js) | Host 插件入口：`ctx.effect` 掛生命週期與路由 |
| [`lib/keeper.js`](lib/keeper.js) | 協調器：掃描、判定、佇列、監看、鎖 |
| [`lib/staleness.js`](lib/staleness.js) | 純決策：身分鍵、落後判定、模式選擇（可單元測試，不需真的索引） |
| [`lib/cbm.js`](lib/cbm.js) | CBM CLI 的文字輸出解析（`--json` 只是把 MCP 信封原樣包出） |
| [`lib/cli.js`](lib/cli.js) | CLI 路徑解析順序與 `--json` 信封解析 |
| [`lib/git.js`](lib/git.js) | git 探針：HEAD、提交時間、`rev-list --count`、髒污 |
| [`lib/watcher.js`](lib/watcher.js) | 每專案檔案監看（chokidar → fs.watch 退路） |
| [`lib/state.js`](lib/state.js) | 原子狀態檔（崩潰後恢復重建意圖） |
| [`lib/log.js`](lib/log.js) | 帶時間戳的結構化日誌（記憶體環 + 落檔） |
| [`lib/routes.js`](lib/routes.js) | REST 控制面 |
| [`lib/client.js`](lib/client.js) | 瀏覽器半邊：設定頁觀測卡片 |
| [`tools/verify-client.mjs`](tools/verify-client.mjs) | 客戶端渲染驗證器（無瀏覽器也能驗證卡片畫得出來） |
| [`tools/verify-keeper.mjs`](tools/verify-keeper.mjs) | Host 半邊對真實 CBM CLI 的驗證器（唯讀） |

---

## 安裝

```bash
# 從 GitHub 安裝（推薦）
dsh plugin --profile web add github:WwW7olFWwW/dsh-cbm-keeper

# 或本地目錄（開發這個插件時）
dsh plugin --profile web add /path/to/dsh-cbm-keeper
```

（或在 DSH Web 的插件管理頁以「本地目錄」安裝同一路徑。等價於 `plugin_manager` 的
`install_bundle`，它會處理套件安裝與 bundle 選擇，不需要手動改 `package.json` 或
`cordis.patch.yml`——NFR-5 要求不得覆寫既有 patch 內容。）

安裝後**不需要重啟**：Host 半邊隨 bundle 一起熱載入，瀏覽器半邊會出現在
設定 →「CBM 圖譜」（若沒有，重整一次頁面）。

### 建議一併調整的上游設定

```bash
codebase-memory-mcp config set auto_index false
```

`auto_index=true` 是**無條件的全量重建**：每個 session 啟動都白燒一次約 61 秒／658 MB，
而它並不會讓圖譜追上 HEAD。本插件在啟動時會讀 `config list`，發現它仍是 `true` 就在
設定頁跳出具名警告（R6），但不會替你改設定。

## 設定

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

## REST 控制面

路由與 UI 同源：卡片上的每個動作都能用 curl 打，兩邊看到同一份資料（FR-12）。
全部走 DSH 既有的 `webServer`，繼承它的 loopback-only 綁定，不另開監聽埠。

| 方法 | 路徑 | 說明 |
|---|---|---|
| `GET` | `/api/cbm-keeper/state?log=100` | 全域狀態 + 專案表 + 不可靠宣告說明 + 最近日誌 |
| `GET` | `/api/cbm-keeper/log?limit=200` | 只要日誌 |
| `POST` | `/api/cbm-keeper/check` | `{}`＝整批重掃；`{"id":"<root>"}`＝只檢查一個 |
| `POST` | `/api/cbm-keeper/rebuild` | `{"id":…}` / `{"staleOnly":true}` / `{"mode":"fast"}` / `{"force":true}` |
| `POST` | `/api/cbm-keeper/watchers` | `{"action":"pause"\|"resume", "id"?:…}` |
| `GET` | `/api/cbm-keeper/config` | 讀取目前設定 |
| `POST` | `/api/cbm-keeper/config` | 寫入設定（欄位 → 新值；`null` 表示回退預設） |

`rebuild` 預設**不帶 force**：圖譜 HEAD 與工作樹一致時回 `queued: 0`，不產生任何索引工作
（FR-3 的驗收條件）。要無條件重跑請帶 `force: true`。

## 落後語意（FR-9）

對外一律同時給 `graphHead` 與 `liveHead`，並附上判據來源：

| `confidence` | 意義 |
|---|---|
| `head` | 主判據：圖譜 `Branch.head_sha` 對上 `git rev-parse HEAD`。`behindBy` 是精確提交數。 |
| `time` | 退路（R2）：圖譜沒有 `Branch` 節點時，改用 `indexed_at`／DB mtime 與 HEAD 提交時間比較。`behindBy` 為 `null`。 |
| `none` | 證據不足（例如專案尚無提交、或不是 git 工作樹）。**`stale` 為 `null`，UI 顯示「無法判定」，絕不會被當成「新鮮」。** |

`index_status` 回報的 `git.head_sha` 是**查詢時即時讀取**的（P6），圖譜沒動也照樣顯示新 HEAD。
本插件不採用它作為新鮮度判據，卡片上也不會出現「看起來是新的」的欄位。

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

## 開發

```bash
node --test "test/*.test.js"           # 單元測試（不需要真的索引）
node tools/verify-keeper.mjs           # 對真實 CBM CLI 掃描（唯讀，需要 CLI 在 PATH）
node tools/verify-client.mjs           # 客戶端渲染驗證（需要 dsh web 在跑）
```

`node --test test/` 在這個目錄會解析失敗（Node 把 `test/` 當成模組而非測試目錄），
請照上面給 glob。

`lib/` 是純 ESM JavaScript，沒有建置步驟；profile 以 `link:` 指向本目錄。

**改完 `lib/` 之後要讓它生效，需要重啟 `dsh web`：**

```bash
systemctl --user restart dsh-web
```

本機實測結論（2026-10-04）：以 `link:` 安裝的 bundle，改動 `lib/*.js` 後**不會**被
熱載入。`install_bundle`、`remove_bundle`、`set_bundle` 停用再啟用，都會讓 Loader
重新 `apply()`（新的協調器實例、`revision` 歸零），但 ESM 的模組快取仍供應舊的
模組世代——`ctx.effect` 重跑的是舊程式碼。瀏覽器半邊（`lib/client.js`）不同：它每次
由 client-modules 重新讀檔並產生新的 bundle rev，重整頁面即生效。

### 驗證現況（2026-10-04）

| 項目 | 證據 |
|---|---|
| 單元測試（NFR-7） | `node --test "test/*.test.js"` → **105 tests / 105 pass / 0 fail / 0 todo** |
| Host 半邊對真實 CLI | `node tools/verify-keeper.mjs` → **19/19**（唯讀掃描 + 孤兒收斂 + 未納管不得重建） |
| 客戶端渲染 | `node tools/verify-client.mjs` → **29/29**（用執行中伺服器的真實回應逐值比對；條數是資料條件式，專案沒有 head 時會少一至兩條） |
| CLI 解析（FR-5） | `cliPath=~/.local/bin/codebase-memory-mcp`, `source=PATH`, `cliVersion=0.11.0`, `supported=true` |
| 自動納管（FR-7/US-4） | 拋棄式倉庫索引後，下一次 `POST /check` 即被納管並建立監看 |
| 落後偵測（FR-2） | 樣本倉庫：`graphHead=liveHead=96cd57bb`, `stale=false`, `behindBy=0`, `confidence=head` |
| 條件式重建（FR-3） | 全部新鮮時 `POST /rebuild` 回 `queued: 0, skipped: 3`；`staleOnly` 回 `沒有落後的專案` |
| 端到端追上（US-1） | 提交 `edae4a30` 後 **18.5 秒**圖譜追上（`watch.triggered` → `rebuild.done caughtUp=true`，索引本身 4.42 s） |
| 觀測面（FR-8/9/10） | 卡片逐值呈現 CLI 路徑／版本／兩個 HEAD／落後量／watcher／警告；無提交的倉庫顯示「無法判定」 |
| 失敗可見（FR-10） | 該倉庫的 `lastCheckedError` 是「這個專案尚無提交（unborn HEAD）…」＋ git 原始訊息 |
| 版本護欄（FR-15） | `0.11.0` 命中支援矩陣；清單外版本在卡片上轉為警告 |
| 不覆寫 profile patch（NFR-5） | 安裝前後 `~/.dsh/profiles/web/cordis.patch.yml` 逐位元組相同 |
| 完整移除（NFR-8） | `remove_bundle` 後 bundle 列表與相依皆移除、路由下線；`cordis.patch.yml` 不變 |
| 設定可配置（障礙排除） | 官方探針 `Config.listConfigs` 對 entry `cbm-keeper` 由 `status: absent` 變 **`status: schema`**；`POST /api/cbm-keeper/config` 回 `{"ok":true}`，寫入後 `cliSource` 由 `config` 回到 `PATH` |
| 卸載演練（NFR-8 的動態面） | 重建進行中（慢速 CLI 包裝，子行程 `sleep 900`）停用 bundle：日誌依序 `rebuild.abandoned`（`durationMs=6880 ok=false`）→ `keeper.stopped` → `plugin.stop`，子行程消失；`rm -rf ~/.dsh/cbm-keeper` 後 12 秒目錄未回來（沒有遲到的落盤） |

驗證是在**已經安裝並正在跑的伺服器上**進行的（`http://127.0.0.1:3080`）。2026-10-04 20:33:01
重啟後（PID 1901011），`lib/config.js` 的 `profilePackageRoots()` 修正在 live 生效；當日累計修好
的三個真實缺陷——`stop()` 非 join、`Config` 未被註冊、以及「解析根只靠 `DSH_PROFILE_DIR`」在宿主
行程無效——都已逐項驗過。**改動 `lib/` 之後仍必須重啟才會換代**（見上一節）。

---

## 授權

[MIT](LICENSE) © 2026 [WwW7olFWwW](https://github.com/WwW7olFWwW)

本專案是獨立的社群插件，與 DeepSeek 官方無隸屬關係；DSH（DeepSeek Harness）與
Codebase Memory MCP 分屬其各自權利人的專案。
