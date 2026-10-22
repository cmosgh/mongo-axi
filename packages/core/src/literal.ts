import { Binary, BSONRegExp, Decimal128, Double, Int32, Long, MaxKey, MinKey, ObjectId, Timestamp, UUID } from "mongodb";
import { usageError } from "./errors.js";
import { redactSecrets } from "./secrets.js";

export const MAX_INPUT_CHARS = 1_000_000;
const MAX_DEPTH = 100;
const REGEX_OPTIONS = /^[imxsu]*$/;

export type Value = unknown;

/** A plain object built by the parser (never a BSON value instance). */
export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

function setKey(target: Record<string, unknown>, key: string, value: unknown): void {
  // defineProperty: a "__proto__" field stays a field instead of replacing the prototype.
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Mongo dates are UTC; a time without a zone is read as UTC, as mongosh's ISODate does. */
export function parseDate(text: string, label: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(text.trim());
  if (!m) throw usageError(`${label}: invalid date '${text}' - expected ISO 8601 such as 2026-10-01 or 2026-10-01T10:00:00Z`);
  const [, y, mo, d, h = "0", mi = "0", s = "0", frac = "0", zone] = m;
  let ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(frac.padEnd(3, "0").slice(0, 3)));
  if (zone && zone.toUpperCase() !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    ms -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || "0")) * 60_000;
  }
  const date = new Date(ms);
  if (Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(d)) throw usageError(`${label}: invalid date '${text}'`);
  return date;
}

const CTOR_NAMES = [
  "ObjectId",
  "ISODate",
  "Date",
  "NumberLong",
  "Long",
  "NumberInt",
  "Int32",
  "NumberDecimal",
  "Decimal128",
  "Double",
  "UUID",
  "BinData",
  "HexData",
  "Timestamp",
  "RegExp",
  "MinKey",
  "MaxKey",
];

/**
 * Reads JSON, Extended JSON and mongosh-style literals into BSON values - data only, nothing is evaluated.
 * Accepts unquoted keys, single quotes, trailing commas, comments, /regex/flags and the constructors above.
 */
export class Scanner {
  pos = 0;
  private depth = 0;

  constructor(
    readonly text: string,
    readonly label: string,
    maxChars = MAX_INPUT_CHARS,
  ) {
    if (text.length > maxChars) throw usageError(`${label} is longer than ${maxChars} characters`);
  }

  fail(problem: string): never {
    const near = redactSecrets(this.text.slice(Math.max(0, this.pos - 15), this.pos + 15)).replace(/\s+/g, " ");
    throw usageError(`${this.label}: ${problem} at position ${this.pos} (near '${near}')`, [
      `Pass JSON or mongosh syntax, e.g. '{status: "paid", created_at: {$gte: ISODate("2026-10-01")}}'`,
    ]);
  }

  skipSpace(): void {
    for (;;) {
      const c = this.text[this.pos];
      if (c !== undefined && /\s/.test(c)) {
        this.pos++;
      } else if (c === "/" && this.text[this.pos + 1] === "/") {
        const eol = this.text.indexOf("\n", this.pos);
        this.pos = eol === -1 ? this.text.length : eol + 1;
      } else if (c === "/" && this.text[this.pos + 1] === "*") {
        const end = this.text.indexOf("*/", this.pos + 2);
        if (end === -1) this.fail("unterminated comment");
        this.pos = end + 2;
      } else {
        return;
      }
    }
  }

  peek(): string | undefined {
    this.skipSpace();
    return this.text[this.pos];
  }

  eat(char: string): boolean {
    if (this.peek() !== char) return false;
    this.pos++;
    return true;
  }

  expect(char: string, what: string): void {
    if (!this.eat(char)) this.fail(`expected '${char}' ${what}`);
  }

  atEnd(): boolean {
    return this.peek() === undefined;
  }

  identifier(): string | undefined {
    this.skipSpace();
    const m = /^[A-Za-z_$][\w$]*/.exec(this.text.slice(this.pos, this.pos + 256));
    if (!m) return undefined;
    this.pos += m[0].length;
    return m[0];
  }

  value(): Value {
    if (++this.depth > MAX_DEPTH) this.fail(`nesting deeper than ${MAX_DEPTH} levels`);
    try {
      return this.valueInner();
    } finally {
      this.depth--;
    }
  }

  private valueInner(): Value {
    const c = this.peek();
    if (c === undefined) this.fail("expected a value");
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"' || c === "'") return this.string();
    if (c === "/") return this.regex();
    if (c === "-" || c === "+" || c === "." || /[0-9]/.test(c)) return this.number();
    const start = this.pos;
    const word = this.identifier();
    if (word === undefined) this.fail(`unexpected '${c}'`);
    switch (word) {
      case "true":
        return true;
      case "false":
        return false;
      case "null":
        return null;
      case "NaN":
        return Number.NaN;
      case "Infinity":
        return Number.POSITIVE_INFINITY;
      case "undefined":
        this.pos = start;
        this.fail("undefined is not a value - use null");
        break;
      case "new":
        return this.constructorCall(this.identifier() ?? this.fail("expected a constructor after 'new'"));
    }
    if (word === "MinKey" || word === "MaxKey") {
      if (this.eat("(")) this.expect(")", `to close ${word}(`);
      return word === "MinKey" ? new MinKey() : new MaxKey();
    }
    return this.constructorCall(word);
  }

  private object(): Record<string, unknown> {
    this.expect("{", "");
    const result: Record<string, unknown> = {};
    while (!this.eat("}")) {
      this.skipSpace();
      const keyStart = this.pos;
      const c = this.text[this.pos];
      let key: string;
      if (c === '"' || c === "'") key = this.string();
      else {
        const m = /^[\w$][\w$.]*/.exec(this.text.slice(this.pos, this.pos + 1024));
        if (!m) this.fail("expected a key or '}'");
        key = m[0];
        this.pos += key.length;
      }
      if (Object.prototype.hasOwnProperty.call(result, key)) {
        this.pos = keyStart;
        this.fail(`duplicate key '${key}'`);
      }
      this.expect(":", `after key '${key}'`);
      setKey(result, key, this.value());
      if (!this.eat(",")) {
        this.expect("}", "or ',' between fields");
        break;
      }
    }
    return extendedJson(result, this);
  }

  private array(): unknown[] {
    this.expect("[", "");
    const result: unknown[] = [];
    while (!this.eat("]")) {
      result.push(this.value());
      if (!this.eat(",")) {
        this.expect("]", "or ',' between items");
        break;
      }
    }
    return result;
  }

  string(): string {
    this.skipSpace();
    const quote = this.text[this.pos]!;
    let out = "";
    let i = this.pos + 1;
    for (;;) {
      const c = this.text[i];
      if (c === undefined || c === "\n") {
        this.fail("unterminated string");
      }
      if (c === quote) break;
      if (c !== "\\") {
        out += c;
        i++;
        continue;
      }
      const e = this.text[i + 1];
      i += 2;
      switch (e) {
        case "n":
          out += "\n";
          break;
        case "t":
          out += "\t";
          break;
        case "r":
          out += "\r";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "v":
          out += "\v";
          break;
        case "0":
          out += "\0";
          break;
        case "\n":
          break;
        case "x": {
          const hex = this.text.slice(i, i + 2);
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) this.fail("invalid \\x escape");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 2;
          break;
        }
        case "u": {
          const braced = /^\{([0-9a-fA-F]{1,6})\}/.exec(this.text.slice(i, i + 8));
          const hex = braced ? braced[1]! : this.text.slice(i, i + 4);
          if (!braced && !/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("invalid \\u escape");
          const code = parseInt(hex, 16);
          if (code > 0x10ffff) this.fail("invalid \\u escape");
          out += String.fromCodePoint(code);
          i += braced ? braced[0].length : 4;
          break;
        }
        case undefined:
          this.fail("unterminated string");
          break;
        default:
          out += e;
      }
    }
    this.pos = i + 1;
    return out;
  }

  private number(): number | Long {
    this.skipSpace();
    const m = /^[-+]?(?:0[xX][0-9a-fA-F]+|Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/.exec(this.text.slice(this.pos, this.pos + 400));
    if (!m) this.fail("invalid number");
    this.pos += m[0].length;
    const text = m[0].replace(/^\+/, "");
    if (/^-?\d+$/.test(text) && !Number.isSafeInteger(Number(text))) {
      // Integers past 2^53 would lose digits as doubles; keep them exact.
      const long = Long.fromString(text);
      if (long.toString() === text.replace(/^(-?)0+(?=\d)/, "$1")) return long;
    }
    if (/^-?0[xX]/.test(text)) return (text.startsWith("-") ? -1 : 1) * parseInt(text.replace(/^-/, ""), 16);
    return Number(text);
  }

  private regex(): BSONRegExp {
    this.skipSpace();
    let i = this.pos + 1;
    let inClass = false;
    for (;;) {
      const c = this.text[i];
      if (c === undefined || c === "\n") this.fail("unterminated regular expression");
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) break;
      i++;
    }
    const pattern = this.text.slice(this.pos + 1, i);
    const flags = /^[A-Za-z]*/.exec(this.text.slice(i + 1))![0];
    this.pos = i + 1 + flags.length;
    if (pattern === "") this.fail("empty regular expression");
    return regexValue(pattern, flags, this);
  }

  private args(name: string): Value[] {
    this.expect("(", `after ${name}`);
    const args: Value[] = [];
    while (!this.eat(")")) {
      args.push(this.value());
      if (!this.eat(",")) {
        this.expect(")", `to close ${name}(`);
        break;
      }
    }
    return args;
  }

  private constructorCall(name: string): Value {
    if (/^(Code|Function|function|eval|BSONSymbol|Symbol|DBPointer|DBRef)$/.test(name)) {
      this.fail(`${name} is not accepted - only data literals are, never server-side code`);
    }
    if (!CTOR_NAMES.includes(name)) this.fail(`unknown name '${name}' - quote strings; literals: ${CTOR_NAMES.join(", ")}`);
    const args = this.args(name);
    return construct(name, args, this);
  }
}

function regexValue(pattern: string, flags: string, s: Scanner): BSONRegExp {
  const options = [...new Set(flags)].sort().join("");
  if (!REGEX_OPTIONS.test(options)) s.fail(`regex flags '${flags}' - MongoDB accepts i, m, x, s and u`);
  return new BSONRegExp(pattern, options);
}

const str = (v: Value, what: string, s: Scanner): string => (typeof v === "string" ? v : s.fail(`${what} takes a string`));

function integer(v: Value, what: string, s: Scanner): number {
  const n = typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n)) s.fail(`${what} takes an integer`);
  return n;
}

function construct(name: string, args: Value[], s: Scanner): Value {
  const [a, b] = args;
  const arity = (max: number): void => {
    if (args.length > max) s.fail(`${name} takes at most ${max} argument${max === 1 ? "" : "s"}`);
  };
  switch (name) {
    case "ObjectId": {
      arity(1);
      if (a === undefined) return new ObjectId();
      const hex = str(a, "ObjectId", s);
      if (!/^[0-9a-fA-F]{24}$/.test(hex)) s.fail(`ObjectId takes a 24-character hex string, got '${hex}'`);
      return new ObjectId(hex);
    }
    case "ISODate":
    case "Date": {
      arity(1);
      if (a === undefined) return new Date();
      if (typeof a === "number") return new Date(a);
      return parseDate(str(a, name, s), s.label);
    }
    case "NumberLong":
    case "Long": {
      arity(1);
      if (typeof a === "string" && /^-?\d+$/.test(a)) return Long.fromString(a);
      if (a instanceof Long) return a;
      return Long.fromNumber(integer(a, name, s));
    }
    case "NumberInt":
    case "Int32": {
      arity(1);
      const n = integer(a, name, s);
      if (n < -(2 ** 31) || n >= 2 ** 31) s.fail(`${name} is out of the 32-bit range`);
      return new Int32(n);
    }
    case "NumberDecimal":
    case "Decimal128": {
      arity(1);
      if (typeof a !== "string" && typeof a !== "number") s.fail(`${name} takes a string such as '12.50'`);
      try {
        return Decimal128.fromString(String(a));
      } catch {
        return s.fail(`${name}: invalid decimal '${String(a)}'`);
      }
    }
    case "Double": {
      arity(1);
      if (typeof a !== "number") s.fail("Double takes a number");
      return new Double(a);
    }
    case "UUID": {
      arity(1);
      if (a === undefined) return new UUID();
      try {
        return new UUID(str(a, "UUID", s));
      } catch {
        return s.fail(`UUID: invalid value '${String(a)}'`);
      }
    }
    case "BinData":
    case "HexData": {
      arity(2);
      const subtype = integer(a, name, s);
      const data = str(b, `${name}'s second argument`, s);
      return new Binary(Buffer.from(data, name === "BinData" ? "base64" : "hex"), subtype);
    }
    case "Timestamp": {
      arity(2);
      if (isPlainObject(a)) return new Timestamp({ t: integer(a["t"], "Timestamp t", s), i: integer(a["i"], "Timestamp i", s) });
      return new Timestamp({ t: integer(a ?? 0, "Timestamp", s), i: integer(b ?? 0, "Timestamp", s) });
    }
    case "RegExp": {
      arity(2);
      return regexValue(str(a, "RegExp", s), b === undefined ? "" : str(b, "RegExp flags", s), s);
    }
  }
  return s.fail(`unknown name '${name}'`);
}

/** Canonical and relaxed Extended JSON v2 wrappers; query operators such as {$regex, $options} stay as they are. */
function extendedJson(obj: Record<string, unknown>, s: Scanner): Record<string, unknown> {
  const keys = Object.keys(obj);
  if (keys.length === 0 || keys.length > 2 || !keys[0]!.startsWith("$")) return obj;
  const [key] = keys;
  const v = obj[key!];
  const only = keys.length === 1;
  const wrapped = (value: unknown) => value as Record<string, unknown>;
  if (only && key === "$oid") return wrapped(construct("ObjectId", [v], s));
  if (only && key === "$date") {
    if (typeof v === "string") return wrapped(parseDate(v, s.label));
    if (typeof v === "number") return wrapped(new Date(v));
    if (v instanceof Long) return wrapped(new Date(v.toNumber()));
    s.fail("$date takes an ISO string or {$numberLong}");
  }
  if (only && key === "$numberLong") return wrapped(construct("NumberLong", [v], s));
  if (only && key === "$numberInt") return wrapped(construct("NumberInt", [v], s));
  if (only && key === "$numberDouble") {
    const n = typeof v === "string" ? Number(v) : Number.NaN;
    if (typeof v !== "string" || (Number.isNaN(n) && v !== "NaN")) s.fail("$numberDouble takes a numeric string");
    return wrapped(new Double(n));
  }
  if (only && key === "$numberDecimal") return wrapped(construct("NumberDecimal", [v], s));
  if (only && key === "$uuid") return wrapped(construct("UUID", [v], s));
  if (only && key === "$binary" && isPlainObject(v)) {
    return wrapped(new Binary(Buffer.from(str(v["base64"], "$binary.base64", s), "base64"), parseInt(str(v["subType"], "$binary.subType", s), 16)));
  }
  if (key === "$binary" && keys[1] === "$type" && typeof v === "string") {
    return wrapped(new Binary(Buffer.from(v, "base64"), parseInt(str(obj["$type"], "$type", s), 16)));
  }
  if (only && key === "$timestamp" && isPlainObject(v)) return wrapped(construct("Timestamp", [v], s));
  if (only && key === "$regularExpression" && isPlainObject(v)) {
    return wrapped(regexValue(str(v["pattern"], "$regularExpression.pattern", s), v["options"] === undefined ? "" : str(v["options"], "$regularExpression.options", s), s));
  }
  if (only && key === "$minKey") return wrapped(new MinKey());
  if (only && key === "$maxKey") return wrapped(new MaxKey());
  if (keys.some((k) => /^\$(code|symbol|dbPointer|undefined)$/.test(k))) s.fail(`${key} is not accepted - only data literals are, never server-side code`);
  return obj;
}

/** One complete value; trailing text is an error. */
export function parseValue(text: string, label: string, maxChars = MAX_INPUT_CHARS): Value {
  const s = new Scanner(text, label, maxChars);
  if (s.atEnd()) throw usageError(`${label} is empty`);
  const value = s.value();
  s.eat(";");
  if (!s.atEnd()) s.fail("unexpected text after the value");
  return value;
}

export function parseDocument(text: string, label: string): Record<string, unknown> {
  const value = parseValue(text, label);
  if (!isPlainObject(value)) throw usageError(`${label} must be an object such as {status: "paid"}`);
  return value;
}

export function parsePipeline(text: string, label: string): Record<string, unknown>[] {
  const value = parseValue(text, label);
  const stages = isPlainObject(value) ? [value] : value;
  if (!Array.isArray(stages)) throw usageError(`${label} must be an array of stages such as [{$match: {status: "paid"}}]`);
  stages.forEach((stage, i) => {
    if (!isPlainObject(stage) || Object.keys(stage).length !== 1 || !Object.keys(stage)[0]!.startsWith("$")) {
      throw usageError(`${label}: stage ${i + 1} must be an object with one $stage key, such as {$match: {...}}`);
    }
  });
  return stages as Record<string, unknown>[];
}
