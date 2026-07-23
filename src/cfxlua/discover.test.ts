import { test, expect } from "bun:test";
import path from "path";
import { parseManifestVersion } from "../core/manifest.js";
import { discoverTestFiles } from "./discover.js";

const fixturesDir = path.join(import.meta.dir, "..", "..", "fixtures", "sample-resource");

test("discovers default test patterns", async () => {
  const files = await discoverTestFiles(fixturesDir);
  expect(files.some((f) => f.endsWith("pricing.spec.lua"))).toBe(true);
  expect(files.every((f) => f.endsWith(".spec.lua"))).toBe(true);
});

test("returns empty list for directory without tests", async () => {
  const files = await discoverTestFiles(path.join(import.meta.dir));
  expect(files).toEqual([]);
});

test("fixture manifest has a version", async () => {
  const content = await Bun.file(path.join(fixturesDir, "fxmanifest.lua")).text();
  expect(parseManifestVersion(content)).toBe("1.0.0");
});
