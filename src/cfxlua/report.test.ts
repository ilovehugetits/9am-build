import { describe, expect, test } from "bun:test";
import path from "path";
import { renderJson, renderText } from "./report.js";
import { packageRoot } from "./ensure-toolchain.js";
import type { RunSummary } from "./types.js";

const FIXTURE = path.join(packageRoot(), "fixtures", "sample-resource");

// chalk emits escape codes when it detects colour support; strip them so
// assertions describe content rather than styling.
const strip = (s: string) => s.replace(/\[[0-9;]*m/g, "");

const summary = (): RunSummary => ({
  resource: "sample-resource",
  root: FIXTURE,
  files: ["tests/pricing.spec.lua"],
  passed: 1,
  failed: 1,
  total: 2,
  durationMs: 71,
  runtime: "CfxLua v1.1.0",
  tests: [
    {
      suite: "pricing.withTax",
      test: "adds tax to the base price",
      name: "pricing.withTax > adds tax to the base price",
      file: "tests/pricing.spec.lua",
      line: 6,
      status: "pass",
      durationMs: 2,
    },
    {
      suite: "pricing.withTax",
      test: "handles zero tax",
      name: "pricing.withTax > handles zero tax",
      file: "tests/pricing.spec.lua",
      line: 10,
      status: "fail",
      durationMs: 1,
      matcher: "equal",
      expected: "100",
      actual: "nil",
      traceback: ["server/main.lua:8: in function 'withTax'"],
    },
  ],
});

describe("renderText", () => {
  test("anchors every result on a greppable PASS/FAIL line with file:line", () => {
    const lines = strip(renderText(summary())).split("\n");
    expect(lines.some((l) => l.startsWith("PASS tests/pricing.spec.lua:6  "))).toBe(true);
    expect(lines.some((l) => l.startsWith("FAIL tests/pricing.spec.lua:10  "))).toBe(true);
  });

  test("keeps matcher labels separated from their values", () => {
    const out = strip(renderText(summary()));
    expect(out).toContain("matcher    equal");
    expect(out).toContain("expected   100");
    expect(out).toContain("actual     nil");
  });

  test("includes the traceback frames", () => {
    expect(strip(renderText(summary()))).toContain("server/main.lua:8: in function 'withTax'");
  });

  test("reads the offending source line off disk and marks it", () => {
    const out = strip(renderText(summary()));
    expect(out).toContain("source server/main.lua:8");
    expect(out).toMatch(/>\s+8 \|/);
  });

  test("names the runtime in the header", () => {
    expect(strip(renderText(summary()))).toContain("[CfxLua v1.1.0]");
  });

  test("summarises counts on the final line", () => {
    const out = strip(renderText(summary())).trim().split("\n").pop();
    expect(out).toBe("2 tests  1 passed  1 failed  71ms");
  });

  test("falls back to the it() location when no traceback frame is usable", () => {
    const s = summary();
    s.tests[1].traceback = ["[C]: in function 'error'"];
    const out = strip(renderText(s));
    expect(out).toContain("source tests/pricing.spec.lua:10");
  });

  test("does not crash when a traceback points at a file that is gone", () => {
    const s = summary();
    s.tests[1].traceback = ["missing/gone.lua:4: in function 'x'"];
    expect(() => renderText(s)).not.toThrow();
  });
});

describe("renderJson", () => {
  test("round-trips to the same summary", () => {
    expect(JSON.parse(renderJson(summary()))).toEqual(JSON.parse(JSON.stringify(summary())));
  });
});
