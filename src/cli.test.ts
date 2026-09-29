import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import pkg from "../package.json" with { type: "json" };

const CLI = join(import.meta.dirname, "cli.ts");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const today = Math.floor(Date.now() / DAY) * DAY;
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const events = (...times: number[]) =>
  times.map((t) => `${JSON.stringify({ timestamp: new Date(t).toISOString() })}\n`).join("");
const yesterdayAt = (...minutes: number[]) =>
  events(...minutes.map((m) => today - DAY + 10 * 60 * MINUTE + m * MINUTE));

function emptyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), `ccplaytime-${String(process.pid)}-`));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function write(dir: string, path: string, text: string): string {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
  return join(dir, path);
}

function claudeDir(): string {
  const dir = emptyDir();
  write(
    dir,
    "projects/-work/s1.jsonl",
    `${yesterdayAt(0, 10)}not json {\n{"type":"summary"}\n${yesterdayAt(20, 60)}`,
  );
  write(dir, "projects/-work/s1/subagents/agent-a.jsonl", yesterdayAt(15, 30));
  return dir;
}

function saveRecord(dir: string, scannedAt: number, secondsByDay: Record<string, number>): void {
  write(
    dir,
    "ccplaytime.json",
    JSON.stringify({ version: 1, scannedAt: new Date(scannedAt).toISOString(), secondsByDay }),
  );
}

function childEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", ...overrides };
  delete env.FORCE_COLOR;
  return env;
}

function runWith(overrides: NodeJS.ProcessEnv, ...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: childEnv(overrides),
    encoding: "utf8",
    timeout: 10_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const run = (dir: string, ...args: string[]) =>
  runWith({ CLAUDE_CONFIG_DIR: dir, HOME: dir }, ...args);
const json = (dir: string) => JSON.parse(run(dir, "--json").stdout) as unknown;

const halfHourYesterday = {
  hoursOnRecord: 0.5,
  hoursLastTwoWeeks: 0.5,
  onRecordSince: dayKey(today - DAY),
  secondsByDay: { [dayKey(today - DAY)]: 1800 },
};

it("reports wall-clock active time across sessions and subagents, skipping idle gaps", () => {
  const { status, stdout, stderr } = run(claudeDir(), "--json");
  expect({ status, stderr, json: JSON.parse(stdout) as unknown }).toEqual({
    status: 0,
    stderr: "",
    json: halfHourYesterday,
  });
});

it("reads ~/.claude when CLAUDE_CONFIG_DIR is unset or blank", () => {
  const home = emptyDir();
  write(home, ".claude/projects/-work/s1.jsonl", yesterdayAt(0, 15, 30));
  const { stdout } = runWith({ HOME: home, CLAUDE_CONFIG_DIR: " " }, "--json");
  expect(JSON.parse(stdout)).toMatchObject({ hoursOnRecord: 0.5 });
});

it("keeps the record after Claude Code deletes the transcripts", () => {
  const dir = claudeDir();
  run(dir, "--json");
  rmSync(join(dir, "projects"), { recursive: true });
  expect(json(dir)).toEqual(halfHourYesterday);
});

it("counts activity added after the previous run", () => {
  const dir = claudeDir();
  run(dir, "--json");
  appendFileSync(
    join(dir, "projects/-work/s1.jsonl"),
    events(today + 60 * MINUTE, today + 70 * MINUTE),
  );
  expect(json(dir)).toMatchObject({
    secondsByDay: { [dayKey(today - DAY)]: 1800, [dayKey(today)]: 600 },
  });
});

it("keeps saved days that the rescan window only partly covers", () => {
  const dir = emptyDir();
  const early = today - 3 * DAY;
  saveRecord(dir, today - DAY + 12 * 60 * MINUTE, {
    [dayKey(early)]: 420,
    [dayKey(early + DAY)]: 360,
  });
  write(
    dir,
    "projects/-work/s1.jsonl",
    events(
      early + DAY - 5 * MINUTE,
      early + DAY + 8 * MINUTE,
      today + 60 * MINUTE,
      today + 70 * MINUTE,
    ),
  );
  const untouched = write(dir, "projects/-work/s2.jsonl", events(early + DAY + 2 * MINUTE));
  utimesSync(untouched, new Date(early + DAY + 3 * MINUTE), new Date(early + DAY + 3 * MINUTE));
  expect(json(dir)).toMatchObject({
    secondsByDay: { [dayKey(early)]: 420, [dayKey(early + DAY)]: 360, [dayKey(today)]: 600 },
  });
});

it("prints a Steam-style card and explains the saved record on the first run", () => {
  const dir = emptyDir();
  write(
    dir,
    "projects/-work/s1.jsonl",
    events(
      Date.parse("2025-06-23T10:00:00Z"),
      Date.parse("2025-06-23T10:15:00Z"),
      Date.parse("2025-06-23T10:30:00Z"),
    ),
  );
  expect(run(dir)).toEqual({
    status: 0,
    stderr: "",
    stdout: [
      "",
      "  ▶ Claude Code",
      "    0.5 hrs on record",
      "    0.0 hrs last two weeks  ··············",
      "    on record since 23 Jun 2025",
      "",
      `  Saved to ${join(dir, "ccplaytime.json")}. Claude Code deletes transcripts after 30 days,`,
      "  so run ccplaytime at least that often to keep your record complete.",
      "",
    ].join("\n"),
  });
});

it("adds scanned days to a saved record and scales the sparkline to the busiest day", () => {
  const dir = claudeDir();
  saveRecord(dir, Date.parse("2025-06-24T00:00:00Z"), {
    "2025-06-23": 5400,
    [dayKey(today - 3 * DAY)]: 3600,
  });
  expect(run(dir).stdout).toBe(
    [
      "",
      "  ▶ Claude Code",
      "    3.0 hrs on record",
      "    1.5 hrs last two weeks  ··········█·▄·",
      "    on record since 23 Jun 2025",
      "",
    ].join("\n"),
  );
});

it("refuses to overwrite a corrupt record", () => {
  const dir = claudeDir();
  const recordPath = write(dir, "ccplaytime.json", "{");
  expect({ ...run(dir), record: readFileSync(recordPath, "utf8") }).toEqual({
    status: 1,
    stdout: "",
    stderr: `ccplaytime: ${recordPath} is not a valid ccplaytime record; fix or remove it\n`,
    record: "{",
  });
});

it("reports no activity for an empty Claude directory without writing a record", () => {
  const dir = emptyDir();
  expect({
    card: run(dir),
    json: run(dir, "--json"),
    saved: existsSync(join(dir, "ccplaytime.json")),
  }).toEqual({
    card: { status: 0, stdout: `No Claude Code activity found in ${dir}\n`, stderr: "" },
    json: {
      status: 0,
      stdout: '{"hoursOnRecord":0,"hoursLastTwoWeeks":0,"onRecordSince":null,"secondsByDay":{}}\n',
      stderr: "",
    },
    saved: false,
  });
});

it("exits cleanly when the reader closes the pipe early", async () => {
  const dir = claudeDir();
  const child = spawn(process.execPath, [CLI, "--json"], {
    env: childEnv({ CLAUDE_CONFIG_DIR: dir, HOME: dir }),
  });
  child.stdout.destroy();
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const status = await new Promise<number | null>((done) => child.on("close", done));
  expect({ status, stderr, saved: existsSync(join(dir, "ccplaytime.json")) }).toEqual({
    status: 0,
    stderr: "",
    saved: true,
  });
});

it("rejects an unknown option by name", () => {
  const { status, stdout, stderr } = run(claudeDir(), "--bogus");
  expect({
    status,
    stdout,
    namesOption: stderr.includes("'--bogus'"),
    showsUsage: stderr.includes("Usage: ccplaytime [--json]"),
  }).toEqual({ status: 2, stdout: "", namesOption: true, showsUsage: true });
});

it("shows usage for --help and the package version for --version", () => {
  const help = run(claudeDir(), "--help");
  expect({ status: help.status, stderr: help.stderr, usage: help.stdout.split("\n")[0] }).toEqual({
    status: 0,
    stderr: "",
    usage: "Usage: ccplaytime [--json]",
  });
  expect(run(claudeDir(), "--version")).toEqual({
    status: 0,
    stdout: `${pkg.version}\n`,
    stderr: "",
  });
});
