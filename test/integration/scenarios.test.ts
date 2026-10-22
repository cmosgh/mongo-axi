// The README recipes, run end to end: read with mongo-axi, fix with mongo-rw-axi, check again.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ro, rw } from "../helpers.js";
import { closeAdmin, db, scratchDatabase, serverVersion } from "./db.js";
import { seedShop } from "./fixtures.js";

const DB = "axi_it_scenarios";

beforeAll(async () => {
  await scratchDatabase(DB, async (d) => {
    await seedShop(d);
    await d.collection("signups").insertMany([{ email: "a@example.test" }, { email: "b@example.test" }, { email: "a@example.test" }, { email: "A@example.test" }]);
  });
});

afterAll(async () => {
  await (await db(DB)).dropDatabase();
  await closeAdmin();
});

describe("recipes", () => {
  it("slow query: find the collection scan, add the index, check the plan", async () => {
    const before = await ro("explain", "orders", "{customer_id: ObjectId('000000000000000000000002'), created_at: {$gte: ISODate('2026-09-10')}}");
    expect(before.stdout).toContain("COLLSCAN");
    expect((await rw("index", "create", "orders", "{customer_id: 1, created_at: -1}")).stdout).toContain("result: created");
    const after = await ro("explain", "orders", "{customer_id: ObjectId('000000000000000000000002'), created_at: {$gte: ISODate('2026-09-10')}}");
    expect(after.stdout).toContain("IXSCAN customer_id_1_created_at_-1 (customer_id 1; created_at -1)");
  });

  it("mixed types: describe flags the field, find the odd documents, convert them", async () => {
    expect((await ro("describe", "orders")).stdout).toContain("Mixed types (total int|string)");
    const odd = await ro("find", "orders", "{total: {$type: 'string'}}", "--project", "{total: 1}");
    expect(odd.stdout).toContain("result[1]{_id,total}:\n  ObjectId('0000000000000000000003ef'),\"12.50\"");
    const [major = 0, minor = 0] = await serverVersion();
    if (major * 100 + minor < 402) return;
    expect((await rw("update", "orders", "{total: {$type: 'string'}}", "[{$set: {total: {$toDouble: '$total'}}}]", "--many")).stdout).toContain("modified: 1");
    expect((await ro("describe", "orders")).stdout).toContain("  total,int|double,100");
    expect((await ro("describe", "orders")).stdout).not.toContain("Mixed types");
  });

  it("orphans: references to documents that do not exist", async () => {
    const { stdout } = await ro(
      "aggregate",
      "reviews",
      "[{$lookup: {from: 'orders', localField: 'order_id', foreignField: '_id', as: 'order'}}, {$match: {order: {$size: 0}}}, {$project: {order: 0}}]",
    );
    expect(stdout).toBe("result[2]{_id,order_id,stars}:\n  4,ObjectId('00000000000000000000232c'),4\n  5,ObjectId('00000000000000000000232d'),5\n");
  });

  it("before a unique index: find the duplicates, remove them, then index", async () => {
    const dupes = await ro("aggregate", "signups", "[{$group: {_id: {$toLower: '$email'}, n: {$sum: 1}, ids: {$push: '$_id'}}}, {$match: {n: {$gt: 1}}}]");
    expect(dupes.stdout).toMatch(/^result\[1\]:\n {2}- _id: a@example\.test\n {4}n: 3\n {4}ids\[3\]: /);
    expect((await rw("delete", "signups", "{email: {$in: ['A@example.test']}}")).stdout).toContain("deleted: 1");
    const first = await (await db(DB)).collection("signups").findOne({ email: "a@example.test" }, { sort: { _id: -1 } });
    expect((await rw("delete", "signups", `{_id: ObjectId('${String(first!["_id"])}')}`)).stdout).toContain("deleted: 1");
    expect((await rw("index", "create", "signups", "{email: 1}", "--unique")).stdout).toContain("result: created");
    const again = await rw("insert", "signups", "{email: 'b@example.test'}");
    expect(again.stdout).toContain("code: WRITE_ERROR");
    expect(again.stdout).toContain("E11000 duplicate key");
  });

  it("an index nobody uses", async () => {
    const { stdout } = await ro("indexes", "orders");
    expect(stdout).toMatch(/Unused since the last restart: .*customer_id_1/);
  });
});
