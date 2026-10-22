# mongo-rw-axi

**Write-capable** MongoDB CLI for agents, for **local dev databases only**. It inserts, updates and deletes documents, loads JSON files, and creates or drops indexes, collections and databases, with the same token-efficient [TOON](https://github.com/toon-format/toon) output as [`mongo-axi`](https://www.npmjs.com/package/mongo-axi). Every read-only `mongo-axi` command is included and still runs read-only.

> **It can modify and drop data.** It only connects directly to one loopback host or unix socket, and refuses a local port that answers as a remote replica set. Irreversible operations preview until `--confirm`.

```sh
npm install -g mongo-rw-axi
printf %s "$DB_PASSWORD" | mongo-rw-axi auth login --profile local --host 127.0.0.1 --user root --auth-source admin -d shop_dev --password-stdin
mongo-rw-axi insert orders '{status: "paid", total: NumberDecimal("12.50"), created_at: ISODate("2026-10-01")}'
mongo-rw-axi update orders '{_id: ObjectId("66f1c2a9e4b0a1b2c3d4e5f6")}' '{$set: {status: "paid"}}'
mongo-rw-axi 'db.orders.updateMany({status: "pending"}, {$set: {status: "expired"}})'
mongo-rw-axi import orders orders.jsonl
```

## What it does

| Command | Writes | Previews until `--confirm` |
|---|---|---|
| `insert <collection> <doc or [docs]>` | `insertMany`, up to 10,000; the collection must exist unless `--create` (a typo must not create one) | - |
| `update <collection> <filter> <update>` | one document, or every match with `--many`; `--upsert`; `--replace`; operators or a pipeline (4.2+) | `--many` whose filter matches every document |
| `delete <collection> <filter>` | one document, or every match with `--many` | `--many` whose filter matches every document |
| `import <collection> <file\|->` | a JSON array or JSON Lines (mongoexport output), in ordered batches; parsed completely before anything is written | `--drop` |
| `index create <collection> <keys>` | `--name`, `--unique`, `--sparse`, `--ttl`, `--partial`; same keys again is a no-op | - |
| `index drop <collection> <name>` | never `_id_` | always |
| `collection create <name>` | `--validator`, `--capped` (+ `--max`), `--view-on` + `--pipeline`; idempotent | - |
| `collection drop <name>` | | always |
| `collection rename <name> <new>` | | when `<new>` exists (it would be replaced) |
| `db drop <name>` | never `admin`, `local` or `config` | always |

"Matches every document" is counted, not guessed from the syntax, so `{_id: {$exists: true}}` previews too. The shell form maps `insertOne`, `insertMany`, `updateOne`, `updateMany`, `replaceOne`, `deleteOne`, `deleteMany`, `createIndex`, `dropIndex`, `drop` and `renameCollection` onto the same commands and gates.

Always refused, whatever the flags:
- writes to the `admin`, `local` and `config` databases and to `system.*` collections (`system.js` holds stored server-side functions, `system.users` the credentials);
- server-side JavaScript (`$where`, `$function`, `$accumulator`) in filters, updates and validators;
- `$out` and `$merge` in read commands: `aggregate` stays read-only.

## Loopback rule

Before connecting, the connection string must name exactly one host that resolves only to `127.0.0.0/8` or `::1`, or a unix socket. `mongodb+srv://`, seed lists, `loadBalanced`, proxy options and `tls=true` are refused (TLS to a loopback port is almost always a tunnel to a managed cluster). The tool connects to the address it checked, always with `directConnection=true`, so the driver never follows a replica set's member list to other hosts. No flag or environment variable overrides this.

After connecting, `hello` lists the replica set's members. If any member is a non-loopback address, resolves to one, or is a dotted name that does not resolve here (`db1.prod.example.com`), the local port is a tunnel to that cluster and the tool refuses it. Members named `localhost`, a loopback address, or a single-label container name that does not resolve here (`mongo1`) are fine.

**Limitation:** a tunnel to a standalone server or a `mongos` cannot be told apart from a local server. Never point a tunnel at a shared database on a machine where an agent has this tool.

Every write command is also checked on the wire, like `mongo-axi`'s reads: only the write commands this tool sends (`insert`, `update`, `delete`, `create`, `drop`, `dropDatabase`, `createIndexes`, `dropIndexes`, `renameCollection`) pass, never on the server's own databases and never with JavaScript inside.

## Recipes

See the [mongo-axi recipes](https://www.npmjs.com/package/mongo-axi#recipes): read and explain with `mongo-axi`, fix with `mongo-rw-axi`, then check again.

```sh
# Reload a collection from a mongoexport dump
mongoexport --uri "$SOURCE" --collection orders | mongo-rw-axi import orders - -d shop_dev --drop --confirm
# Remove expired sessions, then keep them expiring
mongo-rw-axi delete sessions '{expires_at: {$lt: ISODate("2026-10-01")}}' --many
mongo-rw-axi index create sessions '{expires_at: 1}' --ttl 0
```

## Session hook

Install it only where writing is wanted, usually one repository: `mongo-rw-axi setup hooks --local`. The overview it adds starts with the `WRITE-CAPABLE` warning and the loopback scope.

## Connections

Profiles, keychain entries and the env override (`MONGO_RW_AXI_URL`) are separate from `mongo-axi`'s, so logging into one never configures the other.

## Agent integration

A skill ships in `skills/mongo-rw-axi/SKILL.md`. Allow `Bash(mongo-rw-axi:*)` only in projects where an agent should change a local database.

MIT licensed.
