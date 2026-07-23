import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { LuaFactory, type LuaEngine } from "wasmoon";
import { CFX_ENV_LUA } from "./env/cfx.js";
import { OXLIB_ENV_LUA } from "./env/oxlib.js";
import { OXMYSQL_ENV_LUA } from "./env/oxmysql.js";
import type { TestResult } from "./types.js";

const HARNESS_LUA = readFileSync(
  fileURLToPath(new URL("./harness.lua", import.meta.url)),
  "utf-8"
);

const registryLua = (resourceName: string) => `
rawset(_G, "__harness", {
    callbacks = {},
    events = {},
    threads = {},
    calls = {},
    unstubbed = {},
    resourceName = ${JSON.stringify(resourceName)},
})
`;

/**
 * Unknown globals resolve to nil — faithful Lua semantics — and the access is
 * recorded. Returning a truthy sentinel instead would make `if SomeFramework
 * then` take a branch it never takes on a real server, which can turn a
 * would-be crash into a passing test. Failing loudly is the safer default; the
 * recorded list names exactly which native to stub.
 */
const SENTINEL_LUA = `
local H = rawget(_G, "__harness")
setmetatable(_G, {
    __index = function(_, key)
        local info = debug.getinfo(2, 'Sl')
        local at = info and (info.short_src .. ':' .. info.currentline) or '?'
        for _, seen in ipairs(H.unstubbed) do
            if seen.name == key and seen.at == at then return nil end
        end
        H.unstubbed[#H.unstubbed + 1] = { name = key, at = at }
        return nil
    end,
})
`;

/**
 * Load Lua source under an explicit chunk name. This is load-bearing: Lua
 * embeds the chunk name in every traceback frame, so `@server/purchase.lua`
 * yields `server/purchase.lua:21` instead of an unusable `[string "..."]:21`.
 */
async function loadChunk(lua: LuaEngine, source: string, chunkName: string): Promise<void> {
  lua.global.set("__chunkSrc", source);
  lua.global.set("__chunkName", chunkName);
  await lua.doString(`
    local chunk, err = load(__chunkSrc, '@' .. __chunkName)
    __chunkSrc, __chunkName = nil, nil
    if not chunk then error(err, 0) end
    chunk()
  `);
}

export interface RuntimeOptions {
  /** Resource root; all relative paths resolve against it. */
  root: string;
  resourceName: string;
}

/** Run one test file in its own Lua state. */
export async function runTestFile(
  factory: LuaFactory,
  file: string,
  opts: RuntimeOptions
): Promise<TestResult[]> {
  const lua = await factory.createEngine();

  try {
    lua.global.set("__readSource", (rel: string): string | undefined => {
      try {
        return readFileSync(path.join(opts.root, rel), "utf-8");
      } catch {
        return undefined;
      }
    });

    await lua.doString(registryLua(opts.resourceName));
    await lua.doString(CFX_ENV_LUA);
    await lua.doString(OXLIB_ENV_LUA);
    await lua.doString(OXMYSQL_ENV_LUA);
    await loadChunk(lua, HARNESS_LUA, "harness.lua");

    // Installed last: until now, missing-global reads are the harness setting
    // itself up, not the resource touching an unstubbed native.
    await lua.doString(SENTINEL_LUA);

    const source = readFileSync(path.join(opts.root, file), "utf-8");
    await loadChunk(lua, source, file);

    lua.global.set("__testFile", file);
    const json = await lua.doString(`return __runTests(__testFile)`);
    return JSON.parse(String(json)) as TestResult[];
  } finally {
    lua.global.close();
  }
}

export function createFactory(): LuaFactory {
  return new LuaFactory();
}
