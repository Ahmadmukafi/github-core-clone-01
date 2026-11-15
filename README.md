# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Ahmadmukafi/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Ahmadmukafi/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node 22 process, standard library only: its own in-memory git object store (pack read/write with delta resolution, merge-base, three-way squash merges), git smart HTTP (upload-pack protocol v2, receive-pack v0), REST v3 under `/api/v3`, GraphQL v4 at `/api/graphql` (Relay global ids, introspection, cursor pagination, batched operations), and MCP at `/mcp` (JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28, six tools). No git binary, no disk writes, no dependencies.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=<token> MAKEFUN_ENV_URL=<env-url> node main.ts
```

Without `MAKEFUN_ENV_URL` the forge serves on an ephemeral localhost port for local development (auth open when no token is set). With it, the forge registers its port with the trial environment, long-polls `/done`, and exits 0 when the suite is over.

## Layout

- `main.ts` — entrypoint: bind, register, wait for done.
- `src/server.ts` — HTTP routing, bearer auth, `X-GitHub-Request-Id`.
- `src/objects.ts` — git objects, packs, reachability, merge-base, tree diffs.
- `src/store.ts` — the in-memory forge state: repos, refs, issues, pulls, contents.
- `src/pkt.ts` — pkt-line framing and sideband packets.
- `src/git-http.ts` — info/refs, upload-pack (v2/v0), receive-pack.
- `src/rest.ts` — REST v3; `src/rest-shapes.ts` — the shared JSON shapes.
- `src/graphql.ts` — GraphQL v4 parser, executor and schema.
- `src/mcp.ts` — MCP tools over JSON-RPC 2.0.

---

Entered on [make.fun](https://make.fun/?ref=6z0bn4hz&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards
