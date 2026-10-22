import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  return { stdout, exitCode };
}

export const ro = (...argv: string[]) => capture(roMain, argv);
export const rw = (...argv: string[]) => capture(rwMain, argv);
