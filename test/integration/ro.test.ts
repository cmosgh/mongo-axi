import { decode } from "@toon-format/toon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSession, type Session } from "../../packages/core/src/connection.js";
import { readWireGuard } from "../../packages/core/src/guard.js";
import { targetFromUri } from "../../packages/core/src/target.js";
import { setTool } from "../../packages/core/src/tool.js";
import { TOOL } from "../../packages/mongo-axi/src/cli.js";
import { ro } from "../helpers.js";
import { closeAdmin, createUser, db, rootPassword, scratchDatabase, serverPort, spawnCli, urlFor } from "./db.js";
import { ORDER_COUNT, seedShop } from "./fixtures.js";

const DB = "axi_it_ro";
const READER = "axi_it_reader";
const READER_PW = "reader-pw";
const ROOT_URL = () => urlFor("root", rootPassword(), DB);

/** Everything the refusal tests could damage, as one comparable value. */
const snapshot = async () => {
  const shop = await db(DB);
  return {
    collections: (await shop.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort(),
    orders: await shop.collection("orders").find().sort({ _id: 1 }).toArray(),
    customers: await shop.collection("customers").find().sort({ _id: 1 }).toArray(),
    indexes: (await shop.collection("orders").indexes()).map((i) => i.name).sort(),
  };
};

beforeAll(async () => {
  await scratchDatabase(DB, seedShop);
  await createUser(READER, READER_PW, [{ role: "read", db: DB }]);
});

afterAll(async () => {
  await (await db("admin")).command({ dropUser: READER }).catch(() => {});
  await (await db(DB)).dropDatabase();
  await closeAdmin();
});

describe("home", () => {
  it("shows the server and the default database's collections", async () => {
    const { stdout, exitCode } = await ro();
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/\nmode: READ-ONLY/);
    expect(stdout).toMatch(/\nserver: MongoDB \d+\.\d+\.\d+ - standalone\n/);
    expect(stdout).toMatch(new RegExp(`\\ndatabase: ${DB} - 4 collections; 1 views; \\d[\\d.]* [KMG]?B\\n`));
    expect(stdout).toContain("collections[5]: customers,");
    expect(stdout).not.toContain(rootPassword());
  });

  it("lists the largest databases without a default, and takes -d", async () => {
    process.env["MONGO_AXI_URL"] = urlFor("root", rootPassword());
    try {
      const top = await ro();
      expect(top.stdout).toMatch(new RegExp(`\\ndatabases\\[\\d+\\]\\{name,size\\}:\\n(.*\\n)*  ${DB},`));
      expect(top.stdout).toContain("Run `mongo-axi collections -d <database>`");
      const one = await ro("-d", DB);
      expect(one.stdout).toMatch(/^bin: /);
      expect(one.stdout).toContain(`Run \`mongo-axi collections -d ${DB}\` for counts and sizes`);
    } finally {
      process.env["MONGO_AXI_URL"] = ROOT_URL();
    }
  });

  it("reports what it cannot see instead of failing", async () => {
    process.env["MONGO_AXI_URL"] = urlFor(READER, "wrong-pw", DB);
    try {
      const { stdout, exitCode } = await ro();
      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/live: "?unavailable - authentication failed/);
      expect(stdout).toContain("Run `mongo-axi doctor` to diagnose");
    } finally {
      process.env["MONGO_AXI_URL"] = ROOT_URL();
    }
  });
});

describe("hints", () => {
  it("keep -d and give the full rerun command", async () => {
    const cut = await ro("find", "orders", "{}", "--limit", "5", "-d", DB);
    expect(cut.stdout).toContain(`Run \`mongo-axi find orders '{}' -d ${DB} --limit ${ORDER_COUNT}\` to see all`);
    const listed = await ro("collections", "-d", DB);
    expect(listed.stdout).toContain(`Run \`mongo-axi describe <collection> -d ${DB}\``);
    const typo = await ro("find", "ordrs", "-d", DB);
    expect(typo.stdout).toContain(`\`mongo-axi collections -d ${DB}\``);
  });
});

describe("browsing", () => {
  it("databases hides system databases and counts collections without system.*", async () => {
    const { stdout } = await ro("databases");
    expect(stdout).toMatch(new RegExp(`\\n  ${DB},5,`));
    expect(stdout).not.toMatch(/\n {2}admin,/);
    expect(stdout).toMatch(/hidden: \d system databases \(--all\)/);
    expect((await ro("databases", "--all")).stdout).toMatch(/\n {2}admin,\d+,/);
  });

  it("collections tells views and capped collections apart", async () => {
    const { stdout } = await ro("collections");
    expect(stdout).toContain(`database: ${DB}\ntotal: 4 collections; 1 views;`);
    expect(stdout).toMatch(/\n {2}orders,collection,72,/);
    expect(stdout).toMatch(/\n {2}events,capped,1,/);
    expect(stdout).toContain("paid_orders,view,null,null");
    expect((await ro("collections", "--sort", "docs", "--fields", "indexes,validator")).stdout).toMatch(
      /collections\[5\]\{name,kind,docs,size,indexes,validator\}:\n {2}orders,collection,72,[^,]+,3,null/,
    );
  });

  it("describe infers dot paths, flags mixed types and shows indexes, validator and views", async () => {
    const orders = await ro("describe", "orders");
    expect(orders.stdout).toContain(`collection:\n  name: ${DB}.orders\n  docs: 72\n`);
    expect(orders.stdout).toContain("  items,array<object>,100\n  items.sku,string,100\n  items.qty,int,100");
    expect(orders.stdout).toContain("Mixed types (total int|string)");
    expect(orders.stdout).toContain(`customer_id_1,customer_id 1,"partial {status: 'paid'}"`);

    const customers = await ro("describe", "customers", "paid_orders", "events");
    expect(customers.stdout).toContain("  tags,array<string>,20");
    expect(customers.stdout).toContain("validator:\n---\n{$jsonSchema: {bsonType: 'object', required: ['email']");
    expect(customers.stdout).toContain("email_1,email 1,unique");
    expect(customers.stdout).toMatch(/kind: view\n {2}view_on: orders/);
    expect(customers.stdout).toContain("pipeline:\n---\n[{$match: {status: 'paid'}}]\n---");
    expect(customers.stdout).toMatch(/kind: capped[\s\S]*capped: max 100 docs; 1.0 MB/);
  });

  it("names a missing collection with close names instead of returning nothing", async () => {
    const { stdout, exitCode } = await ro("find", "ordrs", "{}");
    expect(exitCode).toBe(1);
    expect(stdout).toContain(`error: collection 'ordrs' not found in database '${DB}'\ncode: NOT_FOUND`);
    expect(stdout).toContain("did you mean: orders");
    const multi = await ro("describe", "orders", "nope");
    expect(multi.stdout).toContain(`${DB}.orders:\n  docs: 72\n`);
    expect(multi.stdout).toContain(`${DB}.nope:\n  status: collection 'nope' not found in database '${DB}'`);
    expect(multi.stdout).toContain(`help[1]:\n  - ${DB}.orders - Mixed types (total int|string)`);
  });

  it("indexes reports usage and unused indexes", async () => {
    const { stdout } = await ro("indexes", "orders");
    expect(stdout).toMatch(/indexes\[3\]\{name,keys,options,size,ops\}:\n {2}_id_,_id 1,null,/);
    expect(stdout).toContain("status_created,status 1; created_at -1,null,");
  });

  it("search finds collection names and sampled field paths", async () => {
    const byName = await ro("search", "ord");
    expect(byName.stdout).toContain(`  ${DB},orders\n  ${DB},paid_orders`);
    const byField = await ro("search", "sku");
    expect(byField.stdout).toContain(`  ${DB}.orders,items.sku,string`);
  });
});

describe("reading documents", () => {
  it("find takes mongosh syntax and prints typed values that paste back", async () => {
    const { stdout } = await ro("find", "orders", '{price: NumberDecimal("12.50")}', "--project", "{price: 1, created_at: 1}");
    expect(stdout).toContain("result[1]{_id,price,created_at}:\n  ObjectId('0000000000000000000003ea'),NumberDecimal('12.50'),\"ISODate('2026-09-03T00:00:00Z')\"");
    const back = await ro("query", "orders", "{_id: ObjectId('0000000000000000000003ea'), created_at: ISODate('2026-09-03T00:00:00Z')}", "--project", "{_id: 1}");
    expect(back.stdout).toContain("result[1]{_id}:\n  ObjectId('0000000000000000000003ea')");
  });

  it("caps results and says how many exist", async () => {
    const { stdout } = await ro("find", "orders", "{}", "--project", "{_id: 1}", "--limit", "2");
    expect(stdout).toMatch(/^docs: 2 of 72 shown\n/);
    expect(stdout).toContain("Run `mongo-axi find orders '{}' --project '{_id: 1}' --limit 72` to see all");
  });

  it("redacts secret fields and shortens long strings and arrays", async () => {
    const { stdout } = await ro("find", "customers", "{password: {$exists: true}}");
    expect(stdout).toContain("password: <redacted>");
    expect(stdout).not.toContain("pbkdf2");
    expect(stdout).toContain("... (+100 chars; --full)");
    expect(stdout).toContain("... (+10 more of 30; --full)");
    const full = await ro("find", "customers", "{password: {$exists: true}}", "--full");
    expect(full.stdout).toContain("x".repeat(300));
    expect(full.stdout).toContain("password: <redacted>");
  });

  it("runs the mongosh shell form as data", async () => {
    const { stdout } = await ro('db.orders.find({status: "paid"}, {status: 1}).sort({_id: 1}).limit(2)');
    expect(stdout).toContain("docs: 2 of 24 shown\nresult[2]{_id,status}:\n  ObjectId('0000000000000000000003e8'),paid\n  ObjectId('0000000000000000000003eb'),paid");
    expect((await ro(`db.getSiblingDB("${DB}").orders.countDocuments({status: "paid"})`)).stdout).toContain("count: 24");
  });

  it("never evaluates the shell form", async () => {
    for (const expr of ["db.orders.find({}); db.dropDatabase()", "db.orders.find(this.constructor)", "db.orders.find({}).forEach(function (d) { d })"]) {
      const { stdout, exitCode } = await ro(expr);
      expect(exitCode, expr).toBe(2);
      expect(stdout, expr).toMatch(/code: (VALIDATION_ERROR|READ_ONLY)/);
    }
  });

  it("count, distinct and aggregate", async () => {
    expect((await ro("count", "orders", '{status: "paid"}')).stdout).toBe("count: 24\n");
    expect((await ro("count", "orders", "--estimate")).stdout).toContain(`count: ${ORDER_COUNT}\nestimate: from collection metadata`);
    expect((await ro("distinct", "orders", "status")).stdout).toContain("values[3]: paid,pending,refunded");
    const agg = await ro("aggregate", "orders", '[{$group: {_id: "$status", n: {$sum: 1}}}, {$sort: {_id: 1}}]');
    expect(agg.stdout).toBe("result[3]{_id,n}:\n  paid,24\n  pending,24\n  refunded,24\n");
    expect((await ro("count", `${DB}.orders`, "-d", "admin")).stdout).toBe(`count: ${ORDER_COUNT}\n`);
  });

  it("explain shows the plan and why a scan is slow", async () => {
    const scan = await ro("explain", "orders", "{total: 5}");
    expect(scan.stdout).toContain("COLLSCAN filter {total: {$eq: 5}}");
    expect(scan.stdout).toContain("an index on total would let it use IXSCAN");
    const indexed = await ro("explain", "orders", '{status: "paid"}', "--analyze");
    expect(indexed.stdout).toContain("IXSCAN status_created (status 1; created_at -1)");
    expect(indexed.stdout).toMatch(/returned: 24\nkeys_examined: 24\ndocs_examined: 24/);
  });
});

describe("machine-readable output", () => {
  const json = async (...argv: string[]) => JSON.parse((await ro(...argv, "--json")).stdout) as Record<string, any>;

  it("--json carries fenced raw text as string fields", async () => {
    const plan = await json("explain", "orders", "{total: 5}");
    expect(plan["plan"]).toBe("COLLSCAN filter {total: {$eq: 5}}");
    expect(plan["help"][0]).toContain("an index on total");
    const customers = await json("describe", "customers");
    expect(customers["collection"]).toMatchObject({ name: `${DB}.customers` });
    expect(customers["validator"]).toMatch(/^\{\$jsonSchema: \{bsonType: 'object'/);
    const many = await json("describe", "customers", "paid_orders", "nope");
    expect(many[`${DB}.customers`]["validator"]).toMatch(/^\{\$jsonSchema/);
    expect(many[`${DB}.paid_orders`]).toMatchObject({ kind: "view", view_on: "orders", pipeline: "[{$match: {status: 'paid'}}]" });
    expect(many[`${DB}.nope`]["status"]).toContain("not found");
  });

  it("--json decodes the same object TOON shows, and document field names stay inside result", async () => {
    const pipeline = '[{$sort: {_id: 1}}, {$limit: 2}, {$project: {_id: 0, help: "$status", "code: x": "$status", docs: "$total"}}]';
    const toon = await ro("aggregate", "orders", pipeline);
    expect(await json("aggregate", "orders", pipeline)).toEqual(decode(toon.stdout, { strict: true }));
    expect(Object.keys(await json("aggregate", "orders", pipeline))).toEqual(["result"]);
    expect((await json("find", "orders", "{}", "--limit", "1", "--project", "{_id: 1}"))["result"]).toEqual([{ _id: "ObjectId('0000000000000000000003e8')" }]);
  });
});

describe("read-only guard", () => {
  it("refuses writes, server-side JavaScript and credential collections before connecting", async () => {
    const before = await snapshot();
    const cases: Array<[string[], RegExp]> = [
      [["aggregate", "orders", '[{$match: {}}, {$out: "stolen"}]'], /\$out writes/],
      [["aggregate", "orders", '[{$facet: {a: [{$MERGE: {into: "stolen"}}]}}]'], /\$merge writes/],
      [["aggregate", "orders", '[{$lookup: {from: "customers", pipeline: [{$out: "stolen"}], as: "x"}}]'], /\$out writes/],
      [["find", "orders", '{$where: "sleep(10000) || true"}'], /\$where runs server-side JavaScript/],
      [["find", "orders", '{$expr: {$function: {body: "function () { return true }", args: [], lang: "js"}}}'], /\$function runs/],
      [["aggregate", "orders", '[{$group: {_id: 1, a: {$accumulator: {init: "function () {}", lang: "js"}}}}]'], /\$accumulator runs/],
      [["aggregate", "orders", "[{$changeStream: {}}]"], /\$changeStream/],
      [["aggregate", "orders", "[{$_internalInhibitOptimization: {}}]"], /internal stage/],
      [["find", "orders", '{x: Code("1")}'], /Code is not accepted/],
      [["find", "orders", '{x: {$code: "1"}}'], /\$code is not accepted/],
      [["find", "admin.system.users", "{}"], /system\.users holds credentials/],
      [["aggregate", "orders", '[{$unionWith: "system.users"}]', "-d", "admin"], /system\.users holds credentials/],
      [["aggregate", "orders", '[{$lookup: {from: "system.keys", pipeline: [], as: "k"}}]'], /system\.keys holds credentials/],
      [["explain", "orders", "--pipeline", '[{$out: "stolen"}]'], /\$out writes/],
      [["db.orders.deleteMany({})"], /deleteMany\(\) writes/],
      [["db.orders.drop()"], /drop\(\) writes/],
      [["db.orders.insertOne({x: 1})"], /insertOne\(\) writes/],
    ];
    for (const [argv, message] of cases) {
      const { stdout, exitCode } = await ro(...argv);
      expect(exitCode, argv.join(" ")).toBe(2);
      expect(stdout, argv.join(" ")).toMatch(message);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("the wire guard stops write commands sent through the driver itself", async () => {
    setTool(TOOL);
    const before = await snapshot();
    const target = targetFromUri(ROOT_URL(), "MONGO_AXI_URL", "env");
    const attempts: Record<string, (s: Session) => Promise<unknown>> = {
      insertOne: (s) => s.db().collection("orders").insertOne({ x: 1 }),
      updateMany: (s) => s.db().collection("orders").updateMany({}, { $set: { status: "x" } }),
      deleteMany: (s) => s.db().collection("orders").deleteMany({}),
      drop: (s) => s.db().collection("orders").drop(),
      dropDatabase: (s) => s.db().dropDatabase(),
      createIndex: (s) => s.db().collection("orders").createIndex({ total: 1 }),
      findOneAndDelete: (s) => s.db().collection("orders").findOneAndDelete({}),
      $out: (s) => s.db().collection("orders").aggregate([{ $out: "stolen" }], { maxTimeMS: 1000 }).toArray(),
      untimedFind: (s) => s.db().collection("orders").find({}).toArray(),
      systemUsers: (s) => s.client.db("admin").collection("system.users").find({}, { maxTimeMS: 1000 }).toArray(),
      runCommand: (s) => s.db().command({ create: "stolen" }),
    };
    for (const [name, attempt] of Object.entries(attempts)) {
      const error = await withSession(target, { wireGuard: readWireGuard, timeoutMs: 5000 }, attempt).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(error?.message, name).toMatch(/the wire guard stopped '\w+' before it was sent/);
    }
    expect(await snapshot()).toEqual(before);
  });
});

describe("server facts", () => {
  it("doctor warns when the credentials can write and verifies the wire guard", async () => {
    const { stdout, exitCode } = await ro("doctor");
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^warning: these credentials can write/);
    expect(stdout).toContain("privileges: write-capable - insert; update; remove;");
    expect(stdout).toContain("wire_guard: verified");
    expect(stdout).toContain("roles: root@admin");
  });

  it("doctor reports a read-role user as read-only", async () => {
    process.env["MONGO_AXI_URL"] = urlFor(READER, READER_PW, DB);
    try {
      const { stdout } = await ro("doctor");
      expect(stdout).not.toContain("warning:");
      expect(stdout).toContain(`user: ${READER}@admin`);
      expect(stdout).toContain("privileges: read-only");
      expect((await ro("count", "orders")).stdout).toBe(`count: ${ORDER_COUNT}\n`);
    } finally {
      process.env["MONGO_AXI_URL"] = ROOT_URL();
    }
  });

  it("sends a server-side time limit and reports a timeout", async () => {
    const admin = await db("admin");
    await admin.command({ configureFailPoint: "maxTimeAlwaysTimeOut", mode: "alwaysOn" });
    try {
      const { stdout } = await ro("find", "orders", "{}");
      expect(stdout).toContain("code: TIMEOUT");
    } finally {
      await admin.command({ configureFailPoint: "maxTimeAlwaysTimeOut", mode: "off" });
    }
  });

  it("opens at most one monitor and two pooled connections per command", async () => {
    const admin = await db("admin");
    const created = async () => Number((await admin.command({ serverStatus: 1 })).connections.totalCreated);
    const before = await created();
    // collections fans storage stats out 8 wide: the pool cap must hold anyway.
    expect((await ro("collections")).exitCode).toBe(0);
    expect((await created()) - before).toBeLessThanOrEqual(3);
  });

  it("reports a wrong password as AUTH_REQUIRED without echoing it", async () => {
    process.env["MONGO_AXI_URL"] = urlFor("root", "wrong-pw-123", DB);
    try {
      const { stdout } = await ro("count", "orders");
      expect(stdout).toContain("code: AUTH_REQUIRED");
      expect(stdout).not.toContain("wrong-pw-123");
    } finally {
      process.env["MONGO_AXI_URL"] = ROOT_URL();
    }
  });
});

describe("auth", () => {
  it("refuses a password in --uri", async () => {
    const { stdout, exitCode } = await ro("auth", "login", "--profile", "it", "--uri", ROOT_URL(), "--no-password");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("--uri contains a password");
    expect(stdout).not.toContain(rootPassword());
  });

  it("saves a profile only after connecting and authenticating", async () => {
    const down = await ro("auth", "login", "--profile", "down", "--host", "127.0.0.1", "--port", "1", "--no-password");
    expect(down.stdout).toContain("code: NETWORK");
    const anon = await ro("auth", "login", "--profile", "anon", "--host", "127.0.0.1", "--port", String(serverPort()), "--no-password");
    expect(anon.stdout).toContain("code: AUTH_REQUIRED");

    const login = ["auth", "login", "--profile", "reader", "--host", "127.0.0.1", "--port", String(serverPort()), "--user", READER, "--auth-source", "admin", "-d", DB, "--password-stdin"];
    const wrong = spawnCli("ro", login, "nope\n");
    expect(wrong.stdout).toContain("code: AUTH_REQUIRED");
    // The password checks out; storing it then hits the disabled test keychain, so nothing is saved.
    const ok = spawnCli("ro", login, `${READER_PW}\n`);
    expect(ok.stdout).toContain("the OS keychain is disabled");
    expect((await ro("auth", "status")).stdout).toContain("profiles: none");
  }, 40_000);
});
