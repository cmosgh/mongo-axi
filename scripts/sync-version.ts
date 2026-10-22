// `npm version <bump>` at the root runs this (the "version" lifecycle script):
// both CLIs are released in lockstep with the root version.
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../package.json", import.meta.url);
const { version } = JSON.parse(readFileSync(root, "utf-8")) as { version: string };
for (const name of ["mongo-axi", "mongo-rw-axi"]) {
  const path = new URL(`../packages/${name}/package.json`, import.meta.url);
  const pkg = JSON.parse(readFileSync(path, "utf-8")) as { version: string };
  pkg.version = version;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`${name} -> ${version}`);
}
