import type { Document } from "mongodb";
import { expectPositionals, parseArgs } from "../args.js";
import type { Session } from "../connection.js";
import { block, helpBlock, out, type Obj } from "../render.js";
import { describeTarget } from "../target.js";
import { tool } from "../tool.js";
import { CONNECTION_FLAGS, CONNECTION_FLAGS_HELP, read, targetFrom, TIMEOUT_FLAG } from "./common.js";

const SHOWN = 8;

/** Actions that cannot change data, schema, users or server state. */
const READ_ACTIONS = new Set([
  "find",
  "listCollections",
  "listIndexes",
  "listDatabases",
  "listSearchIndexes",
  "collStats",
  "dbStats",
  "dbHash",
  "indexStats",
  "changeStream",
  "killCursors",
  "serverStatus",
  "top",
  "connPoolStats",
  "hostInfo",
  "inprog",
  "listSessions",
  "netstat",
  "getCmdLineOpts",
  "getLog",
  "getParameter",
  "getDefaultRWConcern",
  "replSetGetConfig",
  "replSetGetStatus",
  "listShards",
  "getShardMap",
  "shardingState",
  "planCacheRead",
  "validate",
  "useUUID",
  "checkMetadataConsistency",
  "listClusterCatalog",
  "queryStatsRead",
  "operationMetrics",
  "bypassDefaultMaxTimeMS",
]);

/** Listed first: the actions that change data or access. */
const KEY_WRITES = ["insert", "update", "remove", "dropDatabase", "dropCollection", "createCollection", "createIndex", "dropIndex", "renameCollectionSameDB", "createUser", "grantRole", "shutdown"];

const writeOrder = (a: string, b: string): number => {
  const [ka, kb] = [KEY_WRITES.indexOf(a), KEY_WRITES.indexOf(b)];
  if (ka !== kb) return ka === -1 ? 1 : kb === -1 ? -1 : ka - kb;
  return a.localeCompare(b);
};

export interface Privileges {
  users: string[];
  roles: string[];
  write: string[];
}

/** The authenticated users, their roles and every action outside the read set. */
export function summarizePrivileges(status: Document): Privileges {
  const auth = (status["authInfo"] ?? {}) as Document;
  const users = ((auth["authenticatedUsers"] ?? []) as Document[]).map((u) => `${String(u["user"])}@${String(u["db"])}`);
  const roles = ((auth["authenticatedUserRoles"] ?? []) as Document[]).map((r) => `${String(r["role"])}@${String(r["db"])}`);
  const write = new Set<string>();
  for (const privilege of (auth["authenticatedUserPrivileges"] ?? []) as Document[]) {
    for (const action of (privilege["actions"] ?? []) as string[]) if (!READ_ACTIONS.has(action)) write.add(action);
  }
  return { users, roles, write: [...write].sort(writeOrder) };
}

const listed = (items: readonly string[]): string => (items.length > SHOWN ? `${items.slice(0, SHOWN).join("; ")} (+${items.length - SHOWN} more)` : items.join("; "));

/** Sends a harmless non-read command; the wire guard must stop it before the socket. */
async function wireGuardStops(s: Session): Promise<boolean> {
  try {
    await s.client.db("admin").command({ getParameter: 1, featureCompatibilityVersion: 1 });
    return false;
  } catch (error) {
    return /wire guard stopped/.test((error as Error).message ?? "");
  }
}

function topology(hello: Document): string {
  if (hello["msg"] === "isdbgrid") return "sharded cluster (mongos)";
  if (hello["setName"]) return `replica set ${String(hello["setName"])} (${hello["isWritablePrimary"] ?? hello["ismaster"] ? "primary" : hello["secondary"] ? "secondary" : "member"})`;
  return "standalone";
}

export const doctorHelp = (): string => `usage: ${tool().name} doctor [flags]
Connects and reports the server, topology, the user's roles and whether they can write, and checks the wire guard.
flags:
  ${CONNECTION_FLAGS_HELP}, --timeout <seconds>
`;

export async function doctorCommand(args: string[]): Promise<string> {
  const command = `${tool().name} doctor`;
  const parsed = parseArgs(args, [...CONNECTION_FLAGS, TIMEOUT_FLAG], command);
  expectPositionals(parsed, 0, command);
  const target = await targetFrom(parsed);
  const started = Date.now();
  const facts = await read(target, parsed, async (s) => {
    const admin = s.client.db("admin");
    await admin.command({ ping: 1 });
    const latency = Date.now() - started;
    const [build, hello, status] = await Promise.all([admin.command({ buildInfo: 1 }), s.hello(), admin.command({ connectionStatus: 1, showPrivileges: true })]);
    const privileges = summarizePrivileges(status);
    // No users and listDatabases still works: the server runs without access control.
    let open = false;
    if (privileges.users.length === 0) {
      try {
        await admin.admin().listDatabases({ nameOnly: true });
        open = true;
      } catch {
        open = false;
      }
    }
    return { latency, build, hello, privileges, open, guard: await wireGuardStops(s) };
  });

  const { privileges } = facts;
  const report: Obj = {
    target: `${describeTarget(target)} (${target.source === "env" ? target.label : `profile ${target.label}`})`,
    connection: `ok (${facts.latency} ms)`,
    server: String(facts.build["version"] ?? "unknown"),
    topology: topology(facts.hello),
    ...(Array.isArray(facts.hello["hosts"]) ? { members: (facts.hello["hosts"] as string[]).join("; ") } : {}),
    user: privileges.users.join("; ") || "none (not authenticated)",
  };
  if (privileges.roles.length > 0) report["roles"] = listed(privileges.roles);
  report["privileges"] = facts.open
    ? "everything - the server has no access control"
    : privileges.write.length > 0
      ? `write-capable - ${listed(privileges.write)}`
      : privileges.users.length > 0
        ? "read-only"
        : "none";
  report["wire_guard"] = facts.guard ? "verified - a non-read command was stopped before it was sent" : "NOT ACTIVE";
  report["database"] = target.database ?? "none (pass -d)";

  const help: string[] = [];
  let warning: Obj | undefined;
  if (tool().mode === "read-only" && (facts.open || privileges.write.length > 0)) {
    warning = {
      warning: `${facts.open ? "anyone who reaches this server can write" : "these credentials can write"} - ${tool().name} only sends read commands (input guard plus wire allowlist); it is not a role check`,
    };
    help.push(
      `For a hard guarantee use a read-only user - db.getSiblingDB("admin").createUser({user: "agent_ro", pwd: passwordPrompt(), roles: [{role: "read", db: "${target.database ?? "<database>"}"}]})`,
    );
  }
  if (!facts.guard) help.unshift("The wire guard did not stop a non-read command - do not use this build; please report it");
  return out(warning && block(warning), block({ doctor: report }), helpBlock(help));
}
