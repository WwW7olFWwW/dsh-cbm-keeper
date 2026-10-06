# dsh-codebase-watcher [![CI](https://github.com/WwW7olFWwW/dsh-codebase-watcher/actions/workflows/ci.yml/badge.svg)](https://github.com/WwW7olFWwW/dsh-codebase-watcher/actions/workflows/ci.yml)

English | [中文](README.md)

Wiring [Codebase Memory](https://github.com/DeusData/codebase-memory-mcp) (CBM) into [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) with a single MCP row works fine for queries; what breaks is that the graph goes stale silently. The MCP `cwd` is a profile-level constant, so CBM's watching and auto-index land on the wrong tree. CBM's built-in watcher produces no observable rebuild, and the MCP tool `index_repository` has a 60-second cap. In one measured case the graph was 33 hours, 37 commits and 988 files behind while everyone believed it was current.

`dsh-codebase-watcher` measures how far the graph is behind, calls CBM's CLI to rebuild only when it has to, and shows the result on the settings card. Beyond installing the plugin there is nothing to change in CBM or DSH, and no systemd timer to set up.

## Requirements

- **Codebase Memory**: the `codebase-memory-mcp` CLI, tested on 0.11.0. Other versions still work and turn into a card warning. When the CLI is not on `PATH` the card shows "（未解析）" [unresolved]; set `cliPath` on the settings page.
- **Node.js ≥ 20** and **DSH ≥ 0.2.0-rc.2**, both declared in this plugin's `engines`.
- **The project must be a git worktree**: staleness comes from comparing `git rev-parse HEAD` against the graph's `Branch.head_sha`.

## Installation

```sh
dsh plugin --profile web add github:WwW7olFWwW/dsh-codebase-watcher
```

A "CBM 圖譜" [CBM Graph] card then appears under Settings; reload the page once if it does not. While you are there, turn off the upstream unconditional full rebuild. It burns about 61 s / 658 MB at every session start:

```sh
codebase-memory-mcp config set auto_index false
```

## First run

The first scan adopts every project Codebase Memory has already indexed, and queues the stale ones for rebuild. Rebuilds run one at a time (global concurrency 1), so the first batch can take a while.

To watch before you let it act, set `autoRebuild` to `false`, or narrow the set with `includeProjects`.

## Features

- **Staleness detection**: the graph's `Branch.head_sha` against `git rev-parse HEAD`, giving an exact `behindBy`. With no `Branch` node it falls back to `indexed_at` and the database mtime; when the evidence is insufficient it reports "cannot be determined".
- **Conditional rebuild**: only stale projects are queued. When the graph already matches HEAD, `POST /rebuild` returns `queued: 0` and no indexing work happens.

Rebuilds run as a child process, `codebase-memory-mcp cli index_repository`, which sidesteps the 60-second cap on the MCP tool. Every adopted project gets file watching with debounce, so a save is picked up on its own; without chokidar it falls back to `node:fs.watch`.

The settings card and the REST control plane share one source, so every card action can also be hit with curl. The card header and each project row link into the CBM graph UI (`?project=` deep-links to a single project); when the UI is off or unreachable the link says why instead of breaking.

## Compatibility

| Plugin | DSH | Codebase Memory |
|---|---|---|
| `0.3.x` | `>=0.2.0-rc.2` (tested on 0.2.0-rc.2; declared via `engines.dsh`) | `codebase-memory-mcp@0.11.0` (versions outside the list turn into a card warning) |

## Configuration

17 tunable fields and 8 REST routes: [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md). Field changes take effect immediately, no restart.

State lives in `~/.dsh/codebase-watcher/state.json` and the log in `~/.dsh/codebase-watcher/keeper.log`. Read-only query: `curl -s http://127.0.0.1:3080/api/codebase-watcher/state`.

## Known limitations

chokidar is an optional dependency; without it the watcher falls back to `node:fs.watch`. Projects rooted at the home directory are not watched by CBM (upstream security policy). The graph's structural claims cannot be used as evidence.
Everything else is in [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md).

## Removal

```sh
dsh plugin --profile web remove dsh-codebase-watcher
rm -rf ~/.dsh/codebase-watcher
rm -f ~/.dsh/profiles/web/node_modules/dsh-codebase-watcher
```

The last line clears a known pnpm leftover for `link:` packages: the symlink stays in `node_modules` after the dependency is gone. Uninstalling does not delete the state directory; remove it yourself.

## Development

```sh
node --test test/*.test.js   # 115 unit tests, no real index needed
```

[Architecture](docs/ARCHITECTURE.md) ｜ [Verification status](docs/DEVELOPMENT.md) ｜ [Requirements](docs/REQUIREMENTS.md) ｜ [Contributing](CONTRIBUTING.md) ｜ [Changelog](CHANGELOG.md) ｜ [Issues](https://github.com/WwW7olFWwW/dsh-codebase-watcher/issues)

## License

[MIT](LICENSE) © 2026 [WwW7olFWwW](https://github.com/WwW7olFWwW)
