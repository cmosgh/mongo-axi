# mongo-axi

**Read-only** MongoDB CLI for agents, following the [AXI](https://axi.md) principles. It lists databases and collections, infers schemas from samples, and runs capped `find`, `aggregate`, `count`, `distinct` and `explain`. Output is token-efficient [TOON](https://github.com/toon-format/toon).

It cannot change data. For writing to a **local** dev database there is a separate package, [`mongo-rw-axi`](https://www.npmjs.com/package/mongo-rw-axi).

```sh
npm install -g mongo-axi
printf %s "$DB_PASSWORD" | mongo-axi auth login --profile dev --host 127.0.0.1 --user app --auth-source admin -d shop --password-stdin
mongo-axi                       # overview: what this tool can do and the configured connections
mongo-axi collections --sort size
mongo-axi describe orders customers
mongo-axi find orders '{status: "paid", created_at: {$gte: ISODate("2026-10-01")}}' --sort '{created_at: -1}'
mongo-axi aggregate orders '[{$group: {_id: "$status", n: {$sum: 1}}}]'
mongo-axi 'db.orders.find({status: "paid"}).limit(5)'    # mongosh syntax, parsed as data
```

## Safe to auto-approve

An agent with `mongosh` through Bash can run anything its account allows, including JavaScript, so each call needs a human to read it first. `mongo-axi` is read-only by construction: filters are parsed as data, write stages and server-side JavaScript are refused, every command is checked against a read allowlist just before it is sent, and every query carries a 30 s `maxTimeMS`. So `Bash(mongo-axi:*)` can be allowed without prompts.

The same commands sent by an agent through each tool, against a throwaway MongoDB 8.0 as the `root` user the official Docker image creates, which is what a local dev setup usually has. Every cell is checked by `test/integration/safety.test.ts` in CI. **ran** means the effect was on the server afterwards.

<!-- safety:start -->
| Command from the agent | `mongosh --eval` | `mongodb-mcp-server --readOnly` 3.1.0 | `mongo-axi` |
| --- | --- | --- | --- |
| *Reads an agent needs* |  |  |  |
| explain a `find` - does it use an index? | works | works | works |
| `$group` orders by status | works | works | works |
| *Mistakes* |  |  |  |
| `deleteMany` | **ran** | blocked by the tool | refused; points to `mongo-rw-axi` (loopback only) |
| `updateMany` with an empty filter | **ran** | blocked by the tool | blocked by the tool |
| `drop()` a collection | **ran** | blocked by the tool | blocked by the tool |
| `find()` everything in a 10,000-document collection | 10,000 documents; ≈475k tokens | 10 documents; ≈1k tokens | 20 documents; ≈1k tokens |
| *Ways around a read-only mode* |  |  |  |
| `$out` at the end of a pipeline | **ran** | blocked by the tool | blocked by the tool |
| `$merge` back into the collection it reads | **ran** | blocked by the tool | blocked by the tool |
| `$where` running JavaScript on the server (`sleep`) | **ran** | blocked by the tool | blocked by the tool |
| read `admin.system.users` (password hashes) | **ran** | **ran** | refused; credential collections are never read |
| a slow scan - is a server-side time limit sent? | **no time limit** | **no time limit** | stopped by `maxTimeMS` (30 s default) |
<!-- safety:end -->

`mongodb-mcp-server` 3.1.0 in `--readOnly` mode stops the same writes and server-side JavaScript. The differences are in the last two rows: it returns `system.users` (password hashes) to the agent, and it sends no time limit unless you configure `maxTimeMS`.

## How writes are blocked

MongoDB has no read-only session, so the account's roles are the only server-side check. The client carries the rest, in four independent layers:

1. **Data, not code.** Filters, projections, sorts and pipelines are JSON, Extended JSON or mongosh literals (`ObjectId('…')`, `ISODate('…')`, unquoted keys, `/regex/i`). A strict parser turns them into BSON values; nothing is evaluated. The mongosh shell form (`db.orders.find(...).sort(...)`) is parsed the same way, so `forEach(function …)`, a second statement or `this` is a syntax error. `Code` values and `$code` are refused.
2. **An input guard,** before connecting. It walks every level of the parsed input and refuses, in any letter case:
   - `$out` and `$merge` (write stages);
   - `$where`, `$function` and `$accumulator` (server-side JavaScript);
   - `$changeStream` (never returns) and internal `$_…` stages;
   - reads of `system.users` and `system.keys`, also through `$lookup`, `$graphLookup` and `$unionWith`.
3. **A wire allowlist.** The driver emits `commandStarted` synchronously before a command reaches the socket, and a listener that throws stops it. Every command is checked there against a read allowlist (`find`, `aggregate`, `getMore`, `count`, `distinct`, `explain`, `list*`, `*Stats`, `hello`, `ping`, `buildInfo`, `connectionStatus`, `killCursors`, `endSessions`). Aggregate and explain bodies are checked again, and `find`/`aggregate`/`count`/`distinct`, explained or not, must carry `maxTimeMS`. This catches a bug in layers 1-2 or in the commands themselves. `doctor` proves it on every run by sending a non-read command and checking that it was stopped.
4. **No write code in the package.** Write commands live only in `mongo-rw-axi`. The build fails if write-tool code shows up in the `mongo-axi` bundle.

## Limitations

- **It is not a role check.** With write roles, a bug in all of the layers above could still write. For a hard guarantee, connect with a read-only user:
  ```js
  db.getSiblingDB("admin").createUser({user: "agent_ro", pwd: passwordPrompt(), roles: [{role: "read", db: "shop"}]})
  ```
  `mongo-axi doctor` lists the account's roles and warns when it can write or when the server has no access control.
- Reads can still be expensive. Each query stops at 30 s (`--timeout`), but a heavy `$lookup` or `$group` uses server resources until then.
- `explain --analyze` runs the query (read-only, time-capped) to get execution stats.
- Keys named `password`, `pwd` and `credentials` print as `<redacted>`. Other sensitive fields print as stored.
- Results are capped at 20 documents (max 1000, `--limit`). A cut result reports the total up to 1000 (`docs: 20 of 72 shown`), so one rerun with `--limit 72` gets them all. Strings are cut at 200 characters, arrays at 20 items and nesting at depth 8; `--full` lifts all three.
- `describe` and `search` infer fields from a sample (100 and 20 documents), so a rare field can be missing.
- MongoDB 4.0 to 8.x (driver 6.16, wire version 7 and up). The integration suite also runs on `mongo:3.7`, the 4.0 development series.

## Recipes

These are the flows in `test/integration/scenarios.test.ts`. The fixes need the local-only [`mongo-rw-axi`](https://www.npmjs.com/package/mongo-rw-axi).

**Slow query: find the collection scan, add the index, check the plan.**
```sh
mongo-axi explain orders '{customer_id: ObjectId("…"), created_at: {$gte: ISODate("2026-09-10")}}'
# -> COLLSCAN filter {...}; help: an index on customer_id would let it use IXSCAN
mongo-rw-axi index create orders '{customer_id: 1, created_at: -1}'
mongo-axi explain orders '<same filter>'
# -> IXSCAN customer_id_1_created_at_-1 (customer_id 1; created_at -1)
```

**A field with mixed types: a filter on one type misses the others.**
```sh
mongo-axi describe orders                     # help: Mixed types (total int|string)
mongo-axi find orders '{total: {$type: "string"}}' --project '{total: 1}'
mongo-rw-axi update orders '{total: {$type: "string"}}' '[{$set: {total: {$toDouble: "$total"}}}]' --many
```

**References to documents that do not exist.**
```sh
mongo-axi aggregate reviews '[{$lookup: {from: "orders", localField: "order_id", foreignField: "_id", as: "order"}}, {$match: {order: {$size: 0}}}, {$project: {order: 0}}]'
```

**Before a unique index: find the duplicates.**
```sh
mongo-axi aggregate signups '[{$group: {_id: {$toLower: "$email"}, n: {$sum: 1}, ids: {$push: "$_id"}}}, {$match: {n: {$gt: 1}}}]'
mongo-rw-axi delete signups '{_id: ObjectId("…")}'
mongo-rw-axi index create signups '{email: 1}' --unique
```

**An index nobody uses.**
```sh
mongo-axi indexes orders      # ops per index since the last restart; help lists the unused ones
```

## Connections

- **Profiles:** `auth login` creates one. The password goes in the OS keychain and the rest goes in `~/.config/mongo-axi/config.json`. `--uri` takes any connection string without the password (`mongodb+srv://`, `replicaSet=`, `tls=true` and so on).
- **Env override:** `MONGO_AXI_URL=mongodb://user:password@host:port/database?authSource=admin` overrides the profiles.
- **Picking a profile:** use `-p/--profile <name>` (before or after the command), or `MONGO_AXI_PROFILE` for a single command. `-d/--database` picks the database; `database.collection` works too.

## Session hook

Run `mongo-axi` with no command and it prints a short overview (about 220 tokens): what the tool may do, its limits, the configured connection and the next commands to try.

```text
$ mongo-axi
bin: ~/.npm-global/bin/mongo-axi
description: "READ-ONLY MongoDB CLI for agents - infer schemas and run capped read queries, with TOON output. Filters are parsed as data (never evaluated) and every command is checked against a read allowlist before it is sent (not a role check)."
mode: READ-ONLY - find; aggregate; count; distinct; explain. Write stages and server-side JavaScript are refused; results capped at 20 docs
profiles[1]{name,target,active}:
  dev,"app@127.0.0.1:27017/shop",true
help[2]:
  Run `mongo-axi collections`, `mongo-axi describe <collection>...`, `mongo-axi search <name>` or `mongo-axi sample <collection>` to explore
  Run `mongo-axi find <collection> '{status: "paid"}'`, `mongo-axi aggregate <collection> '[...]'` or `mongo-axi 'db.<collection>.find({...})'`; `mongo-axi <command> --help` for flags
```

`mongo-axi setup hooks` installs a session-start hook in Claude Code, Codex or OpenCode that puts this overview into the agent's context, so the agent knows the tool and the database before its first command. The overview never connects to a database or reads the keychain, so the hook adds no delay.

| Command | Applies to | Files written |
|---|---|---|
| `mongo-axi setup hooks` | every session of yours | `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.config/opencode/plugins/` |
| `mongo-axi setup hooks --project` | everyone working in this repository (commit the files) | `.claude/settings.json`, `.codex/hooks.json`, `.opencode/plugins/`; Codex also needs `[features] hooks = true` in `~/.codex/config.toml`, which this adds |
| `mongo-axi setup hooks --local` | only you, only in this repository (Claude Code) | `.claude/settings.local.json`; it says so if git would commit the file |

Run `--project` and `--local` from the repository root. `setup status` and `setup uninstall` take the same flag.

## Agent integration

- **Session start:** `mongo-axi setup hooks`; see [Session hook](#session-hook).
- **Skill:** a discovery skill ships in `skills/mongo-axi/SKILL.md`.

MIT licensed.
