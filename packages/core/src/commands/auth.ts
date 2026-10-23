import { readFileSync } from "node:fs";
import { ConnectionString } from "mongodb-connection-string-url";
import { bool, expectPositionals, flag, intFlag, parseArgs, requireFlag } from "../args.js";
import { readConfig, writeConfig, type Profile } from "../config.js";
import { withSession } from "../connection.js";
import { axiError, usageError } from "../errors.js";
import { readWireGuard } from "../guard.js";
import { block, helpBlock, out } from "../render.js";
import { clearPassword, describeTarget, loginHint, parseConnectionString, profileTarget, selectedProfile, storePassword, validProfileName } from "../target.js";
import { env, tool } from "../tool.js";

export const authHelp = (): string => {
  const name = tool().name;
  return `usage: ${name} auth <subcommand> [flags]
subcommands[4]:
  status, login, use <profile>, logout
flags{login}:
  --profile <name> (required), --password-stdin | --no-password (one is required), and either
  --uri <connection string without the password> (mongodb:// or mongodb+srv://; options such as replicaSet, tls, authSource stay in it)
  or --host <host> (default 127.0.0.1), --port <port> (default 27017), --user <user>, --auth-source <db>, --tls
  -d/--database <name> (default database for commands)
flags{logout}:
  --profile <name> (default: the active profile)
notes:
  Passwords are read from stdin only and stored in the OS keychain; profiles (non-secret) live in ~/.config/${name}.
  ${tool().envPrefix}_URL=mongodb://user:password@host:port/database overrides the profiles; ${tool().envPrefix}_PROFILE picks one for a single command.
  Login connects first, so a typo never replaces a working profile.
examples:
  printf %s "$DB_PASSWORD" | ${name} auth login --profile atlas --uri 'mongodb+srv://app@cluster0.example.mongodb.net/?appName=dev' -d shop --password-stdin
  printf %s "$DB_PASSWORD" | ${name} auth login --profile dev --host 127.0.0.1 --user app --auth-source admin -d shop --password-stdin
  ${name} auth login --profile local --no-password -d shop
  ${name} auth use dev
  ${name} auth logout --profile dev
`;
};

export async function authCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub === "status") return authStatus(rest);
  if (sub === "login") return authLogin(rest);
  if (sub === "use") return authUse(rest);
  if (sub === "logout") return authLogout(rest);
  throw usageError(sub ? `unknown auth subcommand '${sub}'` : "missing auth subcommand", ["subcommands: status, login, use, logout"]);
}

function describeProfile(name: string, p: Profile): string {
  try {
    return describeTarget(profileTarget(name, p, undefined));
  } catch {
    return "invalid connection string";
  }
}

async function authStatus(args: string[]): Promise<string> {
  const command = `${tool().name} auth status`;
  expectPositionals(parseArgs(args, [], command), 0, command);
  const config = readConfig();
  const active = selectedProfile();
  const profiles = Object.entries(config.profiles ?? {}).map(([name, p]) => ({
    name,
    target: describeProfile(name, p),
    // A hand-edited profile may be null.
    password: p?.password ? "OS keychain" : "none",
    active: name === active,
  }));
  const url = env("URL");
  return out(
    url ? block({ override: `${tool().envPrefix}_URL is set and wins over the profiles` }) : "",
    profiles.length > 0 ? block({ profiles }) : block({ profiles: "none" }),
    helpBlock(profiles.length > 0 || url ? [`Run \`${tool().name} doctor\` to test the connection`] : [loginHint()]),
  );
}

/** The profile's connection string, from --uri or the host flags. Never holds a password. */
function loginUri(parsed: ReturnType<typeof parseArgs>, usage: string): string {
  const uri = flag(parsed, "--uri");
  const hostFlags = ["--host", "--port", "--user", "--auth-source", "--tls"].filter((f) => flag(parsed, f) !== undefined || bool(parsed, f));
  if (uri !== undefined) {
    if (hostFlags.length > 0) throw usageError(`pass --uri or ${hostFlags.join(", ")}, not both`, [`usage: ${usage}`]);
    const cs = parseConnectionString(uri, "--uri");
    if (cs.password) {
      throw usageError("--uri contains a password - it would stay in the shell history", [
        `Drop it from the URI and pipe it instead: printf %s "$DB_PASSWORD" | ${tool().name} auth login ... --password-stdin`,
      ]);
    }
    return cs.toString();
  }
  const host = flag(parsed, "--host") ?? "127.0.0.1";
  const port = intFlag(parsed, "--port", 27017, { min: 1, max: 65_535 });
  if (!/^[A-Za-z0-9._:[\]-]+$/.test(host)) throw usageError(`invalid --host '${host}'`);
  const cs = new ConnectionString(`mongodb://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}/`);
  const user = flag(parsed, "--user");
  if (user) cs.username = encodeURIComponent(user);
  const authSource = flag(parsed, "--auth-source");
  if (authSource) cs.searchParams.set("authSource", authSource);
  if (bool(parsed, "--tls")) cs.searchParams.set("tls", "true");
  return cs.toString();
}

async function authLogin(args: string[]): Promise<string> {
  const command = `${tool().name} auth login`;
  const usage = `${command} --profile <name> (--uri <uri> | --host <host> --user <user>) [-d <database>] --password-stdin|--no-password`;
  const parsed = parseArgs(
    args,
    [
      { name: "--profile" },
      { name: "--uri" },
      { name: "--host" },
      { name: "--port" },
      { name: "--user" },
      { name: "--auth-source" },
      { name: "--database", alias: "-d" },
      { name: "--tls", boolean: true },
      { name: "--password-stdin", boolean: true },
      { name: "--no-password", boolean: true },
    ],
    command,
  );
  expectPositionals(parsed, 0, usage);
  const name = requireFlag(parsed, "--profile", usage);
  if (!validProfileName(name)) throw usageError(`invalid profile name '${name}' - use letters, digits, '.', '_' and '-'`);
  const uri = loginUri(parsed, usage);
  const database = flag(parsed, "--database");
  const fromStdin = bool(parsed, "--password-stdin");
  if (fromStdin === bool(parsed, "--no-password")) throw usageError("pass exactly one of --password-stdin or --no-password", [`usage: ${usage}`]);
  if (fromStdin && !new ConnectionString(uri).username) throw usageError("--password-stdin needs a user - add --user or put it in --uri (mongodb://<user>@host)");

  let password: string | undefined;
  if (fromStdin) {
    if (process.stdin.isTTY) throw usageError(`no password on stdin (${tool().name} never prompts)`, [`usage: printf %s "$DB_PASSWORD" | ${usage}`]);
    password = readFileSync(0, "utf-8").replace(/\r?\n$/, "");
    if (password === "") throw usageError("the password read from stdin is empty - use --no-password for a server without access control");
  }

  const profile: Profile = { uri, ...(database ? { database } : {}), password: fromStdin };
  let target = profileTarget(name, profile, password);
  if (tool().checkTarget) target = await tool().checkTarget!(target);
  // Validate before storing so a typo never replaces a working profile.
  const info = await withSession(target, { wireGuard: readWireGuard, timeoutMs: 10_000 }, async (s) => {
    const admin = s.client.db("admin");
    const status = await admin.command({ connectionStatus: 1 });
    const users = (((status["authInfo"] ?? {}) as Record<string, unknown>)["authenticatedUsers"] ?? []) as Array<{ user: string; db: string }>;
    // Without a user the profile only works on a server without access control.
    if (users.length === 0) {
      try {
        await admin.admin().listDatabases({ nameOnly: true });
      } catch {
        throw axiError("the server requires authentication - the profile was not saved", "AUTH_REQUIRED", [
          `Add --user and pipe the password: printf %s "$DB_PASSWORD" | ${tool().name} auth login --profile ${name} ... --user <user> --password-stdin`,
        ]);
      }
    }
    const build = await admin.command({ buildInfo: 1 });
    return { version: String(build["version"] ?? "unknown"), user: users.map((u) => `${u.user}@${u.db}`).join("; ") || "none" };
  });

  if (password !== undefined) await storePassword(name, password);
  else await clearPassword(name);
  const config = readConfig();
  writeConfig({ ...config, profiles: { ...(config.profiles ?? {}), [name]: profile }, active: name });
  return out(
    block({ auth: { status: "logged in", profile: name, target: describeTarget(target), server: info.version, user: info.user, active: true } }),
    helpBlock([`Run \`${tool().name} doctor\` to check the account's roles`, `Run \`${tool().name}\` for a live overview`]),
  );
}

async function authUse(args: string[]): Promise<string> {
  const command = `${tool().name} auth use`;
  const [name] = expectPositionals(parseArgs(args, [], command), 1, `${command} <profile>`);
  const config = readConfig();
  const profiles = Object.keys(config.profiles ?? {});
  if (!profiles.includes(name!)) throw usageError(`no profile '${name}'`, [`profiles: ${profiles.join(", ") || "none"}`, loginHint()]);
  if (config.active === name) return block({ auth: { active: name, result: "already active (no-op)" } });
  writeConfig({ ...config, active: name! });
  return out(block({ auth: { active: name, result: "switched" } }), helpBlock(env("URL") ? [`${tool().envPrefix}_URL is set and still wins over the profiles`] : []));
}

async function authLogout(args: string[]): Promise<string> {
  const command = `${tool().name} auth logout`;
  const parsed = parseArgs(args, [{ name: "--profile" }], command);
  expectPositionals(parsed, 0, `${command} [--profile <name>]`);
  const config = readConfig();
  const name = flag(parsed, "--profile") ?? config.active;
  const profiles = { ...(config.profiles ?? {}) };
  // A hand-edited null profile still exists and is removed.
  if (!name || profiles[name] === undefined) return block({ auth: { status: "no such profile (no-op)" } });
  const hadPassword = Boolean(profiles[name]?.password);
  if (hadPassword) await clearPassword(name);
  delete profiles[name];
  const active = config.active === name ? Object.keys(profiles)[0] : config.active;
  writeConfig({ ...(active ? { active } : {}), profiles });
  return block({ auth: { profile: name, status: hadPassword ? "removed - password deleted from the OS keychain" : "removed", active: active ?? "none" } });
}
