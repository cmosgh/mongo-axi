import { READ_COMMANDS, runCli, type MainOptions } from "../../core/src/cli.js";
import type { Tool } from "../../core/src/tool.js";
import { VERSION } from "./version.js";

export const TOOL: Tool = {
  name: "mongo-axi",
  mode: "read-only",
  envPrefix: "MONGO_AXI",
  banner: {
    mode: "READ-ONLY - find; aggregate; count; distinct; explain. Write stages and server-side JavaScript are refused; results capped at 20 docs",
  },
};

export const DESCRIPTION =
  "READ-ONLY MongoDB CLI for agents - infer schemas and run capped read queries, with TOON output. Filters are parsed as data (never evaluated) and every command is checked against a read allowlist before it is sent (not a role check).";

export const TOP_HELP = `usage: mongo-axi [command] [args] [flags]
commands[14]:
  (none)=overview, databases, collections, describe, indexes, search, sample, query (alias find), count, distinct, aggregate, explain, doctor, auth, setup
  'db.<collection>.find({...})' = mongosh shell form, parsed as data
connection flags (every command that reads):
  -p/--profile <name>, -d/--database <name>, --timeout <seconds> (default 30)
examples:
  mongo-axi collections --sort size
  mongo-axi describe orders customers
  mongo-axi find orders '{status: "paid", created_at: {$gte: ISODate("2026-10-01")}}' --sort '{created_at: -1}'
  mongo-axi aggregate orders '[{$group: {_id: "$status", n: {$sum: 1}}}]' -p staging -d shop
  mongo-axi 'db.orders.find({status: "paid"}).limit(5)'
  mongo-axi query --help
`;

export async function main(options: MainOptions = {}): Promise<void> {
  await runCli({ tool: TOOL, version: VERSION, description: DESCRIPTION, topHelp: TOP_HELP, commands: READ_COMMANDS }, options);
}
