# CfxLua Test Harness — Design

Date: 2026-07-23
Status: pending user review

## Problem

FiveM resources have no way to test their Lua outside a running server. The
current loop for `9am-vehicleshop` is documented in its `CLAUDE.md`: "There is
no test suite… Lua changes require a live FiveM server (`ensure
9am-vehicleshop` to restart)." Every logic change costs a server restart, and
regressions surface as runtime errors in production rather than as failed
assertions.

## Goal

`npx 9am-build test` (or `bunx 9am-build test`), run from a resource folder,
discovers `*.test.lua` files, executes them against a simulated FiveM
environment in a real Lua 5.4 VM, and reports pass/fail with tracebacks in a
format a coding agent can act on without a second run.

Non-goals: config validation, zip inspection, portal interaction, linting.
`test` is the only command the published package exposes.

## Runtime

[`wasmoon`](https://github.com/ceifa/wasmoon) v1.16 — Lua 5.4 compiled to
WebAssembly, MIT, pure npm install with no native build step. Runs identically
under Node ≥ 20.11 and Bun, which is what makes a single published CLI work for
both `npx` and `bunx`.

Verified: `9am-vehicleshop`'s Lua needs no preprocessing. Every backtick in the
resource is inside a comment or a SQL string literal — there are no CfxLua
backtick hash literals in expression position. `goto`/`::label::` are standard
Lua 5.4. Stock Lua compiles these files as-is.

## Architecture

Each module has one job and can be tested alone.

| Module | Responsibility | Deliberately unaware of |
|---|---|---|
| `src/cli.ts` | `#!/usr/bin/env node` entry, exposes only `test` | Everything below |
| `src/commands/test.ts` | Orchestration: discover → run → report → exit code | Lua internals |
| `src/lua/runtime.ts` | wasmoon VM lifecycle, sandbox `_G`, chunk naming | The stub contents |
| `src/lua/env/cfx.ts` | CFX native stubs + unknown-native proxy | The VM |
| `src/lua/env/oxlib.ts` | `lib.callback`, `lib.notify`, `lib.print`, `locale()` | The VM |
| `src/lua/env/oxmysql.ts` | `MySQL.query/insert/scalar/update` and `.await` variants | The VM |
| `src/lua/env/index.ts` | Composes the three into one sandbox table | — |
| `src/lua/harness.lua` | `describe/it/before_each/after_each`, `assert.*`, `harness.*` | JavaScript |
| `src/lua/discover.ts` | Find `**/*.test.lua`, excluding `web/` and `node_modules/` | Execution |
| `src/lua/report.ts` | Build a result object; render as text or JSON | Lua |

`report.ts` receives a plain result object and renders it. Both output formats
come from that one object, so they cannot drift apart.

### Chunk naming is load-bearing

Resource files are loaded as `load(source, "@" .. relativePath)`. Lua embeds the
chunk name in every traceback frame, so frames resolve to real, relative,
clickable paths (`server/purchase.lua:21`) instead of `[string "..."]:21`.
Without this the traceback is useless to an agent.

## Test API

A busted-compatible subset, so the same test files could later run under real
busted if this harness is ever outgrown.

```lua
-- server/purchase.test.lua
describe('parseColorSelection', function()
  before_each(function()
    harness.load('shared/config.lua', 'server/helpers.lua', 'server/purchase.lua')
  end)

  it('converts a custom hex to an RGB triple', function()
    local idx, hex, c1, c2 = parseColorSelection(-1, '#FF8000')
    assert.equal(-1, idx)
    assert.same({ 255, 128, 0 }, c1)
    assert.same(c1, c2)
  end)

  it('returns an error when the player is missing', function()
    harness.stub('Bridge', { GetPlayer = function() return nil end })
    local res = harness.callback('9am-vehicleshop:server:buyVehicle', 1, {})
    assert.falsy(res.success)
  end)
end)
```

| Function | Behaviour |
|---|---|
| `harness.load(...)` | Resets the sandbox globals to a pristine base snapshot, then loads the named resource files in order |
| `harness.stub(name, value)` | Overwrites a sandbox global |
| `harness.callback(name, source, ...)` | Invokes a handler registered via `lib.callback.register` |
| `harness.trigger(event, ...)` | Fires handlers registered via `RegisterNetEvent`/`AddEventHandler` |
| `assert.equal / same / truthy / falsy / has_error` | Assertions |

### Isolation

`harness.load` resetting to a base snapshot gives every `it()` a clean global
table without recreating the VM. Resource files define globals and register
event handlers as a side effect of loading; re-loading into a fresh table is the
only way to make repeated tests independent.

## Simulated environment

Batteries included. The env provides working fakes for CFX natives, ox_lib and
oxmysql so a resource loads with zero configuration; tests inject only their own
scenario data.

Any native the env does not know resolves through a proxy that returns `nil` and
**records the call site**. This matters: an unknown native silently returning
`nil` produces a downstream `attempt to index a nil value` several frames from
the real cause. The recorded list is printed with each failure and is usually
the actual root cause.

## Reporting

Agent-first: greppable, deterministic, every location a `path:line` anchor,
no box drawing, no unicode status glyphs. Paths are relative to the resource
root, which is the agent's working directory. Chalk disables color
automatically when stdout is not a TTY, so piped output is clean.

```
FAIL server/purchase.test.lua:16  parseColorSelection > returns 0 for unknown catalog index

  assertion  assert.equal
  expected   0
  actual     nil

  traceback
    server/purchase.lua:21: in function 'parseColorSelection'
    server/purchase.test.lua:18: in function <server/purchase.test.lua:16>

  source server/purchase.lua:21
    19 |     elseif colorIndex and colorIndex >= 0 then
    20 |         local gtaColor = Config.CatalogColors[colorIndex] or 0
    21 |         color1 = gtaColor
    22 |     end

  unstubbed natives called during this test
    GetVehicleNumberPlateText  server/purchase.lua:88
    GetEntityCoords            server/helpers.lua:143

PASS server/purchase.test.lua:9   parseColorSelection > converts a custom hex to an RGB triple

12 tests  11 passed  1 failed  340ms
```

Tracebacks are captured with `xpcall(fn, debug.traceback)`. The source frame is
read from disk by `report.ts` and rendered with two lines of context.

`--json` emits the same result object as one JSON document: tests, statuses,
assertion values, traceback frames, unstubbed natives, timings.

### Exit codes

| Condition | Code |
|---|---|
| All tests passed | 0 |
| One or more failures or errors | 1 |
| No `*.test.lua` files found | 0, with a prominent warning (`--strict` makes it 1) |

## Packaging

```jsonc
"name": "9am-build",              // verified available on npm
"bin":   { "9am-build": "dist/cli.js" },
"files": ["dist", "README.md", "LICENSE"],
"engines": { "node": ">=20.11" },
"dependencies":    { "wasmoon": "^1.16.0", "chalk": "^5.4.1", "glob": "^11.0.1" },
"devDependencies": { "archiver", "playwright", "@anthropic-ai/sdk", "tsx",
                     "typescript", "@types/*" },
"scripts": { "prepublishOnly": "tsc -p tsconfig.build.json" }
```

Three pure-JS/WASM runtime dependencies, no native build, no postinstall
browser download — `npx 9am-build test` is a fast cold start.

`playwright`, `@anthropic-ai/sdk`, `archiver` and `tsx` move to
`devDependencies`. They are unreachable from `cli.ts`, so consumers never
install them. The `Dockerfile` runs a plain `bun install` (dev dependencies
included), so the Coolify deployment of `deploy`/`server` is unaffected.

`tsconfig.build.json` sets `"files": ["src/cli.ts"]` so tsc emits only the
transitive graph. Source imports already carry `.js` extensions, so the ESM
output runs natively under Node. The shebang lives at the top of `src/cli.ts`;
tsc preserves it.

`src/index.ts`, `src/core/git.ts` and `src/commands/shared.ts` keep their
`Bun.spawnSync` calls and stay outside `dist/`. No Bun-to-Node refactor is
required.

Published via `npm login && npm publish` — unscoped and public by default. The
`@9am` npm scope belongs to an unrelated user, so scoped naming is not an
option.

## Verification

1. Unit tests (`bun test`) for `discover`, `report` (traceback and source-frame
   formatting, JSON shape) and `env/*`.
2. A deliberately broken fixture resource under `test/fixtures/` that asserts
   the report points at the correct file and line — this is what proves the
   chunk-naming and traceback resolution actually work.
3. Acceptance: write a starter suite of 3–5 real tests for `9am-vehicleshop`
   (`parseColorSelection`, `getShopConfig`, `IsVehicleshopAdmin`) and run
   `npx 9am-build test` in that folder.

## Consequences for the resource repo

Two changes land in `9am-vehicleshop`, both requiring the owner's approval:

1. The starter test suite from Verification step 3.
2. `**/*.test.lua` added to `exclude` in `upload-config.json`, so test files
   never ship in the escrow or open zip.
