import { READ_COMMANDS, runCli, type MainOptions } from "../../core/src/cli.js";
import type { Tool } from "../../core/src/tool.js";
import { COLLECTION_HELP, collectionCommand, DB_HELP, dbCommand, INDEX_HELP, indexCommand } from "./commands/admin.js";
import { DELETE_HELP, deleteCommand, INSERT_HELP, insertCommand, UPDATE_HELP, updateCommand } from "./commands/docs.js";
import { IMPORT_HELP, importCommand } from "./commands/import.js";
import { loopbackOnly, notATunnel } from "./loopback.js";
import { shellWrite } from "./shell-write.js";
import { VERSION } from "./version.js";

export const TOOL: Tool = {
  name: "mongo-rw-axi",
  mode: "read-write",
  envPrefix: "MONGO_RW_AXI",
  banner: {
    warning: "WRITE-CAPABLE - insert; update; delete; import; index; collection and db can modify and DROP data",
    scope: "one loopback host or unix socket, direct connection. A port that answers as a remote replica set is refused; a tunnel to a standalone server is not detectable - never tunnel to a shared database",
    reads: "find; aggregate; describe and the other read commands still run read-only",
  },
  checkTarget: loopbackOnly,
  checkServer: notATunnel,
  writeHint: "Writes go through `mongo-rw-axi insert|update|delete` or the shell form `db.<collection>.updateOne(...)`",
  shellWrite,
};

export const DESCRIPTION =
  "WRITE ACCESS - MongoDB CLI for agents that CAN MODIFY AND DROP DATA on loopback databases (local dev): insert, update, delete, import, index, collection and db commands, plus every read-only mongo-axi command. Irreversible operations preview until --confirm. Use mongo-axi for anything that is not local.";

export const TOP_HELP = `usage: mongo-rw-axi [command] [args] [flags]
WARNING: WRITE-CAPABLE. insert, update, delete, import, index, collection and db change data; one loopback host or unix socket only.
Read commands (find, aggregate, ...) still run through the read-only guard - writes go through the write commands.
commands[22]:
  (none)=live overview (takes -p, -d), insert, update, delete, import, index, collection, db, databases, collections, describe, indexes, search, sample, query (alias find), count, distinct, aggregate, explain, doctor, auth, setup, context (session hooks)
  'db.<collection>.updateOne({...}, {...})' = mongosh shell form (reads and writes), parsed as data
connection flags (every command that connects):
  -p/--profile <name>, -d/--database <name>
examples:
  mongo-rw-axi
  mongo-rw-axi insert orders '{status: "paid", total: NumberDecimal("12.50")}'
  mongo-rw-axi update orders '{_id: ObjectId("66f1c2a9e4b0a1b2c3d4e5f6")}' '{$set: {status: "paid"}}'
  mongo-rw-axi delete sessions '{expires_at: {$lt: ISODate("2026-10-01")}}' --many
  mongo-rw-axi 'db.orders.updateMany({status: "pending"}, {$set: {status: "expired"}})'
  mongo-rw-axi import orders orders.jsonl -d shop_test
  mongo-rw-axi collection drop orders_tmp --confirm
  mongo-rw-axi update --help
`;

export async function main(options: MainOptions = {}): Promise<void> {
  await runCli(
    {
      tool: TOOL,
      version: VERSION,
      description: DESCRIPTION,
      topHelp: TOP_HELP,
      commands: {
        insert: { run: insertCommand, help: () => INSERT_HELP },
        update: { run: updateCommand, help: () => UPDATE_HELP },
        delete: { run: deleteCommand, help: () => DELETE_HELP },
        import: { run: importCommand, help: () => IMPORT_HELP },
        index: { run: indexCommand, help: () => INDEX_HELP },
        collection: { run: collectionCommand, help: () => COLLECTION_HELP },
        db: { run: dbCommand, help: () => DB_HELP },
        ...READ_COMMANDS,
      },
    },
    options,
  );
}
