import { describe, expect, it } from "vitest";
import { setTool } from "../packages/core/src/tool.js";
import { targetFromUri } from "../packages/core/src/target.js";
import { TOOL } from "../packages/mongo-rw-axi/src/cli.js";
import { checkUpdate } from "../packages/mongo-rw-axi/src/commands/docs.js";
import { parseImport } from "../packages/mongo-rw-axi/src/commands/import.js";
import { isLoopback, loopbackOnly, memberProblem, splitHost } from "../packages/mongo-rw-axi/src/loopback.js";
import { protectedNamespace, writeWireGuard } from "../packages/mongo-rw-axi/src/write-guard.js";

setTool(TOOL);
const target = (uri: string) => loopbackOnly(targetFromUri(uri, "MONGO_RW_AXI_URL", "env"));

describe("loopback rule", () => {
  it("recognises loopback addresses and splits host:port", () => {
    for (const a of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) expect(isLoopback(a), a).toBe(true);
    for (const a of ["10.0.0.1", "0.0.0.0", "::", "fe80::1", "128.0.0.1"]) expect(isLoopback(a), a).toBe(false);
    expect(splitHost("[::1]:27017")).toEqual({ host: "::1", port: "27017" });
    expect(splitHost("db:27018")).toEqual({ host: "db", port: "27018" });
    expect(splitHost("localhost")).toEqual({ host: "localhost" });
  });

  it("pins the checked address and forces a direct connection", async () => {
    expect((await target("mongodb://app:pw@127.0.0.1:27017/shop?directConnection=false")).uri).toBe("mongodb://app@127.0.0.1:27017/shop?directConnection=true");
    expect((await target("mongodb://localhost/shop?replicaSet=rs0")).uri).toMatch(/^mongodb:\/\/(127\.0\.0\.1|\[::1\])\/shop\?replicaSet=rs0&directConnection=true$/);
    expect((await target("mongodb://%2Ftmp%2Fmongodb-27017.sock/shop")).uri).toBe("mongodb://%2Ftmp%2Fmongodb-27017.sock/shop?directConnection=true");
  });

  it("refuses remote hosts, SRV, seed lists, TLS, proxies and load balancers", async () => {
    for (const [uri, reason] of [
      ["mongodb://10.0.0.5:27017/x", /host '10\.0\.0\.5' - it is not a loopback address/],
      ["mongodb+srv://u@cluster0.example.mongodb.net/x", /mongodb\+srv/],
      ["mongodb://127.0.0.1:1,127.0.0.1:2/x", /2 hosts/],
      ["mongodb://127.0.0.1/x?tls=true", /tls=true/],
      ["mongodb://127.0.0.1/x?ssl=true", /ssl=true/],
      ["mongodb://127.0.0.1/x?proxyHost=h", /proxyHost/],
      ["mongodb://127.0.0.1/x?loadBalanced=true", /loadBalanced/],
    ] as const) {
      await expect(target(uri), uri).rejects.toThrow(reason);
    }
  });
});

describe("tunnel check", () => {
  it("accepts local members and container names, refuses everything else", async () => {
    for (const member of ["127.0.0.1:27017", "[::1]:27017", "localhost:27017", "host.docker.internal:27017", "mongo1:27017"]) {
      expect(await memberProblem(member), member).toBeUndefined();
    }
    expect(await memberProblem("10.1.2.3:27017")).toBe("is not a loopback address");
    expect(await memberProblem("db1.prod.invalid:27017")).toBe("does not resolve here");
  });
});

describe("write guard", () => {
  it("keeps writes off the server's databases and system collections", () => {
    expect(protectedNamespace("admin")).toMatch(/belongs to the server/);
    expect(protectedNamespace("Config", "x")).toMatch(/belongs to the server/);
    expect(protectedNamespace("shop", "system.js")).toMatch(/system collection/);
    expect(protectedNamespace("shop", "orders")).toBeUndefined();
  });

  it("checks write commands on the wire and falls back to the read allowlist", () => {
    expect(writeWireGuard("insert", { insert: "orders", documents: [{}] }, "shop")).toBeUndefined();
    expect(writeWireGuard("insert", { insert: "x" }, "admin")).toMatch(/admin/);
    expect(writeWireGuard("drop", { drop: "system.views" }, "shop")).toMatch(/system collection/);
    expect(writeWireGuard("dropDatabase", { dropDatabase: 1 }, "local")).toMatch(/local/);
    expect(writeWireGuard("delete", { delete: "orders", deletes: [{ q: { $where: "1" }, limit: 0 }] }, "shop")).toMatch(/server-side JavaScript \(deletes\[0\]\.q\.\$where\)/);
    expect(writeWireGuard("update", { update: "orders", updates: [{ q: {}, u: [{ $set: { a: { $function: {} } } }] }] }, "shop")).toMatch(/\$function/);
    expect(writeWireGuard("renameCollection", { renameCollection: "shop.a", to: "admin.a" }, "admin")).toMatch(/admin/);
    expect(writeWireGuard("renameCollection", { renameCollection: "shop.a", to: "shop.b" }, "admin")).toBeUndefined();
    expect(writeWireGuard("createUser", { createUser: "x" }, "admin")).toMatch(/not a read command/);
    expect(writeWireGuard("find", { find: "orders", filter: {} }, "shop")).toMatch(/without maxTimeMS/);
  });
});

describe("update shapes", () => {
  it("needs operators, a pipeline, or --replace with a plain document", () => {
    expect(() => checkUpdate({ update: { $set: { a: 1 } }, replace: false, many: false })).not.toThrow();
    expect(() => checkUpdate({ update: [{ $set: { a: 1 } }], replace: false, many: true })).not.toThrow();
    expect(() => checkUpdate({ update: { a: 1 }, replace: true, many: false })).not.toThrow();
    expect(() => checkUpdate({ update: { a: 1 }, replace: false, many: false })).toThrow(/needs \$operators/);
    expect(() => checkUpdate({ update: { $set: { a: 1 } }, replace: true, many: false })).toThrow(/without \$operators/);
    expect(() => checkUpdate({ update: { a: 1 }, replace: true, many: true })).toThrow(/drop --many/);
    expect(() => checkUpdate({ update: [{ $set: {}, $unset: "a" }], replace: false, many: false })).toThrow(/array of stages/);
  });
});

describe("import parsing", () => {
  it("reads JSON arrays and JSON Lines with Extended JSON, and names the bad line", () => {
    expect(parseImport('[{"a": 1}, {"b": {"$numberLong": "2"}}]', "f.json")).toHaveLength(2);
    expect(parseImport('{"a": 1}\n\n{"b": 2}\r\n', "f.jsonl")).toEqual([{ a: 1 }, { b: 2 }]);
    expect(() => parseImport('{"a": 1}\n{"b": \n', "f.jsonl")).toThrow(/f\.jsonl line 2/);
    expect(() => parseImport('{"$set": {"a": 1}}', "f.jsonl")).toThrow(/insert takes plain documents/);
    expect(() => parseImport('{"a": {"$code": "1"}}', "f.jsonl")).toThrow(/\$code is not accepted/);
  });
});
