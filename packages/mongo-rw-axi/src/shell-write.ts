import type { CreateIndexesOptions, Document } from "mongodb";
import { bool, type ParsedArgs } from "../../core/src/args.js";
import { usageError } from "../../core/src/errors.js";
import { isPlainObject, type Value } from "../../core/src/literal.js";
import { unsupported, type ShellExpr } from "../../core/src/shell.js";
import { executeCollectionDrop, executeIndexCreate, executeIndexDrop, executeRename, indexKeysInput } from "./commands/admin.js";
import { executeDelete, executeInsert, executeUpdate, writeFilter } from "./commands/docs.js";
import { insertableDocs } from "./commands/common.js";

const SUPPORTED = ["insertOne", "insertMany", "updateOne", "updateMany", "replaceOne", "deleteOne", "deleteMany", "createIndex", "dropIndex", "drop", "renameCollection"];

/** Instead of the legacy and compound methods mongosh also has. */
const INSTEAD: Record<string, string> = {
  insert: "insertOne / insertMany",
  update: "updateOne / updateMany",
  remove: "deleteOne / deleteMany",
  save: "insertOne, or replaceOne with {upsert: true}",
  findOneAndUpdate: "updateOne, then find",
  findOneAndReplace: "replaceOne, then find",
  findOneAndDelete: "find, then deleteOne",
  findAndModify: "updateOne or deleteOne",
  bulkWrite: "one command per operation",
  createIndexes: "createIndex once per index",
  ensureIndex: "createIndex",
  dropIndexes: "dropIndex once per index",
};

function options(value: Value, method: string, allowed: readonly string[]): Document {
  if (value === undefined) return {};
  if (!isPlainObject(value) || Object.keys(value).some((k) => !allowed.includes(k))) {
    throw usageError(`${method}() options other than ${allowed.join(", ")} are not supported`);
  }
  return value;
}

/** `db.orders.updateMany(...)` and friends, run as the matching write command with the same --confirm gates. */
export async function shellWrite(parsed: ParsedArgs, expr: ShellExpr): Promise<string> {
  const usage = "mongo-rw-axi 'db.<collection>.<method>(...)'";
  const [call, ...chain] = expr.calls;
  const { method, args } = call!;
  if (chain.length > 0) throw usageError(`${method}() cannot be chained`);
  const confirm = bool(parsed, "--confirm");
  const create = bool(parsed, "--create");
  const coll = expr.collection;
  switch (method) {
    case "insertOne":
      return executeInsert(parsed, coll, { docs: insertableDocs(args[0], "insertOne() document"), create }, usage);
    case "insertMany":
      if (!Array.isArray(args[0])) throw usageError("insertMany() takes an array of documents");
      return executeInsert(parsed, coll, { docs: insertableDocs(args[0], "insertMany() documents"), create }, usage);
    case "updateOne":
    case "updateMany":
    case "replaceOne": {
      const opts = options(args[2], method, ["upsert"]);
      return executeUpdate(
        parsed,
        coll,
        {
          filter: writeFilter(args[0], `${method}() filter`),
          update: args[1] as Document | Document[],
          many: method === "updateMany",
          upsert: opts["upsert"] === true,
          replace: method === "replaceOne",
          confirm,
        },
        usage,
      );
    }
    case "deleteOne":
    case "deleteMany":
      return executeDelete(parsed, coll, { filter: writeFilter(args[0], `${method}() filter`), many: method === "deleteMany", confirm }, usage);
    case "createIndex": {
      const opts = options(args[1], method, ["name", "unique", "sparse", "expireAfterSeconds", "partialFilterExpression"]);
      return executeIndexCreate(parsed, coll, { keys: indexKeysInput(args[0]), options: opts as CreateIndexesOptions }, usage);
    }
    case "dropIndex":
      if (typeof args[0] !== "string") throw usageError("dropIndex() takes the index name - `mongo-rw-axi indexes <collection>` lists them");
      return executeIndexDrop(parsed, coll, { name: args[0], confirm }, usage);
    case "drop":
      return executeCollectionDrop(parsed, coll, confirm, usage);
    case "renameCollection":
      if (typeof args[0] !== "string") throw usageError("renameCollection() takes the new name");
      return executeRename(parsed, coll, args[0], confirm, usage);
  }
  if (INSTEAD[method]) throw usageError(`${method}() is not supported - use ${INSTEAD[method]}`);
  return unsupported(method, SUPPORTED);
}
