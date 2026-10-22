import { usageError } from "./errors.js";

export interface FlagSpec {
  /** Long flag name including dashes, e.g. `--state`. */
  name: string;
  /** Optional short alias, e.g. `-R`. */
  alias?: string;
  /** Boolean flags take no value. */
  boolean?: boolean;
  /** Repeatable value flags collect every occurrence. */
  repeatable?: boolean;
}

export interface ParsedArgs {
  values: Map<string, string[]>;
  bools: Set<string>;
  positionals: string[];
}

/**
 * Flags agents commonly carry over from other CLIs. A targeted hint lets the
 * agent self-correct in one turn instead of scanning the generic flag list.
 */
const RENAMED: Record<string, string> = {
  "--db": "--database",
  "--password": "--password-stdin",
  "--pass": "--password-stdin",
  "--max": "--limit",
  "--rows": "--limit",
  "--docs": "--limit",
  "--yes": "--confirm",
  "--force": "--confirm",
  "--execute": "--confirm",
  "--query": "--filter",
  "--where": "--filter",
  "--match": "--filter",
  "--projection": "--project",
  "--fields": "--project",
  "--select": "--project",
  "--order": "--sort",
  "--offset": "--skip",
  "--url": "--uri",
  "--connection-string": "--uri",
  "--authSource": "--auth-source",
  "--authenticationDatabase": "--auth-source",
  "--context": "--profile",
};

/** Flags agents try for what is a positional argument here. */
const POSITIONAL: Record<string, string> = {
  "--collection": "pass the collection as the first argument (database.collection also works)",
  "-c": "pass the collection as the first argument (database.collection also works)",
  "--pipeline": "pass the pipeline as the argument after the collection, or --file",
};

/**
 * Strict declarative parser: every flag must be declared, unknown flags fail
 * loud with the valid set inline (AXI principle 6). Supports `--flag value`,
 * `--flag=value`, boolean flags, repeatable flags, aliases and a `--`
 * terminator. A bare `-` is a positional (stdin sentinel).
 */
export function parseArgs(
  args: string[],
  specs: readonly FlagSpec[],
  command: string,
): ParsedArgs {
  const byName = new Map<string, FlagSpec>();
  for (const spec of specs) {
    byName.set(spec.name, spec);
    if (spec.alias) byName.set(spec.alias, spec);
  }

  const parsed: ParsedArgs = {
    values: new Map(),
    bools: new Set(),
    positionals: [],
  };
  const unknown: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === "--") {
      parsed.positionals.push(...args.slice(i + 1));
      break;
    }
    if (token === "-" || !token.startsWith("-")) {
      parsed.positionals.push(token);
      continue;
    }

    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);
    if (name === "--help" || name === "-h") continue;

    const spec = byName.get(name);
    if (!spec) {
      if (!unknown.includes(name)) unknown.push(name);
      continue;
    }

    if (spec.boolean) {
      if (inlineValue !== undefined) {
        throw usageError(`${spec.name} does not take a value`, [
          `Run \`${command} --help\``,
        ]);
      }
      parsed.bools.add(spec.name);
      continue;
    }

    let value = inlineValue;
    if (value === undefined) {
      const next = args[i + 1];
      // A following declared flag (or `--`) means the value is missing. Other
      // dash-leading tokens are accepted so bodies like "- item" still work.
      if (next === undefined || next === "--" || byName.has(next)) {
        throw usageError(`${spec.name} requires a value`, [
          `Run \`${command} --help\``,
        ]);
      }
      value = next;
      i++;
    }
    if (value.trim() === "") {
      throw usageError(`${spec.name} requires a non-empty value`);
    }

    const existing = parsed.values.get(spec.name);
    if (existing && !spec.repeatable) {
      throw usageError(`${spec.name} may only be given once`);
    }
    parsed.values.set(spec.name, [...(existing ?? []), value]);
  }

  if (unknown.length > 0) {
    const valid = specs.map((s) => s.name).join(", ") || "(none)";
    const renamed = unknown
      .filter((flag) => RENAMED[flag] && byName.has(RENAMED[flag]!))
      .map((flag) => `${flag} is not supported here; use ${RENAMED[flag]} instead`);
    const positional = unknown.filter((flag) => POSITIONAL[flag]).map((flag) => `${flag} is not a flag - ${POSITIONAL[flag]}`);
    throw usageError(
      `unknown flag${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} for \`${command}\``,
      [
        ...renamed,
        ...positional,
        `valid flags for \`${command}\`: ${valid} (--help always allowed)`,
      ],
    );
  }

  return parsed;
}

export function flag(parsed: ParsedArgs, name: string): string | undefined {
  return parsed.values.get(name)?.[0];
}

export function flags(parsed: ParsedArgs, name: string): string[] {
  return parsed.values.get(name) ?? [];
}

export function bool(parsed: ParsedArgs, name: string): boolean {
  return parsed.bools.has(name);
}

export function requireFlag(
  parsed: ParsedArgs,
  name: string,
  usage: string,
): string {
  const value = flag(parsed, name);
  if (value === undefined) {
    throw usageError(`${name} is required`, [usage]);
  }
  return value;
}

export function intFlag(
  parsed: ParsedArgs,
  name: string,
  fallback: number,
  range: { min: number; max: number },
): number {
  const raw = flag(parsed, name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw usageError(`${name} must be a whole number, got '${raw}'`);
  }
  const value = Number(raw);
  if (value < range.min || value > range.max) {
    throw usageError(`${name} must be between ${range.min} and ${range.max}`);
  }
  return value;
}

export function enumFlag<T extends string>(
  parsed: ParsedArgs,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = flag(parsed, name);
  if (raw === undefined) return fallback;
  const value = raw.toLowerCase() as T;
  if (!allowed.includes(value)) {
    throw usageError(`invalid ${name} '${raw}'`, [
      `valid values: ${allowed.join(", ")}`,
    ]);
  }
  return value;
}

/** Require exactly `count` positionals; extra or missing ones are usage errors. */
export function expectPositionals(
  parsed: ParsedArgs,
  count: number,
  usage: string,
): string[] {
  if (parsed.positionals.length !== count) {
    const problem =
      parsed.positionals.length < count
        ? "missing argument"
        : `unexpected argument '${parsed.positionals[count]}'`;
    throw usageError(problem, [`usage: ${usage}`]);
  }
  return parsed.positionals;
}

/** Parse a comma-separated `--fields` value against the supported extras. */
export function parseFields(
  raw: string | undefined,
  available: readonly string[],
): string[] {
  if (raw === undefined) return [];
  const requested = [
    ...new Set(
      raw
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean),
    ),
  ];
  const bad = requested.filter((f) => !available.includes(f));
  if (bad.length > 0) {
    throw usageError(`unknown field${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}`, [
      `available --fields: ${available.join(", ")}`,
    ]);
  }
  return requested;
}
