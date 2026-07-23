// tsc emits only .js — the CfxLua framework, helpers, runner and batteries are
// authored in Lua and read from disk at runtime, so they have to be copied into
// dist alongside the compiled output.
import { cp, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fromDir = path.join(root, "src", "cfxlua", "test");
const toDir = path.join(root, "dist", "cfxlua", "test");

await mkdir(toDir, { recursive: true });

const entries = (await readdir(fromDir, { recursive: true })).filter((name) => name.endsWith(".lua"));
if (entries.length === 0) {
  throw new Error(`No .lua assets found in ${fromDir} — the published runner would be broken.`);
}

for (const name of entries) {
  const from = path.join(fromDir, name);
  const to = path.join(toDir, name);
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to);
  console.log(`copied ${path.relative(root, from)} -> ${path.relative(root, to)}`);
}
