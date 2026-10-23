import { readFileSync } from "node:fs";
import { flag, intFlag, type FlagSpec, type ParsedArgs } from "../args.js";
import { withSession, type Session } from "../connection.js";
import { axiError, usageError } from "../errors.js";
import { assertReadableCollection, readWireGuard } from "../guard.js";
import { resolveTarget, type Target } from "../target.js";
import { followUp, shellQuote } from "../hints.js";
import { tool } from "../tool.js";

/** Accepted by every command that connects. */
export const PROFILE_FLAG: FlagSpec = { name: "--profile", alias: "-p" };
export const DATABASE_FLAG: FlagSpec = { name: "--database", alias: "-d" };
export const CONNECTION_FLAGS: readonly FlagSpec[] = [PROFILE_FLAG, DATABASE_FLAG];
export const TIMEOUT_FLAG: FlagSpec = { name: "--timeout" };
export const CONNECTION_FLAGS_HELP = "-p/--profile <name>, -d/--database <name>";

export const DEFAULT_TIMEOUT_S = 30;
export const MAX_DOCS = 1000;

export function timeoutMs(parsed: ParsedArgs): number {
  return intFlag(parsed, "--timeout", DEFAULT_TIMEOUT_S, { min: 1, max: 3600 }) * 1000;
}

export async function targetFrom(parsed: ParsedArgs): Promise<Target> {
  const profile = flag(parsed, "--profile");
  const database = flag(parsed, "--database");
  return resolveTarget({ ...(profile ? { profile } : {}), ...(database ? { database } : {}) });
}

/** Every read command goes through here: the read wire guard and a server-side time limit. */
export function read<T>(target: Target, parsed: ParsedArgs, fn: (s: Session) => Promise<T>): Promise<T> {
  return withSession(target, { wireGuard: readWireGuard, timeoutMs: timeoutMs(parsed) }, fn);
}

export function requireDatabase(target: Target, usage: string): string {
  if (target.database) return target.database;
  throw usageError("no database selected", [
    `Pass -d <database> (\`${followUp("databases", { database: false })}\` lists them), use <database>.<collection>, or set a database on the profile`,
    `usage: ${usage}`,
  ]);
}

/** Text from a positional, `-` (stdin) or --file. */
export function inputText(parsed: ParsedArgs, positional: string | undefined, what: string, usage: string): string | undefined {
  const file = flag(parsed, "--file");
  if (file !== undefined && positional !== undefined && positional !== "-") throw usageError(`pass the ${what} as an argument or --file, not both`, [`usage: ${usage}`]);
  let text: string;
  if (file === "-" || positional === "-") {
    if (process.stdin.isTTY) throw usageError(`no ${what} on stdin`, [`usage: ${usage}`]);
    text = readFileSync(0, "utf-8");
  } else if (file !== undefined) {
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      throw usageError(`cannot read --file '${file}'`);
    }
  } else if (positional !== undefined) {
    text = positional;
  } else {
    return undefined;
  }
  if (text.trim() === "") throw usageError(`the ${what} is empty`, [`usage: ${usage}`]);
  return text;
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

/** Names that contain the input, are contained in it, or are a typo or two away. */
export function closeNames(input: string, names: readonly string[]): string[] {
  const needle = input.toLowerCase();
  const typos = Math.min(2, Math.floor(needle.length / 3));
  return names
    .filter((name) => {
      const lower = name.toLowerCase();
      return lower.includes(needle) || needle.includes(lower) || editDistance(needle, lower) <= typos;
    })
    .slice(0, 5);
}

export interface Namespace {
  database: string;
  collection: string;
}

/** Collections and views of one database; empty when the account may not list them. */
export async function collectionNames(s: Session, database: string): Promise<string[] | undefined> {
  try {
    const infos = await s.client.db(database).listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray();
    return infos.map((c) => c.name);
  } catch {
    return undefined;
  }
}

/**
 * `orders` in the selected database, or `shop.orders` as database.collection.
 * A missing collection is an error: MongoDB would silently return nothing.
 */
export async function resolveCollection(s: Session, raw: string, usage: string): Promise<Namespace> {
  assertReadableCollection(raw);
  const selected = s.target.database;
  const dot = raw.indexOf(".");
  const split = dot > 0 && dot < raw.length - 1 ? { database: raw.slice(0, dot), collection: raw.slice(dot + 1) } : undefined;
  let names: string[] | undefined;
  if (selected) {
    names = await collectionNames(s, selected);
    if (names === undefined || names.includes(raw)) return { database: selected, collection: raw };
  }
  if (split) {
    assertReadableCollection(split.collection);
    const other = await collectionNames(s, split.database);
    if (other === undefined || other.includes(split.collection)) return split;
    if (!selected) names = other;
  }
  if (!selected && !split) requireDatabase(s.target, usage);
  const where = selected ?? split!.database;
  const close = closeNames(selected ? raw : split!.collection, names ?? []);
  throw axiError(`collection '${raw}' not found in database '${where}'`, "NOT_FOUND", [
    ...(close.length > 0 ? [`did you mean: ${close.join("; ")}`] : []),
    `Run \`${followUp(`collections -d ${shellQuote(where)}`, { database: false })}\` or \`${followUp(`search ${shellQuote(selected ? raw : split!.collection)}`, { database: false })}\``,
  ]);
}
