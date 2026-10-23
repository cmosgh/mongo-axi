import { readFileSync, realpathSync } from "node:fs";
import { expectPositionals, parseArgs } from "../args.js";
import { usageError } from "../errors.js";
import { block, helpBlock, out } from "../render.js";
import { lastSession, recordSession, sessionText, summarizeTranscript, type CommandLookup } from "../sessionlog.js";
import { tool } from "../tool.js";
import { isConfigured } from "../target.js";
import { connectionStatus, exploreHelp, homeHeader } from "./home.js";

export const contextHelp = (): string => `usage: ${tool().name} context [end]
What the session-start hook prints: the connection, saved profiles and what the last session in this directory ran. Never connects or reads the keychain; exits 0.
\`context end\` is the Claude Code session-end hook: it reads the hook payload on stdin and records the ${tool().name} commands the transcript ran (names and counts, plus the -p and -d used most; never other arguments).
examples:
  ${tool().name} context
  ${tool().name} setup hooks
`;

export interface ContextOptions {
  description: string;
  canonical: CommandLookup;
}

/** Sessions are keyed by directory; realpath so a symlinked checkout matches itself. */
function directoryKey(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function view(options: ContextOptions): string {
  const name = tool().name;
  const last = lastSession(directoryKey(process.cwd()));
  const status = connectionStatus();
  return out(
    homeHeader(options.description),
    block(tool().banner),
    ...status.blocks,
    last && block({ last_session: sessionText(last) }),
    helpBlock(isConfigured() ? [`Run \`${name}\` for live server state; \`${name} --help\` for commands`, ...exploreHelp()] : status.help),
  );
}

/** Never fails the agent's exit: a payload it cannot use records nothing. */
async function end(options: ContextOptions): Promise<string> {
  if (process.stdin.isTTY) throw usageError("context end reads a session-end hook payload on stdin", [`It runs from the hook \`${tool().name} setup hooks\` installs`]);
  let payload: { transcript_path?: unknown; cwd?: unknown };
  try {
    payload = JSON.parse(readFileSync(0, "utf-8")) as typeof payload;
  } catch {
    return block({ recorded: "nothing - stdin is not a hook payload" });
  }
  if (typeof payload?.transcript_path !== "string") return block({ recorded: "nothing - the payload has no transcript_path" });
  try {
    const summary = await summarizeTranscript(payload.transcript_path, options.canonical);
    if (!summary) return block({ recorded: `nothing - no ${tool().name} commands this session` });
    recordSession(directoryKey(typeof payload.cwd === "string" ? payload.cwd : process.cwd()), summary);
    return block({ recorded: sessionText(summary) });
  } catch {
    return block({ recorded: "nothing - the transcript could not be read" });
  }
}

export async function contextCommand(args: string[], options: ContextOptions): Promise<string> {
  const command = `${tool().name} context`;
  const parsed = parseArgs(args, [], command);
  expectPositionals(parsed, parsed.positionals[0] === "end" ? 1 : 0, `${command} [end]`);
  return parsed.positionals[0] === "end" ? end(options) : view(options);
}
