import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HookSettings } from "axi-sdk-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hoistLeadingFlags, type Command } from "../packages/core/src/cli.js";
import { followUp, rerun, rerunHint, setInvocation, shellQuote } from "../packages/core/src/hints.js";
import { configDir } from "../packages/core/src/config.js";
import { findHooks, installHooks, ourHook, removeHooks } from "../packages/core/src/hooks.js";
import { findInvocations, lastSession, recordSession, sessionText, shellSegments, summarizeTranscript } from "../packages/core/src/sessionlog.js";
import { setTool } from "../packages/core/src/tool.js";
import { TOOL } from "../packages/mongo-axi/src/cli.js";
import { ro, rw, useTestEnv } from "./helpers.js";

const lookup = (word: string): string | undefined => ({ find: "query", query: "query", collections: "collections", describe: "describe" })[word];

describe("hints", () => {
  beforeEach(() => setTool(TOOL));

  it("quotes only what the shell would split or expand", () => {
    expect(shellQuote("orders")).toBe("orders");
    expect(shellQuote("shop.orders")).toBe("shop.orders");
    expect(shellQuote("{status: 1}")).toBe("'{status: 1}'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("$HOME")).toBe("'$HOME'");
  });

  it("reruns the command with flags replaced, before a -- terminator", () => {
    setInvocation(["find", "orders", "{status: 1}", "--limit", "5", "-p", "dev"]);
    expect(rerun({ "--limit": "50" })).toBe("mongo-axi find orders '{status: 1}' -p dev --limit 50");
    setInvocation(["find", "orders", "--limit=5"]);
    expect(rerun({ "--limit": "50" })).toBe("mongo-axi find orders --limit 50");
    setInvocation(["delete", "orders", "{}", "--many", "--", "-x"]);
    expect(rerun({ "--confirm": true })).toBe("mongo-axi delete orders '{}' --many --confirm -- -x");
    setInvocation(["shell", "db.orders.find({})"]);
    expect(rerun({ "--limit": "50" })).toBe("mongo-axi 'db.orders.find({})' --limit 50");
  });

  it("falls back to words when the command is too long to repeat", () => {
    setInvocation(["find", "orders", `{note: "${"x".repeat(400)}"}`]);
    expect(rerun({ "--limit": "50" })).toBeUndefined();
    expect(rerunHint({ "--limit": "50" }, "to see all")).toBe("Rerun the same command with --limit 50 to see all");
    expect(rerunHint({}, "again")).toBe("Rerun the same command again");
    setInvocation(["find", "configs", '{uri: "mongodb://app:s3cret@db.example.test/x"}']);
    expect(rerunHint({ "--limit": "50" }, "to see all")).toBe("Rerun the same command with --limit 50 to see all");
  });

  it("keeps the connection flags in follow-ups", () => {
    setInvocation(["collections", "-p", "staging db", "--database=shop"]);
    expect(followUp("describe orders")).toBe("mongo-axi describe orders -p 'staging db' -d shop");
    expect(followUp("databases", { database: false })).toBe("mongo-axi databases -p 'staging db'");
  });
});

describe("session capture", () => {
  it("splits shell lines on operators and resolves quotes", () => {
    expect(shellSegments(`a 'b c' "d\\"e" && f|g; h\nI=1 j`)).toEqual([["a", "b c", 'd"e'], ["f"], ["g"], ["h"], ["I=1", "j"]]);
  });

  it("records command names and -p/-d values, never arguments", () => {
    const line = `cd /x && MONGO_AXI_PROFILE=dev npx -y mongo-axi find orders '{secret: 1}' -d shop | head; mongo-axi -p dev 'db.orders.find({})'; mongo-rw-axi insert orders '{}'`;
    expect(findInvocations(line, "mongo-axi", lookup)).toEqual([
      { command: "query", database: "shop" },
      { command: "shell", profile: "dev" },
    ]);
    expect(findInvocations("/opt/bin/mongo-axi frobnicate secret", "mongo-axi", lookup)).toEqual([{ command: "other" }]);
    expect(findInvocations("mongo-axi --help", "mongo-axi", lookup)).toEqual([{ command: "help" }]);
    expect(findInvocations("mongo-axi -d shop", "mongo-axi", lookup)).toEqual([{ command: "home", database: "shop" }]);
    expect(findInvocations("echo mongo-axi; grep mongo-axi x", "mongo-axi", lookup)).toEqual([]);
  });

  it("summarizes a transcript and keeps the latest session per directory", async () => {
    useTestEnv();
    setTool(TOOL);
    const dir = mkdtempSync(join(tmpdir(), "mongo-axi-transcript-"));
    const transcript = join(dir, "session.jsonl");
    const bash = (command: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command } }] } });
    writeFileSync(
      transcript,
      [
        bash("mongo-axi collections -p dev -d shop"),
        bash("mongo-axi describe orders -p dev -d shop"),
        bash("mongo-axi find orders '{email: \"a@example.test\"}' -p dev -d shop"),
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "mongo-axi find orders" }] } }),
        "not json mongo-axi",
      ].join("\n"),
    );
    const summary = await summarizeTranscript(transcript, lookup);
    expect(summary).toMatchObject({ commands: { collections: 1, describe: 1, query: 1 }, profile: "dev", database: "shop" });
    expect(JSON.stringify(summary)).not.toMatch(/orders|example|email/);
    recordSession("/work/a", summary!);
    recordSession("/work/b", { ended: "2026-10-01", commands: { query: 2 } });
    expect(lastSession("/work/a")).toEqual(summary);
    expect(sessionText(lastSession("/work/b")!)).toBe("2026-10-01 - query 2");
    expect(lastSession("/work/c")).toBeUndefined();
    expect(await summarizeTranscript(transcript, () => undefined)).toMatchObject({ commands: { other: 3 } });
  });
  it("starts a new log when sessions.json has the wrong shape", () => {
    useTestEnv();
    setTool(TOOL);
    mkdirSync(configDir(), { recursive: true });
    for (const content of ['{"directories": null}', '{"directories": [1]}', "null", "not json"]) {
      writeFileSync(join(configDir(), "sessions.json"), content);
      expect(lastSession("/work/a")).toBeUndefined();
      recordSession("/work/a", { ended: "2026-10-01", commands: { query: 1 } });
      expect(lastSession("/work/a")).toMatchObject({ commands: { query: 1 } });
    }
  });
});

describe("hook entries", () => {
  const start = (command: string, extra: object = {}) => ({ matcher: "", hooks: [{ type: "command", command, timeout: 10, ...extra }] });

  it("knows its own hooks by binary name, not by substring", () => {
    expect(ourHook("mongo-axi context", "mongo-axi")).toBe("start");
    expect(ourHook("'/Users/a b/bin/mongo-axi' context end", "mongo-axi")).toBe("end");
    expect(ourHook("/usr/local/lib/node_modules/mongo-axi/dist/mongo-axi.js", "mongo-axi")).toBe("start");
    expect(ourHook("mongo-rw-axi context", "mongo-axi")).toBeUndefined();
    expect(ourHook("/src/mongo-axi/run.sh", "mongo-axi")).toBeUndefined();
    expect(ourHook("mongo-axi databases -p prod", "mongo-axi")).toBeUndefined();
    expect(ourHook("mongo-axi context && echo hi", "mongo-axi")).toBeUndefined();
  });

  it("adds start and end hooks, repairs the binary in place and is a no-op when current", () => {
    const settings = { model: "x", hooks: { SessionStart: [start("other-tool")] } } as HookSettings;
    const [first, added] = installHooks(settings, "mongo-axi", "/old/mongo-axi", ["start", "end"]);
    expect(added).toBe(true);
    expect(findHooks(first, "mongo-axi")).toEqual({ start: "/old/mongo-axi context", end: "/old/mongo-axi context end" });
    const [moved, repaired] = installHooks(first, "mongo-axi", "mongo-axi", ["start", "end"]);
    expect(repaired).toBe(true);
    expect(moved.hooks!.SessionStart).toHaveLength(2);
    expect(findHooks(moved, "mongo-axi")).toEqual({ start: "mongo-axi context", end: "mongo-axi context end" });
    expect(installHooks(moved, "mongo-axi", "mongo-axi", ["start", "end"])).toEqual([moved, false]);
    expect(JSON.stringify(moved)).toContain("other-tool");
  });

  it("upgrades the bare 0.1.0 hook, drops duplicates and leaves hand-written ones", () => {
    const old = {
      hooks: { SessionStart: [start("/usr/local/bin/mongo-axi"), start("mongo-axi"), { hooks: [{ type: "command", command: "mongo-axi databases -p prod" }] }] },
    } as HookSettings;
    const [next] = installHooks(old, "mongo-axi", "mongo-axi", ["start"]);
    expect(next.hooks!.SessionStart).toEqual([start("mongo-axi context"), { hooks: [{ type: "command", command: "mongo-axi databases -p prod" }] }]);
  });

  it("removes only its own hooks and empty containers it emptied", () => {
    const settings = { hooks: { SessionStart: [start("mongo-axi context"), start("other-tool")], SessionEnd: [start("mongo-axi context end")] } } as HookSettings;
    const [removed, changed] = removeHooks(settings, "mongo-axi");
    expect(changed).toBe(true);
    expect(removed).toEqual({ hooks: { SessionStart: [start("other-tool")] } });
    expect(removeHooks({ hooks: { SessionStart: [] } }, "mongo-axi")[1]).toBe(false);
    expect(removeHooks({ hooks: { SessionStart: [start("mongo-axi context")] } }, "mongo-axi")[0]).toEqual({});
  });
});

describe("setup", () => {
  const saved = { home: process.env["HOME"], path: process.env["PATH"], argv1: process.argv[1], cwd: process.cwd() };
  const agentVars = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"];
  const savedVars = Object.fromEntries(agentVars.map((v) => [v, process.env[v]]));
  let home = "";
  let bin = "";

  const install = (at: string): string => {
    const path = join(home, at, "node_modules", "mongo-axi", "dist", "mongo-axi.js");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
    process.argv[1] = path;
    return path;
  };
  const claude = () => JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8")) as HookSettings;

  beforeEach(() => {
    useTestEnv();
    // Never the real agent config: a fresh HOME, and none of the agents' own config-dir overrides.
    home = realpathSync(mkdtempSync(join(tmpdir(), "mongo-axi-home-")));
    process.env["HOME"] = home;
    for (const v of agentVars) delete process.env[v];
    expect(homedir()).toBe(home);
    bin = install("lib");
  });

  afterEach(() => {
    process.env["HOME"] = saved.home;
    process.env["PATH"] = saved.path;
    process.argv[1] = saved.argv1!;
    process.chdir(saved.cwd);
    for (const v of agentVars) if (savedVars[v] === undefined) delete process.env[v];
    else process.env[v] = savedVars[v];
  });

  it("installs Claude Code start and end, Codex start with its feature flag and the OpenCode plugin; a rerun is a no-op", async () => {
    const first = await ro("setup", "hooks");
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("claude_code: installed (session start + end)");
    expect(first.stdout).toContain("codex: installed (session start)");
    expect(first.stdout).toContain("opencode: installed (session start)");
    expect(findHooks(claude(), "mongo-axi")).toEqual({ start: `${bin} context`, end: `${bin} context end` });
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf-8")).toBe("[features]\nhooks = true\n");
    expect(readFileSync(join(home, ".config", "opencode", "plugins", "axi-mongo-axi.js"), "utf-8")).toContain('const args = ["context"];');

    const again = await ro("setup", "hooks");
    expect(again.stdout.match(/already up to date \(no-op\)/g)).toHaveLength(3);
    const status = await ro("setup", "status");
    expect(status.stdout).toMatch(/claude_code: session start \+ end\n {2}codex: session start\n {2}opencode: session start/);

    const removed = await ro("setup", "uninstall");
    expect(removed.stdout.match(/: removed/g)).toHaveLength(3);
    expect(claude()).toEqual({});
    expect((await ro("setup", "uninstall")).stdout.match(/not installed \(no-op\)/g)).toHaveLength(3);
  });

  it("uses the bare name when PATH finds this install", async () => {
    const binDir = join(home, "bin");
    mkdirSync(binDir);
    symlinkSync(bin, join(binDir, "mongo-axi"));
    process.env["PATH"] = `${binDir}${delimiter}${saved.path}`;
    expect((await ro("setup", "hooks")).stdout).toContain("runs: mongo-axi context");
    expect(findHooks(claude(), "mongo-axi").end).toBe("mongo-axi context end");
  });

  it("reports a moved binary and repairs the path", async () => {
    await ro("setup", "hooks");
    const moved = install("lib2");
    renameSync(join(home, "lib"), join(home, "old-lib"));
    expect((await ro("setup", "status")).stdout).toContain("claude_code: broken -");
    expect((await ro("setup", "hooks")).stdout).toContain("claude_code: installed (session start + end)");
    expect(findHooks(claude(), "mongo-axi").start).toBe(`${moved} context`);
    expect((await ro("setup", "status")).stdout).toContain("claude_code: session start + end");
  });

  it("fails with SETUP_FAILED on a partial install and keeps what worked", async () => {
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "hooks.json"), "{not json");
    const { stdout, exitCode } = await ro("setup", "hooks");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("code: SETUP_FAILED");
    expect(stdout).toContain("hooks.json is not valid JSON");
    expect(findHooks(claude(), "mongo-axi").start).toBe(`${bin} context`);
  });

  it("writes project and local scopes under the working directory only", async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "mongo-axi-project-")));
    process.chdir(project);
    expect((await ro("setup", "hooks", "--local")).stdout).toContain("claude_code: installed (session start + end)");
    expect(findHooks(JSON.parse(readFileSync(join(project, ".claude", "settings.local.json"), "utf-8")) as HookSettings, "mongo-axi").end).toBe(`${bin} context end`);
    expect((await ro("setup", "hooks", "--project")).stdout).toContain("teammates need mongo-axi on PATH");
    expect(existsSync(join(project, ".opencode", "plugins", "axi-mongo-axi.js"))).toBe(true);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  });

  it("refuses an npx copy, whose cache later sessions do not have on PATH", async () => {
    install(join(".npm", "_npx", "3f2a"));
    const { stdout, exitCode } = await ro("setup", "hooks", "--project");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("runs from the npx cache");
    expect(stdout).toContain("then `mongo-axi setup hooks --project`");
    expect(stdout).toContain("npx skills add cmosgh/mongo-axi --skill mongo-axi");
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  it("refuses a pnpm dlx copy behind a symlink", async () => {
    const binDir = join(home, "dlx-bin");
    mkdirSync(binDir);
    symlinkSync(install(join("Library", "Caches", "pnpm", "dlx", "9c1e")), join(binDir, "mongo-axi"));
    process.argv[1] = join(binDir, "mongo-axi");
    const project = realpathSync(mkdtempSync(join(tmpdir(), "mongo-axi-project-")));
    process.chdir(project);
    const { stdout, exitCode } = await ro("setup", "hooks", "--local");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("runs from the pnpm dlx cache");
    expect(stdout).toContain("then `mongo-axi setup hooks --local`");
    expect(existsSync(join(project, ".claude"))).toBe(false);
  });

  it("refuses a source checkout", async () => {
    process.argv[1] = join(saved.cwd, "packages", "mongo-axi", "bin", "mongo-axi.ts");
    const { stdout, exitCode } = await ro("setup", "hooks");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("not from a source checkout");
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });
});

const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const roBin = fileURLToPath(new URL("../packages/mongo-axi/bin/mongo-axi.ts", import.meta.url));

describe("context", () => {
  beforeEach(() => useTestEnv());

  it("never connects and shows the last session in this directory", async () => {
    process.env["MONGO_AXI_URL"] = "mongodb://agent:hunter2@127.0.0.1:1/shop?authSource=admin";
    const before = await ro("context");
    expect(before.exitCode).toBe(0);
    expect(before.stdout).toContain('connection: "agent@127.0.0.1:1/shop (MONGO_AXI_URL)"');
    expect(before.stdout).not.toContain("last_session");
    expect(before.stdout).not.toContain("hunter2");

    const transcript = join(mkdtempSync(join(tmpdir(), "mongo-axi-transcript-")), "t.jsonl");
    writeFileSync(transcript, JSON.stringify({ message: { content: [{ type: "tool_use", input: { command: "mongo-axi find orders -d shop" } }] } }));
    const payload = JSON.stringify({ hook_event_name: "SessionEnd", transcript_path: transcript, cwd: process.cwd() });
    const end = spawnSync(process.execPath, [tsxCli, roBin, "context", "end"], { input: payload, encoding: "utf-8", env: process.env });
    expect(end.status).toBe(0);
    expect(end.stdout).toMatch(/recorded: "?\d{4}-\d\d-\d\d - query 1 - database shop/);

    const after = await ro("context");
    expect(after.stdout).toMatch(/last_session: "?\d{4}-\d\d-\d\d - query 1 - database shop/);
  }, 30_000);

  it("records nothing, with exit 0, for a payload it cannot use", () => {
    for (const input of ["", "{}", JSON.stringify({ transcript_path: "/nonexistent/t.jsonl" })]) {
      const r = spawnSync(process.execPath, [tsxCli, roBin, "context", "end"], { input, encoding: "utf-8", env: process.env });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/recorded: "?nothing - /);
    }
  }, 30_000);
});

describe("home", () => {
  beforeEach(() => useTestEnv());

  it("says not configured without connecting", async () => {
    delete process.env["MONGO_AXI_URL"];
    const { stdout, exitCode } = await ro();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("status: not configured");
  });

  it("reports an unreachable server as unavailable, quickly, with exit 0", async () => {
    process.env["MONGO_AXI_URL"] = "mongodb://agent:hunter2@127.0.0.1:1/shop?authSource=admin";
    const started = Date.now();
    const { stdout, exitCode } = await ro();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^bin: /);
    expect(stdout).toContain('live: "unavailable - cannot reach agent@127.0.0.1:1/shop - connection refused"');
    expect(stdout).not.toContain("hunter2");
    expect((await ro("-d", "other")).stdout).toContain('connection: "agent@127.0.0.1:1/other (MONGO_AXI_URL)"');
  }, 15_000);

  it("fails on flags it cannot use", async () => {
    const { stdout, exitCode } = await ro("-p", "nope");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("no profile 'nope'");
    expect((await ro("--limit", "5")).exitCode).toBe(2);
  });
});

describe("leading flags", () => {
  const command: Command = { run: async () => "", help: () => "" };
  const commands = { collection: command, find: command, auth: command };

  it("move after the subcommand and its arguments, before a -- terminator", () => {
    expect(hoistLeadingFlags(["-p", "dev", "collection", "drop", "x"], commands)).toEqual(["collection", "drop", "x", "-p", "dev"]);
    expect(hoistLeadingFlags(["-d", "shop", "find", "orders", "--", "-x"], commands)).toEqual(["find", "orders", "-d", "shop", "--", "-x"]);
    expect(hoistLeadingFlags(["-p", "dev", "db.orders.find({})"], commands)).toEqual(["db.orders.find({})", "-p", "dev"]);
    expect(hoistLeadingFlags(["-p", "dev"], commands)).toEqual(["home", "-p", "dev"]);
    expect(hoistLeadingFlags(["-p", "dev", "--help"], commands)).toEqual(["-p", "dev", "--help"]);
  });

  it("reach the subcommand's own parser", async () => {
    useTestEnv();
    const { stdout, exitCode } = await rw("-p", "nope", "collection", "drop", "x");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("no profile 'nope'");
  });
});

describe("refused commands", () => {
  beforeEach(() => useTestEnv());

  it("answers write commands and the SDK's self-upgrade with where they live", async () => {
    const update = await ro("update");
    expect(update.exitCode).toBe(2);
    expect(update.stdout).toContain("code: READ_ONLY");
    expect(update.stdout).toContain("npm install -g mongo-axi@latest");
    const insert = await ro("insert", "orders", "{a: 1}");
    expect(insert.exitCode).toBe(2);
    expect(insert.stdout).toContain("mongo-rw-axi insert");
    expect((await ro("--help")).stdout).not.toContain("built-in");
    expect((await rw("--help")).stdout).not.toContain("built-in");
    expect((await rw("update", "--help")).stdout).toContain("usage: mongo-rw-axi update");
  });
});
