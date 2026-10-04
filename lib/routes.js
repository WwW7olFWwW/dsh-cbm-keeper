/**
 * REST 控制面（FR-12）。
 *
 * 與 UI 完全同源：設定頁卡片呼叫的每一支路由，都可以用 curl 直接打，兩邊看到
 * 同一份資料與同一個結果（FR-12 的驗收條件）。路由只註冊在 DSH 的 webServer
 * 上，繼承它既有的 loopback-only 綁定，不另外開監聽埠。
 */

import { API_PREFIX } from './constants.js';

/** 請求內文大小上限：設定面沒有大 payload，超過就是誤用。 */
const MAX_BODY_BYTES = 256 * 1024;

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
          if (keeper.enqueue(key, 'manual', mode)) queued += 1;
        }
        log.info('route.rebuild.queued', { queued, requested: targets.length, mode: mode ?? 'configured', force });
        return { payload: { ok: true, queued, requested: targets.length, queue: keeper.status().queue } };
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
          return { payload: { config: deps.config(), upstream: keeper.status().upstreamConfig } };
        }
        if (typeof deps.updateConfig !== 'function') {
          return { status: 503, payload: { error: '此部署沒有掛載 settings 服務，設定為唯讀；請改 cordis.patch.yml。' } };
        }
        await deps.updateConfig(body);
        return { payload: { ok: true, config: deps.config(), note: query.get('note') ?? undefined } };
      }, log),
    },
  ];
}
