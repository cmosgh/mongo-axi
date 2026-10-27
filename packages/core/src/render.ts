import { decode, encode } from "@toon-format/toon";
import { redactSecrets } from "./secrets.js";

export type Obj = Record<string, unknown>;

/** Encode one structured block as TOON. */
export function block(value: Obj): string {
  return encode(value);
}

let jsonMode = false;

/** `--json`: fenced raw text becomes a string field so the whole payload decodes. */
export function setJsonMode(on: boolean): void {
  jsonMode = on;
}

export const isJsonMode = (): boolean => jsonMode;

/** One suggestion per line: `encode()` would join them into one quoted line. */
export function helpBlock(lines: readonly string[]): string {
  if (lines.length === 0) return "";
  return `help[${lines.length}]:\n${lines.map((l) => `  - ${listItem(l)}`).join("\n")}`;
}

/** Quoted only when a decoder would read the bare line differently (`a: b` is an object item). */
function listItem(line: string): string {
  try {
    if ((decode(`x[1]:\n  - ${line}`, { strict: true }) as { x: unknown[] }).x[0] === line) return line;
  } catch {
    // Falls through to quoting.
  }
  return `"${line.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

/** Join blocks into one stdout payload, skipping empty ones. */
export function out(...blocks: Array<string | false | undefined>): string {
  return blocks.filter((b): b is string => Boolean(b)).join("\n");
}

/** Raw text (plans, validators) between `---` fences after a `key:` label; under `--json` the string field `key`. */
export function fenced(key: string, text: string): string {
  const raw = text.replace(/\s+$/, "");
  return jsonMode ? encode({ [key]: raw }) : `${key}:\n---\n${raw}\n---`;
}

/** `--json` payload: the TOON output decoded; text that is not TOON (help pages) comes back as `{ text }`. */
export function toJson(toon: string): string {
  let value: unknown;
  try {
    value = decode(toon, { strict: true });
  } catch {
    value = { text: toon.trimEnd() };
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function renderErrorOutput(message: string, code: string, suggestions: readonly string[]): string {
  return out(block({ error: message, code }), helpBlock(suggestions));
}

export function humanBytes(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return "unknown";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** Single-line preview of agent input for status blocks. */
export function snippet(text: string, max = 120): string {
  const flat = redactSecrets(text).replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}... (+${flat.length - max} chars)`;
}
