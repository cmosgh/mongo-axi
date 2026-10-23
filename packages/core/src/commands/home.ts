import { homedir } from "node:os";
import type { Document, MongoClientOptions } from "mongodb";
import { expectPositionals, parseArgs } from "../args.js";
import { readConfig } from "../config.js";
import { openSession, type Session } from "../connection.js";
import { AxiError, axiError, fromDriverError } from "../errors.js";
import { readWireGuard } from "../guard.js";
import { followUp } from "../hints.js";
import { block, helpBlock, humanBytes, out, type Obj } from "../render.js";
import { describeTarget, isConfigured, loginHint, profileTarget, selectedProfile, targetFromUri, URI_SHAPE, type Target } from "../target.js";
import { env, tool } from "../tool.js";
import { CONNECTION_FLAGS, targetFrom } from "./common.js";

/** Short limits: the overview must answer quickly even when the server does not. */
const QUICK: MongoClientOptions = { serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000, socketTimeoutMS: 8000, retryReads: false };
const COMMAND_MS = 5000;
const DEADLINE_MS = 10_000;
const TOP = 10;
const SYSTEM_DATABASES = new Set(["admin", "local", "config"]);

export const homeHelp = (): string => `usage: ${tool().name} [-p <profile>] [-d <database>]
Live overview: server version and topology, then the default database's collections or the largest databases.
Connects with short time limits; when the server cannot be reached it says why and still exits 0. \`${tool().name} context\` is the offline summary.
examples:
  ${tool().name}
  ${tool().name} -p staging -d shop
`;

/** The SDK's home header (`bin`, `description`), for views it does not render itself. */
export function homeHeader(description: string): string {
  const home = homedir();
  const bin = process.argv[1] ?? tool().name;
  return block({ bin: bin.startsWith(home) ? `~${bin.slice(home.length)}` : bin, description });
}

/** The configured connection and profiles, from config and env only: no network, no keychain. */
export function connectionStatus(): { blocks: string[]; help: string[] } {
  const urlVar = `${tool().envPrefix}_URL`;
  if (!isConfigured()) return { blocks: [block({ status: "not configured" })], help: [loginHint(), `Or set ${urlVar}=${URI_SHAPE.split(" or ")[0]}`] };
  const status: Obj = {};
  const url = env("URL");
  if (url) {
    try {
      status["connection"] = `${describeTarget(targetFromUri(url, urlVar, "env"))} (${urlVar})`;
    } catch {
      status["connection"] = `${urlVar} is set but invalid`;
    }
  }
  const active = selectedProfile();
  const profiles = Object.entries(readConfig().profiles ?? {}).map(([profile, p]) => {
    let target: string;
    try {
      target = describeTarget(profileTarget(profile, p, undefined));
    } catch {
      target = "invalid connection string";
    }
    return { name: profile, target, active: !url && profile === active };
  });
  return { blocks: [Object.keys(status).length > 0 ? block(status) : "", profiles.length > 0 ? block({ profiles }) : ""].filter(Boolean), help: [] };
}

/** Command hints shared by the overview and the session context: [explore, query, writes?]. */
export function exploreHelp(): string[] {
  const f = followUp;
  return [
    `Run \`${f("collections")}\`, \`${f("describe <collection>...")}\`, \`${f("search <name>")}\` or \`${f("sample <collection>")}\` to explore`,
    `Run \`${f(`find <collection> '{status: "paid"}'`)}\`, \`${f("aggregate <collection> '[...]'")}\` or \`${f("'db.<collection>.find({...})'")}\`; \`${tool().name} <command> --help\` for flags`,
    ...(tool().writeHint ? [tool().writeHint!] : []),
  ];
}

const connectionText = (target: Target): string =>
  `${describeTarget(target)} (${target.source === "env" ? `${tool().envPrefix}_URL` : `profile ${target.label}`})`;

function serverText(build: Document | undefined, hello: Document | undefined): string {
  const version = build?.["version"] ? `MongoDB ${String(build["version"])}` : "MongoDB (version not visible)";
  if (!hello) return version;
  if (hello["msg"] === "isdbgrid") return `${version} - sharded cluster (mongos)`;
  if (hello["setName"]) {
    const role = hello["isWritablePrimary"] || hello["ismaster"] ? "primary" : hello["secondary"] ? "secondary" : "member";
    return `${version} - replica set ${String(hello["setName"])} (${role})`;
  }
  return `${version} - standalone`;
}

interface Live {
  blocks: string[];
  help: string[];
}

async function databaseOverview(s: Session, database: string): Promise<Live> {
  const db = s.client.db(database);
  const [infos, stats] = await Promise.all([
    db
      .listCollections({}, { nameOnly: true, authorizedCollections: true })
      .toArray()
      .then((list) => list.filter((c) => !c.name.startsWith("system.")))
      .catch(() => undefined),
    db.command({ dbStats: 1 }).catch(() => undefined),
  ]);
  if (infos === undefined) {
    return { blocks: [block({ database, collections: "not visible to this account" })], help: [`Run \`${followUp("doctor")}\` to see the account's roles`] };
  }
  if (infos.length === 0) {
    return { blocks: [block({ database: `${database} - empty or not found` })], help: [`Run \`${followUp("databases", { database: false })}\` to list databases`] };
  }
  const views = infos.filter((c) => c.type === "view").length;
  const parts = [`${infos.length - views} collections`, ...(views > 0 ? [`${views} views`] : [])];
  // dbStats objects would also count system.views entries; `collections` has exact counts.
  if (stats) parts.push(humanBytes(Number(stats["storageSize"] ?? 0) + Number(stats["indexSize"] ?? 0)));
  const names = infos.map((c) => c.name).sort((a, b) => a.localeCompare(b));
  const shown = names.slice(0, TOP * 2);
  const collections = names.length > shown.length ? [...shown, `+${names.length - shown.length} more`] : shown;
  return {
    blocks: [block({ database: `${database} - ${parts.join("; ")}` }), block({ collections })],
    help: [`Run \`${followUp("collections")}\` for counts and sizes; \`${followUp("describe <collection>")}\` for fields and indexes`],
  };
}

async function serverOverview(s: Session): Promise<Live> {
  let listed: Array<{ name: string; sizeOnDisk?: number }>;
  try {
    listed = (await s.client.db("admin").admin().listDatabases({ nameOnly: false, authorizedDatabases: true })).databases;
  } catch {
    return { blocks: [block({ databases: "not visible to this account" })], help: ["Pass -d <database> to see one database"] };
  }
  const dbs = listed.filter((d) => !SYSTEM_DATABASES.has(d.name)).sort((a, b) => Number(b.sizeOnDisk ?? 0) - Number(a.sizeOnDisk ?? 0));
  if (dbs.length === 0) return { blocks: [block({ databases: "none besides admin, local and config" })], help: [] };
  const rows = dbs.slice(0, TOP).map((d) => ({ name: d.name, size: d.sizeOnDisk === undefined ? null : humanBytes(Number(d.sizeOnDisk)) }));
  const help = [`Run \`${followUp("collections -d <database>", { database: false })}\` to list a database's collections`];
  if (dbs.length > rows.length) help.unshift(`Largest ${rows.length} of ${dbs.length} shown - \`${followUp("databases", { database: false })}\` lists all`);
  return { blocks: [block({ databases: rows })], help };
}

async function liveOverview(target: Target): Promise<Live> {
  const session = await openSession(target, { wireGuard: readWireGuard, timeoutMs: COMMAND_MS, driver: QUICK });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(axiError(`no answer within ${DEADLINE_MS / 1000} s`, "TIMEOUT")), DEADLINE_MS);
  });
  try {
    return await Promise.race([
      (async () => {
        const admin = session.client.db("admin");
        const [build, hello] = await Promise.all([admin.command({ buildInfo: 1 }).catch(() => undefined), session.hello().catch(() => undefined)]);
        const detail = target.database ? await databaseOverview(session, target.database) : await serverOverview(session);
        return { blocks: [block({ server: serverText(build, hello) }), ...detail.blocks], help: detail.help };
      })(),
      deadline,
    ]);
  } catch (error) {
    throw fromDriverError(error, describeTarget(target));
  } finally {
    clearTimeout(timer);
    await session.client.close().catch(() => {});
  }
}

/**
 * The no-argument view: connects with short limits and shows live state. Any failure is reported
 * as `live: unavailable` with exit 0, so it is safe to run first in every session.
 */
export async function homeCommand(args: string[] = []): Promise<string> {
  const name = tool().name;
  const parsed = parseArgs(args, CONNECTION_FLAGS, name);
  expectPositionals(parsed, 0, `${name} [-p <profile>] [-d <database>]`);
  const banner = block(tool().banner);
  if (!isConfigured()) {
    const status = connectionStatus();
    return out(banner, ...status.blocks, helpBlock(status.help));
  }
  let target: Target | undefined;
  try {
    target = await targetFrom(parsed);
    const live = await liveOverview(target);
    // The live hints already point at collections and describe.
    return out(banner, block({ connection: connectionText(target) }), ...live.blocks, helpBlock([...live.help, ...exploreHelp().slice(1)]));
  } catch (error) {
    // Flags the agent typed get a real error; the bare overview never fails.
    if (args.length > 0 && error instanceof AxiError && error.code === "VALIDATION_ERROR") throw error;
    const axi = error instanceof AxiError ? error : fromDriverError(error, target ? describeTarget(target) : "the server");
    return out(
      banner,
      ...(target ? [block({ connection: connectionText(target) })] : connectionStatus().blocks),
      block({ live: `unavailable - ${axi.message}` }),
      helpBlock([...axi.suggestions, `Run \`${followUp("doctor")}\` to diagnose`]),
    );
  }
}
