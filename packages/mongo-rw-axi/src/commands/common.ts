import { BSON, type Collection, type Document } from "mongodb";
import type { FlagSpec, ParsedArgs } from "../../../core/src/args.js";
import { collectionNames, resolveCollection, timeoutMs, type Namespace } from "../../../core/src/commands/common.js";
import { withSession, type Session } from "../../../core/src/connection.js";
import { AxiError, usageError } from "../../../core/src/errors.js";
import { followUp, rerunHint, shellQuote } from "../../../core/src/hints.js";
import { isPlainObject } from "../../../core/src/literal.js";
import { block, helpBlock, out, type Obj } from "../../../core/src/render.js";
import { describeTarget, type Target } from "../../../core/src/target.js";
import { display } from "../../../core/src/values.js";
import { assertWritable, writeWireGuard } from "../write-guard.js";

export const CONFIRM_FLAG: FlagSpec = { name: "--confirm", boolean: true };
export const CREATE_FLAG: FlagSpec = { name: "--create", boolean: true };

/** Every write command goes through here: the write wire guard (and the tunnel check in openSession). */
export function write<T>(target: Target, parsed: ParsedArgs, fn: (s: Session) => Promise<T>): Promise<T> {
  return withSession(target, { wireGuard: writeWireGuard, timeoutMs: timeoutMs(parsed) }, fn);
}

export const nsText = (ns: Namespace): string => `${ns.database}.${ns.collection}`;

/** An existing, writable collection; a missing one is NOT_FOUND with close names (a typo must not create one). */
export async function existingCollection(s: Session, raw: string, usage: string, missingHint?: string): Promise<Namespace> {
  let ns: Namespace;
  try {
    ns = await resolveCollection(s, raw, usage);
  } catch (error) {
    if (missingHint && error instanceof AxiError && error.code === "NOT_FOUND") throw new AxiError(error.message, error.code, [...error.suggestions, missingHint]);
    throw error;
  }
  assertWritable(ns.database, ns.collection);
  return ns;
}

const COLLECTION_NAME = /^[^$\0]{1,255}$/;
const DATABASE_NAME = /^[^/\\. "$*<>:|?\0]{1,63}$/;

export function validDatabase(name: string): string {
  if (!DATABASE_NAME.test(name)) throw usageError(`invalid database name '${name}'`, ["Database names cannot contain /\\. \"$*<>:|? and are at most 63 characters"]);
  return name;
}

/** Where a collection that may not exist yet goes: the selected database, else `database.collection`. */
export function newNamespace(target: Target, raw: string, usage: string): Namespace {
  const dot = raw.indexOf(".");
  const ns = target.database ? { database: target.database, collection: raw } : dot > 0 ? { database: raw.slice(0, dot), collection: raw.slice(dot + 1) } : undefined;
  if (!ns) throw usageError("no database selected", ["Pass -d <database> or use <database>.<collection>", `usage: ${usage}`]);
  validDatabase(ns.database);
  if (!COLLECTION_NAME.test(ns.collection)) throw usageError(`invalid collection name '${ns.collection}' - it cannot contain '$'`);
  assertWritable(ns.database, ns.collection);
  return ns;
}

export async function collectionExists(s: Session, ns: Namespace): Promise<boolean> {
  return ((await collectionNames(s, ns.database)) ?? []).includes(ns.collection);
}

/** Documents to insert: plain objects without top-level operators. */
export function insertableDocs(value: unknown, label: string): Document[] {
  const docs = Array.isArray(value) ? value : [value];
  if (docs.length === 0) throw usageError(`${label} is an empty array`);
  docs.forEach((doc, i) => {
    const where = Array.isArray(value) ? `${label}[${i}]` : label;
    if (!isPlainObject(doc)) throw usageError(`${where} must be an object such as {status: "paid"}`);
    const operator = Object.keys(doc).find((k) => k.startsWith("$"));
    if (operator) throw usageError(`${where} has the operator ${operator} - insert takes plain documents`, ["To change existing documents use `mongo-rw-axi update <collection> <filter> '{$set: {...}}'`"]);
  });
  return docs as Document[];
}

/** What a gated command would do, and that nothing ran. */
export function preview(target: Target, fields: Obj): string {
  return out(block({ preview: { ...fields, target: describeTarget(target) } }), helpBlock([`Nothing was changed. ${rerunHint({ "--confirm": true }, "to run it")}`]));
}

export interface InsertOutcome {
  /** _id of every document now inserted, in input order. */
  ids: unknown[];
  /** Documents whose _id already held the same content: a rerun, nothing to do. */
  unchanged: number;
  /** _id values that exist with different content. */
  conflicts: unknown[];
  /** Other failures (validation, another unique index), first message only. */
  failed: number;
  firstError?: string;
}

const { EJSON } = BSON;

/** Relaxed EJSON with _id first, the order the server stores; int/double differences do not count. */
const comparable = (doc: Document): string => {
  const { _id, ...rest } = doc;
  return EJSON.stringify({ _id, ...rest }, { relaxed: true });
};

interface WriteErrorLike {
  index: number;
  code?: number;
  errmsg?: string;
}

/**
 * insertMany that is safe to rerun: unordered, so one bad document does not stop the rest, and an
 * _id that already holds the same document counts as unchanged instead of failing.
 */
export async function insertDocuments(s: Session, coll: Collection, docs: Document[]): Promise<InsertOutcome> {
  let writeErrors: WriteErrorLike[] = [];
  try {
    await coll.insertMany(docs, { ordered: false });
  } catch (error) {
    const bulk = error as { writeErrors?: WriteErrorLike | WriteErrorLike[] };
    if (bulk.writeErrors === undefined || (Array.isArray(bulk.writeErrors) && bulk.writeErrors.length === 0)) throw error;
    writeErrors = Array.isArray(bulk.writeErrors) ? bulk.writeErrors : [bulk.writeErrors];
  }
  // The driver sets a missing _id on each document before sending it.
  const failedAt = new Set(writeErrors.map((e) => e.index));
  const ids = docs.filter((_, i) => !failedAt.has(i)).map((d) => d["_id"]);
  const duplicateIds = writeErrors.filter((e) => e.code === 11000 && / index: _id_ /.test(e.errmsg ?? ""));
  const others = writeErrors.filter((e) => !duplicateIds.includes(e));
  const outcome: InsertOutcome = { ids, unchanged: 0, conflicts: [], failed: others.length, ...(others[0] ? { firstError: others[0].errmsg ?? `code ${others[0].code}` } : {}) };
  for (let i = 0; i < duplicateIds.length; i += 1000) {
    const chunk = duplicateIds.slice(i, i + 1000).map((e) => docs[e.index]!);
    const stored = await coll.find({ _id: { $in: chunk.map((d) => d["_id"]) } }, { maxTimeMS: s.timeoutMs }).toArray();
    const byId = new Map(stored.map((d) => [EJSON.stringify({ v: d["_id"] }, { relaxed: false }), comparable(d)]));
    for (const doc of chunk) {
      if (byId.get(EJSON.stringify({ v: doc["_id"] }, { relaxed: false })) === comparable(doc)) outcome.unchanged++;
      else outcome.conflicts.push(doc["_id"]);
    }
  }
  return outcome;
}

/** Counts for a summary block, and the error to raise when anything was not written. */
export function insertReport(ns: Namespace, outcome: InsertOutcome): { counts: Obj; error?: AxiError } {
  const counts: Obj = { inserted: outcome.ids.length };
  if (outcome.unchanged > 0) counts["unchanged"] = `${outcome.unchanged} (same _id and content - no-op)`;
  if (outcome.conflicts.length === 0 && outcome.failed === 0) return { counts };
  const parts = [`${outcome.ids.length} inserted`, ...(outcome.unchanged > 0 ? [`${outcome.unchanged} unchanged`] : [])];
  const help: string[] = [];
  if (outcome.conflicts.length > 0) {
    const first = display(outcome.conflicts[0], { full: true });
    parts.push(`${outcome.conflicts.length} with an existing _id and different content (first ${first})`);
    help.push(`To overwrite one: \`${followUp(`update ${shellQuote(nsText(ns))} ${shellQuote(`{_id: ${first}}`)} '<document>' --replace`, { database: false })}\``);
  }
  if (outcome.failed > 0) {
    parts.push(`${outcome.failed} failed - ${outcome.firstError}`);
    if (/E11000/.test(outcome.firstError ?? "")) help.push(`Another document has the same value in a unique index - \`${followUp(`indexes ${shellQuote(nsText(ns))}`, { database: false })}\` lists them`);
  }
  return { counts, error: new AxiError(`${parts.join("; ")} in ${nsText(ns)}`, "WRITE_ERROR", help) };
}
