import type { Document } from "mongodb";
import { expectPositionals, flag, intFlag, parseArgs, type ParsedArgs } from "../args.js";
import { axiError, usageError } from "../errors.js";
import { assertReadInput } from "../guard.js";
import { isPlainObject, type Value } from "../literal.js";
import { CURSOR_METHODS, parseShell, READ_METHODS, unsupported, WRITE_METHODS, type Call, type ShellExpr } from "../shell.js";
import { tool } from "../tool.js";
import { indexesCommand } from "./browse.js";
import { CONNECTION_FLAGS, MAX_DOCS, TIMEOUT_FLAG } from "./common.js";
import { DEFAULT_LIMIT, executeAggregate, executeCount, executeDistinct, executeExplain, executeFind, type ExplainSpec, type FindSpec } from "./query.js";

export const SHELL_FLAGS = [...CONNECTION_FLAGS, TIMEOUT_FLAG, { name: "--limit" }, { name: "--full", boolean: true }];

const guardHint = (): { writeHint?: string } => (tool().writeHint ? { writeHint: tool().writeHint! } : {});

export function shellDoc(value: Value, label: string): Document {
  if (!isPlainObject(value)) throw usageError(`${label} must be an object`);
  assertReadInput(label, value, guardHint());
  return value;
}

function hintArg(value: Value): Document | string {
  if (typeof value === "string") return value;
  return shellDoc(value, "hint()");
}

function intArg(value: Value, method: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw usageError(`${method}() takes a whole number`);
  return value;
}

/** Applies the agent's flags for the database a getSiblingDB() named. */
function withDatabase(parsed: ParsedArgs, expr: ShellExpr): ParsedArgs {
  if (!expr.database) return parsed;
  const given = flag(parsed, "--database");
  if (given !== undefined && given !== expr.database) throw usageError(`-d ${given} and getSiblingDB('${expr.database}') disagree`);
  const values = new Map(parsed.values);
  values.set("--database", [expr.database]);
  return { ...parsed, values };
}

function pipelineArgs(args: Value[]): Document[] {
  const [first, ...rest] = args;
  // mongosh takes aggregate([stages], options) and aggregate(stage, stage, ...).
  const stages = Array.isArray(first) ? first : args;
  if (Array.isArray(first) && rest.length > 0) {
    const options = rest[0];
    if (rest.length > 1 || !isPlainObject(options) || Object.keys(options).some((k) => !["allowDiskUse", "maxTimeMS", "comment"].includes(k))) {
      throw usageError("aggregate() options other than allowDiskUse, maxTimeMS and comment are not supported");
    }
  }
  return stages.map((stage, i) => {
    const doc = shellDoc(stage, `aggregate() stage ${i + 1}`);
    if (Object.keys(doc).length !== 1 || !Object.keys(doc)[0]!.startsWith("$")) throw usageError(`aggregate() stage ${i + 1} must have one $stage key`);
    return doc;
  });
}

const explainAnalyze = (args: Value[]): boolean => typeof args[0] === "string" && args[0] !== "queryPlanner";

async function runFindChain(parsed: ParsedArgs, expr: ShellExpr, first: Call, chain: Call[], usage: string): Promise<string> {
  const [filter, projection] = first.args;
  if (first.args.length > 2) throw usageError(`${first.method}() takes a filter and a projection`);
  const spec: FindSpec = {
    filter: filter === undefined ? {} : shellDoc(filter, `${first.method}() filter`),
    limit: first.method === "findOne" ? 1 : intFlag(parsed, "--limit", DEFAULT_LIMIT, { min: 1, max: MAX_DOCS }),
    skip: 0,
  };
  if (projection !== undefined) spec.projection = shellDoc(projection, `${first.method}() projection`);
  for (const call of chain) {
    const [arg] = call.args;
    switch (call.method) {
      case "sort":
        spec.sort = shellDoc(arg, "sort()");
        break;
      case "limit": {
        const n = intArg(arg, "limit");
        if (n > 0) spec.limit = Math.min(n, MAX_DOCS);
        break;
      }
      case "skip":
        spec.skip = intArg(arg, "skip");
        break;
      case "projection":
      case "project":
        spec.projection = shellDoc(arg, `${call.method}()`);
        break;
      case "hint":
        spec.hint = hintArg(arg);
        break;
      case "count":
      case "itcount":
      case "size":
        return executeCount(parsed, expr.collection, spec.filter, false, spec.hint, usage);
      case "explain": {
        const explain: ExplainSpec = { filter: spec.filter, analyze: explainAnalyze(call.args) };
        if (spec.sort) explain.sort = spec.sort;
        if (spec.projection) explain.projection = spec.projection;
        if (spec.hint) explain.hint = spec.hint;
        return executeExplain(parsed, expr.collection, explain, usage);
      }
      case "toArray":
      case "pretty":
      case "maxTimeMS":
      case "batchSize":
      case "comment":
        break;
      default:
        unsupported(call.method, CURSOR_METHODS);
    }
  }
  return executeFind(parsed, expr.collection, spec, usage);
}

/** Runs a parsed `db.<collection>.<method>(...)` through the same read commands. */
export async function runShellRead(parsed: ParsedArgs, expr: ShellExpr): Promise<string> {
  const usage = `${tool().name} 'db.<collection>.<method>(...)'`;
  const [first, ...chain] = expr.calls;
  const method = first!.method;
  if (WRITE_METHODS.has(method)) {
    if (tool().shellWrite) return tool().shellWrite!(parsed, expr);
    throw axiError(`refused by the read-only guard - ${method}() writes`, "READ_ONLY", [
      `${tool().name} only reads: find, findOne, aggregate, countDocuments, distinct, explain`,
      ...(tool().writeHint ? [tool().writeHint!] : ["To change a local dev database use mongo-rw-axi"]),
    ]);
  }
  const rest = chain.filter((c) => !["toArray", "pretty"].includes(c.method));
  switch (method) {
    case "find":
    case "findOne":
      return runFindChain(parsed, expr, first!, chain, usage);
    case "aggregate": {
      const pipeline = pipelineArgs(first!.args);
      if (rest[0]?.method === "explain") return executeExplain(parsed, expr.collection, { pipeline, analyze: explainAnalyze(rest[0].args) }, usage);
      if (rest.length > 0) unsupported(rest[0]!.method, ["toArray", "explain"]);
      return executeAggregate(parsed, expr.collection, pipeline, intFlag(parsed, "--limit", DEFAULT_LIMIT, { min: 1, max: MAX_DOCS }), usage);
    }
    case "countDocuments":
    case "count": {
      if (rest.length > 0) unsupported(rest[0]!.method, []);
      const [filter] = first!.args;
      return executeCount(parsed, expr.collection, filter === undefined ? {} : shellDoc(filter, `${method}() filter`), false, undefined, usage);
    }
    case "estimatedDocumentCount":
      return executeCount(parsed, expr.collection, {}, true, undefined, usage);
    case "distinct": {
      const [field, filter] = first!.args;
      if (typeof field !== "string") throw usageError("distinct() takes a field name first");
      return executeDistinct(parsed, expr.collection, field, filter === undefined ? {} : shellDoc(filter, "distinct() filter"), intFlag(parsed, "--limit", 50, { min: 1, max: MAX_DOCS }), usage);
    }
    case "getIndexes":
      return indexesCommand([expr.collection, ...passThrough(parsed)]);
    case "explain": {
      // db.orders.explain("executionStats").find({...})
      const [inner, ...more] = rest;
      const analyze = explainAnalyze(first!.args);
      if (inner?.method === "find") {
        const [filter, projection] = inner.args;
        const spec: ExplainSpec = { filter: filter === undefined ? {} : shellDoc(filter, "find() filter"), analyze };
        if (projection !== undefined) spec.projection = shellDoc(projection, "find() projection");
        for (const call of more) {
          if (call.method === "sort") spec.sort = shellDoc(call.args[0], "sort()");
          else if (call.method === "hint") spec.hint = hintArg(call.args[0]);
          else unsupported(call.method, ["sort", "hint"]);
        }
        return executeExplain(parsed, expr.collection, spec, usage);
      }
      if (inner?.method === "aggregate") return executeExplain(parsed, expr.collection, { pipeline: pipelineArgs(inner.args), analyze }, usage);
      throw usageError("explain() must be followed by find(...) or aggregate(...)");
    }
  }
  return unsupported(method, READ_METHODS);
}

/** Flags a nested command call needs again. */
function passThrough(parsed: ParsedArgs): string[] {
  return ["--profile", "--database", "--timeout"].flatMap((name) => (flag(parsed, name) !== undefined ? [name, flag(parsed, name)!] : []));
}

export const shellHelp = (): string => `usage: ${tool().name} 'db.<collection>.<method>(...)' [flags]
mongosh syntax, parsed as data and never evaluated: find/findOne with sort/limit/skip/projection/hint, aggregate, countDocuments, estimatedDocumentCount, distinct, getIndexes, explain.
flags:
  -p/--profile <name>, -d/--database <name>, --limit <n>, --full, --timeout <seconds>
examples:
  ${tool().name} 'db.orders.find({status: "paid"}).sort({created_at: -1}).limit(5)'
  ${tool().name} 'db.getSiblingDB("shop").orders.countDocuments({status: "paid"})'
`;

export async function shellCommand(args: string[]): Promise<string> {
  const command = `${tool().name} <shell expression>`;
  const writes = [{ name: "--confirm", boolean: true }, { name: "--create", boolean: true }];
  const parsed = parseArgs(args, tool().shellWrite ? [...SHELL_FLAGS, ...writes] : SHELL_FLAGS, command);
  const [text] = expectPositionals(parsed, 1, `${tool().name} 'db.<collection>.<method>(...)'`);
  const expr = parseShell(text!);
  return runShellRead(withDatabase(parsed, expr), expr);
}
