import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { env, tool } from "./tool.js";

/** Non-secret settings only. Passwords live in the OS keychain, never here. */
export interface Profile {
  /** Connection string without a password, e.g. mongodb://app@127.0.0.1:27017/?authSource=admin. */
  uri: string;
  /** Default database for commands without -d. */
  database?: string;
  /** false when the account has no password (local dev without access control). */
  password: boolean;
}

export interface Config {
  active?: string;
  profiles?: Record<string, Profile>;
}

export function configDir(): string {
  const override = env("CONFIG_DIR");
  if (override) return override;
  const xdg = process.env["XDG_CONFIG_HOME"];
  return join(xdg && xdg !== "" ? xdg : join(homedir(), ".config"), tool().name);
}

export function readConfig(): Config {
  const path = join(configDir(), "config.json");
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as Config) : {};
  } catch {
    // A corrupt file must not brick the CLI; treat it as empty.
    return {};
  }
}

export function writeConfig(config: Config): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir(), "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
