import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  DAY,
  MINUTE,
  emptyDir,
  everyTenMinutes,
  firstRunHint,
  historyHome,
  json,
  launches,
  onOneUtcDay,
  recordPath,
  rollout,
  run,
  runWith,
  unestimated,
  utcToday,
  wholeHistory,
  write,
  writeHistory,
  writeOtherSessions,
  writeSession,
} from "./fixtures.ts";

it("reads transcripts and launch history from CLAUDE_CONFIG_DIR when set", () => {
  const home = emptyDir();
  const custom = emptyDir();
  writeHistory(custom);
  write(custom, ".claude.json", launches(110));
  write(home, ".claude.json", launches(999));
  const { stdout } = runWith({ HOME: home, CLAUDE_CONFIG_DIR: custom }, "--json");
  expect(JSON.parse(stdout)).toEqual(wholeHistory);
});

it("estimates earlier terminal launches between the typical and the average measured session", () => {
  expect(json(historyHome())).toEqual(wholeHistory);
});

it("prefers Claude Code's legacy .config.json when it exists", () => {
  const home = historyHome(launches(999));
  write(home, ".claude/.config.json", launches(110));
  expect(json(home)).toEqual(wholeHistory);
});

it("keeps the first estimate after transcripts are deleted and launches grow", () => {
  const home = historyHome();
  run(home, "--json");
  rmSync(join(home, ".claude/projects"), { recursive: true });
  write(home, ".claude.json", launches(500));
  expect(json(home)).toEqual(wholeHistory);
});

it("counts earlier launches on the first run that has Claude Code sessions", () => {
  const home = emptyDir();
  const codex = rollout("codex-tui", everyTenMinutes("2025-07-01T20:00:00Z", 60));
  write(home, ".codex/sessions/rollout-a.jsonl", codex);
  write(home, ".claude.json", launches(110));
  run(home, "--json");
  writeHistory(join(home, ".claude"));
  expect(json(home)).toMatchObject({
    apps: [
      { app: "Claude Code", hours: 72.75, earlierLaunches: 100 },
      { app: "Codex", hours: 1 },
    ],
  });
});

it("waits for 10 terminal sessions on disk, then estimates the launches counted on the first run", () => {
  const home = emptyDir();
  const claude = join(home, ".claude");
  writeSession(claude, "-work/s1", "00:00", 180, "cli");
  writeSession(claude, "-work/s2", "03:30", 60, "cli");
  write(home, ".claude.json", launches(50));
  expect(run(home).stdout).toBe(
    [
      "",
      "  ▶ AI Playtime",
      "    4.0 hrs on record",
      "    0.0 hrs last two weeks  ··············",
      "    Claude Code 4.0",
      "    since 1 Jul 2025 (48 earlier launches; estimate needs 10 sessions on disk)",
      "",
      ...firstRunHint(home),
    ].join("\n"),
  );
  writeOtherSessions(claude);
  expect(json(home)).toMatchObject({
    hoursOnRecord: 39.86,
    hoursMeasured: 9.5,
    hoursEstimated: 30.36,
    apps: [{ hoursEstimatedRange: [24, 38.4], earlierLaunches: 48 }],
  });
});

it("names a single earlier launch in the singular", () => {
  const card = run(historyHome(launches(11))).stdout.split("\n");
  expect(card.slice(2, 6)).toEqual([
    "    ~10 hrs on record",
    "    0.0 hrs last two weeks  ··············",
    "    Claude Code ~10",
    "    since 23 Jun 2025 (~1 hrs estimated from 1 earlier launch)",
  ]);
});

it("estimates nothing when Claude Code was first started on the first measured day", () => {
  expect(json(historyHome(launches(110, "2025-07-01T00:00:00.000Z")))).toEqual({
    ...wholeHistory,
    hoursOnRecord: 9.5,
    hoursEstimated: 0,
    since: "2025-07-01",
    apps: [{ ...wholeHistory.apps[0], ...unestimated, hours: 9.5 }],
  });
});

it("refuses to guess from unreadable Claude Code configuration", () => {
  const home = historyHome("{");
  expect({ ...run(home), saved: existsSync(recordPath(home)) }).toEqual({
    status: 1,
    stdout: "",
    stderr: `ai-playtime: ${join(home, ".claude.json")} is not valid Claude Code configuration\n`,
    saved: false,
  });
});

it("shows every app on one line and a single since date", () => {
  const home = historyHome();
  const session = rollout("Codex Desktop", everyTenMinutes("2025-07-01T20:00:00Z", 60));
  write(home, ".codex/sessions/rollout-a.jsonl", session);
  expect(run(home).stdout).toBe(
    [
      "",
      "  ▶ AI Playtime",
      "    ~74 hrs on record",
      "    0.0 hrs last two weeks  ··············",
      "    Claude Code ~73 · ChatGPT app 1.0",
      "    since 23 Jun 2025 (~63 hrs estimated from 100 earlier launches)",
      "",
      ...firstRunHint(home),
    ].join("\n"),
  );
});

it("formats thousands, faint days and an earlier first day from another app", () => {
  onOneUtcDay(() => {
    const today = utcToday();
    const home = historyHome(launches(2010));
    const codex = (name: string, times: number[]) =>
      write(home, `.codex/sessions/${name}.jsonl`, rollout("codex-tui", times));
    codex("rollout-june", everyTenMinutes("2025-06-01T00:00:00Z", 30));
    codex(
      "rollout-busy",
      Array.from({ length: 13 }, (_, i) => today - 3 * DAY + i * 10 * MINUTE),
    );
    codex("rollout-faint", [today - 2 * DAY, today - 2 * DAY + 10 * MINUTE]);
    expect(run(home).stdout.split("\n").slice(2, 6)).toEqual([
      "    ~1,277 hrs on record",
      "    2.2 hrs last two weeks  ··········█▁··",
      "    Claude Code ~1,274 · Codex 2.7",
      "    since 1 Jun 2025 (~1,265 hrs estimated from 2,000 earlier launches)",
    ]);
  });
});
