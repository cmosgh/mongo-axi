// Bundles each CLI (with packages/core inlined) into packages/<name>/dist.
// npm dependencies stay external and must match the package's dependencies.
import { chmodSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const ROOT = new URL("..", import.meta.url).pathname;
const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as { devDependencies: Record<string, string> };

// Driver write calls and write-tool names. Their presence in mongo-axi's bundle fails the build.
const WRITE_ONLY_MARKERS = [
  ".insertOne(",
  ".insertMany(",
  ".updateOne(",
  ".updateMany(",
  ".replaceOne(",
  ".deleteOne(",
  ".deleteMany(",
  ".findOneAndUpdate(",
  ".findOneAndReplace(",
  ".findOneAndDelete(",
  ".bulkWrite(",
  ".dropDatabase(",
  ".dropCollection(",
  ".drop(",
  ".createIndex(",
  ".createIndexes(",
  ".dropIndex(",
  ".rename(",
  ".createCollection(",
  "loopbackOnly",
  "WRITE_WIRE_COMMANDS",
];

function packageName(specifier: string): string | undefined {
  if (specifier.startsWith("node:") || specifier.startsWith(".")) return undefined;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

for (const name of ["mongo-axi", "mongo-rw-axi"]) {
  const dir = join(ROOT, "packages", name);
  const dist = join(dir, "dist");
  rmSync(dist, { recursive: true, force: true });
  const result = await build({
    entryPoints: [join(dir, "bin", `${name}.ts`)],
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outdir: dist,
    // Chunks stay next to the entry so `../package.json` resolves from every file.
    chunkNames: "[name]-[hash]",
    packages: "external",
    metafile: true,
    logLevel: "warning",
  });
  chmodSync(join(dist, `${name}.js`), 0o755);

  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as { dependencies: Record<string, string> };
  const imported = new Set<string>();
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imp of output.imports) {
      const dep = imp.external ? packageName(imp.path) : undefined;
      if (dep) imported.add(dep);
    }
  }
  const declared = Object.keys(pkg.dependencies).sort();
  const used = [...imported].sort();
  if (declared.join() !== used.join()) throw new Error(`${name}: dependencies ${declared.join(", ")} != imported ${used.join(", ")}`);
  for (const dep of declared) {
    if (pkg.dependencies[dep] !== rootPkg.devDependencies[dep]) throw new Error(`${name}: ${dep} ${pkg.dependencies[dep]} != root ${rootPkg.devDependencies[dep]}`);
  }

  if (name === "mongo-axi") {
    for (const file of readdirSync(dist)) {
      const code = readFileSync(join(dist, file), "utf-8");
      const leak = WRITE_ONLY_MARKERS.find((m) => code.includes(m));
      if (leak) throw new Error(`mongo-axi bundle ${file} contains write-tool code ('${leak}')`);
    }
  }
  console.log(`built ${name} (${readdirSync(dist).length} files)`);
}
