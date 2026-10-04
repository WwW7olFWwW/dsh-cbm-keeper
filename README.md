# dsh-cbm-keeper

[![CI](https://github.com/WwW7olFWwW/dsh-cbm-keeper/actions/workflows/ci.yml/badge.svg)](https://github.com/WwW7olFWwW/dsh-cbm-keeper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-106%20pass-brightgreen.svg)](test)

讓 CBM 的知識圖譜自動跟上每個已索引專案的 git HEAD，並把「哪些專案過期、差多少、為什麼失敗」變成看得見的東西。

English: [`README.en.md`](README.en.md)

DSH 只用一行 MCP row 接 CBM 時，**查詢能用，但「圖譜保持新鮮」整件事會失效**——實測曾經落後 33 小時／37 個提交／988 個新增檔，而所有當事人都以為它是新的。三個缺陷疊加：MCP 的 `cwd` 是 profile 級常數、CBM 內建 watcher 不產生可觀測的重建、MCP 工具 `index_repository` 有 60 秒上限（本專案索引要 60,980 ms）。本插件把這三件事繞過去。

---

## 安裝

```bash
dsh plugin --profile web add github:WwW7olFWwW/dsh-cbm-keeper
```

裝完**不用重啟**：卡片會出現在 設定 →「CBM 圖譜」（沒有就重整一次頁面）。
順手關掉上游那個無條件的全量重建——每開一個 session 白燒約 61 秒／658 MB，而且追不上 HEAD：

```bash
codebase-memory-mcp config set auto_index false
```

## 它做什麼

- **認專案**：以 `realpath(root_path)` 為唯一鍵，同一棵樹的別名合併成一列。
- **判落後**：圖譜 `Branch.head_sha` 對 `git rev-parse HEAD`，給精確的 `behindBy`；沒有 `Branch` 節點時退用 `indexed_at`／DB mtime。證據不足就回「無法判定」，**不假裝新鮮**。
- **只重建落後的**：全域併發 1；已對上 HEAD 時 `POST /rebuild` 回 `queued: 0`，不產生任何索引工作。
- **重建走 CLI 子行程**（`codebase-memory-mcp cli index_repository`），不受 MCP 工具 60 秒上限約束。
- **存檔後自動追上**：每專案檔案監看，防抖後重建；chokidar 缺席時退回 `node:fs.watch`。

不改 CBM 本體、不改 DSH 本體、不用 systemd timer。

## 設定

15 個欄位（`enabled`、`cliPath`、`mode`、`scanMinutes`、`autoRebuild`、`extensions` …）全是 volatile，設定頁與 `cordis.patch.yml` 都能改；REST 控制面與 UI 同源，卡片上的每個動作都能用 curl 打。
完整欄位與路由見 [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)。

## 已知限制

- chokidar 是可選相依；缺席時退回 `node:fs.watch`，語意相同。
- 以家目錄為根的專案不支援 CBM 監看（上游安全政策）——本插件自己的監看不受影響。
- 圖譜的結構宣告（`routes`／`layers`／`languages`）不可作為證據，卡片上固定標示。

其餘（孤兒專案、unborn HEAD、`stop()` 的 join、`@deepseek-ai/schemastery` 解析路徑）見 [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md)。

## 移除

```bash
dsh plugin --profile web remove dsh-cbm-keeper
rm -rf ~/.dsh/cbm-keeper
```

## 開發

```bash
node --test test/*.test.js     # 106 項單元測試，不需要真的索引
node tools/verify-keeper.mjs   # 對真實 CBM CLI 唯讀掃描
```

改完 `lib/` 要 `systemctl --user restart dsh-web` 才生效（`link:` 安裝的 ESM 模組快取不會熱載入）。

[架構與檔案職責](docs/ARCHITECTURE.md) ｜ [驗證現況](docs/DEVELOPMENT.md) ｜ [需求規格](docs/REQUIREMENTS.md) ｜ [貢獻指南](CONTRIBUTING.md) ｜ [變更記錄](CHANGELOG.md)

---

## 授權

[MIT](LICENSE) © 2026 [WwW7olFWwW](https://github.com/WwW7olFWwW)。本專案是獨立的社群插件，與 DeepSeek 官方無隸屬關係。
