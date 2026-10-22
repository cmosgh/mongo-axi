// The safety matrix: what an agent's command does through each tool. safety.test.ts checks every cell
// against a throwaway server; scripts/safety-readme.ts renders it, so the README states only what CI verified.

export type Arm = "mongosh" | "mcp" | "axi";

export const ARM_TITLES: Record<Arm, string> = {
  mongosh: "`mongosh --eval`",
  mcp: "`mongodb-mcp-server --readOnly` 3.1.0",
  axi: "`mongo-axi`",
};

/** What happened, as the test observes it. `ran` means the effect is on the server afterwards; `answered` is a read that worked. */
export type Outcome = "ran" | "refused" | "failed" | "answered" | `rows ${number}` | "no time limit" | "time-limited";

export interface SafetyCase {
  id: string;
  /** README row label. */
  title: string;
  /** `read`: something an agent legitimately needs, which should work. */
  kind: "read" | "accident" | "bypass";
  /** The command as mongosh source; mongo-axi gets the same text as its shell form. */
  shell: string;
  /** The same intent as an MCP tool call. */
  mcp: { tool: string; args: Record<string, unknown> };
  expected: Record<Arm, Outcome>;
  /** Characters the agent gets back, checked within 10%; /4 approximates tokens. */
  outputChars?: Record<Arm, number>;
  /** What a refusal tells the agent; `contains` is checked against the output. */
  hint?: Partial<Record<Arm, { contains: string; label: string }>>;
}

export const SAFETY_CASES: SafetyCase[] = [
  {
    id: "explain",
    title: "explain a `find` - does it use an index?",
    kind: "read",
    shell: 'db.orders.find({status: "paid"}).explain()',
    mcp: { tool: "explain", args: { collection: "orders", method: [{ name: "find", arguments: { filter: { status: "paid" } } }] } },
    expected: { mongosh: "answered", mcp: "answered", axi: "answered" },
  },
  {
    id: "group",
    title: "`$group` orders by status",
    kind: "read",
    shell: 'db.orders.aggregate([{$group: {_id: "$status", n: {$sum: 1}}}])',
    mcp: { tool: "aggregate", args: { collection: "orders", pipeline: [{ $group: { _id: "$status", n: { $sum: 1 } } }] } },
    expected: { mongosh: "answered", mcp: "answered", axi: "answered" },
  },
  {
    id: "delete-many",
    title: "`deleteMany`",
    kind: "accident",
    shell: 'db.orders.deleteMany({status: "refunded"})',
    mcp: { tool: "delete-many", args: { collection: "orders", filter: { status: "refunded" } } },
    expected: { mongosh: "ran", mcp: "refused", axi: "refused" },
    hint: { axi: { contains: "use mongo-rw-axi", label: "refused; points to `mongo-rw-axi` (loopback only)" } },
  },
  {
    id: "update-all",
    title: "`updateMany` with an empty filter",
    kind: "accident",
    shell: 'db.orders.updateMany({}, {$set: {status: "cancelled"}})',
    mcp: { tool: "update-many", args: { collection: "orders", filter: {}, update: { $set: { status: "cancelled" } } } },
    expected: { mongosh: "ran", mcp: "refused", axi: "refused" },
  },
  {
    id: "drop",
    title: "`drop()` a collection",
    kind: "accident",
    shell: "db.reviews.drop()",
    mcp: { tool: "drop-collection", args: { collection: "reviews" } },
    expected: { mongosh: "ran", mcp: "refused", axi: "refused" },
  },
  {
    id: "find-all",
    title: "`find()` everything in a 10,000-document collection",
    kind: "accident",
    shell: "db.orders.find().toArray()",
    mcp: { tool: "find", args: { collection: "orders", filter: {} } },
    expected: { mongosh: "rows 10000", mcp: "rows 10", axi: "rows 20" },
    outputChars: { mongosh: 1_900_200, mcp: 2_550, axi: 2_075 },
  },
  {
    id: "out",
    title: "`$out` at the end of a pipeline",
    kind: "bypass",
    shell: 'db.orders.aggregate([{$match: {}}, {$out: "stolen"}])',
    mcp: { tool: "aggregate", args: { collection: "orders", pipeline: [{ $match: {} }, { $out: "stolen" }] } },
    expected: { mongosh: "ran", mcp: "refused", axi: "refused" },
  },
  {
    id: "merge",
    title: "`$merge` back into the collection it reads",
    kind: "bypass",
    shell: 'db.orders.aggregate([{$merge: {into: "orders", whenMatched: [{$set: {status: "merged"}}]}}])',
    mcp: { tool: "aggregate", args: { collection: "orders", pipeline: [{ $merge: { into: "orders", whenMatched: [{ $set: { status: "merged" } }] } }] } },
    expected: { mongosh: "ran", mcp: "refused", axi: "refused" },
  },
  {
    id: "where-sleep",
    title: "`$where` running JavaScript on the server (`sleep`)",
    kind: "bypass",
    shell: 'db.reviews.find({$where: "sleep(600) || true"}).toArray()',
    mcp: { tool: "find", args: { collection: "reviews", filter: { $where: "sleep(600) || true" } } },
    expected: { mongosh: "ran", mcp: "refused", axi: "refused" },
  },
  {
    id: "credentials",
    title: "read `admin.system.users` (password hashes)",
    kind: "bypass",
    shell: 'db.getSiblingDB("admin").system.users.find().toArray()',
    mcp: { tool: "find", args: { database: "admin", collection: "system.users", filter: {} } },
    expected: { mongosh: "ran", mcp: "ran", axi: "refused" },
    hint: { axi: { contains: "holds credentials", label: "refused; credential collections are never read" } },
  },
  {
    id: "time-limit",
    title: "a slow scan - is a server-side time limit sent?",
    kind: "bypass",
    shell: 'db.orders.find({note: /never/}).toArray()',
    mcp: { tool: "find", args: { collection: "orders", filter: { note: { $regex: "never" } } } },
    expected: { mongosh: "no time limit", mcp: "no time limit", axi: "time-limited" },
  },
];
