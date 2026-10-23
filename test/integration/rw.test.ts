import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient, ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { withSession, type Session } from "../../packages/core/src/connection.js";
import { setTool } from "../../packages/core/src/tool.js";
import { targetFromUri } from "../../packages/core/src/target.js";
import { TOOL } from "../../packages/mongo-rw-axi/src/cli.js";
import { loopbackOnly } from "../../packages/mongo-rw-axi/src/loopback.js";
import { writeWireGuard } from "../../packages/mongo-rw-axi/src/write-guard.js";
import { rw } from "../helpers.js";
import { closeAdmin, db, rootPassword, scratchDatabase, serverPort, serverVersion, urlFor } from "./db.js";
import { ORDER_COUNT, seedShop } from "./fixtures.js";

const DB = "axi_it_rw";
const DROP_DB = "axi_it_rw_drop";
const ROOT_URL = () => urlFor("root", rootPassword(), DB);
const files = mkdtempSync(join(tmpdir(), "mongo-rw-axi-it-"));
const file = (name: string, text: string): string => {
  const path = join(files, name);
  writeFileSync(path, text);
  return path;
};

const shop = () => db(DB);
const count = async (collection: string, filter = {}) => (await shop()).collection(collection).countDocuments(filter);
const collections = async (database = DB) => ((await (await db(database)).listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort());

beforeAll(async () => {
  await scratchDatabase(DROP_DB, async (d) => {
    await d.collection("a").insertOne({ x: 1 });
  });
  await scratchDatabase(DB, seedShop);
});

afterAll(async () => {
  for (const name of [DB, DROP_DB]) await (await db(name)).dropDatabase();
  await closeAdmin();
});

describe("home", () => {
  it("warns that it writes and shows the local server", async () => {
    const { stdout, exitCode } = await rw();
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/\nwarning: WRITE-CAPABLE/);
    expect(stdout).toMatch(/\nserver: MongoDB \d+\.\d+\.\d+ - standalone\n/);
    expect(stdout).toContain(`database: ${DB} - `);
    expect(stdout).not.toContain(rootPassword());
  });

  it("shows a non-loopback target as unavailable without connecting", async () => {
    process.env["MONGO_RW_AXI_URL"] = "mongodb://agent:hunter2@10.1.2.3:27017/shop";
    try {
      const { stdout, exitCode } = await rw();
      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/live: "?unavailable - /);
      expect(stdout).toContain("mongo-axi");
      expect(stdout).not.toContain("hunter2");
    } finally {
      process.env["MONGO_RW_AXI_URL"] = ROOT_URL();
    }
  });
});

describe("documents", () => {
  it("insert needs an existing collection unless --create", async () => {
    const typo = await rw("insert", "ordrs", "{a: 1}");
    expect(typo.exitCode).toBe(1);
    expect(typo.stdout).toContain("did you mean: orders");
    expect(typo.stdout).toContain("Pass --create to create it");
    expect(await collections()).not.toContain("ordrs");

    const created = await rw("insert", "notes", '[{_id: ObjectId("000000000000000000000abc"), at: ISODate("2026-10-01"), n: NumberLong("9007199254740993")}, {text: "b"}]', "--create");
    expect(created.stdout).toMatch(/^insert:\n {2}collection: axi_it_rw\.notes \(created\)\n {2}inserted: 2\n {2}ids\[2\]: ObjectId\('000000000000000000000abc'\),ObjectId\('/);
    const stored = await (await shop()).collection("notes").findOne({ _id: new ObjectId("000000000000000000000abc") });
    expect(stored?.["at"]).toEqual(new Date("2026-10-01T00:00:00Z"));
    expect(String(stored?.["n"])).toBe("9007199254740993");

    const operator = await rw("insert", "notes", "{$set: {a: 1}}");
    expect(operator.exitCode).toBe(2);
    expect(operator.stdout).toContain("insert takes plain documents");
  });

  it("insert is a no-op for an _id that already holds the same document, and an error when it differs", async () => {
    const doc = '{_id: ObjectId("000000000000000000000abd"), text: "same", n: 1}';
    expect((await rw("insert", "notes", doc)).stdout).toContain("inserted: 1");
    const again = await rw("insert", "notes", doc, "-d", DB);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toBe("insert:\n  collection: axi_it_rw.notes\n  inserted: 0\n  unchanged: 1 (same _id and content - no-op)\n");

    const changed = await rw("insert", "notes", '[{_id: ObjectId("000000000000000000000abd"), text: "other"}, {text: "new"}]', "-d", DB);
    expect(changed.exitCode).toBe(1);
    expect(changed.stdout).toContain("code: WRITE_ERROR");
    expect(changed.stdout).toContain("1 inserted; 1 with an existing _id and different content (first ObjectId('000000000000000000000abd'))");
    expect(changed.stdout).toContain(`To overwrite one: \`mongo-rw-axi update axi_it_rw.notes '{_id: ObjectId('\\''000000000000000000000abd'\\'')}' '<document>' --replace\``);
    expect(await count("notes", { text: "same" })).toBe(1);
    await (await shop()).collection("notes").deleteMany({ text: { $in: ["same", "new"] } });
  });

  it("update changes one or many and gates a --many that matches everything", async () => {
    const one = await rw("update", "orders", '{status: "paid"}', '{$set: {note: "x"}}');
    expect(one.stdout).toBe("update:\n  collection: axi_it_rw.orders\n  matched: 1\n  modified: 1\n");
    expect(await count("orders", { note: "x" })).toBe(1);

    const many = await rw("update", "orders", '{status: "refunded"}', "{$set: {flag: true}}", "--many");
    expect(many.stdout).toContain("matched: 24\n  modified: 24");

    // A counted check, not a syntax check: this filter matches every document.
    const all = await rw("update", "orders", "{_id: {$exists: true}}", "{$set: {flag: false}}", "--many");
    expect(all.stdout).toMatch(/^preview:\n {2}update: "axi_it_rw\.orders \{\$set: \{flag: false\}\}"\n {2}risk: "changes every document \(72\)/);
    expect(await count("orders", { flag: false })).toBe(0);
    const confirmed = await rw("update", "orders", "{_id: {$exists: true}}", "{$set: {flag: false}}", "--many", "--confirm");
    expect(confirmed.stdout).toContain(`matched: ${ORDER_COUNT}`);
    expect(await count("orders", { flag: false })).toBe(ORDER_COUNT);
  });

  it("update takes pipelines, --replace and --upsert, and refuses server-side JavaScript", async () => {
    const pipeline = await rw("update", "orders", '{_id: ObjectId("0000000000000000000003e8")}', '[{$set: {total2: {$multiply: ["$total", 2]}}}]');
    const [major = 0, minor = 0] = await serverVersion();
    if (major * 100 + minor >= 402) expect((await (await shop()).collection("orders").findOne({ total2: { $exists: true } }))?.["total2"]).toBe(20);
    else expect(pipeline.stdout).toContain("Update pipelines need MongoDB 4.2+");

    const replaced = await rw("update", "customers", '{email: "c2@example.test"}', '{email: "c2@example.test", name: "Replaced"}', "--replace");
    expect(replaced.stdout).toContain("modified: 1");
    expect(await (await shop()).collection("customers").findOne({ email: "c2@example.test" })).toEqual({ _id: expect.any(ObjectId), email: "c2@example.test", name: "Replaced" });

    const upserted = await rw("update", "customers", '{email: "new@example.test"}', '{$set: {plan: "free"}}', "--upsert");
    expect(upserted.stdout).toMatch(/matched: 0\n {2}modified: 0\n {2}upserted_id: "?ObjectId\('[0-9a-f]{24}'\)/);

    for (const [filter, update, message] of [
      ['{$where: "true"}', "{$set: {a: 1}}", /\$where runs server-side JavaScript/],
      ["{}", '[{$set: {a: {$function: {body: "function () { return 1 }", args: [], lang: "js"}}}}]', /\$function runs server-side JavaScript/],
      ["{}", "{a: 1}", /the update needs \$operators/],
    ] as const) {
      const { stdout, exitCode } = await rw("update", "orders", filter, update);
      expect(exitCode).toBe(2);
      expect(stdout).toMatch(message);
    }
  });

  it("delete removes one or many and gates a --many that matches everything", async () => {
    await (await shop()).collection("trash").insertMany([{ k: 1 }, { k: 2 }, { k: 3 }, { k: 4 }]);
    expect((await rw("delete", "trash", "{k: 1}")).stdout).toBe("delete:\n  collection: axi_it_rw.trash\n  deleted: 1\n");
    expect((await rw("delete", "trash", "{k: {$gt: 3}}", "--many")).stdout).toContain("deleted: 1");
    const all = await rw("delete", "trash", "{}", "--many");
    expect(all.stdout).toContain("risk: \"irreversible - deletes every document (2); the filter {} matches them all\"");
    expect(await count("trash")).toBe(2);
    expect((await rw("delete", "trash", "{}", "--many", "--confirm")).stdout).toContain("deleted: 2");
    expect(await count("trash")).toBe(0);
    const missing = await rw("delete", "trsh", "{}");
    expect(missing.stdout).toContain("code: NOT_FOUND");
  });
});

describe("indexes, collections and databases", () => {
  it("index create is idempotent and drop previews first", async () => {
    expect((await rw("index", "create", "orders", "{customer_id: 1, created_at: -1}")).stdout).toContain("name: customer_id_1_created_at_-1\n  keys: customer_id 1; created_at -1\n  result: created");
    expect((await rw("index", "create", "orders", "{customer_id: 1, created_at: -1}")).stdout).toContain("result: already exists (no-op)");
    // No document has `expires`, so the TTL monitor deletes nothing mid-test.
    expect((await rw("index", "create", "notes", "{expires: 1}", "--ttl", "3600", "--name", "ttl_expires")).stdout).toContain("result: created");
    expect((await (await shop()).collection("notes").indexes()).find((i) => i.name === "ttl_expires")?.expireAfterSeconds).toBe(3600);

    const preview = await rw("index", "drop", "orders", "customer_id_1_created_at_-1");
    expect(preview.stdout).toMatch(/^preview:\n {2}drop_index: customer_id_1_created_at_-1 on axi_it_rw\.orders/);
    expect((await (await shop()).collection("orders").indexes()).map((i) => i.name)).toContain("customer_id_1_created_at_-1");
    expect((await rw("index", "drop", "orders", "customer_id_1_created_at_-1", "--confirm")).stdout).toContain("result: dropped");
    expect((await rw("index", "drop", "orders", "customer_id_1_created_at_-1")).stdout).toContain("does not exist (no-op)");
    expect((await rw("index", "drop", "orders", "_id_", "--confirm")).stdout).toContain("_id_ index cannot be dropped");
  });

  it("collection create, rename and drop", async () => {
    expect((await rw("collection", "create", "logs", "--capped", "65536", "--max", "10")).stdout).toContain("kind: capped\n  result: created");
    expect((await rw("collection", "create", "logs")).stdout).toContain("already exists (no-op)");
    expect((await rw("collection", "create", "big_orders", "--view-on", "orders", "--pipeline", "[{$match: {total: {$gt: 50}}}]")).stdout).toContain("kind: view");
    expect((await rw("count", "big_orders")).stdout).toBe("count: 31\n");
    const outView = await rw("collection", "create", "bad_view", "--view-on", "orders", "--pipeline", '[{$out: "x"}]');
    expect(outView.exitCode).toBe(2);

    await (await shop()).collection("tmp_a").insertOne({ v: 1 });
    await (await shop()).collection("tmp_b").insertOne({ v: 2 });
    const over = await rw("collection", "rename", "tmp_a", "tmp_b");
    expect(over.stdout).toContain("risk: irreversible - axi_it_rw.tmp_b exists and is dropped first");
    expect((await rw("collection", "rename", "tmp_a", "tmp_b", "--confirm")).stdout).toContain("renamed to tmp_b (the old one was dropped)");
    expect(await (await shop()).collection("tmp_b").findOne({}, { projection: { _id: 0 } })).toEqual({ v: 1 });

    expect((await rw("collection", "rename", "tmp_b", "tmp_c")).stdout).toContain("renamed to tmp_c");
    const repeat = await rw("collection", "rename", "tmp_b", "tmp_c");
    expect(repeat.exitCode).toBe(0);
    expect(repeat.stdout).toContain("already renamed (no-op)");
    const missing = await rw("collection", "rename", "tmp_x", "tmp_y");
    expect(missing.stdout).toContain("code: NOT_FOUND");
    expect((await rw("collection", "rename", "tmp_c", "tmp_b")).stdout).toContain("renamed to tmp_b");

    const drop = await rw("collection", "drop", "tmp_b");
    expect(drop.stdout).toMatch(/risk: irreversible - deletes 1 documents and 1 indexes/);
    expect(await collections()).toContain("tmp_b");
    expect((await rw("collection", "drop", "tmp_b", "--confirm")).stdout).toContain("dropped (1 documents)");
    expect(await collections()).not.toContain("tmp_b");
    expect((await rw("collection", "drop", "tmp_b", "--confirm")).stdout).toContain("does not exist (no-op)");
  });

  it("db drop previews, then drops; the server's databases are refused", async () => {
    expect((await rw("db", "drop", DROP_DB)).stdout).toContain("risk: irreversible - deletes 1 collections");
    expect(await collections(DROP_DB)).toEqual(["a"]);
    expect((await rw("db", "drop", DROP_DB, "--confirm")).stdout).toContain("dropped (1 collections");
    expect(await collections(DROP_DB)).toEqual([]);
    for (const name of ["admin", "local", "config"]) {
      const { stdout, exitCode } = await rw("db", "drop", name, "--confirm");
      expect(exitCode).toBe(1);
      expect(stdout).toContain("code: FORBIDDEN");
    }
  });

  it("refuses system collections and the server's databases for every write", async () => {
    const before = await collections("admin");
    for (const argv of [
      ["insert", "x", "{a: 1}", "-d", "admin", "--create"],
      ["insert", "system.js", "{_id: 'f', value: 1}", "--create"],
      ["collection", "create", "system.views"],
      ["import", "x", file("one.jsonl", "{a: 1}\n"), "-d", "config"],
      ["db.system.users.insertOne({user: 'x'})", "-d", "admin", "--create"],
    ]) {
      const { stdout } = await rw(...argv);
      expect(stdout, argv.join(" ")).toContain("code: FORBIDDEN");
    }
    expect(await collections("admin")).toEqual(before);
    expect(await collections()).not.toContain("system.js");
  });
});

describe("import", () => {
  it("loads JSON Lines and arrays with Extended JSON and batches", async () => {
    const jsonl = file("orders.jsonl", '{"_id": {"$oid": "66f1c2a9e4b0a1b2c3d4e5f6"}, "at": {"$date": "2026-10-01T00:00:00Z"}, "n": {"$numberLong": "5"}}\n\n{"n": 7}\n{n: 8, price: NumberDecimal("1.5")}\n');
    const loaded = await rw("import", "imported", jsonl, "--batch", "2");
    expect(loaded.stdout).toMatch(/^import:\n {2}collection: axi_it_rw\.imported \(created\)\n {2}inserted: 3\n {2}batches: 2\n/);
    expect((await (await shop()).collection("imported").findOne({ _id: new ObjectId("66f1c2a9e4b0a1b2c3d4e5f6") }))?.["at"]).toEqual(new Date("2026-10-01T00:00:00Z"));

    const array = file("orders.json", '[{"k": 1}, {"k": 2}]');
    expect((await rw("import", "imported", array)).stdout).toContain("inserted: 2");
    expect(await count("imported")).toBe(5);
  });

  it("--drop previews, a bad line loads nothing, and a failure mid-way says how far it got", async () => {
    const array = file("again.json", '[{"k": 1}]');
    expect((await rw("import", "imported", array, "--drop")).stdout).toContain("--drop deletes 5 existing documents");
    expect(await count("imported")).toBe(5);
    expect((await rw("import", "imported", array, "--drop", "--confirm")).stdout).toContain("inserted: 1");
    expect(await count("imported")).toBe(1);

    const bad = await rw("import", "imported", file("bad.jsonl", '{"k": 2}\n{"k": \n'));
    expect(bad.exitCode).toBe(2);
    expect(bad.stdout).toContain("line 2");
    expect(await count("imported")).toBe(1);

    const dup = await rw("import", "imported", file("dup.jsonl", '{"_id": 1, "v": "a"}\n{"_id": 2}\n{"_id": 1, "v": "b"}\n{"_id": 3}\n'));
    expect(dup.exitCode).toBe(1);
    expect(dup.stdout).toContain("import stopped - 3 inserted; 1 with an existing _id and different content (first 1) in axi_it_rw.imported");
    expect(dup.stdout).toContain("code: WRITE_ERROR");
    expect(await count("imported")).toBe(4);
  });

  it("a rerun skips documents already loaded with the same content", async () => {
    const path = file("keyed.jsonl", '{"_id": 10, "k": "a"}\n{"_id": 11, "k": "b"}\n{"_id": 12, "k": "c"}\n');
    expect((await rw("import", "keyed", path, "--batch", "2")).stdout).toContain("inserted: 3");
    const again = await rw("import", "keyed", path, "--batch", "2");
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("inserted: 0\n  unchanged: 3 (same _id and content - no-op)");
    expect(await count("keyed")).toBe(3);
  });
});

describe("shell form", () => {
  it("maps write methods onto the same commands and gates", async () => {
    expect((await rw("db.notes.insertOne({text: 'shell'})")).stdout).toContain("inserted: 1");
    const all = await rw("db.notes.updateMany({}, {$set: {seen: true}})");
    expect(all.stdout).toMatch(/^preview:/);
    expect((await rw("db.notes.updateMany({}, {$set: {seen: true}})", "--confirm")).stdout).toContain("modified: 3");
    expect((await rw("db.notes.createIndex({text: 1}, {name: 'by_text'})")).stdout).toContain("result: created");
    expect((await rw("db.notes.deleteOne({text: 'shell'})")).stdout).toContain("deleted: 1");
    expect((await rw("db.notes.findOneAndUpdate({}, {$set: {a: 1}})")).stdout).toContain("use updateOne, then find");
    expect((await rw("db.notes.drop()")).stdout).toMatch(/^preview:\n {2}drop: axi_it_rw\.notes/);
  });

  it("reads still go through the read-only guard", async () => {
    const { stdout, exitCode } = await rw("aggregate", "orders", '[{$out: "stolen"}]');
    expect(exitCode).toBe(2);
    expect(stdout).toContain("code: READ_ONLY");
    expect(await collections()).not.toContain("stolen");
  });
});

describe("write wire guard", () => {
  it("stops what the commands never send, even through the driver", async () => {
    setTool(TOOL);
    const target = await loopbackOnly(targetFromUri(ROOT_URL(), "MONGO_RW_AXI_URL", "env"));
    const attempts: Record<string, (s: Session) => Promise<unknown>> = {
      adminInsert: (s) => s.client.db("admin").collection("x").insertOne({ a: 1 }),
      systemJs: (s) => s.db().collection<{ _id: string }>("system.js").insertOne({ _id: "f" }),
      whereDelete: (s) => s.db().collection("orders").deleteMany({ $where: "true" }),
      renameIntoAdmin: (s) => s.client.db("admin").command({ renameCollection: `${DB}.orders`, to: "admin.orders" }),
      createUser: (s) => s.client.db("admin").command({ createUser: "x", pwd: "x", roles: [] }),
      eval: (s) => s.db().command({ eval: "1" }),
      dropLocal: (s) => s.client.db("local").dropDatabase(),
    };
    for (const [name, attempt] of Object.entries(attempts)) {
      const error = await withSession(target, { wireGuard: writeWireGuard, timeoutMs: 5000 }, attempt).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(error?.message, name).toMatch(/the wire guard stopped '\w+' before it was sent/);
    }
    expect(await count("orders")).toBe(ORDER_COUNT);
    expect(await collections("admin")).not.toContain("orders");
  });
});

describe("loopback rule", () => {
  const withUrl = async (url: string, ...argv: string[]) => {
    process.env["MONGO_RW_AXI_URL"] = url;
    try {
      return await rw(...argv);
    } finally {
      process.env["MONGO_RW_AXI_URL"] = ROOT_URL();
    }
  };

  it("refuses anything but one loopback host before connecting", async () => {
    for (const url of [
      `mongodb://root:pw@10.0.0.5:${serverPort()}/x`,
      "mongodb+srv://u:p@cluster0.example.mongodb.net/x",
      `mongodb://127.0.0.1:${serverPort()},127.0.0.2:${serverPort()}/x`,
      `mongodb://127.0.0.1:${serverPort()}/x?tls=true`,
      `mongodb://127.0.0.1:${serverPort()}/x?proxyHost=127.0.0.1&proxyPort=1080`,
      `mongodb://127.0.0.1:${serverPort()}/x?loadBalanced=true`,
    ]) {
      const { stdout, exitCode } = await withUrl(url, "count", "orders");
      expect(exitCode, url).toBe(1);
      expect(stdout, url).toMatch(/^error: "?refusing .* mongo-rw-axi only connects to one loopback host or unix socket"?\ncode: FORBIDDEN/);
    }
  });

  it("connects through localhost to the checked address, always directly", async () => {
    const url = `mongodb://root:${encodeURIComponent(rootPassword())}@localhost:${serverPort()}/${DB}?authSource=admin&directConnection=false`;
    expect((await withUrl(url, "count", "customers")).stdout).toMatch(/^count: \d+\n$/);
    const target = await loopbackOnly(targetFromUri(url, "x", "env"));
    expect(target.uri).toMatch(/^mongodb:\/\/root@(127\.0\.0\.1|\[::1\]):\d+\/axi_it_rw\?authSource=admin&directConnection=true$/);
  });
});

describe("tunnel check", () => {
  // A replica set reached on a loopback port: its member list says where the data really lives.
  const HOSTNAME = "db1.prod.invalid";
  let container = "";
  let port = 0;
  let client: MongoClient;

  const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf-8" }).trim();
  const memberHost = async (host: string) => {
    const admin = client.db("admin");
    const { config } = await admin.command({ replSetGetConfig: 1 });
    config.members[0].host = host;
    config.version += 1;
    await admin.command({ replSetReconfig: config, force: true });
    for (let tries = 0; ; tries++) {
      const hello = await admin.command({ isMaster: 1 });
      if (hello["hosts"]?.includes(host)) return;
      if (tries > 60) throw new Error(`member host is not ${host} yet`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  const countVia = () => {
    process.env["MONGO_RW_AXI_URL"] = `mongodb://127.0.0.1:${port}/test`;
    return rw("databases", "--all").finally(() => (process.env["MONGO_RW_AXI_URL"] = ROOT_URL()));
  };

  beforeAll(async () => {
    container = docker("run", "-d", "--rm", "--label", "mongo-axi-it", "--hostname", HOSTNAME, "-p", "127.0.0.1::27017", "--tmpfs", "/data/db", inject("mongoImage"), "--replSet", "rs0", "--bind_ip_all");
    port = Number(docker("port", container, "27017/tcp").split("\n")[0]!.split(":").pop());
    const ip = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", container);
    client = new MongoClient(`mongodb://127.0.0.1:${port}/`, { directConnection: true, serverSelectionTimeoutMS: 2000 });
    for (let tries = 0; ; tries++) {
      try {
        await client.db("admin").command({ ping: 1 });
        break;
      } catch (error) {
        if (tries > 120) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    await client.db("admin").command({ replSetInitiate: { _id: "rs0", members: [{ _id: 0, host: `${ip}:27017` }] } });
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    if (container) docker("rm", "-f", container);
  });

  it("refuses a member at a non-loopback address", async () => {
    const { stdout } = await countVia();
    expect(stdout).toMatch(/^error: "?refusing 127\.0\.0\.1:\d+\/test - it answers as replica set 'rs0' whose member \d+\.\d+\.\d+\.\d+:27017 is not a loopback address/);
    expect(stdout).toContain("code: FORBIDDEN");
  });

  it("refuses a member whose dotted name does not resolve here", async () => {
    await memberHost(`${HOSTNAME}:27017`);
    expect((await countVia()).stdout).toContain(`whose member ${HOSTNAME}:27017 does not resolve here`);
  });

  it("accepts a replica set whose members are local", async () => {
    await memberHost("localhost:27017");
    const { stdout } = await countVia();
    expect(stdout).toMatch(/^databases\[\d+\]\{name,collections,size\}:\n {2}admin,/);
  });
}, 180_000);
