# 9am-build v2 — Playwright API-first Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite 9am-build so the browser is used only for passkey login, all Cfx portal operations run through `portal-api.cfx.re` via Playwright's `APIRequestContext`, sessions self-renew across three tiers, and a new `release` command publishes GitHub releases without touching the portal.

**Architecture:** A thin browser layer (`src/cfx/`) performs WebAuthn passkey login with a Playwright virtual authenticator and persists a `storageState`. A pure API client (`src/cfx/api.ts`) takes an injectable requester so it is unit-testable without a browser, and uploads assets in chunks straight to the REST API. Core build/git/manifest helpers and GitHub/Discord/changelog integrations are ported into `src/core/` and `src/integrations/`. Commands live in `src/commands/` behind a router in `src/index.ts`.

**Tech Stack:** TypeScript (strict), Bun runtime + `bun test`, Playwright (`playwright` package, Chromium), `archiver`, `glob`, `chalk`, `@anthropic-ai/sdk`.

## Global Constraints

- Runtime is **Bun**; use `bun`/`bunx`, never `npm`/`npx`. Test runner is `bun test`.
- Language is **TypeScript** with `"strict": true`; ESM (`"type": "module"`), `.js` import specifiers for local files (bundler moduleResolution).
- Browser automation uses **Playwright** only. Puppeteer must be fully removed.
- Portal API base URL: `https://portal-api.cfx.re` (cookie auth via `jwt`). Auth check: `GET /v1/me` → 200 authed, 401 not.
- Portal upload endpoints (exact):
  `POST v1/assets/{id}/re-upload`, `POST v1/assets/{assetId}/versions/{versionId}/upload-chunk` (multipart `chunk_id`+`chunk`), `POST v1/assets/{assetId}/versions/{versionId}/complete-upload`, `DELETE v1/assets/{assetId}/versions/{versionId}`, `GET v1/assets/{id}`.
- Chunking (verbatim): `chunkSize = fileSize > 33554432 || fileSize < 10240 ? 8388608 : ceil(fileSize/4)`; `chunkCount = ceil(fileSize/chunkSize)`.
- Version type field: `release_candidate` boolean (`true` only for Release Candidate / Beta; Full Release ⇒ `false`).
- fxmanifest version regex (verbatim): `/^\s*versions?[\s(]+['"]([^'"]*)['"]/m`.
- Portal 409 error codes: `MAX_VERSIONS_REACHED`, `DUPLICATE_VERSION`.
- Discourse passkey endpoints: register `POST /u/create_passkey.json` → `POST /u/register_passkey.json`; login `GET /session/passkey/challenge.json` → `POST /session/passkey/auth.json`.
- Preserve external contracts unchanged: `upload-config.json` schema, `repos.json` schema, GitHub release status semantics (`created`/`existing`/`skipped`), Discord "only announce `created`" dedupe, escrow/open zip semantics.
- Credential file: `passkey-credential.json` (repo root). Session file: `auth-state.json` (repo root, Playwright `storageState` format).

---

## File Structure

```
src/
  cfx/
    api.ts          — portal-api REST client (injectable requester; pure + I/O)
    api.test.ts
    upload.ts       — uploadAsset(): chunked upload + version-cap handling
    upload.test.ts
    passkey.ts      — Playwright CDP virtual authenticator + credential file I/O
    login.ts        — passkey login + SSO-only login (browser flows)
    session.ts      — ensureSession(): 3-tier renewal → APIRequestContext
    requester.ts    — Playwright APIRequestContext → Requester adapter
  core/
    config.ts       — upload-config.json schema + loader (ported)
    manifest.ts     — parse/read fxmanifest version
    manifest.test.ts
    build.ts        — zip generation (ported)
    git.ts          — clone/pull/diff (ported)
  integrations/
    github.ts       — release creation + asset upload (ported)
    discord.ts      — changelog notification (ported)
    changelog.ts    — Anthropic/OpenRouter changelog (ported)
  commands/
    deploy.ts       — build + upload + github release + discord
    build.ts        — zip only
    release.ts      — NEW: build + github release (+discord); no portal
    server.ts       — webhook server (ported, retargeted imports)
    register.ts     — passkey registration (Playwright, headed)
    shared.ts       — announceRelease(): shared github+discord helper
  server-support/
    queue.ts        — build queue (ported)
    repos.ts        — repos.json loader + types (extracted from old server.ts)
  index.ts          — command router
```

---

## Phase 0 — Project setup

### Task 0.1: Swap Puppeteer for Playwright, add test script

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: npm scripts `deploy`, `build`, `release`, `server`, `register-passkey`, `test`, `typecheck`; dependency `playwright`; no `puppeteer`.

- [ ] **Step 1: Remove puppeteer, add playwright**

Run:
```bash
bun remove puppeteer
bun add playwright
bunx playwright install chromium
```
Expected: `playwright` appears in `dependencies`, `puppeteer` gone; Chromium downloads.

- [ ] **Step 2: Update scripts block in `package.json`**

Replace the `"scripts"` object with:
```json
"scripts": {
  "deploy": "bun src/index.ts deploy",
  "build": "bun src/index.ts build",
  "release": "bun src/index.ts release",
  "server": "bun src/index.ts server",
  "register-passkey": "bun src/index.ts register",
  "debug": "bun src/index.ts debug",
  "test": "bun test",
  "typecheck": "tsc --noEmit"
}
```

- [ ] **Step 3: Verify Playwright imports**

Run: `bun -e "const {chromium,request}=require('playwright'); console.log(typeof chromium.launch, typeof request.newContext)"`
Expected: `function function`

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lockb
git commit -m "build: replace puppeteer with playwright, add bun test script"
```

---

## Phase 1 — Pure helpers (unit-tested)

### Task 1.1: `core/manifest.ts` — fxmanifest version parsing

**Files:**
- Create: `src/core/manifest.ts`
- Test: `src/core/manifest.test.ts`

**Interfaces:**
- Produces:
  - `export function parseManifestVersion(content: string): string | null`
  - `export async function readManifestVersion(repoDir: string): Promise<string | null>`

- [ ] **Step 1: Write the failing test**

`src/core/manifest.test.ts`:
```ts
import { test, expect } from "bun:test";
import { parseManifestVersion } from "./manifest.js";

test("parses single-quoted version", () => {
  expect(parseManifestVersion("fx_version 'cerulean'\nversion '1.2.3'")).toBe("1.2.3");
});

test("parses double-quoted version", () => {
  expect(parseManifestVersion('version "0.0.1"')).toBe("0.0.1");
});

test("ignores fx_version and matches version line", () => {
  expect(parseManifestVersion("fx_version 'cerulean'\ngame 'gta5'\nversion '2.0.0'")).toBe("2.0.0");
});

test("returns null when absent", () => {
  expect(parseManifestVersion("game 'gta5'")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/manifest.test.ts`
Expected: FAIL — cannot find module `./manifest.js`.

- [ ] **Step 3: Write minimal implementation**

`src/core/manifest.ts`:
```ts
import { readFile } from "fs/promises";
import path from "path";

const VERSION_RE = /^\s*versions?[\s(]+['"]([^'"]*)['"]/m;

export function parseManifestVersion(content: string): string | null {
  const match = content.match(VERSION_RE);
  return match ? match[1] : null;
}

export async function readManifestVersion(repoDir: string): Promise<string | null> {
  try {
    const content = await readFile(path.join(repoDir, "fxmanifest.lua"), "utf-8");
    return parseManifestVersion(content);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/manifest.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/manifest.ts src/core/manifest.test.ts
git commit -m "feat: fxmanifest version parsing with portal-parity regex"
```

---

### Task 1.2: `cfx/api.ts` pure helpers — chunking + error codes

**Files:**
- Create: `src/cfx/api.ts` (helpers only in this task; REST functions added in Task 4.1)
- Test: `src/cfx/api.test.ts`

**Interfaces:**
- Produces:
  - `export function computeChunking(fileSize: number): { chunkSize: number; chunkCount: number }`
  - `export function extractErrorCode(status: number, body: unknown): string | null`

- [ ] **Step 1: Write the failing test**

`src/cfx/api.test.ts`:
```ts
import { test, expect } from "bun:test";
import { computeChunking, extractErrorCode } from "./api.js";

test("small file (<10KB) uses 8MB chunk, single chunk", () => {
  expect(computeChunking(5000)).toEqual({ chunkSize: 8388608, chunkCount: 1 });
});

test("large file (>32MB) uses 8MB chunks", () => {
  const r = computeChunking(50 * 1024 * 1024);
  expect(r.chunkSize).toBe(8388608);
  expect(r.chunkCount).toBe(Math.ceil((50 * 1024 * 1024) / 8388608));
});

test("mid file splits into 4 chunks", () => {
  const size = 20 * 1024 * 1024;
  expect(computeChunking(size)).toEqual({ chunkSize: Math.ceil(size / 4), chunkCount: 4 });
});

test("extractErrorCode reads 409 error_code", () => {
  expect(extractErrorCode(409, { error_code: "DUPLICATE_VERSION" })).toBe("DUPLICATE_VERSION");
});

test("extractErrorCode returns null for non-409", () => {
  expect(extractErrorCode(500, { error_code: "X" })).toBeNull();
});

test("extractErrorCode returns null when no code", () => {
  expect(extractErrorCode(409, { message: "nope" })).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/cfx/api.test.ts`
Expected: FAIL — cannot find module `./api.js`.

- [ ] **Step 3: Write minimal implementation**

`src/cfx/api.ts`:
```ts
const THIRTY_TWO_MB = 33_554_432;
const EIGHT_MB = 8_388_608;
const TEN_KB = 10_240;

export function computeChunking(fileSize: number): { chunkSize: number; chunkCount: number } {
  const chunkSize = fileSize > THIRTY_TWO_MB || fileSize < TEN_KB ? EIGHT_MB : Math.ceil(fileSize / 4);
  const chunkCount = Math.ceil(fileSize / chunkSize);
  return { chunkSize, chunkCount };
}

export function extractErrorCode(status: number, body: unknown): string | null {
  if (status === 409 && body && typeof body === "object" && "error_code" in body) {
    return String((body as { error_code: unknown }).error_code);
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/cfx/api.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cfx/api.ts src/cfx/api.test.ts
git commit -m "feat: portal chunking math and 409 error-code extraction"
```

---

## Phase 2 — Portal API client + upload orchestration

### Task 2.1: `cfx/api.ts` — REST client over an injectable Requester

**Files:**
- Modify: `src/cfx/api.ts`
- Test: `src/cfx/api.test.ts`

**Interfaces:**
- Consumes: `computeChunking`, `extractErrorCode` (Task 1.2).
- Produces:
  ```ts
  export interface HttpResponse { status: number; ok: boolean; json(): Promise<any>; text(): Promise<string>; }
  export interface MultipartField { name: string; value: string | { buffer: Buffer; fileName: string; mimeType: string }; }
  export interface Requester {
    get(url: string): Promise<HttpResponse>;
    postJson(url: string, body: unknown): Promise<HttpResponse>;
    postMultipart(url: string, fields: MultipartField[]): Promise<HttpResponse>;
    del(url: string): Promise<HttpResponse>;
  }
  export interface AssetVersion { id: number; version: string; state: string; is_release_candidate: boolean; created_at: string; }
  export interface AssetDetail { id: number; name: string; versions: AssetVersion[]; }
  export interface ReUploadBody { name: string; chunk_count: number; chunk_size: number; total_size: number; original_file_name: string; release_candidate: boolean; version: string; changelog: string; }
  export const API_BASE = "https://portal-api.cfx.re";
  export function isAuthenticated(req: Requester): Promise<boolean>;
  export function getAsset(req: Requester, id: number): Promise<AssetDetail>;
  export function reUpload(req: Requester, id: number, body: ReUploadBody): Promise<{ asset_id: number; version_id: number }>;
  export function uploadChunk(req: Requester, assetId: number, versionId: number, chunkId: number, chunk: Buffer): Promise<void>;
  export function completeUpload(req: Requester, assetId: number, versionId: number): Promise<void>;
  export function deleteVersion(req: Requester, assetId: number, versionId: number): Promise<void>;
  export class PortalApiError extends Error { code: string | null; status: number; constructor(message: string, status: number, code: string | null); }
  ```

- [ ] **Step 1: Write the failing tests (append to `src/cfx/api.test.ts`)**

```ts
import {
  isAuthenticated, getAsset, reUpload, uploadChunk, completeUpload, deleteVersion,
  PortalApiError, type Requester, type HttpResponse, type MultipartField,
} from "./api.js";

function res(status: number, body: unknown = {}): HttpResponse {
  return { status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body) };
}

function fakeRequester(handlers: Partial<Record<"get" | "postJson" | "postMultipart" | "del", (url: string, arg?: any) => HttpResponse>>): { req: Requester; calls: string[] } {
  const calls: string[] = [];
  const req: Requester = {
    async get(url) { calls.push(`GET ${url}`); return handlers.get?.(url) ?? res(200); },
    async postJson(url, body) { calls.push(`POST ${url}`); return handlers.postJson?.(url, body) ?? res(200); },
    async postMultipart(url, fields) { calls.push(`MP ${url}`); return handlers.postMultipart?.(url, fields) ?? res(200); },
    async del(url) { calls.push(`DEL ${url}`); return handlers.del?.(url) ?? res(200); },
  };
  return { req, calls };
}

test("isAuthenticated true on 200", async () => {
  const { req } = fakeRequester({ get: () => res(200, { id: 1 }) });
  expect(await isAuthenticated(req)).toBe(true);
});

test("isAuthenticated false on 401", async () => {
  const { req } = fakeRequester({ get: () => res(401) });
  expect(await isAuthenticated(req)).toBe(false);
});

test("getAsset returns detail", async () => {
  const detail = { id: 5, name: "x", versions: [] };
  const { req, calls } = fakeRequester({ get: () => res(200, detail) });
  expect(await getAsset(req, 5)).toEqual(detail);
  expect(calls).toContain("GET https://portal-api.cfx.re/v1/assets/5");
});

test("reUpload returns ids", async () => {
  const { req } = fakeRequester({ postJson: () => res(200, { asset_id: 5, version_id: 9 }) });
  const out = await reUpload(req, 5, {
    name: "x", chunk_count: 1, chunk_size: 10, total_size: 10,
    original_file_name: "x.zip", release_candidate: false, version: "1.0.0", changelog: "",
  });
  expect(out).toEqual({ asset_id: 5, version_id: 9 });
});

test("reUpload throws PortalApiError with code on 409", async () => {
  const { req } = fakeRequester({ postJson: () => res(409, { error_code: "DUPLICATE_VERSION" }) });
  await expect(reUpload(req, 5, {
    name: "x", chunk_count: 1, chunk_size: 10, total_size: 10,
    original_file_name: "x.zip", release_candidate: false, version: "1.0.0", changelog: "",
  })).rejects.toMatchObject({ code: "DUPLICATE_VERSION", status: 409 });
});

test("uploadChunk posts multipart with chunk_id + chunk", async () => {
  let seen: MultipartField[] = [];
  const { req } = fakeRequester({ postMultipart: (_u, f) => { seen = f; return res(200); } });
  await uploadChunk(req, 5, 9, 0, Buffer.from("abc"));
  expect(seen.find((f) => f.name === "chunk_id")?.value).toBe("0");
  expect(seen.find((f) => f.name === "chunk")).toBeTruthy();
});

test("completeUpload calls complete endpoint", async () => {
  const { req, calls } = fakeRequester({});
  await completeUpload(req, 5, 9);
  expect(calls).toContain("POST https://portal-api.cfx.re/v1/assets/5/versions/9/complete-upload");
});

test("deleteVersion calls delete endpoint", async () => {
  const { req, calls } = fakeRequester({});
  await deleteVersion(req, 5, 9);
  expect(calls).toContain("DEL https://portal-api.cfx.re/v1/assets/5/versions/9");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/cfx/api.test.ts`
Expected: FAIL — `isAuthenticated`/`getAsset`/etc. not exported.

- [ ] **Step 3: Implement REST functions (append to `src/cfx/api.ts`)**

```ts
export const API_BASE = "https://portal-api.cfx.re";

export interface HttpResponse { status: number; ok: boolean; json(): Promise<any>; text(): Promise<string>; }
export interface MultipartField { name: string; value: string | { buffer: Buffer; fileName: string; mimeType: string }; }
export interface Requester {
  get(url: string): Promise<HttpResponse>;
  postJson(url: string, body: unknown): Promise<HttpResponse>;
  postMultipart(url: string, fields: MultipartField[]): Promise<HttpResponse>;
  del(url: string): Promise<HttpResponse>;
}

export interface AssetVersion { id: number; version: string; state: string; is_release_candidate: boolean; created_at: string; }
export interface AssetDetail { id: number; name: string; versions: AssetVersion[]; }
export interface ReUploadBody {
  name: string; chunk_count: number; chunk_size: number; total_size: number;
  original_file_name: string; release_candidate: boolean; version: string; changelog: string;
}

export class PortalApiError extends Error {
  code: string | null;
  status: number;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "PortalApiError";
    this.status = status;
    this.code = code;
  }
}

async function ensureOk(res: HttpResponse, context: string): Promise<HttpResponse> {
  if (res.ok) return res;
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  const code = extractErrorCode(res.status, body);
  throw new PortalApiError(`${context} failed (${res.status})${code ? `: ${code}` : ""}`, res.status, code);
}

export async function isAuthenticated(req: Requester): Promise<boolean> {
  const res = await req.get(`${API_BASE}/v1/me`);
  return res.status === 200;
}

export async function getAsset(req: Requester, id: number): Promise<AssetDetail> {
  const res = await ensureOk(await req.get(`${API_BASE}/v1/assets/${id}`), `getAsset(${id})`);
  return (await res.json()) as AssetDetail;
}

export async function reUpload(req: Requester, id: number, body: ReUploadBody): Promise<{ asset_id: number; version_id: number }> {
  const res = await ensureOk(await req.postJson(`${API_BASE}/v1/assets/${id}/re-upload`, body), `reUpload(${id})`);
  return (await res.json()) as { asset_id: number; version_id: number };
}

export async function uploadChunk(req: Requester, assetId: number, versionId: number, chunkId: number, chunk: Buffer): Promise<void> {
  const url = `${API_BASE}/v1/assets/${assetId}/versions/${versionId}/upload-chunk`;
  await ensureOk(
    await req.postMultipart(url, [
      { name: "chunk_id", value: String(chunkId) },
      { name: "chunk", value: { buffer: chunk, fileName: "chunk", mimeType: "application/octet-stream" } },
    ]),
    `uploadChunk(${assetId},${versionId},${chunkId})`
  );
}

export async function completeUpload(req: Requester, assetId: number, versionId: number): Promise<void> {
  await ensureOk(
    await req.postJson(`${API_BASE}/v1/assets/${assetId}/versions/${versionId}/complete-upload`, {}),
    `completeUpload(${assetId},${versionId})`
  );
}

export async function deleteVersion(req: Requester, assetId: number, versionId: number): Promise<void> {
  await ensureOk(await req.del(`${API_BASE}/v1/assets/${assetId}/versions/${versionId}`), `deleteVersion(${assetId},${versionId})`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/cfx/api.test.ts`
Expected: PASS (all api tests).

- [ ] **Step 5: Commit**

```bash
git add src/cfx/api.ts src/cfx/api.test.ts
git commit -m "feat: portal-api REST client over injectable requester"
```

---

### Task 2.2: `cfx/upload.ts` — chunked upload with version-cap handling

**Files:**
- Create: `src/cfx/upload.ts`
- Test: `src/cfx/upload.test.ts`

**Interfaces:**
- Consumes: everything from `api.ts` (Task 2.1), `computeChunking` (1.2).
- Produces:
  ```ts
  export interface UploadOptions {
    assetId: number; zipPath: string; version: string;
    changelog?: string; releaseCandidate?: boolean; label: string;
  }
  export async function uploadAsset(req: Requester, opts: UploadOptions): Promise<void>
  // internal but exported for tests:
  export function oldestVersionId(detail: AssetDetail): number | null
  export function hasVersion(detail: AssetDetail, version: string): boolean
  ```

- [ ] **Step 1: Write the failing test**

`src/cfx/upload.test.ts`:
```ts
import { test, expect } from "bun:test";
import { oldestVersionId, hasVersion } from "./upload.js";
import type { AssetDetail } from "./api.js";

const detail: AssetDetail = {
  id: 1, name: "x",
  versions: [
    { id: 30, version: "1.2.0", state: "active", is_release_candidate: false, created_at: "2026-03-03T00:00:00Z" },
    { id: 10, version: "1.0.0", state: "active", is_release_candidate: false, created_at: "2026-01-01T00:00:00Z" },
    { id: 20, version: "1.1.0", state: "active", is_release_candidate: false, created_at: "2026-02-02T00:00:00Z" },
  ],
};

test("oldestVersionId picks earliest created_at", () => {
  expect(oldestVersionId(detail)).toBe(10);
});

test("oldestVersionId null on empty", () => {
  expect(oldestVersionId({ id: 1, name: "x", versions: [] })).toBeNull();
});

test("hasVersion matches existing version string", () => {
  expect(hasVersion(detail, "1.1.0")).toBe(true);
  expect(hasVersion(detail, "9.9.9")).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/cfx/upload.test.ts`
Expected: FAIL — cannot find module `./upload.js`.

- [ ] **Step 3: Write implementation**

`src/cfx/upload.ts`:
```ts
import { readFile } from "fs/promises";
import path from "path";
import chalk from "chalk";
import {
  computeChunking, getAsset, reUpload, uploadChunk, completeUpload, deleteVersion,
  PortalApiError, type Requester, type AssetDetail,
} from "./api.js";

export interface UploadOptions {
  assetId: number;
  zipPath: string;
  version: string;
  changelog?: string;
  releaseCandidate?: boolean;
  label: string;
}

export function oldestVersionId(detail: AssetDetail): number | null {
  if (detail.versions.length === 0) return null;
  return [...detail.versions].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  )[0].id;
}

export function hasVersion(detail: AssetDetail, version: string): boolean {
  return detail.versions.some((v) => v.version === version);
}

export async function uploadAsset(req: Requester, opts: UploadOptions): Promise<void> {
  const { assetId, zipPath, version, label } = opts;
  console.log(chalk.blue(`[${label}] Uploading asset ${assetId} (v${version})...`));

  const detail = await getAsset(req, assetId);
  if (hasVersion(detail, version)) {
    throw new Error(`[${label}] Version ${version} already exists for asset ${assetId}. Bump fxmanifest.lua.`);
  }

  const buffer = Buffer.from(await readFile(zipPath));
  const { chunkSize, chunkCount } = computeChunking(buffer.length);
  const body = {
    name: detail.name,
    chunk_count: chunkCount,
    chunk_size: chunkSize,
    total_size: buffer.length,
    original_file_name: path.basename(zipPath),
    release_candidate: opts.releaseCandidate ?? false,
    version,
    changelog: opts.changelog ?? "",
  };

  let ids: { asset_id: number; version_id: number };
  try {
    ids = await reUpload(req, assetId, body);
  } catch (err) {
    if (err instanceof PortalApiError && err.code === "MAX_VERSIONS_REACHED") {
      const oldest = oldestVersionId(detail);
      if (oldest == null) throw err;
      console.log(chalk.yellow(`[${label}] 5/5 versions — deleting oldest (id ${oldest})...`));
      await deleteVersion(req, assetId, oldest);
      ids = await reUpload(req, assetId, body);
    } else {
      throw err;
    }
  }

  for (let i = 0; i < chunkCount; i++) {
    const chunk = buffer.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, buffer.length));
    await uploadChunk(req, ids.asset_id, ids.version_id, i, chunk);
    console.log(chalk.gray(`[${label}] chunk ${i + 1}/${chunkCount}`));
  }

  await completeUpload(req, ids.asset_id, ids.version_id);
  console.log(chalk.green(`[${label}] Asset ${assetId} uploaded (v${version}).`));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/cfx/upload.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cfx/upload.ts src/cfx/upload.test.ts
git commit -m "feat: chunked asset upload with version-cap recovery"
```

---

## Phase 3 — Browser layer (passkey, login, session)

### Task 3.1: `cfx/passkey.ts` — Playwright virtual authenticator + credential I/O

**Files:**
- Create: `src/cfx/passkey.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SavedCredential { credentialId: string; rpId: string; privateKey: string; userHandle: string; signCount: number; }
  export const CREDENTIAL_FILE: string; // repo-root passkey-credential.json
  export async function setupVirtualAuthenticator(page: import("playwright").Page, credential?: SavedCredential): Promise<{ authenticatorId: string; cdp: import("playwright").CDPSession }>;
  export async function getRegisteredCredentials(cdp: import("playwright").CDPSession, authenticatorId: string): Promise<SavedCredential[]>;
  export async function loadCredential(): Promise<SavedCredential | null>;
  export async function saveCredential(credential: SavedCredential): Promise<void>;
  ```

- [ ] **Step 1: Write implementation** (browser-CDP code; validated live in Task 6.1, not unit-tested)

`src/cfx/passkey.ts`:
```ts
import { access, readFile, writeFile } from "fs/promises";
import path from "path";
import type { Page, CDPSession } from "playwright";

export const CREDENTIAL_FILE = path.resolve(import.meta.dirname, "../../passkey-credential.json");

export interface SavedCredential {
  credentialId: string;
  rpId: string;
  privateKey: string;
  userHandle: string;
  signCount: number;
}

export async function setupVirtualAuthenticator(
  page: Page,
  credential?: SavedCredential
): Promise<{ authenticatorId: string; cdp: CDPSession }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");

  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  if (credential) {
    await cdp.send("WebAuthn.addCredential", {
      authenticatorId,
      credential: {
        credentialId: credential.credentialId,
        rpId: credential.rpId,
        privateKey: credential.privateKey,
        userHandle: credential.userHandle,
        signCount: credential.signCount,
        isResidentCredential: true,
      },
    });
  }

  return { authenticatorId, cdp };
}

export async function getRegisteredCredentials(cdp: CDPSession, authenticatorId: string): Promise<SavedCredential[]> {
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  return credentials.map((c: any) => ({
    credentialId: c.credentialId,
    rpId: c.rpId,
    privateKey: c.privateKey,
    userHandle: c.userHandle ?? "",
    signCount: c.signCount,
  }));
}

export async function loadCredential(): Promise<SavedCredential | null> {
  try {
    await access(CREDENTIAL_FILE);
    return JSON.parse(await readFile(CREDENTIAL_FILE, "utf-8"));
  } catch {
    return null;
  }
}

export async function saveCredential(credential: SavedCredential): Promise<void> {
  await writeFile(CREDENTIAL_FILE, JSON.stringify(credential, null, 2), "utf-8");
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors in `passkey.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/cfx/passkey.ts
git commit -m "feat: Playwright CDP virtual authenticator and credential store"
```

---

### Task 3.2: `cfx/login.ts` — passkey login and SSO-only login flows

**Files:**
- Create: `src/cfx/login.ts`

**Interfaces:**
- Consumes: `setupVirtualAuthenticator`, `SavedCredential` (3.1); `isAuthenticated` (2.1); `playwrightRequester` (3.3 — but only used by session.ts, not here). This task uses only Playwright page navigation and reads `v1/me` through `page.request`.
- Produces:
  ```ts
  export const PORTAL_URL: string;          // https://portal.cfx.re/assets/created-assets
  export async function completeSSO(page: import("playwright").Page): Promise<boolean>;
  export async function loginViaSSO(page: import("playwright").Page): Promise<boolean>;
  export async function loginWithPasskey(page: import("playwright").Page, credential: SavedCredential): Promise<boolean>;
  ```
  Each returns `true` when `page.request.get(v1/me)` yields 200.

- [ ] **Step 1: Write implementation** (validated live in Task 6.x)

`src/cfx/login.ts`:
```ts
import type { Page } from "playwright";
import chalk from "chalk";
import { setupVirtualAuthenticator, type SavedCredential } from "./passkey.js";
import { API_BASE } from "./api.js";

export const PORTAL_URL = "https://portal.cfx.re/assets/created-assets";

async function portalAuthed(page: Page): Promise<boolean> {
  const res = await page.request.get(`${API_BASE}/v1/me`);
  return res.status() === 200;
}

/** From any state on portal, click "Sign in with" and wait for either the forum
 *  login page or a completed SSO (v1/me == 200). Returns true if authed. */
export async function completeSSO(page: Page): Promise<boolean> {
  const signIn = page.getByRole("button", { name: /sign in with/i });
  if (await signIn.count()) {
    await signIn.first().click();
  }
  // Give SSO redirects time to settle, polling the auth signal.
  for (let i = 0; i < 20; i++) {
    if (await portalAuthed(page)) return true;
    if (/forum\.cfx\.re\/login/.test(page.url())) return false; // needs credentials/passkey
    await page.waitForTimeout(500);
  }
  return portalAuthed(page);
}

/** Tier 2: forum session still alive — navigating portal + clicking sign-in
 *  completes SSO with no passkey prompt. */
export async function loginViaSSO(page: Page): Promise<boolean> {
  await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded" });
  if (await portalAuthed(page)) return true;
  return completeSSO(page);
}

/** Tier 3: full passkey login via virtual authenticator. */
export async function loginWithPasskey(page: Page, credential: SavedCredential): Promise<boolean> {
  await setupVirtualAuthenticator(page, credential);

  await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded" });
  if (await portalAuthed(page)) return true;

  // portal → forum login page
  const signIn = page.getByRole("button", { name: /sign in with/i });
  if (await signIn.count()) await signIn.first().click();

  const passkeyBtn = page.getByRole("button", { name: /log in with a passkey/i });
  await passkeyBtn.waitFor({ state: "visible", timeout: 30_000 });
  await passkeyBtn.click();

  // WebAuthn autosigns via the virtual authenticator; forum then SSO-redirects.
  for (let i = 0; i < 30; i++) {
    if (await portalAuthed(page)) {
      console.log(chalk.green("Passkey login successful."));
      return true;
    }
    // If bounced back to portal login, nudge SSO again.
    if (/portal\.cfx\.re\/login/.test(page.url())) {
      const b = page.getByRole("button", { name: /sign in with/i });
      if (await b.count()) await b.first().click();
    }
    await page.waitForTimeout(1000);
  }
  return portalAuthed(page);
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/cfx/login.ts
git commit -m "feat: passkey and SSO-only portal login flows"
```

---

### Task 3.3: `cfx/requester.ts` — APIRequestContext → Requester adapter

**Files:**
- Create: `src/cfx/requester.ts`

**Interfaces:**
- Consumes: `Requester`, `MultipartField`, `HttpResponse` (2.1).
- Produces:
  ```ts
  export function playwrightRequester(ctx: import("playwright").APIRequestContext): Requester;
  ```

- [ ] **Step 1: Write implementation**

`src/cfx/requester.ts`:
```ts
import type { APIRequestContext, APIResponse } from "playwright";
import type { Requester, HttpResponse, MultipartField } from "./api.js";

function wrap(res: APIResponse): HttpResponse {
  return {
    status: res.status(),
    ok: res.ok(),
    json: () => res.json(),
    text: () => res.text(),
  };
}

export function playwrightRequester(ctx: APIRequestContext): Requester {
  return {
    async get(url) { return wrap(await ctx.get(url)); },
    async postJson(url, body) { return wrap(await ctx.post(url, { data: body as any })); },
    async postMultipart(url, fields) {
      const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {};
      for (const f of fields) {
        multipart[f.name] =
          typeof f.value === "string"
            ? f.value
            : { name: f.value.fileName, mimeType: f.value.mimeType, buffer: f.value.buffer };
      }
      return wrap(await ctx.post(url, { multipart }));
    },
    async del(url) { return wrap(await ctx.delete(url)); },
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/cfx/requester.ts
git commit -m "feat: Playwright APIRequestContext requester adapter"
```

---

### Task 3.4: `cfx/session.ts` — 3-tier `ensureSession`

**Files:**
- Create: `src/cfx/session.ts`

**Interfaces:**
- Consumes: `loginViaSSO`, `loginWithPasskey` (3.2); `loadCredential` (3.1); `isAuthenticated` (2.1); `playwrightRequester` (3.3).
- Produces:
  ```ts
  export interface Session { request: import("./api.js").Requester; close(): Promise<void>; }
  export const AUTH_STATE_FILE: string; // repo-root auth-state.json
  export async function ensureSession(): Promise<Session>;
  ```

- [ ] **Step 1: Write implementation**

`src/cfx/session.ts`:
```ts
import { access } from "fs/promises";
import path from "path";
import chalk from "chalk";
import { chromium, request, type APIRequestContext, type Browser } from "playwright";
import { isAuthenticated } from "./api.js";
import { playwrightRequester } from "./requester.js";
import { loginViaSSO, loginWithPasskey } from "./login.js";
import { loadCredential } from "./passkey.js";

export const AUTH_STATE_FILE = path.resolve(import.meta.dirname, "../../auth-state.json");

export interface Session {
  request: ReturnType<typeof playwrightRequester>;
  close(): Promise<void>;
}

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function apiSessionFromState(): Promise<APIRequestContext | null> {
  if (!(await fileExists(AUTH_STATE_FILE))) return null;
  const ctx = await request.newContext({ storageState: AUTH_STATE_FILE });
  if (await isAuthenticated(playwrightRequester(ctx))) return ctx;
  await ctx.dispose();
  return null;
}

const LAUNCH_ARGS = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"];

export async function ensureSession(): Promise<Session> {
  // Tier 1: existing jwt still valid — no browser.
  const cached = await apiSessionFromState();
  if (cached) {
    console.log(chalk.green("Portal session valid (jwt)."));
    return { request: playwrightRequester(cached), close: () => cached.dispose() };
  }

  // Tiers 2 & 3 need a browser.
  const browser: Browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  try {
    const hasState = await fileExists(AUTH_STATE_FILE);
    const context = await browser.newContext(hasState ? { storageState: AUTH_STATE_FILE } : {});
    const page = await context.newPage();

    // Tier 2: forum session alive → SSO with no passkey prompt.
    let ok = await loginViaSSO(page);

    // Tier 3: full passkey login.
    if (!ok) {
      const credential = await loadCredential();
      if (!credential) {
        throw new Error("No passkey credential. Run 'bun run register-passkey' first.");
      }
      console.log(chalk.gray("SSO needs re-auth — logging in with passkey..."));
      ok = await loginWithPasskey(page, credential);
    }

    if (!ok) throw new Error("Portal login failed (SSO + passkey both failed).");

    await context.storageState({ path: AUTH_STATE_FILE });
    const apiCtx = await request.newContext({ storageState: AUTH_STATE_FILE });
    return { request: playwrightRequester(apiCtx), close: () => apiCtx.dispose() };
  } finally {
    await browser.close();
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/cfx/session.ts
git commit -m "feat: 3-tier ensureSession (jwt -> SSO -> passkey)"
```

---

## Phase 4 — Port core + integrations

### Task 4.1: Port core modules (config, build, git)

**Files:**
- Create: `src/core/config.ts` (from `src/config.ts`)
- Create: `src/core/build.ts` (from `src/build.ts`)
- Create: `src/core/git.ts` (from `src/git.ts`)

**Interfaces:**
- Produces (unchanged signatures): `loadConfig`, `UploadConfig`, `VersionConfig`, `FrontendConfig`, `UploadConfig` (config.ts); `buildVersions`, `BuildResult` (build.ts); `cloneOrPull`, `getRepoDir`, `getGitDiff` (git.ts).

- [ ] **Step 1: Move files**

```bash
git mv src/config.ts src/core/config.ts
git mv src/build.ts src/core/build.ts
git mv src/git.ts src/core/git.ts
```

- [ ] **Step 2: Fix `build.ts` import of config**

In `src/core/build.ts`, the line `import type { UploadConfig } from "./config.js";` stays valid (same dir). No change needed.

- [ ] **Step 3: Fix `git.ts` REPOS_DIR path**

In `src/core/git.ts`, change:
```ts
const REPOS_DIR = path.resolve(import.meta.dirname, "../repos");
```
to (now one level deeper):
```ts
const REPOS_DIR = path.resolve(import.meta.dirname, "../../repos");
```

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: errors only from old `src/index.ts`/`src/deploy.ts`/etc. that still import old paths (fixed in later tasks). `src/core/*` themselves must not error. Confirm no error line references `src/core/`.

- [ ] **Step 5: Commit**

```bash
git add src/core/
git commit -m "refactor: move config/build/git into src/core with corrected paths"
```

---

### Task 4.2: Port integrations (github, discord, changelog)

**Files:**
- Create: `src/integrations/github.ts` (from `src/github.ts`)
- Create: `src/integrations/discord.ts` (from `src/discord.ts`)
- Create: `src/integrations/changelog.ts` (from `src/changelog.ts`)

**Interfaces:**
- Produces (unchanged): `createGitHubRelease`, `GitHubReleaseResult`, `GitHubReleaseOptions`, `readManifestVersion` (github.ts — but see Step 2); `sendDiscordChangelog`, `classifyReleaseType`, `ReleaseType`, `DiscordChangelogOptions` (discord.ts); `generateChangelog`, `ChangelogInput` (changelog.ts).

- [ ] **Step 1: Move files**

```bash
git mv src/github.ts src/integrations/github.ts
git mv src/discord.ts src/integrations/discord.ts
git mv src/changelog.ts src/integrations/changelog.ts
```

- [ ] **Step 2: De-duplicate version reading in `github.ts`**

`src/integrations/github.ts` currently defines its own `readManifestVersion`. Remove that function and import the canonical one from core. At top of file add:
```ts
import { readManifestVersion } from "../core/manifest.js";
```
Delete the local `export async function readManifestVersion(...) {...}` block (the ~9-line function). Its call sites already use `readManifestVersion(...)` and keep working via the import.

Also update the `readManifestVersion` import in `src/index.ts` consumers later (Task 5.x) to `../integrations/... ` is no longer where it lives — it now lives in `core/manifest.js`. (Handled in Task 5.1.)

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: `src/integrations/*` must not error. Remaining errors come from not-yet-updated `src/index.ts`/`src/deploy.ts`/`src/server.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/integrations/ src/core/manifest.ts
git commit -m "refactor: move github/discord/changelog into src/integrations; unify manifest version reader"
```

---

### Task 4.3: Extract repos config + queue into `server-support/`

**Files:**
- Create: `src/server-support/repos.ts`
- Create: `src/server-support/queue.ts` (from `src/queue.ts`)

**Interfaces:**
- Produces:
  - `repos.ts`: `export interface RepoEntry { name: string; githubUrl: string; branch?: string }`, `export interface ReposConfig { repos: RepoEntry[] }`, `export async function loadReposConfig(): Promise<ReposConfig>`.
  - `queue.ts`: `export const buildQueue` (unchanged).

- [ ] **Step 1: Move queue**

```bash
git mv src/queue.ts src/server-support/queue.ts
```

- [ ] **Step 2: Create `src/server-support/repos.ts`**

```ts
import { readFile } from "fs/promises";
import path from "path";

export interface RepoEntry {
  name: string;
  githubUrl: string;
  branch?: string;
}

export interface ReposConfig {
  repos: RepoEntry[];
}

const CONFIG_PATH = path.resolve(import.meta.dirname, "../../repos.json");

export async function loadReposConfig(): Promise<ReposConfig> {
  const config: ReposConfig = JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
  if (!config.repos || config.repos.length === 0) {
    throw new Error("repos.json: 'repos' list cannot be empty.");
  }
  return config;
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: `server-support/*` no errors.

- [ ] **Step 4: Commit**

```bash
git add src/server-support/
git commit -m "refactor: extract repos loader and move build queue into server-support"
```

---

## Phase 5 — Commands + router

### Task 5.1: `commands/shared.ts` — shared release announcement

**Files:**
- Create: `src/commands/shared.ts`

**Interfaces:**
- Consumes: `getGitDiff` (core/git), `generateChangelog` (integrations/changelog), `sendDiscordChangelog`, `classifyReleaseType` (integrations/discord), `GitHubReleaseResult` (integrations/github).
- Produces:
  ```ts
  export async function announceRelease(repoDir: string, repoName: string, release: import("../integrations/github.js").GitHubReleaseResult): Promise<void>;
  ```
  Encapsulates the "if release.status === 'created', summarize prevTag..HEAD and notify Discord" logic that was inline in `src/index.ts`.

- [ ] **Step 1: Write implementation**

`src/commands/shared.ts`:
```ts
import chalk from "chalk";
import { getGitDiff } from "../core/git.js";
import { generateChangelog } from "../integrations/changelog.js";
import { sendDiscordChangelog, classifyReleaseType } from "../integrations/discord.js";
import type { GitHubReleaseResult } from "../integrations/github.js";

/** After a brand-new GitHub release, summarize commits since the previous tag
 *  and post a Discord changelog. No-op for existing/skipped releases. */
export async function announceRelease(
  repoDir: string,
  repoName: string,
  release: GitHubReleaseResult | null
): Promise<void> {
  if (!release || release.status !== "created" || !release.tag) return;

  try {
    const prevTag = Bun.spawnSync(
      ["git", "-C", repoDir, "describe", "--tags", "--abbrev=0", `${release.tag}^`],
      { stdio: ["pipe", "pipe", "pipe"] }
    ).stdout.toString().trim();

    const logArgs = prevTag
      ? ["git", "-C", repoDir, "log", `${prevTag}..HEAD`, "--pretty=format:%s"]
      : ["git", "-C", repoDir, "log", "-10", "--pretty=format:%s"];
    const messages = Bun.spawnSync(logArgs, { stdio: ["pipe", "pipe", "pipe"] })
      .stdout.toString().trim().split("\n").filter(Boolean);

    if (messages.length === 0) return;

    console.log(chalk.gray(`[Changelog] ${repoName}: generating (${prevTag || "history"} → ${release.tag})...`));
    const diff = prevTag ? getGitDiff(repoDir, prevTag, "HEAD") : "";
    const changelog = await generateChangelog({
      repoName,
      commits: messages.map((message) => ({ message, added: [], removed: [], modified: [] })),
      diff,
    });
    console.log(chalk.gray(`[Changelog] ${repoName}:\n${changelog}`));

    await sendDiscordChangelog({
      repoName,
      changelog,
      version: release.version,
      releaseType: classifyReleaseType(messages),
    });
  } catch (err) {
    console.error(
      chalk.yellow(`[Changelog] ${repoName}: failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
    );
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: `shared.ts` no errors.

- [ ] **Step 3: Commit**

```bash
git add src/commands/shared.ts
git commit -m "feat: shared announceRelease helper for deploy/release commands"
```

---

### Task 5.2: `commands/build.ts` and `commands/deploy.ts`

**Files:**
- Create: `src/commands/build.ts`
- Create: `src/commands/deploy.ts`

**Interfaces:**
- Consumes: `loadConfig` (core/config), `buildVersions` (core/build), `ensureSession` (cfx/session), `uploadAsset` (cfx/upload), `createGitHubRelease` (integrations/github), `announceRelease` (5.1).
- Produces:
  - `export async function buildCommand(scriptDir: string): Promise<void>` — zips only.
  - `export async function deployCommand(scriptDir: string): Promise<{ release: GitHubReleaseResult | null }>` — build + upload + github + returns release for announce.

- [ ] **Step 1: Write `src/commands/build.ts`**

```ts
import path from "path";
import { mkdir, rm } from "fs/promises";
import chalk from "chalk";
import { loadConfig } from "../core/config.js";
import { buildVersions, type BuildResult } from "../core/build.js";

export async function buildZips(scriptDir: string): Promise<{ config: Awaited<ReturnType<typeof loadConfig>>; zips: BuildResult; outputDir: string }> {
  const resolvedDir = path.resolve(scriptDir);
  const config = await loadConfig(resolvedDir);
  const outputDir = path.join(resolvedDir, ".build");
  await mkdir(outputDir, { recursive: true });
  console.log(chalk.gray("Building zips..."));
  const zips = await buildVersions(resolvedDir, config, outputDir);
  if (zips.escrowZip) console.log(chalk.green(`Escrow zip: ${zips.escrowZip}`));
  if (zips.openZip) console.log(chalk.green(`Open zip: ${zips.openZip}`));
  return { config, zips, outputDir };
}

export async function buildCommand(scriptDir: string): Promise<void> {
  const { outputDir } = await buildZips(scriptDir);
  console.log(chalk.bold.green(`Zips ready in ${outputDir}\n`));
}
```

- [ ] **Step 2: Write `src/commands/deploy.ts`**

```ts
import path from "path";
import { rm } from "fs/promises";
import chalk from "chalk";
import { buildZips } from "./build.js";
import { ensureSession } from "../cfx/session.js";
import { uploadAsset } from "../cfx/upload.js";
import { readManifestVersion } from "../core/manifest.js";
import { createGitHubRelease, type GitHubReleaseResult } from "../integrations/github.js";

export async function deployCommand(scriptDir: string): Promise<{ repoDir: string; release: GitHubReleaseResult | null }> {
  const resolvedDir = path.resolve(scriptDir);
  const { config, zips, outputDir } = await buildZips(resolvedDir);

  const version = await readManifestVersion(resolvedDir);
  if (!version) throw new Error("Could not read version from fxmanifest.lua.");

  console.log(chalk.gray("Ensuring portal session..."));
  const session = await ensureSession();
  try {
    if (zips.escrowZip && config.versions.escrow) {
      await uploadAsset(session.request, {
        assetId: config.versions.escrow.assetId, zipPath: zips.escrowZip, version, label: "ESCROW",
      });
    }
    if (zips.openZip && config.versions.open) {
      await uploadAsset(session.request, {
        assetId: config.versions.open.assetId, zipPath: zips.openZip, version, label: "OPEN",
      });
    }
    console.log(chalk.bold.green("All versions uploaded."));
  } finally {
    await session.close();
  }

  let release: GitHubReleaseResult | null = null;
  try {
    const zipPaths = [zips.escrowZip, zips.openZip].filter((p): p is string => !!p);
    release = await createGitHubRelease({ repoDir: resolvedDir, zipPaths });
  } catch (err) {
    console.log(chalk.yellow(`GitHub release failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`));
  }

  await rm(outputDir, { recursive: true, force: true });
  return { repoDir: resolvedDir, release };
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: `commands/build.ts` + `commands/deploy.ts` no errors.

- [ ] **Step 4: Commit**

```bash
git add src/commands/build.ts src/commands/deploy.ts
git commit -m "feat: build and deploy commands on the API-first upload path"
```

---

### Task 5.3: `commands/release.ts` — GitHub-only release (NEW)

**Files:**
- Create: `src/commands/release.ts`

**Interfaces:**
- Consumes: `buildZips` (5.2), `createGitHubRelease` (integrations/github), `announceRelease` (5.1).
- Produces: `export async function releaseCommand(scriptDir: string): Promise<{ repoDir: string; release: GitHubReleaseResult | null }>`.

- [ ] **Step 1: Write implementation**

`src/commands/release.ts`:
```ts
import path from "path";
import { rm } from "fs/promises";
import chalk from "chalk";
import { buildZips } from "./build.js";
import { createGitHubRelease, type GitHubReleaseResult } from "../integrations/github.js";

/** Build zips and publish a GitHub release with them — no portal upload,
 *  no browser. Discord announcement is handled by the caller via announceRelease. */
export async function releaseCommand(scriptDir: string): Promise<{ repoDir: string; release: GitHubReleaseResult | null }> {
  const resolvedDir = path.resolve(scriptDir);
  const { zips, outputDir } = await buildZips(resolvedDir);

  let release: GitHubReleaseResult | null = null;
  try {
    const zipPaths = [zips.escrowZip, zips.openZip].filter((p): p is string => !!p);
    release = await createGitHubRelease({ repoDir: resolvedDir, zipPaths });
  } catch (err) {
    console.log(chalk.yellow(`GitHub release failed: ${err instanceof Error ? err.message : String(err)}`));
    throw err;
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }

  console.log(chalk.bold.green("GitHub release complete (portal untouched).\n"));
  return { repoDir: resolvedDir, release };
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/commands/release.ts
git commit -m "feat: release command — GitHub-only, no portal push"
```

---

### Task 5.4: `commands/register.ts` — passkey registration (Playwright, headed)

**Files:**
- Create: `src/commands/register.ts`

**Interfaces:**
- Consumes: `setupVirtualAuthenticator`, `getRegisteredCredentials`, `saveCredential` (3.1); `AUTH_STATE_FILE` (3.4).
- Produces: `export async function registerCommand(): Promise<void>`.

- [ ] **Step 1: Write implementation**

`src/commands/register.ts`:
```ts
import path from "path";
import { access } from "fs/promises";
import chalk from "chalk";
import { chromium } from "playwright";
import { setupVirtualAuthenticator, getRegisteredCredentials, saveCredential } from "../cfx/passkey.js";
import { AUTH_STATE_FILE } from "../cfx/session.js";

const FORUM_SECURITY_URL = "https://forum.cfx.re/my/preferences/security";

export async function registerCommand(): Promise<void> {
  console.log(chalk.bold("\n9am-build — Passkey Registration\n"));

  let hasState = false;
  try { await access(AUTH_STATE_FILE); hasState = true; } catch { /* none */ }

  const browser = await chromium.launch({ headless: false, args: ["--disable-blink-features=AutomationControlled"] });
  const context = await browser.newContext(hasState ? { storageState: AUTH_STATE_FILE } : {});
  const page = await context.newPage();

  const { authenticatorId, cdp } = await setupVirtualAuthenticator(page);

  await page.goto(FORUM_SECURITY_URL, { waitUntil: "domcontentloaded" });

  console.log(chalk.bold.cyan("\n════════════════════════════════════════"));
  console.log(chalk.bold.cyan("  In the browser window:"));
  console.log(chalk.bold.cyan("  1. Log in to the forum if prompted"));
  console.log(chalk.bold.cyan("  2. Click 'Add Passkey' (confirm access with your password)"));
  console.log(chalk.bold.cyan("  3. Name the passkey and confirm"));
  console.log(chalk.bold.cyan("  4. Return here and press Enter"));
  console.log(chalk.bold.cyan("════════════════════════════════════════\n"));

  await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));

  const credentials = await getRegisteredCredentials(cdp, authenticatorId);
  if (credentials.length === 0) {
    console.log(chalk.red("No passkey credential found — registration may have failed."));
    await browser.close();
    process.exit(1);
  }

  await saveCredential(credentials[credentials.length - 1]);
  await context.storageState({ path: AUTH_STATE_FILE });
  console.log(chalk.green(`\nPasskey saved (rpId: ${credentials[credentials.length - 1].rpId}).`));
  console.log(chalk.gray("auth-state.json refreshed.\n"));

  await browser.close();
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/commands/register.ts
git commit -m "feat: passkey registration command on Playwright (headed)"
```

---

### Task 5.5: `commands/server.ts` — webhook server (ported)

**Files:**
- Create: `src/commands/server.ts` (from old `src/server.ts`, retargeted)
- Delete: `src/server.ts`

**Interfaces:**
- Consumes: `loadReposConfig`, `RepoEntry` (server-support/repos), `buildQueue` (server-support/queue), `cloneOrPull`, `getGitDiff` (core/git), `deployCommand` (5.2), `announceRelease` is NOT used here (server keeps its push-payload changelog); reuse existing inline changelog with `generateChangelog`/`sendDiscordChangelog`/`classifyReleaseType`.
- Produces: `export async function startServer(): Promise<void>`.

- [ ] **Step 1: Create the new file**

Copy old `src/server.ts` into `src/commands/server.ts` with these import changes at the top:
```ts
import { createHmac, timingSafeEqual } from "crypto";
import chalk from "chalk";
import { cloneOrPull, getGitDiff } from "../core/git.js";
import { deployCommand } from "./deploy.js";
import { buildQueue } from "../server-support/queue.js";
import { loadReposConfig, type RepoEntry } from "../server-support/repos.js";
import { generateChangelog } from "../integrations/changelog.js";
import { sendDiscordChangelog, classifyReleaseType } from "../integrations/discord.js";
```
Remove the now-duplicated `RepoEntry`/`ReposConfig`/`loadReposConfig` definitions (they live in `server-support/repos.ts`). Keep `GitHubCommit`/`GitHubPushPayload` interfaces local.

- [ ] **Step 2: Replace the pipeline body to call `deployCommand`**

In `handleWebhook`, replace the `buildQueue.enqueue` callback's `const release = await deployScript(repoDir);` with:
```ts
const { release } = await deployCommand(repoDir);
```
Keep the existing Discord block below it (which reads `release?.status`, `payload.before/after`, builds the changelog from push commits). It already imports `generateChangelog`/`sendDiscordChangelog`/`classifyReleaseType`.

- [ ] **Step 3: Delete old server**

```bash
git rm src/server.ts
```

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: `commands/server.ts` no errors.

- [ ] **Step 5: Commit**

```bash
git add src/commands/server.ts
git commit -m "refactor: port webhook server, drive it through deployCommand"
```

---

### Task 5.6: `index.ts` — command router + delete dead files

**Files:**
- Modify: `src/index.ts`
- Delete: `src/auth.ts`, `src/upload.ts` (old), `src/deploy.ts`, `src/register-passkey.ts`, `src/passkey.ts`, `manual-login.ts`, `announce-v105.ts`

**Interfaces:**
- Consumes: `buildCommand`, `deployCommand`, `releaseCommand`, `registerCommand`, `startServer`, `announceRelease`, `loadReposConfig`, `cloneOrPull`, plus debug helpers.
- Produces: CLI entrypoint dispatching `deploy|build|release|server|register|debug`.

- [ ] **Step 1: Write new `src/index.ts`**

```ts
import chalk from "chalk";
import { cloneOrPull, getRepoDir, getGitDiff } from "./core/git.js";
import { loadReposConfig } from "./server-support/repos.js";
import { buildCommand } from "./commands/build.js";
import { deployCommand } from "./commands/deploy.js";
import { releaseCommand } from "./commands/release.js";
import { registerCommand } from "./commands/register.js";
import { startServer } from "./commands/server.js";
import { announceRelease } from "./commands/shared.js";
import { generateChangelog } from "./integrations/changelog.js";
import { sendDiscordChangelog, classifyReleaseType } from "./integrations/discord.js";
import { readManifestVersion } from "./core/manifest.js";

function usage(): never {
  console.error(chalk.red("Usage:"));
  console.error(chalk.red("  bun run deploy <script>     Build + upload to portal + GitHub release"));
  console.error(chalk.red("  bun run build <script>      Build zips only"));
  console.error(chalk.red("  bun run release <script>    Build + GitHub release only (no portal)"));
  console.error(chalk.red("  bun run server              Start webhook server"));
  console.error(chalk.red("  bun run register-passkey    Register a forum passkey"));
  console.error(chalk.red("  bun src/index.ts debug <repo> <commit>  Changelog test"));
  process.exit(1);
}

async function resolveScriptDir(scriptName: string): Promise<{ dir: string; repoName: string }> {
  const config = await loadReposConfig();
  const repo = config.repos.find((r) => r.name === scriptName);
  if (!repo) {
    console.log(chalk.yellow(`[${scriptName}] Not in repos.json — treating as a local path.`));
    return { dir: scriptName, repoName: scriptName };
  }
  const dir = await cloneOrPull(repo.name, repo.githubUrl, repo.branch ?? "main");
  return { dir, repoName: repo.name };
}

async function runDebug(repoName: string, commitId: string): Promise<void> {
  const repoDir = getRepoDir(repoName);
  const commitMessage = Bun.spawnSync(["git", "log", commitId, "-1", "--pretty=format:%s"], { cwd: repoDir, stdio: ["pipe", "pipe", "pipe"] }).stdout.toString().trim();
  const filesRaw = Bun.spawnSync(["git", "diff-tree", "--no-commit-id", "-r", "--name-status", commitId], { cwd: repoDir, stdio: ["pipe", "pipe", "pipe"] }).stdout.toString().trim();
  const added: string[] = [], removed: string[] = [], modified: string[] = [];
  for (const line of filesRaw.split("\n").filter(Boolean)) {
    const [status, file] = line.split("\t");
    if (status === "A") added.push(file); else if (status === "D") removed.push(file); else modified.push(file);
  }
  const diff = getGitDiff(repoDir, `${commitId}~1`, commitId);
  const changelog = await generateChangelog({ repoName, commits: [{ message: commitMessage, added, removed, modified }], diff });
  console.log(chalk.green(`Changelog:\n${changelog}\n`));
  const version = await readManifestVersion(repoDir);
  await sendDiscordChangelog({ repoName, changelog, version: version ?? undefined, releaseType: classifyReleaseType([commitMessage]) });
}

async function main() {
  const command = process.argv[2];
  if (!command) usage();

  switch (command) {
    case "server":
    case "serve":
      return startServer();
    case "register":
      return registerCommand();
    case "debug": {
      const [, , , repoName, commitId] = process.argv;
      if (!repoName || !commitId) usage();
      return runDebug(repoName, commitId);
    }
    case "build": {
      const scriptName = process.argv[3];
      if (!scriptName) usage();
      const { dir } = await resolveScriptDir(scriptName);
      return buildCommand(dir);
    }
    case "release": {
      const scriptName = process.argv[3];
      if (!scriptName) usage();
      const { dir, repoName } = await resolveScriptDir(scriptName);
      const { repoDir, release } = await releaseCommand(dir);
      return announceRelease(repoDir, repoName, release);
    }
    case "deploy": {
      const scriptName = process.argv[3];
      if (!scriptName) usage();
      const { dir, repoName } = await resolveScriptDir(scriptName);
      const { repoDir, release } = await deployCommand(dir);
      return announceRelease(repoDir, repoName, release);
    }
    default: {
      // Back-compat: bare "<script>" means deploy.
      const { dir, repoName } = await resolveScriptDir(command);
      const { repoDir, release } = await deployCommand(dir);
      return announceRelease(repoDir, repoName, release);
    }
  }
}

main().catch((err) => {
  console.error(chalk.red(`\nError: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
```

- [ ] **Step 2: Delete dead files**

```bash
git rm src/auth.ts src/upload.ts src/deploy.ts src/register-passkey.ts src/passkey.ts
git rm manual-login.ts announce-v105.ts
```
(Note: new upload/passkey live in `src/cfx/`. The old root-level `src/upload.ts` and `src/passkey.ts` are the Puppeteer versions being removed.)

- [ ] **Step 3: Typecheck the whole project**

Run: `bun run typecheck`
Expected: **zero errors**.

- [ ] **Step 4: Run the full test suite**

Run: `bun test`
Expected: all tests PASS (manifest, api, upload).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: command router; remove Puppeteer-era files"
```

---

## Phase 6 — Docker, docs, live validation

### Task 6.1: Update Dockerfile for Playwright Chromium

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Rewrite Dockerfile**

```dockerfile
FROM oven/bun:1-debian

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install

# Install Playwright's Chromium + OS deps
RUN bunx playwright install --with-deps chromium

COPY . .

RUN chmod +x docker-entrypoint.sh

EXPOSE 9000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["bun", "run", "server"]
```

- [ ] **Step 2: Verify build args referenced exist**

Run: `test -f docker-entrypoint.sh && echo ok`
Expected: `ok` (unchanged from before). If missing, keep the previous entrypoint file — do not create a new contract.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "build: install Playwright Chromium in Docker image"
```

---

### Task 6.2: Validate WebAuthn + register flow live (headed)

**Files:** none (manual validation, user-supervised).

- [ ] **Step 1: Confirm existing credential still loads**

Run: `bun -e "import('./src/cfx/passkey.js').then(m=>m.loadCredential()).then(c=>console.log(c? 'credential present rpId='+c.rpId : 'none'))"`
Expected: prints `credential present rpId=forum.cfx.re` (existing `passkey-credential.json`). If `none`, run `bun run register-passkey` with the user.

- [ ] **Step 2: Validate a headless session end-to-end (no upload)**

Run: `bun -e "import('./src/cfx/session.js').then(async m=>{const s=await m.ensureSession(); const {isAuthenticated}=await import('./src/cfx/api.js'); console.log('authed=', await isAuthenticated(s.request)); await s.close();})"`
Expected: `authed= true`. This exercises tier 1 (cached jwt) or tier 2/3 (SSO/passkey) depending on cookie freshness.

- [ ] **Step 3: Commit (nothing to commit; record result in PR notes)**

---

### Task 6.3: Live upload smoke test (user-supervised)

**Files:** none.

- [ ] **Step 1: Build a real asset without uploading**

Run: `bun run build 9am-textui`
Expected: `.build/9am-textui-escrow.zip` reported; exit 0.

- [ ] **Step 2: Deploy to the real asset (bump version first if needed)**

Coordinate with the user: ensure `repos/9am-textui/fxmanifest.lua` has a fresh `version`. Then:
Run: `bun run deploy 9am-textui`
Expected: session ensured, `[ESCROW]` chunks upload, "Asset 933369 uploaded", GitHub release created/existing. If `DUPLICATE_VERSION`, bump version and retry.

- [ ] **Step 2b (fallback if bun+WebAuthn misbehaves):** re-run the same command with node:
Run: `npx tsx src/index.ts deploy 9am-textui` (only if bun runtime fails on CDP WebAuthn; note in PR).

- [ ] **Step 3: Verify on portal**

Confirm via `GET v1/assets/933369` that the new version appears (the deploy log prints success). Record outcome.

---

### Task 6.4: Update README/env docs

**Files:**
- Modify: `README.md` (if present) — document the new `release` command and Playwright requirement.
- Modify: `.env.example` — unchanged keys; add a comment that Playwright Chromium is required (`bunx playwright install chromium`).

- [ ] **Step 1: Document the `release` command**

Add to README usage section:
```
bun run release <script>   # Build zips + create a GitHub release with them.
                           # Does NOT upload to the Cfx portal and never opens a browser.
```

- [ ] **Step 2: Note Playwright setup**

Add near install instructions: "After `bun install`, run `bunx playwright install chromium` once (Docker does this automatically)."

- [ ] **Step 3: Commit**

```bash
git add README.md .env.example
git commit -m "docs: document release command and Playwright setup"
```

---

## Self-Review

**Spec coverage:**
- API-first architecture → Tasks 2.1–2.2, 3.3, 3.4. ✓
- Browser only for login → login/session split (3.2, 3.4). ✓
- `v1/me` auth signal → `isAuthenticated` (2.1), used in session (3.4). ✓
- Upload REST endpoints + chunking + error codes → 1.2, 2.1, 2.2. ✓
- 3-tier session renewal → `ensureSession` (3.4). ✓
- Passkey registration + renewal → passkey (3.1), login (3.2), register command (5.4). ✓
- New `release` command (no portal) → 5.3, routed in 5.6. ✓
- Preserve config/repos schemas, GitHub/Discord semantics → ports 4.1, 4.2, 4.3, shared 5.1, server 5.5. ✓
- Docker Playwright → 6.1. ✓
- bun runtime, node fallback noted → Global Constraints + 6.3 Step 2b. ✓
- Manifest version regex parity → 1.1. ✓
- Unit tests for pure helpers → 1.1, 1.2, 2.1, 2.2. ✓

**Placeholder scan:** No TBD/TODO; every code step includes full code. Live-validation tasks (6.2–6.3) are inherently manual and give exact commands + expected output. ✓

**Type consistency:** `Requester`/`HttpResponse`/`MultipartField` defined in 2.1 and consumed identically in 2.2 (`uploadAsset(req: Requester, …)`), 3.3 (adapter returns `Requester`), 3.4 (`Session.request`). `AssetDetail`/`AssetVersion` shared between 2.1 and 2.2. `GitHubReleaseResult` from integrations/github consumed in 5.1/5.2/5.3. `announceRelease(repoDir, repoName, release)` signature consistent between 5.1 and callers in 5.6. `ensureSession()`/`Session.close()` consistent (3.4 → 5.2). ✓

**Gap check:** The old `src/index.ts` inline changelog-after-deploy logic is preserved as `announceRelease` (5.1) and wired for both `deploy` and `release`. The webhook server keeps its push-payload-based changelog (5.5), matching prior behavior. No spec requirement left unimplemented.
