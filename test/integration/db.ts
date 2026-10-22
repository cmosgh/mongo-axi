import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { MongoClient, type Db } from "mongodb";
import { inject } from "vitest";
import { useTestEnv } from "../helpers.js";

export const rootUrl = (): string => inject("mongoRootUrl");
export const serverPort = (): number => Number(/:(\d+)\//.exec(rootUrl())![1]);

/** A connection string for `user` on the test server, with `database` as the default. */
export function urlFor(user: string | undefined, password: string | undefined, database?: string): string {
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(password ?? "")}@` : "";
  return `mongodb://${auth}127.0.0.1:${serverPort()}/${database ?? ""}${user ? "?authSource=admin" : ""}`;
}

export const rootPassword = (): string => decodeURIComponent(/root:([^@]+)@/.exec(rootUrl())![1]!);

let client: MongoClient | undefined;

/** Root access that bypasses the tools: fixtures and after-the-fact checks. */
export async function admin(): Promise<MongoClient> {
  client ??= await new MongoClient(rootUrl(), { directConnection: true }).connect();
  return client;
}

export async function closeAdmin(): Promise<void> {
  await client?.close();
  client = undefined;
}

export async function db(name: string): Promise<Db> {
  return (await admin()).db(name);
}

/** A fresh database with both tools pointed at it as root. */
export async function scratchDatabase(name: string, seed?: (db: Db) => Promise<void>): Promise<string> {
  useTestEnv();
  const database = await db(name);
  await database.dropDatabase();
  if (seed) await seed(database);
  process.env["MONGO_AXI_URL"] = urlFor("root", rootPassword(), name);
  process.env["MONGO_RW_AXI_URL"] = urlFor("root", rootPassword(), name);
  return name;
}

/** Creates (or recreates) a user in admin with the given roles. */
export async function createUser(user: string, password: string, roles: Array<{ role: string; db: string }>): Promise<void> {
  const adminDb = await db("admin");
  try {
    await adminDb.command({ dropUser: user });
  } catch {
    // Not there yet.
  }
  await adminDb.command({ createUser: user, pwd: password, roles });
}

export async function serverVersion(): Promise<number[]> {
  const info = await (await db("admin")).command({ buildInfo: 1 });
  return (info["versionArray"] as number[]) ?? String(info["version"]).split(".").map(Number);
}

const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const bins = {
  ro: fileURLToPath(new URL("../../packages/mongo-axi/bin/mongo-axi.ts", import.meta.url)),
  rw: fileURLToPath(new URL("../../packages/mongo-rw-axi/bin/mongo-rw-axi.ts", import.meta.url)),
};

/** The real bin in a child process: stdin, exit codes and process wiring. */
export function spawnCli(which: keyof typeof bins, args: string[], input?: string): { stdout: string; exitCode: number } {
  const result = spawnSync(process.execPath, [tsxCli, bins[which], ...args], { encoding: "utf-8", input: input ?? "", env: process.env });
  return { stdout: result.stdout, exitCode: result.status ?? -1 };
}
