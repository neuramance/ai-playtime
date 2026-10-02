import { appendFileSync, existsSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import pkg from "../package.json" with { type: "json" };
import { expect, it } from "vitest";
import {
  CLI,
  COWORK,
  DAY,
  MINUTE,
  at,
  childEnv,
  claudeHome,
  dayKey,
  emptyDir,
  events,
  everyTenMinutes,
  firstRunHint,
  halfHourYesterday,
  iso,
  json,
  onOneUtcDay,
  recordPath,
  rollout,
  run,
  runWith,
  saveRecord,
  utcToday,
  write,
  writeSession,
  yesterdayAt,
} from "./fixtures.ts";

it("measures wall-clock active time across sessions and subagents, skipping idle gaps", () => {
  onOneUtcDay(() => {
    const { status, stdout, stderr } = run(claudeHome(), "--json");
    expect({ status, stderr, json: JSON.parse(stdout) as unknown }).toEqual({
      status: 0,
      stderr: "",
      json: halfHourYesterday(),
    });
  });
});

it("reads ~/.claude when CLAUDE_CONFIG_DIR is blank", () => {
  const home = emptyDir();
  write(home, ".claude/projects/-work/s1.jsonl", yesterdayAt(0, 15, 30));
  const { stdout } = runWith({ HOME: home, CLAUDE_CONFIG_DIR: " " }, "--json");
  expect(JSON.parse(stdout)).toMatchObject({ hoursOnRecord: 0.5 });
});

it("counts Codex rollouts, giving desktop-app sessions to the ChatGPT app", () => {
  const home = emptyDir();
  const day = ".codex/sessions/2025/07/01";
  const lateLine = '{"type":"event_msg","timestamp":"2025-07-01T10:40:00.000Z"}\n';
  const cut = '{"timestamp":"2025-07-01T05:45:00.';
  const cli = rollout("codex-tui", everyTenMinutes("2025-07-01T10:00:00Z", 30));
  write(home, `${day}/rollout-2025-07-01T10-00-00-a.jsonl`, cli + lateLine + cut);
  write(
    home,
    ".codex/archived_sessions/rollout-2025-07-01T11-00-00-b.jsonl",
    rollout("Codex Desktop", everyTenMinutes("2025-07-01T11:00:00Z", 60)),
  );
  write(
    home,
    `${day}/rollout-2025-07-01T13-00-00-c.jsonl.zst`,
    zstdCompressSync(rollout("codex_work_desktop", everyTenMinutes("2025-07-01T13:00:00Z", 30))),
  );
  write(
    home,
    `${day}/notes.jsonl`,
    rollout("codex-tui", everyTenMinutes("2025-07-01T15:00:00Z", 60)),
  );
  const { stdout } = runWith({ HOME: home, TZ: "Etc/GMT+5" }, "--json");
  expect(JSON.parse(stdout)).toMatchObject({
    hoursOnRecord: 2.17,
    since: "2025-07-01",
    apps: [
      { app: "ChatGPT app", hours: 1.5, secondsByDay: { "2025-07-01": 5400 } },
      { app: "Codex", hours: 0.67, secondsByDay: { "2025-07-01": 2400 } },
    ],
  });
});

it("reads CODEX_HOME and saves under XDG_DATA_HOME when they are set", () => {
  const home = emptyDir();
  const codex = emptyDir();
  const data = emptyDir();
  const session = rollout("codex-tui", everyTenMinutes("2025-07-01T10:00:00Z", 30));
  write(codex, "sessions/rollout-a.jsonl", session);
  const result = runWith({ HOME: home, CODEX_HOME: codex, XDG_DATA_HOME: data }, "--json");
  expect({
    json: JSON.parse(result.stdout) as unknown,
    saved: existsSync(join(data, "ai-playtime/record.json")),
  }).toMatchObject({ json: { hoursOnRecord: 0.5 }, saved: true });
});

it("gives desktop Code-tab and Cowork transcripts to the Claude app", () => {
  const home = emptyDir();
  const claude = join(home, ".claude");
  writeSession(claude, "-work/desk", "09:00", 30, "claude-desktop");
  writeSession(claude, "-work/cli", "10:00", 30, "cli");
  const cowork = `${COWORK}/acct/org/local_1`;
  write(
    home,
    `${cowork}/.claude/projects/-work/s.jsonl`,
    events(everyTenMinutes("2025-07-01T14:00:00Z", 60), "local-agent"),
  );
  write(home, `${cowork}/audit.jsonl`, events(everyTenMinutes("2025-07-01T16:00:00Z", 60)));
  expect(json(home)).toMatchObject({
    hoursOnRecord: 2,
    apps: [
      { app: "Claude app", hours: 1.5 },
      { app: "Claude Code", hours: 0.5 },
    ],
  });
});

it("splits a session continued from the terminal into the desktop app", () => {
  onOneUtcDay(() => {
    const today = utcToday();
    const home = emptyDir();
    const session = ".claude/projects/-work/s1.jsonl";
    const start = today + 10 * 60 * MINUTE;
    write(home, session, events([start, start + 10 * MINUTE], "cli"));
    run(home, "--json");
    const desktop = events([start + 20 * MINUTE], "claude-desktop") + events([start + 30 * MINUTE]);
    appendFileSync(join(home, session), desktop);
    expect(json(home)).toMatchObject({
      hoursOnRecord: 0.34,
      apps: [
        { app: "Claude Code", secondsByDay: { [dayKey(today)]: 600 } },
        { app: "Claude app", secondsByDay: { [dayKey(today)]: 600 } },
      ],
    });
  });
});

it("reads log lines that contain Unicode line separators", () => {
  const home = emptyDir();
  const [start, middle, end] = everyTenMinutes("2025-07-01T10:00:00Z", 20);
  const separated = { timestamp: iso(middle ?? 0), note: "a\u2028b\u2029c" };
  write(
    home,
    ".claude/projects/-work/s1.jsonl",
    `${events([start ?? 0])}${JSON.stringify(separated)}\n${events([end ?? 0])}`,
  );
  const meta = {
    timestamp: iso(start ?? 0),
    type: "session_meta",
    payload: { originator: "Codex Desktop", cwd: "/work\u2028space" },
  };
  write(
    home,
    ".codex/sessions/rollout-a.jsonl",
    `${JSON.stringify(meta)}\n${events([middle ?? 0, end ?? 0])}`,
  );
  expect(json(home)).toMatchObject({
    apps: [
      { app: "Claude Code", secondsByDay: { "2025-07-01": 1200 } },
      { app: "ChatGPT app", secondsByDay: { "2025-07-01": 1200 } },
    ],
  });
});

it("names the file it could not read", () => {
  const home = emptyDir();
  const broken = write(home, ".codex/sessions/rollout-a.jsonl.zst", "not zstd");
  const { status, stderr } = run(home);
  expect({
    status,
    namesFile: stderr.startsWith(`ai-playtime: could not read ${broken}: `),
  }).toEqual({
    status: 1,
    namesFile: true,
  });
});

it("adds up each app's time even when apps run at the same time", () => {
  const home = emptyDir();
  writeSession(join(home, ".claude"), "-work/cli", "10:00", 30, "cli");
  const session = rollout("codex-tui", everyTenMinutes("2025-07-01T10:00:00Z", 30));
  write(home, ".codex/sessions/rollout-a.jsonl", session);
  expect(json(home)).toMatchObject({
    hoursOnRecord: 1,
    apps: [
      { app: "Claude Code", hours: 0.5 },
      { app: "Codex", hours: 0.5 },
    ],
  });
});

it("keeps the record after Claude Code deletes the transcripts", () => {
  onOneUtcDay(() => {
    const home = claudeHome();
    run(home, "--json");
    rmSync(join(home, ".claude/projects"), { recursive: true });
    expect(json(home)).toEqual(halfHourYesterday());
  });
});

it("counts activity added after the previous run", () => {
  onOneUtcDay(() => {
    const today = utcToday();
    const home = claudeHome();
    run(home, "--json");
    appendFileSync(
      join(home, ".claude/projects/-work/s1.jsonl"),
      events([today + 60 * MINUTE, today + 70 * MINUTE]),
    );
    expect(json(home)).toMatchObject({
      apps: [{ secondsByDay: { [dayKey(today - DAY)]: 1800, [dayKey(today)]: 600 } }],
    });
  });
});

it("keeps saved days that the rescan window only partly covers", () => {
  onOneUtcDay(() => {
    const today = utcToday();
    const home = emptyDir();
    const early = today - 3 * DAY;
    saveRecord(home, today - DAY + 12 * 60 * MINUTE, {
      [dayKey(early)]: 420,
      [dayKey(early + DAY)]: 360,
    });
    write(
      home,
      ".claude/projects/-work/s1.jsonl",
      events([
        early + DAY - 5 * MINUTE,
        early + DAY + 8 * MINUTE,
        today + 60 * MINUTE,
        today + 70 * MINUTE,
      ]),
    );
    const untouched = write(
      home,
      ".claude/projects/-work/s2.jsonl",
      events([early + DAY + 2 * MINUTE]),
    );
    utimesSync(untouched, new Date(early + DAY + 3 * MINUTE), new Date(early + DAY + 3 * MINUTE));
    expect(json(home)).toMatchObject({
      apps: [
        {
          secondsByDay: { [dayKey(early)]: 420, [dayKey(early + DAY)]: 360, [dayKey(today)]: 600 },
        },
      ],
    });
  });
});

it("prints a Steam-style card and explains the saved record on the first run", () => {
  const home = emptyDir();
  write(
    home,
    ".claude/projects/-work/s1.jsonl",
    events([at("2025-06-23T10:00:00Z"), at("2025-06-23T10:15:00Z"), at("2025-06-23T10:30:00Z")]),
  );
  expect(run(home)).toEqual({
    status: 0,
    stderr: "",
    stdout: [
      "",
      "  ▶ AI Playtime",
      "    0.5 hrs on record",
      "    0.0 hrs last two weeks  ··············",
      "    Claude Code 0.5",
      "    since 23 Jun 2025",
      "",
      ...firstRunHint(home),
    ].join("\n"),
  });
});

it("adds scanned days to a saved record and scales the sparkline to the busiest day", () => {
  onOneUtcDay(() => {
    const today = utcToday();
    const home = claudeHome();
    saveRecord(home, at("2025-06-24T00:00:00Z"), {
      "2025-06-23": 5400,
      [dayKey(today - 3 * DAY)]: 3600,
    });
    expect(run(home).stdout).toBe(
      [
        "",
        "  ▶ AI Playtime",
        "    3.0 hrs on record",
        "    1.5 hrs last two weeks  ··········█·▄·",
        "    Claude Code 3.0",
        "    since 23 Jun 2025",
        "",
      ].join("\n"),
    );
  });
});

it("keeps the previous record as a backup", () => {
  const home = claudeHome();
  run(home, "--json");
  const first = readFileSync(recordPath(home), "utf8");
  run(home, "--json");
  expect(readFileSync(`${recordPath(home)}.bak`, "utf8")).toBe(first);
});

it("ignores a relative XDG_DATA_HOME", () => {
  const home = claudeHome();
  runWith({ HOME: home, XDG_DATA_HOME: "relative" }, "--json");
  expect({
    saved: existsSync(recordPath(home)),
    stray: existsSync(join(home, "relative")),
  }).toEqual({ saved: true, stray: false });
});

it("refuses to overwrite a corrupt record", () => {
  const home = claudeHome();
  write(home, ".local/share/ai-playtime/record.json", "{");
  expect({ ...run(home), record: readFileSync(recordPath(home), "utf8") }).toEqual({
    status: 1,
    stdout: "",
    stderr: `ai-playtime: ${recordPath(home)} is not a valid AI Playtime record; restore ${recordPath(home)}.bak or remove it\n`,
    record: "{",
  });
});

it("rejects a record holding a day without time", () => {
  const home = claudeHome();
  saveRecord(home, at("2025-06-24T00:00:00Z"), { "2025-06-23": 0 });
  expect(run(home)).toEqual({
    status: 1,
    stdout: "",
    stderr: `ai-playtime: ${recordPath(home)} is not a valid AI Playtime record; restore ${recordPath(home)}.bak or remove it\n`,
  });
});

it("reports no activity without writing a record", () => {
  const home = emptyDir();
  expect({
    card: run(home),
    json: run(home, "--json"),
    saved: existsSync(recordPath(home)),
  }).toEqual({
    card: {
      status: 0,
      stdout: "No Claude Code, Codex, ChatGPT app or Claude app activity found\n",
      stderr: "",
    },
    json: {
      status: 0,
      stdout:
        '{"hoursOnRecord":0,"hoursMeasured":0,"hoursEstimated":0,"hoursLastTwoWeeks":0,"since":null,"tokensOnRecord":0,"usdOnRecord":0,"tokensLastTwoWeeks":0,"usdLastTwoWeeks":0,"tokensSince":null,"unpricedModels":[],"apps":[]}\n',
      stderr: "",
    },
    saved: false,
  });
});

it("exits cleanly when the reader closes the pipe early", async () => {
  const home = claudeHome();
  const child = spawn(process.execPath, [CLI, "--json"], { env: childEnv({ HOME: home }) });
  child.stdout.destroy();
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const status = await new Promise<number | null>((done) => child.on("close", done));
  expect({ status, stderr, saved: existsSync(recordPath(home)) }).toEqual({
    status: 0,
    stderr: "",
    saved: true,
  });
});

it("rejects an unknown option by name", () => {
  const { status, stdout, stderr } = run(claudeHome(), "--bogus");
  expect({
    status,
    stdout,
    namesOption: stderr.includes("'--bogus'"),
    showsUsage: stderr.includes("Usage: ai-playtime [--json]"),
  }).toEqual({ status: 2, stdout: "", namesOption: true, showsUsage: true });
});

it("shows usage for --help and the package version for --version", () => {
  const help = run(claudeHome(), "--help");
  expect({ status: help.status, stderr: help.stderr, usage: help.stdout.split("\n")[0] }).toEqual({
    status: 0,
    stderr: "",
    usage: "Usage: ai-playtime [--json]",
  });
  expect(run(claudeHome(), "--version")).toEqual({
    status: 0,
    stdout: `${pkg.version}\n`,
    stderr: "",
  });
});
