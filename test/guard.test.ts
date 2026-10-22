import { Code } from "mongodb";
import { describe, expect, it } from "vitest";
import { assertReadInput, findDenied, readWireGuard } from "../packages/core/src/guard.js";
import { parsePipeline } from "../packages/core/src/literal.js";

const denied = (pipeline: string) => findDenied(parsePipeline(pipeline, "pipeline"));

describe("input guard", () => {
  it("finds write stages and server-side JavaScript at any depth and in any case", () => {
    expect(denied('[{$out: "x"}]')).toMatchObject({ path: "[0].$out" });
    expect(denied('[{$OuT: "x"}]')).toMatchObject({ path: "[0].$OuT" });
    expect(denied('[{$facet: {a: [{$lookup: {from: "c", pipeline: [{$merge: {into: "x"}}], as: "y"}}]}}]')).toMatchObject({
      path: "[0].$facet.a[0].$lookup.pipeline[0].$merge",
    });
    expect(denied('[{$match: {$expr: {$function: {body: "f", args: [], lang: "js"}}}}]')?.reason).toMatch(/server-side JavaScript/);
    expect(denied('[{$group: {_id: 1, a: {$accumulator: {}}}}]')?.reason).toMatch(/server-side JavaScript/);
    expect(denied("[{$changeStream: {}}]")?.reason).toMatch(/change/);
    expect(denied("[{$_internalSplitPipeline: {}}]")?.reason).toMatch(/internal/);
    expect(findDenied({ $where: "1" })?.reason).toMatch(/server-side JavaScript/);
    expect(findDenied({ a: new Code("1") })?.reason).toMatch(/code/);
  });

  it("refuses stages that read credential collections by value", () => {
    expect(denied('[{$unionWith: "system.users"}]')?.reason).toMatch(/system\.users holds credentials/);
    expect(denied('[{$unionWith: {coll: "System.Keys", pipeline: []}}]')?.reason).toMatch(/credentials/);
    expect(denied('[{$lookup: {from: "system.users", localField: "a", foreignField: "b", as: "c"}}]')?.reason).toMatch(/credentials/);
    expect(denied('[{$graphLookup: {from: "system.users", startWith: "$a", connectFromField: "a", connectToField: "b", as: "c"}}]')?.reason).toMatch(/credentials/);
    expect(denied('[{$lookup: {from: "customers", localField: "a", foreignField: "b", as: "c"}}]')).toBeUndefined();
  });

  it("lets ordinary reads through, including field names that look like operators inside strings", () => {
    expect(denied('[{$match: {note: "$out"}}, {$group: {_id: "$status", n: {$sum: 1}}}, {$sort: {n: -1}}]')).toBeUndefined();
    expect(() => assertReadInput("filter", { status: "paid", out: 1 })).not.toThrow();
    expect(() => assertReadInput("filter", { $where: "1" })).toThrow(/refused by the read-only guard - \$where/);
  });
});

describe("wire guard", () => {
  const timed = { maxTimeMS: 1000 };
  const wire = (name: string, command: Record<string, unknown>) => readWireGuard(name, command, "shop");

  it("allows timed reads and cursor follow-ups", () => {
    expect(wire("find", { find: "orders", filter: {}, ...timed })).toBeUndefined();
    expect(wire("aggregate", { aggregate: "orders", pipeline: [{ $match: {} }], cursor: {}, ...timed })).toBeUndefined();
    expect(wire("getMore", { getMore: 1, collection: "orders" })).toBeUndefined();
    expect(wire("explain", { explain: { find: "orders", filter: {}, ...timed }, verbosity: "executionStats" })).toBeUndefined();
    expect(wire("listCollections", { listCollections: 1 })).toBeUndefined();
  });

  it("stops every command outside the read allowlist", () => {
    for (const name of ["insert", "update", "delete", "findAndModify", "drop", "dropDatabase", "create", "createIndexes", "renameCollection", "createUser", "eval", "mapReduce", "getParameter", "shutdown"]) {
      expect(wire(name, { [name]: "orders" }), name).toMatch(/is not a read command/);
    }
  });

  it("stops untimed reads, explained writes, write stages and credential collections", () => {
    expect(wire("find", { find: "orders", filter: {} })).toMatch(/without maxTimeMS/);
    expect(wire("explain", { explain: { find: "orders", filter: {} }, verbosity: "executionStats" })).toMatch(/without maxTimeMS/);
    expect(wire("explain", { explain: { delete: "orders", deletes: [] } })).toMatch(/explain of 'delete' is not a read/);
    expect(wire("aggregate", { aggregate: "orders", pipeline: [{ $out: "x" }], ...timed })).toMatch(/\$out writes/);
    expect(wire("explain", { explain: { aggregate: "orders", pipeline: [{ $merge: { into: "x" } }], ...timed } })).toMatch(/\$merge writes/);
    expect(wire("find", { find: "system.users", filter: {}, ...timed })).toMatch(/credentials/);
    expect(wire("aggregate", { aggregate: 1, pipeline: [{ $documents: [{}] }, { $unionWith: "system.users" }], ...timed })).toMatch(/credentials/);
  });
});
