# 9am-build

Automated build & deploy pipeline for FiveM (Cfx.re) resources. Push to GitHub, get your script on the Cfx.re Portal — with AI-powered changelogs posted to Discord and versioned GitHub releases.

```
git push  -->  webhook  -->  build zip  -->  upload to portal  -->  GitHub release  -->  changelog to Discord
```

Plus a CfxLua test harness you can run in any resource folder, with no clone and no setup:

```bash
cd path/to/your-resource
npx 9am-build test        # or: bunx 9am-build test
```

## Testing Resources (`9am-build test`)

Runs your resource's `*.test.lua` files in a real Lua 5.4 VM against a simulated
FiveM environment — no server, no credentials, no network. This is the only
command the published npm package exposes; everything else below requires a
clone of this repo.

```bash
npx 9am-build test              # run every *.test.lua under the current folder
npx 9am-build test ./some/dir   # or point it somewhere else
npx 9am-build test --json       # machine-readable results
npx 9am-build test --strict     # exit 1 when no test files exist
```

### Writing a test

Test files sit anywhere in the resource (except `web/`) and end in `.test.lua`.
The API is a busted-compatible subset.

```lua
-- server/purchase.test.lua
describe('parseColorSelection', function()
  before_each(function()
    harness.load('shared/config.lua', 'server/helpers.lua', 'server/purchase.lua')
  end)

  it('converts a custom hex to an RGB triple', function()
    local index, hex, color1 = parseColorSelection(-1, '#FF8000')
    assert.equal(-1, index)
    assert.same({ 255, 128, 0 }, color1)
  end)

  it('denies a player with no ace permission', function()
    harness.stub('Bridge', { GetPlayer = function() return nil end })
    assert.falsy(IsVehicleshopAdmin(1))
  end)
end)
```

| Helper | Purpose |
|---|---|
| `harness.load(...)` | Reset globals to a clean state, then load the named resource files in order |
| `harness.stub(name, value)` | Override a global |
| `harness.callback(name, source, ...)` | Invoke a handler registered via `lib.callback.register` |
| `harness.trigger(event, ...)` | Fire handlers registered via `RegisterNetEvent`/`AddEventHandler` |
| `harness.calls(kind)` | Recorded side effects — `'sql'`, `'clientEvent'`, `'notify'`, `'export'` |
| `harness.threads()` / `harness.runThread(i)` | `CreateThread` bodies, recorded rather than run |
| `assert.equal / same / truthy / falsy / has_error` | Assertions |

`CreateThread` is recorded, never executed — resource code routinely wraps an
infinite `while true do ... end` loop at file scope, which would hang the
runner. Step one explicitly with `harness.runThread(1)` when a test needs it.

### What the environment provides

CFX natives (`IsPlayerAceAllowed`, `TriggerClientEvent`, `vector3`/`vector4`,
`exports`, …), ox_lib (`lib.callback`, `lib.notify`, `locale()`, …) and oxmysql
(`MySQL.query/insert/scalar`, both async and `.await` forms) are stubbed out of
the box, and every SQL query, client event and notification is recorded.

Any global the environment does not know resolves to `nil`, exactly as in real
Lua, and the access is recorded. When a test fails, the report lists which
unknown globals it read and where — usually pointing straight at the native you
need to stub.

### Reading a failure

Output is plain, greppable, and every location is a `path:line` anchor:

```
FAIL server/purchase.test.lua:16  parseColorSelection > returns 0 for unknown index

  assertion  assert.equal
  expected   0
  actual     nil

  traceback
    server/purchase.lua:21: in function 'parseColorSelection'

  source server/purchase.lua:21
      20 |         local gtaColor = Config.CatalogColors[colorIndex] or 0
    > 21 |         color1 = gtaColor

  unstubbed globals read during this test
    GetVehicleNumberPlateText  server/purchase.lua:88

9 tests  8 passed  1 failed  157ms
```

Exit code is 0 when everything passes, 1 on any failure. "No test files found"
exits 0 unless you pass `--strict`.

> Add `**/*.test.lua` to `exclude` in your `upload-config.json` so tests never
> ship inside the escrow or open zip.

## Quick Start

```bash
git clone <repo-url> 9am-build && cd 9am-build
bun install
bunx playwright install chromium   # one-time browser download
cp .env.example .env               # edit with your values
bun run register-passkey            # one-time passkey setup
bun run deploy my-resource          # build + upload to portal
bun run release my-resource         # build + GitHub release only (no portal)
```

## Requirements

- [Bun](https://bun.sh/) v1.0+ — runs the app (CLI, webhook server, portal API calls)
- [Node.js](https://nodejs.org/) v20.11+ — runs the Playwright browser step (Bun cannot drive Playwright's pipe transport, so passkey login/registration runs under Node via a small subprocess). Must be on `PATH`, or set `NODE_BIN`.
- Git
- Playwright Chromium — after `bun install`, run `bunx playwright install chromium` once (the Docker image does this automatically)

## Setup

### 1. Install Dependencies

```bash
bun install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
WEBHOOK_SECRET=your-webhook-secret
PORT=9000
DISCORD_CHANGELOG_WEBHOOK=https://discord.com/api/webhooks/...
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_TOKEN=ghp_...
```

> **Generating a strong `WEBHOOK_SECRET`:**
>
> ```bash
> openssl rand -hex 32
> ```
>
> Use the same value in both `.env` and the GitHub webhook secret field.

### 3. Register a Passkey (One-Time)

The Cfx.re Portal login is automated via a WebAuthn passkey. You register it once, then all future logins are automatic.

> **Note:** This step requires a GUI browser, so do it on your local machine first. Transfer the credential file to your server afterwards.

1. Run `bun run register-passkey`
2. A Chromium window opens — log into the Cfx.re Forum if prompted
3. It navigates to your security preferences automatically
4. Click **"Add Passkey"**, confirm access with your password when prompted, name it (e.g. `9am-build`), and confirm
5. Go back to the terminal and press **Enter**
6. Credentials are saved to `passkey-credential.json`

**Deploying to a remote server?** Copy the credential file:

```bash
scp passkey-credential.json user@your-server:/path/to/9am-build/
```

Session cookies are saved to `auth-state.json` and reused automatically. No GUI needed after initial registration.

### 4. Add Your Repos

Edit `repos.json` to register your FiveM resources:

```json
{
  "repos": [
    {
      "name": "my-resource",
      "githubUrl": "git@github.com:username/my-resource.git",
      "branch": "main"
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `name` | Resource name — used for CLI commands and webhook matching |
| `githubUrl` | Git clone URL (SSH or HTTPS) |
| `branch` | Branch to track (pushes to other branches are ignored) |

### 5. Add `upload-config.json` to Each Resource

Each FiveM resource needs an `upload-config.json` in its root. This tells 9am-build how to package and where to upload.

```json
{
  "name": "my-resource",
  "exclude": [
    "upload-config.json",
    ".gitignore",
    ".git/**",
    ".vscode/**"
  ],
  "frontend": {
    "dir": "web",
    "buildCommand": "bun run build",
    "buildOutput": "build"
  },
  "versions": {
    "escrow": {
      "assetId": 123456,
      "escrowIgnore": ["config.lua", "fxmanifest.lua"]
    }
  }
}
```

<details>
<summary><strong>All upload-config.json fields</strong></summary>

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Resource name |
| `exclude` | Yes | Glob patterns to exclude from all zips |
| `frontend` | No | Frontend build settings |
| `frontend.dir` | Yes* | Frontend directory (e.g. `web`) |
| `frontend.buildCommand` | No | Build command (default: `bun run build`) |
| `frontend.buildOutput` | No | Output directory (default: `build`). Use `dist` for Vue/Svelte |
| `versions` | Yes | At least one version must be defined |
| `versions.escrow.assetId` | Yes* | Cfx.re Portal asset ID |
| `versions.escrow.escrowIgnore` | Yes* | Files to add to `fxmanifest.lua` escrow_ignore block |
| `versions.open.assetId` | Yes* | Cfx.re Portal asset ID |

*Required if parent field is defined.

</details>

<details>
<summary><strong>Escrow vs Open versions</strong></summary>

- **Escrow** — Source files excluded, only build output included. `escrowIgnore` patterns are injected into `fxmanifest.lua`.
- **Open** — All files included. `escrow_ignore { "**/*.*", "*" }` is added automatically so nothing is encrypted.

You can define one or both versions. Each gets its own zip and asset upload.

</details>

<details>
<summary><strong>Finding your Asset ID</strong></summary>

1. Go to the [Cfx.re Portal](https://portal.cfx.re/assets/created-assets)
2. Find your resource in the asset list
3. The number in the **ID** column is your `assetId`

</details>

## Commands

| Command | Description |
|---------|-------------|
| `npx 9am-build test` | Run `*.test.lua` in a resource folder — the only published command, needs no clone |
| `bun run build <name>` | Build zip(s) only — no upload |
| `bun run deploy <name>` | Build + upload to Cfx.re Portal + GitHub release |
| `bun run release <name>` | Build + GitHub release only — never touches the portal or opens a browser |
| `bun run server` | Start webhook server for automated deployments |
| `bun run register-passkey` | One-time passkey registration |
| `bun src/index.ts debug <name> <commit>` | Test changelog generation for a commit |

## Webhook Mode (CI/CD)

Automate deployments on every push. The server receives GitHub webhooks, builds, uploads, and posts a changelog to Discord.

### Setup

1. Start the server:

   ```bash
   bun run server
   ```

2. Create a webhook on GitHub (**Settings > Webhooks > Add webhook**):

   | Field | Value |
   |-------|-------|
   | Payload URL | `https://your-server:9000/webhook` |
   | Content type | `application/json` |
   | Secret | Same as `WEBHOOK_SECRET` in `.env` |
   | Events | "Just the push event" |

### How It Works

1. You push to a tracked branch
2. GitHub sends a webhook to your server
3. Server verifies the HMAC-SHA256 signature
4. Matches the repo/branch against `repos.json`
5. Enqueues the build (one at a time, latest push wins)
6. Builds zip(s) and uploads to the Cfx.re Portal
7. Generates a changelog via Claude API and posts it to Discord

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check — returns `{ status: "ok" }` |
| `POST` | `/webhook` | GitHub push webhook receiver |

### Running with PM2

To keep the server running in the background with auto-restart:

```bash
npm install -g pm2
pm2 start bun --name 9am-build -- run server
pm2 save && pm2 startup
```

```bash
pm2 logs 9am-build      # view logs
pm2 restart 9am-build    # restart
pm2 stop 9am-build       # stop
pm2 delete 9am-build     # remove
```

## GitHub Releases

After a successful portal upload, the pipeline creates a GitHub release on the resource's repo, tagged with the version from `fxmanifest.lua` (e.g. `v1.0.3`), with auto-generated release notes and the built zips attached as assets (`<name>-escrow.zip`, `<name>-open.zip`).

1. Create a personal access token with `repo` scope (classic) or `Contents: Read and write` permission (fine-grained) for your resource repos
2. Add it to `.env`:

   ```env
   GITHUB_TOKEN=ghp_...
   ```

- The release targets the exact commit that was built
- If a release for the tag already exists, the zips are attached to it (existing assets with the same name are kept)
- If `GITHUB_TOKEN` is not set, this step is skipped silently
- Failures are non-fatal — the deploy still succeeds if the release fails

## Discord Changelog

Automatically posts AI-generated changelogs to Discord after each deployment.

1. Create a webhook: **Channel Settings > Integrations > Webhooks > New Webhook**
2. Add the URL to `.env`:

   ```env
   DISCORD_CHANGELOG_WEBHOOK=https://discord.com/api/webhooks/...
   ```

- Changelogs are generated from commit diffs using **OpenRouter** (priority) or **Anthropic** (fallback)
- Written as 1-5 bullet points from the end-user's perspective
- Posted as a gold/yellow embed with the resource name
- Model is configurable via `OPENROUTER_MODEL` (default: `anthropic/claude-sonnet-4.6`)
- If `DISCORD_CHANGELOG_WEBHOOK` is not set, this step is skipped silently

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `WEBHOOK_SECRET` | Server mode | GitHub webhook HMAC secret |
| `PORT` | Server mode | HTTP server port (default: `9000`) |
| `ANTHROPIC_API_KEY` | Changelog* | Anthropic API key |
| `OPENROUTER_API_KEY` | Changelog* | OpenRouter API key (takes priority over Anthropic) |
| `OPENROUTER_MODEL` | No | OpenRouter model (default: `anthropic/claude-sonnet-4.6`) |
| `DISCORD_CHANGELOG_WEBHOOK` | No | Discord webhook URL |
| `GITHUB_TOKEN` | No | GitHub token for creating releases with build zips |
| `CHROMIUM_NO_SANDBOX` | No | Set to `1` to disable the Chromium sandbox (needed only when running as root in a container; the Docker image sets it automatically). Leave unset locally. |

*At least one API key required for changelog generation.

## Project Structure

```
9am-build/
├── src/
│   ├── cli.ts                 # Published npm entry — `9am-build test` only
│   ├── index.ts               # Repo-only CLI entry point & command router
│   ├── lua/                   # CfxLua test harness (the published package)
│   │   ├── runtime.ts         # wasmoon VM lifecycle, sandbox, chunk naming
│   │   ├── harness.lua        # describe/it/assert + harness.* (pure Lua)
│   │   ├── discover.ts        # Find **/*.test.lua
│   │   ├── report.ts          # Agent-first text and --json rendering
│   │   ├── types.ts           # Result shapes
│   │   └── env/               # Simulated FiveM environment
│   │       ├── cfx.ts         # CFX natives, events, vectors, exports
│   │       ├── oxlib.ts       # lib.callback / notify / locale
│   │       └── oxmysql.ts     # MySQL.* with call recording
│   ├── cfx/                   # Cfx portal layer (browser only for login)
│   │   ├── api.ts             # portal-api REST client + chunking/error helpers
│   │   ├── upload.ts          # Chunked asset upload + version-cap recovery
│   │   ├── requester.ts       # fetch-based Requester (Cookie header from session)
│   │   ├── session.ts         # 3-tier ensureSession (jwt → SSO → passkey)
│   │   ├── login.ts           # Passkey + SSO-only portal login flows
│   │   ├── passkey.ts         # WebAuthn virtual authenticator + credential store
│   │   ├── storage-state.ts   # Playwright storageState + legacy migration
│   │   ├── run-browser.ts     # Spawns the Node browser runner from Bun
│   │   └── browser-runner.ts  # Node entry for login/register (Playwright)
│   ├── core/                  # Build & repo primitives
│   │   ├── config.ts          # Load & validate upload-config.json
│   │   ├── build.ts           # Zip creation & frontend builds
│   │   ├── git.ts             # Git clone / pull / diff
│   │   └── manifest.ts        # Read version from fxmanifest.lua
│   ├── integrations/          # External services
│   │   ├── github.ts          # GitHub release creation & asset upload
│   │   ├── discord.ts         # Discord webhook notifications
│   │   └── changelog.ts       # AI changelog generation
│   ├── commands/              # One file per CLI command
│   │   ├── test.ts            # Run *.test.lua (published)
│   │   ├── build.ts           # Zip only
│   │   ├── deploy.ts          # Build + portal upload + GitHub release
│   │   ├── release.ts         # Build + GitHub release only (no portal)
│   │   ├── register.ts        # Passkey registration (headed)
│   │   ├── server.ts          # GitHub webhook HTTP server
│   │   └── shared.ts          # Shared post-release Discord announcement
│   └── server-support/
│       ├── queue.ts           # Serial build queue (latest-wins)
│       └── repos.ts           # repos.json loader
├── repos.json                 # Managed repo list
├── .env.example               # Environment template
└── package.json
```

**Auto-generated files** (gitignored):

| File | Purpose |
|------|---------|
| `auth-state.json` | Cached Cfx.re session cookies |
| `passkey-credential.json` | WebAuthn passkey credentials |
| `repos/` | Cloned repository working copies |

## License

[MIT](LICENSE)
