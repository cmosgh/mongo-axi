import type { Collection, Document } from "mongodb";
import { bool, expectPositionals, flag, intFlag, parseArgs, type ParsedArgs } from "../args.js";
import type { Session } from "../connection.js";
import { axiError, usageError } from "../errors.js";
import { assertReadableCollection, assertReadInput } from "../guard.js";
import { isPlainObject, parseDocument, parsePipeline, parseValue } from "../literal.js";
import { block, fenced, helpBlock, out, type Obj } from "../render.js";
import { tool } from "../tool.js";
import { displayDoc, display, keysText, shellText } from "../values.js";
import { CONNECTION_FLAGS, CONNECTION_FLAGS_HELP, inputText, MAX_DOCS, read, resolveCollection, targetFrom, TIMEOUT_FLAG, type Namespace } from "./common.js";

export const DEFAULT_LIMIT = 20;
const SLOW_MS = 1000;

const guardHint = (): { writeHint?: string } => (tool().writeHint ? { writeHint: tool().writeHint! } : {});

/** Parse one agent-supplied document and run the read guard on it, before connecting. */
export function readDoc(text: string | undefined, label: string): Document | undefined {
  if (text === undefined) return undefined;
  const value = parseDocument(text, label);
  assertReadInput(label, value, guardHint());
  return value;
}

export function readPipeline(text: string, label: string): Document[] {
  const stages = parsePipeline(text, label);
  assertReadInput(label, stages, guardHint());
  return stages;
}

/** A --sort / --hint value: a document, or an index name for --hint. */
function readHint(text: string | undefined): Document | string | undefined {
  if (text === undefined) return undefined;
  const value = parseValue(text, "--hint");
  if (typeof value === "string") return value;
  if (!isPlainObject(value)) throw usageError("--hint takes an index name or a key pattern such as {status: 1}");
  return value;
}

export interface FindSpec {
  filter: Document;
  projection?: Document;
  sort?: Document;
  skip?: number;
  limit: number;
  hint?: Document | string;
}

export interface Rows {
  docs: Document[];
  truncated: boolean;
  /** Matching documents past the cap: exact up to MAX_DOCS, else "more than". */
  total?: { docs: number; exact: boolean };
  elapsedMs: number;
}

export async function runFind(s: Session, ns: Namespace, spec: FindSpec): Promise<Rows> {
  const started = Date.now();
  const coll = s.client.db(ns.database).collection(ns.collection);
  const options = {
    maxTimeMS: s.timeoutMs,
    ...(spec.projection ? { projection: spec.projection } : {}),
    ...(spec.sort ? { sort: spec.sort } : {}),
    ...(spec.skip ? { skip: spec.skip } : {}),
    ...(spec.hint ? { hint: spec.hint } : {}),
  };
  const docs = await coll.find(spec.filter, { ...options, limit: spec.limit + 1, batchSize: spec.limit + 1 }).toArray();
  const truncated = docs.length > spec.limit;
  let total: Rows["total"];
  if (truncated) {
    const count = await coll.countDocuments(spec.filter, {
      maxTimeMS: s.timeoutMs,
      limit: MAX_DOCS + 1,
      ...(spec.skip ? { skip: spec.skip } : {}),
      ...(spec.hint ? { hint: spec.hint } : {}),
    });
    total = { docs: Math.min(count, MAX_DOCS + 1), exact: count <= MAX_DOCS };
  }
  return { docs: docs.slice(0, spec.limit), truncated, ...(total ? { total } : {}), elapsedMs: Date.now() - started };
}

export async function runAggregate(s: Session, coll: Collection, pipeline: Document[], limit: number): Promise<Rows> {
  const started = Date.now();
  const docs: Document[] = [];
  const cursor = coll.aggregate(pipeline, { maxTimeMS: s.timeoutMs, batchSize: limit + 1 });
  try {
    for await (const doc of cursor) {
      docs.push(doc);
      if (docs.length > limit) break;
    }
  } finally {
    await cursor.close().catch(() => {});
  }
  const truncated = docs.length > limit;
  let total: Rows["total"];
  if (truncated) {
    // $out/$merge are refused, so the pipeline never has a final stage these could not follow.
    const [row] = await coll.aggregate([...pipeline, { $limit: MAX_DOCS + 1 }, { $count: "n" }], { maxTimeMS: s.timeoutMs }).toArray();
    const count = Number(row?.["n"] ?? 0);
    total = { docs: Math.min(count, MAX_DOCS + 1), exact: count <= MAX_DOCS };
  }
  return { docs: docs.slice(0, limit), truncated, ...(total ? { total } : {}), elapsedMs: Date.now() - started };
}

function shownOf(rows: Rows, limit: number): string {
  const { total } = rows;
  if (!total) return `${rows.docs.length} shown - more exist (limit ${limit})`;
  return total.exact ? `${rows.docs.length} of ${total.docs} shown` : `${rows.docs.length} of more than ${MAX_DOCS} shown`;
}

/** What to do about a cut result; exact totals get the --limit that shows every document. */
export function truncationHelp(rows: Rows): string[] {
  if (!rows.truncated) return [];
  const { total } = rows;
  if (total?.exact) return [`Rerun with --limit ${total.docs} to see all, or narrow the filter`];
  return [`More than ${MAX_DOCS} match - aggregate ($group; $count) or narrow the filter`];
}

/** `result[N]` documents; a summary line only when cut, empty or slow. */
export function docsBlock(rows: Rows, full: boolean, limit: number): string {
  const summary: Obj = {};
  if (rows.truncated) summary["docs"] = shownOf(rows, limit);
  if (rows.docs.length === 0) summary["docs"] = 0;
  if (rows.elapsedMs >= SLOW_MS) summary["elapsed_ms"] = rows.elapsedMs;
  return out(Object.keys(summary).length > 0 && block(summary), rows.docs.length > 0 && block({ result: rows.docs.map((d) => displayDoc(d, { full })) }));
}

const emptyHelp = (collection: string, filtered: boolean): string[] =>
  filtered ? [`No document matches - \`${tool().name} describe ${collection}\` shows field names and types (a string never equals ISODate(...) or ObjectId(...))`] : [];

export const LIMIT_HELP = `--limit <n> (default ${DEFAULT_LIMIT}; max ${MAX_DOCS})`;

// --- sample ---

export const sampleHelp = (): string => `usage: ${tool().name} sample <collection> [flags]
The first documents in natural order, or a random sample with --random.
flags:
  ${CONNECTION_FLAGS_HELP}, --limit <n> (default 5; max ${MAX_DOCS}), --random, --full (no truncation of long strings, arrays and deep nesting), --timeout <seconds>
examples:
  ${tool().name} sample orders
  ${tool().name} sample shop.orders --random --limit 3 --full
`;

export async function sampleCommand(args: string[]): Promise<string> {
  const command = `${tool().name} sample`;
  const parsed = parseArgs(args, [...CONNECTION_FLAGS, TIMEOUT_FLAG, { name: "--limit" }, { name: "--random", boolean: true }, { name: "--full", boolean: true }], command);
  const [raw] = expectPositionals(parsed, 1, `${command} <collection>`);
  assertReadableCollection(raw!);
  const limit = intFlag(parsed, "--limit", 5, { min: 1, max: MAX_DOCS });
  const target = await targetFrom(parsed);
  const rows = await read(target, parsed, async (s) => {
    const ns = await resolveCollection(s, raw!, `${command} <collection>`);
    const coll = s.client.db(ns.database).collection(ns.collection);
    if (!bool(parsed, "--random")) return runFind(s, ns, { filter: {}, limit });
    const started = Date.now();
    const docs = await coll.aggregate([{ $sample: { size: limit } }], { maxTimeMS: s.timeoutMs }).toArray();
    return { docs, truncated: false, elapsedMs: Date.now() - started };
  });
  // The first N documents are a sample, not a cut result.
  return docsBlock({ ...rows, truncated: false }, bool(parsed, "--full"), limit);
}

// --- query ---

const QUERY_FLAGS = [
  ...CONNECTION_FLAGS,
  TIMEOUT_FLAG,
  { name: "--filter" },
  { name: "--project" },
  { name: "--sort" },
  { name: "--skip" },
  { name: "--limit" },
  { name: "--hint" },
  { name: "--file" },
  { name: "--full", boolean: true },
];

export const queryHelp = (): string => `usage: ${tool().name} query <collection> [filter] [flags]
Finds documents. The filter is JSON or mongosh syntax (unquoted keys, ObjectId('…'), ISODate('…'), /regex/i); nothing is evaluated.
\`${tool().name} 'db.orders.find({…}).sort({…}).limit(5)'\` is parsed (not run as JavaScript) into the same query.
Refused: $where, $function, $accumulator (server-side JavaScript) and system.users.
flags:
  ${CONNECTION_FLAGS_HELP}, --filter <json> (or the 2nd argument), --project <json>, --sort <json>, --skip <n>, ${LIMIT_HELP}, --hint <index name|keys>, --file <path> (filter from a file; - reads stdin), --full (no truncation), --timeout <seconds> (default 30)
examples:
  ${tool().name} query orders '{status: "paid", created_at: {$gte: ISODate("2026-10-01")}}' --sort '{created_at: -1}'
  ${tool().name} query orders '{_id: ObjectId("65f1a2b3c4d5e6f708192a3b")}' --full
  ${tool().name} query customers '{email: /@example\\.test$/i}' --project '{email: 1, name: 1}'
  ${tool().name} 'db.orders.find({status: "paid"}).sort({total: -1}).limit(5)'
`;

export async function queryCommand(args: string[]): Promise<string> {
  const command = `${tool().name} query`;
  const usage = `${command} <collection> [filter]`;
  const parsed = parseArgs(args, QUERY_FLAGS, command);
  if (parsed.positionals.length === 0) throw usageError("missing collection", [`usage: ${usage}`]);
  if (parsed.positionals.length > 2) throw usageError(`unexpected argument '${parsed.positionals[2]}' - quote the filter as one argument`, [`usage: ${usage}`]);
  const [raw, positionalFilter] = parsed.positionals;
  if (positionalFilter !== undefined && flag(parsed, "--filter") !== undefined) throw usageError("pass the filter as an argument or --filter, not both");
  const filter = readDoc(inputText(parsed, positionalFilter ?? flag(parsed, "--filter"), "filter", usage), "filter") ?? {};
  const spec: FindSpec = {
    filter,
    limit: intFlag(parsed, "--limit", DEFAULT_LIMIT, { min: 1, max: MAX_DOCS }),
    skip: intFlag(parsed, "--skip", 0, { min: 0, max: 1_000_000_000 }),
  };
  const projection = readDoc(flag(parsed, "--project"), "--project");
  const sort = readDoc(flag(parsed, "--sort"), "--sort");
  const hint = readHint(flag(parsed, "--hint"));
  if (projection) spec.projection = projection;
  if (sort) spec.sort = sort;
  if (hint) spec.hint = hint;
  return executeFind(parsed, raw!, spec, usage);
}

export async function executeFind(parsed: ParsedArgs, raw: string, spec: FindSpec, usage: string): Promise<string> {
  assertReadableCollection(raw);
  const target = await targetFrom(parsed);
  const rows = await read(target, parsed, async (s) => runFind(s, await resolveCollection(s, raw, usage), spec));
  return out(
    docsBlock(rows, bool(parsed, "--full"), spec.limit),
    helpBlock([...truncationHelp(rows), ...(rows.docs.length === 0 && spec.skip === 0 ? emptyHelp(raw, Object.keys(spec.filter).length > 0) : [])]),
  );
}

// --- count ---

export const countHelp = (): string => `usage: ${tool().name} count <collection> [filter] [flags]
Counts matching documents (countDocuments). --estimate reads the collection metadata instead (fast, no filter).
flags:
  ${CONNECTION_FLAGS_HELP}, --filter <json> (or the 2nd argument), --estimate, --hint <index name|keys>, --timeout <seconds>
examples:
  ${tool().name} count orders '{status: "paid"}'
  ${tool().name} count orders --estimate
`;

export async function countCommand(args: string[]): Promise<string> {
  const command = `${tool().name} count`;
  const usage = `${command} <collection> [filter]`;
  const parsed = parseArgs(args, [...CONNECTION_FLAGS, TIMEOUT_FLAG, { name: "--filter" }, { name: "--estimate", boolean: true }, { name: "--hint" }], command);
  if (parsed.positionals.length === 0 || parsed.positionals.length > 2) throw usageError(parsed.positionals.length === 0 ? "missing collection" : `unexpected argument '${parsed.positionals[2]}'`, [`usage: ${usage}`]);
  const [raw, positionalFilter] = parsed.positionals;
  const filter = readDoc(positionalFilter ?? flag(parsed, "--filter"), "filter");
  const estimate = bool(parsed, "--estimate");
  if (estimate && filter && Object.keys(filter).length > 0) throw usageError("--estimate counts the whole collection - drop the filter or --estimate");
  return executeCount(parsed, raw!, filter ?? {}, estimate, readHint(flag(parsed, "--hint")), usage);
}

export async function executeCount(parsed: ParsedArgs, raw: string, filter: Document, estimate: boolean, hint: Document | string | undefined, usage: string): Promise<string> {
  assertReadableCollection(raw);
  const target = await targetFrom(parsed);
  const count = await read(target, parsed, async (s) => {
    const ns = await resolveCollection(s, raw, usage);
    const coll = s.client.db(ns.database).collection(ns.collection);
    if (estimate) return coll.estimatedDocumentCount({ maxTimeMS: s.timeoutMs });
    return coll.countDocuments(filter, { maxTimeMS: s.timeoutMs, ...(hint ? { hint } : {}) });
  });
  return out(block({ count, ...(estimate ? { estimate: "from collection metadata" } : {}) }), helpBlock(count === 0 ? emptyHelp(raw, Object.keys(filter).length > 0) : []));
}

// --- distinct ---

export const distinctHelp = (): string => `usage: ${tool().name} distinct <collection> <field> [filter] [flags]
The distinct values of one field (dot paths reach into subdocuments and arrays).
flags:
  ${CONNECTION_FLAGS_HELP}, --filter <json> (or the 3rd argument), --limit <n> (values; default 50; max ${MAX_DOCS}), --full, --timeout <seconds>
examples:
  ${tool().name} distinct orders status
  ${tool().name} distinct orders items.sku '{status: "paid"}'
`;

export async function distinctCommand(args: string[]): Promise<string> {
  const command = `${tool().name} distinct`;
  const usage = `${command} <collection> <field> [filter]`;
  const parsed = parseArgs(args, [...CONNECTION_FLAGS, TIMEOUT_FLAG, { name: "--filter" }, { name: "--limit" }, { name: "--full", boolean: true }], command);
  if (parsed.positionals.length < 2 || parsed.positionals.length > 3) throw usageError(parsed.positionals.length < 2 ? "missing argument" : `unexpected argument '${parsed.positionals[3]}'`, [`usage: ${usage}`]);
  const [raw, field, positionalFilter] = parsed.positionals;
  const filter = readDoc(positionalFilter ?? flag(parsed, "--filter"), "filter") ?? {};
  const limit = intFlag(parsed, "--limit", 50, { min: 1, max: MAX_DOCS });
  return executeDistinct(parsed, raw!, field!, filter, limit, usage);
}

export async function executeDistinct(parsed: ParsedArgs, raw: string, field: string, filter: Document, limit: number, usage: string): Promise<string> {
  assertReadableCollection(raw);
  if (field.startsWith("$")) throw usageError(`the field is a name such as status or items.sku, not '${field}'`);
  const target = await targetFrom(parsed);
  const values = await read(target, parsed, async (s) => {
    const ns = await resolveCollection(s, raw, usage);
    return s.client.db(ns.database).collection(ns.collection).distinct(field, filter, { maxTimeMS: s.timeoutMs });
  });
  const shown = values.slice(0, limit).map((v) => display(v, { full: bool(parsed, "--full") }));
  return out(
    block({ field, distinct: values.length }),
    shown.length > 0 && block({ values: shown }),
    helpBlock([
      ...(values.length > limit ? [`${limit} of ${values.length} shown - raise --limit or group with aggregate ($group; $sortByCount)`] : []),
      ...(values.length === 0 ? emptyHelp(raw, true) : []),
    ]),
  );
}

// --- aggregate ---

export const aggregateHelp = (): string => `usage: ${tool().name} aggregate <collection> <pipeline> [flags]
Runs a read-only aggregation pipeline (JSON or mongosh syntax). $out and $merge (writes), $where/$function/$accumulator (server-side JavaScript) and $changeStream are refused.
flags:
  ${CONNECTION_FLAGS_HELP}, ${LIMIT_HELP}, --file <path> (pipeline from a file; - reads stdin), --full, --timeout <seconds> (default 30)
examples:
  ${tool().name} aggregate orders '[{$match: {status: "paid"}}, {$group: {_id: "$customer_id", total: {$sum: "$total"}}}, {$sort: {total: -1}}]'
  ${tool().name} aggregate orders '[{$lookup: {from: "customers", localField: "customer_id", foreignField: "_id", as: "c"}}, {$match: {c: {$size: 0}}}]'
  ${tool().name} aggregate orders --file report.json --limit 200
`;

export async function aggregateCommand(args: string[]): Promise<string> {
  const command = `${tool().name} aggregate`;
  const usage = `${command} <collection> <pipeline>`;
  const parsed = parseArgs(args, [...CONNECTION_FLAGS, TIMEOUT_FLAG, { name: "--limit" }, { name: "--file" }, { name: "--full", boolean: true }], command);
  if (parsed.positionals.length === 0 || parsed.positionals.length > 2) throw usageError(parsed.positionals.length === 0 ? "missing collection" : `unexpected argument '${parsed.positionals[2]}' - quote the pipeline as one argument`, [`usage: ${usage}`]);
  const [raw, positional] = parsed.positionals;
  const text = inputText(parsed, positional, "pipeline", usage);
  if (text === undefined) throw usageError("missing pipeline", [`usage: ${usage}`]);
  const pipeline = readPipeline(text, "pipeline");
  return executeAggregate(parsed, raw!, pipeline, intFlag(parsed, "--limit", DEFAULT_LIMIT, { min: 1, max: MAX_DOCS }), usage);
}

export async function executeAggregate(parsed: ParsedArgs, raw: string, pipeline: Document[], limit: number, usage: string): Promise<string> {
  assertReadableCollection(raw);
  const target = await targetFrom(parsed);
  const rows = await read(target, parsed, async (s) => {
    const ns = await resolveCollection(s, raw, usage);
    return runAggregate(s, s.client.db(ns.database).collection(ns.collection), pipeline, limit);
  });
  return out(docsBlock(rows, bool(parsed, "--full"), limit), helpBlock(truncationHelp(rows)));
}

// --- explain ---

export const explainHelp = (): string => `usage: ${tool().name} explain <collection> [filter] [flags]
The winning query plan as a tree: COLLSCAN reads every document, IXSCAN <index> uses one. --analyze runs the query (read-only, time-capped) and adds docs/keys examined and time.
flags:
  ${CONNECTION_FLAGS_HELP}, --filter <json> (or the 2nd argument), --sort <json>, --project <json>, --hint <index>, --pipeline <json> (explain an aggregation instead), --analyze, --timeout <seconds>
examples:
  ${tool().name} explain orders '{status: "paid", created_at: {$gte: ISODate("2026-10-01")}}'
  ${tool().name} explain orders '{customer_id: ObjectId("65f1a2b3c4d5e6f708192a3b")}' --sort '{created_at: -1}' --analyze
  ${tool().name} explain orders --pipeline '[{$match: {status: "paid"}}, {$group: {_id: "$customer_id", n: {$sum: 1}}}]'
`;

export interface ExplainSpec {
  filter?: Document;
  sort?: Document;
  projection?: Document;
  hint?: Document | string;
  pipeline?: Document[];
  analyze: boolean;
}

export async function explainCommand(args: string[]): Promise<string> {
  const command = `${tool().name} explain`;
  const usage = `${command} <collection> [filter]`;
  // --pipeline is declared here, so the args parser does not offer its positional hint.
  const parsed = parseArgs(
    args,
    [...CONNECTION_FLAGS, TIMEOUT_FLAG, { name: "--filter" }, { name: "--sort" }, { name: "--project" }, { name: "--hint" }, { name: "--pipeline" }, { name: "--analyze", boolean: true }],
    command,
  );
  if (parsed.positionals.length === 0 || parsed.positionals.length > 2) throw usageError(parsed.positionals.length === 0 ? "missing collection" : `unexpected argument '${parsed.positionals[2]}'`, [`usage: ${usage}`]);
  const [raw, positionalFilter] = parsed.positionals;
  const pipelineText = flag(parsed, "--pipeline");
  const filter = readDoc(positionalFilter ?? flag(parsed, "--filter"), "filter");
  if (pipelineText !== undefined && (filter || flag(parsed, "--sort") || flag(parsed, "--project"))) throw usageError("--pipeline explains an aggregation - put the filter in a $match stage");
  const spec: ExplainSpec = { analyze: bool(parsed, "--analyze") };
  if (pipelineText !== undefined) spec.pipeline = readPipeline(pipelineText, "--pipeline");
  else {
    spec.filter = filter ?? {};
    const sort = readDoc(flag(parsed, "--sort"), "--sort");
    const projection = readDoc(flag(parsed, "--project"), "--project");
    const hint = readHint(flag(parsed, "--hint"));
    if (sort) spec.sort = sort;
    if (projection) spec.projection = projection;
    if (hint) spec.hint = hint;
  }
  return executeExplain(parsed, raw!, spec, usage);
}

interface PlanSummary {
  lines: string[];
  stages: Set<string>;
  rejected: number;
}

/** A plan node's one-line label: stage, index and the parts that decide its cost. */
function nodeLabel(node: Document): string {
  const parts = [String(node["stage"] ?? "?")];
  if (node["indexName"]) parts.push(`${String(node["indexName"])} (${keysText((node["keyPattern"] ?? {}) as Record<string, unknown>)})`);
  if (node["direction"] === "backward") parts.push("backward");
  if (node["sortPattern"]) parts.push(`by ${keysText(node["sortPattern"] as Record<string, unknown>)}`);
  if (node["limitAmount"] !== undefined) parts.push(String(node["limitAmount"]));
  if (node["skipAmount"] !== undefined) parts.push(`skip ${String(node["skipAmount"])}`);
  if (node["filter"] && Object.keys(node["filter"] as Document).length > 0) parts.push(`filter ${shellText(node["filter"])}`);
  return parts.join(" ");
}

function planTree(node: Document | undefined, depth: number, summary: PlanSummary): void {
  if (!node) return;
  // Slot-based engine (7.0+) wraps the classic tree in queryPlan.
  if (node["queryPlan"]) return planTree(node["queryPlan"] as Document, depth, summary);
  if (Array.isArray(node["shards"])) {
    summary.lines.push(`${"  ".repeat(depth)}${String(node["stage"] ?? "SHARDS")}`);
    for (const shard of node["shards"] as Document[]) {
      summary.lines.push(`${"  ".repeat(depth + 1)}shard ${String(shard["shardName"])}`);
      planTree(shard["winningPlan"] as Document, depth + 2, summary);
    }
    return;
  }
  summary.stages.add(String(node["stage"]));
  summary.lines.push(`${"  ".repeat(depth)}${nodeLabel(node)}`);
  if (node["inputStage"]) planTree(node["inputStage"] as Document, depth + 1, summary);
  for (const child of (node["inputStages"] ?? []) as Document[]) planTree(child, depth + 1, summary);
}

function plannerOf(explain: Document): { planner?: Document; stats?: Document; later: string[] } {
  if (explain["queryPlanner"]) {
    const later = Array.isArray(explain["stages"]) ? (explain["stages"] as Document[]).slice(1).map((st) => Object.keys(st)[0]!) : [];
    return { planner: explain["queryPlanner"] as Document, stats: explain["executionStats"] as Document | undefined, later };
  }
  const stages = (explain["stages"] ?? []) as Document[];
  const cursor = stages[0]?.["$cursor"] as Document | undefined;
  return {
    ...(cursor ? { planner: cursor["queryPlanner"] as Document, stats: cursor["executionStats"] as Document | undefined } : {}),
    later: stages.slice(cursor ? 1 : 0).map((st) => Object.keys(st)[0]!),
  };
}

export async function executeExplain(parsed: ParsedArgs, raw: string, spec: ExplainSpec, usage: string): Promise<string> {
  assertReadableCollection(raw);
  const target = await targetFrom(parsed);
  const verbosity = spec.analyze ? "executionStats" : "queryPlanner";
  const explain = await read(target, parsed, async (s) => {
    const ns = await resolveCollection(s, raw, usage);
    const coll = s.client.db(ns.database).collection(ns.collection);
    if (spec.pipeline) return coll.aggregate(spec.pipeline, { maxTimeMS: s.timeoutMs }).explain(verbosity);
    return coll
      .find(spec.filter ?? {}, {
        maxTimeMS: s.timeoutMs,
        ...(spec.sort ? { sort: spec.sort } : {}),
        ...(spec.projection ? { projection: spec.projection } : {}),
        ...(spec.hint ? { hint: spec.hint } : {}),
      })
      .explain(verbosity);
  });
  const { planner, stats, later } = plannerOf(explain);
  const summary: PlanSummary = { lines: [], stages: new Set(), rejected: ((planner?.["rejectedPlans"] ?? []) as unknown[]).length };
  planTree(planner?.["winningPlan"] as Document | undefined, 0, summary);
  if (summary.lines.length === 0) summary.lines.push("(no query plan in the explain output)");
  if (later.length > 0) summary.lines.push(`then ${later.join(" -> ")}`);
  const result: Obj = {};
  if (summary.rejected > 0) result["rejected_plans"] = summary.rejected;
  if (stats) {
    Object.assign(result, {
      returned: Number(stats["nReturned"] ?? 0),
      keys_examined: Number(stats["totalKeysExamined"] ?? 0),
      docs_examined: Number(stats["totalDocsExamined"] ?? 0),
      ms: Number(stats["executionTimeMillis"] ?? 0),
    });
  }
  const help: string[] = [];
  const filterKeys = Object.keys(spec.filter ?? (spec.pipeline?.[0]?.["$match"] as Document | undefined) ?? {}).filter((k) => !k.startsWith("$"));
  if (summary.stages.has("COLLSCAN")) {
    help.push(`COLLSCAN reads every document${filterKeys.length > 0 ? ` - an index on ${filterKeys.join("; ")} would let it use IXSCAN` : ""}`);
  }
  if (summary.stages.has("SORT")) help.push("SORT runs in memory - an index that ends with the sort keys avoids it");
  if (stats && Number(stats["nReturned"]) > 0 && Number(stats["totalDocsExamined"]) > 10 * Number(stats["nReturned"])) {
    help.push(`Examined ${Number(stats["totalDocsExamined"])} documents to return ${Number(stats["nReturned"])} - the index is not selective for this filter`);
  }
  if (!spec.analyze) help.push("Add --analyze for documents examined and time (it runs the query)");
  return out(fenced("plan", summary.lines.join("\n")), Object.keys(result).length > 0 && block(result), helpBlock(help));
}
