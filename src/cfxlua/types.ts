export type TestStatus = "pass" | "fail" | "error";

export interface TestResult {
  suite: string;
  test: string;
  /** `suite > test` */
  name: string;
  /** Spec file, relative to the resource root. */
  file: string;
  /** Line of the `it(...)` call. */
  line: number;
  status: TestStatus;
  durationMs: number;
  /** Present when status is "fail" — the matcher that rejected. */
  matcher?: string;
  expected?: string;
  actual?: string;
  message?: string;
  /** Lua traceback frames, framework frames removed. */
  traceback?: string[];
}

export interface RunSummary {
  resource: string;
  root: string;
  files: string[];
  tests: TestResult[];
  passed: number;
  failed: number;
  total: number;
  durationMs: number;
  /** CfxLua toolchain version, plus whether it ran through WSL. */
  runtime: string;
}
