import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { onTestFinished } from "vitest";

export const CLI = join(import.meta.dirname, "cli.ts");
export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
export const COWORK = "Library/Application Support/Claude/local-agent-mode-sessions";

export const today = Math.floor(Date.now() / DAY) * DAY;
export const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const iso = (ms: number) => new Date(ms).toISOString();
export const at = (text: string) => Date.parse(text);
export const events = (times: number[], entrypoint?: string) =>
  times.map((t) => `${JSON.stringify({ timestamp: iso(t), entrypoint })}\n`).join("");
export const yesterdayAt = (...minutes: number[]) =>
  events(minutes.map((m) => today - DAY + 10 * 60 * MINUTE + m * MINUTE));
export const everyTenMinutes = (from: string, minutes: number) =>
  Array.from({ length: minutes / 10 + 1 }, (_, i) => at(from) + i * 10 * MINUTE);
export const launches = (numStartups: number, firstStartTime = "2025-06-23T09:00:00.000Z") =>
  JSON.stringify({ numStartups, firstStartTime, theme: "dark" });
export const rollout = (originator: string, times: number[]) =>
  [
    { timestamp: iso(times[0] ?? 0), type: "session_meta", payload: { originator } },
    ...times.slice(1).map((t) => ({ timestamp: iso(t), type: "event_msg", payload: {} })),
  ]
    .map((line) => `${JSON.stringify(line)}\n`)
    .join("");

export function emptyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), `ai-playtime-${String(process.pid)}-`));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

export function write(dir: string, path: string, text: string | Buffer): string {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
  return join(dir, path);
}

export const recordPath = (home: string) => join(home, ".local/share/ai-playtime/record.json");

export function saveRecord(
  home: string,
  scannedAt: number,
  claudeCode: Record<string, number>,
): void {
  const record = {
    version: 1,
    scannedAt: iso(scannedAt),
    apps: { "claude-code": claudeCode },
    earlier: null,
  };
  write(home, ".local/share/ai-playtime/record.json", JSON.stringify(record));
}

export function claudeHome(): string {
  const home = emptyDir();
  write(
    home,
    ".claude/projects/-work/s1.jsonl",
    `${yesterdayAt(0, 10)}not json {\n{"type":"summary"}\n${yesterdayAt(20, 60)}`,
  );
  write(home, ".claude/projects/-work/s1/subagents/agent-a.jsonl", yesterdayAt(15, 30));
  return home;
}

export function writeSession(
  claude: string,
  name: string,
  from: string,
  minutes: number,
  entry?: string,
) {
  const times = everyTenMinutes(`2025-07-01T${from}:00Z`, minutes);
  write(claude, `projects/${name}.jsonl`, events(times, entry));
}

export function writeOtherSessions(claude: string) {
  for (const hour of [5, 6, 7, 8, 9, 10, 11, 12]) {
    const from = `${String(hour).padStart(2, "0")}:00`;
    writeSession(claude, `-work/s${String(hour - 2)}`, from, 30, "cli");
  }
  writeSession(claude, "-batch/print", "13:00", 30, "sdk-cli");
  writeSession(claude, "-ide/vscode", "14:00", 30, "claude-vscode");
  writeSession(claude, "-old/unmarked", "15:00", 30);
}

export function writeHistory(claude: string) {
  writeSession(claude, "-work/s1", "00:00", 180, "cli");
  const subagent = events([at("2025-07-01T01:05:00Z")], "cli");
  write(claude, "projects/-work/s1/subagents/agent-a.jsonl", subagent);
  writeSession(claude, "-work/s2", "03:30", 60, "cli");
  writeOtherSessions(claude);
}

export function historyHome(config = launches(110)): string {
  const home = emptyDir();
  writeHistory(join(home, ".claude"));
  write(home, ".claude.json", config);
  return home;
}

const CLEARED = new Set(["FORCE_COLOR", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_DATA_HOME"]);

export function childEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(([name]) => !CLEARED.has(name));
  return { ...Object.fromEntries(inherited), NO_COLOR: "1", ...overrides };
}

export function runWith(overrides: NodeJS.ProcessEnv, ...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: childEnv(overrides),
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export const run = (home: string, ...args: string[]) => runWith({ HOME: home }, ...args);
export const json = (home: string) => JSON.parse(run(home, "--json").stdout) as unknown;
export const firstRunHint = (home: string) => [
  `  Saved to ${recordPath(home)}. Claude Code deletes transcripts after 30 days,`,
  "  so run ai-playtime at least that often to keep your record complete.",
  "",
];

export const unestimated = { hoursEstimated: 0, hoursEstimatedRange: null, earlierLaunches: 0 };

export const halfHourYesterday = {
  hoursOnRecord: 0.5,
  hoursMeasured: 0.5,
  hoursEstimated: 0,
  hoursLastTwoWeeks: 0.5,
  since: dayKey(today - DAY),
  apps: [
    {
      app: "Claude Code",
      ...unestimated,
      hours: 0.5,
      hoursMeasured: 0.5,
      hoursLastTwoWeeks: 0.5,
      secondsByDay: { [dayKey(today - DAY)]: 1800 },
    },
  ],
};

export const wholeHistory = {
  hoursOnRecord: 72.75,
  hoursMeasured: 9.5,
  hoursEstimated: 63.25,
  hoursLastTwoWeeks: 0,
  since: "2025-06-23",
  apps: [
    {
      app: "Claude Code",
      hours: 72.75,
      hoursMeasured: 9.5,
      hoursEstimated: 63.25,
      hoursEstimatedRange: [50, 80],
      earlierLaunches: 100,
      hoursLastTwoWeeks: 0,
      secondsByDay: { "2025-07-01": 34_200 },
    },
  ],
};
