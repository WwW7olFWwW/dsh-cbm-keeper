/**
 * 客戶端半邊的渲染驗證器。
 *
 * 為什麼需要它：`lib/client.js` 是一支手寫的動態 Client 模組，跑在瀏覽器裡；
 * 沒有瀏覽器控制時，「bundle 被供應了」不等於「卡片畫得出來」。這個腳本用一個
 * 約 120 行的迷你 hook 執行器（useState／useEffect／useCallback）真的把註冊進
 * `settings.section` 的元件跑一遍，並用**執行中伺服器的真實回應**當資料源，
 * 最後把渲染出的文字與預期值逐項比對。
 *
 * 用法：
 *   node tools/verify-client.mjs [base-url]
 * 預設 base-url 為 http://127.0.0.1:3080。
 */

import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');
const BASE = process.argv[2] ?? 'http://127.0.0.1:3080';

/**
 * 建立一個最小但語意正確的 React 替代品。
 *
 * 只實作這支插件用到的那一小塊：createElement、useState、useEffect、useCallback。
 * 渲染是深度優先的同步遍歷，hook 以「每次渲染重設的游標」定位——與 React 的
 * 規則（順序固定、不得條件呼叫）一致，因此能抓出違反 hook 規則的寫法。
 *
 * @returns {{React: object, render: (Component: Function, props: object) => Promise<string>, errors: Error[]}}
 *   執行器。
 */
function createMiniReact() {
  const hooks = [];
  const errors = [];
  let cursor = 0;
  let version = 0;
  let pendingEffects = [];
  let pendingCleanups = [];

  /**
   * 淺比較依賴陣列，決定 effect 是否重跑（React 的 deps 語意）。
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

  const React = {
    createElement: function (type, config) {
      const children = Array.prototype.slice.call(arguments, 2);
      const props = Object.assign({}, config ?? {});
      if (children.length === 1) props.children = children[0];
      else if (children.length > 1) props.children = children;
      return { type, props };
    },
    useState: function (initial) {
      const index = cursor;
      cursor += 1;
      if (hooks[index] === undefined) {
        hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      }
      const cell = hooks[index];
      return [cell.value, function (next) {
        cell.value = typeof next === 'function' ? next(cell.value) : next;
        version += 1;
      }];
    },
    useEffect: function (effect, deps) {
      const index = cursor;
      cursor += 1;
      const cell = hooks[index];
      if (cell !== undefined && !depsChanged(cell.deps, deps)) return;
      hooks[index] = { deps: deps === undefined ? undefined : deps.slice() };
      pendingEffects.push(effect);
    },
    useCallback: function (callback, deps) {
      const index = cursor;
      cursor += 1;
      const cell = hooks[index];
      // React 的語意：deps 沒變就回上一次那個函式實例。少了這一步，依賴它的
      // useEffect（deps: [reload]）每輪都會重跑，驗證會誤判成無窮迴圈。
      if (cell !== undefined && !depsChanged(cell.deps, deps)) return cell.value;
      hooks[index] = { deps: deps === undefined ? undefined : deps.slice(), value: callback };
      return callback;
    },
    useMemo: function (factory, deps) {
      const index = cursor;
      cursor += 1;
      const cell = hooks[index];
      if (cell !== undefined && !depsChanged(cell.deps, deps)) return cell.value;
      const value = factory();
      hooks[index] = { deps: deps === undefined ? undefined : deps.slice(), value };
      return value;
    },
    useContext: function () {
      throw new Error('此插件不得使用 React context');
    },
    createContext: function () {
      throw new Error('此插件不得使用 React context');
    },
  };

  /**
   * 把一個元素樹渲染成 HTML 字串（同步、深度優先）。
   * @param {unknown} node - 元素、字串、數字或陣列。
   * @param {object} props - 傳給函式元件的 props。
   * @returns {string} HTML。
   */
  function renderElement(node, props) {
    if (node === null || node === undefined || node === false || node === true) return '';
    if (Array.isArray(node)) {
      const parts = [];
      for (const child of node) parts.push(renderElement(child, undefined));
      return parts.join('');
    }
    if (typeof node === 'string' || typeof node === 'number') return escapeHtml(String(node));
    if (typeof node.type === 'function') {
      const saved = cursor;
      cursor = 0;
      try {
        const produced = node.type(node.props ?? props ?? {});
        return renderElement(produced, node.props ?? props);
      } finally {
        cursor = saved;
      }
    }
    const tag = node.type;
    const attributes = [];
    const style = node.props?.style;
    const text = [];
    for (const key of Object.keys(node.props ?? {})) {
      if (key === 'children' || key === 'style' || key === 'key') continue;
      const value = node.props[key];
      if (value === undefined || value === null || value === false) continue;
      if (typeof value === 'function') continue;
      attributes.push(key + '="' + escapeHtml(String(value)) + '"');
    }
    if (style !== undefined && style !== null) attributes.push('style="' + escapeHtml(styleToCss(style)) + '"');
    const children = node.props?.children;
    if (typeof children === 'string' || typeof children === 'number') text.push(escapeHtml(String(children)));
    else if (Array.isArray(children)) {
      for (const child of children) text.push(renderElement(child, undefined));
    } else if (children !== undefined && children !== null) {
      text.push(renderElement(children, undefined));
    }
    return '<' + tag + (attributes.length > 0 ? ' ' + attributes.join(' ') : '') + '>' + text.join('') + '</' + tag + '>';
  }

  /**
   * 反覆渲染直到狀態穩定：每次先渲染、再跑 effect、再讓非同步工作落地。
   *
   * 每次渲染後立刻執行 effect 的清理函式——掛在 effect 上的計時器（面板的 3 秒
   * 輪詢）否則會讓 Node 的 event loop 永不結束，也會讓驗證誤判成無窮迴圈。
   *
   * @param {Function} Component - 元件。
   * @param {object} props - props。
   * @returns {Promise<{html: string, passes: number}>} 渲染結果與迴圈次數。
   */
  async function render(Component, props) {
    let html = '';
    for (let pass = 0; pass < 20; pass += 1) {
      for (const cleanup of pendingCleanups.reverse()) {
        try {
          if (typeof cleanup === 'function') cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      pendingCleanups = [];
      cursor = 0;
      pendingEffects = [];
      const before = version;
      const tree = { type: Component, props: props ?? {} };
      try {
        html = renderElement(tree, props ?? {});
      } catch (error) {
        errors.push(error);
        return { html: '', passes: pass + 1 };
      }
      for (const effect of pendingEffects) {
        try {
          pendingCleanups.push(effect());
        } catch (error) {
          errors.push(error);
          return { html: '', passes: pass + 1 };
        }
      }
      await new Promise(function (resolve) { setTimeout(resolve, 25); });
      if (version === before) {
        // 收尾：把最後一輪掛上的計時器清掉，否則 Node 的 event loop 不會結束。
        for (const cleanup of pendingCleanups) {
          try {
            if (typeof cleanup === 'function') cleanup();
          } catch (error) {
            errors.push(error);
          }
        }
        pendingCleanups = [];
        return { html, passes: pass + 1 };
      }
    }
    return { html, passes: 20 };
  }

  return { React, render, errors };
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
 * @returns {object} 假 context 與其記錄。
 */
function createFakeCtx() {
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
        return function (key) {
          const table = record.dictionaries.find(function (entry) { return entry.ns === ns; });
          const dict = table?.dicts?.zh ?? {};
          return dict[key] ?? key;
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
 * 主流程。
 * @returns {Promise<void>} 完成即結束；有失敗時以非零碼退出。
 */
async function main() {
  console.log('dsh-cbm-keeper 客戶端渲染驗證');
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

  const realFetch = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    return realFetch(new URL(String(input), BASE), init);
  };

  await import(pathToFileURL(join(PLUGIN_ROOT, 'lib', 'client.js')).href);

  const checks = new Checks();
  checks.ok('模組以 __ModuleLoader__.load 註冊', captured !== undefined);
  checks.ok('registration id 等於套件名', captured?.id === 'dsh-cbm-keeper', String(captured?.id));

  const mini = createMiniReact();
  const exported = captured.factory(function require(id) {
    if (id === 'react') return mini.React;
    throw new Error('未預期的 require：' + id);
  });

  checks.ok('factory 匯出 inject 清單', Array.isArray(exported.inject) && exported.inject.includes('slots'));
  checks.ok('factory 匯出 apply', typeof exported.apply === 'function');

  const { ctx, record } = createFakeCtx();
  exported.apply(ctx);

  checks.ok('註冊了 locale 字典', record.dictionaries.length === 1 && record.dictionaries[0].ns === 'cbm-keeper');
  checks.ok('注入 settings.section', record.injections.includes('settings.section'), record.injections.join(','));
  const registration = record.registrations[0];
  checks.ok('settings.section 註冊存在', registration !== undefined);
  checks.ok('分區 id 為 cbm-keeper', registration?.options?.id === 'cbm-keeper', String(registration?.options?.id));
  checks.ok('分區 order 為數字', typeof registration?.options?.order === 'number', String(registration?.options?.order));
  checks.ok('分區 label 可解析為非空字串', typeof registration?.options?.label?.() === 'string' && registration.options.label().length > 0,
    String(registration?.options?.label?.()));

  const rendered = await mini.render(registration.Component, {});
  checks.ok('元件渲染未拋錯', mini.errors.length === 0, mini.errors.map(function (e) { return e.message; }).join(' | '));
  checks.ok('渲染有輸出', rendered.html.length > 500, String(rendered.html.length) + ' bytes');
  checks.ok('狀態穩定（無窮迴圈）', rendered.passes < 20, String(rendered.passes) + ' passes');

  const html = rendered.html;

  // 逐值核對：這些字串只有在真的抓到 /api/cbm-keeper/state 的資料時才會出現。
  let live;
  try {
    const response = await realFetch(new URL('/api/cbm-keeper/state?log=120', BASE));
    live = await response.json();
  } catch (error) {
    checks.ok('取得執行中伺服器的真實狀態', false, error instanceof Error ? error.message : String(error));
    live = undefined;
  }
  if (live !== undefined) {
    checks.ok('標題出現', html.includes('Codebase Memory'));
    checks.ok('CLI 路徑逐值呈現', html.includes(live.status.cliPath), live.status.cliPath);
    checks.ok('CLI 版本逐值呈現', html.includes(live.status.cliVersion), live.status.cliVersion);
    checks.ok('沒有卡在載入中', !html.includes('載入中…'));
    for (const project of live.projects) {
      checks.ok('專案 ' + project.name + ' 出現在卡片上', html.includes(project.name));
      if (project.graphHeadShort !== undefined) {
        checks.ok('專案 ' + project.name + ' 的圖譜 HEAD 逐值呈現', html.includes(project.graphHeadShort), project.graphHeadShort);
      }
      if (project.liveHeadShort !== undefined) {
        checks.ok('專案 ' + project.name + ' 的工作樹 HEAD 逐值呈現', html.includes(project.liveHeadShort), project.liveHeadShort);
      }
      if (project.stale === true) {
        checks.ok('專案 ' + project.name + ' 標示為落後', html.includes('落後'));
      } else if (project.stale === false) {
        checks.ok('專案 ' + project.name + ' 標示為已同步', html.includes('已同步'));
      } else {
        checks.ok('專案 ' + project.name + ' 標示為無法判定（不得宣稱已索引）', html.includes('無法判定'));
      }
    }
    const stale = live.projects.filter(function (project) { return project.stale === true; });
    checks.ok('落後計數與實際一致（' + String(stale.length) + '）', true);
    for (const warning of live.status.warnings ?? []) {
      checks.ok('警告可見：' + warning.code, html.includes('警告'));
      break;
    }
  }

  checks.ok('使用主題 token 而非字面色', html.includes('--dsw-alias-'), 'missing token');

  console.log('');
  console.log('通過 ' + String(checks.passed) + ' 項，失敗 ' + String(checks.failures.length) + ' 項');
  if (checks.failures.length > 0) {
    for (const failure of checks.failures) console.log('  - ' + failure);
    process.exitCode = 1;
  }
}

await main();
