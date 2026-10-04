# 貢獻指南

感謝你願意讓 DSH 社群更好用。這個專案刻意保持小：**純 ESM JavaScript、沒有建置步驟、沒有執行期相依**
（`chokidar` 是 optional，缺席時自動退回 `node:fs.watch`）。

## 開發環境

- Node.js >= 20（CI 跑 20 / 22 / 24）
- 不需要 `npm install` 就能跑測試

## 跑測試

```bash
node --test test/*.test.js
```

**glob 不要加引號**：Node 20 的 `--test` 不會自己展開 glob，`"test/*.test.js"` 會被當成一個字面路徑
（CI 上會看到 `Could not find '.../test/*.test.js'`）。交給 shell 展開，20／22／24 都成立。

**不要寫成 `node --test test/`**：Node 會把 `test/` 當成模組而非測試目錄，直接解析失敗。

目前的基準是 **106 tests / 106 pass / 0 fail**。送 PR 前請確認沒有回歸。

想跑真實 CLI 的唯讀驗證（需要 `codebase-memory-mcp` 在 PATH）：

```bash
node tools/verify-keeper.mjs
```

## 程式風格

- 純 ESM；2 空白縮排；單引號；行尾分號。
- **優先用 `function` 宣告，不要用箭頭函數**（回呼參數除外）。
- 註解用繁體中文，並在註解裡標明它對應的需求編號（`FR-n` / `NFR-n`，見
  [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md)）。
- **純決策邏輯放 `lib/staleness.js`**：它不碰檔案系統、不開子行程，所有外部事實都靠參數傳入。
  凡是「判定」類的邏輯都應該放得進這一層，因為它能在單元測試裡逐值驗證，不需要真的索引任何東西。
- 對外欄位一律**同時給值與判據來源**（例如 `graphHead` 配 `liveHead`、`stale` 配 `confidence`）。
  寧可回 `null` 加一句「證據不足」，也不要給一個看起來很肯定的猜測。

## 送 PR

1. 開 issue 或在 PR 描述裡說清楚：**哪個需求編號**、**你觀察到什麼**、**怎麼重現**。
2. 一個 PR 只解一件事；`lib/` 的改動請附上對應的 `test/` 案例。
3. 如果 CI 紅了，先修 CI 再請求 review。

## 改動 `lib/` 之後的注意事項

以 `link:` 方式安裝的 bundle，改完 `lib/*.js` **不會**熱載入：ESM 模組快取仍供應舊世代，
`ctx.effect` 重跑的是舊程式碼。本機測試請重啟 `dsh web`。
瀏覽器半邊（`lib/client.js`）不受此限，重整頁面即生效。

## 新增一個設定欄位時要同步的四個地方

1. `lib/config.js` 的 `CONFIG_FIELDS`（含 `volatile()` 與 `.description()`）
2. `lib/client.js` 設定頁卡片上的顯示／編輯
3. `README.md` 的設定表格
4. `test/config.test.js` 的界線與清單語意測試

漏掉第 4 項是最常見的回歸來源。

## 授權

送出的貢獻以 [MIT License](LICENSE) 授權。
