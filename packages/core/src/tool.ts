import type { ParsedArgs } from "./args.js";
import type { Session } from "./connection.js";
import type { ShellExpr } from "./shell.js";
import type { Target } from "./target.js";

/** Which CLI is running. Each has its own config dir, keychain service and env vars. */
export interface Tool {
  name: string;
  mode: "read-only" | "read-write";
  /** First lines of the home view: what this tool can and cannot do. */
  banner: Record<string, string>;
  /** Env var prefix, e.g. MONGO_AXI -> MONGO_AXI_URL. */
  envPrefix: string;
  /** Vetoes a target before any connection (the write tool's loopback rule). */
  checkTarget?: (target: Target) => Promise<Target>;
  /** Vetoes the server once connected (the write tool's tunnel check). */
  checkServer?: (session: Session) => Promise<void>;
  /** Appended to read-only refusals. */
  writeHint?: string;
  /** Runs shell-form write methods (`db.orders.updateOne(...)`); absent on the read-only tool. */
  shellWrite?: (parsed: ParsedArgs, expr: ShellExpr) => Promise<string>;
}

let current: Tool | undefined;

export function setTool(tool: Tool): void {
  current = tool;
}

export function tool(): Tool {
  if (!current) throw new Error("tool not initialised");
  return current;
}

export function env(suffix: string): string | undefined {
  const value = process.env[`${tool().envPrefix}_${suffix}`];
  return value === "" ? undefined : value;
}
