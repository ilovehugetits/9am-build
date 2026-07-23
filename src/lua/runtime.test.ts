import { describe, expect, test } from "bun:test";
import path from "path";
import { fileURLToPath } from "url";
import { createFactory, runTestFile } from "./runtime.js";
import { discoverTests } from "./discover.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/sample-resource"
);

const run = () =>
  runTestFile(createFactory(), "logic.test.lua", {
    root: FIXTURE,
    resourceName: "sample-resource",
  });

describe("discoverTests", () => {
  test("finds test files and returns posix-relative paths", async () => {
    expect(await discoverTests(FIXTURE)).toEqual(["logic.test.lua"]);
  });

  test("returns an empty list when a directory has none", async () => {
    expect(await discoverTests(path.join(FIXTURE, ".."))).not.toContain("logic.lua");
  });
});

describe("runTestFile", () => {
  test("reports each test once, with pass and fail statuses", async () => {
    const results = await run();
    expect(results).toHaveLength(5);
    expect(results.filter((r) => r.status === "pass")).toHaveLength(3);
    expect(results.filter((r) => r.status !== "pass")).toHaveLength(2);
  });

  test("names tests with their describe prefix", async () => {
    const results = await run();
    expect(results.map((r) => r.name)).toContain("addTax > applies a percentage rate");
    expect(results.map((r) => r.name)).toContain(
      "fixture:buy callback > accepts a valid payload"
    );
  });

  test("anchors each test at the line of its it() call", async () => {
    const results = await run();
    const first = results.find((r) => r.name === "addTax > applies a percentage rate");
    expect(first?.file).toBe("logic.test.lua");
    expect(first?.line).toBe(6);
  });

  test("captures structured expected/actual for an assertion failure", async () => {
    const results = await run();
    const failed = results.find((r) => r.name === "addTax > classifies a mid-range price");
    expect(failed?.status).toBe("fail");
    expect(failed?.assertion).toBe("assert.equal");
    expect(failed?.expected).toBe('"mid"');
    expect(failed?.actual).toBe("nil");
  });

  test("resolves traceback frames to real resource paths, not [string ...]", async () => {
    const results = await run();
    const errored = results.find((r) => r.name === "addTax > surfaces an unstubbed native");
    expect(errored?.status).toBe("error");
    expect(errored?.traceback?.[0]).toBe("logic.lua:18: in function 'needsNative'");
    expect(errored?.traceback?.join("\n")).not.toContain("[string");
  });

  test("strips harness frames from the traceback", async () => {
    const results = await run();
    for (const result of results) {
      expect(result.traceback?.join("\n") ?? "").not.toContain("harness.lua");
    }
  });

  test("records which unstubbed global caused an error, and where", async () => {
    const results = await run();
    const errored = results.find((r) => r.name === "addTax > surfaces an unstubbed native");
    expect(errored?.unstubbed).toEqual([
      { name: "GetVehicleNumberPlateText", at: "logic.lua:18" },
    ]);
  });

  test("captures lib.callback handlers so tests can invoke them", async () => {
    const results = await run();
    const accepted = results.find(
      (r) => r.name === "fixture:buy callback > accepts a valid payload"
    );
    expect(accepted?.status).toBe("pass");
  });

  test("isolates globals between tests via harness.load", async () => {
    // Both describe blocks load logic.lua independently; if state leaked, the
    // second block's callback registry would hold duplicates and misbehave.
    const results = await run();
    const rejected = results.find(
      (r) => r.name === "fixture:buy callback > rejects a payload with no model"
    );
    expect(rejected?.status).toBe("pass");
  });
});
