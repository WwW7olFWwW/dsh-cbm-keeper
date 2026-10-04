# 開發與驗證

## 跑起來

```bash
node --test test/*.test.js             # 單元測試（106 項，不需要真的索引）
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

本機實測結論（2026-10-04）：以 `link:` 安裝的 bundle，改動 `lib/*.js` 後**不會**被
熱載入。`install_bundle`、`remove_bundle`、`set_bundle` 停用再啟用，都會讓 Loader
重新 `apply()`（新的協調器實例、`revision` 歸零），但 ESM 的模組快取仍供應舊的
模組世代——`ctx.effect` 重跑的是舊程式碼。瀏覽器半邊（`lib/client.js`）不同：它每次
由 client-modules 重新讀檔並產生新的 bundle rev，重整頁面即生效。

## 驗證現況（2026-10-04）

| 項目 | 證據 |
|---|---|
| 單元測試（NFR-7） | `node --test test/*.test.js` → **106 tests / 106 pass / 0 fail / 0 todo**（Node 20／22／24 皆同） |
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
