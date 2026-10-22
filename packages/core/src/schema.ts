import { isPlainObject } from "./literal.js";
import { typeName } from "./values.js";

export const MAX_PATHS = 200;
const MAX_SCHEMA_DEPTH = 6;

export interface FieldStat {
  path: string;
  /** Type names, most frequent first. */
  types: string[];
  /** Documents (of the sample) that have this path at least once. */
  docs: number;
}

export interface Schema {
  fields: FieldStat[];
  sampled: number;
  /** Paths past MAX_PATHS that were not listed. */
  omitted: number;
}

/** Plain objects and the driver's documents; BSON values (ObjectId, Date, ...) are leaves. */
const isDocument = (v: unknown): v is Record<string, unknown> => isPlainObject(v) || (typeof v === "object" && v !== null && !Array.isArray(v) && typeName(v) === "object" && !("_bsontype" in v));

/** `array<object>`, `array<int|string>`; `array` when empty. */
function arrayType(items: readonly unknown[]): string {
  const types = [...new Set(items.map(typeName))].sort();
  return types.length === 0 ? "array" : `array<${types.join("|")}>`;
}

/**
 * Field paths in Mongo dot notation, their types and how many sampled documents have them.
 * Fields of objects inside arrays use the array's path (`items.sku`), as filters do.
 */
export function inferSchema(docs: readonly unknown[]): Schema {
  const stats = new Map<string, { types: Map<string, number>; docs: number }>();
  let omitted = 0;

  for (const doc of docs) {
    const seen = new Set<string>();
    const visit = (value: unknown, path: string, depth: number): void => {
      let stat = stats.get(path);
      if (!stat) {
        if (stats.size >= MAX_PATHS) {
          omitted++;
          return;
        }
        stat = { types: new Map(), docs: 0 };
        stats.set(path, stat);
      }
      const type = Array.isArray(value) ? arrayType(value) : typeName(value);
      stat.types.set(type, (stat.types.get(type) ?? 0) + 1);
      if (!seen.has(path)) {
        seen.add(path);
        stat.docs++;
      }
      if (depth >= MAX_SCHEMA_DEPTH) return;
      const children = Array.isArray(value) ? value.filter(isDocument) : isDocument(value) ? [value] : [];
      for (const child of children) for (const [key, v] of Object.entries(child)) visit(v, `${path}.${key}`, depth + 1);
    };
    if (!isDocument(doc)) continue;
    for (const [key, child] of Object.entries(doc)) visit(child, key, 1);
  }

  const fields = [...stats.entries()].map(([path, s]) => ({
    path,
    types: [...s.types.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t),
    docs: s.docs,
  }));
  return { fields, sampled: docs.length, omitted };
}

const NUMERIC = new Set(["int", "long", "double", "decimal"]);

/** Types that need different filters: numbers compare across types, array element types and null do not count. */
export function isMixed(types: readonly string[]): boolean {
  const kinds = new Set(types.filter((t) => t !== "null").map((t) => (NUMERIC.has(t) ? "number" : t.startsWith("array") ? "array" : t)));
  return kinds.size > 1;
}
