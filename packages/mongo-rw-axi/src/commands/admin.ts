import type { CreateIndexesOptions, Document } from "mongodb";
import { bool, flag, intFlag, parseArgs, type ParsedArgs } from "../../../core/src/args.js";
import { indexKeys, indexOptions, storageStats } from "../../../core/src/commands/browse.js";
import { collectionNames, CONNECTION_FLAGS, CONNECTION_FLAGS_HELP, PROFILE_FLAG, targetFrom } from "../../../core/src/commands/common.js";
import { readPipeline } from "../../../core/src/commands/query.js";
import { axiError, usageError } from "../../../core/src/errors.js";
import { isPlainObject, parseDocument } from "../../../core/src/literal.js";
import { block, helpBlock, humanBytes, out, type Obj } from "../../../core/src/render.js";
import { keysText, shellText } from "../../../core/src/values.js";
import { assertNoCode, assertWritable, PROTECTED_DATABASES } from "../write-guard.js";
import { CONFIRM_FLAG, existingCollection, newNamespace, nsText, preview, validDatabase, write } from "./common.js";

// --- index ---

export const INDEX_HELP = `usage: mongo-rw-axi index <create|drop> <collection> <keys|name> [flags]
WRITES. create is idempotent (an index on the same keys is a no-op); drop previews until --confirm and never drops _id_.
flags{create}:
  --name <name>, --unique, --sparse, --ttl <seconds>, --partial <filter>, ${CONNECTION_FLAGS_HELP}
flags{drop}:
  --confirm, ${CONNECTION_FLAGS_HELP}
examples:
  mongo-rw-axi index create orders '{status: 1, created_at: -1}'
  mongo-rw-axi index create sessions '{created_at: 1}' --ttl 3600
  mongo-rw-axi index create customers '{email: 1}' --unique --partial '{email: {$exists: true}}'
  mongo-rw-axi index drop orders status_1_created_at_-1 --confirm
`;

export interface IndexCreateSpec {
  keys: Document;
  options: CreateIndexesOptions;
}

export function indexKeysInput(value: unknown): Document {
  if (!isPlainObject(value) || Object.keys(value).length === 0) throw usageError("index keys are a document such as {status: 1, created_at: -1}");
  return value;
}

export async function executeIndexCreate(parsed: ParsedArgs, raw: string, spec: IndexCreateSpec, usage: string): Promise<string> {
  if (spec.options.partialFilterExpression) assertNoCode("--partial", spec.options.partialFilterExpression);
  const target = await targetFrom(parsed);
  const result = await write(target, parsed, async (s) => {
    const ns = await existingCollection(s, raw, usage);
    const coll = s.client.db(ns.database).collection(ns.collection);
    const wanted = shellText(spec.keys);
    const same = (await coll.listIndexes().toArray()).find((i) => shellText(i["key"]) === wanted);
    if (same && (!spec.options.name || spec.options.name === same["name"])) return { ns, name: String(same["name"]), created: false, existing: same };
    const name = await coll.createIndex(spec.keys, spec.options);
    return { ns, name, created: true, existing: undefined };
  });
  const summary: Obj = { collection: nsText(result.ns), name: result.name, keys: keysText(spec.keys) };
  const existingOptions = result.existing ? indexOptions(result.existing) : null;
  if (existingOptions) summary["options"] = existingOptions;
  summary["result"] = result.created ? "created" : "already exists (no-op)";
  return out(
    block({ index: summary }),
    helpBlock(result.existing && existingOptions !== indexOptions({ ...spec.options, key: spec.keys }) ? ["The existing index has other options - drop it first to change them"] : []),
  );
}

export interface IndexDropSpec {
  name: string;
  confirm: boolean;
}

export async function executeIndexDrop(parsed: ParsedArgs, raw: string, spec: IndexDropSpec, usage: string): Promise<string> {
  if (spec.name === "_id_") throw usageError("the _id_ index cannot be dropped");
  const target = await targetFrom(parsed);
  const result = await write(target, parsed, async (s) => {
    const ns = await existingCollection(s, raw, usage);
    const coll = s.client.db(ns.database).collection(ns.collection);
    const indexes = await coll.listIndexes().toArray();
    const index = indexes.find((i) => i["name"] === spec.name);
    if (index && spec.confirm) await coll.dropIndex(spec.name);
    return { ns, index, names: indexes.map((i) => String(i["name"])) };
  });
  if (!result.index) {
    return out(block({ index: { collection: nsText(result.ns), name: spec.name, result: "does not exist (no-op)" } }), helpBlock([`indexes: ${result.names.join("; ")}`]));
  }
  if (!spec.confirm) {
    return preview(target, {
      drop_index: `${spec.name} on ${nsText(result.ns)}`,
      keys: indexKeys(result.index),
      risk: `queries that use it fall back to a collection scan${result.index["unique"] ? "; duplicates are no longer rejected" : ""}`,
    });
  }
  return block({ index: { collection: nsText(result.ns), name: spec.name, result: "dropped" } });
}

export async function indexCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub === "create") {
    const command = "mongo-rw-axi index create";
    const usage = `${command} <collection> <keys>`;
    const parsed = parseArgs(
      rest,
      [...CONNECTION_FLAGS, { name: "--name" }, { name: "--unique", boolean: true }, { name: "--sparse", boolean: true }, { name: "--ttl" }, { name: "--partial" }],
      command,
    );
    const [raw, keysText, extra] = parsed.positionals;
    if (!raw || keysText === undefined || extra !== undefined) throw usageError(extra !== undefined ? `unexpected argument '${extra}'` : "missing argument", [`usage: ${usage}`]);
    const options: CreateIndexesOptions = {};
    const name = flag(parsed, "--name");
    if (name) options.name = name;
    if (bool(parsed, "--unique")) options.unique = true;
    if (bool(parsed, "--sparse")) options.sparse = true;
    if (flag(parsed, "--ttl") !== undefined) options.expireAfterSeconds = intFlag(parsed, "--ttl", 0, { min: 0, max: 2_147_483_647 });
    const partial = flag(parsed, "--partial");
    if (partial !== undefined) options.partialFilterExpression = parseDocument(partial, "--partial");
    return executeIndexCreate(parsed, raw, { keys: indexKeysInput(parseDocument(keysText, "keys")), options }, usage);
  }
  if (sub === "drop") {
    const command = "mongo-rw-axi index drop";
    const usage = `${command} <collection> <name>`;
    const parsed = parseArgs(rest, [...CONNECTION_FLAGS, CONFIRM_FLAG], command);
    const [raw, name, extra] = parsed.positionals;
    if (!raw || name === undefined || extra !== undefined) throw usageError(extra !== undefined ? `unexpected argument '${extra}'` : "missing argument", [`usage: ${usage}`, "`mongo-rw-axi indexes <collection>` lists the names"]);
    return executeIndexDrop(parsed, raw, { name, confirm: bool(parsed, "--confirm") }, usage);
  }
  throw usageError(sub ? `unknown index subcommand '${sub}'` : "missing index subcommand", ["subcommands: create, drop"]);
}

// --- collection ---

export const COLLECTION_HELP = `usage: mongo-rw-axi collection <create|drop|rename> <name> [args] [flags]
WRITES. create is idempotent; drop previews until --confirm; rename previews until --confirm when the new name exists (it would be replaced).
flags{create}:
  --validator <doc>, --capped <bytes>, --max <docs> (with --capped), --view-on <collection> --pipeline <stages>, ${CONNECTION_FLAGS_HELP}
flags{drop,rename}:
  --confirm, ${CONNECTION_FLAGS_HELP}
examples:
  mongo-rw-axi collection create audit_log --capped 10485760
  mongo-rw-axi collection create customers --validator '{$jsonSchema: {required: ["email"]}}'
  mongo-rw-axi collection create paid_orders --view-on orders --pipeline '[{$match: {status: "paid"}}]'
  mongo-rw-axi collection rename orders_tmp orders --confirm
  mongo-rw-axi collection drop orders_tmp --confirm
`;

export async function executeCollectionDrop(parsed: ParsedArgs, raw: string, confirm: boolean, usage: string): Promise<string> {
  const target = await targetFrom(parsed);
  const result = await write(target, parsed, async (s) => {
    const ns = await existingCollection(s, raw, usage).catch((error: { code?: string }) => {
      if (error.code === "NOT_FOUND") return undefined;
      throw error;
    });
    if (!ns) return { missing: true } as const;
    const info = (await s.client.db(ns.database).listCollections({ name: ns.collection }).toArray())[0];
    const view = info?.type === "view";
    const st = view ? undefined : await storageStats(s, ns);
    if (confirm) await s.client.db(ns.database).collection(ns.collection).drop();
    return { ns, view, st, dropped: confirm } as const;
  });
  if ("missing" in result) return block({ collection: { name: raw, result: "does not exist (no-op)" } });
  if (!result.dropped) {
    const what = result.view ? "the view definition (no data)" : result.st ? `${result.st.count} documents and ${result.st.nindexes} indexes (${humanBytes(result.st.storageSize + result.st.totalIndexSize)})` : "the collection, its documents and indexes";
    return preview(target, { drop: nsText(result.ns), risk: `irreversible - deletes ${what}` });
  }
  return block({ collection: { name: nsText(result.ns), result: result.view ? "dropped (view)" : `dropped${result.st ? ` (${result.st.count} documents)` : ""}` } });
}

export async function executeRename(parsed: ParsedArgs, raw: string, to: string, confirm: boolean, usage: string): Promise<string> {
  const target = await targetFrom(parsed);
  const result = await write(target, parsed, async (s) => {
    const ns = await existingCollection(s, raw, usage);
    const dest = newNamespace({ ...s.target, database: ns.database }, to, usage);
    const taken = ((await collectionNames(s, ns.database)) ?? []).includes(dest.collection);
    if (taken && !confirm) return { ns, dest, gated: true } as const;
    await s.client.db(ns.database).collection(ns.collection).rename(dest.collection, { dropTarget: taken });
    return { ns, dest, replaced: taken } as const;
  });
  if ("gated" in result) return preview(target, { rename: `${nsText(result.ns)} -> ${nsText(result.dest)}`, risk: `irreversible - ${nsText(result.dest)} exists and is dropped first` });
  return block({ collection: { name: nsText(result.ns), result: `renamed to ${result.dest.collection}${result.replaced ? " (the old one was dropped)" : ""}` } });
}

async function collectionCreate(args: string[]): Promise<string> {
  const command = "mongo-rw-axi collection create";
  const usage = `${command} <name>`;
  const parsed = parseArgs(args, [...CONNECTION_FLAGS, { name: "--validator" }, { name: "--capped" }, { name: "--max" }, { name: "--view-on" }, { name: "--pipeline" }], command);
  const [raw, extra] = parsed.positionals;
  if (!raw || extra !== undefined) throw usageError(extra !== undefined ? `unexpected argument '${extra}'` : "missing argument", [`usage: ${usage}`]);
  const options: Document = {};
  const validator = flag(parsed, "--validator");
  if (validator !== undefined) {
    options["validator"] = parseDocument(validator, "--validator");
    assertNoCode("--validator", options["validator"]);
  }
  if (flag(parsed, "--capped") !== undefined) Object.assign(options, { capped: true, size: intFlag(parsed, "--capped", 0, { min: 4096, max: Number.MAX_SAFE_INTEGER }) });
  if (flag(parsed, "--max") !== undefined) {
    if (!options["capped"]) throw usageError("--max needs --capped <bytes>");
    options["max"] = intFlag(parsed, "--max", 0, { min: 1, max: Number.MAX_SAFE_INTEGER });
  }
  const viewOn = flag(parsed, "--view-on");
  const pipeline = flag(parsed, "--pipeline");
  if ((viewOn === undefined) !== (pipeline === undefined)) throw usageError("a view needs both --view-on <collection> and --pipeline <stages>");
  if (viewOn !== undefined) Object.assign(options, { viewOn, pipeline: readPipeline(pipeline!, "--pipeline") });

  const target = await targetFrom(parsed);
  const result = await write(target, parsed, async (s) => {
    const ns = newNamespace(s.target, raw, usage);
    if (((await collectionNames(s, ns.database)) ?? []).includes(ns.collection)) return { ns, created: false };
    await s.client.db(ns.database).createCollection(ns.collection, options);
    return { ns, created: true };
  });
  return out(
    block({ collection: { name: nsText(result.ns), kind: viewOn ? "view" : options["capped"] ? "capped" : "collection", result: result.created ? "created" : "already exists (no-op)" } }),
    helpBlock(result.created ? [] : [`Run \`mongo-rw-axi describe ${raw}\` to see its options`]),
  );
}

export async function collectionCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub === "create") return collectionCreate(rest);
  if (sub === "drop" || sub === "rename") {
    const command = `mongo-rw-axi collection ${sub}`;
    const usage = sub === "drop" ? `${command} <name>` : `${command} <name> <new name>`;
    const parsed = parseArgs(rest, [...CONNECTION_FLAGS, CONFIRM_FLAG], command);
    const want = sub === "drop" ? 1 : 2;
    if (parsed.positionals.length !== want) throw usageError(parsed.positionals.length < want ? "missing argument" : `unexpected argument '${parsed.positionals[want]}'`, [`usage: ${usage}`]);
    const [raw, to] = parsed.positionals as [string, string];
    return sub === "drop" ? executeCollectionDrop(parsed, raw, bool(parsed, "--confirm"), usage) : executeRename(parsed, raw, to, bool(parsed, "--confirm"), usage);
  }
  throw usageError(sub ? `unknown collection subcommand '${sub}'` : "missing collection subcommand", ["subcommands: create, drop, rename"]);
}

// --- db ---

export const DB_HELP = `usage: mongo-rw-axi db drop <name> [flags]
WRITES. Drops a database; previews until --confirm. admin, local and config are always refused.
MongoDB creates a database with its first collection: \`mongo-rw-axi collection create <name> -d <database>\`.
flags:
  --confirm, -p/--profile <name>
examples:
  mongo-rw-axi db drop shop_test --confirm
`;

export async function dbCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub !== "drop") throw usageError(sub ? `unknown db subcommand '${sub}'` : "missing db subcommand", ["subcommands: drop (a database is created with its first collection)"]);
  const command = "mongo-rw-axi db drop";
  const parsed = parseArgs(rest, [PROFILE_FLAG, CONFIRM_FLAG], command);
  if (parsed.positionals.length !== 1) throw usageError(parsed.positionals.length === 0 ? "missing argument" : `unexpected argument '${parsed.positionals[1]}'`, [`usage: ${command} <name>`]);
  const name = validDatabase(parsed.positionals[0]!);
  if (PROTECTED_DATABASES.has(name.toLowerCase())) throw axiError(`refusing to drop '${name}' - it belongs to the server`, "FORBIDDEN");
  assertWritable(name);
  const confirm = bool(parsed, "--confirm");
  const target = await targetFrom(parsed);
  const result = await write(target, parsed, async (s) => {
    const listed = await s.client.db("admin").admin().listDatabases({ nameOnly: false, filter: { name } });
    const info = listed.databases.find((d) => d.name === name);
    if (!info) return { exists: false } as const;
    const collections = (await collectionNames(s, name))?.filter((c) => !c.startsWith("system.")).length ?? 0;
    if (confirm) await s.client.db(name).dropDatabase();
    return { exists: true, collections, size: humanBytes(info.sizeOnDisk ?? 0) } as const;
  });
  if (!result.exists) return block({ db: { name, result: "does not exist (no-op)" } });
  if (!confirm) return preview(target, { drop_database: name, risk: `irreversible - deletes ${result.collections} collections (${result.size})` });
  return block({ db: { name, result: `dropped (${result.collections} collections; ${result.size})` } });
}
