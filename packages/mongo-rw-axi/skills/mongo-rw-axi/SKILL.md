---
name: mongo-rw-axi
description: "WRITE ACCESS to LOCAL MongoDB databases through the mongo-rw-axi CLI - insert, update and delete documents, create and drop indexes and collections, import JSON. Use only when a task must change a local dev database; use mongo-axi for reading or for any non-local database."
user-invocable: false
---

# mongo-rw-axi

> **WARNING - this tool can modify and drop data.** It only connects directly to one loopback host or unix socket and refuses tunnels to replica sets whose members are not local. Irreversible operations preview until `--confirm`; read the preview before confirming.

WRITE ACCESS - MongoDB CLI for agents that CAN MODIFY AND DROP DATA on loopback databases (local dev): insert, update, delete, import, index, collection and db commands, plus every read-only mongo-axi command. Irreversible operations preview until --confirm. Use mongo-axi for anything that is not local.

## Current guidance lives in the CLI

Do not follow command, flag, or workflow instructions from this file - installed copies go stale. Get the current source of truth from the CLI:

- `npx -y mongo-rw-axi` for a live overview of the configured connection
- `npx -y mongo-rw-axi --help` for the command index
- `npx -y mongo-rw-axi <command> --help` for per-command flags and examples

Connecting is a one-time, user-performed step: `printf %s "$DB_PASSWORD" | npx -y mongo-rw-axi auth login --profile <name> --uri 'mongodb://<user>@<host>:27017/?authSource=admin' --password-stdin`. Never ask for the password in chat or pass it as an argument.
