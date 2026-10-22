import { runAxiCli } from "axi-sdk-js";
import { authCommand, authHelp } from "./commands/auth.js";
import { collectionsCommand, collectionsHelp, databasesCommand, databasesHelp, describeCommand, describeHelp, indexesCommand, indexesHelp, searchCommand, searchHelp } from "./commands/browse.js";
import { doctorCommand, doctorHelp } from "./commands/doctor.js";
import { homeCommand } from "./commands/home.js";
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
import { AxiError, exitCodeForError } from "./errors.js";
import { renderErrorOutput } from "./render.js";
import { isShellForm } from "./shell.js";
import { setTool, type Tool } from "./tool.js";

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

/** `tool --profile x collections` runs as `tool collections --profile x`: agents often put connection flags first. */
export function hoistLeadingFlags(argv: string[], commands: Record<string, Command>): string[] {
  if (!argv[0]?.startsWith("-") || argv[0] === "-") return argv;
  const at = argv.findIndex((token) => commands[token] !== undefined || isShellForm(token));
  if (at <= 0 || argv.slice(0, at).some((token) => FRONT_ONLY.has(token))) return argv;
  return [argv[at]!, ...argv.slice(0, at), ...argv.slice(at + 1)];
}

export interface CliSpec {
  tool: Tool;
  version: string;
  description: string;
  topHelp: string;
  commands: Record<string, Command>;
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
  await runAxiCli({
    argv: routeShell(hoistLeadingFlags(options.argv ?? process.argv.slice(2), commands)),
    ...(options.stdout ? { stdout: options.stdout } : {}),
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
}
