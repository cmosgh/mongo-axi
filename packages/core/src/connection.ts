import { MongoClient, type Db, type Document, type MongoClientOptions } from "mongodb";
import { ConnectionString } from "mongodb-connection-string-url";
import { fromDriverError } from "./errors.js";
import { wireRefusal, type WireGuard } from "./guard.js";
import { describeTarget, type Target } from "./target.js";
import { tool } from "./tool.js";

export interface SessionOptions {
  /** Checked on every command just before it is written to the socket; a reason stops it. */
  wireGuard: WireGuard;
  /** Server-side limit (maxTimeMS) commands pass on. */
  timeoutMs: number;
  /** Extra driver options (the write tool's directConnection). */
  driver?: MongoClientOptions;
}

export class Session {
  constructor(
    readonly client: MongoClient,
    readonly target: Target,
    readonly timeoutMs: number,
  ) {}

  /** The named database, else -d / the profile's default. */
  db(name?: string): Db {
    return this.client.db(name ?? this.target.database);
  }

  /** `hello`, or `isMaster` on servers older than 4.4.2. */
  async hello(): Promise<Document> {
    const admin = this.client.db("admin");
    try {
      return await admin.command({ hello: 1 });
    } catch {
      return admin.command({ isMaster: 1 });
    }
  }
}

function clientOptions(target: Target, options: SessionOptions): MongoClientOptions {
  const cs = new ConnectionString(target.uri);
  return {
    appName: tool().name,
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    // Agents run many short processes in parallel: per process, one polling monitor per member
    // (streaming would add an RTT socket each) plus two pooled connections.
    maxPoolSize: 2,
    serverMonitoringMode: "poll",
    // Every command is seen by the wire guard before it is sent.
    monitorCommands: true,
    // Regex values stay as BSONRegExp: PCRE patterns need not compile in JavaScript.
    bsonRegExp: true,
    ...(target.password !== undefined ? { auth: { username: decodeURIComponent(cs.username), password: target.password } } : {}),
    ...options.driver,
  };
}

export async function openSession(target: Target, options: SessionOptions): Promise<Session> {
  const client = new MongoClient(target.uri, clientOptions(target, options));
  // The driver emits commandStarted synchronously before the write; throwing here stops the command.
  client.on("commandStarted", (event) => {
    const reason = options.wireGuard(event.commandName, event.command as Record<string, unknown>, event.databaseName);
    if (reason) throw wireRefusal(event.commandName, reason);
  });
  try {
    await client.connect();
    const session = new Session(client, target, options.timeoutMs);
    await tool().checkServer?.(session);
    return session;
  } catch (error) {
    await client.close().catch(() => {});
    throw fromDriverError(error, describeTarget(target));
  }
}

export async function withSession<T>(target: Target, options: SessionOptions, fn: (session: Session) => Promise<T>): Promise<T> {
  const session = await openSession(target, options);
  try {
    return await fn(session);
  } catch (error) {
    throw fromDriverError(error, describeTarget(target));
  } finally {
    await session.client.close().catch(() => {});
  }
}
