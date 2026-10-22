import { BSONRegExp, Decimal128, Int32, Long, ObjectId, UUID } from "mongodb";
import { describe, expect, it } from "vitest";
import { closeNames } from "../packages/core/src/commands/common.js";
import { parseDocument, parsePipeline, parseValue } from "../packages/core/src/literal.js";
import { inferSchema, isMixed } from "../packages/core/src/schema.js";
import { redactSecrets } from "../packages/core/src/secrets.js";
import { isShellForm, parseShell } from "../packages/core/src/shell.js";
import { display, shellText } from "../packages/core/src/values.js";

const OID = "0000000000000000000003ea";
const fails = (fn: () => unknown, message: RegExp) => expect(fn).toThrow(message);

describe("literal parser", () => {
  it("reads JSON and mongosh syntax as the same data", () => {
    const json = parseDocument('{"status": "paid", "n": 1, "tags": ["a", "b"]}', "filter");
    const shell = parseDocument("{status: 'paid', n: 1, tags: ['a', 'b',], /* note */ } // done", "filter");
    expect(shell).toEqual(json);
    expect(parseDocument("{'items.sku': 'x', $or: [{a: null}, {b: true}]}", "f")).toEqual({ "items.sku": "x", $or: [{ a: null }, { b: true }] });
  });

  it("builds BSON values from mongosh constructors and Extended JSON", () => {
    const doc = parseDocument(
      `{a: ObjectId('${OID}'), b: ISODate('2026-10-01'), c: NumberLong('9007199254740993'), d: NumberDecimal('1.50'),
        e: NumberInt(5), f: /ab+c/i, g: UUID('3b241101-e2bb-4255-8caf-4136c566a962'), h: 9007199254740993, i: new Date('2026-10-01T10:00')}`,
      "filter",
    );
    expect(doc["a"]).toBeInstanceOf(ObjectId);
    expect((doc["b"] as Date).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(String(doc["c"])).toBe("9007199254740993");
    expect(doc["c"]).toBeInstanceOf(Long);
    expect(doc["d"]).toBeInstanceOf(Decimal128);
    expect(doc["e"]).toBeInstanceOf(Int32);
    expect(doc["f"]).toEqual(new BSONRegExp("ab+c", "i"));
    expect((doc["g"] as UUID).toHexString()).toBe("3b241101-e2bb-4255-8caf-4136c566a962");
    expect(doc["h"]).toBeInstanceOf(Long);
    // A time without a zone is UTC, as in mongosh.
    expect((doc["i"] as Date).toISOString()).toBe("2026-10-01T10:00:00.000Z");
    const ejson = parseDocument(`{a: {$oid: '${OID}'}, b: {$date: '2026-10-01T00:00:00Z'}, c: {$numberLong: '5'}}`, "filter");
    expect(ejson["a"]).toBeInstanceOf(ObjectId);
    expect(ejson["b"]).toBeInstanceOf(Date);
    expect(ejson["c"]).toBeInstanceOf(Long);
  });

  it("never accepts code or names it does not know", () => {
    fails(() => parseValue('{x: Code("1")}', "filter"), /Code is not accepted/);
    fails(() => parseValue("{x: function () { return 1 }}", "filter"), /function is not accepted/);
    fails(() => parseValue("{x: () => 1}", "filter"), /filter/);
    fails(() => parseValue('{x: {$code: "1"}}', "filter"), /\$code is not accepted/);
    fails(() => parseValue("{status: paid}", "filter"), /unknown name 'paid' - quote strings/);
    fails(() => parseValue("{a: process.exit(1)}", "filter"), /unknown name 'process'/);
    fails(() => parseValue("{a: `x${1}`}", "filter"), /filter/);
  });

  it("refuses duplicate keys, trailing text and deep nesting", () => {
    fails(() => parseValue("{a: 1, a: 2}", "filter"), /duplicate key 'a'/);
    fails(() => parseValue("{a: 1} {b: 2}", "filter"), /unexpected text after the value/);
    fails(() => parseValue(`${"[".repeat(200)}${"]".repeat(200)}`, "filter"), /nest/);
  });

  it("keeps __proto__ as a plain key", () => {
    const doc = parseDocument('{"__proto__": {"polluted": 1}}', "filter");
    expect(Object.keys(doc)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.getPrototypeOf(doc)).toBe(Object.prototype);
  });

  it("pipelines are arrays of one-key $stages", () => {
    expect(parsePipeline("{$match: {a: 1}}", "pipeline")).toEqual([{ $match: { a: 1 } }]);
    fails(() => parsePipeline("[{$match: {}, $limit: 1}]", "pipeline"), /stage 1 must be an object with one \$stage key/);
    fails(() => parsePipeline("[{match: {}}]", "pipeline"), /stage 1/);
  });
});

describe("display", () => {
  it("prints typed values in mongosh form and numbers as numbers", () => {
    const out = display(
      { _id: new ObjectId(OID), at: new Date("2026-10-01T00:00:00Z"), small: Long.fromNumber(5), big: Long.fromString("9007199254740993"), price: Decimal128.fromString("1.50"), re: new BSONRegExp("a", "i") },
      { full: false },
    );
    expect(out).toEqual({ _id: `ObjectId('${OID}')`, at: "ISODate('2026-10-01T00:00:00Z')", small: 5, big: "NumberLong('9007199254740993')", price: "NumberDecimal('1.50')", re: "/a/i" });
  });

  it("shortens long strings, arrays and deep nesting unless --full, and always redacts secrets", () => {
    const doc = { s: "x".repeat(250), list: Array.from({ length: 25 }, (_, i) => i), user: { pwd: "hunter2", password: "", credentials: null } };
    const out = display(doc, { full: false }) as Record<string, unknown>;
    expect(out["s"]).toBe(`${"x".repeat(200)}... (+50 chars; --full)`);
    expect((out["list"] as unknown[]).at(-1)).toBe("... (+5 more of 25; --full)");
    expect(out["user"]).toEqual({ pwd: "<redacted>", password: "", credentials: null });
    const full = display(doc, { full: true }) as Record<string, unknown>;
    expect((full["list"] as unknown[]).length).toBe(25);
    expect((full["user"] as Record<string, unknown>)["pwd"]).toBe("<redacted>");
    let deep: unknown = 1;
    for (let i = 0; i < 12; i++) deep = { d: deep };
    expect(JSON.stringify(display(deep, { full: false }))).toContain("{1 fields; --full}");
  });

  it("shellText reads back to the same value", () => {
    const value = { "odd key": "it's \"quoted\"\n", at: new Date("2026-10-01T00:00:00Z"), id: new ObjectId(OID), n: [1, 2.5, -3], nested: { ok: true, none: null } };
    const text = shellText(value);
    expect(text).toContain("'odd key': 'it\\'s \"quoted\"\\n'");
    expect(parseValue(text, "x")).toEqual(value);
  });

  it("redacts the password of connection strings", () => {
    expect(redactSecrets("bad mongodb://app:s3cr%40t@db:27017/x and mongodb+srv://u:p@c.example.net")).toBe("bad mongodb://app:<redacted>@db:27017/x and mongodb+srv://u:<redacted>@c.example.net");
  });
});

describe("schema inference", () => {
  it("uses Mongo dot paths with array element types", () => {
    const schema = inferSchema([
      { _id: 1, items: [{ sku: "a", qty: 1 }, { sku: "b" }], tags: ["x"], total: 5 },
      { _id: 2, items: [], tags: "x", total: 5.5 },
      { _id: 3, total: null },
    ]);
    const types = Object.fromEntries(schema.fields.map((f) => [f.path, f.types.join("|")]));
    const docs = Object.fromEntries(schema.fields.map((f) => [f.path, f.docs]));
    expect(types).toEqual({ _id: "int", items: "array<object>|array", "items.sku": "string", "items.qty": "int", tags: "array<string>|string", total: "int|double|null" });
    expect(docs["items.sku"]).toBe(1);
    expect(docs["total"]).toBe(3);
  });

  it("only flags types that need different filters", () => {
    expect(isMixed(["int", "double", "long", "null"])).toBe(false);
    expect(isMixed(["array<object>", "array"])).toBe(false);
    expect(isMixed(["int", "string"])).toBe(true);
    expect(isMixed(["array<string>", "string"])).toBe(true);
  });
});

describe("shell form", () => {
  it("parses the target and method chain without evaluating it", () => {
    expect(isShellForm("db.orders.find({})")).toBe(true);
    expect(isShellForm("orders")).toBe(false);
    expect(parseShell('db.orders.find({status: "paid"}).sort({_id: -1}).limit(5)')).toEqual({
      collection: "orders",
      calls: [
        { method: "find", args: [{ status: "paid" }] },
        { method: "sort", args: [{ _id: -1 }] },
        { method: "limit", args: [5] },
      ],
    });
    expect(parseShell('db.getSiblingDB("shop").fs.files.countDocuments()')).toMatchObject({ database: "shop", collection: "fs.files" });
    expect(parseShell("db['my-coll'].find()")).toMatchObject({ collection: "my-coll" });
    expect(parseShell("db.getCollection('a.b').find()")).toMatchObject({ collection: "a.b" });
  });

  it("refuses anything beyond one chained expression", () => {
    fails(() => parseShell("db.orders.find({}); db.dropDatabase()"), /unexpected|after/);
    fails(() => parseShell("db.orders.find(this.x)"), /unknown name 'this'/);
    fails(() => parseShell("db.orders.find({}).forEach(function (d) {})"), /function|forEach/);
  });
});

describe("close names", () => {
  it("suggests substrings and small typos", () => {
    const names = ["orders", "order_items", "customers", "paid_orders"];
    expect(closeNames("ordrs", names)).toEqual(["orders"]);
    expect(closeNames("order", names)).toEqual(["orders", "order_items", "paid_orders"]);
    expect(closeNames("xyz", names)).toEqual([]);
  });
});
