# 開發與驗證

## 跑起來

```bash
node --test test/*.test.js             # 單元測試（204 項，不需要真的索引）
node tools/verify-keeper.mjs           # 對真實 CBM CLI 掃描（唯讀，需要 CLI 在 PATH）
node tools/verify-client.mjs           # 客戶端渲染驗證（需要 dsh web 在跑）
```

`lib/` 是純 ESM JavaScript，沒有建置步驟；profile 以 `link:` 指向本目錄。

**兩個踩過的坑**

- `node --test test/` 會解析失敗（Node 把 `test/` 當成模組而非測試目錄），要給 glob。
- **glob 不要加引號**：Node 20 的 `--test` 不會自己展開 glob，`"test/*.test.js"` 會被當成
  一個字面路徑（CI 上會看到 `Could not find '.../test/*.test.js'`）。

**改完 `lib/` 之後要讓它生效，需要重啟 `dsh web`：**

```bash
systemctl --user restart dsh-web
```

以 `link:` 安裝的 bundle，改動 `lib/*.js` 後**不會**被熱載入。`install_bundle`、`remove_bundle`、`set_bundle` 停用再啟用，都會讓 Loader
重新 `apply()`（新的協調器實例、`revision` 歸零），但 ESM 的模組快取仍供應舊的
模組世代——`ctx.effect` 重跑的是舊程式碼。瀏覽器半邊（`lib/client.js`）不同：它每次
由 client-modules 重新讀檔並產生新的 bundle rev，重整頁面即生效。

## 驗證現況

下表是在一台已安裝並在跑的 DSH 上、用同一組指令量到的；換一台機器重跑即可複現。

| 項目 | 證據 |
|---|---|
| 單元測試（NFR-7） | `node --test test/*.test.js` → **204 tests / 204 pass / 0 fail / 0 todo**（2026-10-07 實測；Node 20／22／24 皆同） |
| Host 半邊對真實 CLI | `node tools/verify-keeper.mjs` → **23/23**（唯讀掃描 + 孤兒收斂 + 未納管不得重建 + 圖譜 UI 連結） |
| 圖譜 UI 連結 | 同一支驗證器的最後四項：連結指向 `127.0.0.1:<ui_port>/?tab=graph`、探測結果是布林、每個已納管專案都有 `?project=` 深連結（對 `127.0.0.1:9749` 實測） |
| 客戶端渲染 | `node tools/verify-client.mjs` → **212/212**（2026-10-07 實測；用執行中伺服器的真實回應逐值比對，另含輪詢節流與退避的假時鐘測試、以及英文介面的零 CJK 斷言） |
| CLI 解析（FR-5） | `cliPath=~/.local/bin/codebase-memory-mcp`, `source=PATH`, `cliVersion=0.11.0`, `supported=true` |
| 自動納管（FR-7/US-4） | 拋棄式倉庫索引後，下一次 `POST /check` 即被納管並建立監看 |
| 落後偵測（FR-2） | 樣本倉庫：`graphHead=liveHead`, `stale=false`, `behindBy=0`, `confidence=head` |
| 條件式重建（FR-3） | 全部新鮮時 `POST /rebuild` 回 `queued: 0, skipped: 3`；`staleOnly` 回 `沒有落後的專案` |
| 端到端追上（US-1） | 對樣本倉庫提交後 **18.5 秒**圖譜追上（`watch.triggered` → `rebuild.done caughtUp=true`，索引本身 4.42 s） |
| 觀測面（FR-8/9/10） | 卡片逐值呈現 CLI 路徑／版本／兩個 HEAD／落後量／watcher／警告；無提交的倉庫顯示「無法判定」 |
| 失敗可見（FR-10） | 該倉庫的 `lastCheckedError` 是「這個專案尚無提交（unborn HEAD）…」＋ git 原始訊息 |
| 版本護欄（FR-15） | `0.11.0` 命中支援矩陣；清單外版本在卡片上轉為警告 |
| 不覆寫 profile patch（NFR-5） | 安裝前後 `~/.dsh/profiles/web/cordis.patch.yml` 逐位元組相同 |
| 完整移除（NFR-8） | `remove_bundle` 後 bundle 列表與相依皆移除、路由下線；`cordis.patch.yml` 不變 |
| 設定可配置（障礙排除） | 官方探針 `Config.listConfigs` 對 entry `codebase-watcher` 由 `status: absent` 變 **`status: schema`**；`POST /api/codebase-watcher/config` 回 `{"ok":true}`，寫入後 `cliSource` 由 `config` 回到 `PATH` |
| 卸載演練（NFR-8 的動態面） | 重建進行中（慢速 CLI 包裝，子行程 `sleep 900`）停用 bundle：日誌依序 `rebuild.abandoned`（`durationMs=6880 ok=false`）→ `keeper.stopped` → `plugin.stop`，子行程消失；`rm -rf ~/.dsh/codebase-watcher` 後 12 秒目錄未回來（沒有遲到的落盤） |

驗證是在一台**已經安裝並正在跑的** DSH 上進行的（預設 `http://127.0.0.1:3080`）。表中的每一項都能
用同一組指令重跑複現；與主機無關的部分（例如 `profilePackageRoots()` 的解析順序）在單元測試裡也
有對應案例。**改動 `lib/` 之後仍必須重啟 `dsh web` 才會換代**：ESM 模組快取仍供應舊的模組
世代，重新 apply 只會重跑舊程式碼。

## 怎麼重跑 dirty 追逐的量測

`tools/bench-dirty-chase.mjs` 用真的 `CbmKeeper`、真的 `node:fs.watch` 與真的計時器，把 git 探針、
CBM CLI 與重建本身換成可計數的注入替身，模擬「一個人連續編輯 20 秒、共 50 次存檔，然後停手 12 秒」，
用「每輪編輯產生幾次重建」比較 `dirtySettleSeconds` 前後的差異。

```bash
npm run bench                                          # A/B 兩組（0 與 90 秒）都跑
node tools/bench-dirty-chase.mjs --settle 90           # 只跑一組，參數是真實秒數
node tools/bench-dirty-chase.mjs --json                # 機器可讀
node tools/bench-dirty-chase.mjs --assert --settle 90  # CI 用：不合格就 exit 1
```

**口徑要講清楚**：這是**比例模型**——真的 `CbmKeeper`、真的 `node:fs.watch`、真的計時器，但 git 探針／
CBM CLI／重建本身是注入替身，**呼叫次數等於真實的子行程次數**。時間參數等比壓縮約 1/30
（存檔間隔 400 ms、防抖 300 ms、冷卻 1.5 s、單次重建 250 ms，**比例維持不變**，可以外推），
所以畫面印出來的毫秒**不是真實秒數**，要乘回去才是。

實測對照：`dirtySettleSeconds = 0`（等於關掉 settle 視窗，也就是 0.3.0 的行為）在編輯期間排入 10 次
重建，而 **10 次全部被 CBM 以 `aborted_previous_preserved` 中止，圖譜一次都沒有追上**；`90`（現在的預設）
則編輯期間 0 次重建、成功 1 次、被中止 0 次，停手後追上。CI 有一個獨立 job 跑 `--assert --settle 90`，
擋的就是前者回來。

工具會先檢查 settle 視窗塞不塞得進觀察窗；塞不進去時它會直接講明「量到的 0 次不代表抑制成功」，
看到那行就別把 0 當成結果。

## 為什麼 `Config` 可能是 undefined

**症狀**：設定頁與 `POST /config` 回 `No configurable plugin entry`，官方探針
（`cordis_inspect_query`，provider `Config`、method `listConfigs`）對 entry `codebase-watcher`
回 `status: absent`。插件本身照常運作，只是該 entry 不再「可配置」。

原因是兩個陷阱疊在一起：

- 本插件以 `link:` 安裝時 `import.meta.url` 指向這個目錄，從這裡往上走的 `node_modules` 鏈
  **到不了** profile 的 `node_modules`。
- `DSH_PROFILE_DIR` 只由 `dsh-shell-env` 注入**每一次模型 shell 呼叫的子行程**，載入插件的
  宿主行程裡並沒有它——實測 `dsh web` 的 `/proc/<pid>/environ` 完全沒有 `DSH_*`。

**做法**：`lib/config.js` 的解析根順序是「環境有給的 profile → 自己 → cwd → **DSH home 底下的
`profiles/*`（把真的 link 了本插件的那個排前面）**」，見 `schemasteryRequireRoots()` 與
`profilePackageRoots()`。全部落空時 `Config` 會匯出成 `undefined`。

設定服務只要求 `Config` 有 `toJSON` 且欄位是 volatile，而 volatile 參照用
`Symbol.for('cosmokit.volatile.write')` 跨副本識別，因此用 profile 那一份編出來的 schema
在 harness 自己的設定服務上完全可用（逐條驗過三道門：schema 可列舉、欄位可寫入、
寫入後設定服務讀得到新值）。
