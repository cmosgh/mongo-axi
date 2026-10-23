import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { computeCodexConfigUpdate, type HookSettings } from "axi-sdk-js";
import { shellSegments } from "./sessionlog.js";

/** `start` runs `<tool> context` (never connects); `end` runs `<tool> context end` (records the session). */
export type HookKind = "start" | "end";
export type Scope = "user" | "project" | "local";

interface Entry {
  type?: string;
  command?: string;
  timeout?: number;
  [key: string]: unknown;
}

interface Group {
  matcher?: string | null;
  hooks?: Entry[];
  [key: string]: unknown;
}

type Hooks = Record<string, unknown>;

const EVENTS: Record<HookKind, string> = { start: "SessionStart", end: "SessionEnd" };
const ARGS: Record<HookKind, string> = { start: "context", end: "context end" };
const TIMEOUTS: Record<HookKind, number> = { start: 10, end: 30 };

export const hookCommand = (bin: string, kind: HookKind): string => `${bin} ${ARGS[kind]}`;

/**
 * Which of our hooks a command is: this tool's binary (by file name, wherever it is installed) running
 * `context` or `context end`. A bare binary is an older install that ran the overview: ours, to repair.
 * Anything else, such as a hand-written `mongo-axi databases`, belongs to the user.
 */
export function ourHook(command: unknown, name: string): HookKind | undefined {
  if (typeof command !== "string") return undefined;
  const segments = shellSegments(command);
  if (segments.length !== 1) return undefined;
  const [bin = "", ...args] = segments[0]!;
  if (basename(bin) !== name && basename(bin) !== `${name}.js`) return undefined;
  const rest = args.join(" ");
  return rest === "" || rest === ARGS.start ? "start" : rest === ARGS.end ? "end" : undefined;
}

const groupsOf = (hooks: Hooks, event: string): Group[] | undefined => {
  const groups = hooks[event];
  if (groups === undefined) return undefined;
  if (!Array.isArray(groups)) throw new Error(`hooks.${event} is not a list`);
  return groups as Group[];
};

/** The commands of our hooks in a settings file, by kind. */
export function findHooks(settings: HookSettings, name: string): Partial<Record<HookKind, string>> {
  const found: Partial<Record<HookKind, string>> = {};
  const hooks = (settings.hooks ?? {}) as Hooks;
  for (const event of Object.values(EVENTS)) {
    for (const group of groupsOf(hooks, event) ?? []) {
      for (const entry of Array.isArray(group?.hooks) ? group.hooks : []) {
        const kind = ourHook(entry?.command, name);
        if (kind && EVENTS[kind] === event) found[kind] ??= entry.command!;
      }
    }
  }
  return found;
}

/** The settings with exactly one hook of each kind pointing at `bin`: repaired in place, else appended. Other hooks stay as they are. */
export function installHooks(settings: HookSettings, name: string, bin: string, kinds: readonly HookKind[]): [HookSettings, boolean] {
  const updated = structuredClone(settings);
  const hooks = (updated.hooks ??= {}) as Hooks;
  // The SDK's legacy lowercase list: ours move to SessionStart.
  if (Array.isArray(hooks["session_start"])) {
    const rest = (hooks["session_start"] as Entry[]).filter((entry) => ourHook(entry?.command, name) === undefined);
    if (rest.length > 0) hooks["session_start"] = rest;
    else delete hooks["session_start"];
  }
  for (const kind of kinds) {
    const event = EVENTS[kind];
    const want: Entry = { type: "command", command: hookCommand(bin, kind), timeout: TIMEOUTS[kind] };
    let kept = false;
    const next: Group[] = [];
    for (const group of groupsOf(hooks, event) ?? []) {
      if (!Array.isArray(group?.hooks)) {
        next.push(group);
        continue;
      }
      const entries: Entry[] = [];
      for (const entry of group.hooks) {
        if (ourHook(entry?.command, name) !== kind) entries.push(entry);
        else if (!kept) {
          kept = true;
          entries.push({ ...entry, ...want });
        }
      }
      if (entries.length > 0 || group.hooks.length === 0) next.push({ ...group, hooks: entries });
    }
    if (!kept) next.push({ matcher: "", hooks: [want] });
    hooks[event] = next;
  }
  return JSON.stringify(updated) === JSON.stringify(settings) ? [settings, false] : [updated, true];
}

/** The settings without any of our hooks. */
export function removeHooks(settings: HookSettings, name: string): [HookSettings, boolean] {
  if (!settings.hooks) return [settings, false];
  const updated = structuredClone(settings);
  const hooks = updated.hooks as Hooks;
  let removed = 0;
  if (Array.isArray(hooks["session_start"])) {
    const list = hooks["session_start"] as Entry[];
    const rest = list.filter((entry) => ourHook(entry?.command, name) === undefined);
    removed += list.length - rest.length;
    if (rest.length > 0) hooks["session_start"] = rest;
    else if (list.length > 0) delete hooks["session_start"];
  }
  for (const event of Object.values(EVENTS)) {
    const groups = groupsOf(hooks, event);
    if (!groups) continue;
    const next: Group[] = [];
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) {
        next.push(group);
        continue;
      }
      const entries = group.hooks.filter((entry) => ourHook(entry?.command, name) === undefined);
      removed += group.hooks.length - entries.length;
      if (entries.length === group.hooks.length) next.push(group);
      else if (entries.length > 0) next.push({ ...group, hooks: entries });
    }
    if (next.length > 0 || groups.length === 0) hooks[event] = next;
    else delete hooks[event];
  }
  if (removed === 0) return [settings, false];
  if (Object.keys(hooks).length === 0) delete updated.hooks;
  return [updated, true];
}

export interface AgentFiles {
  claude: string;
  codex?: string;
  /** Codex reads hooks only with `[features] hooks = true`, always in the user config. */
  codexConfig?: string;
  opencode?: string;
}

/** Where each agent reads hooks for a scope; the agents' own config-dir variables are honoured. */
export function agentFiles(name: string, scope: Scope, projectDir: string): AgentFiles {
  const home = homedir();
  const claudeHome = process.env["CLAUDE_CONFIG_DIR"] || join(home, ".claude");
  const codexHome = process.env["CODEX_HOME"] || join(home, ".codex");
  const configHome = process.env["XDG_CONFIG_HOME"] || join(home, ".config");
  const plugin = `axi-${name}.js`;
  if (scope === "local") return { claude: join(projectDir, ".claude", "settings.local.json") };
  if (scope === "project") {
    return {
      claude: join(projectDir, ".claude", "settings.json"),
      codex: join(projectDir, ".codex", "hooks.json"),
      codexConfig: join(codexHome, "config.toml"),
      opencode: join(projectDir, ".opencode", "plugins", plugin),
    };
  }
  return {
    claude: join(claudeHome, "settings.json"),
    codex: join(codexHome, "hooks.json"),
    codexConfig: join(codexHome, "config.toml"),
    opencode: join(configHome, "opencode", "plugins", plugin),
  };
}

export function readSettings(path: string): HookSettings {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new Error(`${path} is not valid JSON - fix or remove it`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed as HookSettings;
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export const writeSettings = (path: string, settings: HookSettings): void => writeText(path, `${JSON.stringify(settings, null, 2)}\n`);

/** Returns true when the file changed. */
export function enableCodexHooks(path: string): boolean {
  const [updated, changed] = computeCodexConfigUpdate(existsSync(path) ? readFileSync(path, "utf-8") : "");
  if (changed) writeText(path, updated);
  return changed;
}

export function codexHooksEnabled(path: string): boolean {
  return existsSync(path) && !computeCodexConfigUpdate(readFileSync(path, "utf-8"))[1];
}

// The axi-sdk-js marker line: its status and uninstall recognise the file too.
const managedLine = (name: string): string => `// axi-sdk-js managed opencode plugin: ${name}`;

/** An OpenCode plugin that adds `<bin> context` to each session's system context (OpenCode 1 and 2 entrypoints). */
export function openCodePlugin(name: string, bin: string): string {
  return `${managedLine(name)}
// Written by \`${name} setup hooks\`, which rewrites it; remove the line above to keep your own edits.
import { spawn } from "node:child_process";

const command = ${JSON.stringify(bin)};
const args = ${JSON.stringify(ARGS.start.split(" "))};
const header = ${JSON.stringify(`## AXI ambient context: ${name}`)};
const timeoutMs = ${TIMEOUTS.start * 1000};

function run(directory) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd: directory || process.cwd(), env: process.env, shell: false, stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      resolve("error: " + command + " failed: " + error.message);
      return;
    }
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve("error: " + command + " timed out after " + timeoutMs + "ms");
    }, timeoutMs);
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve("error: " + command + " failed: " + error.message);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(stdout.trim());
    });
  });
}

function contextFor(directory) {
  const cache = new Map();
  return async (sessionID) => {
    const key = sessionID ?? "";
    if (!cache.has(key)) cache.set(key, await run(directory));
    const text = cache.get(key);
    return text ? header + "\\n" + text : "";
  };
}

export default {
  id: ${JSON.stringify(`axi-${name}`)},
  async setup(ctx) {
    const context = contextFor(ctx.location.directory);
    await ctx.session.hook("context", async (event) => {
      const text = await context(event.sessionID);
      if (text) event.system.push({ type: "text", text });
    });
  },
  async server({ directory }) {
    const context = contextFor(directory);
    return {
      "experimental.chat.system.transform": async (input, output) => {
        const text = await context(input.sessionID);
        if (text) output.system.push(text);
      },
    };
  },
};
`;
}

export type PluginState = "missing" | "foreign" | "current" | "outdated";

/** foreign = a file of the same name that setup did not write; it is never overwritten or removed. */
export function pluginState(path: string, name: string, bin?: string): PluginState {
  if (!existsSync(path)) return "missing";
  const text = readFileSync(path, "utf-8");
  if (!text.includes(managedLine(name))) return "foreign";
  if (bin !== undefined) return text === openCodePlugin(name, bin) ? "current" : "outdated";
  return text.includes(`const args = ${JSON.stringify(ARGS.start.split(" "))};`) ? "current" : "outdated";
}

/** The binary the plugin runs, when setup wrote it. */
export function pluginCommand(path: string): string | undefined {
  try {
    const match = /^const command = (".*");$/m.exec(readFileSync(path, "utf-8"));
    return match ? (JSON.parse(match[1]!) as string) : undefined;
  } catch {
    return undefined;
  }
}

export function removePlugin(path: string): void {
  rmSync(path, { force: true });
}
