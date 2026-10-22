# mongo-axi plan

Two [AXI](https://axi.md) MongoDB CLIs for agents, built like `mysql-axi` / `mysql-rw-axi`:

| Package | Can write? | Hosts | Use for |
|---|---|---|---|
| `mongo-axi` | **No.** Four layers, below | any (incl. `mongodb+srv`, Atlas) | reading any database |
| `mongo-rw-axi` | **Yes.** insert, update, delete, index, collection, db, import | one loopback host or unix socket, direct connection | changing a local dev database |

Goal order: **AI-safe first**, then token-efficient output, then breadth.

## Safety model

### Read-only tool (`mongo-axi`)

MongoDB has no read-only session (MySQL's `transaction_read_only`), so the server-side layer is only the account's roles. The client therefore carries more of the guarantee, in four independent layers:

1. **No code, only data.** Agents pass filters, pipelines, projections and sorts as JSON / Extended JSON / mongosh-style literals (`ObjectId('…')`, `ISODate('…')`, unquoted keys). A small strict parser turns them into BSON values. Nothing is ever `eval`ed, and there is no `mongosh --eval` or `runCommand` passthrough.
2. **Input guard** (walks the parsed value at every depth, before connecting; refusals exit 2 with a hint):
   - `$out`, `$merge`: write stages.
   - `$where`, `$function`, `$accumulator`: server-side JavaScript (CPU burn, sandbox escapes).
   - `$changeStream`: blocks forever.
   - `$_internal*` and other `$_` stages.
   - BSON `Code` values.
   - Reads of `system.users` / `system.keys` (credential hashes, signing keys).
3. **Wire allowlist.** The driver emits `commandStarted` synchronously before a command is written to the socket. A listener that throws stops it, so every command is checked against a read allowlist (`find`, `aggregate`, `getMore`, `count`, `distinct`, `explain`, `list*`, `*Stats`, `ping`, `hello`, `connectionStatus`, `buildInfo`, `killCursors`, `endSessions`):
   - `aggregate` and `explain` bodies are re-checked for write stages.
   - `find`/`aggregate`/`count`/`distinct` must carry `maxTimeMS`.
   - This catches any bug in layers 1-2 or in the code paths themselves.
4. **No write code in the bundle.** Write commands live only in `packages/mongo-rw-axi`. `scripts/build.ts` fails if a write marker (`insertMany`, `deleteMany`, `dropDatabase`, `loopbackOnly`, …) shows up in the `mongo-axi` bundle.

Plus resource caps:
- `maxTimeMS` 30 s on every query (`--timeout`).
- 20 docs by default (`--limit`, max 1000); a cut result reports the exact total up to 1000.
- Strings truncated at 200 chars, arrays at 20 items, depth 8 (`--full` lifts all three).
- `appName=mongo-axi`, so a DBA sees the tool in `currentOp` and logs.

`doctor` reads `connectionStatus { showPrivileges: true }`:
- It warns when the account holds any non-read action, or when the server has no access control.
- It prints the `createUser … roles: [{ role: "read", db }]` recipe for a hard guarantee.

### Write tool (`mongo-rw-axi`)

**Loopback rule** (no flag or env var overrides it):
- exactly one host;
- it must resolve only to 127.0.0.0/8 or `::1`, or be a unix socket;
- always `directConnection=true`, so the driver never follows a replica set's member list to other hosts;
- `mongodb+srv`, multi-host URIs, `loadBalanced` and proxy options are refused;
- the tool connects to the address it checked, not to a name that could re-resolve elsewhere.

**Tunnel detection (stronger than mysql-rw-axi):**
- after connecting, if `hello` lists replica set members that resolve to non-loopback addresses (e.g. `*.mongodb.net`), the local port is a tunnel to a real cluster → refuse;
- member names that don't resolve (docker-compose service names) only get a warning.

**`--confirm` gates.** These preview until `--confirm`:
- drop database / collection / index, rename over an existing collection;
- `import --drop`;
- an update or delete whose filter is empty or **matches every document** (a counted check, not a syntax check: `{_id: {$exists: true}}` is caught too).

Everything is idempotent where it can be: create-if-missing, drop-if-exists, previews.

Read commands in `mongo-rw-axi` go through the read path above, including the wire allowlist.

## Commands

**Read (both tools):**

| Command | Purpose |
|---|---|
| *(none)* | overview: mode banner, configured connections, next steps. No network, no keychain (session hook) |
| `search <text>` | databases / collections / views / sampled field paths containing text |
| `databases` | name, size, collections (`--all` adds admin/local/config) |
| `collections` | name, kind (collection/view/timeseries/capped), docs estimate, size; `--sort`, `--fields` |
| `describe <coll>...` | schema inferred from `$sample` (path, types, % present), indexes, validator, view pipeline, options |
| `sample <coll>` | first N docs (`--random` uses `$sample`) |
| `query <coll> [filter]` (alias `find`) | find; `--project`, `--sort`, `--skip`, `--limit`, `--full` |
| `count <coll> [filter]` | `countDocuments`; `--estimate` uses metadata |
| `distinct <coll> <field> [filter]` | capped distinct values |
| `aggregate <coll> <pipeline>` | read pipelines only; `--file`, `-` for stdin |
| `explain <coll> [filter]` | winning plan as a compact tree (COLLSCAN / IXSCAN name); `--analyze` adds executionStats |
| `indexes <coll>` | keys, unique/sparse/partial/TTL, size, `$indexStats` usage |
| `doctor` | latency, version, topology, user, roles, write-capable warning |
| `auth` | `status`, `login`, `use`, `logout`. Profiles in `~/.config/<tool>`, password in the OS keychain, `<PREFIX>_URL` env override |
| `setup` | session-start hooks (axi-sdk-js), `--project` / `--local` |

The shell form routes like bare SQL in mysql-axi: `mongo-axi 'db.orders.find({status: "paid"}).sort({_id: -1}).limit(5)'` is parsed, not evaluated, and runs as `query`. Write methods are refused with a pointer to `mongo-rw-axi`.

**Write (`mongo-rw-axi` only):**

| Command | Purpose |
|---|---|
| `insert <coll> <doc or [docs]>` | `--file`, `-` |
| `update <coll> <filter> <update>` | `--many`, `--upsert`, `--replace`; reports matched / modified / upserted |
| `delete <coll> <filter>` | `--many` |
| `index create <coll> <keys>` | `--name`, `--unique`, `--sparse`, `--ttl`, `--partial` |
| `index drop <coll> <name>` | needs `--confirm` |
| `collection create <name>` | `--validator`, `--capped`, `--max`, `--view-on` + `--pipeline` |
| `collection drop <name>`, `collection rename <from> <to>` | |
| `db drop <name>` | admin/local/config always refused |
| `import <coll> <file.json\|.jsonl\|->` | EJSON array, JSONL or mongoexport output; parsed fully before writing; batched; `--drop` |

Shell-form writes (`db.orders.updateMany(...)`) map onto the same verbs and the same `--confirm` rules.

## Output

- TOON throughout, via `block()`, `helpBlock()`, `out()` and `fenced()`.
- Typed values print in mongosh form, so anything printed can be pasted back into a filter: `ObjectId('…')`, `ISODate('…')`, `NumberDecimal('…')`, `NumberLong('…')` (only beyond 2^53), `UUID('…')`, `BinData(n, '…')` (≤ 32 bytes, else `<binary N bytes>`), `Timestamp(t, i)`, `/re/flags`.
- Exact keys `password`, `pwd` and `credentials` are redacted.

## Compatibility

`mongodb@6.16.0` is the newest driver that still speaks wire version 7. That covers MongoDB 4.0, the 3.7 dev series and the 8.x servers. Driver 6.17+ needs 4.2+, 7.x needs 4.4+. Node >= 20. Update pipelines (`update ... '[{$set: ...}]'`) need a 4.2+ server.

## Tests

| Suite | What it covers |
|---|---|
| `test/unit.test.ts`, `test/guard.test.ts` | parser, guard, value rendering, schema inference, loopback, classification (pure) |
| `test/integration/` (`pnpm run test:integration`, Docker) | starts its own throwaway standalone `mongo:8.0` (`MONGO_AXI_IT_IMAGE=mongo:3.7` for local parity) on a random loopback port, never the local server; `rw` adds a replica-set container for the tunnel check |

Integration test files:
- `ro`: every read command and its output, the input guard, the wire guard driven directly, doctor for root and a read-role user, the time limit (fail point), auth.
- `rw`: every write command, the confirm gates, the loopback and tunnel refusals.
- `safety`: the README matrix.
  - Arms: `mongosh --eval`, `mongodb-mcp-server --readOnly` and `mongo-axi`.
  - Cases: explain, `$group`, `deleteMany`, `updateMany({})`, `drop`, an unbounded `find`, `$out`, `$merge`, `$where` + `sleep`, `admin.system.users`, and whether a time limit is sent. The wire layer with the input guard bypassed is covered in `ro`.
- `scenarios`: the README recipes.

## Phases

Status (2026-10-22): phases 1-3 are done except the token benchmark; nothing is committed or published yet.

1. **Scaffold + read path**: the monorepo shared with mysql-axi (args, render, errors, config, auth, setup, skill, build checks); the connection plus wire allowlist; the parser and guard; value rendering; every read command; unit + ro integration tests.
2. **Write tool**: loopback + tunnel rule, write verbs, confirm gates, import, shell-form writes; rw integration tests.
3. **Safety matrix + recipes**: `safety-cases.ts`, `pnpm run safety:readme`, scenarios, READMEs, CI (`check`, `integration` on 8.0 and 3.7, `runtime-node20`), release workflow.
4. **Later**:
   - token benchmark vs `mongosh` and `mongodb-mcp-server` (local only, spends model tokens);
   - `ops` (`$currentOp`) and `slow` (profiler) reads;
   - a classified `run '<command json>'` escape hatch in the write tool.
