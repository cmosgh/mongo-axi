import { encode } from "@toon-format/toon";
import { redactSecrets } from "./secrets.js";

export type Obj = Record<string, unknown>;

/** Encode one structured block as TOON. */
export function block(value: Obj): string {
  return encode(value);
}

/** One suggestion per line: `encode()` would join them into one quoted line. */
export function helpBlock(lines: readonly string[]): string {
  if (lines.length === 0) return "";
  return `help[${lines.length}]:\n${lines.map((l) => `  ${l}`).join("\n")}`;
}

/** Join blocks into one stdout payload, skipping empty ones. */
export function out(...blocks: Array<string | false | undefined>): string {
  return blocks.filter((b): b is string => Boolean(b)).join("\n");
}

/** Raw text (plans, validators) goes between fences, never inside a TOON string. */
export function fenced(label: string, text: string): string {
  return `${label}:\n---\n${text.replace(/\s+$/, "")}\n---`;
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
