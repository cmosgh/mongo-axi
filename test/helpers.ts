import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { expect } from "vitest";
import { main as roMain } from "../packages/mongo-axi/src/cli.js";
import { main as rwMain } from "../packages/mongo-rw-axi/src/cli.js";

export const RO_URL = "mongodb://agent:s3cret@127.0.0.1:27017/shop?authSource=admin";
export const RW_URL = "mongodb://127.0.0.1:27017/shop";

/** Env-only config so tests never touch the real keychain or ~/.config. */
export function useTestEnv(): void {
  for (const prefix of ["MONGO_AXI", "MONGO_RW_AXI"]) {
    process.env[`${prefix}_CONFIG_DIR`] = mkdtempSync(join(tmpdir(), "mongo-axi-test-"));
    process.env[`${prefix}_NO_KEYCHAIN`] = "1";
    delete process.env[`${prefix}_PROFILE`];
  }
  process.env["MONGO_AXI_URL"] = RO_URL;
  process.env["MONGO_RW_AXI_URL"] = RW_URL;
}

async function capture(main: typeof roMain, argv: string[]): Promise<{ stdout: string; exitCode: number }> {
  let stdout = "";
  process.exitCode = 0;
  await main({ argv, stdout: { write: (chunk: string) => (stdout += chunk) } });
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  assertDecodes(argv, stdout);
  return { stdout, exitCode };
}

/** Every payload is strict TOON, except help pages and fenced raw text; --json is always JSON. */
function assertDecodes(argv: string[], stdout: string): void {
  if (argv.includes("--json")) {
    expect(() => JSON.parse(stdout), stdout).not.toThrow();
    return;
  }
  const helpPage = argv.some((a) => a === "--help" || a === "-h") || ["-v", "-V", "--version"].includes(argv[0] ?? "");
  if (helpPage || /^---$/m.test(stdout) || stdout === "") return;
  expect(() => decode(stdout, { strict: true }), stdout).not.toThrow();
}

export const ro = (...argv: string[]) => capture(roMain, argv);
export const rw = (...argv: string[]) => capture(rwMain, argv);
