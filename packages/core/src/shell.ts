import { usageError } from "./errors.js";
import { Scanner, type Value } from "./literal.js";

export interface Call {
  method: string;
  args: Value[];
}

/** `db.orders.find({...}).sort({...})` as data: where it points and the method chain. Nothing is evaluated. */
export interface ShellExpr {
  database?: string;
  collection: string;
  calls: Call[];
}

/** True when an argument looks like mongosh's `db.<collection>.<method>(...)`. */
export const isShellForm = (text: string): boolean => /^\s*db\s*(\.|\[)/.test(text) && text.includes("(");

function callArgs(s: Scanner, method: string): Value[] {
  s.expect("(", `after ${method}`);
  const args: Value[] = [];
  while (!s.eat(")")) {
    args.push(s.value());
    if (!s.eat(",")) {
      s.expect(")", `to close ${method}(`);
      break;
    }
  }
  return args;
}

function stringArg(s: Scanner, method: string): string {
  const [name, ...rest] = callArgs(s, method);
  if (typeof name !== "string" || name === "" || rest.length > 0) s.fail(`${method} takes one name`);
  return name;
}

export function parseShell(text: string): ShellExpr {
  const s = new Scanner(text, "shell expression");
  if (s.identifier() !== "db") s.fail("expected db.<collection>.<method>(...)");
  let database: string | undefined;
  let collection: string | undefined;
  const segments: string[] = [];
  // Collection: db.orders, db.fs.files (dotted name), db["orders"], db.getCollection("orders"), after an optional getSiblingDB.
  for (;;) {
    if (s.eat("[")) {
      if (s.peek() !== '"' && s.peek() !== "'") s.fail("expected a quoted collection name");
      segments.push(s.string());
      s.expect("]", "after the collection name");
      continue;
    }
    if (!s.eat(".")) s.fail("expected '.' and a method call");
    const name = s.identifier() ?? s.fail("expected a name after '.'");
    if (s.peek() !== "(") {
      segments.push(name);
      continue;
    }
    if (name === "getSiblingDB" && segments.length === 0 && database === undefined && collection === undefined) {
      database = stringArg(s, name);
      continue;
    }
    if (name === "getCollection" && segments.length === 0 && collection === undefined) {
      collection = stringArg(s, name);
      continue;
    }
    collection ??= segments.join(".");
    if (!collection) s.fail(`expected db.<collection>.${name}(...)`);
    const calls: Call[] = [{ method: name, args: callArgs(s, name) }];
    while (s.eat(".")) {
      const method = s.identifier() ?? s.fail("expected a method name after '.'");
      calls.push({ method, args: callArgs(s, method) });
    }
    s.eat(";");
    if (!s.atEnd()) s.fail("unexpected text after the expression - one expression per call");
    return { ...(database ? { database } : {}), collection, calls };
  }
}

export const READ_METHODS = ["find", "findOne", "aggregate", "countDocuments", "count", "estimatedDocumentCount", "distinct", "getIndexes", "explain"] as const;
export const CURSOR_METHODS = ["sort", "limit", "skip", "projection", "project", "hint", "toArray", "pretty", "count", "itcount", "size", "explain", "maxTimeMS", "batchSize", "comment"] as const;

/** Write methods agents commonly reach for; refused on the read path with a pointer to the write tool. */
export const WRITE_METHODS = new Set([
  "insert",
  "insertOne",
  "insertMany",
  "update",
  "updateOne",
  "updateMany",
  "replaceOne",
  "remove",
  "deleteOne",
  "deleteMany",
  "findOneAndUpdate",
  "findOneAndReplace",
  "findOneAndDelete",
  "findAndModify",
  "bulkWrite",
  "save",
  "drop",
  "createIndex",
  "createIndexes",
  "ensureIndex",
  "dropIndex",
  "dropIndexes",
  "renameCollection",
]);

export function unsupported(method: string, allowed: readonly string[]): never {
  throw usageError(`${method}() is not supported in the shell form`, [`supported: ${allowed.join(", ")}`]);
}
