import { tool } from "./tool.js";

/** The running command's arguments (after flag hoisting), so hints can repeat its connection flags. */
let invocation: string[] = [];

export function setInvocation(argv: readonly string[]): void {
  // The shell form is routed as `shell <expr>`; the agent typed only the expression.
  invocation = argv[0] === "shell" ? argv.slice(1) : [...argv];
}

const SAFE = /^[\w@%+=:,./-]+$/;

/** POSIX single-quote quoting: the hint pastes back into a shell unchanged. */
export function shellQuote(token: string): string {
  return SAFE.test(token) ? token : `'${token.replace(/'/g, `'\\''`)}'`;
}

function flagValue(argv: readonly string[], long: string, short: string): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") break;
    if ((token === long || token === short) && i + 1 < argv.length) value = argv[++i];
    else if (token.startsWith(`${long}=`)) value = token.slice(long.length + 1);
  }
  return value;
}

/** ` -p staging -d shop` when the running command named them, so a follow-up reads the same place. */
export function connectionFlags(options: { database?: boolean } = {}): string {
  const profile = flagValue(invocation, "--profile", "-p");
  const database = options.database === false ? undefined : flagValue(invocation, "--database", "-d");
  return `${profile ? ` -p ${shellQuote(profile)}` : ""}${database ? ` -d ${shellQuote(database)}` : ""}`;
}

/** `mongo-axi describe <collection> -p staging` - a follow-up command on the same connection. */
export function followUp(rest: string, options: { database?: boolean } = {}): string {
  return `${tool().name} ${rest}${connectionFlags(options)}`;
}

/** Beyond this the agent already has the command; repeating it would only cost tokens. */
const MAX_RERUN = 300;

/**
 * The running command again with `set` flags replaced or added (true = boolean flag),
 * or undefined when it is too long to repeat.
 */
export function rerun(set: Record<string, string | true>, argv: readonly string[] = invocation): string | undefined {
  const kept: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    const name = token.split("=")[0]!;
    if (name in set) {
      if (set[name] !== true && !token.includes("=")) i++;
      continue;
    }
    kept.push(token);
  }
  const added = Object.entries(set).flatMap(([name, value]) => (value === true ? [name] : [name, value]));
  // After a `--` terminator flags would read as positionals.
  const end = kept.indexOf("--");
  kept.splice(end === -1 ? kept.length : end, 0, ...added);
  const text = `${tool().name} ${kept.map(shellQuote).join(" ")}`;
  return text.length <= MAX_RERUN ? text : undefined;
}

/** "Run `<command>`" with the flags set, or a plain instruction when the command is too long to repeat. */
export function rerunHint(set: Record<string, string | true>, why: string): string {
  const command = rerun(set);
  const flags = Object.entries(set)
    .map(([name, value]) => (value === true ? name : `${name} ${value}`))
    .join(" ");
  if (command) return `Run \`${command}\` ${why}`;
  return flags ? `Rerun the same command with ${flags} ${why}` : `Rerun the same command ${why}`;
}
