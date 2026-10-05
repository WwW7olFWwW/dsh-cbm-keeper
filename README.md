# dsh-codebase-watcher [![CI](https://github.com/WwW7olFWwW/dsh-codebase-watcher/actions/workflows/ci.yml/badge.svg)](https://github.com/WwW7olFWwW/dsh-codebase-watcher/actions/workflows/ci.yml)

[English](README.en.md) | 中文

用一行 MCP row 把 [Codebase Memory](https://github.com/DeusData/codebase-memory-mcp)（CBM）接進 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH），查詢本身沒問題，問題出在圖譜會靜默過期。MCP 的 `cwd` 是 profile 級常數，CBM 的監看與 auto-index 因此落在錯的樹；CBM 內建的 watcher 不產生可觀測的重建；MCP 工具 `index_repository` 還有 60 秒上限。實測圖譜曾落後 33 小時、37 個提交、988 個檔案，而所有人都以為它是新的。

`dsh-codebase-watcher` 自己判斷圖譜落後多少，只在需要時呼叫 CBM 的 CLI 重建，並把結果擺在設定頁看得見的地方。除了裝這個插件，不必改 CBM 或 DSH 的設定，也不用另外掛 systemd timer。

## 需求

- **Codebase Memory**：需要 `codebase-memory-mcp` 這支 CLI，實測 0.11.0；清單外的版本可以用，卡片上會轉為警告。它不在 `PATH` 時卡片顯示「（未解析）」，在設定頁填 `cliPath` 即可。
- **Node.js ≥ 20**，DSH ≥ 0.2.0-rc.2；兩者都由本插件的 `engines` 宣告。
- **專案必須是 git 工作樹**：落後判定靠 `git rev-parse HEAD` 與圖譜的 `Branch.head_sha` 對比。

## 安裝

```sh
dsh plugin --profile web add github:WwW7olFWwW/dsh-codebase-watcher
```

裝好後設定頁會多一張「CBM 圖譜」卡片；沒看到就重整一次頁面。順帶把上游那個無條件的全量重建關掉，它每次 session 會白燒約 61 秒／658 MB：

```sh
codebase-memory-mcp config set auto_index false
```

## 首次啟動

第一次掃描會納管 Codebase Memory 已經索引的全部專案，其中落後的會自動排進重建；重建全域併發 1，所以第一批可能要跑上一陣子。

想先觀察、不讓它動手，把 `autoRebuild` 設成 `false`；或用 `includeProjects` 限定只納管哪幾個專案。

## 功能

- **落後判定**：圖譜的 `Branch.head_sha` 對上 `git rev-parse HEAD`，給出精確的 `behindBy`；沒有 `Branch` 節點時退用 `indexed_at` 與資料庫 mtime，證據不足就回報「無法判定」。
- **條件式重建**：只排入落後的專案；圖譜已經對上 HEAD 時，`POST /rebuild` 回 `queued: 0`，不產生任何索引工作。

重建是以子行程呼叫 `codebase-memory-mcp cli index_repository`，繞過 MCP 工具那個 60 秒上限。每個已納管的專案都有檔案監看與防抖，存檔後自動追上；chokidar 不在時退回 `node:fs.watch`。

設定頁的卡片與 REST 控制面同源，卡片上的每個動作都能用 curl 打。卡片標題列與每個專案列各有一顆連到 CBM 圖譜 UI 的連結（`?project=` 直達單一專案）；UI 沒開或連不上時標明原因，不給點了會壞的按鈕。

## 相容版本

| 插件 | DSH | Codebase Memory |
|---|---|---|
| `0.2.x` | `>=0.2.0-rc.2`（實測 0.2.0-rc.2；由 `engines.dsh` 宣告） | `codebase-memory-mcp@0.11.0`（清單外版本在卡片上轉為警告） |

## 設定

17 個可調欄位與 8 條 REST 路由：[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)。欄位改完立刻生效，不用重啟。

狀態檔在 `~/.dsh/codebase-watcher/state.json`，日誌在 `~/.dsh/codebase-watcher/keeper.log`；唯讀查詢：`curl -s http://127.0.0.1:3080/api/codebase-watcher/state`。

## 已知限制

chokidar 是選用相依，缺席時退回 `node:fs.watch`。以家目錄為根的專案不支援 CBM 監看（上游安全政策）。圖譜的結構宣告不可作為證據。
其餘見 [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md)。

## 移除

```sh
dsh plugin --profile web remove dsh-codebase-watcher
rm -rf ~/.dsh/codebase-watcher
rm -f ~/.dsh/profiles/web/node_modules/dsh-codebase-watcher
```

最後一行清的是 pnpm 對 `link:` 套件的已知殘留：相依移除了，`node_modules` 裡的符號連結還在。卸載不會刪狀態目錄，要你自己刪。

## 開發

```sh
node --test test/*.test.js   # 115 項單元測試，不需要真的索引
```

[架構](docs/ARCHITECTURE.md)｜[驗證現況](docs/DEVELOPMENT.md)｜[需求規格](docs/REQUIREMENTS.md)｜[貢獻指南](CONTRIBUTING.md)｜[變更記錄](CHANGELOG.md)｜[問題回報](https://github.com/WwW7olFWwW/dsh-codebase-watcher/issues)

## 授權

[MIT](LICENSE) © 2026 [WwW7olFWwW](https://github.com/WwW7olFWwW)
