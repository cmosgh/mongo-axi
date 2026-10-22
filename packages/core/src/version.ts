// Leaf module: node builtins only. The `--version` fast path imports it.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** package.json sits one level above both src/ (dev) and dist/ (bundle). */
export function readPackageVersion(name: string, metaUrl: string): string {
  const candidate = join(dirname(fileURLToPath(metaUrl)), "..", "package.json");
  if (existsSync(candidate)) {
    const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as { name?: unknown; version?: unknown };
    if (parsed.name === name && typeof parsed.version === "string") return parsed.version;
  }
  throw new Error(`Could not determine ${name} package version`);
}
