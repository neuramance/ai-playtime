import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, expect, it, onTestFinished } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SKIPPED = new Set(["node_modules", ".git", "dist"]);
let copy = "";

beforeAll(() => {
  copy = realpathSync(mkdtempSync(join(tmpdir(), `agent-verify-${String(process.pid)}-`)));
  cpSync(ROOT, copy, { recursive: true, filter: (source) => !SKIPPED.has(relative(ROOT, source)) });
  symlinkSync(join(ROOT, "node_modules"), join(copy, "node_modules"));
});

afterAll(() => {
  rmSync(copy, { recursive: true, force: true });
});

function plant(files: Record<string, string>): string[] {
  const paths = Object.entries(files).map(([name, text]) => {
    writeFileSync(join(copy, name), text);
    return join(copy, name);
  });
  onTestFinished(() => {
    for (const path of paths) rmSync(path, { force: true });
  });
  return paths;
}

function gate(...paths: string[]) {
  const result = spawnSync(join(copy, "scripts/agent-verify"), paths, {
    cwd: copy,
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

const lines = (...parts: string[]) => `${parts.join("\n")}\n`;

const branches = (decisions: number) =>
  lines(
    "export function grade(n: number): number {",
    ...Array.from(
      { length: decisions },
      (_, i) => `  if (n === ${String(i)}) return ${String(i)};`,
    ),
    "  return -1;",
    "}",
  );

const nesting = (levels: number) =>
  lines(
    "export function nest(n: number): number {",
    ...Array.from({ length: levels }, (_, i) => `${"  ".repeat(i + 1)}if (n > ${String(i)}) {`),
    `${"  ".repeat(levels + 1)}return n;`,
    ...Array.from({ length: levels }, (_, i) => `${"  ".repeat(levels - i)}}`),
    "  return 0;",
    "}",
  );

const longFunction = (length: number) =>
  lines(
    "export function long(): number {",
    "  let total = 0;",
    ...Array.from({ length: length - 4 }, () => "  total += 1;"),
    "  return total;",
    "}",
  );

const longFile = (length: number) =>
  lines(...Array.from({ length }, (_, i) => `export const v${String(i)} = ${String(i)};`));

it("accepts code at every complexity and size limit, including awkward file names", () => {
  const paths = plant({
    "src/--grade at limit.ts": branches(9),
    "src/at-depth.ts": nesting(3),
    "src/at-function-length.ts": longFunction(100),
    "src/at-file-length.ts": longFile(500),
  });
  const { status, output } = gate(...paths);
  expect({ status, output }).toEqual({
    status: 0,
    output: expect.stringMatching(/^agent-verify: passed format, lint in \d+\.\ds\n$/) as string,
  });
});

it("rejects code over each limit and names the rule and location", () => {
  const paths = plant({
    "src/over-complexity.ts": branches(10),
    "src/over-depth.ts": nesting(4),
    "src/over-function-length.ts": longFunction(101),
    "src/over-file-length.ts": longFile(501),
    "src/tautology.test.ts": lines(
      'import { expect, it } from "vitest";',
      "",
      'it("compares a value with itself", () => {',
      "  const value = Math.random();",
      "  expect(value).toEqual(value);",
      "});",
    ),
  });
  const { status, output } = gate(...paths);
  expect(status).toBe(1);
  expect(output).toMatch(/FAIL lint \(exit 1\)/);
  expect(output).toMatch(
    /over-complexity\.ts\n\s+1:\d+\s+error\s+Function 'grade' has a complexity of 11\. Maximum allowed is 10\s+complexity/,
  );
  expect(output).toMatch(
    /over-depth\.ts\n\s+5:\d+\s+error\s+Blocks are nested too deeply \(4\)\. Maximum allowed is 3\s+max-depth/,
  );
  expect(output).toMatch(
    /over-function-length\.ts\n\s+1:\d+\s+error\s+Function 'long' has too many lines \(101\)\. Maximum allowed is 100\s+max-lines-per-function/,
  );
  expect(output).toMatch(
    /over-file-length\.ts\n\s+501:\d+\s+error\s+File has too many lines \(501\)\. Maximum allowed is 500\s+max-lines/,
  );
  expect(output).toMatch(
    /tautology\.test\.ts\n\s+5:\d+\s+error\s+This assertion compares a value with itself.*local\/no-tautological-assertion/,
  );
});

it("rejects paths outside the repository, including through symlinks", () => {
  symlinkSync("/etc/hosts", join(copy, "src/escape.ts"));
  onTestFinished(() => {
    rmSync(join(copy, "src/escape.ts"));
  });
  expect(gate("/etc/hosts")).toEqual({
    status: 2,
    output: `agent-verify: /etc/hosts is outside the repository ${copy}\n`,
  });
  expect(gate(join(copy, "src/escape.ts")).status).toBe(2);
});

it("checks an in-repository file whose name starts with two dots", () => {
  const [path = ""] = plant({ "..notes.md": "Notes\n" });
  expect(gate(path).output).toMatch(/^agent-verify: passed format in \d+\.\ds\n$/);
});

it("labels a focused run with only deleted files as skipped", () => {
  expect(gate(join(copy, "src/deleted.ts"))).toEqual({
    status: 0,
    output: "agent-verify: skipped, no existing files to check\n",
  });
});

it("passes the full gate on a clean tree and fails it when a test fails", () => {
  expect(gate().output).toMatch(
    /^agent-verify: passed format, lint, typecheck, test, build in \d+\.\ds\n$/,
  );
  plant({
    "src/planted.test.ts": lines(
      'import { expect, it } from "vitest";',
      "",
      'it("planted failure", () => {',
      "  expect(1 + 1).toBe(3);",
      "});",
    ),
  });
  const { status, output } = gate();
  expect({
    status,
    failed: output.match(/FAIL \w+/g),
    names: output.includes("planted.test.ts"),
  }).toEqual({
    status: 1,
    failed: ["FAIL test"],
    names: true,
  });
}, 60_000);

it("stops every check and leaves no processes behind when interrupted", async () => {
  const child = spawn(join(copy, "scripts/agent-verify"), [], { cwd: copy });
  let output = "";
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  while (spawnSync("pgrep", ["-f", join(copy, "node_modules")], { timeout: 10_000 }).status !== 0) {
    await new Promise((wait) => setTimeout(wait, 50));
  }
  child.kill("SIGTERM");
  const status = await new Promise<number | null>((done) => child.on("close", done));
  const survivors = spawnSync("pgrep", ["-f", copy], { encoding: "utf8", timeout: 10_000 });
  expect({
    status,
    interrupted: output.includes("(interrupted)"),
    survivors: survivors.stdout,
  }).toEqual({
    status: 1,
    interrupted: true,
    survivors: "",
  });
});
