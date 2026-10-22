import { ConnectionString } from "mongodb-connection-string-url";
import { readConfig, type Profile } from "./config.js";
import { axiError, usageError } from "./errors.js";
import { env, tool } from "./tool.js";

export interface Target {
  /** Profile name, or the env var name when the URI came from the environment. */
  label: string;
  source: "env" | "profile";
  /** Connection string without the password. */
  uri: string;
  /** Sent through the driver's auth option, never inside `uri`. */
  password?: string;
  /** Default database: -d, the profile's, then the connection string's path. */
  database?: string;
}

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

async function keychainEntry(profile: string): Promise<KeyringEntry> {
  if (env("NO_KEYCHAIN") === "1") throw axiError(`the OS keychain is disabled (${tool().envPrefix}_NO_KEYCHAIN=1)`, "AUTH_REQUIRED", [`Set ${tool().envPrefix}_URL instead`]);
  try {
    // Loaded lazily: an unsupported platform degrades to the env-var path.
    const { Entry } = await import("@napi-rs/keyring");
    return new Entry(tool().name, profile);
  } catch {
    throw axiError("OS keychain is not available on this system", "AUTH_REQUIRED", [`Set ${tool().envPrefix}_URL in the environment instead`]);
  }
}

export async function storePassword(profile: string, password: string): Promise<void> {
  (await keychainEntry(profile)).setPassword(password);
}

/** Returns true when a stored password was removed. */
export async function clearPassword(profile: string): Promise<boolean> {
  try {
    return (await keychainEntry(profile)).deletePassword();
  } catch {
    return false;
  }
}

export function validProfileName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,62}$/i.test(name);
}

export function loginHint(): string {
  return `Run \`printf %s "$DB_PASSWORD" | ${tool().name} auth login --profile <name> --uri 'mongodb://<user>@<host>:27017/?authSource=admin' --password-stdin\` (or --no-password)`;
}

export const URI_SHAPE = "mongodb://user:password@host:port/database or mongodb+srv://...";

/** Parsed with the driver's own parser, so the hosts checked are the hosts connected to. Errors never echo the URI. */
export function parseConnectionString(raw: string, label: string): ConnectionString {
  let cs: ConnectionString;
  try {
    cs = new ConnectionString(raw);
  } catch {
    throw usageError(`${label} is not a valid connection string - expected ${URI_SHAPE}`);
  }
  if (cs.hosts.length === 0) throw usageError(`${label} has no host - expected ${URI_SHAPE}`);
  return cs;
}

const pathDatabase = (cs: ConnectionString): string | undefined => decodeURIComponent(cs.pathname.replace(/^\//, "")) || undefined;

/** Splits the password off the URI: it travels in the driver's auth option and is never printed. */
export function targetFromUri(raw: string, label: string, source: Target["source"]): Target {
  const cs = parseConnectionString(raw, label);
  const password = cs.password ? decodeURIComponent(cs.password) : undefined;
  cs.password = "";
  const database = pathDatabase(cs);
  return { label, source, uri: cs.toString(), ...(password !== undefined ? { password } : {}), ...(database ? { database } : {}) };
}

export function profileTarget(name: string, profile: Profile, password: string | undefined): Target {
  const target = targetFromUri(profile.uri, `profile '${name}'`, "profile");
  return {
    ...target,
    label: name,
    ...(password ? { password } : {}),
    ...(profile.database ? { database: profile.database } : {}),
  };
}

/** The profile a command uses: --profile, then <PREFIX>_PROFILE, then the active one. */
export function selectedProfile(explicit?: string): string | undefined {
  return explicit ?? env("PROFILE") ?? readConfig().active;
}

/** True when there is anything to connect to, without touching the keychain. */
export function isConfigured(): boolean {
  return Boolean(env("URL")) || Object.keys(readConfig().profiles ?? {}).length > 0;
}

export interface TargetOptions {
  profile?: string;
  database?: string;
}

/** --profile wins over <PREFIX>_URL, which wins over the active profile. */
export async function resolveTarget(options: TargetOptions = {}): Promise<Target> {
  const urlVar = `${tool().envPrefix}_URL`;
  const url = env("URL");
  let target: Target;
  if (url && !options.profile) {
    target = targetFromUri(url, urlVar, "env");
  } else {
    const name = selectedProfile(options.profile);
    const profiles = readConfig().profiles ?? {};
    if (!name) throw axiError("no connection configured", "AUTH_REQUIRED", [loginHint(), `Or set ${urlVar}=${URI_SHAPE.split(" or ")[0]}`]);
    const profile = profiles[name];
    if (!profile) throw usageError(`no profile '${name}'`, [`profiles: ${Object.keys(profiles).join(", ") || "none"}`, loginHint()]);
    let password: string | undefined;
    if (profile.password) {
      password = (await keychainEntry(name)).getPassword() ?? "";
      if (!password) throw axiError(`no password stored for profile '${name}'`, "AUTH_REQUIRED", [loginHint()]);
    }
    target = profileTarget(name, profile, password);
  }
  if (options.database) target = { ...target, database: options.database };
  return tool().checkTarget ? tool().checkTarget!(target) : target;
}

/** `user@host:port,host2:port/db`; never the password. */
export function describeTarget(t: Pick<Target, "uri" | "database">): string {
  const cs = new ConnectionString(t.uri);
  const user = cs.username ? `${decodeURIComponent(cs.username)}@` : "";
  const hosts = cs.hosts.map((h) => decodeURIComponent(h)).join(",");
  return `${user}${hosts}${cs.isSRV ? " (srv)" : ""}${t.database ? `/${t.database}` : ""}`;
}
