# 架構

```
瀏覽器（設定 →「CBM 圖譜」）
   │  settings.section slot，純 fetch
   ▼
/api/codebase-watcher/{state,log,check,rebuild,watchers,config}      ← Host 半邊（lib/routes.js）
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
| [`lib/index.js`](../lib/index.js) | Host 插件入口：`ctx.effect` 掛生命週期與路由 |
| [`lib/keeper.js`](../lib/keeper.js) | 協調器：掃描、判定、佇列、監看、鎖 |
| [`lib/staleness.js`](../lib/staleness.js) | 純決策：身分鍵、落後判定、模式選擇（可單元測試，不需真的索引） |
| [`lib/cbm.js`](../lib/cbm.js) | CBM CLI 的文字輸出解析（`--json` 只是把 MCP 信封原樣包出） |
| [`lib/cli.js`](../lib/cli.js) | CLI 路徑解析順序與 `--json` 信封解析 |
| [`lib/git.js`](../lib/git.js) | git 探針：HEAD、提交時間、`rev-list --count`、髒污 |
| [`lib/watcher.js`](../lib/watcher.js) | 每專案檔案監看（chokidar → fs.watch 退路） |
| [`lib/state.js`](../lib/state.js) | 原子狀態檔（崩潰後恢復重建意圖） |
| [`lib/log.js`](../lib/log.js) | 帶時間戳的結構化日誌（記憶體環 + 落檔） |
| [`lib/routes.js`](../lib/routes.js) | REST 控制面 |
| [`lib/client.js`](../lib/client.js) | 瀏覽器半邊：設定頁觀測卡片 |
| [`tools/verify-client.mjs`](../tools/verify-client.mjs) | 客戶端渲染驗證器（無瀏覽器也能驗證卡片畫得出來） |
| [`tools/verify-keeper.mjs`](../tools/verify-keeper.mjs) | Host 半邊對真實 CBM CLI 的驗證器（唯讀） |

## 落後語意（FR-9）

對外一律同時給 `graphHead` 與 `liveHead`，並附上判據來源：

| `confidence` | 意義 |
|---|---|
| `head` | 主判據：圖譜 `Branch.head_sha` 對上 `git rev-parse HEAD`。`behindBy` 是精確提交數。 |
| `time` | 退路（R2）：圖譜沒有 `Branch` 節點時，改用 `indexed_at`／DB mtime 與 HEAD 提交時間比較。`behindBy` 為 `null`。 |
| `none` | 證據不足（例如專案尚無提交、或不是 git 工作樹）。**`stale` 為 `null`，UI 顯示「無法判定」，絕不會被當成「新鮮」。** |

`index_status` 回報的 `git.head_sha` 是**查詢時即時讀取**的（P6），圖譜沒動也照樣顯示新 HEAD。
本插件不採用它作為新鮮度判據，卡片上也不會出現「看起來是新的」的欄位。
