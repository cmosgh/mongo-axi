import { isSecretKey, REDACTED } from "./secrets.js";

export const STRING_CHARS = 200;
export const ARRAY_ITEMS = 20;
export const MAX_DEPTH = 8;
const BINARY_BYTES = 32;

export interface DisplayOptions {
  /** No truncation of strings, arrays or depth. */
  full: boolean;
}

type Bson = { _bsontype?: string } & Record<string, unknown>;

const bsonType = (v: unknown): string | undefined =>
  typeof v === "object" && v !== null ? ((v as Bson)._bsontype ?? (v instanceof Date ? "Date" : v instanceof RegExp ? "RegExp" : undefined)) : undefined;

/** `2026-10-01T10:00:00Z`: milliseconds only when they are not zero. */
export const isoDate = (d: Date): string => (Number.isNaN(d.getTime()) ? "Invalid Date" : d.toISOString().replace(".000Z", "Z"));

function scalar(value: Bson, type: string): unknown {
  switch (type) {
    case "ObjectId":
    case "ObjectID":
      return `ObjectId('${(value as unknown as { toHexString(): string }).toHexString()}')`;
    case "Date":
      return `ISODate('${isoDate(value as unknown as Date)}')`;
    case "Long": {
      const text = String(value);
      return Number.isSafeInteger(Number(text)) ? Number(text) : `NumberLong('${text}')`;
    }
    case "Int32":
    case "Double": {
      const n = (value as unknown as { valueOf(): number }).valueOf();
      return Number.isFinite(n) ? n : String(n);
    }
    case "Decimal128":
      return `NumberDecimal('${String(value)}')`;
    case "Binary": {
      const bin = value as unknown as { sub_type: number; length(): number; toString(enc: string): string; toUUID?: () => { toHexString(dash: boolean): string } };
      if (bin.sub_type === 4 && bin.length() === 16 && bin.toUUID) return `UUID('${bin.toUUID().toHexString(true)}')`;
      if (bin.length() > BINARY_BYTES) return `<binary ${bin.length()} bytes>`;
      return `BinData(${bin.sub_type}, '${bin.toString("base64")}')`;
    }
    case "Timestamp": {
      const ts = value as unknown as { t: number; i: number };
      return `Timestamp(${ts.t}, ${ts.i})`;
    }
    case "BSONRegExp": {
      const re = value as unknown as { pattern: string; options: string };
      return `/${re.pattern}/${re.options}`;
    }
    case "RegExp": {
      const re = value as unknown as RegExp;
      return `/${re.source}/${re.flags}`;
    }
    case "MinKey":
    case "MaxKey":
      return type;
    case "Code":
      return "<code>";
    case "BSONSymbol":
      return String(value);
    case "DBRef": {
      const ref = value as unknown as { collection: string; oid: unknown };
      return `DBRef('${ref.collection}', ${String(display(ref.oid, { full: true }))})`;
    }
  }
  return `<${type}>`;
}

const truncateString = (text: string, full: boolean): string =>
  full || text.length <= STRING_CHARS ? text : `${text.slice(0, STRING_CHARS)}... (+${text.length - STRING_CHARS} chars; --full)`;

/**
 * One BSON value as TOON-friendly JS: numbers stay numbers, typed values print in mongosh form
 * (so they can be pasted back into a filter), long strings, long arrays and deep nesting shrink.
 */
export function display(value: unknown, options: DisplayOptions, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return truncateString(value, options.full);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : `NumberLong('${value}')`;
  const type = bsonType(value);
  if (type) return scalar(value as Bson, type);
  if (Array.isArray(value)) {
    if (!options.full && depth >= MAX_DEPTH) return `[${value.length} items; --full]`;
    const shown = options.full ? value : value.slice(0, ARRAY_ITEMS);
    const items = shown.map((v) => display(v, options, depth + 1));
    if (shown.length < value.length) items.push(`... (+${value.length - shown.length} more of ${value.length}; --full)`);
    return items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!options.full && depth >= MAX_DEPTH) return `{${entries.length} fields; --full}`;
    return Object.fromEntries(entries.map(([k, v]) => [k, isSecretKey(k) && v !== null && v !== "" ? REDACTED : display(v, options, depth + 1)]));
  }
  return String(value);
}

/** A whole document for output. */
export const displayDoc = (doc: unknown, options: DisplayOptions): Record<string, unknown> => display(doc, options) as Record<string, unknown>;

/** The type name agents see in `describe` and use in `$type` filters. */
export function typeName(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "double";
  if (Array.isArray(value)) return "array";
  switch (bsonType(value)) {
    case undefined:
      return "object";
    case "ObjectId":
    case "ObjectID":
      return "objectId";
    case "Date":
      return "date";
    case "Long":
      return "long";
    case "Int32":
      return "int";
    case "Double":
      return "double";
    case "Decimal128":
      return "decimal";
    case "Binary":
      return (value as { sub_type?: number }).sub_type === 4 ? "uuid" : "binData";
    case "Timestamp":
      return "timestamp";
    case "BSONRegExp":
    case "RegExp":
      return "regex";
    case "MinKey":
      return "minKey";
    case "MaxKey":
      return "maxKey";
    case "Code":
      return "javascript";
    case "DBRef":
      return "dbRef";
    default:
      return "object";
  }
}

/** Single quotes, so the text needs no escaping inside TOON's double-quoted cells. */
const quote = (text: string): string => `'${JSON.stringify(text).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'`;

const bareKey = (key: string): string => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key));

/**
 * A value as mongosh-style source text (`{status: 'paid', at: ISODate('...')}`), the syntax the parser reads back.
 * Pretty-printed with `indent` spaces once a line would pass 100 characters.
 */
export function shellText(value: unknown, indent = 2, level = 0): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return quote(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  const type = bsonType(value);
  if (type) return String(scalar(value as Bson, type));
  const pad = (n: number): string => " ".repeat(n * indent);
  if (Array.isArray(value)) {
    const items = value.map((v) => shellText(v, indent, level + 1));
    const flat = `[${items.join(", ")}]`;
    if (flat.length + level * indent <= 100 || items.length === 0) return flat;
    return `[\n${items.map((i) => `${pad(level + 1)}${i}`).join(",\n")}\n${pad(level)}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => `${bareKey(k)}: ${shellText(v, indent, level + 1)}`);
    const flat = `{${entries.join(", ")}}`;
    if (flat.length + level * indent <= 100 || entries.length === 0) return flat;
    return `{\n${entries.map((e) => `${pad(level + 1)}${e}`).join(",\n")}\n${pad(level)}}`;
  }
  return String(value);
}

/** `status 1; created_at -1` - an index key pattern without TOON-quoting characters. */
export const keysText = (keys: Record<string, unknown>): string =>
  Object.entries(keys)
    .map(([k, v]) => `${k} ${typeof v === "object" && v !== null ? String(display(v, { full: true })) : String(v)}`)
    .join("; ");
