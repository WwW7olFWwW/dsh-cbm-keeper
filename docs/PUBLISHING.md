# 發布清單

**現況：這個套件沒有發布到 npm。** 安裝走 GitHub 規格、Release tarball 或插件市場
（見 [README 的安裝一節](../README.md#安裝)）。這份清單是等要補發 npm 時照著跑用的，
寫在這裡是為了讓發布這件事可執行，不是公告已經發布。

## 為什麼要發

現在從 npm 安裝會失敗——`dsh plugin add dsh-codebase-watcher` 對裸名會去 registry 查，
而 registry 上沒有這個名字。發了 npm 之後：

- `dsh plugin --profile <你的 profile> add dsh-codebase-watcher` 直接成立。
- 目錄端**不需要改任何欄位**：`awesome-dsh-plugin` 的 npm 映射由 registry 自動採集，
  手寫 `npm:` 欄位反而會被目錄 CI 拒。目錄條目只填 `tarball:`，維持現狀即可。

## 前置

- npm 帳號對 `dsh-codebase-watcher` 這個名字有發布權。
- 兩種登入方式，挑一種：
  - 互動：`npm login`（本機目前**沒有** `~/.npmrc`，`npm whoami` 回 `ENEEDAUTH`）。
  - CI 或非互動：環境變數 `NPM_TOKEN`，搭配一行的 `~/.npmrc`：

    ```
    //registry.npmjs.org/:_authToken=${NPM_TOKEN}
    ```

    權杖要是 **Automation** 或 **Granular（含 publish 權限）** 類型，
    否則帳號開了 2FA 時 `npm publish` 會卡在 OTP 提示。
- `package.json` 已經就緒，不用改：`publishConfig.access=public`、`repository`、
  `homepage`、`bugs`、`license` 都在。`engines.node` 目前是 `>=20.13`（Linux 遞迴 `fs.watch` 的下限），
  若要跟著程式實際用到的新 API 收緊，**那是另一個改動**，不要夾在發布裡做。

## 步驟

1. **確認身分**

   ```sh
   npm whoami            # 必須回你的帳號，不能是 ENEEDAUTH
   npm config get registry   # 必須是 https://registry.npmjs.org/
   ```

2. **版本對齊**：`package.json` 的 `version`、CHANGELOG 最上面那一版、git tag 三者一致。
   tag 先打好再發，順序反了會出現「registry 有版本、repo 找不到對應 tag」。

3. **看一次會出什麼包**（不會上傳）

   ```sh
   npm pack --dry-run
   ```

   在 0.3.0 上實測：**27 個檔案、package 104.3 kB、解開後 325.9 kB**。
   內容是 `lib/**/*.js`、`cordis.patch.yml`、README 兩份、CHANGELOG、CONTRIBUTING、
   LICENSE、`docs/`。這個套件**沒有建置步驟**（沒有 `prepare`／`prepublishOnly`），
   發布出去的就是原始碼本身，所以看到什麼就等於裝到什麼。

4. **乾跑一次**

   ```sh
   npm publish --dry-run
   ```

   確認 tarball 檔名是 `dsh-codebase-watcher-<version>.tgz`、且沒有多帶檔案。

5. **發布**

   ```sh
   npm publish
   ```

   `publishConfig.access=public` 已設，不需要再帶 `--access public`。

6. **事後驗證**（三件事都要成立）

   ```sh
   npm view dsh-codebase-watcher version        # 回剛發的版本
   npm view dsh-codebase-watcher dist.tarball   # 回 registry 上的 tarball 位址
   ```

   再找一台乾淨的機器（或一個乾淨的 profile）實際裝一次：

   ```sh
   dsh plugin --profile <你的 profile> add dsh-codebase-watcher
   ```

   裝完照 README 的「怎麼確認裝成功」看一次 `GET /state`。

## 發完之後

- Release 頁補一筆對應版本的 tarball，讓市場安裝那條路繼續有效。
- 若 CI 之後要自動發布，把上面的步驟包成一個只在 tag push 時觸發的 job；
  `NPM_TOKEN` 放 repo secret，不要寫進任何檔案。
