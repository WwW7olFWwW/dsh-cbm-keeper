/**
 * 假的 IncomingMessage／ServerResponse（FR-12 的路由測試用）。
 *
 * 目的是讓路由處理函式被直接呼叫，而不是真的開一個 HTTP 伺服器：請求端只需要
 * 是可被 `for await` 疊代的物件，回應端只需要有 `writeHead`／`end`。
 *
 * @param {object} [options] - 請求選項。
 * @param {string} [options.method] - HTTP 方法。
 * @param {string} [options.url] - 請求 URL（含查詢字串）。
 * @param {string} [options.body] - 原始內文字串。
 * @returns {{req: object, res: object, read: () => {status: number, headers: object, body: string, json: () => any}}}
 *   請求、回應與結果讀取器。
 */
export function makeExchange(options) {
  const settings = options ?? {};
  const chunks = settings.body === undefined || settings.body === '' ? [] : [Buffer.from(settings.body, 'utf8')];
  const req = {
    method: settings.method ?? 'GET',
    url: settings.url ?? '/',
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };

  let status;
  let headers;
  let body;
  const res = {
    writeHead: function (code, responseHeaders) {
      status = code;
      headers = responseHeaders;
    },
    end: function (payload) {
      body = payload;
    },
  };

  return {
    req,
    res,
    read: function () {
      return {
        status,
        headers,
        body,
        json: function () { return body === undefined ? undefined : JSON.parse(body); },
      };
    },
  };
}

/**
 * 建立一支最小可用的 keeper 替身，供 routes.js 測試驅動。
 *
 * @param {object} [overrides] - 覆寫的方法或狀態。
 * @returns {object} keeper 替身，附帶 `enqueued`／`checkCalls` 觀測陣列。
 */
export function makeStubKeeper(overrides) {
  const settings = overrides ?? {};
  const stub = {
    enqueued: [],
    checkCalls: [],
    watcherCalls: [],
    statusPayload: { revision: 1, queue: [] },
    listPayload: [],
    caveatsPayload: [{ code: 'x', message: 'y' }],
    checkResult: { ok: true },
    watcherResult: { ok: true, affected: 0 },
    status: function () { return stub.statusPayload; },
    list: function () { return stub.listPayload; },
    caveats: function () { return stub.caveatsPayload; },
    check: async function (key) { stub.checkCalls.push(key); return stub.checkResult; },
    enqueue: function (key, reason, mode) {
      stub.enqueued.push({ key, reason, mode });
      return true;
    },
    watcherAction: async function (key, action) {
      stub.watcherCalls.push({ key, action });
      return stub.watcherResult;
    },
  };
  return Object.assign(stub, settings);
}
