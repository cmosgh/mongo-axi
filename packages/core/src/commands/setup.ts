import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { shouldInstallHooksForNodeAxiExecPath } from "axi-sdk-js";
import { bool, expectPositionals, parseArgs } from "../args.js";
import { axiError, usageError } from "../errors.js";
import { shellQuote } from "../hints.js";
import {
  agentFiles,
  codexHooksEnabled,
  enableCodexHooks,
  findHooks,
  hookCommand,
  installHooks,
  openCodePlugin,
  pluginCommand,
  pluginState,
  readSettings,
  removeHooks,
  removePlugin,
  writeSettings,
  writeText,
  type HookKind,
  type Scope,
} from "../hooks.js";
import { block, helpBlock, out, type Obj } from "../render.js";
import { shellSegments } from "../sessionlog.js";
import { tool } from "../tool.js";

export const SKILL_REPO = "cmosgh/mongo-axi";

export const setupHelp = (): string => `usage: ${tool().name} setup <hooks|status|uninstall> [--project | --local]
Opt-in agent hooks. At session start Claude Code, Codex and OpenCode run \`${tool().name} context\` and add its short summary to the agent's context; it never connects or reads the keychain.
At session end Claude Code runs \`${tool().name} context end\`, which records the ${tool().name} commands the session ran (names and counts, never arguments) for the next session in the same directory.
flags:
  --project (this repository's shared config - .claude/settings.json, .codex/hooks.json, .opencode/plugins/ - instead of your user config)
  --local (this repository, only for you: Claude Code's .claude/settings.local.json)
notes:
  Rerun \`setup hooks\` after a reinstall or move: it repairs the hook command, and is a no-op when nothing changed.
  Codex reads hooks only with [features] hooks = true in ~/.codex/config.toml: setup sets it; uninstall leaves it (other tools use it).
  Without hooks, install the skill instead (loads on demand, no per-session cost): npx skills add ${SKILL_REPO} --skill ${tool().name}
examples:
  ${tool().name} setup hooks
  ${tool().name} setup hooks --local
  ${tool().name} setup status --project
`;

const AGENT_NAMES = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" } as const;
type Agent = keyof typeof AGENT_NAMES;

/** The hooks each agent gets: Codex and OpenCode have no session-end event with a transcript. */
const KINDS: Record<Agent, readonly HookKind[]> = { claude: ["start", "end"], codex: ["start"], opencode: ["start"] };

/** The installed binary running this command; a source checkout (tsx) is refused like the SDK does. */
function installedExecPath(name: string): string | undefined {
  const execPath = resolve(process.argv[1] ?? "");
  return shouldInstallHooksForNodeAxiExecPath(execPath, { marker: name, binaryNames: [name], distEntrypoints: [`dist/${name}.js`] }) ? execPath : undefined;
}

const real = (path: string): string | undefined => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

/** npx and pnpm dlx run from a cache that later sessions do not have on PATH, so a hook there breaks. */
const TEMPORARY_INSTALL = /[\\/](_npx|dlx)[\\/]/;

/** The bare name when PATH finds this same install (portable for teammates), else the absolute path. */
function portableBin(name: string, execPath: string): string {
  const target = real(execPath);
  const onPath = (process.env["PATH"] ?? "").split(delimiter).some((dir) => dir && target !== undefined && real(join(dir, name)) === target);
  return onPath ? name : execPath;
}

const tilde = (path: string): string => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);

/** True when git would commit the file: inside a repository and not ignored. */
function committable(projectDir: string, file: string): boolean {
  const inRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: projectDir, encoding: "utf-8" }).stdout?.trim() === "true";
  return inRepo && spawnSync("git", ["check-ignore", "-q", file], { cwd: projectDir }).status === 1;
}

const describeKinds = (kinds: readonly HookKind[]): string => (kinds.length === 2 ? "session start + end" : `session ${kinds[0]}`);

/** An absolute hook binary that no longer exists: the tool was moved or uninstalled. */
function missingBin(command: string): string | undefined {
  const bin = shellSegments(command)[0]?.[0];
  return bin && isAbsolute(bin) && !existsSync(bin) ? bin : undefined;
}

function agentStatus(agent: Agent, files: ReturnType<typeof agentFiles>, name: string): string {
  if (agent === "opencode") {
    const state = pluginState(files.opencode!, name);
    if (state === "missing") return "not installed";
    if (state === "foreign") return `not installed - ${tilde(files.opencode!)} was not written by setup`;
    const bin = pluginCommand(files.opencode!);
    if (bin && isAbsolute(bin) && !existsSync(bin)) return `broken - ${tilde(bin)} is missing; rerun setup hooks`;
    return state === "current" ? "session start" : "outdated - rerun setup hooks";
  }
  const path = agent === "claude" ? files.claude : files.codex!;
  let found: Partial<Record<HookKind, string>>;
  try {
    found = findHooks(readSettings(path), name);
  } catch (error) {
    return `unreadable - ${error instanceof Error ? error.message : String(error)}`;
  }
  const kinds = KINDS[agent].filter((kind) => found[kind] !== undefined);
  if (kinds.length === 0) return "not installed";
  const broken = kinds.map((kind) => missingBin(found[kind]!)).find(Boolean);
  if (broken) return `broken - ${tilde(broken)} is missing; rerun setup hooks`;
  const outdated = kinds.some((kind) => !found[kind]!.endsWith(hookCommand("", kind)));
  const missing = KINDS[agent].filter((kind) => found[kind] === undefined);
  if (outdated || missing.length > 0) return `${describeKinds(kinds)} - outdated; rerun setup hooks`;
  return describeKinds(kinds);
}

function status(scope: Scope, name: string): string {
  const files = agentFiles(name, scope, process.cwd());
  const hooks: Obj = { scope };
  for (const agent of Object.keys(AGENT_NAMES) as Agent[]) {
    if (agent !== "claude" && scope === "local") continue;
    hooks[agent === "claude" ? "claude_code" : agent] = agentStatus(agent, files, name);
  }
  if (files.codexConfig && hooks["codex"] !== "not installed" && !codexHooksEnabled(files.codexConfig)) {
    hooks["codex"] = `${String(hooks["codex"])} - but [features] hooks is off in ${tilde(files.codexConfig)}; rerun setup hooks`;
  }
  return block({ hooks });
}

interface Outcome {
  agent: Agent;
  result: string;
  failed?: string;
}

function install(scope: Scope, name: string, execPath: string): Outcome[] {
  const files = agentFiles(name, scope, process.cwd());
  const bin = portableBin(name, execPath);
  const outcomes: Outcome[] = [];
  const settingsAgent = (agent: Agent, path: string, extra?: () => boolean): void => {
    try {
      const [updated, changed] = installHooks(readSettings(path), name, shellQuote(bin), KINDS[agent]);
      if (changed) writeSettings(path, updated);
      const enabled = extra?.() ?? false;
      outcomes.push({ agent, result: changed || enabled ? `installed (${describeKinds(KINDS[agent])})` : "already up to date (no-op)" });
    } catch (error) {
      outcomes.push({ agent, result: "failed", failed: error instanceof Error ? error.message : String(error) });
    }
  };
  settingsAgent("claude", files.claude);
  if (files.codex) settingsAgent("codex", files.codex, () => enableCodexHooks(files.codexConfig!));
  if (files.opencode) {
    const path = files.opencode;
    try {
      const state = pluginState(path, name, bin);
      if (state === "foreign") throw new Error(`${path} exists and was not written by setup - remove or rename it`);
      if (state !== "current") writeText(path, openCodePlugin(name, bin));
      outcomes.push({ agent: "opencode", result: state === "current" ? "already up to date (no-op)" : "installed (session start)" });
    } catch (error) {
      outcomes.push({ agent: "opencode", result: "failed", failed: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}

function uninstall(scope: Scope, name: string): Obj {
  const files = agentFiles(name, scope, process.cwd());
  const hooks: Obj = { scope };
  for (const [agent, path] of [["claude", files.claude], ["codex", files.codex]] as const) {
    if (!path) continue;
    const key = agent === "claude" ? "claude_code" : agent;
    try {
      const [updated, changed] = removeHooks(readSettings(path), name);
      if (changed) writeSettings(path, updated);
      hooks[key] = changed ? "removed" : "not installed (no-op)";
    } catch (error) {
      hooks[key] = `failed - ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (files.opencode) {
    const state = pluginState(files.opencode, name);
    if (state === "foreign") hooks["opencode"] = `kept - ${tilde(files.opencode)} was not written by setup`;
    else if (state === "missing") hooks["opencode"] = "not installed (no-op)";
    else {
      removePlugin(files.opencode);
      hooks["opencode"] = "removed";
    }
  }
  return hooks;
}

export async function setupCommand(args: string[]): Promise<string> {
  const name = tool().name;
  const [sub, ...rest] = args;
  if (sub !== "hooks" && sub !== "status" && sub !== "uninstall") {
    throw usageError(sub ? `unknown setup action '${sub}'` : "missing setup action", [
      `Run \`${name} setup hooks\` to install, \`${name} setup status\` to inspect, \`${name} setup uninstall\` to remove`,
    ]);
  }
  const command = `${name} setup ${sub}`;
  const parsed = parseArgs(rest, [{ name: "--project", boolean: true }, { name: "--local", boolean: true }], command);
  expectPositionals(parsed, 0, `${command} [--project | --local]`);
  if (bool(parsed, "--project") && bool(parsed, "--local")) throw usageError("pass --project or --local, not both");
  const scope: Scope = bool(parsed, "--local") ? "local" : bool(parsed, "--project") ? "project" : "user";

  if (sub === "status") return status(scope, name);
  if (sub === "uninstall") return block({ hooks: uninstall(scope, name) });

  const execPath = installedExecPath(name);
  if (!execPath) throw usageError(`run setup from an installed ${name} (npm install -g ${name}), not from a source checkout`);
  if (TEMPORARY_INSTALL.test(real(execPath) ?? execPath)) {
    throw usageError(`this ${name} runs from the npx cache, which later sessions do not have - a hook would break`, [
      `Run \`npm install -g ${name}\`, then \`${name} setup hooks\``,
      `Or use the skill instead: npx skills add ${SKILL_REPO} --skill ${name}`,
    ]);
  }
  const outcomes = install(scope, name, execPath);
  const failed = outcomes.filter((o) => o.failed);
  if (failed.length > 0) {
    const done = outcomes.filter((o) => !o.failed).map((o) => AGENT_NAMES[o.agent]);
    throw axiError(
      `${failed.map((o) => `${AGENT_NAMES[o.agent]} failed - ${o.failed}`).join("; ")}${done.length > 0 ? ` (${done.join(" and ")} done)` : ""}`,
      "SETUP_FAILED",
      [`Fix that, then rerun \`${command}${scope === "user" ? "" : ` --${scope}`}\` - hooks already in place are left as they are`],
    );
  }
  const bin = portableBin(name, execPath);
  const hooks: Obj = { scope };
  for (const o of outcomes) hooks[o.agent === "claude" ? "claude_code" : o.agent] = o.result;
  hooks["runs"] = `${bin === name ? name : tilde(bin)} context`;
  const help: string[] = [];
  const localFile = join(".claude", "settings.local.json");
  if (scope === "local" && committable(process.cwd(), localFile)) help.push(`git would commit ${localFile} - add it to .gitignore to keep the hook personal`);
  if (scope === "project" && bin !== name) help.push(`The hooks run ${tilde(bin)}: teammates need ${name} on PATH (npm install -g ${name}), then rerun this from that install`);
  help.push(`Restart the agent session to receive the ${name} context`);
  return out(block({ hooks }), helpBlock(help));
}
