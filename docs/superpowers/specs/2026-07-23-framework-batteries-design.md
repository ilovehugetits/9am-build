# Framework Batteries (QBCore / QBox / ESX / ox_lib) — Design

Date: 2026-07-23
Status: implemented on `feat/framework-batteries`

## Problem

`9am-build test` runs a resource's Lua inside the CfxLua VM, whose runtime
stubs cover FXServer natives and oxmysql's `MySQL`. Nothing covers the
framework layer. A file like `9am-vehicleshop/server/bridge.lua` does this on
load:

```lua
local isQBox = GetResourceState('qbx_core') == 'started'   -- always "missing"
...
error('[9am-vehicleshop] No supported framework found ...')
```

so any file that touches `QBCore`, `exports.qbx_core`, `ESX` or `lib.*` either
errors at load or silently exercises magic-mock stubs that return `nil`
everywhere. Every such test starts with a wall of hand-written stubs.

## Goal

Batteries included: a resource written against ox_lib, QBCore, QBox
(`qbx_core`) or ESX (`es_extended`) loads under the harness with zero
configuration, and tests get a small control API to seed players, switch the
active framework, and observe side effects (money, items, notifications,
callbacks).

Non-goals: client-only surfaces (`lib.zones`, `lib.points`, NUI), statebags
beyond what the runtime already stubs, persistence (the `MySQL` stub stays the
runtime's no-op), inventory resources (ox_inventory et al).

## Approaches considered

1. **Independent stub files per framework, no shared state.** Simple, but a
   player seeded for QBCore is invisible to the ESX view, and a bridge-style
   file (the 9AM house pattern) cannot be tested across frameworks in one
   suite.
2. **Shared player-state core + per-framework adapter views + an active
   framework switch.** One `addPlayer` seeds one canonical record; QBCore,
   QBox and ESX each expose it in their own shape. `GetResourceState` reports
   exactly one framework as `started` — like a real server — and tests can
   switch it at runtime to drive every branch of a bridge. **Chosen.**
3. **Load the real framework sources from GitHub.** Highest fidelity, but a
   network-dependent, version-chasing dependency for a unit-test harness, and
   the real cores demand a database and event loop the harness deliberately
   does not have.

## Architecture

New Lua assets under `src/cfxlua/test/batteries/`, loaded by `runner.lua`
after `framework.lua`/`helpers.lua` and before any spec file:

| Module | Responsibility |
|---|---|
| `state.lua` | Canonical player records, jobs registry, notification log, unified callback/useable-item registries, the QB-shape player factory |
| `oxlib.lua` | Global `lib` (`callback`, `notify`, `print`, `locale`, `table`, `string`, `math`, `addCommand`, `logger`) + `locale()` fallback + `cache` |
| `qbcore.lua` | Global `QBCore`, `exports['qb-core']` (`GetCoreObject`, `AddJob`, `UpdateJob`), `QBCore.Functions.*`, `QBCore.Shared.*`, `QBCore.Commands.Add` |
| `qbox.lua` | `exports.qbx_core` (`GetPlayer`, `GetQBPlayers`, `GetPlayerByCitizenId`, `SetJob`, `GetJobs`, `CreateJob`, `GetDutyCountJob`, money ops, `Notify`, …) |
| `esx.lua` | `ESX` shared object via `exports['es_extended']:getSharedObject()`: `GetPlayerFromId/-Identifier`, `GetExtendedPlayers`, `GetJobs`, server callbacks, usable items, xPlayer adapters |
| `init.lua` | Reads the battery selection, loads the above in order, installs the `GetResourceState` overlay and `TestHelpers` extensions |

The API surface is the one real 9AM resources consume (verified against
`9am-vehicleshop`'s `server/bridge.lua` and `client/framework.lua`), extended
to the common documented core of each framework — not an exhaustive re-implementation.

### One state, three views

`state.lua` holds one record per player source:

```lua
{ source, citizenid, license, firstname, lastname,
  job = { name, label, grade, gradeName, isboss, onduty },
  money = { cash, bank, crypto },
  items = { { name, label, amount, info, slot }, ... },
  metadata = {} }
```

`qbcore.lua`/`qbox.lua` wrap it as the QB player object
(`player.PlayerData.*` + `player.Functions.*`); `esx.lua` wraps it as an
xPlayer (`getMoney`, `getAccount`, `addInventoryItem`, `setJob`, …). Both
views mutate the same record, so money removed through
`QBCore.Functions.RemoveMoney` is visible through `xPlayer.getMoney()`. The
ESX `money` account is the QB `cash` balance.

### Active framework

All battery globals exist at all times, but a `GetResourceState` overlay
reports `started` only for `ox_lib`, `oxmysql` and the *active* framework's
resource (`qbx_core` | `qb-core` | `es_extended`). Default: `qbox` (the 9AM
primary stack). `Bridge`-style detection therefore behaves exactly as on a
real server, and:

```lua
TestHelpers.framework.use('esx')      -- switch, keeps seeded players
TestHelpers.reload('server.bridge')   -- re-run load-time detection
```

drives every branch of a bridge in one suite. `use('none')` reports no
framework, for asserting the no-framework error path.

### Callbacks

All three callback styles land in one registry keyed by name:

- `lib.callback.register(name, fn)` — ox_lib, return-style
- `QBCore.Functions.CreateCallback(name, fn(source, cb, ...))` — cb-style
- `ESX.RegisterServerCallback(name, fn(source, cb, ...))` — cb-style

`TestHelpers.callback(name, source, ...)` invokes whichever is registered and
returns its results (cb-style handlers are given a capturing `cb`).
`lib.callback.await(name, false, ...)` — the client-side call shape that
appears inside resource client files — dispatches to the same registry with
`TestHelpers.framework.defaultSource` (default `1`) as the handler's source,
so client-flow code can be exercised against real server handlers.

### Observability

`lib.notify`, `QBCore.Functions.Notify`, `exports.qbx_core:Notify` and
`xPlayer.showNotification` all append to one log read via
`TestHelpers.framework.notifications()`. Job registration
(`exports['qb-core']:AddJob`, `exports.qbx_core:CreateJob`, ESX's
`jobs`-table + `RefreshJobs`) mutates one shared jobs registry that
`QBCore.Shared.Jobs`, `exports.qbx_core:GetJobs()` and `ESX.GetJobs()` all
read. `AddJob`/`UpdateJob` fire `QBCore:Server:UpdateObject`, matching
qb-core's contract.

## Control API (spec-facing)

```lua
TestHelpers.framework.use(name)         -- 'qbox' | 'qbcore' | 'esx' | 'none'
TestHelpers.framework.active()          -- current name
TestHelpers.framework.addPlayer(src, opts?)  -- seed + return active-shape player
TestHelpers.framework.removePlayer(src)
TestHelpers.framework.getState(src)     -- canonical record, for assertions
TestHelpers.framework.notifications()   -- { { source, args }, ... }
TestHelpers.framework.useItem(src, item)
TestHelpers.framework.reset()           -- players + notifications; registries survive
TestHelpers.callback(name, src, ...)    -- invoke any registered callback
TestHelpers.reload(module)              -- drop package.loaded + require again
```

`addPlayer` defaults: citizenid `CID<src>`, unemployed grade 0, 500 cash /
5000 bank, no items — every field overridable.

## Configuration

`9am-test.json` gains two optional fields, forwarded to the runner as
environment variables (`NINEAM_TEST_FRAMEWORK`, `NINEAM_TEST_BATTERIES`):

```jsonc
{
  "framework": "qbcore",   // initial active framework, default "qbox"
  "batteries": false        // or ["oxlib"] — default true = all
}
```

`batteries: false` restores today's bare runtime for resources that want
their own stubs.

## Packaging

`scripts/copy-lua.mjs` copies recursively so `batteries/` ships inside
`dist/cfxlua/test/`. No new npm dependencies.

## Verification

1. Fixture: `fixtures/sample-resource` gains `server/bridge.lua` (a distilled
   copy of the vehicleshop pattern: detection, `GetPlayer`, `RemoveMoney`,
   job checks) plus `tests/batteries.spec.lua` exercising it under all three
   frameworks via `use()` + `reload()`, and covering money/items/callbacks/
   notifications/jobs round-trips per framework.
2. `run.test.ts` e2e: temp resources asserting the batteries suite passes,
   `batteries: false` leaves the globals unset, and `framework` config sets
   the initial active framework.
3. Packaging test asserts the batteries assets resolve from `testAssetsDir()`.
