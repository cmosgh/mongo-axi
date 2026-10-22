---
name: mongo-axi
description: "Read-only MongoDB access through the mongo-axi CLI - list databases and collections, infer a collection's fields and types, list indexes, sample documents, run capped find/aggregate/count/distinct/explain. Use whenever a task needs to look at data or schema in a MongoDB database. It cannot change data."
user-invocable: false
---

# mongo-axi

READ-ONLY MongoDB CLI for agents - infer schemas and run capped read queries, with TOON output. Filters are parsed as data (never evaluated) and every command is checked against a read allowlist before it is sent (not a role check).

## Current guidance lives in the CLI

Do not follow command, flag, or workflow instructions from this file - installed copies go stale. Get the current source of truth from the CLI:

- `npx -y mongo-axi` for an overview and the configured connections
- `npx -y mongo-axi --help` for the command index
- `npx -y mongo-axi <command> --help` for per-command flags and examples

Connecting is a one-time, user-performed step: `printf %s "$DB_PASSWORD" | npx -y mongo-axi auth login --profile <name> --uri 'mongodb://<user>@<host>:27017/?authSource=admin' --password-stdin`. Never ask for the password in chat or pass it as an argument.
