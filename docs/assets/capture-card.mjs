#!/usr/bin/env node
/**
 * 產生 README 用的「CBM 圖譜」卡片截圖。
 *
 * 為什麼要有這支：這個插件賣的就是設定頁那張卡片，但 repo 裡沒有任何圖片。
 * 它不引入任何相依——直接用 Chrome 的 CDP（Node 22+ 的原生 WebSocket），
 * 拍的是**真正在跑的 DSH GUI**、**真正的 /api/codebase-watcher/state 資料**，
 * 不是另外畫一張示意圖。
 *
 * 用法：
 *   node docs/assets/capture-card.mjs --out docs/assets/cbm-card.png
 *   node docs/assets/capture-card.mjs --out docs/assets/cbm-card-en.png --lang en
 *
 * 參數：
 *   --out <path>    輸出 PNG（必填）
 *   --lang <zh|en>  要拍的介面語言；與現況不同時會先切換，拍完**還原原本的語言**
 *   --base <url>    DSH GUI 來源，預設 http://127.0.0.1:3080
 *   --token <t>     GUI 啟動權杖；預設讀 DSH_WEB_URL，再退回 dsh-web 的 journal
 *   --width <px>    視窗寬度，預設 1180
 *   --scale <n>     像素密度，預設 2
 *   --browser <p>   Chrome 執行檔；預設抓 ~/.cache/ms-playwright 下的 chromium
 *   --keep-open     拍完不關瀏覽器（除錯用）
 *   --keep-lang     不還原介面語言（要把使用者的語言真的切成 --lang 時用）
 *   --expand-config 先展開卡片上的「設定」區塊再拍（預設收起）
 *   --only-config   只裁「設定」區塊，不拍整張卡
 *   --probe-height  探針視窗高度，預設 1600（太矮會點不到側邊欄底部的「设置」）
 *
 * 前置：`dsh web` 正在跑，且本機已安裝 Playwright 的 chromium（只要執行檔，不需要 driver）。
 *
 * 注意：GUI 是登入態的（`dsh web` 會印一組 ?token=...）。本腳本只讀該權杖、只用於連本機，
 * 不會把它寫進任何檔案或輸出。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/* ------------------------------------------------------------------ 參數 */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    // --only-config → onlyConfig：旗標名用 kebab，程式裡讀 camel。
    const name = key.slice(2).replace(/-([a-z])/g, function (_m, ch) { return ch.toUpperCase(); });
    const next = argv[i + 1];
    // 沒有下一個參數、或下一個又是 --flag 時，這是一個布林旗標。
    // （先前把布林旗標寫成特例，結果新增的旗標會默默吃掉下一個參數而完全沒作用。）
    if (next === undefined || next.startsWith('--')) { out[name] = true; continue; }
    out[name] = next;
    i += 1;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.out) {
  console.error('缺少 --out <path>');
  process.exit(2);
}

const BASE = args.base || process.env.DSH_BASE || 'http://127.0.0.1:3080';
const WIDTH = Number(args.width || 1180);
const SCALE = Number(args.scale || 2);
const WANT_LANG = args.lang === 'en' ? 'en' : args.lang === 'zh' ? 'zh' : null;
const KEEP_OPEN = args.keepOpen === true;
/** 探針視窗高度。側邊欄工作區一多，底部那一列（記憶／設定）會被推出視窗，
 *  findByText 的命中測試就點不到——1500 以上才穩。 */
const PROBE_HEIGHT = Number(args.probeHeight || 1600);
/** 保留切換後的語言，不還原（要把使用者的介面語言直接改成 --lang 時用）。 */
const KEEP_LANG = args.keepLang === true;
/** 先展開卡片上的「設定」區塊再拍（該區塊預設收起，價值在展開後）。 */
const EXPAND_CONFIG = args.expandConfig === true;
/** 只裁「設定」區塊本身，不拍整張卡。 */
const ONLY_CONFIG = args.onlyConfig === true;

/** 卡片本身有 i18n 字典（lib/client.js 的 zh／en），標題就是最好的就緒訊號。 */
const PANEL_TITLE = { zh: 'Codebase Memory 圖譜新鮮度', en: 'Codebase Memory graph freshness' };
const SECTION_LABEL = { zh: 'CBM 圖譜', en: 'CBM Graph' };
const SETTINGS_LABEL = { zh: '设置', en: 'Settings' };
const SKIP_TOUR_LABEL = { zh: '跳过向导', en: 'Skip tour' };
const LANG_SELECTOR = { zh: '中文', en: 'English' };
const GENERAL_LABEL = { zh: '通用设置', en: 'General' };
/** 卡片上「設定」區塊的展開鈕；展開後文案會變。 */
/** 展開後一定會出現的欄位名，用來確認展開真的完成了。 */
const CONFIG_MARKER = 'dirtySettleSeconds';
const SHOW_CONFIG_LABEL = { zh: '顯示設定', en: 'Show settings' };
const HIDE_CONFIG_LABEL = { zh: '收起設定', en: 'Hide settings' };

/* ------------------------------------------------------- Chrome 與 CDP 客戶端 */

function findChrome() {
  if (args.browser) return args.browser;
  const root = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(root)) return null;
  const candidates = [];
  for (const entry of readdirSync(root)) {
    candidates.push(join(root, entry, 'chrome-linux64', 'chrome'));
    candidates.push(join(root, entry, 'chrome-linux', 'chrome'));
    candidates.push(join(root, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
  }
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function launchChrome(binary, port, scratch) {
  const userDataDir = mkdtempSync(join(scratch, 'profile-'));
  const child = spawn(binary, [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + userDataDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  const deadline = Date.now() + 30000;
  let version = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (response.ok) { version = await response.json(); break; }
    } catch (error) { /* 還沒起來 */ }
    await delay(200);
  }
  if (!version) {
    child.kill('SIGKILL');
    throw new Error('Chrome 未在 30 秒內開啟 CDP 埠 ' + port);
  }
  return { child: child, version: version };
}

function connectCdp(url) {
  const socket = new WebSocket(url);
  const client = { nextId: 0, pending: new Map(), socket: socket };
  socket.addEventListener('message', function (event) {
    const message = JSON.parse(event.data);
    if (message.id === undefined || !client.pending.has(message.id)) return;
    const entry = client.pending.get(message.id);
    client.pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  client.send = function (method, params, sessionId) {
    const id = ++client.nextId;
    const payload = { id: id, method: method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise(function (resolve, reject) {
      client.pending.set(id, { resolve: resolve, reject: reject });
      socket.send(JSON.stringify(payload));
    });
  };
  return new Promise(function (resolve, reject) {
    socket.addEventListener('open', function () { resolve(client); }, { once: true });
    socket.addEventListener('error', function () { reject(new Error('CDP WebSocket 連線失敗')); }, { once: true });
  });
}

/* ------------------------------------------------------------ 頁面操作輔助 */

function makePage(browser, sessionId) {
  const page = { sessionId: sessionId };
  page.send = function (method, params) { return browser.send(method, params, sessionId); };
  page.evaluate = async function (fn, arg) {
    const expression = typeof fn === 'function'
      ? '(' + fn.toString() + ')(' + JSON.stringify(arg === undefined ? null : arg) + ')'
      : fn;
    const result = await page.send('Runtime.evaluate', { expression: expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception;
      throw new Error('頁面內 evaluate 失敗：' + ((detail && detail.description) || result.exceptionDetails.text));
    }
    return result.result.value;
  };
  /**
   * 輪詢到條件成立為止——不用固定 sleep，重跑時不會拍到載入中的畫面。
   * probe 是純函式、arg 會被序列化傳進去（不要用 bind，bind 過的函式 stringify 後會變成 native code）。
   */
  page.waitFor = async function (label, probe, arg, timeoutMs) {
    const limit = timeoutMs || 30000;
    const deadline = Date.now() + limit;
    while (Date.now() < deadline) {
      const value = await page.evaluate(probe, arg);
      if (value) return value;
      await delay(150);
    }
    throw new Error('等待逾時（' + Math.round(limit / 1000) + ' 秒）：' + label);
  };
  page.click = async function (finder, arg) {
    const box = await page.evaluate(finder, arg);
    if (!box) return false;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await page.send('Input.dispatchMouseEvent', {
        type: type, x: box.x, y: box.y, button: 'left', clickCount: 1,
        buttons: type === 'mousePressed' ? 1 : 0,
      });
    }
    await delay(250);
    return true;
  };
  return page;
}

const findByText = function (payload) {
  const nodes = document.querySelectorAll('button, a, [role="button"], [role="tab"], [role="menuitem"], li, div, span');
  for (const node of nodes) {
    const own = (node.innerText || '').trim().replace(/\s+/g, ' ');
    if (payload.exact ? own !== payload.text : own.indexOf(payload.text) === -1) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) continue;
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') continue;
    if (rect.top < 0 || rect.left < 0 || rect.top > innerHeight || rect.left > innerWidth) continue;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    // 命中測試：被模態遮住的元素「看得到但點不到」，直接回 null，
    // 讓呼叫端知道現在有東西蓋在上面，而不是送出一記打在遮罩上的點擊。
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || !(node === hit || node.contains(hit) || hit.contains(node))) continue;
    return { x: cx, y: cy };
  }
  return null;
};

const findScrollPaneWith = function (title) {
  let best = null;
  for (const node of document.querySelectorAll('div')) {
    if ((node.innerText || '').indexOf(title) === -1) continue;
    const style = getComputedStyle(node);
    if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < 300) continue;
    const area = rect.width * rect.height;
    if (!best || area > best.area) best = { area: area, node: node };
  }
  return best ? best.node : null;
};

/**
 * 關掉首次啟動的記憶嚮導。
 *
 * 這個模態**在側邊欄之後才渲染**，所以「看到側邊欄就去找跳過按鈕」會撲空，
 * 接著模態蓋住整個畫面，後面每一個點擊都會打在遮罩上。改成輪詢等它出現。
 *
 * @returns {Promise<boolean>} 是否真的關掉了。
 */
async function dismissTour(page) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    for (const label of [SKIP_TOUR_LABEL.zh, SKIP_TOUR_LABEL.en]) {
      if (await page.click(findByText, { text: label, exact: true })) {
        console.log('關閉嚮導：' + label);
        await delay(900);
        return true;
      }
    }
    await delay(400);
  }
  return false;
}

/**
 * 把設定對話框開起來（已開就直接回 true）。
 *
 * 兩個坑：①「設定開著」不能用本插件的分區標籤來判斷——開著但停在其他分區時，
 * 再點一次側邊欄的「設定」會把它**關掉**；②這個對話框偶爾點一次不出現，
 * 所以要重試。判斷「開著」用一般分區或本分區任一出現即可。
 *
 * @returns {Promise<boolean>} 對話框是否已開。
 */
async function openSettings(page, lang) {
  const labels = [GENERAL_LABEL[lang], SECTION_LABEL[lang]];
  const isOpen = function (list) {
    const text = document.body.innerText;
    for (const label of list) if (text.indexOf(label) !== -1) return true;
    return false;
  };
  if (await page.evaluate(isOpen, labels)) return true;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    // 點不到多半是有模態蓋著；再給嚮導一次機會，然後重試。
    await dismissTour(page);
    await page.click(findByText, { text: SETTINGS_LABEL[lang], exact: true });
    try {
      await page.waitFor('設定對話框', isOpen, labels, 12000);
      return true;
    } catch (error) {
      console.log('  設定對話框沒開，重試（第 ' + attempt + ' 次）');
      await delay(900);
    }
  }
  return false;
}

/**
 * 幫任何 promise 加上逾時。還原語言這條路徑不能有「卡住」這種失敗模式，
 * 所以每一步都自帶上限，卡住就當失敗、進下一輪重試。
 */
function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise(function (_resolve, reject) {
    timer = setTimeout(function () { reject(new Error('逾時 ' + ms + 'ms：' + label)); }, ms);
  });
  return Promise.race([promise, guard]).finally(function () { if (timer) clearTimeout(timer); });
}

/**
 * 把介面語言切回 `toLang`。**這是唯一會動到使用者偏好的動作，所以刻意寫得囉唆**：
 * 每一步都有短逾時、整段最多重試三輪，最後一輪改成重新載入頁面再試（DOM 卡死也能救）。
 *
 * @returns {Promise<boolean>} 還原成功與否。
 */
async function restoreLanguage(page, fromLang, toLang) {
  const titlePresent = function (label) { return document.body.innerText.indexOf(label) !== -1; };
  const step = function (promise, ms, label) { return withTimeout(promise, ms, label); };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      if (attempt === 3) {
        // 前兩輪都失敗：整頁重載，從乾淨的 DOM 再試一次。
        console.log('  還原第 3 輪：重新載入頁面後再試');
        await step(page.send('Page.reload', { ignoreCache: false }), 15000, '重新載入');
        await step(page.waitFor('側邊欄', titlePresent, SETTINGS_LABEL[fromLang], 30000), 32000, '等側邊欄');
        await delay(1500);
      }
      const open = await step(page.evaluate(titlePresent, SECTION_LABEL[fromLang]), 5000, '檢查設定是否已開');
      if (!open) {
        await step(page.click(findByText, { text: SETTINGS_LABEL[fromLang], exact: true }), 5000, '開設定');
        await step(page.waitFor('設定對話框', titlePresent, SECTION_LABEL[fromLang], 10000), 12000, '等設定對話框');
      }
      await step(page.click(findByText, { text: GENERAL_LABEL[fromLang], exact: true }), 5000, '切到一般分區');
      await delay(600);
      await step(page.click(findByText, { text: LANG_SELECTOR[fromLang], exact: true }), 5000, '開語言選單');
      await delay(400);
      await step(page.click(findByText, { text: LANG_SELECTOR[toLang], exact: true }), 5000, '選目標語言');
      await delay(1200);
      if (await step(page.evaluate(titlePresent, SECTION_LABEL[toLang]), 5000, '驗證語言')) return true;
      console.error('  還原第 ' + attempt + ' 輪：切換後驗證不到 ' + toLang);
    } catch (error) {
      console.error('  還原第 ' + attempt + ' 輪失敗：' + error.message);
    }
    await delay(800);
  }
  return false;
}

/* ---------------------------------------------------------------- 主流程 */

const SCRATCH = args.scratch || join(homedir(), 'scratch', 'dsh-cbm-assets');
const port = Number(args.port || 9440 + Math.floor(Math.random() * 100));

function readToken() {
  if (args.token) return args.token;
  if (process.env.DSH_TOKEN) return process.env.DSH_TOKEN;
  if (process.env.DSH_WEB_URL) {
    const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(process.env.DSH_WEB_URL);
    if (match) return match[1];
  }
  const journal = spawnSync('journalctl', ['--user', '-u', 'dsh-web', '--no-pager', '-n', '3000'], { encoding: 'utf8' });
  if (!journal.stdout) return null;
  // 服務重啟過就會有好幾組權杖；只有**最後一組**屬於目前這個行程。
  const all = journal.stdout.match(/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/g);
  if (!all || all.length === 0) return null;
  return all[all.length - 1].replace(/^.*token=/, '');
}

const token = readToken();
if (!token) {
  console.error('找不到 GUI 權杖：請帶 --token，或確認 `dsh web` 由 systemd 使用者服務 dsh-web 啟動。');
  process.exit(2);
}

const chromeBinary = findChrome();
if (!chromeBinary) {
  console.error('找不到 Chrome：請帶 --browser <path>，或安裝 Playwright 的 chromium。');
  process.exit(2);
}

console.log('chrome :', chromeBinary);
console.log('base   :', BASE);
console.log('out    :', args.out);

const chrome = await launchChrome(chromeBinary, port, SCRATCH);
const browser = await connectCdp(chrome.version.webSocketDebuggerUrl);
let originalLang = null;
let langSwitched = false;
let pageRef = null;

try {
  const created = await browser.send('Target.createTarget', { url: 'about:blank' });
  const attached = await browser.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
  const page = makePage(browser, attached.sessionId);
  pageRef = page;
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: PROBE_HEIGHT, deviceScaleFactor: SCALE, mobile: false });

  await page.send('Page.navigate', { url: BASE + '/?token=' + encodeURIComponent(token) });

  // 1) 等到側邊欄出現——代表 app 掛載完成。
  await page.waitFor('DSH 側邊欄與設定入口', function (labels) {
    const text = document.body ? document.body.innerText : '';
    for (const label of labels) if (text.indexOf(label) !== -1) return true;
    return false;
  }, [SETTINGS_LABEL.zh, SETTINGS_LABEL.en], 40000);

  // 2) 首次啟動會有記憶嚮導蓋住畫面；有就關掉，沒有就繼續（輪詢等它渲染完）。
  await dismissTour(page);

  // 3) 判定目前介面語言（設定入口的字串本身就會說）。
  const currentLang = await page.evaluate(function (labels) {
    const text = document.body.innerText;
    if (text.indexOf(labels[0]) !== -1) return 'zh';
    if (text.indexOf(labels[1]) !== -1) return 'en';
    return null;
  }, [SETTINGS_LABEL.zh, SETTINGS_LABEL.en]);
  originalLang = currentLang;
  console.log('目前語言:', currentLang);

  // 4) 需要換語言就換；拍完會還原。
  if (WANT_LANG && currentLang && WANT_LANG !== currentLang) {
    if (!(await openSettings(page, currentLang))) throw new Error('開不了設定對話框');
    if (!(await page.click(findByText, { text: GENERAL_LABEL[currentLang], exact: true }))) {
      throw new Error('找不到「一般」分區 ' + GENERAL_LABEL[currentLang]);
    }
    await delay(600);
    if (!(await page.click(findByText, { text: LANG_SELECTOR[currentLang], exact: true }))) {
      throw new Error('找不到語言選擇器 ' + LANG_SELECTOR[currentLang]);
    }
    await delay(400);
    if (!(await page.click(findByText, { text: LANG_SELECTOR[WANT_LANG], exact: true }))) {
      throw new Error('找不到語言選項 ' + LANG_SELECTOR[WANT_LANG]);
    }
    langSwitched = true;
    await page.waitFor('介面切換為 ' + WANT_LANG, function (label) {
      return document.body.innerText.indexOf(label) !== -1;
    }, SECTION_LABEL[WANT_LANG], 15000);
    console.log('已切換語言 →', WANT_LANG);
  }

  const lang = WANT_LANG || currentLang || 'zh';

  // 5) 開設定、選到本插件的分區。
  //    剛剛為了換語言已經把設定開著了，再點一次側邊欄會把它關掉。
  if (!(await openSettings(page, lang))) throw new Error('開不了設定對話框');
  // 5b) 設定 shell 在遠端往返之後會把 activeId 打回預設分區，開好的卡片約 2–3 秒後被卸載。
  //     所以「點開 → 標題出現」不算成功：**標題和內容都要**撐過那個視窗才算數，
  //     不然會拍到一張正在載入、甚至已經被卸載的卡片。
  const titlePresent = function (title) { return document.body.innerText.indexOf(title) !== -1; };
  const cardReady = function (payload) {
    const text = document.body.innerText;
    if (text.indexOf(payload.title) === -1) return false;
    // 「CLI」兩種語言的卡片都有，是比標題更強的就緒訊號（標題會在載入中就出現）。
    return text.indexOf(payload.marker) !== -1;
  };
  const readyPayload = { title: PANEL_TITLE[lang], marker: 'CLI' };
  let cardStable = false;
  for (let attempt = 0; attempt < 5 && !cardStable; attempt += 1) {
    if (!(await page.click(findByText, { text: SECTION_LABEL[lang], exact: true }))) {
      throw new Error('設定頁找不到分區「' + SECTION_LABEL[lang] + '」');
    }
    try {
      await page.waitFor('卡片內容', cardReady, readyPayload, 15000);
    } catch (error) {
      console.log('  卡片內容沒出現，重試（第 ' + (attempt + 1) + ' 次）');
      continue;
    }
    await delay(3500);
    cardStable = await page.evaluate(cardReady, readyPayload);
    if (!cardStable) console.log('  卡片被設定 shell 打回預設分區，重開（第 ' + (attempt + 1) + ' 次）');
  }
  if (!cardStable) throw new Error('卡片一直被打回預設分區，開不起來');

  // 7) 設定面板是固定高度的容器，內容會被裁掉；把它與祖先的固定高度解開，
  //    讓內容區長到全高。DOM 與資料都不動，只有容器高度。
  const layout = await page.evaluate(function (title) {
    const findPane = function () {
      let best = null;
      for (const node of document.querySelectorAll('div')) {
        if ((node.innerText || '').indexOf(title) === -1) continue;
        const style = getComputedStyle(node);
        if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') continue;
        const rect = node.getBoundingClientRect();
        if (rect.width < 300) continue;
        const area = rect.width * rect.height;
        if (!best || area > best.area) best = { area: area, node: node };
      }
      return best ? best.node : null;
    };
    const pane = findPane();
    if (!pane) return null;
    let node = pane;
    while (node && node !== document.documentElement) {
      node.style.height = 'auto';
      node.style.maxHeight = 'none';
      node = node.parentElement;
    }
    const overlay = pane.closest('div[class*="overlay"]');
    if (overlay) { overlay.style.alignItems = 'flex-start'; overlay.style.paddingTop = '16px'; }
    pane.scrollTop = 0;
    const rect = pane.getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: rect.width, h: pane.scrollHeight };
  }, PANEL_TITLE[lang]);
  if (!layout) throw new Error('找不到卡片的捲動容器');

  await page.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: Math.ceil(layout.h + 40), deviceScaleFactor: SCALE, mobile: false,
  });
  await delay(500);

  // 量一次卡片、把視窗調到剛好裝得下。展開「設定」區塊之後卡片會長高，
  // 所以整段包成函式，展開後再跑一次——不然裁切高度會是展開前的舊值。
  const fitToCard = async function () {
    // 改變視窗大小會讓框架重繪、把上面解開的固定高度放回去，所以量測前再解一次。
    await page.waitFor('卡片回到畫面', function (title) {
      return document.body.innerText.indexOf(title) !== -1;
    }, PANEL_TITLE[lang], 20000);
    const measured = await page.evaluate(function (title) {
    const collect = function (requireScroller) {
      let best = null;
      for (const node of document.querySelectorAll('div')) {
        if ((node.innerText || '').indexOf(title) === -1) continue;
        if (requireScroller) {
          const style = getComputedStyle(node);
          if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') continue;
        }
        const rect = node.getBoundingClientRect();
        if (rect.width < 300) continue;
        const area = rect.width * rect.height;
        if (!best || area > best.area) best = { area: area, node: node };
      }
      return best;
    };
    // 重繪可能把捲動容器換掉，先找捲動容器，找不到就退而求其次找最大的卡片容器。
    const best = collect(true) || collect(false);
    if (!best) return null;
    let node = best.node;
    while (node && node !== document.documentElement) {
      node.style.height = 'auto';
      node.style.maxHeight = 'none';
      node = node.parentElement;
    }
    const overlay = best.node.closest('div[class*="overlay"]');
    if (overlay) { overlay.style.alignItems = 'flex-start'; overlay.style.paddingTop = '16px'; }
    const rect = best.node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: rect.width, h: best.node.scrollHeight };
  }, PANEL_TITLE[lang]);
    if (!measured) return null;
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH, height: Math.ceil(measured.y + measured.h + 24), deviceScaleFactor: SCALE, mobile: false,
    });
    await delay(400);
    return measured;
  };

  let box = await fitToCard();
  if (!box) throw new Error('量不到卡片尺寸');

  // 7b) 卡片上的「設定」區塊預設收起；要拍展開狀態就先按展開，等欄位真的出現，再重新量一次。
  if (EXPAND_CONFIG || ONLY_CONFIG) {
    if (!(await page.click(findByText, { text: SHOW_CONFIG_LABEL[lang], exact: true }))) {
      console.log('  找不到「' + SHOW_CONFIG_LABEL[lang] + '」，可能已經展開');
    }
    await page.waitFor('設定欄位列', function (marker) {
      return document.body.innerText.indexOf(marker) !== -1;
    }, CONFIG_MARKER, 15000);
    await delay(600);
    box = await fitToCard();
    if (!box) throw new Error('展開後量不到卡片尺寸');
  }

  // 7c) 只裁「設定」區塊：同時含展開鈕與欄位名的最小容器。
  if (ONLY_CONFIG) {
    const block = await page.evaluate(function (payload) {
      let best = null;
      for (const node of document.querySelectorAll('div, section')) {
        const text = node.innerText || '';
        if (text.indexOf(payload.marker) === -1) continue;
        if (text.indexOf(payload.button) === -1) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width < 300 || rect.height < 80) continue;
        const area = rect.width * rect.height;
        if (!best || area < best.area) best = { area: area, x: rect.x, y: rect.y, w: rect.width, h: rect.height };
      }
      return best;
    }, { marker: CONFIG_MARKER, button: HIDE_CONFIG_LABEL[lang] });
    if (!block) throw new Error('找不到「設定」區塊');
    console.log('設定區塊 =', JSON.stringify(block));
    box = { x: block.x, y: block.y, w: block.w, h: block.h };
  }

  const shot = await page.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 },
  });
  const buffer = Buffer.from(shot.data, 'base64');
  writeFileSync(args.out, buffer);
  console.log('已寫入 :', args.out, buffer.length + ' bytes', Math.round(box.w * SCALE) + 'x' + Math.round(box.h * SCALE));

} finally {
  // 8) 還原使用者的介面語言。放在 finally：中途失敗也不能把使用者的 GUI 留在別的語言。
  if (langSwitched && pageRef && !KEEP_LANG) {
    let restored = false;
    try {
      // 整段還原再包一層上限，確保它不可能讓腳本卡住不返回。
      restored = await withTimeout(restoreLanguage(pageRef, WANT_LANG, originalLang), 120000, '語言還原');
    } catch (error) {
      console.error('語言還原整體逾時：' + error.message);
    }
    if (restored) {
      console.log('已還原語言 →', originalLang);
    } else {
      console.error('');
      console.error('!!! 語言還原失敗——使用者的介面語言目前是 ' + WANT_LANG + '，需要手動切回 ' + originalLang + ' !!!');
      console.error('!!! 手動步驟：設定 → ' + GENERAL_LABEL[WANT_LANG] + ' → 語言選擇器 → 選 ' + (originalLang === 'zh' ? '中文' : 'English') + ' !!!');
      console.error('');
      process.exitCode = 3;
    }
  }
  if (!KEEP_OPEN) {
    try { browser.socket.close(); } catch (error) { /* 已關 */ }
    chrome.child.kill('SIGKILL');
  }
}
