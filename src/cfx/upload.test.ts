import { test, expect } from "bun:test";
import { oldestVersionId, duplicateVersions } from "./upload.js";
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

test("duplicateVersions returns entries matching version string", () => {
  expect(duplicateVersions(detail, "1.1.0").map((v) => v.id)).toEqual([20]);
  expect(duplicateVersions(detail, "9.9.9")).toEqual([]);
});
