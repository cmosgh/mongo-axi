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
commands[15]:
  (none)=live overview (takes -p, -d), databases, collections, describe, indexes, search, sample, query (alias find), count, distinct, aggregate, explain, doctor, auth, setup, context (session hooks)
  'db.<collection>.find({...})' = mongosh shell form, parsed as data
connection flags (every command that reads):
  -p/--profile <name>, -d/--database <name>, --timeout <seconds> (default 30)
output flags (every command):
  --json (JSON instead of TOON, for scripts)
examples:
  mongo-axi collections --sort size
  mongo-axi describe orders customers
  mongo-axi find orders '{status: "paid", created_at: {$gte: ISODate("2026-10-01")}}' --sort '{created_at: -1}'
  mongo-axi aggregate orders '[{$group: {_id: "$status", n: {$sum: 1}}}]' -p staging -d shop
  mongo-axi 'db.orders.find({status: "paid"}).limit(5)'
  mongo-axi query --help
`;

const local = "local dev databases only";

/** mongo-rw-axi's commands: answered with where they live, not "unknown command". */
const REFUSED: Record<string, string> = {
  update: `Change documents with \`mongo-rw-axi update <collection> <filter> <update>\` (${local}); to upgrade mongo-axi a person runs \`npm install -g mongo-axi@latest\``,
  insert: `Insert with \`mongo-rw-axi insert <collection> <document>\` (${local})`,
  delete: `Delete with \`mongo-rw-axi delete <collection> <filter>\` (${local})`,
  import: `Load files with \`mongo-rw-axi import <collection> <file>\` (${local})`,
  index: `Create or drop indexes with \`mongo-rw-axi index create|drop\` (${local})`,
  collection: `Create, drop or rename collections with \`mongo-rw-axi collection create|drop|rename\` (${local})`,
  db: `Drop databases with \`mongo-rw-axi db drop\` (${local})`,
};

export async function main(options: MainOptions = {}): Promise<void> {
  await runCli({ tool: TOOL, version: VERSION, description: DESCRIPTION, topHelp: TOP_HELP, commands: READ_COMMANDS, refused: REFUSED }, options);
}
