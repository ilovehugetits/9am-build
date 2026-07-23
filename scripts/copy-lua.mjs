// tsc emits only .js — the CfxLua framework, helpers and runner are authored in
// Lua and read from disk at runtime, so they have to be copied into dist
// alongside the compiled output.
import { cp, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fromDir = path.join(root, "src", "cfxlua", "test");
const toDir = path.join(root, "dist", "cfxlua", "test");

await mkdir(toDir, { recursive: true });

const entries = (await readdir(fromDir)).filter((name) => name.endsWith(".lua"));
if (entries.length === 0) {
  throw new Error(`No .lua assets found in ${fromDir} — the published runner would be broken.`);
}

for (const name of entries) {
  await cp(path.join(fromDir, name), path.join(toDir, name));
  console.log(`copied ${path.relative(root, path.join(fromDir, name))} -> ${path.relative(root, path.join(toDir, name))}`);
}
