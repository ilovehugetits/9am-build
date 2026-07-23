# 9am-build v2 — Playwright, API-first rewrite

**Date:** 2026-07-23
**Status:** Approved (design), pending implementation plan

## Problem

9am-build automates uploading FiveM assets to the Cfx.re portal. The current
implementation (Puppeteer + DOM scraping) is unstable: it detects login by
scanning page text for "Created Assets", clicks through upload dialogs with
brittle selectors, and depends on the portal's HTML structure, which has since
changed. Sessions expire and re-login is unreliable. We want a from-scratch
rewrite that keeps TypeScript and Playwright, fixes every redirect/click/selector
with stable primitives, registers a passkey and renews sessions with it, and adds
a GitHub-release-only command that never touches the portal.

## Research findings (live Playwright session, 2026-07-23)

Collected against the real `9am.dev` account with a headed browser.

### Auth chain
- `portal.cfx.re/assets/created-assets` (unauthenticated) → `/login?return=...`
- "Sign in with" button → `portal-api.cfx.re/v1/auth/discourse?return=...` →
  `forum.cfx.re/login` (Discourse SSO).
- Forum login is a **plain page** (not a modal); elements are role-addressable:
  - `getByRole('textbox', { name: 'Email / Username' })`
  - `getByRole('textbox', { name: 'Password' })`
  - `getByRole('button', { name: 'Log In' })`
  - `getByRole('button', { name: 'Log in with a passkey' })`
- On login: forum `POST /session` → `POST portal-api/v1/auth/discourse` (SSO
  payload) → portal sets `jwt` cookie → `GET v1/me` returns 200.

### Session validity — single reliable signal
- **`GET https://portal-api.cfx.re/v1/me`** → `200` authenticated, `401` not.
  Replaces the old "scan DOM for 'Created Assets'" heuristic.

### Cookie lifetimes (basis for 3-tier renewal)
- Portal `jwt`: short-lived. `refresh-token` (portal-api): ~1 day.
- Forum `_t`: **60 days**. `_forum_session`: session cookie.
- Implication: the forum session outlives the portal jwt, so an expired jwt can
  often be refreshed by re-running the SSO handshake **without** a passkey prompt.

### Portal upload is a JSON REST API (extracted from the frontend bundle)
Endpoints on `https://portal-api.cfx.re` (cookie auth via `jwt`):
- `GET  v1/me` — auth check.
- `GET  v1/me/assets?page=&search=&sort=asset.id&direction=desc` — list.
- `GET  v1/assets/{id}` — detail incl. `versions[]` (id, version, state, ...).
- `POST v1/assets/{id}/re-upload` — body
  `{ name, chunk_count, chunk_size, total_size, original_file_name, release_candidate, version, changelog }`
  → `{ asset_id, version_id }`.
- `POST v1/assets/{assetId}/versions/{versionId}/upload-chunk` — `FormData`
  with `chunk_id` (string) and `chunk` (Blob slice).
- `POST v1/assets/{assetId}/versions/{versionId}/complete-upload`.
- `DELETE v1/assets/{assetId}/versions/{versionId}` — free a version slot.
- (also present: `createAsset` `POST v1/me/assets`, `renameAsset`, `deleteAsset`,
  `reencrypt`, `updateAssetVersion` — not needed for re-upload flow.)

Chunking logic (verbatim from bundle):
```
chunkSize  = fileSize > 32*1024*1024 || fileSize < 10240 ? 8*1024*1024 : ceil(fileSize/4)
chunkCount = ceil(fileSize / chunkSize)
```
Version type: `release_candidate: versionType === 'release_candidate'`
(Full Release ⇒ `false`).

Version detected from `fxmanifest.lua` with:
```
/^\s*versions?[\s(]+['"]([^'"]*)['"]/m
```

Error handling: 409 responses carry `error_code`:
- `MAX_VERSIONS_REACHED` — asset at 5/5 versions; delete oldest and retry.
- `DUPLICATE_VERSION` — bump the fxmanifest version.

### Passkey (Discourse endpoints, confirmed in forum bundle)
- Registration: `POST /u/create_passkey.json` (challenge) →
  `POST /u/register_passkey.json` (finalize). Registration triggers a
  **"Confirm access"** re-auth (password or existing passkey).
- Login: `GET /session/passkey/challenge.json` → `POST /session/passkey/auth.json`.
- CSRF: `GET /session/csrf.json`.
- The account already has a working `Automation` passkey; credential format in
  the existing `passkey-credential.json` is reusable.

## Architecture

Browser is used **only for login/passkey** (WebAuthn signing needs a real
browser). After login, cookies are captured and all asset operations run through
Playwright's `APIRequestContext`, which shares cookies with the browser context —
no manual httpOnly cookie handling, native HTTP for chunk uploads, and immunity to
portal UI changes.

### Module layout (clean boundaries, from scratch)
```
src/
  cfx/
    passkey.ts    — virtual authenticator (CDP WebAuthn), credential load/save
    login.ts      — passkey → forum → SSO → portal; returns storageState
    session.ts    — ensureSession(): 3-tier renewal; returns a valid APIRequestContext
    api.ts        — portal-api client: me, getAsset, reUpload, uploadChunk, complete, deleteVersion
    upload.ts     — uploadAsset(): drives api.ts + version-cap (5/5) handling
  core/
    config.ts     — upload-config.json schema (preserved)
    build.ts      — zip generation (escrow/open) — logic ported
    git.ts        — clone/pull/diff (preserved)
    manifest.ts   — read version from fxmanifest.lua (portal's regex, verbatim)
  integrations/
    github.ts     — release creation + asset upload (preserved)
    discord.ts    — changelog notification (preserved)
    changelog.ts  — Anthropic-generated changelog (preserved)
  commands/
    deploy.ts     — build + upload + github release + discord
    build.ts      — zip only
    release.ts    — NEW: build + github release (+discord); NO portal upload
    server.ts     — webhook server
    register.ts   — passkey registration
  index.ts        — command router
```

### Session management (`session.ts`)
`ensureSession()` tries, in order, and persists `storageState` after any success:
1. **jwt valid** — load saved `storageState`, `GET v1/me` == 200 ⇒ use directly
   (no browser launched).
2. **jwt dead, forum `_t` alive** — launch headless browser, navigate portal +
   click "Sign in with"; if the forum session is live the SSO completes with no
   passkey prompt, yielding a fresh jwt.
3. **forum session dead** — passkey login: set up the virtual authenticator with
   the saved credential, click "Log in with a passkey" → SSO → fresh jwt.

Returns an `APIRequestContext` carrying valid cookies for `api.ts`.

### Upload flow (`api.ts` + `upload.ts`)
`GET v1/assets/{id}` to read existing versions and pre-empt `DUPLICATE_VERSION` →
`re-upload` → chunk loop (size rule above) → `complete-upload`. On
`409 MAX_VERSIONS_REACHED`, `DELETE` the oldest version and retry once. All error
signals come from JSON, never the DOM.

### `release` command
`bun run release <script>`: load config → build zips → `createGitHubRelease()`
(zips as assets) → if a new release, send the Discord changelog. Never touches the
portal; no browser launched. The GitHub+Discord block is factored into a shared
helper reused by `deploy`.

### Error handling & Docker
- Every portal-api call goes through one wrapper; a 401 triggers a single session
  renewal, then a clear error if it still fails.
- **Coolify:** the Dockerfile installs Playwright Chromium + deps
  (`playwright install --with-deps chromium`). Passkey registration is done
  locally (headed); `passkey-credential.json` and the initial `auth-state.json`
  are copied to the server, which then self-renews via tier-1/tier-2 headless.
- Runtime stays **bun** (as today). Risk: Playwright + bun + CDP WebAuthn is
  validated early in the `register` command; if it misbehaves, fall back to node
  for that command.

## Testing / verification
- `api.ts` pure helpers (chunk math, version regex, error-code mapping) get unit
  tests.
- Integration: a live upload to a small real asset (e.g. `9am-textui`) under the
  user's supervision.

## Out of scope
- Creating brand-new assets (only re-upload to configured `assetId`s).
- Changing the webhook server's payload contract or Discord message format.
- Migrating away from bun as the runtime (kept unless WebAuthn forces node).

## Preserved behavior
- `upload-config.json` / `repos.json` schemas unchanged.
- GitHub release semantics (`created`/`existing`/`skipped`) and Discord dedupe
  unchanged.
- Escrow vs open-source zip building semantics unchanged.
