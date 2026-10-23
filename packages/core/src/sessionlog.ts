import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { configDir } from "./config.js";
import { tool } from "./tool.js";

/** What one agent session did with this tool: command names and counts, never their arguments. */
export interface SessionSummary {
  ended: string;
  commands: Record<string, number>;
  /** The -p / -d values used most, so the next session starts on the same connection. */
  profile?: string;
  database?: string;
}

interface SessionLog {
  directories: Record<string, SessionSummary>;
}

const MAX_DIRECTORIES = 100;
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;

/** Words between shell separators, with quotes and escapes resolved. Good enough to find our own invocations. */
export function shellSegments(command: string): string[][] {
  const segments: string[][] = [[]];
  let token = "";
  let started = false;
  let quote: string | undefined;
  const end = (): void => {
    if (started) segments[segments.length - 1]!.push(token);
    token = "";
    started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) token += command[++i];
      else token += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < command.length) {
      token += command[++i];
      started = true;
    } else if (";|&()`\n".includes(c)) {
      end();
      segments.push([]);
    } else if (/\s/.test(c)) {
      end();
    } else {
      token += c;
      started = true;
    }
  }
  end();
  return segments.filter((s) => s.length > 0);
}

const WRAPPERS = new Set(["npx", "-y", "--yes", "pnpm", "dlx", "exec", "command", "time", "env", "node"]);
const VALUE_FLAGS = new Set(["-p", "--profile", "-d", "--database", "--timeout"]);

export interface Invocation {
  command: string;
  profile?: string;
  database?: string;
}

/** Resolves a first word to its command name (aliases included); undefined when it is not one. */
export type CommandLookup = (word: string) => string | undefined;

/** This tool's invocations in one shell command line. Unknown first words count as `other`, so no argument is recorded. */
export function findInvocations(commandLine: string, name: string, canonical: CommandLookup): Invocation[] {
  const found: Invocation[] = [];
  for (const words of shellSegments(commandLine)) {
    let i = 0;
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || WRAPPERS.has(words[i]!))) i++;
    const base = (words[i] ?? "").split("/").pop() ?? "";
    if (base !== name && base !== `${name}.js`) continue;
    const invocation: Invocation = { command: "home" };
    let named = false;
    for (let j = i + 1; j < words.length; j++) {
      const word = words[j]!;
      const [flagName, inline] = word.startsWith("--") && word.includes("=") ? [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)] : [word, undefined];
      if (VALUE_FLAGS.has(flagName)) {
        const value = inline ?? words[++j];
        if (flagName === "-p" || flagName === "--profile") invocation.profile = value;
        if (flagName === "-d" || flagName === "--database") invocation.database = value;
        continue;
      }
      if (named) continue;
      if (word === "--help" || word === "-h") invocation.command = "help";
      else if (word === "--version" || word === "-v" || word === "-V") invocation.command = "version";
      if (word.startsWith("-")) continue;
      named = true;
      invocation.command = word.startsWith("db.") ? "shell" : (canonical(word) ?? "other");
    }
    found.push(invocation);
  }
  return found;
}

/** Claude Code transcript lines are JSON; tool calls carry `input.command` for shell tools. */
function* toolCommands(value: unknown): Generator<string> {
  if (Array.isArray(value)) {
    for (const item of value) yield* toolCommands(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record["type"] === "tool_use") {
    const input = record["input"] as Record<string, unknown> | undefined;
    if (typeof input?.["command"] === "string") yield input["command"];
    return;
  }
  for (const key of ["message", "content"]) if (key in record) yield* toolCommands(record[key]);
}

const mostUsed = (values: Array<string | undefined>): string | undefined => {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};

/** Reads a transcript and sums this tool's invocations; undefined when it holds none. */
export async function summarizeTranscript(path: string, canonical: CommandLookup): Promise<SessionSummary | undefined> {
  const name = tool().name;
  if (statSync(path).size > MAX_TRANSCRIPT_BYTES) return undefined;
  const invocations: Invocation[] = [];
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf-8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes(name)) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    for (const command of toolCommands(entry)) invocations.push(...findInvocations(command, name, canonical));
  }
  if (invocations.length === 0) return undefined;
  const commands: Record<string, number> = {};
  for (const inv of invocations) commands[inv.command] = (commands[inv.command] ?? 0) + 1;
  const profile = mostUsed(invocations.map((i) => i.profile));
  const database = mostUsed(invocations.map((i) => i.database));
  return { ended: new Date().toISOString().slice(0, 10), commands, ...(profile ? { profile } : {}), ...(database ? { database } : {}) };
}

const logPath = (): string => join(configDir(), "sessions.json");

function readLog(): SessionLog {
  try {
    const parsed = JSON.parse(readFileSync(logPath(), "utf-8")) as SessionLog;
    return parsed && typeof parsed.directories === "object" ? parsed : { directories: {} };
  } catch {
    return { directories: {} };
  }
}

/** Keeps the latest session per directory, and only the most recent directories. */
export function recordSession(directory: string, summary: SessionSummary): void {
  const log = readLog();
  delete log.directories[directory];
  log.directories[directory] = summary;
  const names = Object.keys(log.directories);
  for (const old of names.slice(0, Math.max(0, names.length - MAX_DIRECTORIES))) delete log.directories[old];
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(logPath(), `${JSON.stringify(log, null, 2)}\n`, { mode: 0o600 });
}

export function lastSession(directory: string): SessionSummary | undefined {
  return existsSync(logPath()) ? readLog().directories[directory] : undefined;
}

/** `2026-10-23 - find 4; describe 2 - profile dev; database shop` */
export function sessionText(summary: SessionSummary): string {
  const commands = Object.entries(summary.commands)
    .sort((a, b) => b[1] - a[1])
    .map(([command, n]) => `${command} ${n}`)
    .join("; ");
  const where = [summary.profile && `profile ${summary.profile}`, summary.database && `database ${summary.database}`].filter(Boolean).join("; ");
  return `${summary.ended} - ${commands}${where ? ` - ${where}` : ""}`;
}
