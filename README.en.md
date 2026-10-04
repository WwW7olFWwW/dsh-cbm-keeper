# dsh-cbm-keeper

[中文版 README](README.md)

[![CI](https://github.com/WwW7olFWwW/dsh-cbm-keeper/actions/workflows/ci.yml/badge.svg)](https://github.com/WwW7olFWwW/dsh-cbm-keeper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-106%20pass-brightgreen.svg)](test)

Keep CBM's knowledge graph in step with each indexed project's git HEAD — and make "which projects are stale, by how much, and why it failed" visible.

Wiring DSH to CBM with nothing but a manual MCP row **works for queries but breaks graph freshness as a whole**: in one measured case the graph was 33 hours / 37 commits / 988 new files behind while everyone involved believed it was current. Three defects compound: DSH's MCP `cwd` is a profile-level constant, CBM's built-in watcher produces no observable rebuild, and the MCP tool `index_repository` has a 60-second cap (indexing this project takes 60,980 ms). This plugin works around all three.

---

## Installation

```bash
dsh plugin --profile web add github:WwW7olFWwW/dsh-cbm-keeper
```

**No restart needed**: the card appears under Settings → "CBM 圖譜" [CBM Graph] (reload the page once if it does not).
While you are there, turn off the upstream unconditional full rebuild — every session start burns ~61 s / 658 MB and still does not catch up to HEAD:

```bash
codebase-memory-mcp config set auto_index false
```

## What it does

- **Identifies projects** by `realpath(root_path)`, so aliases of the same tree collapse into one row.
- **Decides staleness** by comparing the graph's `Branch.head_sha` against `git rev-parse HEAD`, giving an exact `behindBy`; falls back to `indexed_at` / DB mtime when there is no `Branch` node. Insufficient evidence reports "cannot be determined" — **it never pretends to be fresh**.
- **Rebuilds only what is stale**: global concurrency 1; when the graph already matches HEAD, `POST /rebuild` returns `queued: 0` and produces no indexing work at all.
- **Rebuilds through a CLI child process** (`codebase-memory-mcp cli index_repository`), so the MCP tool's 60-second cap does not apply.
- **Catches up on save**: per-project file watching with debounce; falls back to `node:fs.watch` when chokidar is absent.

It does not modify CBM, does not modify DSH, and needs no systemd timer.

## Configuration

All 15 fields (`enabled`, `cliPath`, `mode`, `scanMinutes`, `autoRebuild`, `extensions`, …) are volatile and editable from the settings page or `cordis.patch.yml`; the REST control plane shares one source with the UI, so every card action can be hit with curl.
Full field list and routes: [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

## Known limitations

- chokidar is an optional dependency; without it, watching falls back to `node:fs.watch` with identical semantics.
- Projects rooted at the home directory are not supported for CBM watching (upstream security policy) — this plugin's own watching is unaffected.
- The graph's structural claims (`routes` / `layers` / `languages`) cannot be used as evidence; the card labels them as such.

Everything else (orphan projects, unborn HEAD, the `stop()` join, the `@deepseek-ai/schemastery` resolution path) is in [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md).

## Removal

```bash
dsh plugin --profile web remove dsh-cbm-keeper
rm -rf ~/.dsh/cbm-keeper
```

## Development

```bash
node --test test/*.test.js     # 106 unit tests, no real index needed
node tools/verify-keeper.mjs   # read-only scan against the real CBM CLI
```

After changing `lib/`, run `systemctl --user restart dsh-web` for it to take effect (the ESM module cache of a `link:` install is not hot-loaded).

[Architecture and file map](docs/ARCHITECTURE.md) ｜ [Verification status](docs/DEVELOPMENT.md) ｜ [Requirements](docs/REQUIREMENTS.md) ｜ [Contributing](CONTRIBUTING.md) ｜ [Changelog](CHANGELOG.md)

---

## License

[MIT](LICENSE) © 2026 [WwW7olFWwW](https://github.com/WwW7olFWwW). This is an independent community plugin, not affiliated with DeepSeek.
