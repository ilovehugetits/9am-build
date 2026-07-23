import { test, expect } from "bun:test";
import {
  computeChunking, extractErrorCode,
  isAuthenticated, getAsset, reUpload, uploadChunk, completeUpload, deleteVersion,
  type Requester, type HttpResponse, type MultipartField,
} from "./api.js";

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
