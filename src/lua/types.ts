export interface UnstubbedCall {
  name: string;
  /** `relative/path.lua:LINE` */
  at: string;
}

export type TestStatus = "pass" | "fail" | "error";

export interface TestResult {
  /** Test file, relative to the resource root, posix separators. */
  file: string;
  /** Full name, describe blocks joined with " > ". */
  name: string;
  /** Line of the `it(...)` call. */
  line: number;
  status: TestStatus;
  durationMs: number;
  /** Present when status is "fail". */
  assertion?: string;
  expected?: string;
  actual?: string;
  message?: string;
  /** Cleaned Lua traceback frames, harness frames removed. */
  traceback?: string[];
  unstubbed?: UnstubbedCall[];
}

export interface RunSummary {
  resource: string;
  root: string;
  files: string[];
  tests: TestResult[];
  durationMs: number;
  passed: number;
  failed: number;
}
