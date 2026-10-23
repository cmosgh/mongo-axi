import type { Collection, Document } from "mongodb";
import { bool, parseArgs, type ParsedArgs } from "../../../core/src/args.js";
import { CONNECTION_FLAGS, CONNECTION_FLAGS_HELP, inputText, targetFrom } from "../../../core/src/commands/common.js";
import { AxiError, axiError, usageError } from "../../../core/src/errors.js";
import { isPlainObject, parseDocument, parseValue } from "../../../core/src/literal.js";
import { block, helpBlock, out, snippet, type Obj } from "../../../core/src/render.js";
import { followUp, shellQuote } from "../../../core/src/hints.js";
import { display, shellText } from "../../../core/src/values.js";
import { assertNoCode } from "../write-guard.js";
import { CONFIRM_FLAG, CREATE_FLAG, collectionExists, existingCollection, insertDocuments, insertableDocs, insertReport, newNamespace, nsText, preview, write } from "./common.js";

const MAX_INSERT = 10_000;
const SHOWN_IDS = 20;

export const INSERT_HELP = `usage: mongo-rw-axi insert <collection> <document or [documents]> [flags]
WRITES. Inserts documents given as JSON or mongosh syntax (an _id is generated when missing), up to ${MAX_INSERT}; use import for files.
The collection must exist (a typo must not create one) unless --create. An _id that already holds the same document is a no-op, so a rerun is safe; documents without _id are inserted again.
flags:
  ${CONNECTION_FLAGS_HELP}, --file <path> (or - for stdin), --create
examples:
  mongo-rw-axi insert orders '{status: "paid", total: NumberDecimal("12.50"), created_at: ISODate("2026-10-01")}'
  mongo-rw-axi insert orders '[{sku: "a", qty: 1}, {sku: "b", qty: 2}]'
  mongo-rw-axi insert audit_log --file events.json --create
`;

export const UPDATE_HELP = `usage: mongo-rw-axi update <collection> <filter> <update> [flags]
WRITES. Updates the first matching document, or every match with --many.
<update> is an operator document ({$set: {...}}), a pipeline ([{$set: {...}}]), or the whole new document with --replace.
An --many update whose filter matches every document previews until --confirm.
flags:
  ${CONNECTION_FLAGS_HELP}, --many, --upsert, --replace, --confirm
examples:
  mongo-rw-axi update orders '{_id: ObjectId("66f1c2a9e4b0a1b2c3d4e5f6")}' '{$set: {status: "paid"}}'
  mongo-rw-axi update orders '{status: "pending", created_at: {$lt: ISODate("2026-01-01")}}' '{$set: {status: "expired"}}' --many
  mongo-rw-axi update customers '{email: "a@example.test"}' '{$set: {plan: "pro"}}' --upsert
  mongo-rw-axi update orders '{}' '[{$set: {total: {$toDecimal: "$total"}}}]' --many --confirm
`;

export const DELETE_HELP = `usage: mongo-rw-axi delete <collection> <filter> [flags]
WRITES. Deletes the first matching document, or every match with --many. The filter is required ('{}' matches everything).
An --many delete whose filter matches every document previews until --confirm.
flags:
  ${CONNECTION_FLAGS_HELP}, --many, --confirm
examples:
  mongo-rw-axi delete orders '{_id: ObjectId("66f1c2a9e4b0a1b2c3d4e5f6")}'
  mongo-rw-axi delete sessions '{expires_at: {$lt: ISODate("2026-10-01")}}' --many
`;

/** A filter for update/delete: a document, checked for code. */
export function writeFilter(value: unknown, label: string): Document {
  if (!isPlainObject(value)) throw usageError(`${label} must be an object such as {_id: ObjectId("...")} - '{}' matches every document`);
  assertNoCode(label, value);
  return value;
}

// --- insert ---

export interface InsertSpec {
  docs: Document[];
  create: boolean;
}

export async function executeInsert(parsed: ParsedArgs, raw: string, spec: InsertSpec, usage: string): Promise<string> {
  if (spec.docs.length > MAX_INSERT) throw usageError(`${spec.docs.length} documents - insert takes up to ${MAX_INSERT}`, ["Use `mongo-rw-axi import <collection> <file>` for larger loads"]);
  const target = await targetFrom(parsed);
  const result = await write(target, parsed, async (s) => {
    const ns = spec.create ? newNamespace(s.target, raw, usage) : await existingCollection(s, raw, usage, "Pass --create to create it");
    const created = spec.create && !(await collectionExists(s, ns));
    const outcome = await insertDocuments(s, s.client.db(ns.database).collection(ns.collection), spec.docs);
    return { ns, created, outcome };
  });
  const { counts, error } = insertReport(result.ns, result.outcome);
  if (error) throw error;
  const ids = result.outcome.ids;
  const summary: Obj = { collection: `${nsText(result.ns)}${result.created ? " (created)" : ""}`, ...counts };
  if (ids.length > 0) summary["ids"] = ids.slice(0, SHOWN_IDS).map((id) => display(id, { full: true }));
  return out(block({ insert: summary }), helpBlock(ids.length > SHOWN_IDS ? [`First ${SHOWN_IDS} of ${ids.length} ids shown`] : []));
}

export async function insertCommand(args: string[]): Promise<string> {
  const command = "mongo-rw-axi insert";
  const usage = `${command} <collection> <document or [documents]>`;
  const parsed = parseArgs(args, [...CONNECTION_FLAGS, { name: "--file" }, CREATE_FLAG], command);
  const [raw, positional, extra] = parsed.positionals;
  if (!raw || extra !== undefined) throw usageError(raw ? `unexpected argument '${extra}'` : "missing argument", [`usage: ${usage}`]);
  const text = inputText(parsed, positional, "documents", usage);
  if (text === undefined) throw usageError("missing the document to insert", [`usage: ${usage}`]);
  const docs = insertableDocs(parseValue(text, "documents"), "documents");
  return executeInsert(parsed, raw, { docs, create: bool(parsed, "--create") }, usage);
}

// --- update ---

export interface UpdateSpec {
  filter: Document;
  update: Document | Document[];
  many: boolean;
  upsert: boolean;
  replace: boolean;
  confirm: boolean;
}

/** Shape checks the server would make later, with the fix in the message. */
export function checkUpdate(spec: Pick<UpdateSpec, "update" | "replace" | "many">): void {
  const { update } = spec;
  if (spec.replace) {
    if (spec.many) throw usageError("--replace replaces one document - drop --many");
    if (!isPlainObject(update) || Object.keys(update).some((k) => k.startsWith("$"))) throw usageError("with --replace the update is the whole new document, without $operators");
  } else if (Array.isArray(update)) {
    if (update.length === 0 || update.some((stage) => !isPlainObject(stage) || Object.keys(stage).length !== 1 || !Object.keys(stage)[0]!.startsWith("$"))) {
      throw usageError("an update pipeline is an array of stages such as [{$set: {...}}]");
    }
  } else if (!isPlainObject(update) || Object.keys(update).length === 0 || Object.keys(update).some((k) => !k.startsWith("$"))) {
    throw usageError("the update needs $operators such as {$set: {status: \"paid\"}}", ["To replace the whole document pass --replace"]);
  }
  assertNoCode("update", update);
}

/** Matches every document of a non-empty collection: the gate for --many writes. */
async function matchesAll(coll: Collection, filter: Document, timeoutMs: number): Promise<{ all: boolean; matched: number }> {
  const matched = await coll.countDocuments(filter, { maxTimeMS: timeoutMs });
  const total = Object.keys(filter).length === 0 ? matched : await coll.countDocuments({}, { maxTimeMS: timeoutMs });
  return { all: total > 0 && matched === total, matched };
}

export async function executeUpdate(parsed: ParsedArgs, raw: string, spec: UpdateSpec, usage: string): Promise<string> {
  checkUpdate(spec);
  const target = await targetFrom(parsed);
  const result = await write(target, parsed, async (s) => {
    const ns = await existingCollection(s, raw, usage);
    const coll = s.client.db(ns.database).collection(ns.collection);
    if (spec.many && !spec.confirm) {
      const gate = await matchesAll(coll, spec.filter, s.timeoutMs);
      if (gate.all) return { ns, gated: gate.matched } as const;
    }
    const options = { upsert: spec.upsert };
    const r = spec.replace
      ? await coll.replaceOne(spec.filter, spec.update as Document, options)
      : spec.many
        ? await coll.updateMany(spec.filter, spec.update, options)
        : await coll.updateOne(spec.filter, spec.update, options);
    return { ns, r } as const;
  }).catch((error: unknown) => {
    if (Array.isArray(spec.update) && error instanceof AxiError && /wrong type 'array'/.test(error.message)) {
      throw axiError(error.message, "QUERY_ERROR", ["Update pipelines need MongoDB 4.2+ - use operators such as {$set: {...}}"]);
    }
    throw error;
  });
  if ("gated" in result) {
    return preview(target, {
      update: `${nsText(result.ns)} ${snippet(shellText(spec.update, 0).replace(/\n\s*/g, " "))}`,
      risk: `changes every document (${result.gated}) - the filter ${shellText(spec.filter)} matches them all`,
    });
  }
  const summary: Obj = { collection: nsText(result.ns), matched: result.r.matchedCount, modified: result.r.modifiedCount };
  if (result.r.upsertedId != null) summary["upserted_id"] = display(result.r.upsertedId, { full: true });
  const help = result.r.matchedCount === 0 && !spec.upsert ? [`No document matched - \`${followUp(`count ${shellQuote(raw)} '<filter>'`)}\` checks a filter; --upsert inserts when nothing matches`] : [];
  return out(block({ update: summary }), helpBlock(help));
}

export async function updateCommand(args: string[]): Promise<string> {
  const command = "mongo-rw-axi update";
  const usage = `${command} <collection> <filter> <update>`;
  const parsed = parseArgs(args, [...CONNECTION_FLAGS, { name: "--many", boolean: true }, { name: "--upsert", boolean: true }, { name: "--replace", boolean: true }, CONFIRM_FLAG], command);
  const [raw, filterText, updateText, extra] = parsed.positionals;
  if (!raw || filterText === undefined || updateText === undefined || extra !== undefined) {
    throw usageError(extra !== undefined ? `unexpected argument '${extra}'` : "missing argument", [`usage: ${usage}`, "The filter is required: '{}' matches every document"]);
  }
  const update = parseValue(updateText, "update");
  return executeUpdate(
    parsed,
    raw,
    {
      filter: writeFilter(parseDocument(filterText, "filter"), "filter"),
      update: update as Document | Document[],
      many: bool(parsed, "--many"),
      upsert: bool(parsed, "--upsert"),
      replace: bool(parsed, "--replace"),
      confirm: bool(parsed, "--confirm"),
    },
    usage,
  );
}

// --- delete ---

export interface DeleteSpec {
  filter: Document;
  many: boolean;
  confirm: boolean;
}

export async function executeDelete(parsed: ParsedArgs, raw: string, spec: DeleteSpec, usage: string): Promise<string> {
  const target = await targetFrom(parsed);
  const result = await write(target, parsed, async (s) => {
    const ns = await existingCollection(s, raw, usage);
    const coll = s.client.db(ns.database).collection(ns.collection);
    if (spec.many && !spec.confirm) {
      const gate = await matchesAll(coll, spec.filter, s.timeoutMs);
      if (gate.all) return { ns, gated: gate.matched } as const;
    }
    const r = spec.many ? await coll.deleteMany(spec.filter) : await coll.deleteOne(spec.filter);
    return { ns, deleted: r.deletedCount } as const;
  });
  if ("gated" in result) {
    return preview(target, {
      delete: nsText(result.ns),
      risk: `irreversible - deletes every document (${result.gated}); the filter ${shellText(spec.filter)} matches them all`,
    });
  }
  return out(
    block({ delete: { collection: nsText(result.ns), deleted: result.deleted } }),
    helpBlock(result.deleted === 0 ? [`No document matched - \`${followUp(`count ${shellQuote(raw)} '<filter>'`)}\` checks a filter`] : []),
  );
}

export async function deleteCommand(args: string[]): Promise<string> {
  const command = "mongo-rw-axi delete";
  const usage = `${command} <collection> <filter>`;
  const parsed = parseArgs(args, [...CONNECTION_FLAGS, { name: "--many", boolean: true }, CONFIRM_FLAG], command);
  const [raw, filterText, extra] = parsed.positionals;
  if (!raw || filterText === undefined || extra !== undefined) {
    throw usageError(extra !== undefined ? `unexpected argument '${extra}'` : "missing argument", [`usage: ${usage}`, "The filter is required: '{}' matches every document"]);
  }
  return executeDelete(parsed, raw, { filter: writeFilter(parseDocument(filterText, "filter"), "filter"), many: bool(parsed, "--many"), confirm: bool(parsed, "--confirm") }, usage);
}
