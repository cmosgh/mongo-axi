import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ConnectionString } from "mongodb-connection-string-url";
import type { Session } from "../../core/src/connection.js";
import { axiError } from "../../core/src/errors.js";
import { describeTarget, type Target } from "../../core/src/target.js";

const READ_ONLY_HINT = "Use mongo-axi (read-only) for any database that is not local";

export function isLoopback(address: string): boolean {
  const a = address.toLowerCase();
  return /^127\.\d+\.\d+\.\d+$/.test(a) || a === "::1" || a === "0:0:0:0:0:0:0:1" || /^::ffff:127\.\d+\.\d+\.\d+$/.test(a);
}

/** `[::1]:27017` -> ::1 and 27017; `localhost` -> localhost. */
export function splitHost(hostPort: string): { host: string; port?: string } {
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostPort);
  if (v6) return { host: v6[1]!, ...(v6[2] ? { port: v6[2] } : {}) };
  const colon = hostPort.lastIndexOf(":");
  return colon > 0 ? { host: hostPort.slice(0, colon), port: hostPort.slice(colon + 1) } : { host: hostPort };
}

function refuse(what: string, why: string): never {
  throw axiError(`refusing ${what} - ${why}; mongo-rw-axi only connects to one loopback host or unix socket`, "FORBIDDEN", [READ_ONLY_HINT]);
}

async function resolveAll(host: string): Promise<string[]> {
  try {
    return (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw axiError(`cannot resolve host '${host}'`, "NETWORK");
  }
}

/**
 * The write tool's hard rule, before connecting: one host that resolves only to loopback (or a unix socket),
 * reached directly. No flag or env var overrides it.
 */
export async function loopbackOnly(target: Target): Promise<Target> {
  const cs = new ConnectionString(target.uri);
  if (cs.isSRV) refuse("a mongodb+srv:// connection string", "SRV records name the members of a remote cluster");
  if (cs.hosts.length !== 1) refuse(`${cs.hosts.length} hosts`, "a seed list reaches past one server");
  for (const [key, value] of [...cs.searchParams]) {
    const k = key.toLowerCase();
    if (k === "loadbalanced" && value === "true") refuse("loadBalanced=true", "a load balancer fronts other servers");
    if (k.startsWith("proxy")) refuse(`the ${key} option`, "a proxy can reach any host");
    if ((k === "tls" || k === "ssl") && value === "true") refuse(`${key}=true`, "TLS to a loopback port is almost always a tunnel to a managed cluster");
    // The driver must never follow a replica set's member list to other hosts.
    if (k === "directconnection") cs.searchParams.delete(key);
  }
  cs.searchParams.set("directConnection", "true");

  const raw = cs.hosts[0]!;
  const socket = decodeURIComponent(raw);
  if (socket.startsWith("/") && socket.endsWith(".sock")) return { ...target, uri: cs.toString() };

  const { host, port } = splitHost(raw);
  const addresses = isIP(host) ? [host] : await resolveAll(host);
  const outside = addresses.filter((a) => !isLoopback(a));
  if (addresses.length === 0 || outside.length > 0) refuse(`host '${host}'${outside.length > 0 && outside[0] !== host ? ` (${outside.join("; ")})` : ""}`, "it is not a loopback address");
  // Connect to the address that was checked, not a name that could re-resolve elsewhere.
  // IPv4 first: mongod binds 127.0.0.1 by default, while localhost often resolves to ::1 first.
  const address = addresses.find((a) => a.startsWith("127.")) ?? addresses[0]!;
  cs.hosts = [`${address.includes(":") ? `[${address}]` : address}${port ? `:${port}` : ""}`];
  return { ...target, uri: cs.toString() };
}

/** Why a replica set member's address is not on this machine; undefined when it is (or is a container name). */
export async function memberProblem(member: string): Promise<string | undefined> {
  const host = splitHost(member).host.toLowerCase();
  if (isIP(host)) return isLoopback(host) ? undefined : "is not a loopback address";
  if (host === "localhost" || host.endsWith(".localhost") || host === "host.docker.internal") return undefined;
  let addresses: string[];
  try {
    addresses = (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    // Single-label names are docker-compose services and container names; a dotted name that does not resolve is someone else's network.
    return host.includes(".") ? "does not resolve here" : undefined;
  }
  const outside = addresses.filter((a) => !isLoopback(a));
  return outside.length > 0 ? `resolves to ${outside.join("; ")}` : undefined;
}

const names = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

/** After connecting: a loopback port that answers as a member of a remote replica set is a tunnel to it. */
export async function notATunnel(session: Session): Promise<void> {
  const hello = await session.hello();
  const members = [...new Set([...names(hello["hosts"]), ...names(hello["passives"]), ...names(hello["arbiters"])])];
  const problems: string[] = [];
  for (const member of members) {
    const problem = await memberProblem(member);
    if (problem) problems.push(`${member} ${problem}`);
  }
  if (problems.length === 0) return;
  throw axiError(
    `refusing ${describeTarget(session.target)} - it answers as replica set '${String(hello["setName"])}' whose member ${problems.slice(0, 3).join("; ")}, so the local port is a tunnel to that cluster`,
    "FORBIDDEN",
    [READ_ONLY_HINT, "A local replica set names its members localhost:<port>, 127.0.0.1:<port> or a container name"],
  );
}
