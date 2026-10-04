# dsh-cbm-keeper

[中文版 README](README.md)

[![CI](https://github.com/WwW7olFWwW/dsh-cbm-keeper/actions/workflows/ci.yml/badge.svg)](https://github.com/WwW7olFWwW/dsh-cbm-keeper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-106%20pass-brightgreen.svg)](test)

DSH × Codebase Memory graph freshness plugin.

Requirements: [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) ｜ Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md) ｜ Changelog: [`CHANGELOG.md`](CHANGELOG.md)

**In one sentence**: make CBM's knowledge graph automatically follow each indexed project's git HEAD, and turn "which projects are stale, by how much, and why it failed" into something you can see.

---

## What it solves

When DSH hooks up Codebase Memory with nothing but a single manual MCP row, **queries work, but "keeping the graph fresh" fails as a whole**: in one measured case it was 33 hours / 37 commits / 988 new files behind, while everyone involved believed it was current. Three independent defects compound:

1. DSH's MCP `cwd` is a profile-level constant ⇒ CBM's watching and auto-index land on the wrong tree (P1);
2. CBM's built-in watcher produces no observable rebuild even when registration succeeds (P2);
3. The MCP tool `index_repository` has a 60-second limit, while indexing this project takes 60,980 ms ⇒ it gets killed every time (P4).

This plugin gets the four things — project resolution, stale detection, conditional rebuild, and visibility — right using DSH's own plugin mechanism, **without modifying CBM itself, without modifying DSH itself, and without a systemd timer**.

## Architecture

```
Browser (Settings → "CBM 圖譜" [CBM Graph])
   │  settings.section slot, plain fetch
   ▼
/api/cbm-keeper/{state,log,check,rebuild,watchers,config}      ← Host half (lib/routes.js)
   ▼
CbmKeeper coordinator (lib/keeper.js)
   ├── Scan: list_projects → merge into the project table by realpath(root) (FR-1)
   ├── Stale decision: Branch.head_sha vs git rev-parse HEAD (FR-2)
   ├── Conditional rebuild: only stale ones are enqueued, global concurrency 1 (FR-3 / FR-14)
   ├── Rebuild execution: `codebase-memory-mcp cli index_repository` (FR-4, bypasses MCP)
   └── Per-project watching: chokidar, falling back to node:fs.watch when absent (FR-6)
```

| File | Responsibility |
|---|---|
| [`lib/index.js`](lib/index.js) | Host plugin entry: `ctx.effect` wires up the lifecycle and the routes |
| [`lib/keeper.js`](lib/keeper.js) | Coordinator: scan, decide, queue, watch, lock |
| [`lib/staleness.js`](lib/staleness.js) | Pure decision logic: identity key, stale decision, mode selection (unit-testable, no real index needed) |
| [`lib/cbm.js`](lib/cbm.js) | Parsing of the CBM CLI's text output (`--json` merely wraps the MCP envelope as-is) |
| [`lib/cli.js`](lib/cli.js) | CLI path resolution order and `--json` envelope parsing |
| [`lib/git.js`](lib/git.js) | git probes: HEAD, commit time, `rev-list --count`, dirtiness |
| [`lib/watcher.js`](lib/watcher.js) | Per-project file watching (chokidar → fs.watch fallback) |
| [`lib/state.js`](lib/state.js) | Atomic state file (restores rebuild intent after a crash) |
| [`lib/log.js`](lib/log.js) | Structured logs with timestamps (in-memory ring + file) |
| [`lib/routes.js`](lib/routes.js) | REST control plane |
| [`lib/client.js`](lib/client.js) | Browser half: the observation card on the settings page |
| [`tools/verify-client.mjs`](tools/verify-client.mjs) | Client rendering verifier (proves the card renders even without a browser) |
| [`tools/verify-keeper.mjs`](tools/verify-keeper.mjs) | Verifier for the Host half against the real CBM CLI (read-only) |

---

## Installation

```bash
# Install from GitHub (recommended)
dsh plugin --profile web add github:WwW7olFWwW/dsh-cbm-keeper

# Or from a local directory (while developing this plugin)
dsh plugin --profile web add /path/to/dsh-cbm-keeper
```

(Or install the same path as a "local directory" from the plugin manager page in DSH Web. It is equivalent to `plugin_manager`'s
`install_bundle`, which handles package installation and bundle selection; you do not need to hand-edit `package.json` or
`cordis.patch.yml` — NFR-5 requires that existing patch content must not be overwritten.)

After installation **no restart is needed**: the Host half hot-loads together with the bundle, and the browser half appears under
Settings → "CBM 圖譜" [CBM Graph] (if it does not, reload the page once).

### Upstream setting worth adjusting alongside

```bash
codebase-memory-mcp config set auto_index false
```

`auto_index=true` is an **unconditional full rebuild**: every session start burns roughly 61 seconds / 658 MB for nothing,
and it still does not bring the graph up to HEAD. At startup this plugin reads `config list`, and if it is still `true` it raises
a named warning on the settings page (R6) — but it will not change the setting for you.

## Configuration

The configuration fields are exactly the Loader entry's Config (writable in `cordis.patch.yml`, and also editable from the settings page).
Every field is `volatile`: it takes effect in place once written, without rebuilding the fiber or restarting.

| Field | Default | Effect |
|---|---|---|
| `enabled` | `true` | Master switch. Turning it off stops automation only (scan / watch / auto-rebuild); routes and the settings page still work. |
| `cliPath` | `''` | Absolute path to the CBM executable. Empty = search in order `CBM_BIN` → `PATH` → common platform paths. |
| `mode` | `full` | Rebuild mode: `fast` / `moderate` / `full`. |
| `rebuildTimeoutSeconds` | `1800` | Timeout for a single rebuild. |
| `scanMinutes` | `5` | Interval for scanning upstream projects and their stale state. |
| `watchEnabled` | `true` | Whether to set up per-project file watching. |
| `debounceMs` | `3000` | Watch debounce; one batch of saves counts as a single rebuild. |
| `autoRebuild` | `true` | Rebuild automatically when staleness is detected. When off, it only reports. |
| `includeDirty` | `true` | Count uncommitted changes as staleness too. |
| `nice` | `10` | nice value of the rebuild child process. |
| `maxLogEntries` | `500` | Number of log entries kept in memory (the file log is unlimited). |
| `extensions` | `''` | Comma-separated whitelist of watched file extensions. Empty = built-in list; `*` = no filtering. |
| `excludes` | `''` | Comma-separated directory names excluded from watching. Empty = built-in list. |
| `includeProjects` | `''` | Manage only these project names. Empty = all. |
| `excludeProjects` | `''` | Exclude these project names. |

## REST control plane

Routes and UI share one source: every action on the card can be hit with curl, and both sides see the same data (FR-12).
Everything goes through DSH's existing `webServer`, inheriting its loopback-only binding, and no extra listening port is opened.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/cbm-keeper/state?log=100` | Global state + project table + notes on unreliable claims + recent log |
| `GET` | `/api/cbm-keeper/log?limit=200` | Log only |
| `POST` | `/api/cbm-keeper/check` | `{}` = rescan the whole batch; `{"id":"<root>"}` = check one only |
| `POST` | `/api/cbm-keeper/rebuild` | `{"id":…}` / `{"staleOnly":true}` / `{"mode":"fast"}` / `{"force":true}` |
| `POST` | `/api/cbm-keeper/watchers` | `{"action":"pause"\|"resume", "id"?:…}` |
| `GET` | `/api/cbm-keeper/config` | Read the current configuration |
| `POST` | `/api/cbm-keeper/config` | Write configuration (field → new value; `null` means revert to default) |

`rebuild` **carries no force** by default: when the graph HEAD matches the working tree it returns `queued: 0` and produces no indexing work
at all (the acceptance condition of FR-3). To re-run unconditionally, pass `force: true`.

## Staleness semantics (FR-9)

Externally it always reports both `graphHead` and `liveHead`, together with the provenance of the verdict:

| `confidence` | Meaning |
|---|---|
| `head` | Primary criterion: the graph's `Branch.head_sha` against `git rev-parse HEAD`. `behindBy` is the exact commit count. |
| `time` | Fallback (R2): when the graph has no `Branch` node, compare `indexed_at` / DB mtime against the HEAD commit time. `behindBy` is `null`. |
| `none` | Insufficient evidence (for example the project has no commits yet, or is not a git working tree). **`stale` is `null`, the UI shows 「無法判定」 ("cannot be determined"), and it is never treated as "fresh".** |

The `git.head_sha` reported by `index_status` is **read live at query time** (P6), so it shows the new HEAD even when the graph has not moved.
This plugin does not use it as a freshness criterion, and no field that "looks new" ever appears on the card.

## Known limitations

- **chokidar is an optional dependency**. When installed via `link:`, pnpm does not install its optionalDependencies into the
  profile, and watching then automatically falls back to `node:fs.watch` (recursive), with the same behavior and semantics; the log records a
  `watcher.chokidar.unavailable` line explaining why. To force chokidar, run
  `pnpm add chokidar@^4` in the plugin directory.
- **Projects rooted at the home directory are not supported for CBM watching** (R5): the upstream security policy rejects them, which is unrelated to this plugin;
  this plugin's watching is its own and is not affected by that policy, but such a project's CBM graph still only updates when this plugin triggers a rebuild.
- **The graph's structural claims are unreliable** (P8/P9/P16). The bottom of the settings page always lists four claims that "cannot be used as evidence";
  this is deliberate labeling rather than a functional defect.
- **Repositories with no commits yet** (`git` has no first commit) are listed as 「無法判定」 ("cannot be determined") with git's raw error message attached; they are never
  mistaken for fresh, nor rebuilt automatically.
- **Projects that vanish upstream stay on the list, marked "orphan"** (`selected=false`, `orphaned=true`, watching stopped),
  instead of being silently removed — that way you can see that "it is gone". Orphans exist only in memory and disappear on restart.
- **`stop()` is a real join**: on unload it waits for an in-flight rebuild to finish (aborting the child process first, capped at 15 seconds),
  so an immediate `rm -rf ~/.dsh/cbm-keeper` after `remove_bundle` cannot be undone by a late write.
  An aborted rebuild leaves one `rebuild.abandoned` log entry, and the state file deliberately stays at `running` / `queued`,
  so that `recoverIntent()` on the next start re-enqueues it.
- **Resolution path of `@deepseek-ai/schemastery` (two traps stacked)**: when this plugin is installed via `link:`,
  `import.meta.url` points at this directory, and the `node_modules` chain going up from here **cannot reach** the profile; and
  `DSH_PROFILE_DIR` is injected by `dsh-shell-env` only into **the child process of each model shell call** — the host process
  that loads the plugin does not have it (measured: `dsh web`'s `/proc/<pid>/environ` contains no `DSH_*` at all). So
  the resolution root order in `lib/config.js` is "profile given by the environment → itself → cwd → **`profiles/*` under the
  DSH home (with the one that actually links this plugin first)**", see `schemasteryRequireRoots()` and
  `profilePackageRoots()`. When all of them miss, `Config` is exported as `undefined` — the plugin keeps working, but that entry
  is no longer "configurable": the settings page and `POST /config` return `No configurable plugin entry`, and the official probe
  (`cordis_inspect_query`, provider `Config`, method `listConfigs`) returning `status: absent` is exactly this symptom.
  The settings service only requires `Config` to have `toJSON` and its fields to be volatile, and volatile references are
  identified across copies via `Symbol.for('cosmokit.volatile.write')`, so a schema compiled from the profile's copy
  works perfectly on the harness's own settings service (all three gates were verified item by item locally:
  the schema is enumerable, the fields are writable, and the settings service reads the new value back after a write).

## Removal

```bash
dsh plugin --profile web remove dsh-cbm-keeper
rm -rf ~/.dsh/cbm-keeper
rm -f ~/.dsh/profiles/web/node_modules/dsh-cbm-keeper   # if left behind (see below)
```

The first line removes the bundle registration and the package dependency; the second clears the plugin's own state file and logs; the third deals with
a known pnpm behavior for `link:` packages — it leaves the symlink inside `node_modules`,
even after the dependency has been removed from `package.json`. The plugin does **not** delete the state directory automatically on unload:
that would only throw away history on every restart, a price higher than the leftover.

Beyond that there are no other footprints: it does not write into project trees, does not change CBM configuration, does not touch `~/.cache/codebase-memory-mcp/`, and does not
touch the profile's `cordis.patch.yml` (the bundle is layered on as a patch layer; that file is byte-for-byte identical before and after installation).

## Development

```bash
node --test "test/*.test.js"           # unit tests (no real index needed)
node tools/verify-keeper.mjs           # scan against the real CBM CLI (read-only, requires the CLI on PATH)
node tools/verify-client.mjs           # client rendering verification (requires dsh web to be running)
```

`node --test test/` fails to resolve in this directory (Node treats `test/` as a module rather than a test directory);
use the glob given above.

`lib/` is plain ESM JavaScript with no build step; the profile points at this directory via `link:`.

**For changes to `lib/` to take effect, `dsh web` must be restarted:**

```bash
systemctl --user restart dsh-web
```

Measured locally (2026-10-04): for a bundle installed via `link:`, changes to `lib/*.js` are **not**
hot-loaded. `install_bundle`, `remove_bundle`, and disabling then re-enabling via `set_bundle` all make the Loader
`apply()` again (a new coordinator instance, `revision` back to zero), but the ESM module cache still serves the old
module generation — what `ctx.effect` re-runs is the old code. The browser half (`lib/client.js`) is different: it re-reads the file
via client-modules every time and produces a new bundle rev, so a page reload is enough.

### Verification status (2026-10-04)

| Item | Evidence |
|---|---|
| Unit tests (NFR-7) | `node --test "test/*.test.js"` → **106 tests / 106 pass / 0 fail / 0 todo** |
| Host half against the real CLI | `node tools/verify-keeper.mjs` → **19/19** (read-only scan + orphan convergence + untracked projects must not be rebuilt) |
| Client rendering | `node tools/verify-client.mjs` → **29/29** (compared value by value against the running server's real responses; the count is data-conditional and drops by one or two when a project has no head) |
| CLI resolution (FR-5) | `cliPath=~/.local/bin/codebase-memory-mcp`, `source=PATH`, `cliVersion=0.11.0`, `supported=true` |
| Automatic adoption (FR-7/US-4) | After a disposable repository is indexed, the next `POST /check` adopts it and sets up watching |
| Stale detection (FR-2) | Sample repository: `graphHead=liveHead=96cd57bb`, `stale=false`, `behindBy=0`, `confidence=head` |
| Conditional rebuild (FR-3) | With everything fresh, `POST /rebuild` returns `queued: 0, skipped: 3`; `staleOnly` returns `沒有落後的專案` ("no stale projects") |
| End-to-end catch-up (US-1) | After commit `edae4a30` the graph caught up in **18.5 seconds** (`watch.triggered` → `rebuild.done caughtUp=true`, the index itself taking 4.42 s) |
| Observability (FR-8/9/10) | The card presents CLI path / version / both HEADs / lag / watcher / warnings value by value; a repository with no commits shows 「無法判定」 ("cannot be determined") |
| Failures are visible (FR-10) | That repository's `lastCheckedError` is 「這個專案尚無提交（unborn HEAD）…」 ("this project has no commits yet (unborn HEAD)…") + git's raw message |
| Version guardrail (FR-15) | `0.11.0` hits the support matrix; a version outside the list turns into a warning on the card |
| Profile patch not overwritten (NFR-5) | `~/.dsh/profiles/web/cordis.patch.yml` is byte-for-byte identical before and after installation |
| Complete removal (NFR-8) | After `remove_bundle` both the bundle list entry and the dependency are removed and the routes go offline; `cordis.patch.yml` is unchanged |
| Configurability (troubleshooting) | The official probe `Config.listConfigs` for entry `cbm-keeper` goes from `status: absent` to **`status: schema`**; `POST /api/cbm-keeper/config` returns `{"ok":true}`, and after a write `cliSource` goes from `config` back to `PATH` |
| Unload drill (the dynamic face of NFR-8) | With a rebuild in flight (slow CLI wrapper, child process `sleep 900`), disabling the bundle gives the log `rebuild.abandoned` (`durationMs=6880 ok=false`) → `keeper.stopped` → `plugin.stop` in that order, and the child process disappears; 12 seconds after `rm -rf ~/.dsh/cbm-keeper` the directory has not come back (no late write) |

Verification was performed **on the already-installed, running server** (`http://127.0.0.1:3080`). After the restart at 2026-10-04 20:33:01
(PID 1901011), the `profilePackageRoots()` fix in `lib/config.js` took effect live; the three real defects fixed that day —
`stop()` not being a join, `Config` not being registered, and "the resolution root relying only on `DSH_PROFILE_DIR`" being ineffective in the host
process — were each verified item by item. **Changes to `lib/` still require a restart to take effect** (see the previous section).

---

## License

[MIT](LICENSE) © 2026 [WwW7olFWwW](https://github.com/WwW7olFWwW)

This project is an independent community plugin and is not affiliated with DeepSeek; DSH (DeepSeek Harness) and
Codebase Memory MCP belong to their respective rights holders.
