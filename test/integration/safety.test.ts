// Runs each command of the safety matrix as an agent would - through mongosh, the read-only MCP server
// and mongo-axi - then checks the server for its effect. All three connect as root, like a local dev setup.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ObjectId } from "mongodb";
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { ro, useTestEnv } from "../helpers.js";
import { closeAdmin, db, rootPassword, urlFor } from "./db.js";
import { SAFETY_CASES, type Arm, type Outcome, type SafetyCase } from "./safety-cases.js";

const DB = "safety";
const ORDERS = 10_000;
const STATUSES = ["paid", "pending", "refunded"];
// Its exports map hides package.json, so resolve the bin from the workspace root.
const mcpEntry = fileURLToPath(new URL("../../node_modules/mongodb-mcp-server/dist/esm/index.js", import.meta.url));
const hasMongosh = spawnSync("docker", ["exec", inject("mongoContainer"), "which", "mongosh"]).status === 0;

interface Reply {
  output: string;
  refused: boolean;
  failed: boolean;
}

/** mongosh inside the server's container, as `mongosh --eval` from an agent's shell. */
function viaMongosh(shell: string): Reply {
  const url = `mongodb://root:${encodeURIComponent(rootPassword())}@127.0.0.1:27017/${DB}?authSource=admin`;
  const result = spawnSync("docker", ["exec", inject("mongoContainer"), "mongosh", "--quiet", url, "--eval", shell], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  return { output: result.stdout + result.stderr, refused: false, failed: result.status !== 0 };
}

/** A minimal MCP stdio client: newline-delimited JSON-RPC. */
class McpServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private readonly waiting = new Map<number, (message: Record<string, any>) => void>();
  private nextId = 1;

  constructor() {
    this.child = spawn(process.execPath, [mcpEntry, "--readOnly"], {
      // Telemetry is on by default; the test must not report anything.
      env: { ...process.env, MDB_MCP_CONNECTION_STRING: urlFor("root", rootPassword(), DB), MDB_MCP_TELEMETRY: "disabled", DO_NOT_TRACK: "1" },
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      for (let eol = this.buffer.indexOf("\n"); eol !== -1; eol = this.buffer.indexOf("\n")) {
        const message = JSON.parse(this.buffer.slice(0, eol)) as Record<string, any>;
        this.buffer = this.buffer.slice(eol + 1);
        this.waiting.get(message["id"])?.(message);
      }
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async start(): Promise<void> {
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "safety-test", version: "0" } });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }

  async call(tool: string, args: Record<string, unknown>): Promise<Reply> {
    const { result, error } = await this.request("tools/call", { name: tool, arguments: { connectionId: "preconfigured", database: DB, ...args } });
    const output = error ? String(error.message) : (result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
    const failed = Boolean(error || result?.isError);
    return { output, refused: failed && /not found|readOnly mode|is disabled/.test(output), failed };
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.child.once("exit", () => resolve());
      this.child.kill();
    });
  }
}

async function viaAxi(shell: string): Promise<Reply> {
  const { stdout, exitCode } = await ro(shell);
  return { output: stdout, refused: exitCode === 2, failed: exitCode !== 0 };
}

/** Documents the agent got back, from each tool's own format. */
function rowsReturned(arm: Arm, output: string): number {
  if (arm === "mongosh") return (output.match(/(^|\s)_id: ObjectId\(/gm) ?? []).length;
  if (arm === "mcp") return Number(/Returning (\d+) documents/.exec(output)?.[1] ?? 0);
  return Number(/result\[(\d+)\]/.exec(output)?.[1] ?? 0);
}

const shop = () => db(DB);
const count = async (collection: string, filter = {}) => (await shop()).collection(collection).countDocuments(filter);
const exists = async (collection: string) => (await (await shop()).listCollections({ name: collection }).toArray()).length > 0;

/** The side effect each case would leave on the server; undefined for cases measured by their output. */
const EFFECTS: Record<string, ((reply: Reply, ms: number) => Promise<boolean>) | undefined> = {
  "delete-many": async () => (await count("orders", { status: "refunded" })) === 0,
  "update-all": async () => (await count("orders", { status: "cancelled" })) > 0,
  drop: async () => !(await exists("reviews")),
  out: async () => exists("stolen"),
  merge: async () => (await count("orders", { status: "merged" })) > 0,
  // Five reviews at 600 ms each.
  "where-sleep": async (_reply, ms) => ms >= 2900,
  credentials: async (reply) => /SCRAM-SHA/.test(reply.output),
};

async function observe(arm: Arm, c: SafetyCase): Promise<Outcome> {
  const mcp = arm === "mcp" ? new McpServer() : undefined;
  await mcp?.start();
  const admin = await db("admin");
  // Times out every command that carries maxTimeMS, at once: whether a limit is sent, without a slow query.
  if (c.id === "time-limit") await admin.command({ configureFailPoint: "maxTimeAlwaysTimeOut", mode: "alwaysOn" });
  try {
    const started = Date.now();
    const reply = arm === "mongosh" ? viaMongosh(c.shell) : mcp ? await mcp.call(c.mcp.tool, c.mcp.args) : await viaAxi(c.shell);
    const ms = Date.now() - started;
    const hint = c.hint?.[arm];
    if (hint) expect(reply.output).toContain(hint.contains);
    if (c.outputChars) expect(Math.abs(reply.output.length / c.outputChars[arm] - 1)).toBeLessThan(0.1);
    if (reply.refused) return "refused";
    if (c.kind === "read") return reply.failed ? "failed" : "answered";
    if (c.id === "find-all") return reply.failed ? "failed" : `rows ${rowsReturned(arm, reply.output)}`;
    if (c.id === "time-limit") return /TIMEOUT|MaxTimeMSExpired|exceeded time limit/.test(reply.output) ? "time-limited" : reply.failed ? "failed" : "no time limit";
    return (await EFFECTS[c.id]!(reply, ms)) ? "ran" : "failed";
  } finally {
    if (c.id === "time-limit") await admin.command({ configureFailPoint: "maxTimeAlwaysTimeOut", mode: "off" });
    await mcp?.stop();
  }
}

beforeEach(async () => {
  useTestEnv();
  process.env["MONGO_AXI_URL"] = urlFor("root", rootPassword(), DB);
  const safety = await shop();
  await safety.dropDatabase();
  await safety.collection("orders").insertMany(
    Array.from({ length: ORDERS }, (_, i) => ({
      _id: new ObjectId(i.toString(16).padStart(24, "0")),
      customer: `c${i % 50}`,
      status: STATUSES[i % 3],
      total: 10 + (i % 90),
      created_at: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000),
      note: `order ${i}`,
    })),
  );
  await safety.collection("orders").createIndex({ status: 1 });
  await safety.collection<{ _id: number }>("reviews").insertMany([1, 2, 3, 4, 5].map((n) => ({ _id: n, stars: n })));
});

afterAll(async () => {
  await (await shop()).dropDatabase();
  await closeAdmin();
});

describe.skipIf(!hasMongosh)("safety matrix", () => {
  it.each(SAFETY_CASES.flatMap((c) => (["mongosh", "mcp", "axi"] as const).map((arm) => [c.title, arm, c] as const)))("%s via %s", async (_title, arm, c) => {
    expect(await observe(arm, c)).toBe(c.expected[arm]);
  }, 60_000);
});
