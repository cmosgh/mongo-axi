# mongo-axi

Two [AXI](https://axi.md) MongoDB CLIs for agents, built from one shared core:

| Package | Can write? | Hosts | Use for |
|---|---|---|---|
| [`mongo-axi`](packages/mongo-axi) | **No.** Data-only parser, input guard and a wire allowlist | any (`mongodb+srv`, Atlas, replica sets) | reading any database |
| [`mongo-rw-axi`](packages/mongo-rw-axi) | **Yes.** insert, update, delete, import, index, collection, db | one loopback host or unix socket, direct connection | changing a local dev database |

These are two separate packages, so installing or allowing only `mongo-axi` means an agent has no write command available.

## Documentation

**[mongo-axi](packages/mongo-axi)** (read-only)
- [Safe to auto-approve](packages/mongo-axi#safe-to-auto-approve): what the same agent commands do through `mongosh`, `mongodb-mcp-server --readOnly` and `mongo-axi`, verified in CI
- [How writes are blocked](packages/mongo-axi#how-writes-are-blocked) and [Limitations](packages/mongo-axi#limitations)
- [Recipes](packages/mongo-axi#recipes): slow queries, mixed types, orphan references, duplicates before a unique index, unused indexes
- [Session hook](packages/mongo-axi#session-hook) and [Connections](packages/mongo-axi#connections)

**[mongo-rw-axi](packages/mongo-rw-axi)** (writes, loopback only)
- [What it does](packages/mongo-rw-axi#what-it-does): the write commands and which need `--confirm`
- [Loopback rule](packages/mongo-rw-axi#loopback-rule): single host, direct connection, tunnel detection and its limit

## Layout

```
packages/core          shared code (private, bundled into both CLIs)
packages/mongo-axi     read-only CLI
packages/mongo-rw-axi  write CLI: write commands, loopback and tunnel rule, write wire guard
test/                  parser, guard and unit tests; integration tests against throwaway containers
```

## Development

```sh
pnpm install
pnpm run check              # typecheck, tests, bundle, skill and safety-table freshness
pnpm run test:integration   # needs Docker: starts a throwaway MongoDB 8.0 on a random loopback port
MONGO_AXI_IT_IMAGE=mongo:3.7 pnpm run test:integration   # same suite on an older server (the safety matrix needs mongosh, so it skips)
pnpm run safety:readme      # render the safety matrix that test/integration/safety.test.ts verifies
```

Both packages are released together: `npm version patch && git push --follow-tags` bumps the root and both packages, and the Release workflow stages both on npm for 2FA approval.

MIT licensed.
