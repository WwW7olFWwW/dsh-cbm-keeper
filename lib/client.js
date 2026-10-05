/**
 * dsh-codebase-watcher — 瀏覽器半邊（設定頁觀測卡片）。
 *
 * 掛在 `settings.section` 上（設定 →「CBM 圖譜」），顯示每個已索引專案的
 * graph_head／live_head／behind_by／watcher 狀態／lastError，並提供手動操作。
 * 所有資料都來自 Host 半邊的 `/api/codebase-watcher/*`，因此卡片與 curl 逐值一致
 * （FR-8/FR-9/FR-12）。
 *
 * 這是一支手寫的動態 Client 模組：`dsh.client` 只宣告 platform 與資訊性的
 * inject 邊，實際載入走模組表的 lazy factory。樣式只用主題 token
 * （`--dsw-alias-*`），不引入任何 Harness Client 套件，也不碰 DOM 之外的世界。
 */

window.__ModuleLoader__.load({
  id: 'dsh-codebase-watcher',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 本地化命名空間。 */
    const NS = 'codebase-watcher';

    /** 這支卡片的字典。鍵名與 zh 完全對齊。 */
    const zh = {
      'section.label': 'CBM 圖譜',
      'panel.title': 'Codebase Memory 圖譜新鮮度',
      'panel.subtitle': '每個已索引專案的圖譜 HEAD 與工作樹 HEAD 逐項比對；判定為落後才會重建。',
      'action.check': '立即檢查',
      'action.rebuildStale': '重建所有落後',
      'action.rebuildAll': '全部強制重建',
      'action.cancel': '取消重建',
      'hint.rebuildAll': '不管圖譜是否落後，對所有已納管專案重跑一次索引。',
      'hint.cancel': '中止目前正在跑的重建；被中止的專案會在下一次啟動時重新排入。',
      'action.pauseAll': '暫停全部監看',
      'action.resumeAll': '恢復全部監看',
      'action.rebuild': '重建',
      'action.forceRebuild': '強制重建',
      'action.pause': '暫停監看',
      'action.resume': '恢復監看',
      'action.refresh': '重新載入',
      'action.showLog': '顯示日誌',
      'action.hideLog': '收起日誌',
      'action.openGraph': '開啟圖譜',
      'action.openProjectGraph': '圖譜',
      'graph.hint': '在 CBM 的圖譜 UI 開啟',
      'graph.disabled': 'CBM 圖譜 UI 未啟用：執行 codebase-memory-mcp --ui=true',
      'graph.invalid': '圖譜 UI 網址無法解析',
      'graph.unreachable': '圖譜 UI 未回應',
      'state.loading': '載入中…',
      'state.empty': '目前沒有任何已索引的專案。先在 CBM 索引一個專案，下一輪掃描會自動納管。',
      'state.stale': '落後',
      'state.fresh': '已同步',
      'state.unknown': '無法判定',
      'state.running': '重建中',
      'state.queued': '排隊中',
      'state.idle': '閒置',
      'state.watching': '監看中',
      'state.paused': '監看已暫停',
      'state.stopped': '已停止',
      'state.failed': '失敗',
      'label.cli': 'CLI',
      'label.cliSource': '來源',
      'label.version': '版本',
      'label.lastScan': '上次掃描',
      'label.queue': '佇列',
      'label.watching': '監看中',
      'label.root': '根目錄',
      'label.branch': '分支',
      'label.graphHead': '圖譜 HEAD',
      'label.liveHead': '工作樹 HEAD',
      'label.behindBy': '落後提交',
      'label.indexedAt': '索引時點',
      'label.lastIndexedAt': '上次重建',
      'label.lastDuration': '上次耗時',
      'label.watcher': '監看',
      'label.triggers': '觸發次數',
      'label.nodes': '節點',
      'label.edges': '邊',
      'label.parsePartial': '局部解析',
      'label.notIndexed': '未入圖檔',
      'label.confidence': '判據',
      'label.reasons': '判定依據',
      'label.lastError': '上次錯誤',
      'label.lastRefreshError': '上次掃描失敗',
      'label.watcherError': '監看失敗',
      'label.checkError': '檢查時的問題',
      'label.warnings': '警告',
      'label.dirty': '工作樹有未提交變更',
      'label.caveats': '不可作為證據的圖譜宣告',
      'label.log': '最近事件',
      'confidence.head': 'HEAD 比對',
      'confidence.time': '時間旁證',
      'confidence.none': '無',
      'reason.head-match': '圖譜與工作樹 HEAD 一致',
      'reason.head-match-but-dirty': 'HEAD 一致，但工作樹有未提交變更（依設定計為落後）',
      'reason.head-advanced': '圖譜落後工作樹',
      'reason.live-head-unavailable': '讀不到工作樹 HEAD',
      'reason.time-fallback-head-newer': '圖譜沒有 Branch 節點，改用時間旁證：疑似落後',
      'reason.time-fallback-head-older': '圖譜沒有 Branch 節點，改用時間旁證：看起來一致',
      'reason.no-evidence': '證據不足，無法判定',
      'unit.seconds': '秒',
      'unit.commits': '個提交',
      'unit.files': '檔',
    };

    /** 英文對照。 */
    const en = {
      'section.label': 'CBM Graph',
      'panel.title': 'Codebase Memory graph freshness',
      'panel.subtitle': 'Compares each indexed project\u2019s graph HEAD against its worktree HEAD and rebuilds only what is judged stale.',
      'action.check': 'Check now',
      'action.rebuildStale': 'Rebuild stale',
      'action.rebuildAll': 'Force rebuild all',
      'action.cancel': 'Cancel rebuild',
      'hint.rebuildAll': 'Re-index every tracked project regardless of staleness.',
      'hint.cancel': 'Abort the running rebuild; the project is re-queued on the next start.',
      'action.pauseAll': 'Pause all watchers',
      'action.resumeAll': 'Resume all watchers',
      'action.rebuild': 'Rebuild',
      'action.forceRebuild': 'Force rebuild',
      'action.pause': 'Pause watcher',
      'action.resume': 'Resume watcher',
      'action.refresh': 'Reload',
      'action.showLog': 'Show log',
      'action.hideLog': 'Hide log',
      'action.openGraph': 'Open graph',
      'action.openProjectGraph': 'Graph',
      'graph.hint': 'Open in the CBM graph UI',
      'graph.disabled': 'CBM graph UI is off: run codebase-memory-mcp --ui=true',
      'graph.invalid': 'Graph UI URL cannot be resolved',
      'graph.unreachable': 'Graph UI is not responding',
      'state.loading': 'Loading…',
      'state.empty': 'No indexed projects yet. Index one with CBM and the next scan adopts it automatically.',
      'state.stale': 'Stale',
      'state.fresh': 'Up to date',
      'state.unknown': 'Undetermined',
      'state.running': 'Rebuilding',
      'state.queued': 'Queued',
      'state.idle': 'Idle',
      'state.watching': 'Watching',
      'state.paused': 'Watcher paused',
      'state.stopped': 'Stopped',
      'state.failed': 'Failed',
      'label.cli': 'CLI',
      'label.cliSource': 'Source',
      'label.version': 'Version',
      'label.lastScan': 'Last scan',
      'label.queue': 'Queue',
      'label.watching': 'Watching',
      'label.root': 'Root',
      'label.branch': 'Branch',
      'label.graphHead': 'Graph HEAD',
      'label.liveHead': 'Worktree HEAD',
      'label.behindBy': 'Behind by',
      'label.indexedAt': 'Indexed at',
      'label.lastIndexedAt': 'Last rebuild',
      'label.lastDuration': 'Last duration',
      'label.watcher': 'Watcher',
      'label.triggers': 'Triggers',
      'label.nodes': 'Nodes',
      'label.edges': 'Edges',
      'label.parsePartial': 'Partial parses',
      'label.notIndexed': 'Not indexed',
      'label.confidence': 'Evidence',
      'label.reasons': 'Why',
      'label.lastError': 'Last error',
      'label.lastRefreshError': 'Last scan failed',
      'label.watcherError': 'Watcher failed',
      'label.checkError': 'Check problem',
      'label.warnings': 'Warnings',
      'label.dirty': 'Uncommitted worktree changes',
      'label.caveats': 'Graph declarations not usable as evidence',
      'label.log': 'Recent events',
      'confidence.head': 'HEAD comparison',
      'confidence.time': 'Time fallback',
      'confidence.none': 'none',
      'reason.head-match': 'Graph and worktree HEAD match',
      'reason.head-match-but-dirty': 'HEAD matches, but the worktree has uncommitted changes (counted as stale by configuration)',
      'reason.head-advanced': 'Graph is behind the worktree',
      'reason.live-head-unavailable': 'Worktree HEAD cannot be read',
      'reason.time-fallback-head-newer': 'No Branch node in the graph; time-based fallback suggests it is behind',
      'reason.time-fallback-head-older': 'No Branch node in the graph; time-based fallback suggests it matches',
      'reason.no-evidence': 'Not enough evidence to decide',
      'unit.seconds': 's',
      'unit.commits': 'commits',
      'unit.files': 'files',
    };

    /** 主題 token 的唯一出口：所有顏色都經過這裡，元件不得寫字面色。 */
    const TOKEN = {
      text: 'var(--dsw-alias-label-primary)',
      textDim: 'var(--dsw-alias-label-tertiary)',
      textFaint: 'var(--dsw-alias-label-caption)',
      border: 'var(--dsw-alias-border-l2)',
      borderSoft: 'var(--dsw-alias-border-l1)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      surfaceAlt: 'var(--dsw-alias-bg-layer-2)',
      brand: 'var(--dsw-alias-brand-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-label)',
      error: 'var(--dsw-alias-state-error-primary)',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    };

    /**
     * 帶逾時的 JSON 抓取；失敗時拋出帶伺服器訊息的錯誤。
     * @param {string} url - 同源路徑。
     * @param {object} [init] - fetch 選項。
     * @returns {Promise<object>} 解析後的回應。
     */
    async function api(url, init) {
      const controller = new AbortController();
      const timer = setTimeout(function () { controller.abort(); }, 30000);
      try {
        const response = await fetch(url, Object.assign({ signal: controller.signal }, init ?? {}));
        const text = await response.text();
        let payload;
        try {
          payload = text.length === 0 ? {} : JSON.parse(text);
        } catch {
          throw new Error('HTTP ' + response.status + '：回應不是合法 JSON');
        }
        if (!response.ok) {
          throw new Error(typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status);
        }
        return payload;
      } finally {
        clearTimeout(timer);
      }
    }

    /**
     * 送出一個 POST。
     * @param {string} path - 路由。
     * @param {object} body - 內文。
     * @returns {Promise<object>} 回應。
     */
    function post(path, body) {
      return api('/api/codebase-watcher' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
    }

    /**
     * 相對時間：給定 ISO 時間字串，回傳「3 分鐘前」這類字串。
     * @param {string|undefined} iso - ISO 時間。
     * @param {string} fallback - 無值時的替代文字。
     * @returns {string} 顯示文字。
     */
    function relativeTime(iso, fallback) {
      if (typeof iso !== 'string' || iso.length === 0) return fallback;
      const then = Date.parse(iso);
      if (Number.isNaN(then)) return iso;
      const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
      if (seconds < 60) return seconds + ' 秒前';
      if (seconds < 3600) return Math.round(seconds / 60) + ' 分鐘前';
      if (seconds < 86400) return Math.round(seconds / 3600) + ' 小時前';
      return Math.round(seconds / 86400) + ' 天前';
    }

    /**
     * 毫秒轉人類可讀。
     * @param {number|undefined} ms - 毫秒。
     * @param {string} unit - 秒的單位字串。
     * @returns {string} 顯示文字。
     */
    function formatDuration(ms, unit) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
      return (ms / 1000).toFixed(1) + ' ' + unit;
    }

    /**
     * 數字千分位。
     * @param {number|undefined} value - 數值。
     * @returns {string} 顯示文字。
     */
    function formatNumber(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      return value.toLocaleString('en-US');
    }

    /** 判定理由代碼 → 字典鍵。字典沒有的代碼一律原樣顯示代碼本身，不猜語意。 */
    const REASON_KEYS = {
      'head-match': 'reason.head-match',
      'head-match-but-dirty': 'reason.head-match-but-dirty',
      'head-advanced': 'reason.head-advanced',
      'live-head-unavailable': 'reason.live-head-unavailable',
      'time-fallback-head-newer': 'reason.time-fallback-head-newer',
      'time-fallback-head-older': 'reason.time-fallback-head-older',
      'no-evidence': 'reason.no-evidence',
    };

    /**
     * 取一個可選字串欄位：非字串或空字串都算「沒有值」。
     * Host 半邊可能是舊世代（沒有 reasons／lastRefreshError／graphUi.note／
     * watcher.lastError），卡片必須照常成立，因此所有新欄位都經過這裡。
     * @param {unknown} value - 待檢查的值。
     * @returns {string|undefined} 可用的字串。
     */
    function optionalText(value) {
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    }

    /**
     * 把判定理由代碼翻成人話。
     * @param {unknown} code - 理由代碼。
     * @param {Function} t - 翻譯函式。
     * @returns {string} 顯示文字；空字串代表這個代碼不值得顯示。
     */
    function describeReason(code, t) {
      if (typeof code !== 'string' || code.length === 0) return '';
      const key = REASON_KEYS[code];
      return key === undefined ? code : t(key);
    }

    /** 小徽章。 @param {object} props - label/tone。 @returns {object} React 元素。 */
    function Badge(props) {
      const tone = props.tone ?? 'neutral';
      const color = tone === 'error' ? TOKEN.error
        : tone === 'warn' ? TOKEN.warn
          : tone === 'success' ? TOKEN.success
            : tone === 'brand' ? TOKEN.brand
              : TOKEN.textDim;
      return h('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '4px',
          padding: '1px 7px', borderRadius: '999px', fontSize: '11px', lineHeight: '18px',
          border: '1px solid ' + TOKEN.border, color, background: TOKEN.surfaceAlt, whiteSpace: 'nowrap',
        },
      }, props.children ?? props.label);
    }

    /** 按鈕。 @param {object} props - onClick/label/tone/disabled/title。 @returns {object} React 元素。 */
    function Button(props) {
      const [hover, setHover] = React.useState(false);
      const disabled = props.disabled === true;
      const color = props.tone === 'danger' ? TOKEN.error : props.tone === 'brand' ? TOKEN.brand : TOKEN.text;
      return h('button', {
        type: 'button',
        title: props.title,
        disabled,
        onClick: props.onClick,
        onMouseEnter: function () { setHover(true); },
        onMouseLeave: function () { setHover(false); },
        style: {
          font: 'inherit', fontSize: '12px', lineHeight: '20px', padding: '2px 10px',
          borderRadius: '6px', cursor: disabled ? 'not-allowed' : 'pointer',
          color: disabled ? TOKEN.textFaint : color,
          border: '1px solid ' + TOKEN.border,
          background: hover && !disabled ? TOKEN.surfaceAlt : TOKEN.surface,
          opacity: disabled ? 0.6 : 1,
        },
      }, props.label);
    }

    /**
     * 連結按鈕：與 Button 同外觀，但用 `<a>` 開新分頁——圖譜 UI 是另一個來源
     * （CBM 的 HTTP 服務），不能在這裡用 fetch 取代。
     * @param {object} props - href/label/tone/title。 @returns {object} React 元素。
     */
    function LinkButton(props) {
      const [hover, setHover] = React.useState(false);
      const color = props.tone === 'brand' ? TOKEN.brand : TOKEN.text;
      return h('a', {
        href: props.href,
        target: '_blank',
        rel: 'noreferrer noopener',
        title: props.title ?? props.href,
        onMouseEnter: function () { setHover(true); },
        onMouseLeave: function () { setHover(false); },
        style: {
          font: 'inherit', fontSize: '12px', lineHeight: '20px', padding: '2px 10px',
          borderRadius: '6px', cursor: 'pointer', color,
          border: '1px solid ' + TOKEN.border,
          background: hover ? TOKEN.surfaceAlt : TOKEN.surface,
          textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px',
        },
      }, props.label);
    }

    /** 一列 key/value。 @param {object} props - label/value/mono/tone。 @returns {object} React 元素。 */
    function Field(props) {
      return h('div', { style: { display: 'flex', gap: '6px', alignItems: 'baseline', minWidth: 0 } },
        h('span', { style: { color: TOKEN.textFaint, fontSize: '11px', flex: '0 0 auto' } }, props.label),
        h('span', {
          title: props.title ?? String(props.value ?? ''),
          style: {
            color: props.tone === 'error' ? TOKEN.error : (props.value === undefined || props.value === null || props.value === '—' ? TOKEN.textFaint : TOKEN.text),
            fontSize: '12px',
            fontFamily: props.mono === true ? TOKEN.mono : 'inherit',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          },
        }, props.value === undefined || props.value === null || props.value === '' ? '—' : String(props.value)));
    }

    /**
     * 單一專案的卡片（FR-8）。
     * @param {object} props - project/t/busy/onAction。
     * @returns {object} React 元素。
     */
    function ProjectCard(props) {
      const project = props.project;
      const t = props.t;
      const busy = props.busy === true;
      const watcher = project.watcher ?? {};
      const watcherError = optionalText(watcher.lastError);
      const reasons = Array.isArray(project.reasons) ? project.reasons : [];
      const staleTone = project.stale === true ? 'error' : (project.stale === false ? 'success' : 'warn');
      const staleLabel = project.stale === true ? t('state.stale')
        : (project.stale === false ? t('state.fresh') : t('state.unknown'));
      const behind = project.behindBy === null || project.behindBy === undefined
        ? (project.confidence === 'time' ? t('confidence.time') : '—')
        : String(project.behindBy) + ' ' + t('unit.commits');
      // 只有「落後且確實有落後提交數」才配紅色；behindBy 為 0 時（例如只因為
      // 工作樹 dirty 才判定落後）用一般色，否則會出現紅色的「落後 0 個提交」。
      const behindTone = project.stale === true && typeof project.behindBy === 'number' && project.behindBy > 0
        ? 'error' : undefined;
      const watcherLabel = watcher.status === 'watching' ? t('state.watching')
        : watcher.status === 'failed' ? t('state.failed') : t('state.stopped');
      const rebuildLabel = project.rebuildState === 'running' ? t('state.running')
        : project.rebuildState === 'queued' ? t('state.queued') : t('state.idle');

      return h('div', {
        style: {
          border: '1px solid ' + (project.stale === true ? TOKEN.error : TOKEN.borderSoft),
          borderRadius: '10px', padding: '12px 14px', background: TOKEN.surface,
          display: 'flex', flexDirection: 'column', gap: '8px',
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        h('span', { style: { color: TOKEN.text, fontSize: '14px', fontWeight: 600 } }, project.name),
        project.branch ? h('span', { style: { color: TOKEN.textFaint, fontSize: '11px' } }, project.branch) : null,
        h(Badge, { label: staleLabel, tone: staleTone }),
        h(Badge, { label: rebuildLabel, tone: project.rebuildState === 'idle' ? 'neutral' : 'brand' }),
        h(Badge, { label: t('label.watcher') + '：' + watcherLabel, tone: watcher.status === 'failed' ? 'error' : 'neutral' }),
        watcherError !== undefined
          ? h('span', {
            style: { color: TOKEN.error, fontSize: '11px', wordBreak: 'break-word' },
            title: watcherError,
          }, t('label.watcherError') + '：' + watcherError)
          : null,
        project.watcherPaused === true ? h(Badge, { label: t('state.paused'), tone: 'warn' }) : null,
        h(Badge, {
          label: t('label.confidence') + '：' + t('confidence.' + (project.confidence ?? 'none')),
          tone: project.confidence === 'head' ? 'neutral' : 'warn',
        }),
        project.dirty === true ? h(Badge, { label: t('label.dirty'), tone: 'warn' }) : null,
        h('div', { style: { flex: '1 1 auto' } }),
        h(Button, {
          label: t('action.check'), disabled: busy,
          onClick: function () { props.onAction('check', project); },
        }),
        h(Button, {
          label: project.stale === true ? t('action.rebuild') : t('action.forceRebuild'),
          tone: 'brand', disabled: busy,
          title: project.stale === true ? undefined : '圖譜 HEAD 與工作樹一致；這會強制重跑一次索引。',
          onClick: function () { props.onAction('rebuild', project); },
        }),
        h(Button, {
          label: watcher.status === 'watching' ? t('action.pause') : t('action.resume'),
          disabled: busy,
          onClick: function () { props.onAction(watcher.status === 'watching' ? 'pause' : 'resume', project); },
        }),
        project.graphUrl !== undefined
          ? h(LinkButton, {
            href: project.graphUrl, label: t('action.openProjectGraph'),
            title: t('graph.hint') + '：' + project.graphUrl,
          })
          : null,
      ),
      reasons.length > 0
        ? h('div', {
          style: { color: TOKEN.textFaint, fontSize: '11px', lineHeight: '1.6', wordBreak: 'break-word' },
        }, t('label.reasons') + '：' + reasons
          .map(function (code) { return describeReason(code, t); })
          .filter(function (text) { return text.length > 0; })
          .join('；'))
        : null,
      h('div', {
        style: {
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '4px 18px', borderTop: '1px solid ' + TOKEN.borderSoft, paddingTop: '8px',
        },
      },
      h(Field, { label: t('label.root'), value: project.rootPath, mono: true, title: project.rootPath }),
      h(Field, { label: t('label.graphHead'), value: project.graphHeadShort ?? '—', mono: true, title: project.graphHead ?? '' }),
      h(Field, { label: t('label.liveHead'), value: project.liveHeadShort ?? '—', mono: true, title: project.liveHead ?? '' }),
      h(Field, { label: t('label.behindBy'), value: behind, tone: behindTone }),
      h(Field, { label: t('label.indexedAt'), value: relativeTime(project.indexedAt, '—'), title: project.indexedAt ?? '' }),
      h(Field, { label: t('label.lastIndexedAt'), value: relativeTime(project.lastIndexedAt, '—'), title: project.lastIndexedAt ?? '' }),
      h(Field, { label: t('label.lastDuration'), value: formatDuration(project.lastDurationMs, t('unit.seconds')) }),
      h(Field, { label: t('label.triggers'), value: String(watcher.triggers ?? 0) + '（' + String(watcher.backend ?? 'none') + '）' }),
      h(Field, { label: t('label.nodes'), value: formatNumber(project.nodes) }),
      h(Field, { label: t('label.edges'), value: formatNumber(project.edges) }),
      h(Field, { label: t('label.parsePartial'), value: formatNumber(project.parsePartialCount) }),
      h(Field, { label: t('label.notIndexed'), value: formatNumber(project.notIndexedFilesCount) + ' ' + t('unit.files') }),
      ),
      project.lastError !== undefined && project.lastError !== null && project.lastError !== ''
        ? h('div', {
          style: {
            color: TOKEN.error, fontSize: '12px', borderTop: '1px solid ' + TOKEN.borderSoft,
            paddingTop: '6px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          },
        }, t('label.lastError') + '：' + project.lastError)
        : null,
      project.lastCheckedError !== undefined && project.lastCheckedError !== null && project.lastCheckedError !== ''
        ? h('div', { style: { color: TOKEN.warn, fontSize: '12px', wordBreak: 'break-word' } },
          t('label.checkError') + '：' + project.lastCheckedError)
        : null,
      );
    }

    /**
     * 設定頁內容：整塊觀測面（FR-8/9/10/12）。
     * @param {object} props - t（由註冊處閉包帶入的翻譯函式）。
     * @returns {object} React 元素。
     */
    function Panel(props) {
      const t = props.t;
      const [snapshot, setSnapshot] = React.useState(undefined);
      const [error, setError] = React.useState(undefined);
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState(undefined);
      const [showLog, setShowLog] = React.useState(false);

      const reload = React.useCallback(function () {
        return api('/api/codebase-watcher/state?log=120')
          .then(function (payload) {
            setSnapshot(payload);
            setError(undefined);
          })
          .catch(function (failure) {
            setError(failure.message);
          });
      }, []);

      React.useEffect(function () {
        let alive = true;
        void reload();
        const timer = setInterval(function () { if (alive) void reload(); }, 3000);
        return function () {
          alive = false;
          clearInterval(timer);
        };
      }, [reload]);

      /**
       * 執行一個會改變狀態的動作；忙碌期間停用按鈕，結束後立刻重讀。
       * @param {string} path - 路由。
       * @param {object} body - 內文。
       * @returns {Promise<void>} 完成。
       */
      const run = React.useCallback(function (path, body) {
        setBusy(true);
        setNote(undefined);
        return post(path, body)
          .then(function (payload) {
            if (typeof payload.note === 'string') setNote(payload.note);
            return reload();
          })
          .catch(function (failure) { setError(failure.message); })
          .finally(function () { setBusy(false); });
      }, [reload]);

      if (snapshot === undefined) {
        return h('div', { style: { color: TOKEN.textDim, fontSize: '13px', padding: '12px' } },
          error === undefined ? t('state.loading') : '載入失敗：' + error);
      }

      const status = snapshot.status ?? {};
      const graphUi = status.graphUi ?? {};
      const projects = snapshot.projects ?? [];
      const caveats = snapshot.caveats ?? [];
      const log = snapshot.log ?? [];
      const warnings = status.warnings ?? [];
      // Host 半邊是舊世代時這兩個欄位不存在；undefined 就整段不畫。
      const refreshError = optionalText(status.lastRefreshError);
      const graphUiNote = optionalText(graphUi.note);

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 2px 24px' } },
        h('div', null,
          h('div', { style: { color: TOKEN.text, fontSize: '15px', fontWeight: 600 } }, t('panel.title')),
          h('div', { style: { color: TOKEN.textDim, fontSize: '12px', marginTop: '2px' } }, t('panel.subtitle')),
        ),

        h('div', {
          style: {
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '4px 18px', border: '1px solid ' + TOKEN.borderSoft, borderRadius: '10px',
            padding: '10px 14px', background: TOKEN.surfaceAlt,
          },
        },
        h(Field, { label: t('label.cli'), value: status.cliPath ?? '（未解析）', mono: true, tone: status.cliPath === undefined ? 'error' : undefined, title: status.cliPath ?? '' }),
        h(Field, { label: t('label.cliSource'), value: status.cliSource ?? '—' }),
        h(Field, { label: t('label.version'), value: status.cliVersion ?? '—', tone: status.cliVersionSupported === false ? 'error' : undefined }),
        h(Field, { label: t('label.lastScan'), value: relativeTime(status.lastRefreshAt, '—'), title: status.lastRefreshAt ?? '' }),
        h(Field, { label: t('label.queue'), value: String((status.queue ?? []).length) + (status.running === undefined ? '' : '（執行中）') }),
        h(Field, { label: t('label.watching'), value: String(status.watching ?? 0) + ' / ' + String(projects.filter(function (p) { return p.selected === true; }).length) }),
        ),

        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
          h(Button, { label: t('action.check'), disabled: busy, tone: 'brand', onClick: function () { void run('/check', {}); } }),
          h(Button, { label: t('action.rebuildStale'), disabled: busy, onClick: function () { void run('/rebuild', { staleOnly: true }); } }),
          h(Button, {
            label: t('action.rebuildAll'),
            disabled: busy,
            title: t('hint.rebuildAll'),
            onClick: function () { void run('/rebuild', { force: true }); },
          }),
          h(Button, {
            label: t('action.cancel'),
            disabled: busy || status.running === undefined,
            title: t('hint.cancel'),
            onClick: function () { void run('/cancel', {}); },
          }),
          h(Button, { label: t('action.pauseAll'), disabled: busy, onClick: function () { void run('/watchers', { action: 'pause' }); } }),
          h(Button, { label: t('action.resumeAll'), disabled: busy, onClick: function () { void run('/watchers', { action: 'resume' }); } }),
          h(Button, { label: t('action.refresh'), disabled: busy, onClick: function () { void reload(); } }),
          h(Button, { label: showLog ? t('action.hideLog') : t('action.showLog'), onClick: function () { setShowLog(!showLog); } }),
          graphUi.url !== undefined
            ? h(LinkButton, {
              href: graphUi.url, label: t('action.openGraph'), tone: 'brand',
              title: t('graph.hint') + '：' + graphUi.url,
            })
            : null,
          graphUi.state === 'disabled' ? h(Badge, { label: t('graph.disabled'), tone: 'neutral' }) : null,
          graphUi.state === 'invalid' ? h(Badge, { label: t('graph.invalid'), tone: 'warn' }) : null,
          graphUi.url !== undefined && graphUi.reachable === false
            ? h(Badge, { label: t('graph.unreachable'), tone: 'warn' })
            : null,
          graphUiNote !== undefined
            ? h('span', {
              style: { color: TOKEN.warn, fontSize: '11px', wordBreak: 'break-word' },
              title: graphUiNote,
            }, graphUiNote)
            : null,
          busy ? h('span', { style: { color: TOKEN.textFaint, fontSize: '12px' } }, '…') : null,
        ),

        error !== undefined ? h('div', { style: { color: TOKEN.error, fontSize: '12px', whiteSpace: 'pre-wrap' } }, error) : null,
        note !== undefined ? h('div', { style: { color: TOKEN.textDim, fontSize: '12px' } }, note) : null,

        refreshError !== undefined || warnings.length > 0
          ? h('div', {
            style: {
              border: '1px solid ' + (refreshError === undefined ? TOKEN.warn : TOKEN.error),
              borderRadius: '10px', padding: '10px 14px',
              display: 'flex', flexDirection: 'column', gap: '6px', background: TOKEN.surface,
            },
          },
          refreshError !== undefined
            ? h('div', {
              style: { color: TOKEN.error, fontSize: '12px', fontWeight: 600, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
            }, t('label.lastRefreshError') + '：' + refreshError)
            : null,
          warnings.length > 0
            ? h('div', { style: { color: TOKEN.warn, fontSize: '12px', fontWeight: 600 } }, t('label.warnings'))
            : null,
          warnings.map(function (warning, index) {
            return h('div', { key: 'w' + String(index), style: { color: TOKEN.text, fontSize: '12px', whiteSpace: 'pre-wrap' } },
              '· ' + warning.message);
          }))
          : null,

        projects.length === 0
          ? h('div', { style: { color: TOKEN.textDim, fontSize: '13px' } }, t('state.empty'))
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
            projects.map(function (project) {
              return h(ProjectCard, {
                key: project.key,
                project,
                t,
                busy,
                onAction: function (action, target) {
                  if (action === 'check') void run('/check', { id: target.key });
                  else if (action === 'rebuild') void run('/rebuild', { id: target.key, force: target.stale !== true });
                  else void run('/watchers', { id: target.key, action });
                },
              });
            })),

        h('details', null,
          h('summary', { style: { cursor: 'pointer', color: TOKEN.textDim, fontSize: '12px' } }, t('label.caveats')),
          h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px', color: TOKEN.textDim, fontSize: '12px', lineHeight: '1.6' } },
            caveats.map(function (caveat, index) {
              return h('li', { key: 'c' + String(index) }, caveat.message);
            }))),

        showLog
          ? h('div', {
            style: {
              border: '1px solid ' + TOKEN.borderSoft, borderRadius: '10px', padding: '10px 12px',
              maxHeight: '320px', overflow: 'auto', background: TOKEN.surfaceAlt,
            },
          },
          h('div', { style: { color: TOKEN.textDim, fontSize: '12px', marginBottom: '6px' } }, t('label.log')),
          log.slice().reverse().map(function (entry) {
            const tone = entry.level === 'error' ? TOKEN.error : (entry.level === 'warn' ? TOKEN.warn : TOKEN.textDim);
            let detail = '';
            try {
              detail = JSON.stringify(entry.detail);
            } catch {
              detail = '';
            }
            return h('div', {
              key: 'l' + String(entry.seq),
              style: { fontFamily: TOKEN.mono, fontSize: '11px', color: TOKEN.textFaint, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
            },
            h('span', { style: { color: tone } }, entry.at + ' ' + entry.level + ' ' + entry.event),
            detail.length > 2 ? ' ' + detail : '');
          }))
          : null,
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(function () {
          return ctx.locale.register(NS, { zh, en });
        }, 'dsh-codebase-watcher: dictionaries');
        const t = ctx.locale.bind(NS);

        ctx.effect(function () {
          return ctx.slots.inject('settings.section', function () {
            return ctx.slots.register({
              name: 'settings.section',
              id: 'codebase-watcher',
              order: 14,
              label: function () { return t('section.label'); },
              locale: NS,
              inject: function () { return {}; },
            }, function Section() {
              return h(Panel, { t });
            });
          });
        }, 'dsh-codebase-watcher: settings section');
      },
    };
  },
});
