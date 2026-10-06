/**
 * REST 控制面（FR-12）。
 *
 * 與 UI 完全同源：設定頁卡片呼叫的每一支路由，都可以用 curl 直接打，兩邊看到
 * 同一份資料與同一個結果（FR-12 的驗收條件）。路由只註冊在 DSH 的 webServer
 * 上，繼承它既有的 loopback-only 綁定，不另外開監聽埠。
 */

import { API_PREFIX } from './constants.js';
import { CONFIG_FIELDS, defaultConfigValues } from './config.js';

/** 請求內文大小上限：設定面沒有大 payload，超過就是誤用。 */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * 找出一個專案；找不到時回一份現成的 404 回應（D6）。
 *
 * `id` 是 realpath 後的路徑，不是卡片上顯示的 name。打錯時要說找不到，
 * 而不是往下打 CLI 再回一個 502「檢查失敗」或「已對上 HEAD」的誤導訊息。
 * 這段檢查原本在 /check 與 /rebuild 逐字重複兩份，兩邊的說法一旦分岔，
 * curl 與 UI 就會看到不同的錯誤。
 *
 * @param {string} id - 專案身分鍵。
 * @returns {{status: number, payload: object}} 404 回應。
 */
function missingProject(id) {
  return {
    status: 404,
    payload: {
      error: '找不到這個專案：' + id,
      hint: 'id 是專案的絕對路徑；可用 GET /state 的 projects[].key。',
    },
  };
}

/**
 * 專案是否存在（依 list() 的鍵）。
 * @param {import('./keeper.js').CbmKeeper} keeper - 協調器。
 * @param {string} id - 專案身分鍵。
 * @returns {boolean} 存在則 true。
 */
function hasProject(keeper, id) {
  return keeper.list().some(function (project) { return project.key === id; });
}

/**
 * 列出「目前值 ≠ 預設值」的欄位名（排序；WS12）。
 *
 * 判準用**值**而不是「鍵存不存在」：schemastery 會把所有欄位補上 `default()`，
 * 所以鍵集看不出誰被改過。值相同就不算被覆寫——重置它不會有任何改變，列出來
 * 只是噪音。
 *
 * @param {object} values - 目前的可寫設定（config 形狀）。
 * @param {object} defaults - 預設值（config 形狀，見 defaultConfigValues）。
 * @returns {string[]} 被覆寫的欄位名（排序）。
 */
function overriddenFields(values, defaults) {
  if (values === null || typeof values !== 'object') return [];
  return CONFIG_FIELDS
    .filter(function (field) {
      return Object.prototype.hasOwnProperty.call(values, field) && values[field] !== defaults[field];
    })
    .sort();
}

/**
 * 送出一份 JSON 回應。
 * @param {import('node:http').ServerResponse} res - 回應物件。
 * @param {number} status - HTTP 狀態碼。
 * @param {unknown} payload - 要序列化的物件。
 * @returns {void}
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 讀取並解析請求內文。
 * @param {import('node:http').IncomingMessage} req - 請求物件。
 * @returns {Promise<object>} 解析後的物件；空內文回空物件。
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('請求內文過大（上限 ' + MAX_BODY_BYTES + ' bytes）');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text.length === 0) return {};
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('請求內文必須是 JSON 物件');
  }
  return parsed;
}

/**
 * 把一個處理函式包成 WebRoute 的 handler，統一錯誤呈現（FR-10）。
 * @param {string} label - 路由標籤（寫進日誌）。
 * @param {(body: object, query: URLSearchParams) => Promise<{status?: number, payload: unknown}>} handler - 實作。
 * @param {import('./log.js').KeeperLog} log - 日誌器。
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler。
 */
function wrap(label, handler, log) {
  return async function (req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      let body = {};
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        body = await readJsonBody(req);
      }
      const result = await handler(body, url.searchParams);
      sendJson(res, result.status ?? 200, result.payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('route.failed', { route: label, error: message });
      sendJson(res, 400, { error: message, route: label });
    }
  };
}

/**
 * 建立整組路由。
 *
 * @param {object} deps - 協作對象。
 * @param {import('./keeper.js').CbmKeeper} deps.keeper - 協調器。
 * @param {import('./log.js').KeeperLog} deps.log - 日誌器。
 * @param {() => object} deps.config - 讀取執行期設定。
 * @param {(patch: object) => Promise<void>} [deps.updateConfig] - 寫入設定（此部署有 settings 服務時）。
 * @returns {Array<{kind: 'exact', path: string, handler: Function}>} 路由表。
 */
export function makeRoutes(deps) {
  const keeper = deps.keeper;
  const log = deps.log;

  return [
    {
      kind: 'exact',
      path: API_PREFIX + '/state',
      handler: wrap('state', async function (_body, query) {
        const limit = Number.parseInt(query.get('log') ?? '100', 10);
        return {
          payload: {
            status: keeper.status(),
            projects: keeper.list(),
            caveats: keeper.caveats(),
            log: log.recent(Number.isFinite(limit) ? limit : 100),
          },
        };
      }, log),
    },
    {
      kind: 'exact',
      path: API_PREFIX + '/log',
      handler: wrap('log', async function (_body, query) {
        const limit = Number.parseInt(query.get('limit') ?? '200', 10);
        return { payload: { entries: log.recent(Number.isFinite(limit) ? limit : 200) } };
      }, log),
    },
    {
      kind: 'exact',
      path: API_PREFIX + '/check',
      handler: wrap('check', async function (body) {
        const id = typeof body.id === 'string' && body.id.length > 0 ? body.id : undefined;
        if (id !== undefined && !hasProject(keeper, id)) return missingProject(id);
        const result = await keeper.check(id);
        if (!result.ok) return { status: 502, payload: { error: result.error ?? '檢查失敗' } };
        return { payload: { ok: true, status: keeper.status(), projects: keeper.list() } };
      }, log),
    },
    {
      kind: 'exact',
      path: API_PREFIX + '/rebuild',
      handler: wrap('rebuild', async function (body) {
        const mode = typeof body.mode === 'string' ? body.mode : undefined;
        const force = body.force === true;
        const id = typeof body.id === 'string' && body.id.length > 0 ? body.id : undefined;
        const staleOnly = body.staleOnly === true;

        let targets = [];
        if (id !== undefined) {
          if (!hasProject(keeper, id)) return missingProject(id);
          targets = [id];
        } else {
          targets = keeper.list()
            .filter(function (project) { return project.selected === true; })
            .filter(function (project) { return staleOnly ? project.stale === true : true; })
            .map(function (project) { return project.key; });
        }
        if (targets.length === 0) {
          return { payload: { ok: true, queued: 0, note: staleOnly ? '沒有落後的專案' : '沒有可重建的專案' } };
        }
        if (!force) {
          // 條件式重建（FR-3）：只有在圖譜確實落後時才排入，HEAD 未動就什麼都不做。
          const eligible = keeper.list()
            .filter(function (project) { return targets.includes(project.key); })
            .filter(function (project) { return project.stale === true; })
            .map(function (project) { return project.key; });
          if (eligible.length === 0) {
            return {
              payload: {
                ok: true,
                queued: 0,
                skipped: targets.length,
                note: '全部目標的圖譜 HEAD 都與工作樹一致；未產生任何索引工作。需要強制重建請帶 force=true。',
              },
            };
          }
          targets = eligible;
        }
        let queued = 0;
        for (const key of targets) {
          // C6：`force` 必須傳下去。少了它，冷卻閘門會擋掉人工／強制重建，
          // 與設定的描述（「人工與強制重建不受此限」）互相矛盾，而且沒有任何提示。
          if (keeper.enqueue(key, 'manual', mode, { force })) queued += 1;
        }
        log.info('route.rebuild.queued', { queued, requested: targets.length, mode: mode ?? 'configured', force });
        return { payload: { ok: true, queued, requested: targets.length, queue: keeper.status().queue } };
      }, log),
    },
    {
      kind: 'exact',
      path: API_PREFIX + '/cancel',
      handler: wrap('cancel', async function () {
        const cancelled = typeof keeper.cancelRunning === 'function' ? keeper.cancelRunning() : false;
        log.info('route.cancel', { cancelled });
        return { payload: { ok: true, cancelled, running: keeper.status().running } };
      }, log),
    },
    {
      kind: 'exact',
      path: API_PREFIX + '/watchers',
      handler: wrap('watchers', async function (body) {
        const action = body.action === 'pause' ? 'pause' : (body.action === 'resume' ? 'resume' : undefined);
        if (action === undefined) return { status: 400, payload: { error: 'action 必須是 pause 或 resume' } };
        const id = typeof body.id === 'string' && body.id.length > 0 ? body.id : undefined;
        const result = await keeper.watcherAction(id, action);
        if (!result.ok) return { status: 404, payload: { error: result.error } };
        return { payload: { ok: true, affected: result.affected, projects: keeper.list() } };
      }, log),
    },
    {
      kind: 'exact',
      path: API_PREFIX + '/config',
      handler: wrap('config', async function (body, query) {
        if (body === undefined || Object.keys(body).length === 0) {
          // config＝可寫的那一份（欄位名與 POST 一致，改完可以原樣送回來）；
          // runtime＝執行期形狀（毫秒、展開後的陣列），只供觀測。
          const hasWritable = typeof deps.configValues === 'function';
          const writable = hasWritable ? deps.configValues() : deps.config();
          const defaults = defaultConfigValues();
          return {
            payload: {
              config: writable,
              // WS12：`defaults` 與 `config` 同形狀、同鍵集、同型別（都走 readConfigValues）。
              defaults: defaults,
              // 沒有「可寫設定」的供應器時無從比較：回空陣列，而不是拿執行期形狀去猜。
              overridden: hasWritable ? overriddenFields(writable, defaults) : [],
              runtime: deps.config(),
              upstream: keeper.status().upstreamConfig,
            },
          };
        }
        // D2＋WS12：白名單。以前任何鍵都會被靜默寫進 Loader config——打錯字（`scanMs`
        // 之於 `scanMinutes`）或把 GET 的 runtime 形狀原樣 POST 回來，都會留下一堆
        // 沒有作用的設定，而使用者只會覺得「我明明設了」。現在只寫已知欄位，
        // 其餘具名回報；全部都是未知鍵時回 400，不假裝成功。
        // `reset` 是這一版的**指令鍵**（不是設定欄位），必須排除在 unknown 之外，
        // 否則每一次重置都會回報一個不存在的問題。
        const unknown = Object.keys(body)
          .filter(function (key) { return key !== 'reset' && !CONFIG_FIELDS.includes(key); })
          .sort();
        // WS12：reset（恢復預設）。`true`＝全部、字串陣列＝指定欄位；可與一般賦值
        // 同時出現，順序是**先 reset 再 set**（同一欄位同時出現時，賦值勝出）。
        const reset = Array.isArray(body.reset) ? body.reset : (body.reset === true ? CONFIG_FIELDS : []);
        if (body.reset !== undefined && body.reset !== null && body.reset !== false
          && body.reset !== true && !Array.isArray(body.reset)) {
          return { status: 400, payload: { error: 'reset 必須是 true（全部）或欄位名陣列', unknown } };
        }
        const resetFields = [];
        for (const name of reset) {
          const field = typeof name === 'string' ? name : String(name);
          if (!CONFIG_FIELDS.includes(field)) {
            // 未知的欄位名不靜默吞掉：併進既有的 unknown 回報。
            if (!unknown.includes(field)) unknown.push(field);
            continue;
          }
          if (!resetFields.includes(field)) resetFields.push(field);
        }
        unknown.sort();
        const patch = {};
        // 恢復預設＝把值設成 undefined；`index.js` 的 updateConfig 會映射成
        // `{op:'unset', path:[field]}`（與宿主 ConfigFormController.unset() 同一套
        // 語意，清掉覆寫、落回 schema 的 default()）。不新增第二種寫法。
        for (const field of resetFields) patch[field] = undefined;
        for (const field of CONFIG_FIELDS) {
          if (Object.prototype.hasOwnProperty.call(body, field)) patch[field] = body[field];
        }
        if (Object.keys(patch).length === 0) {
          return { status: 400, payload: { error: '沒有可辨識的設定欄位', unknown } };
        }
        if (typeof deps.updateConfig !== 'function') {
          return { status: 503, payload: { error: '此部署沒有掛載 settings 服務，設定為唯讀；請改 cordis.patch.yml。' } };
        }
        await deps.updateConfig(patch);
        // 回應形狀保持 {ok:true, config, …}，只**新增** unknown／reset：既有 curl 腳本不會斷。
        return {
          payload: {
            ok: true,
            config: deps.config(),
            unknown: unknown,
            reset: resetFields,
            note: query.get('note') ?? undefined,
          },
        };
      }, log),
    },
  ];
}
