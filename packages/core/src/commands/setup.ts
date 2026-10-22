import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import {
  computeSessionStartHookRemoval,
  computeSessionStartHookUpdate,
  installSessionStartHooks,
  sessionStartHookStatus,
  shouldInstallHooksForNodeAxiExecPath,
  uninstallSessionStartHooks,
  type HookSettings,
} from "axi-sdk-js";
import { bool, expectPositionals, parseArgs } from "../args.js";
import { usageError } from "../errors.js";
import { block, helpBlock, out } from "../render.js";
import { tool } from "../tool.js";

export const setupHelp = (): string => `usage: ${tool().name} setup <hooks|status|uninstall> [--project | --local]
Manage the opt-in session-start hook: Claude Code, Codex and OpenCode run \`${tool().name}\` when a session starts and add its short overview to the agent's context.
flags:
  --project (this repository's shared agent config - .claude/settings.json, .codex/hooks.json, .opencode/plugins/ - instead of your user config)
  --local (this repository only and only for you: Claude Code's .claude/settings.local.json; Codex and OpenCode have no per-user project file)
notes:
  The overview never connects to a database or reads the keychain.
  --project still enables hooks in ~/.codex/config.toml ([features] hooks = true).
examples:
  ${tool().name} setup hooks
  ${tool().name} setup hooks --local
  ${tool().name} setup status --project
`;

const LOCAL_SETTINGS = join(".claude", "settings.local.json");

/** The installed binary running this command; dev runs through tsx are refused like the SDK does. */
function installedExecPath(name: string): string | undefined {
  const execPath = resolve(process.argv[1] ?? "");
  return shouldInstallHooksForNodeAxiExecPath(execPath, { marker: name, binaryNames: [name], distEntrypoints: [`dist/${name}.js`] }) ? execPath : undefined;
}

/** `mongo-axi` when PATH finds this same install (portable for teammates), else the absolute path. */
function hookCommand(name: string, execPath: string): string {
  const real = (path: string): string | undefined => {
    try {
      return realpathSync(path);
    } catch {
      return undefined;
    }
  };
  const target = real(execPath);
  const onPath = (process.env["PATH"] ?? "").split(delimiter).some((dir) => dir && target !== undefined && real(join(dir, name)) === target);
  return onPath ? name : execPath;
}

function readSettings(path: string): HookSettings {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as HookSettings;
  } catch {
    throw usageError(`${path} is not valid JSON - fix or remove it, then rerun`);
  }
}

function writeSettings(path: string, settings: HookSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

const hasHook = (settings: HookSettings, marker: string): boolean => computeSessionStartHookRemoval(settings, marker)[1];

/** True when git would commit the file: inside a repository and not ignored. */
function committable(projectDir: string, file: string): boolean {
  const inRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: projectDir, encoding: "utf-8" }).stdout.trim() === "true";
  return inRepo && spawnSync("git", ["check-ignore", "-q", file], { cwd: projectDir }).status === 1;
}

function localSetup(sub: "hooks" | "status" | "uninstall", name: string): string {
  const projectDir = process.cwd();
  const path = join(projectDir, LOCAL_SETTINGS);
  const settings = readSettings(path);
  if (sub === "status") return block({ hooks: { scope: "local", claude_code: hasHook(settings, name) ? "installed" : "not installed", file: LOCAL_SETTINGS } });
  if (sub === "uninstall") {
    const [updated, changed] = computeSessionStartHookRemoval(settings, name);
    if (changed) writeSettings(path, updated);
    return block({ hooks: { scope: "local", status: changed ? "removed" : "not installed (no-op)", file: LOCAL_SETTINGS } });
  }
  const execPath = installedExecPath(name);
  if (!execPath) throw usageError(`run setup from an installed ${name} (npm install -g ${name} or npx ${name}), not from a source checkout`);
  const [updated, changed] = computeSessionStartHookUpdate(settings, { marker: name, command: hookCommand(name, execPath) });
  if (changed) writeSettings(path, updated);
  return out(
    block({ hooks: { scope: "local", status: changed ? "installed" : "already up to date (no-op)", integrations: "Claude Code", file: LOCAL_SETTINGS } }),
    helpBlock([
      ...(committable(projectDir, LOCAL_SETTINGS) ? [`git would commit ${LOCAL_SETTINGS} - add it to .gitignore to keep the hook personal`] : []),
      `Restart the agent session to receive the ${name} overview`,
    ]),
  );
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
  if (bool(parsed, "--local")) return localSetup(sub, name);
  const scope = bool(parsed, "--project") ? "project" : "user";
  const identity = { marker: name, binaryNames: [name], distEntrypoints: [`dist/${name}.js`], projectDir: process.cwd() };

  if (sub === "status") {
    const status = sessionStartHookStatus({ ...identity, scope });
    return block({
      hooks: {
        scope,
        claude_code: status.claude.installed ? "installed" : "not installed",
        codex: status.codex.installed ? "installed" : "not installed",
        opencode: status.opencode.installed ? "installed" : "not installed",
      },
    });
  }
  if (sub === "uninstall") {
    await uninstallSessionStartHooks({ ...identity, scope });
    return block({ hooks: { scope, status: "removed (or were not installed)" } });
  }
  if (!installedExecPath(name)) throw usageError(`run setup from an installed ${name} (npm install -g ${name} or npx ${name}), not from a source checkout`);
  const errors: string[] = [];
  await installSessionStartHooks({ ...identity, scope, onError: (message) => errors.push(message) });
  // The SDK skips silently when it does not recognise the binary; report what actually landed.
  const status = sessionStartHookStatus({ ...identity, scope });
  if (!status.claude.installed) throw usageError(`the hook was not installed${errors.length > 0 ? ` - ${errors[0]}` : ""}`);
  return out(
    block({ hooks: { scope, status: "installed or already up to date", integrations: "Claude Code; Codex; OpenCode" } }),
    helpBlock([...errors, `Restart the agent session to receive the ${name} overview`]),
  );
}
