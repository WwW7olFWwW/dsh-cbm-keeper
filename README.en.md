# dsh-cbm-keeper [![CI](https://github.com/WwW7olFWwW/dsh-cbm-keeper/actions/workflows/ci.yml/badge.svg)](https://github.com/WwW7olFWwW/dsh-cbm-keeper/actions/workflows/ci.yml)

English | [中文](README.md)

Hooking [Codebase Memory](https://github.com/DeusData/codebase-memory-mcp) (CBM) into [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) with a single MCP row **works for queries but leaves the graph silently stale**: the MCP `cwd` is a profile-level constant (so CBM's watching and auto-index land on the wrong tree), CBM's built-in watcher produces no observable rebuild, and the MCP tool `index_repository` has a 60-second cap. In one measured case the graph was 33 hours / 37 commits / 988 files behind while everyone believed it was current.

`dsh-cbm-keeper` gets **staleness detection, conditional rebuild and observability** right — **without modifying CBM, without modifying DSH, and without a systemd timer**.

## Installation

```sh
dsh plugin --profile web add github:WwW7olFWwW/dsh-cbm-keeper
```

No restart needed; the card appears under Settings → "CBM 圖譜" [CBM Graph]. While you are there, turn off the upstream unconditional full rebuild (~61 s / 658 MB burnt on every session start):

```sh
codebase-memory-mcp config set auto_index false
```

## Features

- **Staleness detection**: the graph's `Branch.head_sha` vs `git rev-parse HEAD`, giving an exact `behindBy`; falls back to `indexed_at` / DB mtime when there is no `Branch` node. Insufficient evidence reports "cannot be determined" instead of pretending to be fresh.
- **Conditional rebuild**: only stale projects are enqueued, global concurrency 1; when the graph matches HEAD, `POST /rebuild` returns `queued: 0`.
- **Bypasses the MCP 60-second cap**: rebuilds run as a child process, `codebase-memory-mcp cli index_repository`.
- **Catches up on save**: per-project file watching with debounce; falls back to `node:fs.watch` without chokidar.
- **Observability and control**: the settings card and the REST control plane share one source, so every card action can be hit with curl.

## Compatibility

| Plugin | DSH | Codebase Memory |
|---|---|---|
| `0.1.x` | 0.2 (`dsh web`) | `codebase-memory-mcp@0.11.0` (versions outside the list turn into a card warning) |

## Configuration

15 volatile fields and 7 REST routes: [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)

## Known limitations

chokidar is an optional dependency; projects rooted at the home directory are not supported for CBM watching (upstream security policy); the graph's structural claims cannot be used as evidence.
Everything else is in [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md).

## Removal

```sh
dsh plugin --profile web remove dsh-cbm-keeper
rm -rf ~/.dsh/cbm-keeper
```

## Development

```sh
node --test test/*.test.js   # 106 unit tests, no real index needed
```

After changing `lib/`, run `systemctl --user restart dsh-web` for it to take effect (the ESM module cache of a `link:` install is not hot-loaded).

[Architecture](docs/ARCHITECTURE.md) ｜ [Verification status](docs/DEVELOPMENT.md) ｜ [Requirements](docs/REQUIREMENTS.md) ｜ [Contributing](CONTRIBUTING.md) ｜ [Changelog](CHANGELOG.md) ｜ [Issues](https://github.com/WwW7olFWwW/dsh-cbm-keeper/issues)

## License

[MIT](LICENSE) © 2026 [WwW7olFWwW](https://github.com/WwW7olFWwW)
