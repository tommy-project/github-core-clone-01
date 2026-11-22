# github-core-clone-01 — a GitHub-compatible git forge in one Node process

Built for the [make.fun](https://make.fun) competition
**"Build a GitHub-compatible git forge"** (`github-core-clone-01`).
A standalone forge that serves the four surfaces Git clients already know —
git smart HTTP, REST v3, GraphQL, and MCP — from a single dependency-free
Node 22 process with its own in-memory store. No UI, no outside service,
no `git` binary.

## What it does

- **Git smart HTTP** — `info/refs`, `git-upload-pack`, `git-receive-pack`
  (protocol v2 aware), with its own pack reader/writer and pkt-line handling.
  Clone and push work against it like against any git host.
- **REST v3** (`/api/v3/`) — repositories, branches, commits, contents,
  issues, comments, labels, pull requests, files and merges.
- **GraphQL** (`POST /api/graphql`) — queries and mutations shaped like the
  ones `gh` and `github-mcp-server` send.
- **MCP** (`POST /mcp`) — streamable HTTP: `initialize`, `tools/list`,
  `tools/call`.
- **Auth** — bearer token via the `MAKEFUN_SHOP_TOKEN` environment variable;
  `/healthz` answers `{"ok": true}` without a token, everything else
  requires it. Unknown paths answer JSON 404.
- **Deterministic** — the state export is identical across runs; error
  stacks are never surfaced, handlers answer with HTTP statuses and JSON
  error bodies.

## How to run

Requires **Node >= 22.18**. No dependencies to install.

```sh
npm start
# node --experimental-strip-types main.ts
```

Note: `main.ts` is wired to the make.fun trial harness — it binds an
ephemeral port, registers it at `MAKEFUN_ENV_URL`, then polls `/done`
until the trial ends. Without `MAKEFUN_ENV_URL` it exits with an error.
To run it standalone, point that variable at your own harness or wrap
`createApp()` from `app.ts` in your own entrypoint.

## Verification

Local practice suite from the competition kit (`sdk/run.ts`) against a
fresh server:

- **120/120 conformance checks passed**
- Score **800** (600 feature + 200 agent-native) **+ 183 perf points**
  locally (trial perf is calibrated against the reference forge, so it
  will differ)

Submitted to make.fun on 15 Nov 2026 (submission
`01a1ddad-729f-776e-9fa9-11aed3c2b72b`); entries closed 21 Nov 2026.
No final result is claimed here — the graded outcome had not been
published when this repo was created.

## Layout

| File | Role |
|---|---|
| `main.ts` | Trial lifecycle: bind, register, poll `/done` |
| `app.ts` | HTTP server, routing, bearer auth |
| `rest.ts` | REST v3 handlers |
| `graphql.ts` | GraphQL handlers |
| `mcp.ts` | MCP tools over streamable HTTP |
| `gitproto.ts` | Git smart-HTTP services (info/refs, upload-pack, receive-pack) |
| `gitwire.ts` | pkt-line / pack wire format |
| `store.ts` | In-memory store (repos, issues, PRs, objects, refs) |
| `http-util.ts` | Body reading, JSON responses, auth check |

## License

MIT — see [LICENSE](LICENSE).

Built by [Tomm](https://github.com/tommy-project) — crypto hunter and
builder from Indonesia, competing at
[make.fun](https://make.fun/u/tommy-project).
