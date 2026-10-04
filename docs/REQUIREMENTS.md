# DSH × Codebase Memory 整合：需求文檔（自研插件）

| 項目 | 內容 |
|---|---|
| **版本** | v0.1（實作前的需求草案；實作現況與驗證結果見 [`../README.md`](../README.md)） |
| **日期** | 2026-10-04 |
| **性質** | 需求規格。回答「為什麼要做、要做什麼、驗收怎麼算」；實作步驟另見計畫 |
| **依據** | 2026-10-04 在 Fedora 主機上對 `codebase-memory-mcp@0.11.0` + DSH（`dsh-web.service`，0.2.0-rc.2 線）的**逐值實測**；所有問題均附可重跑指令（附錄 A） |
| **代號** | `dsh-cbm-keeper` |

---

## 0. 摘要

DSH 目前用**一行手動 MCP row** 接上 Codebase Memory（CBM）。實測結果：**查詢可用，但「圖譜保持新鮮」這件事在 DSH 上整體失效**——圖譜曾落後 33 小時／37 個提交／988 個新增檔，而所有當事人都以為它是新的。

原因是三個獨立缺陷的疊加：
1. **DSH 的 MCP `cwd` 是 profile 級常數**（由 `dsh web` 的啟動目錄決定），而 CBM 的監看與 auto-index **都以該 cwd 為工作區根**；
2. **CBM 內建的 watcher 即使註冊成功也不會產生可觀測的重建**（兩次對照探針，0 次索引工作）；
3. **MCP 工具 `index_repository` 有 60 秒上限**，而本專案索引需 60,980 ms ⇒ 每次都恰好被 supervisor 殺掉、白跑。

當時查過的外部現成方案不足以覆蓋本機情境：市集上的 `dsh-codebase-memory`（andyfan1094）在
2026-08-26 的狀態是最後提交 2026-08-26、最後發佈 v0.2.1（2026-08-22，當時已 39 天無更新），
且其 Linux 路徑解析在 Fedora 上必然失敗（見 P14）。以上是當日觀察，上游之後若有更新請以現況為準；
本插件與該專案沒有依賴或衍生關係。

⇒ **結論：自研一個薄插件，把「專案解析、落後偵測、條件式重建、可見性」四件事做對。**

---

## 1. 問題陳述（逐值證據）

### P1 — 多專案時，CBM 的監看與 auto-index 落在錯的樹

MCP row 是 `cwd: !!js process.cwd()`；`dsh web` 的 `WorkingDirectory=/home/user/deepseek-harness` ⇒ MCP server 的 cwd 就是 harness。
- `/proc/<mcp-server-pid>/cwd` → `/home/user/deepseek-harness`
- daemon 日誌：`daemon.autoindex.skipped project=home-user-deepseek-harness reason=unsafe_or_unavailable_path`
- 36 次 `daemon.workspace.skipped operation=watch detail=/home/user: _path_is_a_home,…`

**對照實驗（決定性）**：以不同 cwd 起 MCP session ⇒ `cwd=家目錄` 立刻產生 2 筆 `workspace.skipped`；`cwd=專案目錄` 無 skip。

**影響**：所有專案都拿不到自動更新；sample-repo 完全不在射程內。

### P2 — CBM 內建 watcher 不會實際重建

以拋棄式 git 倉庫（cwd 指該倉庫、session 存活 65 秒）跑兩次探針：
- 探針 1：t=12s 產生**已提交**的新檔 → 無任何索引工作
- 探針 2：t=10s 產生**未提交**髒污（新檔＋已追蹤檔修改），持續 55 秒 → `worker_budget project=watcher-probe` = **0**

**影響**：`watcher_enabled=true`／`auto_watch=true` 這兩個預設值給人「有在顧」的錯覺。

### P3 — `auto_index` 是無條件的全量重建

圖譜於 04:29 剛重建完成、HEAD 未變；04:31 開一個 session 仍然啟動 worker（`daemon.index.worker_budget project=… active_jobs=1`）。
**成本實測**：60,980 ms／DB 658 MB／worker log `peak_charged_mb=2858`。
**影響**：開啟它＝每個 session 啟動白燒一次；關掉它＝完全沒有自動更新。兩難。

### P4 — MCP `index_repository` 的 60 秒上限 < 本專案所需的 61 秒

```
mcp.request … tool=index_repository status=error duration_ms=60004
index.supervisor.reap outcome=killed exit_code=-1
index.supervisor.containment_failed outcome=killed
```
**影響**：經 MCP 呼叫的索引**必然失敗**；只能改走 CLI（`codebase-memory-mcp cli …`）。

### P5 — 圖譜不會自動追上 HEAD（實測）

| 項目 | 值 |
|---|---|
| `indexed_at` | 2026-10-02T11:07:52Z |
| 圖譜 `Branch.head_sha` | `3449ba2`（10-02 03:10 的提交） |
| 當時 HEAD | `96cd57b`（10-04 04:03） |
| 落後量 | 37 提交／1,046 檔變更／988 檔新增 |
| DB mtime | 停在索引那一刻，33 小時未再寫入 |

### P6 — `index_status.git.head_sha` 會誤導

`index_status(verbose)` 顯示的 `git.head_sha` 是**查詢時即時讀取**（DB mtime 未變也照樣顯示新 HEAD）⇒ 讓人以為索引是新的。**真正代表圖譜內容的是 `indexed_at` 與圖譜內 `Branch.head_sha`。**

### P7 — 專案身分鍵不明確 ⇒ 重複專案風險

同一個 repo 出現兩種名字：CLI 帶 `--name sample-repo`；未帶 name 時 daemon 以路徑派生 `home-user-sample-repo`。`list_projects` 只回 name/root_path/branch/計數，**沒有「這是不是同一棵樹」的判定**；`auto_index_limit` 的說明又是「Max files for auto-indexing **new projects**」。
本次未實際產生重複，但這是**隨時會踩**的地雷。

### P8 — 圖譜的結構宣告不可靠（引用前必須驗）

| 宣告 | 實情 |
|---|---|
| `Route` × 22 | **無一是產品路由**（CDP `/json/*` 端點＋i18n 鍵如 `"/ 的樣本載體"`），且 `file_path` 全空、不可溯源 |
| `layers: src = api (has HTTP route definitions)` | 不成立（`src` 是 SPA，四條 vue-router 路由） |
| `languages` | 漏 `.mjs`（磁碟 280 檔） |
| `.py` 0/16 | **非缺陷**：16 個 `.py` 全在 gitignore 的 `02-reverse/`、`smartmark6-backup/` |

### P9 — `parse_partial` 是無聲缺口

29 檔 partial，含 `05-web/src/styles/tailwind.css`（92-93、113-115 行）與 `base.css`（36-38）⇒ 這些範圍的節點可能缺席，引用時得回到 grep。

### P10 — 沒有「落後總覽」

只能逐專案拼：`index_status`（新舊皆不可信）＋ `query_graph` 取 Branch ＋ `stat` DB ＋ 翻 daemon log。沒有單一入口回答「**現在哪些專案過期、各差幾個提交**」。

### P11 — 觀測性薄弱

- daemon log 的行內**沒有時間戳**，只能靠前後文推時序
- 「我的監看被拒了」只寫在 daemon log，UI／工具都不回報
- 沒有 REST／UI 可查 watcher 狀態（這正是被放棄的那個第三方插件**有**做的部分）

### P12 — 索引成本高且不可控

61s／658 MB／峰值 2.8 GB charged；模式（fast/moderate/full）與併發沒有控制面。

### P13 — 失敗是靜默的

敏感路徑被拒、CLI 找不到、重建逾時，全部只留在一份無時間戳的日誌裡；使用者體驗是「以為有索引，其實沒有」。

### P14 — 現成插件在 Linux 不可用（自研的觸發點）

`dsh-codebase-memory`（andyfan1094，v0.2.1，MIT）逐值檢查：
- 架構正確：watcher **不持有 MCP 連線**、直接 shell out CLI、`autoAttach` 對所有已知專案自動掛 watcher
- **但** `src/cli-bridge.mjs` 的 `resolveExecutable()` 在非 Windows 只找 `/usr/local/lib/node_modules/…` 與 `/usr/lib/node_modules/…`；本機 CLI 在 `~/.local/bin/` ⇒ 回退第一候選 ⇒ **必然 ENOENT**
- `src/index.mjs:43` 是 `createCliBridge({})`（不傳 executable），設定 schema 無 `cliPath`／`executable` ⇒ **無法用設定覆寫**
- bundle id 就叫 `mcp-codebase-memory`，**與本 profile 的手動 row 撞名**
- 文件綁 `codebase-memory-mcp@0.10.8`（Windows AMD64 發行件）；本機 0.11.0
- **最後提交 2026-08-26、最後發佈 2026-08-22 ⇒ 已 39 天無更新**

**對照**：`troytse/dsh-plugin-codegraph-project` 最後提交 2026-09-30（4 天前，活躍），且它示範了「按 session workspace 解析專案、每專案一個 MCP」的可行範式——但後端是 CodeGraph，不是 CBM。

### P15 — 版本漂移無護欄

本機 CBM 0.11.0；生態插件綁 0.10.8。沒有「啟動時檢查版本並警告」的機制。

### P16 — gitignore 內容不入圖（預期行為，但要說清楚）

本次索引 `not_indexed_files_count = 2043`（gitignore／ignored-suffix）。對「原版對標」這類需要讀 `02-reverse/`、`smartmark6-backup/` 的工作，圖譜幫不上忙，必須 grep 原始檔。

---

## 2. 目標與非目標

### 目標
1. **在任何已索引的專案上，圖譜自動跟上該專案的 git HEAD**，不需人工介入、不需重啟 DSH、不需改 MCP row。
2. **多專案天生支援**（sample-repo 與未來任何專案一視同仁）。
3. **狀態與失敗完全可見**：一眼看出哪些專案過期、差多少、上次重建多久、為什麼失敗。
4. **與 DSH 的啟動方式解耦**（systemd 常駐、cwd 固定都不再是問題）。
5. **不要求提權、不污染專案樹**（所有寫入限家目錄設定區）。

### 非目標
- ❌ 不改 CBM 本體（不改二進位、不 patch 上游）
- ❌ 不改 DSH 本體的 MCP client（不要求它支援 per-session `cwd`）
- ❌ 不用 systemd timer／cron 這種「宿主外部」方案（人類 2026-10-04 已明確否決）
- ❌ 不取代 CBM 的查詢工具（`search_graph` / `query_graph` / `trace_path` … 一律沿用）
- ❌ 不做語意分析或圖譜品質修補（P8 只做「標示不可引用」，不修圖）

---

## 3. 使用者故事

| # | 故事 | 驗收觀察點 |
|---|---|---|
| US-1 | 作為開發者，我改完碼提交後繼續問 agent 問題，agent 看到的圖譜**已包含我剛提交的變更** | 提交後 N 秒內 `graph_head == git HEAD` |
| US-2 | 作為開發者，我在設定頁一眼看到**哪些專案過期、各差幾個提交** | 卡片列出 name／root／graph_head／live_head／behind_by |
| US-3 | 作為開發者，當自動更新壞掉時，我**在 UI 上看到原因**（CLI 找不到／路徑被拒／重建失敗） | 卡片上的 `lastError` ＋ 具名訊息 |
| US-4 | 作為開發者，我新 clone 一個專案並索引一次後，**它自動被納管**，不需再設定 | 下輪掃描自動出現該專案 |

---

## 4. 功能需求

> 優先級：**M**＝必須（MVP）／**S**＝應該／**C**＝可以。

| ID | 需求 | 驗收條件 | 對應問題 | 優先 |
|---|---|---|---|---|
| **FR-1** | **專案身分以 root_path 為唯一鍵**（canonical/realpath）；`name` 僅為顯示標籤。同一 root_path 已存在時沿用既有 name，**不得**因名字不同而新建專案 | 對同一 repo 連續觸發兩次（一次帶 name、一次不帶）⇒ `list_projects` 仍只有一筆 | P7 | M |
| **FR-2** | **落後偵測**：對每個目標專案比較「圖譜 HEAD」（`query_graph` 取 `Branch.head_sha`）與「實際 `git rev-parse HEAD`」，算出 `stale` 與 `behind_by`（提交數） | 造一個新提交 ⇒ 卡片在下一輪顯示 `stale=true, behind_by=1` | P5/P10 | M |
| **FR-3** | **條件式重建**：僅在 `stale` 時重建（可選 `dirty` 旗標涵蓋未提交變更）；提供 `force` 忽略判斷 | HEAD 未變時重跑 ⇒ **不**產生索引工作；HEAD 變了 ⇒ 產生一次 | P3/P5/P12 | M |
| **FR-4** | **重建走 CLI、不經 MCP**：以子行程呼叫 `codebase-memory-mcp cli --quiet index_repository --repo-path <abs> --mode <mode> --name <name>`，逾時預設 1800s | 對 sample-repo 觸發 ⇒ 完成且 `graph_head` 追上（不受 60 秒限制） | P4 | M |
| **FR-5** | **CLI 可執行檔解析可設定且可觀測**：依序 `CBM_BIN` 環境變數 → `PATH` 查找 → 平台常見路徑 → 明確報錯；解析結果以 `cli_path` 暴露在 UI／REST | 把 `CBM_BIN` 指向任意路徑 ⇒ 生效；指向不存在路徑 ⇒ UI 具名報錯（不得靜默） | P14 | M |
| **FR-6** | **每專案檔案監看**：以 chokidar 監看已納管專案，防抖後觸發重建；內建排除 `node_modules/.git/dist/build/.codebase-memory/__pycache__` 等；副檔名白名單可設定 | 改一個 `.ts` 檔 ⇒ 防抖期後觸發且僅觸發**一次**重建 | P1/P2 | S |
| **FR-7** | **自動納管**：啟動時對 `list_projects` 的每個專案建立 watcher；之後定時（預設 5 分鐘）掃描新增專案並納管 | 新增一個已索引專案 ⇒ 無人工介入下被納管 | P1/P10 | S |
| **FR-8** | **設定頁卡片（觀測面）**：每列顯示 `name`／`root_path`／`graph_head`（短）／`live_head`（短）／`behind_by`／`lastIndexedAt`／`lastDurationMs`／`watcher 狀態`／`lastError` | 卡片內容與 CLI 逐值一致 | P10/P11 | M |
| **FR-9** | **明確的 staleness 語意**：對外輸出一律同時給 `graph_head` 與 `live_head`，**禁止**只顯示即時 HEAD 就宣稱「已索引」 | 圖譜過期時 UI 必須顯示 `stale`；不得出現「看起來是新的」 | P6 | M |
| **FR-10** | **失敗可見**：CLI 找不到、路徑被安全政策拒絕、重建失敗／逾時，皆須在 UI 與結構化日誌（**含時間戳**）具名呈現 | 故意讓 CLI 路徑錯 ⇒ UI 立即顯示原因 | P13/P14 | M |
| **FR-11** | **索引結果回報**：顯示 `nodes`／`edges`／`parse_partial` 清單／`not_indexed` 數量與理由 | 對 sample-repo 索引後顯示 128,530 / 154,752 / 29 / 2,043 | P9/P16 | S |
| **FR-12** | **手動操作**：一鍵「立即檢查」「全部重建 stale」「重建此專案」「暫停／恢復 watcher」；並以 REST 暴露同等能力 | 每個動作可在 UI 與 REST 觸發，結果一致 | P11 | M |
| **FR-13** | **不可靠宣告的標示**：對已知會誤導的圖譜欄位（`Route.file_path` 為空、`layers` 與事實不符）在 UI／文件中標示「不可作為證據」 | 卡片或說明檔明確標示 | P8 | C |
| **FR-14** | **成本控制**：全域併發上限 1（鎖檔）；重建以低優先級執行；`mode` 可選 `fast/moderate/full`；顯示上次耗時 | 同時觸發多個專案 ⇒ 序列化執行 | P12 | S |
| **FR-15** | **版本相容檢查**：啟動時讀 `codebase-memory-mcp --version`，與支援矩陣比對；不符只**警告**不阻擋 | 版本不符時 UI 出現警告 | P15 | C |

---

## 5. 非功能需求

| ID | 需求 | 驗收條件 |
|---|---|---|
| **NFR-1 平台** | Linux（Fedora）為主，不得依賴 Windows；純 ESM JavaScript，Node ≥ 20；單一執行期依賴（`chokidar`） | 在 Fedora 上可安裝、可執行、可移除 |
| **NFR-2 不越權** | 所有寫入限 `~/.dsh/**`、`~/.config/**`、`~/.local/state/**`；**不寫專案樹**；**不需要 sudo** | 安裝與運行過程中無提權提示 |
| **NFR-3 資源** | idle 時 CPU 近 0；重建以 `nice`＋idle IO 執行；單次重建對互動無感 | 重建期間 GUI 操作不卡 |
| **NFR-4 觀測** | 所有動作寫結構化日誌（**帶時間戳**）；最近 N 筆可在 UI 查 | 日誌可逐值回溯每次判斷與重建 |
| **NFR-5 相容** | **不得**與使用者手動的 MCP row 撞 id；不得覆寫既有 `cordis.patch.yml` 內容，只能明確新增／移除自己的 bundle | 安裝前後 diff 僅含本插件相關行 |
| **NFR-6 冪等** | 重建有鎖（防重入）；watcher 不持有 MCP 連線；崩潰後能從狀態檔恢復意圖 | 併發觸發不會產生兩次重建 |
| **NFR-7 可測試** | 核心決策（身分鍵、落後判定、CLI 解析、模式選擇）可單元測試，且**不需要真的索引** | 有單元測試；可用假 git/假 CLI 驗證 |
| **NFR-8 完整移除** | 移除後不留殘骸：bundle 註冊、狀態檔、日誌、設定全清 | 移除後 `dsh plugin list` 與檔案系統皆無殘留 |

---

## 6. 整合介面

| 介面 | 內容 |
|---|---|
| **DSH 插件** | Cordis bundle（`package.json` 的 `dsh.bundle.patch`）；`settings.section` slot 放觀測卡片；`webServer` 註冊 REST 路由；生命週期用 `ctx.effect` 收尾（不可用模組級 WeakSet 守門——本機已有該踩坑紀錄） |
| **CBM CLI** | `codebase-memory-mcp cli [--quiet] [--json] <tool> [--flag value]`；本專案實際會用到：`list_projects`、`index_status`、`query_graph`（取 `Branch.head_sha`）、`index_repository` |
| **狀態檔** | `~/.dsh/<plugin-id>/state.json`（每個專案的 watcher 意圖、上次結果、上次錯誤），原子寫入 |
| **輔助訊號** | `~/.cache/codebase-memory-mcp/<project>.db` 的 mtime（僅作旁證，不作主判據） |
| **REST（草案）** | `GET /list`、`GET /status?id=`、`POST /check`、`POST /rebuild`、`POST /start|stop|resume` |

---

## 7. 與現有方案對照：為什麼自研

| 方案 | 為何不採用 |
|---|---|
| 現行手動 MCP row（現況） | 查詢可用，但監看／自動索引落點錯（P1/P2/P5） |
| `dsh-codebase-memory`（andyfan1094 v0.2.1） | **39 天無更新**；Linux 路徑解析必然失敗且無設定可覆寫；bundle id 撞名；綁 0.10.8（P14） |
| `auto_index=true`（內建） | 無條件全量重建，每個 session 白燒 61s（P3） |
| systemd 使用者計時器 | 人類已明確否決（宿主外部方案） |
| 從專案目錄啟動 DSH | 不可能：DSH 由 systemd 常駐，`WorkingDirectory` 固定 |
| 一專案一 profile | 可行但要把其他設定複製 N 份，維護成本高 |
| 改用 CodeGraph 系插件 | 可解「per-session 專案解析」，但等於換掉 CBM 這個後端 |

---

## 8. 風險與未確認項

| # | 風險／未確認 | 處置 |
|---|---|---|
| R1 | CBM 0.11.0 的 CLI 介面**未被上游文件化**，靠實測鎖定 | M0 spike 先固定四個工具的實際輸出格式；FR-15 加版本檢查；必要時以 DB mtime 為 fallback 判據 |
| R2 | 取圖譜 HEAD 依賴 `Branch` 節點，上游若改 schema 會斷 | 加 fallback：`stat` DB mtime ＋ `git log -1` 時間比較 |
| R3 | 重建期間 daemon 同時服務查詢 | 已實測可並存，但未做壓測；M1 補一次併發實測 |
| R4 | sample-repo 有 6,554 檔，watcher 事件量未實測 | M2 先量測再決定是否預設改用輪詢 |
| R5 | 家目錄被安全政策拒（P1） | 插件明確宣告「以家目錄為根的專案不支援自動監看」，並在 UI 具名 |
| R6 | 與 CBM 內建 watcher/auto_index 併存會重複重建 | 安裝指引明確要求 `auto_index=false`；插件啟動時偵測並警告 |
| R7 | 索引成本（61s／658 MB／峰值 2.8 GB） | FR-3 條件式重建 ＋ FR-14 併發上限 1 ＋ nice |
| **U1** | **DSH 插件 API 能否取得「session 的 workspace 目錄」**（FR-6/FR-7 若要走 per-session 路線則必需；`dsh-plugin-codegraph-project` 的存在暗示可以） | **M0 必須先驗**；若不可得，退回「全域掃描 `list_projects`」路線（FR-7 已涵蓋） |
| **U2** | 插件 API 版本相容（本機 DSH 0.2.0-rc.2） | M0 驗證 `settings.section` 與 `webServer` 是否如文件可用 |
| **U3** | 是否要把 FR-6 watcher 做成可選（純輪詢比 chokidar 更省事） | M2 依 R4 實測決定 |

---

## 9. 里程碑

| 階段 | 範圍 | 產出（可驗收） |
|---|---|---|
| **M0 — Spike**（0.5 天） | 驗 U1/U2：能否拿 session workspace、能否註冊設定頁卡片、能否 spawn CLI 並解析輸出 | 一支可跑的骨架插件 ＋ 一份逐值結論 |
| **M1 — MVP**（1–2 天） | FR-1/2/3/4/5/8/9/12：設定頁卡片 ＋ 手動「檢查／重建 stale」＋ CLI 路徑可設定 | 卡片顯示 stale 表；對 sample-repo 手動重建成功且 `graph_head` 追上 |
| **M2 — 自動化**（1–2 天） | FR-6/7/10/11/14：watcher ＋ 自動納管 ＋ 失敗可見 ＋ 成本控制 | 提交後 N 秒內自動追上（用拋棄式倉庫驗證，不碰 sample-repo） |
| **M3 — 收尾** | FR-13/15 ＋ NFR 全項 ＋ 打包（`dsh plugin add` 可安裝／可完整移除） | 移除後無殘骸；版本不符有警告 |

---

## 附錄 A — 證據重跑指令

```bash
# P1：MCP server 的 cwd 與監看被拒
readlink /proc/$(pgrep -f 'codebase-memory-mcp$' | head -1)/cwd
grep -E 'workspace.skipped|autoindex.skipped' ~/.cache/codebase-memory-mcp/logs/cbm-daemon.log | tail

# P2：watcher 不重建（用拋棄式倉庫；cwd 指該倉庫起 session，改檔後看有無 worker_budget）
grep -c 'worker_budget project=<測試專案名>' ~/.cache/codebase-memory-mcp/logs/cbm-daemon.log

# P3/P4：60 秒上限與 supervisor 殺 worker
grep -E 'duration_ms=60004|supervisor.reap|containment_failed' ~/.cache/codebase-memory-mcp/logs/cbm-daemon.log | tail

# P5/P6：圖譜落後與 head_sha 誤導
stat -c '%y %s' ~/.cache/codebase-memory-mcp/sample-repo.db
codebase-memory-mcp cli --json query_graph --project sample-repo --query "MATCH (b:Branch) RETURN b.head_sha AS head"
git -C /home/user/sample-repo log --oneline -1

# P8：Route 節點無 file_path、layers 宣告不成立
codebase-memory-mcp cli --json query_graph --project sample-repo --query "MATCH (r:Route) RETURN r.name, r.file_path"

# P14：第三方插件的 Linux 路徑解析
curl -sS https://raw.githubusercontent.com/andyfan1094/dsh-codebase-memory/main/src/cli-bridge.mjs | sed -n '/function resolveExecutable/,/^}/p'
```

## 附錄 B — 本輪未確認項（不得推定）

| # | 未確認 | 為何未確認 |
|---|---|---|
| B1 | CBM 內建 watcher「註冊成功後是否本就會重建」 | 日誌中從未出現成功監看事件的樣本（兩次探針皆 0 工作） |
| B2 | `dsh-codebase-memory` 在 Linux 是否**完全**不可用 | 只做了原始碼靜讀，未實裝；作者的 MCP 橋接明標 Windows-only |
| B3 | GitHub API 的星數／下載／最後推送 | API 被限流，改用 atom feed 取得提交與發佈時間（已足夠佐證「停更」） |
| B4 | DSH 插件 API 能否取得 session workspace | 需 M0 實測（U1） |
| B5 | sample-repo 規模下 watcher 的事件量與 CPU | 未量測（R4） |
