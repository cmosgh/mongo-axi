import type { Document } from "mongodb";
import { axiError, usageError } from "../../core/src/errors.js";
import { findDenied, readWireGuard, type WireGuard } from "../../core/src/guard.js";

/** The server's own databases: never written by an agent. */
export const PROTECTED_DATABASES = new Set(["admin", "local", "config"]);

/** Why this namespace must not be written; undefined when it may. */
export function protectedNamespace(database: string, collection?: string): string | undefined {
  if (PROTECTED_DATABASES.has(database.toLowerCase())) return `the '${database}' database belongs to the server`;
  // system.js holds stored server-side functions, system.views the view definitions, system.users credentials.
  if (collection !== undefined && collection.toLowerCase().startsWith("system.")) return `${collection} is a system collection`;
  return undefined;
}

export function assertWritable(database: string, collection?: string): void {
  const reason = protectedNamespace(database, collection);
  if (reason) throw axiError(`refusing to write ${collection ? `${database}.${collection}` : database} - ${reason}`, "FORBIDDEN");
}

/** Filters and updates are data: server-side JavaScript and write stages inside them are refused. */
export function assertNoCode(label: string, value: unknown): void {
  const hit = findDenied(value);
  if (hit) {
    throw usageError(`refused - ${hit.reason} (${label}${hit.path ? ` at ${hit.path}` : ""})`, [
      "Filters, updates and pipelines are taken as data; server-side JavaScript ($where, $function, $accumulator) is never sent",
    ]);
  }
}

/** Commands only the write tool sends; everything else goes through the read allowlist. */
export const WRITE_WIRE_COMMANDS = new Set(["insert", "update", "delete", "create", "drop", "dropDatabase", "createIndexes", "dropIndexes", "renameCollection"]);

function bodies(name: string, command: Document): Array<[string, unknown]> {
  if (name === "update") return ((command["updates"] ?? []) as Document[]).flatMap((u, i): Array<[string, unknown]> => [[`updates[${i}].q`, u["q"]], [`updates[${i}].u`, u["u"]]]);
  if (name === "delete") return ((command["deletes"] ?? []) as Document[]).map((d, i): [string, unknown] => [`deletes[${i}].q`, d["q"]]);
  if (name === "create") return [["pipeline", command["pipeline"]], ["validator", command["validator"]]];
  return [];
}

/** The last check before the socket: write commands only on user namespaces, with no code inside. */
export const writeWireGuard: WireGuard = (name, command, database) => {
  if (!WRITE_WIRE_COMMANDS.has(name)) return readWireGuard(name, command, database);
  if (name === "renameCollection") {
    for (const ns of [command["renameCollection"], command["to"]]) {
      const [db = "", ...rest] = String(ns).split(".");
      const reason = protectedNamespace(db, rest.join("."));
      if (reason) return reason;
    }
    return undefined;
  }
  const collection = typeof command[name] === "string" ? (command[name] as string) : undefined;
  const reason = protectedNamespace(database, collection);
  if (reason) return reason;
  for (const [label, value] of bodies(name, command)) {
    const hit = findDenied(value, label);
    if (hit) return `${hit.reason} (${hit.path})`;
  }
  return undefined;
};
