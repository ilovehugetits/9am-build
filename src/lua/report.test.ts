import { describe, expect, test } from "bun:test";
import path from "path";
import { fileURLToPath } from "url";
import { renderJson, renderText } from "./report.js";
import type { RunSummary } from "./types.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/sample-resource"
);

// chalk emits escape codes when it detects colour support; strip them so
// assertions describe content rather than styling.
const strip = (s: string) => s.replace(/\[[0-9;]*m/g, "");

const summary = (): RunSummary => ({
  resource: "sample-resource",
  root: FIXTURE,
  files: ["logic.test.lua"],
  durationMs: 71,
  passed: 1,
  failed: 1,
  tests: [
    {
      file: "logic.test.lua",
      name: "addTax > applies a percentage rate",
      line: 6,
      status: "pass",
      durationMs: 2,
    },
    {
      file: "logic.test.lua",
      name: "addTax > classifies a mid-range price",
      line: 10,
      status: "fail",
      durationMs: 1,
      assertion: "assert.equal",
      expected: '"mid"',
      actual: "nil",
      traceback: ["logic.lua:12: in function 'classify'"],
      unstubbed: [{ name: "GetEntityCoords", at: "logic.lua:18" }],
    },
  ],
});

describe("renderText", () => {
  test("anchors every result on a greppable PASS/FAIL line with file:line", () => {
    const lines = strip(renderText(summary())).split("\n");
    expect(lines.some((l) => l.startsWith("PASS logic.test.lua:6  "))).toBe(true);
    expect(lines.some((l) => l.startsWith("FAIL logic.test.lua:10  "))).toBe(true);
  });

  test("keeps assertion labels separated from their values", () => {
    const out = strip(renderText(summary()));
    expect(out).toContain("assertion  assert.equal");
    expect(out).toContain('expected   "mid"');
    expect(out).toContain("actual     nil");
  });

  test("includes the traceback and the unstubbed globals", () => {
    const out = strip(renderText(summary()));
    expect(out).toContain("logic.lua:12: in function 'classify'");
    expect(out).toContain("GetEntityCoords  logic.lua:18");
  });

  test("reads the offending source line off disk and marks it", () => {
    const out = strip(renderText(summary()));
    expect(out).toContain("source logic.lua:12");
    expect(out).toContain("> 12 |         return nil");
  });

  test("summarises counts on the final line", () => {
    const out = strip(renderText(summary())).trim().split("\n").pop();
    expect(out).toBe("2 tests  1 passed  1 failed  71ms");
  });

  test("does not crash when a traceback points at a file that is gone", () => {
    const s = summary();
    s.tests[1].traceback = ["missing/gone.lua:4: in function 'x'"];
    expect(() => renderText(s)).not.toThrow();
  });
});

describe("renderJson", () => {
  test("round-trips to the same summary", () => {
    expect(JSON.parse(renderJson(summary()))).toEqual(
      JSON.parse(JSON.stringify(summary()))
    );
  });
});
