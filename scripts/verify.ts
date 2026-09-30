import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, sep } from "node:path";

const ROOT = realpathSync(join(import.meta.dirname, ".."));
const BIN = join(ROOT, "node_modules", ".bin");
const LOG_DIR = join(ROOT, "node_modules", ".cache", "agent-verify");
const FOCUSED_DEADLINE_MS = 25_000;
const FULL_DEADLINE_MS = 240_000;
const DIAGNOSTIC_LINES = 40;
const LINTED = new Set([".ts", ".js"]);

interface Check {
  name: string;
  command: readonly [string, ...string[]];
  env?: Record<string, string>;
}

interface Outcome {
  check: Check;
  status: number | NodeJS.Signals | "timed out" | "interrupted";
  output: string;
}

function full(buildDir: string): Check[] {
  return [
    { name: "format", command: [join(BIN, "prettier"), "--check", "."] },
    { name: "lint", command: [join(BIN, "eslint"), "."] },
    { name: "typecheck", command: [join(BIN, "tsc")] },
    { name: "test", command: [join(BIN, "vitest"), "run", "--exclude", "scripts/**"] },
    { name: "build", command: ["bun", "run", "build"], env: { OUT: buildDir } },
  ];
}

function inRepository(path: string): string {
  const real = realpathSync(path);
  const inside = relative(ROOT, real);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`${path} is outside the repository ${ROOT}`);
  }
  return real;
}

function focused(paths: string[]): Check[] {
  const files = paths.filter((path) => existsSync(path)).map(inRepository);
  const lintable = files.filter((file) => LINTED.has(extname(file)));
  const checks: Check[] = [];
  if (files.length > 0) {
    checks.push({
      name: "format",
      command: [join(BIN, "prettier"), "--check", "--ignore-unknown", ...files],
    });
  }
  if (lintable.length > 0) {
    checks.push({ name: "lint", command: [join(BIN, "eslint"), "--no-warn-ignored", ...lintable] });
  }
  return checks;
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

function abortReason(signal: AbortSignal): Outcome["status"] {
  const timedOut = signal.reason instanceof DOMException && signal.reason.name === "TimeoutError";
  return timedOut ? "timed out" : "interrupted";
}

function run(check: Check, signal: AbortSignal): Promise<Outcome> {
  const [command, ...args] = check.command;
  const child = spawn(command, args, {
    cwd: ROOT,
    detached: true,
    env: { ...process.env, ...check.env },
  });
  const stop = () => {
    killGroup(child.pid);
  };
  signal.addEventListener("abort", stop, { once: true });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  return new Promise((done) => {
    child.on("error", (error) => {
      output += error.message;
    });
    child.on("close", (code, killedBy) => {
      signal.removeEventListener("abort", stop);
      done({
        check,
        status: signal.aborted ? abortReason(signal) : (code ?? killedBy ?? 1),
        output,
      });
    });
  });
}

function report(outcome: Outcome): string {
  const { check, status, output } = outcome;
  mkdirSync(LOG_DIR, { recursive: true });
  const log = join(LOG_DIR, `${check.name}-${String(process.pid)}.log`);
  writeFileSync(log, output);
  const lines = output.trimEnd().split("\n");
  const shown = lines.slice(-DIAGNOSTIC_LINES).join("\n");
  const omitted = Math.max(lines.length - DIAGNOSTIC_LINES, 0);
  const how = typeof status === "number" ? `exit ${String(status)}` : status;
  return [
    `agent-verify: FAIL ${check.name} (${how}): ${check.command.join(" ")}`,
    ...(omitted > 0 ? [`... ${String(omitted)} earlier lines omitted`] : []),
    shown,
    `full log: ${relative(ROOT, log)}`,
    "",
  ].join("\n");
}

async function verify(checks: Check[], deadlineMs: number): Promise<number> {
  const interrupt = new AbortController();
  for (const name of ["SIGINT", "SIGTERM"] as const) {
    process.once(name, () => {
      interrupt.abort();
    });
  }
  const signal = AbortSignal.any([interrupt.signal, AbortSignal.timeout(deadlineMs)]);
  const started = performance.now();
  const outcomes = await Promise.all(checks.map((check) => run(check, signal)));
  const failures = outcomes.filter((outcome) => outcome.status !== 0);
  if (failures.length > 0) {
    process.stderr.write(failures.map(report).join("\n"));
    return 1;
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const names = checks.map((check) => check.name).join(", ");
  process.stdout.write(`agent-verify: passed ${names} in ${seconds}s\n`);
  return 0;
}

async function main(paths: string[]): Promise<number> {
  if (paths.length > 0) {
    const checks = focused(paths);
    if (checks.length > 0) return verify(checks, FOCUSED_DEADLINE_MS);
    process.stdout.write("agent-verify: skipped, no existing files to check\n");
    return 0;
  }
  const buildDir = mkdtempSync(join(tmpdir(), "agent-verify-build-"));
  try {
    return await verify(full(buildDir), FULL_DEADLINE_MS);
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}

process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`agent-verify: ${error instanceof Error ? error.message : String(error)}\n`);
  return 2;
});
