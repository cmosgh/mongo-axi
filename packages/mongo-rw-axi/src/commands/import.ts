import { readFileSync, statSync } from "node:fs";
import type { Document } from "mongodb";
import { bool, flag, intFlag, parseArgs } from "../../../core/src/args.js";
import { CONNECTION_FLAGS, CONNECTION_FLAGS_HELP, targetFrom } from "../../../core/src/commands/common.js";
import { AxiError, axiError, fromDriverError, usageError } from "../../../core/src/errors.js";
import { parseValue } from "../../../core/src/literal.js";
import { block, helpBlock, out, type Obj } from "../../../core/src/render.js";
import { followUp, rerunHint, shellQuote } from "../../../core/src/hints.js";
import { describeTarget } from "../../../core/src/target.js";
import { CONFIRM_FLAG, collectionExists, insertDocuments, insertableDocs, insertReport, newNamespace, nsText, preview, write, type InsertOutcome } from "./common.js";

const MAX_FILE_BYTES = 256 * 1024 * 1024;

export const IMPORT_HELP = `usage: mongo-rw-axi import <collection> <file|-> [flags]
WRITES. Loads a JSON array or JSON Lines file (mongoexport output works) into a collection, in batches; creates the collection when missing.
A document whose _id already holds the same content is skipped, so rerunning an import of documents with _id is a no-op (one without _id gets a new one each run); the first batch with a failure stops the import.
Extended JSON ($oid, $date, ...) and mongosh literals are read as data. --drop drops the collection first and previews until --confirm.
flags:
  ${CONNECTION_FLAGS_HELP}, --drop, --confirm, --batch <n> (default 1000)
examples:
  mongo-rw-axi import orders orders.jsonl -d shop_test
  mongo-rw-axi import customers customers.json -d shop_test --drop --confirm
  mongoexport --db shop --collection orders | mongo-rw-axi import orders - -d shop_test
`;

/** A JSON array, or one document per line (blank lines skipped). */
export function parseImport(text: string, source: string): Document[] {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("[")) return insertableDocs(parseValue(trimmed, source, MAX_FILE_BYTES), source);
  const docs: Document[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    docs.push(...insertableDocs(parseValue(line, `${source} line ${i + 1}`), `${source} line ${i + 1}`));
  });
  if (docs.length === 0) throw usageError(`${source} has no documents`);
  return docs;
}

function readSource(path: string): string {
  if (path === "-") {
    if (process.stdin.isTTY) throw usageError("no documents on stdin");
    return readFileSync(0, "utf-8");
  }
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw usageError(`cannot read '${path}'`);
  }
  if (size > MAX_FILE_BYTES) throw usageError(`'${path}' is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`, ["Split it, or use mongoimport for bulk loads"]);
  return readFileSync(path, "utf-8");
}

export async function importCommand(args: string[]): Promise<string> {
  const command = "mongo-rw-axi import";
  const usage = `${command} <collection> <file|->`;
  const parsed = parseArgs(args, [...CONNECTION_FLAGS, { name: "--drop", boolean: true }, CONFIRM_FLAG, { name: "--batch" }], command);
  if (parsed.positionals.length !== 2) throw usageError(parsed.positionals.length < 2 ? "missing argument" : `unexpected argument '${parsed.positionals[2]}'`, [`usage: ${usage}`]);
  const [raw, path] = parsed.positionals as [string, string];
  const batch = intFlag(parsed, "--batch", 1000, { min: 1, max: 100_000 });
  const drop = bool(parsed, "--drop");
  const confirm = bool(parsed, "--confirm");
  const source = path === "-" ? "stdin" : path;
  // Parse everything before connecting: a bad line must not leave half a load behind.
  const docs = parseImport(readSource(path), source);

  const target = await targetFrom(parsed);
  const started = Date.now();
  const total: InsertOutcome = { ids: [], unchanged: 0, conflicts: [], failed: 0 };
  const result = await write(target, parsed, async (s) => {
    const ns = newNamespace(s.target, raw, usage);
    const coll = s.client.db(ns.database).collection(ns.collection);
    const exists = await collectionExists(s, ns);
    if (drop && exists && !confirm) return { ns, gated: await coll.countDocuments({}, { maxTimeMS: s.timeoutMs }) } as const;
    if (drop && exists) await coll.drop();
    for (let i = 0; i < docs.length; i += batch) {
      let outcome: InsertOutcome;
      try {
        outcome = await insertDocuments(s, coll, docs.slice(i, i + batch));
      } catch (error) {
        throw axiError(`import stopped after ${total.ids.length} of ${docs.length} documents - ${fromDriverError(error, describeTarget(s.target)).message}`, "WRITE_ERROR");
      }
      total.ids.push(...outcome.ids);
      total.unchanged += outcome.unchanged;
      total.conflicts.push(...outcome.conflicts);
      total.failed += outcome.failed;
      total.firstError ??= outcome.firstError;
      const { error } = insertReport(ns, total);
      if (error) {
        // Later batches are not sent: a broken file should not load further.
        const left = docs.length - Math.min(i + batch, docs.length);
        throw new AxiError(`import stopped${left > 0 ? ` with ${left} documents not sent` : ""} - ${error.message}`, "WRITE_ERROR", [
          ...error.suggestions,
          `Documents already in ${nsText(ns)} are skipped on a rerun when unchanged: fix the data, then ${rerunHint({}, "again")}`,
        ]);
      }
    }
    return { ns, created: !exists || drop } as const;
  });
  if ("gated" in result) {
    return preview(target, { import: `${docs.length} documents from ${source} into ${nsText(result.ns)}`, risk: `irreversible - --drop deletes ${result.gated} existing documents and the collection's indexes first` });
  }
  const { counts } = insertReport(result.ns, total);
  const summary: Obj = { collection: `${nsText(result.ns)}${result.created ? " (created)" : ""}`, ...counts, batches: Math.ceil(docs.length / batch), elapsed_ms: Date.now() - started };
  return out(block({ import: summary }), helpBlock([`Run \`${followUp(`describe ${shellQuote(raw)}`)}\` to check the inferred fields`]));
}
