# dsh-cbm-keeper [![CI](https://github.com/WwW7olFWwW/dsh-cbm-keeper/actions/workflows/ci.yml/badge.svg)](https://github.com/WwW7olFWwW/dsh-cbm-keeper/actions/workflows/ci.yml)

[English](README.en.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：讓 [Codebase Memory](https://github.com/DeusData/codebase-memory-mcp) 的知識圖譜自動跟上每個已索引專案的 git HEAD。只用一行 MCP row 接 CBM 時圖譜會靜默過期（實測落後 33 小時／37 個提交／988 個檔案，而所有人都以為它是新的）；本插件負責落後判定、條件式重建與觀測——**不改 CBM、不改 DSH、不需要 systemd timer**。

## 安裝

```sh
dsh plugin --profile web add github:WwW7olFWwW/dsh-cbm-keeper
```

裝完不用重啟，卡片在 設定 →「CBM 圖譜」。建議同時關掉上游那個無條件的全量重建（每次 session 白燒約 61 秒／658 MB）：

```sh
codebase-memory-mcp config set auto_index false
```

## 功能

- **落後判定**：圖譜 `Branch.head_sha` 對 `git rev-parse HEAD`，給精確 `behindBy`；沒有 `Branch` 節點時退用 `indexed_at`／DB mtime。證據不足回報「無法判定」，不假裝新鮮。
- **條件式重建**：只排入落後的專案，全域併發 1；已對上 HEAD 時 `POST /rebuild` 回 `queued: 0`。
- **繞過 MCP 的 60 秒上限**：重建以子行程呼叫 `codebase-memory-mcp cli index_repository`。
- **存檔後自動追上**：每專案檔案監看與防抖；chokidar 缺席時退回 `node:fs.watch`。
- **觀測與控制**：設定頁卡片與 REST 控制面同源，卡片上的每個動作都能用 curl 打。

## 相容版本

| 插件 | DSH | Codebase Memory |
|---|---|---|
| `0.1.x` | 0.2（`dsh web`） | `codebase-memory-mcp@0.11.0`（清單外版本在卡片上轉為警告） |

## 設定

15 個 volatile 欄位與 7 條 REST 路由：[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)

## 已知限制

chokidar 是可選相依；以家目錄為根的專案不支援 CBM 監看（上游安全政策）；圖譜的結構宣告不可作為證據。
其餘見 [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md)。

## 移除

```sh
dsh plugin --profile web remove dsh-cbm-keeper
rm -rf ~/.dsh/cbm-keeper
```

## 開發

```sh
node --test test/*.test.js   # 106 項單元測試，不需要真的索引
```

改完 `lib/` 需 `systemctl --user restart dsh-web` 才生效（`link:` 安裝的 ESM 快取不會熱載入）。

[架構](docs/ARCHITECTURE.md)｜[驗證現況](docs/DEVELOPMENT.md)｜[需求規格](docs/REQUIREMENTS.md)｜[貢獻指南](CONTRIBUTING.md)｜[變更記錄](CHANGELOG.md)｜[問題回報](https://github.com/WwW7olFWwW/dsh-cbm-keeper/issues)

## 授權

[MIT](LICENSE) © 2026 [WwW7olFWwW](https://github.com/WwW7olFWwW)
