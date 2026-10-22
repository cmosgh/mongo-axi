import type { Document } from "mongodb";
import type { FlagSpec, ParsedArgs } from "../../../core/src/args.js";
import { collectionNames, resolveCollection, timeoutMs, type Namespace } from "../../../core/src/commands/common.js";
import { withSession, type Session } from "../../../core/src/connection.js";
import { AxiError, usageError } from "../../../core/src/errors.js";
import { isPlainObject } from "../../../core/src/literal.js";
import { block, helpBlock, out, type Obj } from "../../../core/src/render.js";
import { describeTarget, type Target } from "../../../core/src/target.js";
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
  return out(block({ preview: { ...fields, target: describeTarget(target) } }), helpBlock(["Nothing was changed. Rerun the same command with --confirm to run it"]));
}
