import { runAxiCli } from "axi-sdk-js";
import { authCommand, authHelp } from "./commands/auth.js";
import { collectionsCommand, collectionsHelp, databasesCommand, databasesHelp, describeCommand, describeHelp, indexesCommand, indexesHelp, searchCommand, searchHelp } from "./commands/browse.js";
import { contextCommand, contextHelp } from "./commands/context.js";
import { doctorCommand, doctorHelp } from "./commands/doctor.js";
import { homeCommand, homeHeader, homeHelp } from "./commands/home.js";
import {
  aggregateCommand,
  aggregateHelp,
  countCommand,
  countHelp,
  distinctCommand,
  distinctHelp,
  explainCommand,
  explainHelp,
  queryCommand,
  queryHelp,
  sampleCommand,
  sampleHelp,
} from "./commands/query.js";
import { setupCommand, setupHelp } from "./commands/setup.js";
import { shellCommand, shellHelp } from "./commands/shell-form.js";
import { AxiError, axiError, exitCodeForError } from "./errors.js";
import { setInvocation } from "./hints.js";
import { out, renderErrorOutput, setJsonMode, toJson } from "./render.js";
import { isShellForm } from "./shell.js";
import { setTool, tool, type Tool } from "./tool.js";

export interface Command {
  run: (args: string[]) => Promise<string>;
  help: () => string;
}

/** Commands both CLIs share; all of them read through the read wire guard. */
export const READ_COMMANDS: Record<string, Command> = {
  databases: { run: databasesCommand, help: databasesHelp },
  collections: { run: collectionsCommand, help: collectionsHelp },
  describe: { run: describeCommand, help: describeHelp },
  indexes: { run: indexesCommand, help: indexesHelp },
  search: { run: searchCommand, help: searchHelp },
  sample: { run: sampleCommand, help: sampleHelp },
  query: { run: queryCommand, help: queryHelp },
  count: { run: countCommand, help: countHelp },
  distinct: { run: distinctCommand, help: distinctHelp },
  aggregate: { run: aggregateCommand, help: aggregateHelp },
  explain: { run: explainCommand, help: explainHelp },
  doctor: { run: doctorCommand, help: doctorHelp },
  auth: { run: authCommand, help: authHelp },
  setup: { run: setupCommand, help: setupHelp },
};

/** Names agents carry over from mongosh and SQL tools. */
const ALIASES: Record<string, string> = {
  find: "query",
  dbs: "databases",
  colls: "collections",
  tables: "collections",
  desc: "describe",
  schema: "describe",
  agg: "aggregate",
};

const SHELL = "shell";

/** `tool 'db.orders.find({...})'` runs the shell form: parsed as data, never evaluated. */
export function routeShell(argv: string[]): string[] {
  const [first] = argv;
  return first !== undefined && isShellForm(first) ? [SHELL, ...argv] : argv;
}

const FRONT_ONLY = new Set(["--help", "-h", "--version", "-V", "-v"]);

const HOME = "home";

/**
 * `tool --profile x collections` runs as `tool collections --profile x`: agents often put connection flags first.
 * Flags without a command (`tool -p staging`) run the overview with them.
 */
export function hoistLeadingFlags(argv: string[], commands: Record<string, Command>): string[] {
  if (!argv[0]?.startsWith("-") || argv[0] === "-") return argv;
  const at = argv.findIndex((token) => commands[token] !== undefined || isShellForm(token));
  if (argv.slice(0, at === -1 ? argv.length : at).some((token) => FRONT_ONLY.has(token))) return argv;
  if (at === -1) return [HOME, ...argv];
  // After the subcommand and its arguments (`collection drop x -p dev`), but before a `--` terminator.
  const rest = argv.slice(at + 1);
  const end = rest.indexOf("--") === -1 ? rest.length : rest.indexOf("--");
  return [argv[at]!, ...rest.slice(0, end), ...argv.slice(0, at), ...rest.slice(end)];
}

export interface CliSpec {
  tool: Tool;
  version: string;
  description: string;
  topHelp: string;
  commands: Record<string, Command>;
  /** Commands of the other tool, answered with where they live instead of "unknown command". */
  refused?: Record<string, string>;
}

/** A command this tool deliberately lacks: READ_ONLY (exit 2) with the alternative. */
function refusal(name: string, hint: string): Command {
  const error = (): AxiError => axiError(`'${name}' is not a ${tool().name} command - ${tool().mode === "read-only" ? "this tool only reads" : "it never installs packages"}`, "READ_ONLY", [hint]);
  return {
    run: async () => {
      throw error();
    },
    help: () => `${name}: not available in ${tool().name}. ${hint}\n`,
  };
}

export interface MainOptions {
  argv?: string[];
  stdout?: { write: (chunk: string) => unknown };
}

function formatError(error: unknown): { output: string; exitCode: number } {
  const axi = error instanceof AxiError ? error : new AxiError(error instanceof Error ? error.message : String(error), "UNKNOWN");
  return { output: `${renderErrorOutput(axi.message, axi.code, axi.suggestions)}\n`, exitCode: exitCodeForError(axi) };
}

export async function runCli(spec: CliSpec, options: MainOptions = {}): Promise<void> {
  setTool(spec.tool);
  const commands: Record<string, Command> = { ...spec.commands };
  for (const [alias, target] of Object.entries(ALIASES)) if (commands[target] && !commands[alias]) commands[alias] = commands[target]!;
  commands[SHELL] = { run: shellCommand, help: shellHelp };
  commands[HOME] = { run: async (args) => out(homeHeader(spec.description), await homeCommand(args)), help: homeHelp };
  const canonical = (word: string): string | undefined => (commands[word] ? (ALIASES[word] ?? word) : undefined);
  commands["context"] = { run: (args) => contextCommand(args, { description: spec.description, canonical }), help: contextHelp };
  // Shadows the SDK's built-in self-upgrade: an agent allowed to run this tool must not install packages.
  if (!commands["update"]) commands["update"] = refusal("update", `To upgrade ${spec.tool.name}, a person runs \`npm install -g ${spec.tool.name}@latest\``);
  for (const [name, hint] of Object.entries(spec.refused ?? {})) commands[name] = refusal(name, hint);
  // Stripped here: the SDK rejects flags before the command, and --json may stand anywhere.
  const given = options.argv ?? process.argv.slice(2);
  const json = given.includes("--json");
  setJsonMode(json);
  const argv = routeShell(hoistLeadingFlags(json ? given.filter((a) => a !== "--json") : given, commands));
  setInvocation(argv);
  const stdout = options.stdout ?? process.stdout;
  let buffered = "";
  await runAxiCli({
    argv,
    ...(json ? { stdout: { write: (chunk: string) => (buffered += chunk) } } : options.stdout ? { stdout: options.stdout } : {}),
    description: spec.description,
    version: spec.version,
    topLevelHelp: spec.topHelp,
    home: () => homeCommand(),
    commands: Object.fromEntries(
      Object.entries(commands).map(([name, c]) => [name, async (args: string[]) => (args.includes("-h") ? c.help().trimEnd() : c.run(args))]),
    ),
    getCommandHelp: (command) => commands[command]?.help(),
    renderUnknownCommand: (command) =>
      `${renderErrorOutput(`unknown command '${command}'`, "VALIDATION_ERROR", [
        `commands: ${Object.keys(spec.commands).join(", ")} (no command = overview; 'db.<collection>.find(...)' = shell form)`,
        `Run \`${spec.tool.name} --help\` for examples`,
      ])}\n`,
    formatError,
  });
  if (!json) return;
  // The SDK only guards the stdout it writes to: `--json | head` must not crash on EPIPE either.
  if (stdout === process.stdout) process.stdout.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") throw error; });
  stdout.write(toJson(buffered));
}
