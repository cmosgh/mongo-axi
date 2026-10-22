// Generates packages/<name>/skills/<name>/SKILL.md from each package's src/skill.ts.
//
//   pnpm run build:skill            # write the files
//   pnpm run build:skill -- --check # exit 1 if a committed file is stale
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { skillMarkdown as roSkill } from "../packages/mongo-axi/src/skill.js";
import { skillMarkdown as rwSkill } from "../packages/mongo-rw-axi/src/skill.js";

const check = process.argv.includes("--check");
let stale = false;
for (const [name, render] of [["mongo-axi", roSkill], ["mongo-rw-axi", rwSkill]] as const) {
  const dir = new URL(`../packages/${name}/skills/${name}/`, import.meta.url);
  const target = new URL("SKILL.md", dir);
  const expected = render();
  if (check) {
    if ((await readFile(target, "utf8").catch(() => null)) !== expected) {
      console.error(`packages/${name}/skills/${name}/SKILL.md is out of date. Run \`pnpm run build:skill\` and commit the result.`);
      stale = true;
    }
  } else {
    await mkdir(dir, { recursive: true });
    await writeFile(target, expected);
    console.log(`Wrote packages/${name}/skills/${name}/SKILL.md`);
  }
}
if (stale) process.exit(1);
if (check) console.log("SKILL.md files are up to date.");
