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
const events = (times: number[], entrypoint?: string) =>
  times
    .map((t) => `${JSON.stringify({ timestamp: new Date(t).toISOString(), entrypoint })}\n`)
    .join("");
const yesterdayAt = (...minutes: number[]) =>
  events(minutes.map((m) => today - DAY + 10 * 60 * MINUTE + m * MINUTE));

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
  const record = {
    version: 1,
    scannedAt: new Date(scannedAt).toISOString(),
    secondsByDay,
    earlier: null,
  };
  write(dir, "ccplaytime.json", JSON.stringify(record));
}

const at = (iso: string) => Date.parse(iso);
const everyTenMinutes = (from: string, minutes: number) =>
  Array.from({ length: minutes / 10 + 1 }, (_, i) => at(from) + i * 10 * MINUTE);
const launches = (numStartups: number, firstStartTime = "2025-06-23T09:00:00.000Z") =>
  JSON.stringify({ numStartups, firstStartTime, theme: "dark" });

function writeSession(
  claude: string,
  name: string,
  from: string,
  minutes: number,
  entrypoint?: string,
) {
  write(
    claude,
    `projects/${name}.jsonl`,
    events(everyTenMinutes(`2025-07-01T${from}:00Z`, minutes), entrypoint),
  );
}

function writeOtherSessions(claude: string) {
  for (const hour of [5, 6, 7, 8, 9, 10, 11, 12]) {
    writeSession(
      claude,
      `-work/s${String(hour - 2)}`,
      `${String(hour).padStart(2, "0")}:00`,
      30,
      "cli",
    );
  }
  writeSession(claude, "-batch/print", "13:00", 30, "sdk-cli");
  writeSession(claude, "-ide/vscode", "14:00", 30, "claude-vscode");
  writeSession(claude, "-old/unmarked", "15:00", 30);
}

function writeHistory(claude: string, config: string, configText = launches(110)) {
  writeSession(claude, "-work/s1", "00:00", 180, "cli");
  write(
    claude,
    "projects/-work/s1/subagents/agent-a.jsonl",
    events([at("2025-07-01T01:05:00Z")], "cli"),
  );
  writeSession(claude, "-work/s2", "03:30", 60, "cli");
  writeOtherSessions(claude);
  writeFileSync(config, configText);
}

function historyDir(configText?: string): string {
  const dir = emptyDir();
  writeHistory(dir, join(dir, ".claude.json"), configText);
  return dir;
}

const wholeHistory = {
  hoursOnRecord: 72.75,
  hoursMeasured: 9.5,
  hoursEstimated: 63.25,
  hoursEstimatedRange: [50, 80],
  hoursLastTwoWeeks: 0,
  playingSince: "2025-06-23",
  measuredSince: "2025-07-01",
  earlierLaunches: 100,
  secondsByDay: { "2025-07-01": 34_200 },
};

function childEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  delete env.CLAUDE_CONFIG_DIR;
  return { ...env, ...overrides };
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
  runWith({ CLAUDE_CONFIG_DIR: dir, HOME: emptyDir() }, ...args);
const json = (dir: string) => JSON.parse(run(dir, "--json").stdout) as unknown;

const halfHourYesterday = {
  hoursOnRecord: 0.5,
  hoursMeasured: 0.5,
  hoursEstimated: 0,
  hoursEstimatedRange: null,
  hoursLastTwoWeeks: 0.5,
  playingSince: dayKey(today - DAY),
  measuredSince: dayKey(today - DAY),
  earlierLaunches: 0,
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

it("estimates earlier terminal launches between the typical and the average measured session", () => {
  expect(json(historyDir())).toEqual(wholeHistory);
});

it("reads ~/.claude.json for launch history when CLAUDE_CONFIG_DIR is unset", () => {
  const home = emptyDir();
  writeHistory(join(home, ".claude"), join(home, ".claude.json"));
  expect(JSON.parse(runWith({ HOME: home }, "--json").stdout)).toEqual(wholeHistory);
});

it("prefers Claude Code's legacy .config.json when it exists", () => {
  const dir = historyDir(launches(999));
  write(dir, ".config.json", launches(110));
  expect(json(dir)).toEqual(wholeHistory);
});

it("keeps the first estimate after transcripts are deleted and launches grow", () => {
  const dir = historyDir();
  run(dir, "--json");
  rmSync(join(dir, "projects"), { recursive: true });
  writeFileSync(join(dir, ".claude.json"), launches(500));
  expect(json(dir)).toEqual(wholeHistory);
});

it("waits for 10 measured sessions, then estimates the launches counted on the first run", () => {
  const dir = emptyDir();
  writeSession(dir, "-work/s1", "00:00", 180, "cli");
  writeSession(dir, "-work/s2", "03:30", 60, "cli");
  write(dir, ".claude.json", launches(50));
  expect(run(dir).stdout).toBe(
    [
      "",
      "  ▶ Claude Code",
      "    4.0 hrs on record",
      "    0.0 hrs last two weeks  ··············",
      "    playing since 23 Jun 2025, measured since 1 Jul 2025",
      "    48 earlier launches, estimated once 10 sessions are measured",
      "",
      `  Saved to ${join(dir, "ccplaytime.json")}. Claude Code deletes transcripts after 30 days,`,
      "  so run ccplaytime at least that often to keep your record complete.",
      "",
    ].join("\n"),
  );
  writeOtherSessions(dir);
  expect(json(dir)).toMatchObject({
    hoursOnRecord: 39.86,
    hoursMeasured: 9.5,
    hoursEstimated: 30.36,
    hoursEstimatedRange: [24, 38.4],
    earlierLaunches: 48,
  });
});

it("names a single earlier launch in the singular", () => {
  const card = run(historyDir(launches(11))).stdout.split("\n");
  expect(card.slice(2, 6)).toEqual([
    "    ~10 hrs on record",
    "    0.0 hrs last two weeks  ··············",
    "    playing since 23 Jun 2025, measured since 1 Jul 2025",
    "    ~1 hrs estimated from 1 earlier launch (1–1)",
  ]);
});

it("estimates nothing when Claude Code was first started on the first measured day", () => {
  expect(json(historyDir(launches(110, "2025-07-01T00:00:00.000Z")))).toEqual({
    ...wholeHistory,
    hoursOnRecord: 9.5,
    hoursEstimated: 0,
    hoursEstimatedRange: null,
    playingSince: "2025-07-01",
    earlierLaunches: 0,
  });
});

it("refuses to guess from unreadable Claude Code configuration", () => {
  const dir = historyDir("{");
  expect({ ...run(dir), saved: existsSync(join(dir, "ccplaytime.json")) }).toEqual({
    status: 1,
    stdout: "",
    stderr: `ccplaytime: ${join(dir, ".claude.json")} is not valid Claude Code configuration\n`,
    saved: false,
  });
});

it("shows whole history on the card, split into measured and estimated", () => {
  const dir = historyDir();
  expect(run(dir).stdout).toBe(
    [
      "",
      "  ▶ Claude Code",
      "    ~73 hrs on record",
      "    0.0 hrs last two weeks  ··············",
      "    playing since 23 Jun 2025, measured since 1 Jul 2025",
      "    ~63 hrs estimated from 100 earlier launches (50–80)",
      "",
      `  Saved to ${join(dir, "ccplaytime.json")}. Claude Code deletes transcripts after 30 days,`,
      "  so run ccplaytime at least that often to keep your record complete.",
      "",
    ].join("\n"),
  );
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
    events([today + 60 * MINUTE, today + 70 * MINUTE]),
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
    events([
      early + DAY - 5 * MINUTE,
      early + DAY + 8 * MINUTE,
      today + 60 * MINUTE,
      today + 70 * MINUTE,
    ]),
  );
  const untouched = write(dir, "projects/-work/s2.jsonl", events([early + DAY + 2 * MINUTE]));
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
    events([at("2025-06-23T10:00:00Z"), at("2025-06-23T10:15:00Z"), at("2025-06-23T10:30:00Z")]),
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
      stdout:
        '{"hoursOnRecord":0,"hoursMeasured":0,"hoursEstimated":0,"hoursEstimatedRange":null,"hoursLastTwoWeeks":0,"playingSince":null,"measuredSince":null,"earlierLaunches":0,"secondsByDay":{}}\n',
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
