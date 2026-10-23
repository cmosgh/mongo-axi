# mongo-axi - contributor notes for agents

Monorepo for two AXI MongoDB CLIs: `mongo-axi` (read-only) and `mongo-rw-axi` (writes, loopback only). Read the AXI principles (https://axi.md) before changing output.

- **The split is the safety model.** Write code (write commands, loopback and tunnel rule, write wire guard, shell-form writes) lives only in `packages/mongo-rw-axi`. `scripts/build.ts` fails if write-tool code ends up in the `mongo-axi` bundle. Never add a write path to `packages/core`.
- **Read path, always:**
  1. `packages/core/src/literal.ts` parses agent input as data; nothing is evaluated.
  2. `assertReadInput()` in `guard.ts` refuses write stages, server-side JavaScript and credential collections before connecting.
  3. `readWireGuard()` checks every command in the driver's `commandStarted` listener (`connection.ts`) and stops anything outside the read allowlist or without `maxTimeMS`.
  Read commands in `mongo-rw-axi` use the same path. A guard change needs cases in `test/guard.test.ts` and, for server behaviour, `test/integration/`.
- **Output is the product.** Every stdout byte costs tokens. Typed values print in mongosh form (`values.ts`) so they paste back into a filter. Keep numbers as numbers. Avoid commas, colons and double quotes in literal TOON strings.
- **Handlers return strings** built with `block()`, `helpBlock()`, `out()` and `fenced()` from `packages/core/src/render.ts`. Raw text (plans, validators, pipelines) goes between `---` fences.
- **Every flag is declared.** `parseArgs()` rejects unknown flags with the valid set inline. Validate input before connecting; usage errors and guard refusals exit 2.
- **A missing collection is an error** (`resolveCollection`), never an empty result: MongoDB returns nothing for a typo.
- **Mutations are idempotent and irreversible ones need `--confirm`,** previewing otherwise.
- **`context` runs at every session start** (the hook from `setup hooks`): it never connects or reads the keychain, and exits 0. The no-argument home view connects with short limits and reports any failure as `live: unavailable` with exit 0.
- **Hints carry the connection:** build next-step commands with `followUp()` and reruns with `rerunHint()` (`packages/core/src/hints.ts`), so `-p`/`-d` and the exact command survive. `setup` touches only hooks whose binary is this tool (`hooks.ts`).
- **Secrets:** passwords come from stdin or `<PREFIX>_URL` only, are stored in the OS keychain, and are never echoed (driver errors and parse errors included).
- `packages/core/src/version.ts` and each package's `src/version.ts` are leaf modules (node builtins only) for the `--version` fast path.
- **Driver:** `mongodb` stays on `~6.16.0`, the last line that speaks wire version 7 (MongoDB 4.0 and the 3.7 dev series).
- **Tests:**
  - `test/guard.test.ts`, `test/unit.test.ts`, `test/rw-unit.test.ts` cover pure logic; `test/session.test.ts` covers hints, session capture, hooks and `setup`.
  - A test that runs `setup` sets `HOME` to a temp dir and clears `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `XDG_CONFIG_HOME` first: never write a developer's real agent config.
  - `test/integration/` (`pnpm run test:integration`, needs Docker) starts its own throwaway MongoDB container on a random loopback port (`MONGO_AXI_IT_IMAGE` picks the image): `ro`, `rw` (with a second replica-set container for the tunnel check), `scenarios` and `safety`. It never touches a local server. `safety-cases.ts` is the README's safety matrix: `safety.test.ts` checks every cell against `mongosh`, `mongodb-mcp-server --readOnly` (telemetry disabled) and `mongo-axi`, and `pnpm run safety:readme` renders it (`check` fails when the table is stale).
  - Fixtures are synthetic: never use real database, collection or people names.
- `pnpm run check` must pass. The `SKILL.md` files are generated with `pnpm run build:skill`. Package `dependencies` must match the root `devDependencies` (the build checks this).
