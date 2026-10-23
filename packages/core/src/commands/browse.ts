import type { Document } from "mongodb";
import { bool, enumFlag, expectPositionals, flag, intFlag, parseArgs, parseFields } from "../args.js";
import type { Session } from "../connection.js";
import { axiError, usageError } from "../errors.js";
import { assertReadableCollection } from "../guard.js";
import { block, fenced, helpBlock, humanBytes, out, type Obj } from "../render.js";
import { inferSchema, isMixed } from "../schema.js";
import { followUp, rerunHint } from "../hints.js";
import { tool } from "../tool.js";
import { keysText, shellText } from "../values.js";
import {
  CONNECTION_FLAGS,
  CONNECTION_FLAGS_HELP,
  collectionNames,
  MAX_DOCS,
  PROFILE_FLAG,
  read,
  requireDatabase,
  resolveCollection,
  targetFrom,
  TIMEOUT_FLAG,
  type Namespace,
} from "./common.js";

const SYSTEM_DATABASES = new Set(["admin", "local", "config"]);
const n = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));

/** At most `width` promises at a time, results in input order. */
async function mapLimit<T, R>(items: readonly T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return results;
}

export interface StorageStats {
  count: number;
  size: number;
  storageSize: number;
  totalIndexSize: number;
  nindexes: number;
  indexSizes: Record<string, number>;
  capped: boolean;
}

/** `$collStats` storage numbers, summed over shards; undefined for views or without the privilege. */
export async function storageStats(s: Session, ns: Namespace): Promise<StorageStats | undefined> {
  try {
    const rows = await s.client
      .db(ns.database)
      .collection(ns.collection)
      .aggregate([{ $collStats: { storageStats: {} } }], { maxTimeMS: s.timeoutMs })
      .toArray();
    if (rows.length === 0) return undefined;
    const total: StorageStats = { count: 0, size: 0, storageSize: 0, totalIndexSize: 0, nindexes: 0, indexSizes: {}, capped: false };
    for (const row of rows) {
      const st = (row["storageStats"] ?? {}) as Document;
      total.count += n(st["count"]);
      total.size += n(st["size"]);
      total.storageSize += n(st["storageSize"]);
      total.totalIndexSize += n(st["totalIndexSize"]);
      total.nindexes = Math.max(total.nindexes, n(st["nindexes"]));
      total.capped ||= Boolean(st["capped"]);
      for (const [name, size] of Object.entries((st["indexSizes"] ?? {}) as Record<string, unknown>)) total.indexSizes[name] = (total.indexSizes[name] ?? 0) + n(size);
    }
    return total;
  } catch {
    return undefined;
  }
}

// --- databases ---

export const databasesHelp = (): string => `usage: ${tool().name} databases [flags]
Databases with collection counts and on-disk size.
flags:
  --all (include admin, local, config), --limit <n> (default 100), -p/--profile <name>, --timeout <seconds> (default 30)
examples:
  ${tool().name} databases
  ${tool().name} databases --all
`;

export async function databasesCommand(args: string[]): Promise<string> {
  const command = `${tool().name} databases`;
  const parsed = parseArgs(args, [PROFILE_FLAG, { name: "--all", boolean: true }, { name: "--limit" }, TIMEOUT_FLAG], command);
  expectPositionals(parsed, 0, command);
  const limit = intFlag(parsed, "--limit", 100, { min: 1, max: 10_000 });
  const all = bool(parsed, "--all");
  const target = await targetFrom(parsed);
  const { rows, hidden } = await read(target, parsed, async (s) => {
    const listed = await s.client.db("admin").admin().listDatabases({ nameOnly: false, authorizedDatabases: true });
    const dbs = listed.databases.filter((d) => all || !SYSTEM_DATABASES.has(d.name)).sort((a, b) => a.name.localeCompare(b.name));
    const shown = dbs.slice(0, limit);
    const counts = await mapLimit(shown, 8, async (d) => (await collectionNames(s, d.name))?.filter((c) => all || !c.startsWith("system.")).length);
    return {
      rows: shown.map((d, i) => ({ name: d.name, collections: counts[i] ?? null, size: humanBytes(n(d.sizeOnDisk)) })),
      hidden: { system: listed.databases.length - dbs.length, cut: dbs.length - shown.length },
    };
  });
  const summary: Obj = {};
  if (target.database) summary["default"] = target.database;
  if (hidden.system > 0) summary["hidden"] = `${hidden.system} system databases (--all)`;
  return out(
    rows.length > 0 ? block({ databases: rows }) : block({ databases: "none visible to this account" }),
    Object.keys(summary).length > 0 && block(summary),
    helpBlock([...(hidden.cut > 0 ? [`Showing ${limit} of ${limit + hidden.cut} - ${rerunHint({ "--limit": String(limit + hidden.cut) }, "to list all")}`] : []), `Run \`${followUp("collections -d <database>", { database: false })}\` to list its collections`]),
  );
}

// --- collections ---

const COLLECTION_FIELDS = ["data_size", "storage_size", "index_size", "indexes", "avg_doc", "validator"] as const;

export const collectionsHelp = (): string => `usage: ${tool().name} collections [-d <database>] [flags]
Collections and views of one database with document counts and on-disk size (storage + indexes).
flags:
  ${CONNECTION_FLAGS_HELP}, --sort name|size|docs (default name), --limit <n> (default 200), --fields <${COLLECTION_FIELDS.join(",")}>, --all (include system.*), --timeout <seconds>
examples:
  ${tool().name} collections
  ${tool().name} collections -d shop --sort size --limit 10
  ${tool().name} collections --fields index_size,validator
`;

export async function collectionsCommand(args: string[]): Promise<string> {
  const command = `${tool().name} collections`;
  const parsed = parseArgs(
    args,
    [...CONNECTION_FLAGS, TIMEOUT_FLAG, { name: "--sort" }, { name: "--limit" }, { name: "--fields" }, { name: "--all", boolean: true }],
    command,
  );
  expectPositionals(parsed, 0, `${command} [-d <database>]`);
  const sort = enumFlag(parsed, "--sort", ["name", "size", "docs"] as const, "name");
  const limit = intFlag(parsed, "--limit", 200, { min: 1, max: 10_000 });
  const fields = parseFields(flag(parsed, "--fields"), COLLECTION_FIELDS);
  const target = await targetFrom(parsed);
  const database = requireDatabase(target, `${command} -d <database>`);
  const all = bool(parsed, "--all");
  const { infos, stats, exists } = await read(target, parsed, async (s) => {
    const infos = (await s.client.db(database).listCollections({}, { authorizedCollections: true }).toArray()).filter(
      (c) => all || !c.name.startsWith("system."),
    );
    const stats = await mapLimit(infos, 8, (c) => (c.type === "collection" ? storageStats(s, { database, collection: c.name }) : Promise.resolve(undefined)));
    const exists = infos.length > 0 || (await s.client.db("admin").admin().listDatabases({ nameOnly: true, authorizedDatabases: true })).databases.some((d) => d.name === database);
    return { infos, stats, exists };
  });
  if (!exists) throw axiError(`database '${database}' not found`, "NOT_FOUND", [`Run \`${followUp("databases", { database: false })}\``]);

  const rows = infos.map((c, i) => {
    const st = stats[i];
    const options = ("options" in c ? (c.options ?? {}) : {}) as Document;
    const kind = c.type === "view" ? "view" : c.type === "timeseries" ? "timeseries" : st?.capped || options["capped"] ? "capped" : "collection";
    return { info: c, st, kind, onDisk: st ? st.storageSize + st.totalIndexSize : 0, options };
  });
  const sorted = [...rows].sort((a, b) =>
    sort === "size" ? b.onDisk - a.onDisk : sort === "docs" ? n(b.st?.count) - n(a.st?.count) : a.info.name.localeCompare(b.info.name),
  );
  const extras: Record<(typeof COLLECTION_FIELDS)[number], (r: (typeof rows)[number]) => unknown> = {
    data_size: (r) => (r.st ? humanBytes(r.st.size) : null),
    storage_size: (r) => (r.st ? humanBytes(r.st.storageSize) : null),
    index_size: (r) => (r.st ? humanBytes(r.st.totalIndexSize) : null),
    indexes: (r) => (r.st ? r.st.nindexes : null),
    avg_doc: (r) => (r.st && r.st.count > 0 ? humanBytes(Math.round(r.st.size / r.st.count)) : null),
    validator: (r) => (r.options["validator"] ? "yes" : null),
  };
  const list = sorted.slice(0, limit).map((r) => {
    const row: Obj = { name: r.info.name, kind: r.kind, docs: r.st ? r.st.count : null, size: r.st ? humanBytes(r.onDisk) : null };
    for (const field of fields) row[field] = extras[field as (typeof COLLECTION_FIELDS)[number]](r);
    return row;
  });
  const views = rows.filter((r) => r.kind === "view").length;
  const total = rows.reduce((sum, r) => sum + r.onDisk, 0);
  const help = [`Run \`${followUp("describe <collection>")}\` to see its fields and indexes`];
  if (rows.length > limit) help.unshift(`Showing ${limit} of ${rows.length} - ${rerunHint({ "--limit": String(rows.length) }, "to list all")}`);
  if (rows.some((r) => r.kind !== "view" && !r.st)) help.push("Counts and sizes need the collStats privilege (the read role has it)");
  return out(
    block({ database, total: `${rows.length - views} collections; ${views} views; ${humanBytes(total)}` }),
    list.length > 0 ? block({ collections: list }) : block({ collections: "none" }),
    helpBlock(help),
  );
}

// --- search ---

export const searchHelp = (): string => `usage: ${tool().name} search <text> [flags]
Databases, collections and field paths whose name contains <text>, case-insensitive. Fields come from a small sample of each collection.
flags:
  ${CONNECTION_FLAGS_HELP} (search one database), --limit <n> (per list; default 50), --sample <n> (docs per collection; default 20; 0 skips fields), --all (include admin, local, config), --timeout <seconds>
examples:
  ${tool().name} search voucher
  ${tool().name} search email -d shop
`;

const MAX_SEARCH_COLLECTIONS = 200;

export async function searchCommand(args: string[]): Promise<string> {
  const command = `${tool().name} search`;
  const parsed = parseArgs(args, [...CONNECTION_FLAGS, TIMEOUT_FLAG, { name: "--limit" }, { name: "--sample" }, { name: "--all", boolean: true }], command);
  const [text] = expectPositionals(parsed, 1, `${command} <text>`);
  if (text!.trim() === "") throw usageError("the search text is empty", [`usage: ${command} <text>`]);
  const needle = text!.toLowerCase();
  const limit = intFlag(parsed, "--limit", 50, { min: 1, max: MAX_DOCS });
  const sample = intFlag(parsed, "--sample", 20, { min: 0, max: 100 });
  const target = await targetFrom(parsed);
  // An explicit -d searches that database; the profile's default database does not narrow the search.
  const only = flag(parsed, "--database");
  const all = bool(parsed, "--all");
  const result = await read(target, parsed, async (s) => {
    const dbNames = only
      ? [only]
      : (await s.client.db("admin").admin().listDatabases({ nameOnly: true, authorizedDatabases: true })).databases.map((d) => d.name).filter((d) => all || !SYSTEM_DATABASES.has(d));
    const perDb = await mapLimit(dbNames, 8, async (database) => ({ database, names: (await collectionNames(s, database)) ?? [] }));
    const namespaces = perDb.flatMap(({ database, names }) => names.filter((c) => !c.startsWith("system.")).map((collection) => ({ database, collection })));
    const scanned = namespaces.slice(0, MAX_SEARCH_COLLECTIONS);
    const fields =
      sample === 0
        ? []
        : (
            await mapLimit(scanned, 8, async (ns) => {
              try {
                const docs = await s.client.db(ns.database).collection(ns.collection).aggregate([{ $sample: { size: sample } }], { maxTimeMS: s.timeoutMs }).toArray();
                return inferSchema(docs)
                  .fields.filter((f) => f.path.toLowerCase().includes(needle))
                  .map((f) => ({ collection: `${ns.database}.${ns.collection}`, path: f.path, types: f.types.join("|") }));
              } catch {
                return [];
              }
            })
          ).flat();
    return { dbNames, namespaces, fields, skipped: namespaces.length - scanned.length };
  });
  const databases = result.dbNames.filter((d) => d.toLowerCase().includes(needle));
  const collections = result.namespaces.filter((ns) => ns.collection.toLowerCase().includes(needle));
  if (databases.length === 0 && collections.length === 0 && result.fields.length === 0) {
    return out(
      block({ matches: `none - no database; collection or sampled field name contains '${text}'${only ? ` in ${only}` : ""}` }),
      helpBlock([only ? "Drop -d to search every database" : "Try a shorter or different part of the name", ...(sample > 0 ? ["Fields come from a sample - raise --sample for rare fields"] : [])]),
    );
  }
  const more = (count: number, what: string) => (count > limit ? [`More than ${limit} ${what} match - use a longer text, -d <database> or raise --limit`] : []);
  return out(
    databases.length > 0 && block({ databases: databases.slice(0, limit) }),
    collections.length > 0 && block({ collections: collections.slice(0, limit).map((ns) => ({ database: ns.database, name: ns.collection })) }),
    result.fields.length > 0 && block({ fields: result.fields.slice(0, limit) }),
    helpBlock([
      ...more(collections.length, "collections"),
      ...more(result.fields.length, "fields"),
      ...(result.skipped > 0 ? [`Fields were sampled from the first ${MAX_SEARCH_COLLECTIONS} collections - pass -d to narrow`] : []),
      `Run \`${followUp("describe <database>.<collection>", { database: false })}\` for its fields and indexes`,
    ]),
  );
}

// --- describe ---

const MAX_DESCRIBE = 20;

export const describeHelp = (): string => `usage: ${tool().name} describe <collection>... [flags]
Fields inferred from a random sample (path, types, % of docs that have it), indexes, validator, and view/capped/timeseries options.
Several collections (up to ${MAX_DESCRIBE}) are described in one call. <database>.<collection> works without -d.
flags:
  ${CONNECTION_FLAGS_HELP}, --sample <n> (docs; default 100; max ${MAX_DOCS}), --timeout <seconds>
examples:
  ${tool().name} describe orders
  ${tool().name} describe shop.orders shop.customers --sample 500
`;

export function indexOptions(index: Document): string | null {
  const parts: string[] = [];
  if (index["unique"]) parts.push("unique");
  if (index["sparse"]) parts.push("sparse");
  if (index["hidden"]) parts.push("hidden");
  if (index["expireAfterSeconds"] !== undefined) parts.push(`ttl ${n(index["expireAfterSeconds"])}s`);
  if (index["partialFilterExpression"]) parts.push(`partial ${shellText(index["partialFilterExpression"])}`);
  if (index["collation"]) parts.push(`collation ${String((index["collation"] as Document)["locale"])}`);
  if (index["weights"]) parts.push(`text ${Object.keys(index["weights"] as Document).join(" ")}`);
  return parts.length > 0 ? parts.join("; ") : null;
}

/** Text indexes list their fields under weights; their key is `_fts text`. */
export const indexKeys = (index: Document): string => keysText((index["key"] ?? {}) as Record<string, unknown>);

async function describeIn(s: Session, raw: string, sampleSize: number, usage: string) {
  const ns = await resolveCollection(s, raw, usage);
  const db = s.client.db(ns.database);
  const [info] = await db.listCollections({ name: ns.collection }, { authorizedCollections: true }).toArray();
  const view = info?.type === "view";
  const coll = db.collection(ns.collection);
  const [docs, indexes, st] = await Promise.all([
    coll.aggregate([{ $sample: { size: sampleSize } }], { maxTimeMS: s.timeoutMs, promoteValues: false }).toArray(),
    view ? Promise.resolve([]) : coll.listIndexes().toArray(),
    view ? Promise.resolve(undefined) : storageStats(s, ns),
  ]);
  return { ns, info, view, schema: inferSchema(docs), indexes, st };
}

type DescribeResult = Awaited<ReturnType<typeof describeIn>>;

function renderDescribe(r: DescribeResult): string {
  const options = (r.info && "options" in r.info ? (r.info.options ?? {}) : {}) as Document;
  const header: Obj = { name: `${r.ns.database}.${r.ns.collection}` };
  if (r.view) Object.assign(header, { kind: "view", view_on: options["viewOn"] });
  else if (r.info?.type === "timeseries") header["kind"] = "timeseries";
  else if (options["capped"]) header["kind"] = "capped";
  if (r.st) Object.assign(header, { docs: r.st.count, size: humanBytes(r.st.storageSize + r.st.totalIndexSize) });
  header["sampled"] = r.schema.sampled;
  const ts = options["timeseries"] as Document | undefined;
  if (ts) header["timeseries"] = `time ${String(ts["timeField"])}${ts["metaField"] ? `; meta ${String(ts["metaField"])}` : ""}${ts["granularity"] ? `; ${String(ts["granularity"])}` : ""}`;
  if (options["capped"]) header["capped"] = `${options["max"] ? `max ${n(options["max"])} docs; ` : ""}${humanBytes(n(options["size"]))}`;
  if (options["collation"]) header["collation"] = String((options["collation"] as Document)["locale"]);
  if (options["validationLevel"] || options["validationAction"]) header["validation"] = `${String(options["validationLevel"] ?? "strict")}; ${String(options["validationAction"] ?? "error")}`;

  const pct = (docs: number): number => (r.schema.sampled === 0 ? 0 : Math.round((docs / r.schema.sampled) * 100));
  const mixed = r.schema.fields.filter((f) => isMixed(f.types));
  const help: string[] = [];
  if (r.schema.sampled === 0) help.push("The collection is empty - no fields to infer");
  if (r.schema.omitted > 0) help.push(`More than ${r.schema.fields.length} field paths - the rest were not listed`);
  if (mixed.length > 0) help.push(`Mixed types (${mixed.slice(0, 3).map((f) => `${f.path} ${f.types.join("|")}`).join("; ")}) - a filter on one type misses the others`);
  return out(
    block({ collection: header }),
    r.schema.fields.length > 0 && block({ fields: r.schema.fields.map((f) => ({ path: f.path, types: f.types.join("|"), pct: pct(f.docs) })) }),
    r.indexes.length > 0 && block({ indexes: r.indexes.map((i) => ({ name: i["name"], keys: indexKeys(i), options: indexOptions(i) })) }),
    options["validator"] !== undefined && fenced("validator", shellText(options["validator"])),
    r.view && fenced("pipeline", shellText(options["pipeline"] ?? [])),
    helpBlock(help),
  );
}

export async function describeCommand(args: string[]): Promise<string> {
  const command = `${tool().name} describe`;
  const parsed = parseArgs(args, [...CONNECTION_FLAGS, TIMEOUT_FLAG, { name: "--sample" }], command);
  if (parsed.positionals.length === 0) throw usageError("missing argument", [`usage: ${command} <collection>...`]);
  if (parsed.positionals.length > MAX_DESCRIBE) throw usageError(`describe takes at most ${MAX_DESCRIBE} collections per call`);
  for (const raw of parsed.positionals) assertReadableCollection(raw);
  const sampleSize = intFlag(parsed, "--sample", 100, { min: 1, max: MAX_DOCS });
  const target = await targetFrom(parsed);
  const usage = `${command} <collection>`;
  if (parsed.positionals.length === 1) {
    return renderDescribe(await read(target, parsed, (s) => describeIn(s, parsed.positionals[0]!, sampleSize, usage)));
  }
  const results = await read(target, parsed, async (s) => {
    const all: Array<DescribeResult | { raw: string; error: string; hint?: string }> = [];
    for (const raw of parsed.positionals) {
      try {
        all.push(await describeIn(s, raw, sampleSize, usage));
      } catch (error) {
        const e = error as { message?: string; suggestions?: string[] };
        all.push({ raw, error: e.message ?? String(error), ...(e.suggestions?.[0] ? { hint: e.suggestions[0] } : {}) });
      }
    }
    return all;
  });
  return out(...results.map((r) => ("error" in r ? block({ collection: { name: r.raw, status: r.error, ...(r.hint ? { hint: r.hint } : {}) } }) : renderDescribe(r))));
}

// --- indexes ---

export const indexesHelp = (): string => `usage: ${tool().name} indexes <collection> [flags]
Indexes with keys, options, size and how often each was used since the server started ($indexStats; needs the indexStats privilege).
flags:
  ${CONNECTION_FLAGS_HELP}, --timeout <seconds>
examples:
  ${tool().name} indexes orders
`;

export async function indexesCommand(args: string[]): Promise<string> {
  const command = `${tool().name} indexes`;
  const parsed = parseArgs(args, [...CONNECTION_FLAGS, TIMEOUT_FLAG], command);
  const [raw] = expectPositionals(parsed, 1, `${command} <collection>`);
  assertReadableCollection(raw!);
  const target = await targetFrom(parsed);
  const result = await read(target, parsed, async (s) => {
    const ns = await resolveCollection(s, raw!, `${command} <collection>`);
    const coll = s.client.db(ns.database).collection(ns.collection);
    const indexes = await coll.listIndexes().toArray();
    const st = await storageStats(s, ns);
    let usage: Map<string, { ops: number; since: unknown }> | undefined;
    try {
      const rows = await coll.aggregate([{ $indexStats: {} }], { maxTimeMS: s.timeoutMs }).toArray();
      usage = new Map();
      for (const row of rows) {
        const name = String(row["name"]);
        const accesses = (row["accesses"] ?? {}) as Document;
        const prev = usage.get(name);
        usage.set(name, { ops: (prev?.ops ?? 0) + n(accesses["ops"]), since: prev?.since ?? accesses["since"] });
      }
    } catch {
      usage = undefined;
    }
    return { ns, indexes, st, usage };
  });
  const rows = result.indexes.map((i) => {
    const name = String(i["name"]);
    const row: Obj = { name, keys: indexKeys(i), options: indexOptions(i) };
    if (result.st) row["size"] = humanBytes(result.st.indexSizes[name] ?? 0);
    if (result.usage) row["ops"] = result.usage.get(name)?.ops ?? 0;
    return row;
  });
  const unused = result.usage ? rows.filter((r) => r["ops"] === 0 && r["name"] !== "_id_").map((r) => String(r["name"])) : [];
  const since = result.usage ? [...result.usage.values()].map((u) => u.since).find((v) => v instanceof Date) : undefined;
  return out(
    block({ indexes: rows }),
    since instanceof Date && block({ ops_since: since.toISOString().replace(".000Z", "Z") }),
    helpBlock([
      ...(unused.length > 0 ? [`Unused since the last restart: ${unused.join("; ")} - check every app path before dropping one`] : []),
      ...(result.usage ? [] : ["Usage counts need the indexStats privilege (clusterMonitor role)"]),
    ]),
  );
}
