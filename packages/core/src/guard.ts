import { axiError } from "./errors.js";
import { isPlainObject } from "./literal.js";

/** Operators and stages refused anywhere in read input, with the reason shown to the agent. */
const DENIED_KEYS: Record<string, string> = {
  $out: "$out writes the pipeline result into a collection",
  $merge: "$merge writes the pipeline result into a collection",
  $where: "$where runs server-side JavaScript",
  $function: "$function runs server-side JavaScript",
  $accumulator: "$accumulator runs server-side JavaScript",
  $changestream: "$changeStream waits for changes and never returns",
  $changestreamsplitlargeevent: "$changeStreamSplitLargeEvent belongs to a change stream",
};

/** Collections whose documents are credentials or signing keys. */
const DENIED_COLLECTIONS = new Set(["system.users", "system.keys"]);

export interface GuardOptions {
  /** Extra suggestion appended to refusals (e.g. where writes can go instead). */
  writeHint?: string;
}

function refuse(reason: string, options: GuardOptions): never {
  throw axiError(`refused by the read-only guard - ${reason}`, "READ_ONLY", [
    "Read-only accepts filters, projections, sorts and pipelines that only read",
    ...(options.writeHint ? [options.writeHint] : []),
  ]);
}

/** Why a key is refused on the read path; case-insensitive, so `$OUT` cannot slip past. */
export function deniedKey(key: string): string | undefined {
  const k = key.toLowerCase();
  if (DENIED_KEYS[k]) return DENIED_KEYS[k];
  if (k.startsWith("$_")) return `${key} is an internal stage or operator`;
  return undefined;
}

/** The collection a `$lookup`, `$graphLookup` or `$unionWith` stage reads, which names it as a value. */
function stageSource(key: string, stage: unknown): unknown {
  const k = key.toLowerCase();
  if (k === "$unionwith") return isPlainObject(stage) ? stage["coll"] : stage;
  if (k !== "$lookup" && k !== "$graphlookup" || !isPlainObject(stage)) return undefined;
  const from = stage["from"];
  return isPlainObject(from) ? from["coll"] : from;
}

const isCode = (v: unknown): boolean => typeof v === "object" && v !== null && (v as { _bsontype?: string })._bsontype === "Code";

/** The first refused key or value at any depth, with its path. */
export function findDenied(value: unknown, path = ""): { path: string; reason: string } | undefined {
  if (isCode(value)) return { path, reason: "BSON code values run server-side JavaScript" };
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findDenied(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!isPlainObject(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    const reason = deniedKey(key);
    if (reason) return { path: here, reason };
    const source = stageSource(key, child);
    if (typeof source === "string" && DENIED_COLLECTIONS.has(source.toLowerCase())) return { path: here, reason: `${source} holds credentials or signing keys` };
    const hit = findDenied(child, here);
    if (hit) return hit;
  }
  return undefined;
}

/** Throws READ_ONLY unless every part of the agent's input only reads. Runs before connecting. */
export function assertReadInput(label: string, value: unknown, options: GuardOptions = {}): void {
  const hit = findDenied(value);
  if (hit) refuse(`${hit.reason} (${label}${hit.path ? ` at ${hit.path}` : ""})`, options);
}

export function assertReadableCollection(collection: string, options: GuardOptions = {}): void {
  if (DENIED_COLLECTIONS.has(collection.toLowerCase())) refuse(`${collection} holds credentials or signing keys`, options);
}

// --- wire guard: the last check, on the exact command document, before it is written to the socket ---

/** Every command the read path may send; anything else is a bug and is stopped. */
export const READ_WIRE_COMMANDS = new Set([
  "find",
  "getMore",
  "killCursors",
  "aggregate",
  "count",
  "distinct",
  "explain",
  "listDatabases",
  "listCollections",
  "listIndexes",
  "dbStats",
  "collStats",
  "buildInfo",
  "buildinfo",
  "connectionStatus",
  "ping",
  "hello",
  "isMaster",
  "ismaster",
  "endSessions",
]);

/** Commands that must carry a server-side time limit. */
const TIMED = new Set(["find", "aggregate", "count", "distinct"]);

export type WireGuard = (name: string, command: Record<string, unknown>, database: string) => string | undefined;

/** Why the read path must not send this command; undefined when it may. */
export const readWireGuard: WireGuard = (name, command) => {
  if (!READ_WIRE_COMMANDS.has(name)) return `'${name}' is not a read command`;
  const inner = name === "explain" && isPlainObject(command["explain"]) ? command["explain"] : command;
  const innerName = Object.keys(inner)[0] ?? "";
  if (name === "explain" && !TIMED.has(innerName)) return `explain of '${innerName}' is not a read`;
  // Explain carries the limit on its inner command, where the server applies it (executionStats runs the query).
  if (TIMED.has(innerName) && typeof inner["maxTimeMS"] !== "number") return `'${innerName}' was sent without maxTimeMS`;
  const collection = typeof inner[innerName] === "string" ? (inner[innerName] as string) : "";
  if (DENIED_COLLECTIONS.has(collection.toLowerCase())) return `${collection} holds credentials or signing keys`;
  for (const part of ["pipeline", "filter", "query", "projection", "sort", "let"]) {
    const hit = findDenied(inner[part], part);
    if (hit) return `${hit.reason} (${hit.path})`;
  }
  return undefined;
};

export function wireRefusal(name: string, reason: string) {
  return axiError(`the wire guard stopped '${name}' before it was sent - ${reason}`, "READ_ONLY", [
    "This is a bug in the tool, not in your input - please report it with the command you ran",
  ]);
}
