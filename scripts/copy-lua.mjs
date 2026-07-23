// tsc emits only .js — the harness is authored in Lua and read at runtime,
// so it has to be copied into dist alongside the compiled output.
import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "src", "lua", "harness.lua");
const to = path.join(root, "dist", "lua", "harness.lua");

await mkdir(path.dirname(to), { recursive: true });
await cp(from, to);
console.log(`copied ${path.relative(root, from)} -> ${path.relative(root, to)}`);
