// vitest globalSetup: a throwaway MongoDB in Docker on a random loopback port with access control on,
// so the suite never touches a developer's own server and can create users and drop databases freely.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { MongoClient } from "mongodb";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** mongodb://root:<password>@127.0.0.1:<port>/?authSource=admin */
    mongoRootUrl: string;
    mongoContainer: string;
    mongoImage: string;
  }
}

const IMAGE = process.env["MONGO_AXI_IT_IMAGE"] ?? "mongo:8.0";
const READY_TIMEOUT_MS = 120_000;

const docker = (...args: string[]): string => execFileSync("docker", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function waitUntilReady(url: string, container: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    // The image's init phase listens inside the container only, so an authenticated ping means the real server is up.
    const client = new MongoClient(url, { serverSelectionTimeoutMS: 2000, directConnection: true });
    try {
      await client.db("admin").command({ ping: 1 });
      return;
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`MongoDB container ${container} not ready after ${READY_TIMEOUT_MS / 1000}s: ${String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await client.close().catch(() => {});
    }
  }
}

export default async function setup(project: TestProject): Promise<() => void> {
  try {
    docker("version", "--format", "{{.Server.Version}}");
  } catch {
    throw new Error("the integration tests start their own MongoDB container and need a running Docker daemon");
  }
  const password = randomBytes(12).toString("hex");
  const container = docker(
    "run", "-d", "--rm", "--label", "mongo-axi-it",
    "-e", "MONGO_INITDB_ROOT_USERNAME=root",
    "-e", `MONGO_INITDB_ROOT_PASSWORD=${password}`,
    "-p", "127.0.0.1::27017",
    "--tmpfs", "/data/db",
    IMAGE,
    // Fail points (maxTimeAlwaysTimeOut) prove the time limit is sent without a slow query.
    "--setParameter", "enableTestCommands=1",
  );
  const stop = (): void => {
    try {
      docker("rm", "-f", container);
    } catch {
      // Already gone (--rm).
    }
  };
  try {
    const port = docker("port", container, "27017/tcp").split("\n")[0]!.split(":").pop();
    const url = `mongodb://root:${password}@127.0.0.1:${port}/?authSource=admin`;
    await waitUntilReady(url, container);
    project.provide("mongoRootUrl", url);
    project.provide("mongoContainer", container);
    project.provide("mongoImage", IMAGE);
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}
