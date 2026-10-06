/**
 * 客戶端半邊的渲染驗證器。
 *
 * 為什麼需要它：`lib/client.js` 是一支手寫的動態 Client 模組，跑在瀏覽器裡；
 * 沒有瀏覽器控制時，「bundle 被供應了」不等於「卡片畫得出來」。這個腳本用一個
 * 迷你 hook 執行器（useState／useEffect／useCallback／useMemo／useRef）真的把註冊進
 * `settings.section` 的元件跑一遍，資料源有兩種：
 *
 *   1. **執行中伺服器的真實回應**（預設 http://127.0.0.1:3080）——只讀 GET，逐值比對；
 *   2. **夾具**——`enabled=false`／`orphaned`／CLI 未解析／空清單／連線失敗這些
 *      狀態在真機上不好重現，用夾具餵進去；也用在互動測試（點擊不會打到真伺服器）。
 *
 * 互動是這支驗證器的重點：`mount()` 回傳的把手可以**真的按下按鈕**（找 DOM 節點、
 * 檢查 disabled、呼叫 onClick），再用假時鐘推進時間驗證輪詢間隔、退避與
 * `document.hidden` 暫停。少了這一層，卡片上的「未實作狀態」永遠測不到。
 *
 * 用法：
 *   node tools/verify-client.mjs [base-url]
 * 預設 base-url 為 http://127.0.0.1:3080。
 */

import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');
const BASE = process.argv[2] ?? 'http://127.0.0.1:3080';

/** 驗證器自己的計時器：客戶端會被換上假時鐘，驗證器不能跟著被凍住。 */
const REAL_SET_TIMEOUT = globalThis.setTimeout;
const REAL_CLEAR_TIMEOUT = globalThis.clearTimeout;
const REAL_SET_INTERVAL = globalThis.setInterval;
const REAL_CLEAR_INTERVAL = globalThis.clearInterval;
const REAL_FETCH = globalThis.fetch;

/** 等待非同步工作落地的一輪（毫秒）。 */
const SETTLE_MS = 25;

/**
 * 驗證器自己的 sleep（一律走真時鐘）。
 * @param {number} ms - 毫秒。
 * @returns {Promise<void>} 完成。
 */
function sleep(ms) {
  return new Promise(function (resolve) { REAL_SET_TIMEOUT(resolve, ms); });
}

/**
 * 建立一個迷你但語意正確的 React 替代品。
 *
 * 實作這支插件用到的那一小塊：createElement、useState、useEffect、useCallback、
 * useMemo、useRef。渲染是深度優先的同步遍歷，hook 以「每個元件實例自己的游標」
 * 定位——與 React 的規則（順序固定、不得條件呼叫）一致。實例的身分用「樹上路徑
 * ＋元件名」決定，所以 Button 的 hover state 不會跟 Panel 的 snapshot 撞在一起。
 *
 * @returns {object} 執行器（React／mount／errors）。
 */
function createMiniReact() {
  const scopes = new Map();
  const errors = [];
  let version = 0;
  let currentScope;
  let pendingEffects = [];
  let nodes = [];
  let mountSeq = 0;

  /**
   * 淺比較依賴陣列，決定 hook 是否重跑（React 的 deps 語意）。
   * @param {unknown[]|undefined} previous - 上次的 deps。
   * @param {unknown[]|undefined} next - 這次的 deps。
   * @returns {boolean} 需要重跑則 true。
   */
  function depsChanged(previous, next) {
    if (previous === undefined || next === undefined) return true;
    if (previous.length !== next.length) return true;
    for (let index = 0; index < next.length; index += 1) {
      if (previous[index] !== next[index]) return true;
    }
    return false;
  }

  /**
   * 進入一個元件實例，回傳它的 hook scope。
   * @param {string} path - 實例路徑。
   * @returns {object} scope。
   */
  function beginScope(path) {
    let scope = scopes.get(path);
    if (scope === undefined) {
      scope = { hooks: [], cursor: 0, visited: false };
      scopes.set(path, scope);
    }
    scope.cursor = 0;
    scope.visited = true;
    return scope;
  }

  /**
   * 取下一個 hook 格。
   * @returns {object} hook 格。
   */
  function nextCell() {
    const scope = currentScope;
    const index = scope.cursor;
    scope.cursor += 1;
    if (scope.hooks[index] === undefined) scope.hooks[index] = {};
    return scope.hooks[index];
  }

  const React = {
    createElement: function (type, config) {
      const children = Array.prototype.slice.call(arguments, 2);
      const props = Object.assign({}, config ?? {});
      if (children.length === 1) props.children = children[0];
      else if (children.length > 1) props.children = children;
      return { type, props };
    },
    useState: function (initial) {
      const cell = nextCell();
      if (cell.hasState !== true) {
        cell.hasState = true;
        cell.state = typeof initial === 'function' ? initial() : initial;
      }
      return [cell.state, function (next) {
        const value = typeof next === 'function' ? next(cell.state) : next;
        // React 的 bail-out：值沒變就不重畫。卡片刻意用新物件帶錯誤，才不會凍住。
        if (value !== cell.state) {
          cell.state = value;
          version += 1;
        }
      }];
    },
    useEffect: function (effect, deps) {
      const cell = nextCell();
      if (cell.hasEffect === true && !depsChanged(cell.deps, deps)) return;
      // React 的順序：deps 變了先跑上一次的 cleanup，再跑新的 effect。
      if (cell.hasEffect === true && typeof cell.cleanup === 'function') {
        try {
          cell.cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      cell.hasEffect = true;
      cell.deps = deps === undefined ? undefined : deps.slice();
      cell.effect = effect;
      cell.cleanup = undefined;
      pendingEffects.push(cell);
    },
    useCallback: function (callback, deps) {
      const cell = nextCell();
      // deps 沒變就回上一次那個函式實例，依賴它的 useEffect 才不會每輪重跑。
      if (cell.hasValue === true && !depsChanged(cell.deps, deps)) return cell.value;
      cell.hasValue = true;
      cell.deps = deps === undefined ? undefined : deps.slice();
      cell.value = callback;
      return callback;
    },
    useMemo: function (factory, deps) {
      const cell = nextCell();
      if (cell.hasValue === true && !depsChanged(cell.deps, deps)) return cell.value;
      cell.hasValue = true;
      cell.deps = deps === undefined ? undefined : deps.slice();
      cell.value = factory();
      return cell.value;
    },
    useRef: function (initial) {
      const cell = nextCell();
      if (cell.hasRef !== true) {
        cell.hasRef = true;
        cell.ref = { current: initial };
      }
      return cell.ref;
    },
    useContext: function () {
      throw new Error('此插件不得使用 React context');
    },
    createContext: function () {
      throw new Error('此插件不得使用 React context');
    },
  };

  /**
   * 把一個元素樹渲染成 HTML 字串（同步、深度優先），並收集宿主節點。
   * @param {unknown} node - 元素、字串、數字或陣列。
   * @param {string} path - 這個位置的路徑（hook scope 的身分）。
   * @returns {string} HTML。
   */
  function renderElement(node, path) {
    if (node === null || node === undefined || node === false || node === true) return '';
    if (Array.isArray(node)) {
      const parts = [];
      for (let index = 0; index < node.length; index += 1) {
        parts.push(renderElement(node[index], path + '/' + String(index)));
      }
      return parts.join('');
    }
    if (typeof node === 'string' || typeof node === 'number') return escapeHtml(String(node));
    if (typeof node.type === 'function') {
      const name = node.type.name === '' ? 'anon' : node.type.name;
      const scopePath = path + '#' + name;
      const saved = currentScope;
      currentScope = beginScope(scopePath);
      let produced;
      try {
        produced = node.type(node.props ?? {});
      } finally {
        currentScope = saved;
      }
      return renderElement(produced, scopePath);
    }
    const props = node.props ?? {};
    nodes.push({ tag: node.type, props });
    const attributes = [];
    const style = props.style;
    const text = [];
    for (const key of Object.keys(props)) {
      if (key === 'children' || key === 'style' || key === 'key') continue;
      const value = props[key];
      if (value === undefined || value === null || value === false) continue;
      if (typeof value === 'function') continue;
      attributes.push(key + '="' + escapeHtml(String(value)) + '"');
    }
    if (style !== undefined && style !== null) attributes.push('style="' + escapeHtml(styleToCss(style)) + '"');
    const children = props.children;
    if (typeof children === 'string' || typeof children === 'number') text.push(escapeHtml(String(children)));
    else if (Array.isArray(children)) {
      for (let index = 0; index < children.length; index += 1) {
        text.push(renderElement(children[index], path + '/' + String(index)));
      }
    } else if (children !== undefined && children !== null) {
      text.push(renderElement(children, path + '/0'));
    }
    return '<' + node.type + (attributes.length > 0 ? ' ' + attributes.join(' ') : '') + '>' + text.join('') + '</' + node.type + '>';
  }

  /**
   * 跑一輪渲染：先畫，再跑這一輪掛上的 effect，最後把沒被走到的 scope（＝被卸載
   * 的元件）清掉。回傳 HTML。
   * @param {Function} Component - 根元件。
   * @param {object} props - 根 props。
   * @param {string} rootPath - 這個掛載點的路徑前綴。
   * @returns {string} HTML。
   */
  function renderPass(Component, props, rootPath) {
    nodes = [];
    pendingEffects = [];
    for (const scope of scopes.values()) scope.visited = false;
    const html = renderElement({ type: Component, props: props ?? {} }, rootPath);
    for (const cell of pendingEffects) {
      try {
        cell.cleanup = cell.effect();
      } catch (error) {
        errors.push(error);
      }
    }
    for (const [path, scope] of scopes) {
      if (scope.visited === true) continue;
      for (const cell of scope.hooks) {
        if (typeof cell.cleanup === 'function') {
          try {
            cell.cleanup();
          } catch (error) {
            errors.push(error);
          }
        }
      }
      scopes.delete(path);
    }
    return html;
  }

  /**
   * 找出第一個符合條件的宿主節點。
   * @param {Function} predicate - 條件。
   * @returns {object|undefined} 節點。
   */
  function findNode(predicate) {
    for (const node of nodes) {
      if (predicate(node) === true) return node;
    }
    return undefined;
  }

  /**
   * 掛載一個元件，回傳可以互動的把手。
   * @param {Function} Component - 元件。
   * @param {object} props - props。
   * @returns {object} 把手。
   */
  function mount(Component, props) {
    mountSeq += 1;
    const rootPath = 'm' + String(mountSeq);
    let html = '';
    return {
      get html() { return html; },
      get nodes() { return nodes; },
      /**
       * 反覆渲染直到狀態連續兩輪不變。
       * @param {number} [maxPasses] - 上限。
       * @returns {Promise<boolean>} 是否穩定。
       */
      settle: async function (maxPasses) {
        const limit = typeof maxPasses === 'number' ? maxPasses : 14;
        let stable = 0;
        for (let pass = 0; pass < limit; pass += 1) {
          const before = version;
          try {
            html = renderPass(Component, props, rootPath);
          } catch (error) {
            errors.push(error);
            return false;
          }
          await sleep(SETTLE_MS);
          if (version === before) {
            stable += 1;
            if (stable >= 2) return true;
          } else {
            stable = 0;
          }
        }
        return false;
      },
      /**
       * 反覆渲染直到條件成立或逾時。
       * @param {Function} predicate - 吃 html 的條件。
       * @param {number} [timeoutMs] - 逾時（毫秒）。
       * @returns {Promise<boolean>} 條件是否成立。
       */
      waitUntil: async function (predicate, timeoutMs) {
        const limit = typeof timeoutMs === 'number' ? timeoutMs : 5000;
        const deadline = Date.now() + limit;
        for (;;) {
          if (predicate(html) === true) return true;
          if (Date.now() > deadline) return false;
          await sleep(50);
          await this.settle();
        }
      },
      /**
       * 按下第一個符合條件的節點。
       * @param {Function} predicate - 條件。
       * @returns {{ok: boolean, reason?: string}} 結果。
       */
      click: function (predicate) {
        const node = findNode(predicate);
        if (node === undefined) return { ok: false, reason: '找不到節點' };
        if (node.props.disabled === true) return { ok: false, reason: '節點已停用' };
        if (typeof node.props.onClick !== 'function') return { ok: false, reason: '節點沒有 onClick' };
        node.props.onClick({ type: 'click' });
        return { ok: true };
      },
      /**
       * 依條件取節點文字。
       * @param {Function} predicate - 條件。
       * @returns {string|undefined} 文字。
       */
      text: function (predicate) {
        const node = findNode(predicate);
        return node === undefined ? undefined : nodeText(node);
      },
      /**
       * 依條件數節點。
       * @param {Function} predicate - 條件。
       * @returns {number} 數量。
       */
      count: function (predicate) {
        let total = 0;
        for (const node of nodes) {
          if (predicate(node) === true) total += 1;
        }
        return total;
      },
      /** 卸載：把這個掛載點掛上的 timer／listener 全部收掉。 */
      unmount: function () {
        for (const [path, scope] of scopes) {
          if (path.indexOf(rootPath) !== 0) continue;
          for (const cell of scope.hooks) {
            if (typeof cell.cleanup === 'function') {
              try {
                cell.cleanup();
              } catch (error) {
                errors.push(error);
              }
            }
          }
          scopes.delete(path);
        }
        html = '';
        nodes = [];
      },
    };
  }

  return { React, mount, errors };
}

/**
 * 物件 style 轉 CSS 文字。
 * @param {object} style - React style 物件。
 * @returns {string} CSS。
 */
function styleToCss(style) {
  const parts = [];
  for (const key of Object.keys(style)) {
    const value = style[key];
    if (value === undefined || value === null) continue;
    parts.push(key.replace(/[A-Z]/g, function (letter) { return '-' + letter.toLowerCase(); }) + ':' + String(value));
  }
  return parts.join(';');
}

/**
 * HTML 轉義（比對用的輸出不需要完全等價瀏覽器，但必須可讀且不產生假陽性）。
 * @param {string} text - 原文。
 * @returns {string} 轉義後文字。
 */
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 取出一個節點底下所有文字（含巢狀元素），用來按標籤找按鈕。
 * @param {object} node - 宿主節點。
 * @returns {string} 文字。
 */
function nodeText(node) {
  const parts = [];
  function walk(value) {
    if (value === undefined || value === null || value === false || value === true) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value === 'string' || typeof value === 'number') {
      parts.push(String(value));
      return;
    }
    if (typeof value === 'object' && value.props !== undefined) walk(value.props.children);
  }
  walk(node.props?.children);
  return parts.join('').trim();
}

/**
 * 逐項斷言，收集所有失敗而不是遇到第一個就停。
 */
class Checks {
  constructor() {
    this.passed = 0;
    this.failures = [];
  }

  /**
   * @param {string} label - 檢查項描述。
   * @param {boolean} ok - 是否通過。
   * @param {string} [detail] - 失敗時的補充。
   * @returns {void}
   */
  ok(label, ok, detail) {
    if (ok) {
      this.passed += 1;
      console.log('  PASS  ' + label);
      return;
    }
    this.failures.push(label + (detail === undefined ? '' : ' — ' + detail));
    console.log('  FAIL  ' + label + (detail === undefined ? '' : ' — ' + detail));
  }
}

/**
 * 建立假的 Cordis client context，記錄插件註冊了什麼。
 * @param {string} [lang] - 綁定哪一本字典（zh／en）。
 * @returns {object} 假 context 與其記錄。
 */
function createFakeCtx(lang) {
  const record = { registrations: [], dictionaries: [], injections: [], disposers: [] };
  const ctx = {
    effect: function (factory, label) {
      const disposer = factory();
      record.disposers.push({ label, disposer });
      return disposer;
    },
    locale: {
      register: function (ns, dicts) {
        record.dictionaries.push({ ns, dicts });
        return function () {};
      },
      bind: function (ns) {
        return function (key, params) {
          const table = record.dictionaries.find(function (entry) { return entry.ns === ns; });
          const dict = table?.dicts?.[lang ?? 'zh'] ?? {};
          const template = dict[key] ?? key;
          if (params === undefined) return template;
          // 與真 locale 同一套語意（packages/client/locale/src/client/index.ts:466-474）：
          // {name} 換成 params[name]，查不到的名字原樣留著（客戶端靠這一點判斷要不要 fallback）。
          return template.replace(/\{(\w+)\}/g, function (match, name) {
            return name in params ? String(params[name]) : match;
          });
        };
      },
    },
    slots: {
      inject: function (name, callback) {
        record.injections.push(name);
        return callback();
      },
      register: function (options, Component) {
        record.registrations.push({ options, Component });
        return function () {};
      },
    },
  };
  return { ctx, record };
}

/**
 * 假的 document：只實作這張卡片用到的部分（hidden 與 visibilitychange）。
 * @returns {object} 假 document。
 */
function createFakeDocument() {
  const listeners = new Map();
  return {
    hidden: false,
    addEventListener: function (type, handler) { listeners.set(type, handler); },
    removeEventListener: function (type, handler) {
      if (listeners.get(type) === handler) listeners.delete(type);
    },
    dispatch: function (type) {
      const handler = listeners.get(type);
      if (handler !== undefined) handler({ type });
    },
    listenerCount: function (type) { return listeners.has(type) ? 1 : 0; },
  };
}

/**
 * 假的 navigator：讓「複製」鈕的成功路徑可測。
 * @returns {object} 假 navigator。
 */
function createFakeNavigator() {
  const state = { written: [] };
  return {
    state,
    clipboard: {
      writeText: function (text) {
        state.written.push(text);
        return Promise.resolve();
      },
    },
  };
}

/**
 * 假時鐘：接管 setTimeout／clearTimeout，讓驗證器可以「快轉」輪詢。
 *
 * 驗證器自己（含迷你 React 的等待）一律走真時鐘，只有被測的客戶端程式碼會被接管。
 * @returns {object} 時鐘。
 */
function createClock() {
  const timers = new Map();
  const errors = [];
  let now = 0;
  let seq = 0;

  /**
   * 讓真的事件迴圈轉幾圈，使 promise 落地。
   * @returns {Promise<void>} 完成。
   */
  async function flush() {
    await sleep(4);
    await sleep(4);
  }

  return {
    errors,
    /** 目前（假）時間。 */
    now: function () { return now; },
    /** 待觸發的 timer 數量。 */
    pending: function () { return timers.size; },
    /** 接管全域計時器。 */
    install: function () {
      globalThis.setTimeout = function (handler, delay) {
        seq += 1;
        const id = seq;
        timers.set(id, { at: now + (typeof delay === 'number' && delay > 0 ? delay : 0), handler });
        return id;
      };
      globalThis.clearTimeout = function (id) { timers.delete(id); };
      // 卡片用的是 setTimeout 鏈（要退避），不是固定間隔的 setInterval。
      globalThis.setInterval = function () {
        throw new Error('客戶端不該使用 setInterval（輪詢要走可退避的 setTimeout 鏈）');
      };
      globalThis.clearInterval = function () {};
    },
    /** 還原真時鐘。 */
    restore: function () {
      globalThis.setTimeout = REAL_SET_TIMEOUT;
      globalThis.clearTimeout = REAL_CLEAR_TIMEOUT;
      globalThis.setInterval = REAL_SET_INTERVAL;
      globalThis.clearInterval = REAL_CLEAR_INTERVAL;
      timers.clear();
    },
    /**
     * 快轉 ms 毫秒，沿途依序觸發到期的 timer。
     * @param {number} ms - 毫秒。
     * @returns {Promise<void>} 完成。
     */
    advance: async function (ms) {
      const target = now + ms;
      for (;;) {
        let due;
        for (const [id, timer] of timers) {
          if (timer.at > target) continue;
          if (due === undefined || timer.at < due.timer.at) due = { id, timer };
        }
        if (due === undefined) break;
        timers.delete(due.id);
        now = due.timer.at;
        try {
          due.timer.handler();
        } catch (error) {
          errors.push(error);
        }
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

/**
 * 建立假／真的 fetch 路由器：記錄每一次呼叫，並依模式回夾具或真伺服器。
 * @returns {object} 路由器。
 */
function createFetchRouter() {
  const calls = [];
  let held;
  const router = {
    mode: 'live',
    fixture: undefined,
    hold: false,
    /**
     * 最後一次真正被餵給元件的 `/state` 內容。
     *
     * 為什麼要記：`/state` 的數字是活的（每輪掃描重算）。先在 A 時刻抓一份、
     * 稍後才讓元件渲染，兩者可能已經不同（實際踩過：dirty-chase 警告在兩次
     * 抓取之間消失，於是「字典英文」比對必然落空）。比對要用元件真的看到的那一份。
     */
    lastState: undefined,
    calls,
    /** `/config` 的夾具（含 defaults／overridden）。未設＝舊 host。 */
    configFixture: undefined,
    /** 清空呼叫記錄。 */
    reset: function () { calls.length = 0; },
    /** 放掉被 hold 住的那個 POST（換它 resolve）。 */
    release: function () {
      const resume = held;
      held = undefined;
      if (resume !== undefined) resume();
    },
    /**
     * 所有 POST 呼叫。
     * @returns {object[]} 呼叫清單。
     */
    postCount: function () {
      return calls.filter(function (call) { return call.method === 'POST'; }).length;
    },
    /**
     * 狀態查詢（GET）的呼叫。
     * @returns {object[]} 呼叫清單。
     */
    stateCalls: function () {
      return calls.filter(function (call) { return call.path === '/api/codebase-watcher/state'; });
    },
    /**
     * 某個路由的 POST 呼叫。
     * @param {string} suffix - 路由尾。
     * @returns {object[]} 呼叫清單。
     */
    postCalls: function (suffix) {
      return calls.filter(function (call) {
        return call.method === 'POST' && call.path.endsWith(suffix);
      });
    },
    /**
     * 夾具模式下每個路由要回什麼。
     * @param {string} path - 路徑。
     * @param {string} method - HTTP 方法。
     * @returns {object|undefined} 回應本體。
     */
    respond: function (path, method, body) {
      if (method === 'GET') {
        if (path.endsWith('/config')) {
          // 沒設夾具＝舊 host：沒有 defaults／overridden，用戶端據此整塊不渲染。
          return router.configFixture ?? { config: {}, runtime: {}, upstream: {} };
        }
        return router.fixture;
      }
      if (path.endsWith('/config')) {
        // 真的把重置套用到夾具上：重置後的 GET 會反映新狀態（按鈕才會消失）。
        const payload = router.configFixture ?? { config: {}, defaults: {}, overridden: [] };
        const overridden = Array.isArray(payload.overridden) ? payload.overridden : [];
        const requested = body !== undefined && body.reset === true
          ? overridden.slice()
          : (body !== undefined && Array.isArray(body.reset) ? body.reset : []);
        for (const field of requested) {
          if (payload.defaults !== undefined && Object.prototype.hasOwnProperty.call(payload.defaults, field)) {
            payload.config[field] = payload.defaults[field];
          }
          const at = overridden.indexOf(field);
          if (at !== -1) overridden.splice(at, 1);
        }
        return { ok: true, config: payload.config, overridden, unknown: [] };
      }
      if (path.endsWith('/check')) return { ok: true, status: {}, projects: router.fixture?.projects ?? [] };
      if (path.endsWith('/rebuild')) return { ok: true, queued: 2, requested: 3 };
      if (path.endsWith('/cancel')) return { ok: true, cancelled: true };
      if (path.endsWith('/watchers')) return { ok: true, affected: 1 };
      return { ok: true };
    },
  };

  globalThis.fetch = function (input, init) {
    const url = new URL(String(input), BASE);
    const method = typeof init?.method === 'string' ? init.method.toUpperCase() : 'GET';
    let body;
    try {
      body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    } catch {
      body = undefined;
    }
    calls.push({ url: url.href, path: url.pathname, search: url.search, method, body });
    if (router.mode === 'fail' || (router.mode === 'failPost' && method === 'POST')) {
      return Promise.reject(new Error('verifier: 模擬連線失敗'));
    }
    if (router.mode === 'fixture') {
      if (method === 'GET' && url.pathname.endsWith('/state')) router.lastState = router.fixture;
      if (router.hold === true && method === 'POST') {
        return new Promise(function (resolve) {
          held = function () {
            resolve({
              ok: true,
              status: 200,
              text: function () { return Promise.resolve(JSON.stringify(router.respond(url.pathname, method))); },
            });
          };
        });
      }
      const payload = router.respond(url.pathname, method, body);
      if (payload === undefined) return Promise.reject(new Error('verifier: 沒有 ' + url.pathname + ' 的夾具'));
      return Promise.resolve({
        ok: true,
        status: 200,
        text: function () { return Promise.resolve(JSON.stringify(payload)); },
      });
    }
    return REAL_FETCH(url, init).then(function (response) {
      if (method === 'GET' && url.pathname.endsWith('/state')) {
        // clone 之後再讀一份，原回應照常交給元件。
        return response.clone().json().then(function (body) {
          router.lastState = body;
          return response;
        }, function () { return response; });
      }
      return response;
    });
  };
  return router;
}

/**
 * 造一個專案（夾具用）。
 * @param {object} overrides - 要覆蓋的欄位。
 * @returns {object} 專案。
 */
function makeProject(overrides) {
  return Object.assign({
    key: '/tmp/demo/fresh',
    name: 'demo-fresh',
    rootPath: '/tmp/demo/fresh',
    branch: 'main',
    selected: true,
    orphaned: false,
    graphHead: 'a'.repeat(40),
    liveHead: 'a'.repeat(40),
    graphHeadShort: 'aaaaaaaa',
    liveHeadShort: 'aaaaaaaa',
    behindBy: 0,
    stale: false,
    confidence: 'head',
    reasons: ['head-match'],
    dirty: false,
    indexedAt: '2026-10-05T00:00:00Z',
    lastIndexedAt: '2026-10-05T00:00:05Z',
    lastDurationMs: 1234,
    nodes: 10,
    edges: 20,
    parsePartialCount: 0,
    notIndexedFilesCount: 0,
    rebuildState: 'idle',
    watcherPaused: false,
    watcher: { status: 'watching', backend: 'fs.watch', triggers: 3 },
    graphUrl: 'http://127.0.0.1:9749/?tab=graph&project=demo-fresh',
  }, overrides ?? {});
}

/**
 * 造一份 /state 夾具。
 * @param {object} overrides - 要覆蓋的欄位。
 * @returns {object} 夾具。
 */
function makeFixture(overrides) {
  return Object.assign({
    status: {
      revision: 7,
      enabled: true,
      cliPath: '/opt/bin/codebase-memory-mcp',
      cliSource: 'PATH',
      cliCandidates: [],
      cliVersion: '0.11.0',
      cliVersionSupported: true,
      upstreamConfig: { auto_watch: 'true', watcher_enabled: 'true' },
      graphUi: { state: 'ok', url: 'http://127.0.0.1:9749/?tab=graph', reachable: true },
      warnings: [],
      lastRefreshAt: '2026-10-05T00:00:00Z',
      watching: 2,
      queue: [],
      config: { autoRebuild: true, watchEnabled: true },
    },
    projects: [
      makeProject({}),
      makeProject({
        key: '/tmp/demo/stale', name: 'demo-stale', rootPath: '/tmp/demo/stale',
        stale: true, behindBy: 3, dirty: true, reasons: ['head-advanced'],
        graphHeadShort: 'bbbbbbbb', liveHeadShort: 'cccccccc',
        graphUrl: 'http://127.0.0.1:9749/?tab=graph&project=demo-stale',
      }),
      makeProject({
        key: '/tmp/demo/unknown', name: 'demo-unknown', rootPath: '/tmp/demo/unknown',
        stale: null, behindBy: null, confidence: 'none', reasons: ['no-evidence'],
        graphUrl: 'http://127.0.0.1:9749/?tab=graph&project=demo-unknown',
      }),
    ],
    caveats: [{ code: 'demo', message: 'demo caveat text' }],
    log: [
      { seq: 41, at: '2026-10-05T00:00:01Z', level: 'info', event: 'scan.done', detail: { projects: 3 } },
      { seq: 42, at: '2026-10-05T00:00:02Z', level: 'warn', event: 'scan.retry' },
    ],
  }, overrides ?? {});
}

/**
 * HTML 文字還原：渲染器只做最小轉義（& < > "），逐字比對字典文案時要還原回來，
 * 否則 `"src = api"` 這種帶引號的英文永遠比不中。
 * @param {string} text - HTML 片段。
 * @returns {string} 文字。
 */
function unescapeHtml(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * 列出畫面上所有測試鉤子（失敗時當診斷字串用）。
 * @param {object} harness - 掛載把手。
 * @returns {string} 逗號分隔的 action 清單。
 */
function actionList(harness) {
  return harness.nodes
    .filter(function (node) { return node.props['data-dsw-action'] !== undefined; })
    .map(function (node) { return String(node.props['data-dsw-action']); })
    .join(',');
}

/**
 * 取常駐指示的 CSS 文字（驗證 wide／rail 兩種版面）。
 * @param {object} harness - 掛載把手。
 * @returns {string} CSS。
 */
function indicatorCss(harness) {
  const node = harness.nodes.find(function (item) { return item.props['data-dsw-indicator'] !== undefined; });
  return node === undefined ? '' : styleToCss(node.props.style);
}

/**
 * 依畫面順序取出專案卡（用專案卡上「立即檢查」鈕的 owner 當代表）。
 * @param {object} harness - 掛載把手。
 * @returns {string[]} 專案 key 清單。
 */
function projectOrder(harness) {
  return harness.nodes
    .filter(function (node) { return node.props['data-dsw-action'] === 'project:check'; })
    .map(function (node) { return String(node.props['data-dsw-project']); });
}

/**
 * 在掛載點上找按鈕。
 * @param {string} action - `data-dsw-action` 值。
 * @param {string} [owner] - `data-dsw-project` 值（可選）。
 * @returns {Function} 條件函式。
 */
function byAction(action, owner) {
  return function (node) {
    if (node.tag !== 'button') return false;
    if (node.props['data-dsw-action'] !== action) return false;
    if (owner !== undefined && node.props['data-dsw-project'] !== owner) return false;
    return true;
  };
}

/**
 * 主流程。
 * @returns {Promise<void>} 完成即結束；有失敗時以非零碼退出。
 */
async function main() {
  console.log('dsh-codebase-watcher 客戶端渲染驗證');
  console.log('  base   ' + BASE);
  console.log('  plugin ' + PLUGIN_ROOT);

  let captured;
  globalThis.window = {
    __ModuleLoader__: {
      load: function (spec) {
        captured = spec;
      },
    },
  };
  const router = createFetchRouter();
  const doc = createFakeDocument();
  globalThis.document = doc;
  const fakeNavigator = createFakeNavigator();
  // Node 21+ 的 globalThis.navigator 是唯讀 getter，直接賦值會靜默失敗。
  Object.defineProperty(globalThis, 'navigator', {
    value: fakeNavigator, configurable: true, writable: true,
  });

  await import(pathToFileURL(join(PLUGIN_ROOT, 'lib', 'client.js')).href);

  const checks = new Checks();
  checks.ok('模組以 __ModuleLoader__.load 註冊', captured !== undefined);
  checks.ok('registration id 等於套件名', captured?.id === 'dsh-codebase-watcher', String(captured?.id));

  const mini = createMiniReact();
  const exported = captured.factory(function require(id) {
    if (id === 'react') return mini.React;
    throw new Error('未預期的 require：' + id);
  });

  checks.ok('factory 匯出 inject 清單', Array.isArray(exported.inject) && exported.inject.includes('slots'));
  checks.ok('factory 匯出 apply', typeof exported.apply === 'function');

  const { ctx, record } = createFakeCtx();
  exported.apply(ctx);

  checks.ok('註冊了 locale 字典', record.dictionaries.length === 1 && record.dictionaries[0].ns === 'codebase-watcher');
  checks.ok('注入 settings.section', record.injections.includes('settings.section'), record.injections.join(','));
  const registrationOf = function (bag, name) {
    return bag.registrations.find(function (entry) { return entry.options?.name === name; });
  };
  const registration = registrationOf(record, 'settings.section');
  checks.ok('settings.section 註冊存在', registration !== undefined);
  checks.ok('分區 id 為 codebase-watcher', registration?.options?.id === 'codebase-watcher', String(registration?.options?.id));
  checks.ok('分區 order 為數字', typeof registration?.options?.order === 'number', String(registration?.options?.order));
  checks.ok('分區 label 可解析為非空字串', typeof registration?.options?.label?.() === 'string' && registration.options.label().length > 0,
    String(registration?.options?.label?.()));

  const mountPanel = function () { return mini.mount(registration.Component, {}); };

  // ---------------------------------------------------------------- 靜態守門
  const rawSource = readFileSync(join(PLUGIN_ROOT, 'lib', 'client.js'), 'utf8');
  // 靜態守門只看程式碼：註解裡提到 window.confirm／=>／hex 都不算違規。
  const source = rawSource
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const dicts = record.dictionaries[0].dicts;
  const zhKeys = Object.keys(dicts.zh).sort();
  const enKeys = Object.keys(dicts.en).sort();
  const cjk = /[\u4e00-\u9fff]/;
  const leaked = enKeys.filter(function (key) { return cjk.test(dicts.en[key]); });

  checks.ok('client.js 沒有箭頭函式（專案規範）', source.indexOf('=>') === -1);
  checks.ok('client.js 沒有 innerHTML／dangerouslySetInnerHTML', source.indexOf('innerHTML') === -1);
  checks.ok('client.js 沒有 window.confirm（破壞性操作走行內確認）', source.indexOf('window.confirm') === -1);
  checks.ok('client.js 沒有字面色（hex）', !/#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?\b/.test(source));
  checks.ok('client.js 沒有 setInterval（輪詢要走可退避的鏈）', source.indexOf('setInterval') === -1);
  checks.ok('zh／en 字典鍵完全一致', zhKeys.join(',') === enKeys.join(','),
    zhKeys.filter(function (key) { return enKeys.indexOf(key) === -1; }).join(','));
  checks.ok('字典鍵數 ≥ 120', zhKeys.length >= 120, String(zhKeys.length));
  checks.ok('英文字典沒有中文殘留', leaked.length === 0, leaked.join(','));
  checks.ok('對比最低的 caption token 只用在「沒有值」一處',
    (source.match(/TOKEN\.textFaint/g) ?? []).length === 1,
    String((source.match(/TOKEN\.textFaint/g) ?? []).length) + ' 處');
  checks.ok('沒有「監看：監看中」這種同義重複', source.indexOf("'label.watcher') + '：'") === -1);

  // ------------------------------------------------ 真實伺服器（只讀 GET）
  router.mode = 'live';
  const live = mountPanel();
  const liveErrors = mini.errors.length;
  await live.settle();
  // 真伺服器會慢（正在跑重建時尤其）：等它把資料送進來，最多 8 秒。
  await live.waitUntil(function (html) { return !html.includes('載入中'); }, 8000);
  checks.ok('元件以真實資料渲染未拋錯', mini.errors.length === liveErrors,
    mini.errors.slice(liveErrors).map(function (error) { return error.message; }).join(' | '));
  checks.ok('渲染有輸出', live.html.length > 500, String(live.html.length) + ' bytes');
  checks.ok('真實資料只讀不寫（沒有送出任何 POST）', router.postCount() === 0, String(router.postCount()));

  let liveData;
  try {
    const response = await REAL_FETCH(new URL('/api/codebase-watcher/state?log=0', BASE));
    liveData = await response.json();
  } catch (error) {
    checks.ok('取得執行中伺服器的真實狀態', false, error instanceof Error ? error.message : String(error));
    liveData = undefined;
  }
  if (liveData !== undefined) {
    const stale = liveData.projects.filter(function (project) { return project.stale === true; });
    const unknown = liveData.projects.filter(function (project) {
      return project.orphaned !== true && project.stale !== true && project.stale !== false;
    });
    checks.ok('標題出現', live.html.includes('Codebase Memory'));
    checks.ok('沒有卡在載入中', !live.html.includes('載入中…'));
    checks.ok('CLI 路徑逐值呈現', live.html.includes(liveData.status.cliPath), liveData.status.cliPath);
    checks.ok('CLI 版本逐值呈現', live.html.includes(liveData.status.cliVersion), liveData.status.cliVersion);
    checks.ok('摘要列有專案總數（' + String(liveData.projects.length) + '）',
      live.html.includes(String(liveData.projects.length) + ' 專案'));
    checks.ok('摘要列的落後數與真值一致（' + String(stale.length) + '）',
      live.html.includes(String(stale.length) + ' 落後'));
    checks.ok('摘要列的無法判定數與真值一致（' + String(unknown.length) + '）',
      live.html.includes(String(unknown.length) + ' 無法判定'));
    checks.ok('摘要列有自動化狀態', live.html.includes('自動化'));
    for (const project of liveData.projects) {
      checks.ok('專案 ' + project.name + ' 出現在卡片上', live.html.includes(project.name));
      if (project.graphHead !== undefined) {
        checks.ok('專案 ' + project.name + ' 的圖譜 HEAD 逐值呈現', live.html.includes(project.graphHeadShort), project.graphHeadShort);
      }
      if (project.liveHead !== undefined) {
        checks.ok('專案 ' + project.name + ' 的工作樹 HEAD 逐值呈現', live.html.includes(project.liveHeadShort), project.liveHeadShort);
      }
    }
    checks.ok('篩選 chips 以角色群組呈現', live.html.includes('role="group"'));
    const warning = (liveData.status.warnings ?? [])[0];
    if (warning !== undefined) {
      checks.ok('警告可見：' + warning.code, live.html.includes('警告') && live.html.includes(warning.message));
    }
  }
  checks.ok('使用主題 token 而非字面色', live.html.includes('--dsw-alias-'), 'missing token');
  live.unmount();

  // ------------------------------------------------ 英文介面不得漏中文
  const english = createFakeCtx('en');
  exported.apply(english.ctx);
  const enRegistration = registrationOf(english.record, 'settings.section');
  router.mode = 'fixture';
  router.fixture = makeFixture({ status: Object.assign(makeFixture().status, { warnings: [{ code: 'demo', message: 'demo warning' }] }) });
  const enHarness = mini.mount(enRegistration.Component, {});
  await enHarness.settle();
  checks.ok('英文介面渲染成功', enHarness.html.includes('Codebase Memory graph freshness'));
  const enBody = enHarness.html.replace(/<[^>]*>/g, ' ');
  checks.ok('英文介面沒有中文外洩', !cjk.test(enBody),
    (enBody.match(new RegExp(cjk.source, 'g')) ?? []).slice(0, 8).join(''));
  checks.ok('英文介面的相對時間走字典（不是中文）', /\d+ (s|min|h|d) ago/.test(enHarness.html));
  enHarness.unmount();

  // 英文介面的「每個分支都走一遍」：把 CLI 失敗、警告、錯誤、確認問句全開出來，
  // 逐字掃有沒有漏掉的中文（P1-11 的回歸守門）。
  const kitchenBase = makeFixture();
  router.fixture = {
    status: Object.assign({}, kitchenBase.status, {
      enabled: false,
      cliPath: undefined,
      cliError: 'demo cli error',
      cliCandidates: ['/demo/bin/codebase-memory-mcp'],
      logFileError: 'demo log file error',
      stateLoadError: 'demo state file error',
      upstreamConfigError: 'demo upstream error',
      lastRefreshError: 'demo refresh error',
      graphUi: { state: 'invalid', url: 'http://127.0.0.1:9749/demo', reachable: false },
      running: { key: '/tmp/demo/gone', reason: 'manual', startedAt: new Date(Date.now() - 65000).toISOString() },
      cliVersion: '0.11.0',
      upstreamConfigError: 'demo upstream error',
      statsSince: '2026-10-05T00:00:00Z',
      stats: {
        sinceStartRebuildsQueued: 4, sinceStartRebuildsSucceeded: 3, sinceStartRebuildsFailed: 0,
        sinceStartRebuildsAborted: 1, sinceStartSkippedCooldown: 2, sinceStartSkippedGate: 5,
        sinceStartSettled: 1, sinceStartSettleDeferred: 1, sinceStartChecksShortCircuited: 7,
        sinceStartRebuildMs: 61000,
      },
      warnings: [
        { code: 'cli-missing', message: 'HOST-zh cli missing' },
        { code: 'version-unexpected', message: 'HOST-zh version' },
        { code: 'auto-index-on', message: 'HOST-zh auto index' },
        { code: 'upstream-watcher-on', message: 'HOST-zh upstream watcher' },
        { code: 'upstream-config-unreadable', message: 'HOST-zh upstream config' },
        { code: 'dirty-chase-detected', message: 'HOST-zh dirty chase', data: { aborted: 3, completed: 4, percent: 75 } },
      ],
    }),
    projects: [
      makeProject({
        key: '/tmp/demo/gone', name: 'demo-gone', rootPath: '/tmp/demo/gone',
        orphaned: true, stale: null, behindBy: null, confidence: 'time',
        reasons: ['time-fallback-head-newer', 'live-head-unavailable', 'unknown-code'],
        dirty: true, rebuildState: 'queued', watcherPaused: true,
        watcher: { status: 'failed', backend: 'none', triggers: 0, lastError: 'demo watcher error' },
        lastError: 'demo project error', lastCheckedError: 'demo check error',
      }),
    ],
    caveats: [
      { code: 'route-file-path-empty', message: 'HOST-zh route' },
      { code: 'layers-unreliable', message: 'HOST-zh layers' },
      { code: 'parse-partial', message: 'HOST-zh partial' },
      { code: 'gitignored-not-indexed', message: 'HOST-zh gitignored' },
    ],
    log: [{ seq: 1, at: '2026-10-05T00:00:00Z', level: 'error', event: 'demo.event' }],
  };
  const kitchen = mini.mount(enRegistration.Component, {});
  await kitchen.settle();
  kitchen.click(byAction('panel:log'));
  await kitchen.settle();
  kitchen.click(byAction('panel:rebuildAll'));
  await kitchen.settle();
  const kitchenBody = kitchen.html.replace(/<[^>]*>/g, ' ');
  checks.ok('英文介面（含錯誤／警告／確認問句）沒有中文外洩', !cjk.test(kitchenBody),
    (kitchenBody.match(new RegExp(cjk.source, 'g')) ?? []).slice(0, 8).join(''));
  checks.ok('確認問句確實出現在英文介面上', kitchen.html.includes('Force-rebuild every project?'));
  checks.ok('孤兒提示走字典', kitchen.html.includes('no longer in the CBM graph'));
  kitchen.unmount();

  // ------------------------------------------------ 夾具：停用／孤兒／CLI／空清單
  // 停用
  router.fixture = makeFixture({
    status: Object.assign(makeFixture().status, { enabled: false, config: { autoRebuild: false } }),
  });
  const disabled = mountPanel();
  await disabled.settle();
  checks.ok('enabled=false：摘要列標示已停用', disabled.html.includes('自動化 已停用'));
  checks.ok('enabled=false：說明不會自動掃描或重建', disabled.html.includes('自動掃描或重建'));
  disabled.unmount();

  // 自動重建關閉（但外掛還開著）
  router.fixture = makeFixture({
    status: Object.assign(makeFixture().status, { enabled: true, config: { autoRebuild: false } }),
  });
  const autoOff = mountPanel();
  await autoOff.settle();
  checks.ok('autoRebuild=false：摘要列標示自動重建關閉', autoOff.html.includes('自動重建關閉'));
  checks.ok('autoRebuild=false：不是誤報成全停用', !autoOff.html.includes('自動化 已停用'));
  autoOff.unmount();

  // 孤兒
  router.fixture = makeFixture({
    projects: [
      makeProject({
        key: '/tmp/demo/gone', name: 'demo-gone', rootPath: '/tmp/demo/gone',
        orphaned: true, stale: null, behindBy: null,
      }),
      makeProject({}),
      makeProject({ key: '/tmp/demo/stale', name: 'demo-stale', stale: true, behindBy: 3 }),
    ],
  });
  const orphaned = mountPanel();
  await orphaned.settle();
  checks.ok('orphaned：出現「已不在圖譜」徽章', orphaned.html.includes('已不在圖譜'));
  checks.ok('orphaned：附上救援說明', orphaned.html.includes('重新索引，或把它移出納管清單'));
  checks.ok('orphaned：摘要列計數', orphaned.html.includes('1 已不在圖譜'));
  const order = projectOrder(orphaned);
  checks.ok('排序：落後 → 已同步 → 孤兒（孤兒永遠最後）',
    order.join(',') === ['/tmp/demo/stale', '/tmp/demo/fresh', '/tmp/demo/gone'].join(','),
    order.join(' , '));
  orphaned.unmount();

  // CLI 未解析
  router.fixture = makeFixture({
    status: Object.assign(makeFixture().status, {
      cliPath: undefined,
      cliError: 'verifier: 找不到 CLI 執行檔',
      cliCandidates: ['/opt/bin/codebase-memory-mcp', '/home/demo/.local/bin/codebase-memory-mcp'],
    }),
  });
  const noCli = mountPanel();
  await noCli.settle();
  checks.ok('CLI 未解析：欄位顯示（未解析）', noCli.html.includes('（未解析）'));
  checks.ok('CLI 未解析：顯示失敗原因', noCli.html.includes('verifier: 找不到 CLI 執行檔'));
  checks.ok('CLI 未解析：列出已嘗試的路徑', noCli.html.includes('/home/demo/.local/bin/codebase-memory-mcp'));
  checks.ok('CLI 未解析：給出可複製的診斷指令', noCli.html.includes('command -v codebase-memory-mcp'));
  noCli.unmount();

  // 空清單
  router.fixture = makeFixture({ projects: [] });
  const empty = mountPanel();
  await empty.settle();
  checks.ok('空清單：顯示引導文字', empty.html.includes('目前沒有任何已索引的專案'));
  checks.ok('空清單：不畫篩選 chips', !empty.html.includes('role="group"'));
  checks.ok('空清單：摘要列不留「0 落後／0 無法判定」這種噪音', !empty.html.includes('0 落後') && !empty.html.includes('0 無法判定'));
  checks.ok('空清單：摘要列仍有總數與自動化狀態', empty.html.includes('0 專案') && empty.html.includes('自動化'));
  router.fixture = makeFixture({ projects: [], log: [] });
  const emptyLog = empty.click(byAction('panel:log'));
  checks.ok('點得到空清單的「顯示日誌」', emptyLog.ok === true, emptyLog.reason);
  await empty.settle();
  checks.ok('日誌為空時給專屬文案（不是沿用回饋文案）', empty.html.includes('目前沒有事件'));
  empty.unmount();

  // running：摘要列要說「誰在跑、跑多久」，缺 startedAt 也不能壞
  router.fixture = makeFixture({
    status: Object.assign(makeFixture().status, {
      running: { key: '/tmp/demo/stale', reason: 'watch', startedAt: new Date(Date.now() - 72000).toISOString() },
    }),
  });
  const running = mountPanel();
  await running.settle();
  checks.ok('running：摘要列點名正在重建的專案', running.html.includes('重建中: demo-stale'),
    running.html.slice(0, 200));
  checks.ok('running：顯示已跑時間（1 分 12 秒）', /1 分 1[0-9] 秒/.test(running.html));
  checks.ok('running：取消重建可以按', running.nodes.some(function (node) {
    return node.props['data-dsw-action'] === 'panel:cancel' && node.props.disabled !== true;
  }));
  running.unmount();

  router.fixture = makeFixture({
    status: Object.assign(makeFixture().status, {
      running: { key: '/tmp/demo/not-in-list', reason: 'manual' },
    }),
  });
  const runningLegacy = mountPanel();
  await runningLegacy.settle();
  checks.ok('running 缺 startedAt（舊世代）：照樣顯示、不顯示計時',
    runningLegacy.html.includes('重建中: /tmp/demo/not-in-list') && !runningLegacy.html.includes('已跑'));
  runningLegacy.unmount();

  router.fixture = makeFixture({});
  const idle = mountPanel();
  await idle.settle();
  checks.ok('沒在重建時取消鈕停用', idle.nodes.some(function (node) {
    return node.props['data-dsw-action'] === 'panel:cancel' && node.props.disabled === true;
  }));
  idle.unmount();

  // ------------------------------------------------ 互動：點擊
  router.mode = 'fixture';
  router.hold = false;
  router.fixture = makeFixture({});
  router.reset();
  const interactive = mountPanel();
  await interactive.settle();

  const initialGets = router.stateCalls();
  checks.ok('首次載入只抓一次狀態', initialGets.length >= 1 && initialGets.length <= 2, String(initialGets.length));
  checks.ok('日誌面板收起時輪詢帶 log=0', initialGets[0].search === '?log=0', initialGets[0].url);
  checks.ok('日誌面板收起時不渲染日誌內容', !interactive.html.includes('scan.done'));

  // 顯示日誌 → log=120（reload 的識別隨 showLog 改變，會立刻補一次）
  const beforeLog = router.stateCalls().length;
  const clickLog = interactive.click(byAction('panel:log'));
  checks.ok('點得到「顯示日誌」', clickLog.ok === true, clickLog.reason);
  await interactive.settle();
  const logGets = router.stateCalls();
  checks.ok('展開日誌後立刻以 log=120 重抓', logGets.length > beforeLog && logGets[logGets.length - 1].search === '?log=120',
    logGets.length > beforeLog ? logGets[logGets.length - 1].url : '沒有新請求');
  checks.ok('展開日誌後渲染出日誌事件', interactive.html.includes('scan.done'));
  checks.ok('沒有 detail 的日誌事件不會炸掉（型別守衛）', interactive.html.includes('scan.retry'));
  checks.ok('日誌鈕切換成「收起日誌」', interactive.text(byAction('panel:log')) === '收起日誌');

  // 收起日誌 → log=0
  const clickHide = interactive.click(byAction('panel:log'));
  checks.ok('點得到「收起日誌」', clickHide.ok === true, clickHide.reason);
  await interactive.settle();
  const hiddenGets = router.stateCalls();
  checks.ok('收起日誌後回到 log=0', hiddenGets[hiddenGets.length - 1].search === '?log=0',
    hiddenGets[hiddenGets.length - 1].url);
  checks.ok('收起日誌後不再渲染日誌內容', !interactive.html.includes('scan.done'));

  // 單專案檢查 → POST + role=status 回饋
  const clickCheck = interactive.click(byAction('project:check', '/tmp/demo/fresh'));
  checks.ok('點得到專案卡的「立即檢查」', clickCheck.ok === true, clickCheck.reason);
  await interactive.settle();
  const checkPosts = router.postCalls('/check');
  checks.ok('按下檢查會送出 POST /check', checkPosts.length === 1, String(checkPosts.length));
  checks.ok('POST /check 帶正確的 id', checkPosts[0]?.body?.id === '/tmp/demo/fresh', JSON.stringify(checkPosts[0]?.body));
  checks.ok('回饋區有 role="status"', interactive.html.includes('role="status"'));
  checks.ok('標題是語意標籤而不是 div', interactive.html.includes('<h3'));
  checks.ok('不可作為證據的宣告預設展開', interactive.html.includes('open="true"'));
  checks.ok('回饋訊息由回應自行組成（無 note 也能說話）', interactive.html.includes('已重新檢查這個專案'));

  // 強制重建：兩段式確認
  const postsBefore = router.postCalls('/rebuild').length;
  const clickForce = interactive.click(byAction('project:rebuild', '/tmp/demo/fresh'));
  checks.ok('點得到「強制重建」', clickForce.ok === true, clickForce.reason);
  await interactive.settle();
  checks.ok('第一次點擊只上膛、不送 POST', router.postCalls('/rebuild').length === postsBefore);
  checks.ok('上膛後顯示確認問句', interactive.html.includes('圖譜與工作樹一致，仍要強制重建？'));
  const clickConfirm = interactive.click(byAction('project:rebuild:confirm', '/tmp/demo/fresh'));
  checks.ok('點得到「確定」', clickConfirm.ok === true, clickConfirm.reason + ' @ ' + actionList(interactive));
  await interactive.settle();
  const forcePosts = router.postCalls('/rebuild');
  checks.ok('確認後才送出 POST /rebuild', forcePosts.length === 1, String(forcePosts.length));
  checks.ok('強制重建帶 force=true', forcePosts[0]?.body?.force === true, JSON.stringify(forcePosts[0]?.body));
  checks.ok('重建回饋用回應裡的數字組訊息', interactive.html.includes('已排入 2 個重建'),
    interactive.text(function (node) { return node.props?.role === 'status'; }));

  // 破壞性面板動作同樣要確認，且取消不會送 POST
  const clickAll = interactive.click(byAction('panel:rebuildAll'));
  checks.ok('點得到「全部強制重建」', clickAll.ok === true, clickAll.reason);
  await interactive.settle();
  checks.ok('全部強制重建：先問一次', interactive.html.includes('確定要對所有專案強制重建？'));
  const dismiss = interactive.click(byAction('panel:rebuildAll:dismiss'));
  checks.ok('點得到「取消」', dismiss.ok === true, dismiss.reason);
  await interactive.settle();
  checks.ok('取消後不送 POST', router.postCalls('/rebuild').length === 1, String(router.postCalls('/rebuild').length));

  // 篩選 chips
  const clickChip = interactive.click(byAction('chip:stale'));
  checks.ok('點得到「落後」篩選', clickChip.ok === true, clickChip.reason);
  await interactive.settle();
  checks.ok('篩選後只剩落後專案', projectOrder(interactive).join(',') === '/tmp/demo/stale',
    projectOrder(interactive).join(' , '));
  checks.ok('篩選鈕帶 aria-pressed', interactive.html.includes('aria-pressed="true"'));
  const clickAllChip = interactive.click(byAction('chip:all'));
  checks.ok('點得到「全部」篩選', clickAllChip.ok === true, clickAllChip.reason);
  await interactive.settle();
  checks.ok('取消篩選後全部回來', projectOrder(interactive).length === 3, projectOrder(interactive).join(' , '));

  // 複製鈕
  const clickCopy = interactive.click(function (node) {
    return node.tag === 'button' && nodeText(node) === '複製';
  });
  checks.ok('點得到「複製」', clickCopy.ok === true, clickCopy.reason);
  await interactive.settle();
  checks.ok('複製成功後鈕面變成「已複製」', fakeNavigator.state.written.length === 1
    && fakeNavigator.state.written[0].includes('--version'), fakeNavigator.state.written.join(' | '));

  // 忙碌期間只鎖相關按鈕
  router.hold = true;
  const clickPanelCheck = interactive.click(byAction('panel:check'));
  checks.ok('點得到面板的「立即檢查」', clickPanelCheck.ok === true, clickPanelCheck.reason);
  await interactive.settle();
  const busyButton = interactive.nodes.find(function (node) {
    return node.props['data-dsw-action'] === 'panel:check';
  });
  const projectButton = interactive.nodes.find(function (node) {
    return node.props['data-dsw-action'] === 'project:check';
  });
  checks.ok('忙碌中的按鈕自己標 aria-busy', busyButton?.props?.['aria-busy'] === true);
  checks.ok('忙碌中的按鈕顯示「執行中…」', String(busyButton?.props?.children).includes('執行中…'));
  checks.ok('忙碌時專案卡按鈕不受影響（不再一起變灰）', projectButton?.props?.disabled !== true);
  checks.ok('忙碌時面板其他動作確實鎖住', interactive.nodes.some(function (node) {
    return node.props['data-dsw-action'] === 'panel:rebuildStale' && node.props.disabled === true;
  }));
  checks.ok('忙碌時外框標 aria-busy', interactive.nodes.some(function (node) {
    return node.tag === 'div' && node.props['aria-busy'] === true;
  }));
  checks.ok('點不動已停用的按鈕', interactive.click(byAction('panel:rebuildStale')).reason === '節點已停用');
  checks.ok('停用中的按鈕沒有 aria-busy（沒在跑就不要裝忙）',
    interactive.nodes.filter(function (node) {
      return node.props['data-dsw-action'] === 'panel:rebuildStale';
    })[0]?.props?.['aria-busy'] === undefined);
  router.hold = false;
  router.release();
  await interactive.settle();
  router.reset();
  checks.ok('放掉忙碌中的請求後按鈕解鎖', interactive.nodes.filter(function (node) {
    return node.props['data-dsw-action'] === 'panel:check';
  })[0]?.props?.['aria-busy'] === undefined);
  // 只有 POST 失敗時，訊息要說「動作失敗」而不是誤報「已離線」
  router.mode = 'failPost';
  const clickFail = interactive.click(byAction('panel:resumeAll'));
  checks.ok('點得到「恢復全部監看」', clickFail.ok === true, clickFail.reason);
  await interactive.settle();
  checks.ok('動作失敗：標示為「動作失敗」', interactive.html.includes('動作失敗'));
  checks.ok('動作失敗：不會誤報成離線', !interactive.html.includes('已離線'));
  checks.ok('動作失敗：仍走 role="alert"', interactive.html.includes('role="alert"'));
  router.mode = 'fixture';
  router.reset();
  interactive.unmount();

  // ------------------------------------------------ 連線失敗、退避、背景暫停
  const clock = createClock();
  clock.install();
  router.mode = 'fixture';
  router.fixture = makeFixture({});
  router.reset();
  const offline = mountPanel();
  await offline.settle();
  checks.ok('（假時鐘）先在線上一次', router.stateCalls().length === 1, String(router.stateCalls().length));

  // t=0 線上成功（1 次）；轉為失敗後：t=3s 失敗 → 退避 6s → t=9s 失敗 → 退避 12s → t=21s。
  router.mode = 'fail';
  await clock.advance(3000);
  await offline.settle();
  checks.ok('連線失敗：出現離線標示', offline.html.includes('已離線'));
  checks.ok('連線失敗：標出資料時間', offline.html.includes('資料時間'));
  checks.ok('連線失敗：過期標示用 role="alert"', offline.html.includes('role="alert"'));
  checks.ok('連線失敗：保留最後一份快照而不是清空', offline.html.includes('demo-fresh'));
  checks.ok('第 3 秒的那次重試確實失敗（2 次請求）', router.stateCalls().length === 2, String(router.stateCalls().length));

  await clock.advance(3000);
  checks.ok('失敗後退避成 6 秒：第 6 秒不打', router.stateCalls().length === 2, String(router.stateCalls().length));
  await clock.advance(3000);
  await offline.settle();
  checks.ok('第 9 秒才再試（+6 秒）', router.stateCalls().length === 3, String(router.stateCalls().length));
  await clock.advance(6000);
  checks.ok('第二次失敗退避成 12 秒：第 15 秒不打', router.stateCalls().length === 3, String(router.stateCalls().length));
  await clock.advance(6000);
  await offline.settle();
  checks.ok('第 21 秒才再試（+12 秒）：3→6→12 指數退避成立', router.stateCalls().length === 4, String(router.stateCalls().length));

  checks.ok('頁面在前景時有掛 visibilitychange', doc.listenerCount('visibilitychange') === 1);
  doc.hidden = true;
  doc.dispatch('visibilitychange');
  const beforeHidden = router.stateCalls().length;
  await clock.advance(120000);
  checks.ok('頁面轉背景後完全停止輪詢', router.stateCalls().length === beforeHidden,
    String(router.stateCalls().length - beforeHidden) + ' 次');
  doc.hidden = false;
  doc.dispatch('visibilitychange');
  await offline.settle();
  checks.ok('回到前景立刻補一次', router.stateCalls().length === beforeHidden + 1, String(router.stateCalls().length));
  offline.unmount();
  clock.restore();
  checks.ok('假時鐘期間客戶端沒有拋錯', clock.errors.length === 0,
    clock.errors.map(function (error) { return error.message; }).join(' | '));

  // ------------------------------------------------ 真資料 + 英文字典（不切換使用者的介面語言）
  // 這一條才是「英文卡片上還有沒有中文」的真答案：拿執行中伺服器的 /state，
  // 用 en 字典渲染同一張卡片，再逐條拿「字典應該產生的英文」去比對。
  if (liveData !== undefined) {
    const enDict = english.record.dictionaries[0].dicts.en;
    const fill = function (template, params) {
      return template.replace(/\{(\w+)\}/g, function (match, name) {
        return name in params && params[name] !== undefined ? String(params[name]) : match;
      });
    };
    // 已知 code → 字典應該產生的英文；值缺席（客戶端會 fallback）或未知 code 回 undefined。
    const expectedEn = function (entry, kind) {
      const template = enDict[kind + '.' + String(entry.code)];
      if (template === undefined) return undefined;
      const params = {};
      if (entry.code === 'version-unexpected') params.version = rendered.status.cliVersion;
      if (entry.code === 'upstream-config-unreadable') params.error = rendered.status.upstreamConfigError;
      // host 直接放在 data 的值（dirty-chase-detected 的三個數字）也要帶進來，
      // 否則這一條會被當成「值缺席」而跳過，等於沒測到。
      const data = entry.data !== null && typeof entry.data === 'object' ? entry.data : {};
      for (const name of Object.keys(data)) {
        if (data[name] !== undefined && data[name] !== null) params[name] = data[name];
      }
      const text = fill(template, params);
      return /\{\w+\}/.test(text) ? undefined : text;
    };

    router.mode = 'live';
    const liveEn = mini.mount(enRegistration.Component, {});
    await liveEn.settle();
    await liveEn.waitUntil(function (html) { return !html.includes('Loading'); }, 8000);
    // 用元件真的渲染的那一份（最後一次輪詢），不是幾秒前抓的舊快照。
    const rendered = router.lastState ?? liveData;
    const liveWarnings = Array.isArray(rendered.status?.warnings) ? rendered.status.warnings : [];
    const liveCaveats = Array.isArray(rendered.caveats) ? rendered.caveats : [];

    const liveEnText = unescapeHtml(liveEn.html.replace(/<[^>]*>/g, ' '));
    const misses = [];
    let matched = 0;
    for (const warning of liveWarnings) {
      const want = expectedEn(warning, 'warning');
      if (want === undefined) continue;
      matched += 1;
      if (!liveEnText.includes(want)) misses.push(warning.code);
    }
    for (const caveat of liveCaveats) {
      const want = expectedEn(caveat, 'caveat');
      if (want === undefined) continue;
      matched += 1;
      if (!liveEnText.includes(want)) misses.push(caveat.code);
    }
    checks.ok('真資料＋英文字典：每條已知 code 都渲染出字典英文（' + String(matched) + ' 條）',
      matched > 0 && misses.length === 0, misses.join(','));

    const sliceBetween = function (from, to) {
      const at = liveEn.html.indexOf(from);
      if (at === -1) return '';
      const stop = liveEn.html.indexOf(to, at);
      return unescapeHtml(liveEn.html.slice(at, stop === -1 ? at + 6000 : stop).replace(/<[^>]*>/g, ' '));
    };
    const warnBlock = sliceBetween('Warnings', 'Read with care');
    const caveatBlock = sliceBetween('Read with care', 'role="group"');
    checks.ok('真資料＋英文字典：警告區塊沒有中文', !cjk.test(warnBlock), warnBlock.slice(0, 120));
    checks.ok('真資料＋英文字典：判讀注意區塊沒有中文', !cjk.test(caveatBlock), caveatBlock.slice(0, 120));
    liveEn.unmount();
    router.mode = 'fixture';
  }

  // ------------------------------------------------ 警告與判讀注意的雙語（code → 字典 + fallback）
  const knownWarnings = [
    { code: 'cli-missing', message: 'HOST-zh：找不到 CLI（原文）' },
    { code: 'version-unexpected', message: 'HOST-zh：版本 1.2.3 不在清單（原文）' },
    { code: 'auto-index-on', message: 'HOST-zh：auto_index 開著（原文）' },
    { code: 'upstream-watcher-on', message: 'HOST-zh：上游 watcher 開著（原文）' },
    { code: 'upstream-config-unreadable', message: 'HOST-zh：讀不到設定（原文）' },
  ];
  const knownCaveats = [
    { code: 'route-file-path-empty', message: 'HOST-zh：route 路徑空（原文）' },
    { code: 'layers-unreliable', message: 'HOST-zh：layers 不可靠（原文）' },
    { code: 'parse-partial', message: 'HOST-zh：解析缺口（原文）' },
    { code: 'gitignored-not-indexed', message: 'HOST-zh：gitignore 不入圖（原文）' },
  ];
  // host 端今天只給 message，值是狀態裡的同一份事實；夾具照實況給中文 message，
  // 這樣英文渲染一旦 fallback 就會漏 CJK，測試立刻抓到。
  const localizedFixture = function (warnings, caveats, statusExtra) {
    const base = makeFixture();
    return makeFixture({
      status: Object.assign({}, base.status, {
        cliVersion: '0.11.0',
        upstreamConfigError: 'demo upstream error',
        warnings,
      }, statusExtra ?? {}),
      caveats,
    });
  };

  router.mode = 'fixture';
  router.fixture = localizedFixture(knownWarnings, knownCaveats);
  const enAll = mini.mount(enRegistration.Component, {});
  await enAll.settle();
  const enAllBody = enAll.html.replace(/<[^>]*>/g, ' ');
  checks.ok('英文：已知警告與判讀注意全翻成英文（零 CJK）', !cjk.test(enAllBody),
    (enAllBody.match(new RegExp(cjk.source, 'g')) ?? []).slice(0, 8).join(''));
  checks.ok('英文：host 的中文原文沒有漏出來', !enAllBody.includes('HOST-zh'));
  checks.ok('英文：cli-missing 走字典', enAll.html.includes('codebase-memory-mcp executable was not found'));
  checks.ok('英文：version-unexpected 帶出版本號', enAll.html.includes('version 0.11.0 is outside the tested support list'));
  checks.ok('英文：upstream-config-unreadable 帶出錯誤訊息', enAll.html.includes('could not be read (demo upstream error)'));
  checks.ok('英文：auto-index-on 走字典並保留指令', enAll.html.includes('config set auto_index false'));
  checks.ok('英文：upstream-watcher-on 走字典', enAll.html.includes('The built-in CBM watcher'));
  checks.ok('英文：四條判讀注意全部走字典',
    enAll.html.includes('Route nodes in the graph all have an empty file_path')
    && enAll.html.includes('layers declaration')
    && enAll.html.includes('parse_partial have parsing gaps')
    && enAll.html.includes('gitignore never enter the graph'));
  enAll.unmount();

  const zhAll = mini.mount(registration.Component, {});
  await zhAll.settle();
  checks.ok('中文：警告逐字沿用 host 措辭（三份不漂移）',
    zhAll.html.includes('找不到 codebase-memory-mcp 執行檔。已依序嘗試設定值')
    && zhAll.html.includes('版本 0.11.0 不在實測支援清單內')
    && zhAll.html.includes('讀不到 CBM 設定（demo upstream error）'));
  checks.ok('中文：判讀注意逐字沿用 host 措辭',
    zhAll.html.includes('圖譜的 Route 節點 file_path 全為空')
    && zhAll.html.includes('gitignore 內的路徑不會進圖譜'));
  zhAll.unmount();

  router.fixture = localizedFixture(
    [
      { code: 'brand-new-warning', message: 'HOST-zh：未來才有的新警告' },
      { code: 'version-unexpected', message: 'HOST-zh：版本 4.5.6 不在清單（原文）' },
      { code: 'version-unexpected', message: 'HOST-zh：data 帶值的版本', data: { version: '9.9.9' } },
    ],
    [{ code: 'brand-new-caveat', message: 'HOST-zh：未來才有的新判讀注意' }],
    { cliVersion: undefined },
  );
  const enFallback = mini.mount(enRegistration.Component, {});
  await enFallback.settle();
  checks.ok('未知 warning code：原樣顯示 host 原文', enFallback.html.includes('HOST-zh：未來才有的新警告'));
  checks.ok('未知 warning code：不生出生鍵', !enFallback.html.includes('warning.brand-new-warning'));
  checks.ok('未知 caveat code：原樣顯示 host 原文', enFallback.html.includes('HOST-zh：未來才有的新判讀注意'));
  checks.ok('未知 caveat code：不生出生鍵', !enFallback.html.includes('caveat.brand-new-caveat'));
  checks.ok('已知 code 但值缺席：退回 host 原文而不是留下 {version}',
    enFallback.html.includes('HOST-zh：版本 4.5.6 不在清單（原文）') && !enFallback.html.includes('{version}'));
  checks.ok('host 在 data 帶值時以 data 為準', enFallback.html.includes('9.9.9'));
  enFallback.unmount();

  // ------------------------------------------------ dirty-chase-detected（帶結構化 data 的新警告）
  const dirtyChase = {
    code: 'dirty-chase-detected',
    message: 'HOST-zh：偵測到圖譜重建正在跟你的編輯賽跑（原文）',
    data: { aborted: 3, completed: 4, percent: 75 },
  };
  router.mode = 'fixture';
  router.fixture = localizedFixture([dirtyChase], []);
  const enChase = mini.mount(enRegistration.Component, {});
  await enChase.settle();
  const enChaseBody = enChase.html.replace(/<[^>]*>/g, ' ');
  checks.ok('dirty-chase：英文介面零 CJK', !cjk.test(enChaseBody),
    (enChaseBody.match(new RegExp(cjk.source, 'g')) ?? []).slice(0, 8).join(''));
  checks.ok('dirty-chase：英文文案把 data 的三個數字帶進去',
    enChase.html.includes('3 rebuilds were aborted mid-flight in the last 24 hours')
    && enChase.html.includes('75% of 4 completed attempts'));
  checks.ok('dirty-chase：英文文案講到 dirtySettleSeconds 設 90 可解、設 0 維持現行',
    enChase.html.includes('dirtySettleSeconds to 90') && enChase.html.includes('Leaving it at 0'));
  checks.ok('dirty-chase：英文文案把決定權留給使用者', enChase.html.includes('is your call'));
  checks.ok('dirty-chase：畫面沒有裸露的佔位符', !/\{(aborted|completed|percent)\}/.test(enChase.html));
  enChase.unmount();

  const zhChase = mini.mount(registration.Component, {});
  await zhChase.settle();
  checks.ok('dirty-chase：中文逐字沿用 host 措辭（含三個數字）',
    zhChase.html.includes('偵測到圖譜重建正在跟你的編輯賽跑')
    && zhChase.html.includes('有 3 次重建在途中被中止（佔 4 次已完成嘗試的 75%）')
    && zhChase.html.includes('要不要改、改成幾秒，由你決定。'));
  checks.ok('dirty-chase：中文文案講到 dirtySettleSeconds 設 90／設 0',
    zhChase.html.includes('dirtySettleSeconds 設成 90') && zhChase.html.includes('設 0 則維持現行行為'));
  zhChase.unmount();

  // core 還沒落地（或舊 host）＝沒有 data：三段規則的最後一段，退回 host 原文
  router.fixture = localizedFixture([
    { code: 'dirty-chase-detected', message: 'HOST-zh：dirty chase 沒有 data（原文）' },
  ], []);
  const chaseNoData = mini.mount(enRegistration.Component, {});
  await chaseNoData.settle();
  checks.ok('dirty-chase：data 缺席時 fallback 回 host 原文',
    chaseNoData.html.includes('HOST-zh：dirty chase 沒有 data（原文）'));
  checks.ok('dirty-chase：data 缺席時不留裸露佔位符',
    !/\{(aborted|completed|percent)\}/.test(chaseNoData.html));
  checks.ok('dirty-chase：data 缺席時不生出生鍵', !chaseNoData.html.includes('warning.dirty-chase-detected'));
  chaseNoData.unmount();

  // ------------------------------------------------ 成效（status().stats，本次啟動以來）
  const statsFixture = function (stats, statsSince) {
    const base = makeFixture();
    return makeFixture({
      status: Object.assign({}, base.status, { stats, statsSince }),
    });
  };
  // sinceStart* 與 last24h* 刻意給不同值：UI 只能顯示前者，混用會立刻被斷言抓到。
  const fullStats = {
    sinceStartRebuildsQueued: 12,
    sinceStartRebuildsSucceeded: 9,
    sinceStartRebuildsFailed: 1,
    sinceStartRebuildsAborted: 2,
    sinceStartSkippedCooldown: 27,
    sinceStartSkippedGate: 41,
    sinceStartSettled: 8,
    sinceStartSettleDeferred: 5,
    sinceStartChecksShortCircuited: 36,
    sinceStartRebuildMs: 82000,
    last24hRebuildsQueued: 3,
    last24hRebuildsSucceeded: 2,
    last24hRebuildsFailed: 1,
    last24hRebuildsAborted: 0,
    last24hSkippedCooldown: 4,
    last24hSkippedGate: 6,
    last24hSettled: 2,
    last24hSettleDeferred: 1,
    last24hChecksShortCircuited: 9,
    last24hRebuildMs: 21000,
  };
  const zeroStats = {
    sinceStartRebuildsQueued: 0, sinceStartRebuildsSucceeded: 0, sinceStartRebuildsFailed: 0,
    sinceStartRebuildsAborted: 0, sinceStartSkippedCooldown: 0, sinceStartSkippedGate: 0,
    sinceStartSettled: 0, sinceStartSettleDeferred: 0, sinceStartChecksShortCircuited: 0,
    sinceStartRebuildMs: 0,
  };
  const pad2 = function (value) { return value < 10 ? '0' + String(value) : String(value); };
  const sinceIso = new Date(Date.now() - 3600000).toISOString();
  const sinceClock = pad2(new Date(sinceIso).getHours()) + ':' + pad2(new Date(sinceIso).getMinutes());

  router.mode = 'fixture';
  router.fixture = statsFixture(fullStats, sinceIso);
  const withStats = mini.mount(registration.Component, {});
  await withStats.settle();
  checks.ok('成效：起算時間用「本次啟動以來」措辭', withStats.html.includes('本次啟動以來'));
  // 真機上踩到：這三行比欄位寬，省略號會把數字吃掉（只看得到「失敗 7（其中 7 次…」）。
  checks.ok('成效：長數字行換行顯示而不是省略',
    withStats.nodes.some(function (node) {
      return nodeText(node).indexOf('排入 12') === 0 && node.props?.style?.wordBreak === 'break-all';
    }));
  checks.ok('成效：顯示 statsSince 的當地時鐘（' + sinceClock + '）',
    withStats.html.includes('自 ' + sinceClock), sinceClock);
  checks.ok('成效：重建三數逐值呈現（失敗＝失敗＋被中止）', withStats.html.includes('排入 12 · 成功 9 · 失敗 3'));
  checks.ok('成效：看得出其中幾次是被中止', withStats.html.includes('（其中 2 次被中止）'));
  checks.ok('成效：省下的重建逐值呈現', withStats.html.includes('冷卻跳過 27 · 閘門跳過 41 · settle 延後 5'));
  checks.ok('成效：省下的完整檢查逐值呈現', withStats.html.includes('36 次'));
  checks.ok('成效：累計耗時格式化成人看得懂（1 分 22 秒）', withStats.html.includes('1 分 22 秒'));
  checks.ok('成效：只顯示 sinceStart*，不混入 last24h*',
    withStats.html.includes('排入 12') && !withStats.html.includes('排入 3'));
  checks.ok('成效：措辭不得出現「總計」或「歷史」', !/總計|歷史/.test(withStats.html));
  withStats.unmount();

  router.fixture = statsFixture(fullStats, undefined);
  const noSince = mini.mount(registration.Component, {});
  await noSince.settle();
  checks.ok('成效：statsSince 缺席時不顯示起算時間',
    noSince.html.includes('成效（本次啟動以來）') && !noSince.html.includes('自 ' + sinceClock));
  checks.ok('成效：statsSince 缺席時其餘數字照常', noSince.html.includes('排入 12 · 成功 9 · 失敗 3'));
  noSince.unmount();

  router.fixture = statsFixture(
    Object.assign({}, fullStats, { sinceStartRebuildMs: 13620000 }),
    sinceIso,
  );
  const bigSpan = mini.mount(registration.Component, {});
  await bigSpan.settle();
  checks.ok('成效：大數字仍可讀（3 小時 47 分）', bigSpan.html.includes('3 小時 47 分'));
  bigSpan.unmount();

  router.fixture = statsFixture(zeroStats, sinceIso);
  const zeroBlock = mini.mount(registration.Component, {});
  await zeroBlock.settle();
  checks.ok('成效：全部為 0 時整個區塊不渲染（安靜是預設）', !zeroBlock.html.includes('成效'));
  zeroBlock.unmount();

  router.fixture = makeFixture();
  const noStats = mini.mount(registration.Component, {});
  await noStats.settle();
  checks.ok('成效：stats 缺席（舊 host）時整個區塊不渲染', !noStats.html.includes('成效'));
  checks.ok('成效：stats 缺席時不留下任何 0 的痕跡', !noStats.html.includes('省下的重建'));
  noStats.unmount();

  // 英文側：區塊要以英文出現（kitchen-sink 那組的零 CJK 守門也涵蓋這些鍵）
  router.fixture = statsFixture(fullStats, sinceIso);
  const enStats = mini.mount(enRegistration.Component, {});
  await enStats.settle();
  checks.ok('成效：英文介面用英文標題', enStats.html.includes('Impact (since this start, from ' + sinceClock + ')'));
  checks.ok('成效：英文介面逐值呈現',
    enStats.html.includes('queued 12 · succeeded 9 · failed 3')
    && enStats.html.includes('(2 aborted mid-rebuild)')
    && enStats.html.includes('cooldown 27 · gate 41 · settle deferred 5'));
  enStats.unmount();
  router.mode = 'fixture';

  // ------------------------------------------------ 設定區塊（預設值 ＋ 恢復預設）
  const configFields = [
    'enabled', 'cliPath', 'mode', 'rebuildTimeoutSeconds', 'scanMinutes', 'watchEnabled',
    'debounceMs', 'rebuildCooldownSeconds', 'dirtySettleSeconds', 'autoRebuild', 'includeDirty',
    'nice', 'maxLogEntries', 'extensions', 'excludes', 'includeProjects', 'excludeProjects', 'graphUrl',
  ];
  const configFixture = function (overridden) {
    const defaults = {
      enabled: true, cliPath: '', mode: 'full', rebuildTimeoutSeconds: 1800, scanMinutes: 5,
      watchEnabled: true, debounceMs: 3000, rebuildCooldownSeconds: 45, dirtySettleSeconds: 90,
      autoRebuild: true, includeDirty: true, nice: 10, maxLogEntries: 2000,
      extensions: ['ts', 'tsx', 'js'], excludes: ['node_modules', '.git'],
      includeProjects: [], excludeProjects: [], graphUrl: '',
    };
    const config = JSON.parse(JSON.stringify(defaults));
    for (const field of overridden) {
      config[field] = field === 'rebuildCooldownSeconds' ? 60
        : field === 'dirtySettleSeconds' ? 0
          : field === 'enabled' ? false : config[field];
    }
    return { config, defaults, runtime: {}, upstream: {}, overridden: overridden.slice() };
  };
  const configRowCount = function (harness) {
    return harness.count(function (node) { return node.props['data-dsw-config-field'] !== undefined; });
  };

  router.mode = 'fixture';
  router.fixture = makeFixture({});

  // 舊 host：整個區塊不渲染
  router.configFixture = undefined;
  const legacyHost = mini.mount(registration.Component, {});
  await legacyHost.settle();
  checks.ok('設定：舊 host（沒有 defaults／overridden）整塊不渲染',
    !legacyHost.html.includes('data-dsw-config') && !legacyHost.html.includes('顯示設定'));
  checks.ok('設定：舊 host 不留「恢復預設」的痕跡', !legacyHost.html.includes('全部恢復預設'));
  legacyHost.unmount();

  // 沒有任何覆寫：全部標（預設）、全部恢復鈕 disabled
  router.configFixture = configFixture([]);
  const noOverride = mini.mount(registration.Component, {});
  await noOverride.settle();
  checks.ok('設定：無覆寫時區塊在、但預設收起', noOverride.html.includes('data-dsw-config')
    && noOverride.html.includes('顯示設定') && configRowCount(noOverride) === 0);
  noOverride.click(byAction('panel:config'));
  await noOverride.settle();
  checks.ok('設定：展開後列出所有可寫欄位（' + String(configFields.length) + ' 個）',
    configRowCount(noOverride) === configFields.length, String(configRowCount(noOverride)));
  checks.ok('設定：無覆寫時全部標「（預設）」', (noOverride.html.match(/（預設）/g) ?? []).length === configFields.length,
    String((noOverride.html.match(/（預設）/g) ?? []).length));
  checks.ok('設定：無覆寫時沒有任何單欄恢復鈕',
    noOverride.count(function (node) {
      return String(node.props['data-dsw-action'] ?? '').indexOf('config:reset:') === 0;
    }) === 0);
  checks.ok('設定：無覆寫時「全部恢復預設」disabled', noOverride.nodes.filter(function (node) {
    return node.props['data-dsw-action'] === 'config:resetAll';
  })[0]?.props?.disabled === true);
  checks.ok('設定：型別顯示可讀（布林／數字／空字串／陣列）',
    noOverride.html.includes('>true<') && noOverride.html.includes('>1800<')
    && noOverride.html.includes('（空）') && noOverride.html.includes('ts, tsx, js'));
  checks.ok('設定：空陣列顯示「（空清單）」', noOverride.html.includes('（空清單）'));
  checks.ok('設定：文案說清楚只恢復預設值、編輯在別處',
    noOverride.html.includes('只會把你改過的欄位改回預設值') && noOverride.html.includes('DSH 的插件設定表單'));
  noOverride.unmount();

  // 兩個覆寫：只給覆寫的欄位按鈕；單欄重置後按鈕消失
  router.configFixture = configFixture(['rebuildCooldownSeconds', 'dirtySettleSeconds']);
  router.reset();
  const withOverride = mini.mount(registration.Component, {});
  await withOverride.settle();
  checks.ok('設定：有覆寫時頂端標出數量', withOverride.html.includes('你改過 2 個欄位'));
  withOverride.click(byAction('panel:config'));
  await withOverride.settle();
  checks.ok('設定：只有被覆寫的欄位才有恢復鈕',
    withOverride.count(byAction('config:reset:rebuildCooldownSeconds')) === 1
    && withOverride.count(byAction('config:reset:dirtySettleSeconds')) === 1
    && withOverride.count(byAction('config:reset:enabled')) === 0);
  checks.ok('設定：覆寫欄位看得出來（目前值旁標出預設值）',
    withOverride.html.includes('預設值 45') && withOverride.html.includes('預設值 90'));
  checks.ok('設定：有覆寫時「全部恢復預設」可按', withOverride.nodes.filter(function (node) {
    return node.props['data-dsw-action'] === 'config:resetAll';
  })[0]?.props?.disabled !== true);

  const clickOne = withOverride.click(byAction('config:reset:rebuildCooldownSeconds'));
  checks.ok('設定：點得到單欄「恢復預設」', clickOne.ok === true, clickOne.reason);
  await withOverride.settle();
  const onePost = router.postCalls('/config');
  checks.ok('設定：單欄重置送出 {reset:[欄位]}', onePost.length === 1
    && JSON.stringify(onePost[0]?.body) === JSON.stringify({ reset: ['rebuildCooldownSeconds'] }),
    JSON.stringify(onePost[0]?.body));
  checks.ok('設定：單欄重置後該欄位的按鈕消失',
    withOverride.count(byAction('config:reset:rebuildCooldownSeconds')) === 0
    && withOverride.count(byAction('config:reset:dirtySettleSeconds')) === 1);
  checks.ok('設定：單欄重置的回饋從回應推導',
    withOverride.html.includes('已恢復 rebuildCooldownSeconds 的預設值'),
    withOverride.text(function (node) { return node.props?.role === 'status'; }));
  checks.ok('設定：重置走既有的 role="status" 回饋區',
    withOverride.html.includes('role="status"'));

  // 全部重置：兩段式確認 → {reset:true} → 按鈕全消失
  const clickResetAll = withOverride.click(byAction('config:resetAll'));
  checks.ok('設定：點得到「全部恢復預設」', clickResetAll.ok === true, clickResetAll.reason);
  await withOverride.settle();
  checks.ok('設定：全部重置先問一次（不是 window.confirm）',
    withOverride.html.includes('確定要把所有改過的欄位恢復成預設值？'));
  checks.ok('設定：上膛時還沒送 POST', router.postCalls('/config').length === 1,
    String(router.postCalls('/config').length));
  const confirmAll = withOverride.click(byAction('config:resetAll:confirm'));
  checks.ok('設定：點得到確認', confirmAll.ok === true, confirmAll.reason);
  await withOverride.settle();
  const allPost = router.postCalls('/config');
  checks.ok('設定：全部重置送出 {reset:true}',
    allPost.length === 2 && JSON.stringify(allPost[1]?.body) === JSON.stringify({ reset: true }),
    JSON.stringify(allPost[1]?.body));
  checks.ok('設定：全部重置後所有恢復鈕消失',
    withOverride.count(function (node) {
      return String(node.props['data-dsw-action'] ?? '').indexOf('config:reset:') === 0;
    }) === 0);
  checks.ok('設定：全部重置的數量從回應推導（剩 1 個覆寫）',
    withOverride.html.includes('已恢復 1 個欄位的預設值'));
  checks.ok('設定：全部重置後「全部恢復預設」回到 disabled', withOverride.nodes.filter(function (node) {
    return node.props['data-dsw-action'] === 'config:resetAll';
  })[0]?.props?.disabled === true);
  withOverride.unmount();

  // 英文
  router.configFixture = configFixture(['dirtySettleSeconds']);
  const enConfig = mini.mount(enRegistration.Component, {});
  await enConfig.settle();
  enConfig.click(byAction('panel:config'));
  await enConfig.settle();
  const enConfigBody = enConfig.html.replace(/<[^>]*>/g, ' ');
  checks.ok('設定：英文介面零 CJK', !cjk.test(enConfigBody),
    (enConfigBody.match(new RegExp(cjk.source, 'g')) ?? []).slice(0, 8).join(''));
  checks.ok('設定：英文文案齊備', enConfig.html.includes('1 fields changed')
    && enConfig.html.includes('Reset all to defaults') && enConfig.html.includes('(default)')
    && enConfig.html.includes('(empty)') && enConfig.html.includes('(empty list)'));
  enConfig.unmount();
  router.mode = 'fixture';

  // ------------------------------------------------ 常駐狀態指示（sidebar.footer.action）
  const badgeRegistration = registrationOf(record, 'sidebar.footer.action');
  checks.ok('註冊了 sidebar.footer.action 常駐指示', badgeRegistration !== undefined);
  checks.ok('常駐指示用獨立 id（list 型不佔別人的格）',
    badgeRegistration?.options?.id === 'codebase-watcher-status', String(badgeRegistration?.options?.id));
  checks.ok('常駐指示帶 order', typeof badgeRegistration?.options?.order === 'number');

  // 展開的側邊欄傳 wide=true，收合成 56px 軌道時傳 false（owner prop 語意）。
  const mountBadge = function (ownerProps) {
    return mini.mount(badgeRegistration.Component, ownerProps ?? { wide: true });
  };
  const badgeClock = createClock();
  badgeClock.install();

  // 全部新鮮 → 什麼都不畫（安靜是預設）
  doc.hidden = false;
  router.mode = 'fixture';
  router.fixture = makeFixture({ projects: [makeProject({})] });
  router.reset();
  const badgeQuiet = mountBadge();
  await badgeQuiet.settle();
  checks.ok('全部新鮮時不渲染任何指示', badgeQuiet.html === '', badgeQuiet.html.slice(0, 120));
  checks.ok('常駐指示第一次就帶 log=0', router.stateCalls()[0]?.search === '?log=0', router.stateCalls()[0]?.url);
  checks.ok('常駐指示只讀不寫（沒有 POST）', router.postCount() === 0, String(router.postCount()));
  badgeQuiet.unmount();

  // 有落後 → warn
  router.fixture = makeFixture({
    projects: [
      makeProject({}),
      makeProject({ key: '/tmp/demo/stale', name: 'demo-stale', stale: true, behindBy: 2 }),
      makeProject({ key: '/tmp/demo/unknown', name: 'demo-unknown', stale: null, confidence: 'none' }),
    ],
  });
  const badgeWarn = mountBadge();
  await badgeWarn.settle();
  checks.ok('有落後 → warn 圓點', badgeWarn.html.includes('data-dsw-indicator="warn"'), badgeWarn.html.slice(0, 160));
  checks.ok('warn 圓點走 state token（不硬編色）', badgeWarn.html.includes('--dsw-alias-state-warn-label'));
  checks.ok('warn 只數落後，不把「無法判定」算進去', badgeWarn.html.includes('CBM 圖譜: 1 個專案落後'));
  checks.ok('指示帶 aria-label 與 title',
    badgeWarn.html.includes('aria-label="CBM 圖譜: 1 個專案落後"') && badgeWarn.html.includes('title="CBM 圖譜: 1 個專案落後"'));
  checks.ok('指示有 role="status" 當 live region', badgeWarn.html.includes('role="status"'));
  checks.ok('warn 顯示待處理專案數', badgeWarn.text(function (node) {
    return node.props['data-dsw-indicator'] !== undefined;
  }) === '1');
  checks.ok('展開時是藥丸（不搶軌道的版面）', indicatorCss(badgeWarn).includes('height:26px')
    && indicatorCss(badgeWarn).includes('flex:0 0 auto'), indicatorCss(badgeWarn));
  badgeWarn.unmount();

  // 收合成 56px 軌道：只留圓點，資訊仍在 title／aria-label
  const badgeRail = mountBadge({ wide: false });
  await badgeRail.settle();
  checks.ok('軌道模式仍渲染 warn 圓點', badgeRail.html.includes('data-dsw-indicator="warn"'));
  checks.ok('軌道模式是 36px 高的圓點欄位（不動別人的 36×36 控制盒）',
    indicatorCss(badgeRail).includes('height:36px') && indicatorCss(badgeRail).includes('width:20px'),
    indicatorCss(badgeRail));
  checks.ok('軌道模式不塞數字（title 仍帶完整句子）',
    badgeRail.text(function (node) { return node.props['data-dsw-indicator'] !== undefined; }) === ''
    && badgeRail.html.includes('aria-label="CBM 圖譜: 1 個專案落後"'));
  badgeRail.unmount();

  // 有失敗（孤兒／監看 failed／上次掃描失敗）→ error，且 error 壓過 warn
  router.fixture = makeFixture({
    status: Object.assign(makeFixture().status, { lastRefreshError: 'demo scan failure' }),
    projects: [
      makeProject({ key: '/tmp/demo/stale', name: 'demo-stale', stale: true, behindBy: 2 }),
      makeProject({ key: '/tmp/demo/gone', name: 'demo-gone', orphaned: true, stale: null }),
      makeProject({ key: '/tmp/demo/broken', name: 'demo-broken', watcher: { status: 'failed', backend: 'none' } }),
    ],
  });
  const badgeError = mountBadge();
  await badgeError.settle();
  checks.ok('有失敗 → error 圓點（壓過 warn）', badgeError.html.includes('data-dsw-indicator="error"'), badgeError.html.slice(0, 160));
  checks.ok('error 圓點走 state token', badgeError.html.includes('--dsw-alias-state-error-primary'));
  checks.ok('error 標示同時說出落後、失敗與掃描失敗',
    badgeError.html.includes('1 個專案落後') && badgeError.html.includes('2 個專案失敗')
    && badgeError.html.includes('上次掃描失敗'));
  badgeError.unmount();

  // 輪詢：30 秒起跳、背景暫停、卸載即停
  router.mode = 'fixture';
  router.fixture = makeFixture({ projects: [makeProject({ key: '/tmp/demo/stale', name: 'demo-stale', stale: true })] });
  router.reset();
  const badgePoll = mountBadge();
  await badgePoll.settle();
  checks.ok('常駐指示掛載時只載入一次', router.stateCalls().length === 1, String(router.stateCalls().length));
  checks.ok('掛載時就掛上 visibilitychange', doc.listenerCount('visibilitychange') === 1);
  await badgeClock.advance(29000);
  checks.ok('29 秒內不打第二次（間隔 >= 30 秒）', router.stateCalls().length === 1, String(router.stateCalls().length));
  await badgeClock.advance(1000);
  await badgePoll.settle();
  checks.ok('第 30 秒打第二次', router.stateCalls().length === 2, String(router.stateCalls().length));

  router.mode = 'fail';
  await badgeClock.advance(30000);
  checks.ok('失敗一次後退避成 60 秒：第 60 秒照打（3 次）', router.stateCalls().length === 3, String(router.stateCalls().length));
  await badgeClock.advance(30000);
  checks.ok('退避期間不打（第 90 秒）', router.stateCalls().length === 3, String(router.stateCalls().length));
  await badgeClock.advance(30000);
  checks.ok('第 120 秒才再試（30→60 退避）', router.stateCalls().length === 4, String(router.stateCalls().length));
  checks.ok('連線失敗時不自己生出錯誤指示（維持上一次判斷）',
    badgePoll.html.includes('data-dsw-indicator="warn"'));

  doc.hidden = true;
  doc.dispatch('visibilitychange');
  const badgeBeforeHidden = router.stateCalls().length;
  await badgeClock.advance(600000);
  checks.ok('頁面轉背景後常駐指示完全停止輪詢', router.stateCalls().length === badgeBeforeHidden,
    String(router.stateCalls().length - badgeBeforeHidden) + ' 次');
  doc.hidden = false;
  doc.dispatch('visibilitychange');
  await badgePoll.settle();
  checks.ok('回到前景立刻補一次', router.stateCalls().length === badgeBeforeHidden + 1, String(router.stateCalls().length));

  badgePoll.unmount();
  const badgeAfterUnmount = router.stateCalls().length;
  await badgeClock.advance(600000);
  checks.ok('卸載後不再輪詢（timer 清乾淨）', router.stateCalls().length === badgeAfterUnmount,
    String(router.stateCalls().length - badgeAfterUnmount) + ' 次');
  checks.ok('卸載後移除 visibilitychange 監聽', doc.listenerCount('visibilitychange') === 0);
  badgeClock.restore();
  checks.ok('常駐指示的假時鐘期間沒有拋錯', badgeClock.errors.length === 0,
    badgeClock.errors.map(function (error) { return error.message; }).join(' | '));

  // ------------------------------------------------ 收尾
  checks.ok('整場驗證沒有留下任何未處理的元件錯誤', mini.errors.length === 0,
    mini.errors.map(function (error) { return error.message; }).join(' | '));

  console.log('');
  console.log('通過 ' + String(checks.passed) + ' 項，失敗 ' + String(checks.failures.length) + ' 項');
  if (checks.failures.length > 0) {
    for (const failure of checks.failures) console.log('  - ' + failure);
    process.exitCode = 1;
  }
}

await main();
