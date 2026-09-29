#!/usr/bin/env node
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs, styleText } from "node:util";
import * as z from "zod/mini";
import pkg from "../package.json" with { type: "json" };
import {
  claudePaths,
  loadLaunches,
  parseJson,
  readIfPresent,
  scanSessions,
  type ClaudePaths,
  type Session,
} from "./claude.ts";
import {
  activeSeconds,
  activeSecondsByDay,
  CALIBRATION_SESSIONS,
  calibrate,
  countEarlier,
  IDLE_LIMIT_MS,
  mergeRecord,
  midpoint,
  rescanFrom,
  summarize,
  type Earlier,
  type SecondsByDay,
  type Summary,
} from "./playtime.ts";

const USAGE = `Usage: ccplaytime [--json]

Steam-style hours played for Claude Code.

Counts wall-clock time any Claude Code session was active, merging parallel
sessions and subagents. Gaps over ${String(IDLE_LIMIT_MS / 60_000)} minutes count as idle.

Each run saves daily (UTC) totals to $CLAUDE_CONFIG_DIR/ccplaytime.json (default
~/.claude), so your record outlives Claude Code's 30-day transcript cleanup.

Time before your oldest transcript is estimated from Claude Code's count of
terminal launches, once ${String(CALIBRATION_SESSIONS)} sessions are measured: between your typical
(median) and average session, shown with its range.

Options:
  --json         print machine-readable output
  -h, --help     show this help
  -v, --version  show version`;

const Count = z.int().check(z.nonnegative());
const RecordFile = z.object({
  version: z.literal(1),
  scannedAt: z.iso.datetime(),
  secondsByDay: z.record(z.iso.date(), Count),
  earlier: z.nullable(
    z.object({
      since: z.iso.date(),
      launches: Count,
      bounds: z.nullable(z.object({ lowSeconds: Count, highSeconds: Count })),
    }),
  ),
});
const NO_ACTIVITY_JSON = {
  hoursOnRecord: 0,
  hoursMeasured: 0,
  hoursEstimated: 0,
  hoursEstimatedRange: null,
  hoursLastTwoWeeks: 0,
  playingSince: null,
  measuredSince: null,
  earlierLaunches: 0,
  secondsByDay: {},
};
const BARS = "▁▂▃▄▅▆▇█";
const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";

interface SavedRecord {
  scannedAt: number;
  secondsByDay: SecondsByDay;
  earlier: Earlier | null;
}

interface Tracked {
  record: SecondsByDay;
  summary: Summary;
  earlier: Earlier | null;
  newRecordPath: string | undefined;
}

async function loadRecord(path: string): Promise<SavedRecord | undefined> {
  const text = await readIfPresent(path);
  if (text === undefined) return undefined;
  const parsed = RecordFile.safeParse(parseJson(text));
  if (!parsed.success)
    throw new Error(`${path} is not a valid ccplaytime record; fix or remove it`);
  const { scannedAt, secondsByDay, earlier } = parsed.data;
  return { scannedAt: Date.parse(scannedAt), secondsByDay, earlier };
}

async function saveRecord(path: string, record: SavedRecord): Promise<void> {
  const temp = `${path}.${String(process.pid)}.tmp`;
  const json = { version: 1, ...record, scannedAt: new Date(record.scannedAt).toISOString() };
  await writeFile(temp, `${JSON.stringify(json, null, 2)}\n`);
  await rename(temp, path);
}

async function countLaunches(paths: ClaudePaths, sessions: number, summary: Summary) {
  const launches = await loadLaunches(paths.configs);
  return launches === undefined ? null : countEarlier(launches, sessions, summary.measuredSince);
}

async function estimate(
  paths: ClaudePaths,
  sessions: Session[],
  summary: Summary,
  saved: SavedRecord | undefined,
): Promise<Earlier | null> {
  const interactive = sessions.filter((session) => session.interactive);
  const earlier =
    saved === undefined ? await countLaunches(paths, interactive.length, summary) : saved.earlier;
  if (earlier === null) return null;
  const calibration = {
    sessionSeconds: interactive.map((session) => activeSeconds(session.timestamps)),
    wallSeconds: activeSeconds(interactive.flatMap((session) => session.timestamps)),
  };
  return { ...earlier, bounds: calibrate(earlier.launches, calibration) };
}

async function track(paths: ClaudePaths, now: number): Promise<Tracked | undefined> {
  const recordPath = join(paths.dir, "ccplaytime.json");
  const saved = await loadRecord(recordPath);
  const calibrating = saved === undefined || saved.earlier?.bounds === null;
  const since = calibrating ? 0 : rescanFrom(saved.scannedAt, now);
  const sessions = await scanSessions(paths.projects, since);
  const scanned = activeSecondsByDay(sessions.flatMap((session) => session.timestamps));
  const record = mergeRecord(saved?.secondsByDay ?? {}, scanned);
  const summary = summarize(record, now);
  if (summary === undefined) return undefined;
  const earlier = calibrating ? await estimate(paths, sessions, summary, saved) : saved.earlier;
  await saveRecord(recordPath, { scannedAt: now, secondsByDay: record, earlier });
  return { record, summary, earlier, newRecordPath: saved === undefined ? recordPath : undefined };
}

function hours(seconds: number): string {
  return (seconds / 3600).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function wholeHours(seconds: number): string {
  return Math.round(seconds / 3600).toLocaleString("en-US");
}

function sparkline(values: readonly number[]): string {
  const peak = Math.max(...values);
  return values
    .map((v) => (v === 0 ? "·" : BARS.charAt(Math.ceil((v / peak) * BARS.length) - 1)))
    .join("");
}

function longDate(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const month = date.getUTCMonth() * 3;
  return `${String(date.getUTCDate())} ${MONTHS.slice(month, month + 3)} ${String(date.getUTCFullYear())}`;
}

function estimatedSeconds(earlier: Earlier | null): number {
  return earlier?.bounds ? midpoint(earlier.bounds) : 0;
}

function launchCount(launches: number): string {
  return `${launches.toLocaleString("en-US")} earlier launch${launches === 1 ? "" : "es"}`;
}

function historyLines(summary: Summary, earlier: Earlier | null): string[] {
  const measuredSince = longDate(summary.measuredSince);
  if (earlier === null) return [`on record since ${measuredSince}`];
  const { bounds } = earlier;
  const estimated =
    bounds === null
      ? `${launchCount(earlier.launches)}, estimated once ${String(CALIBRATION_SESSIONS)} sessions are measured`
      : `~${wholeHours(midpoint(bounds))} hrs estimated from ${launchCount(earlier.launches)} (${wholeHours(bounds.lowSeconds)}–${wholeHours(bounds.highSeconds)})`;
  return [`playing since ${longDate(earlier.since)}, measured since ${measuredSince}`, estimated];
}

function render({ summary, earlier, newRecordPath }: Tracked): string {
  const accent = (text: string) => styleText(["bold", "yellow"], text);
  const estimated = estimatedSeconds(earlier);
  const total =
    estimated === 0
      ? hours(summary.secondsMeasured)
      : `~${wholeHours(summary.secondsMeasured + estimated)}`;
  const lines = [
    "",
    `  ${styleText("yellow", "▶")} ${styleText("bold", "Claude Code")}`,
    `    ${accent(total)} hrs on record`,
    `    ${accent(hours(summary.secondsLastTwoWeeks))} hrs last two weeks  ${styleText("yellow", sparkline(summary.lastTwoWeeks))}`,
    ...historyLines(summary, earlier).map((line) => styleText("dim", `    ${line}`)),
    "",
  ];
  if (newRecordPath !== undefined) {
    lines.push(
      styleText(
        "dim",
        `  Saved to ${newRecordPath}. Claude Code deletes transcripts after 30 days,\n  so run ccplaytime at least that often to keep your record complete.`,
      ),
      "",
    );
  }
  return lines.join("\n");
}

function toJson({ record, summary, earlier }: Tracked): string {
  const toHours = (seconds: number) => Math.round(seconds / 36) / 100;
  const measured = toHours(summary.secondsMeasured);
  const estimated = toHours(estimatedSeconds(earlier));
  const bounds = earlier?.bounds ?? null;
  const json = {
    hoursOnRecord: Math.round((measured + estimated) * 100) / 100,
    hoursMeasured: measured,
    hoursEstimated: estimated,
    hoursEstimatedRange:
      bounds === null ? null : [toHours(bounds.lowSeconds), toHours(bounds.highSeconds)],
    hoursLastTwoWeeks: toHours(summary.secondsLastTwoWeeks),
    playingSince: earlier?.since ?? summary.measuredSince,
    measuredSince: summary.measuredSince,
    earlierLaunches: earlier?.launches ?? 0,
    secondsByDay: record,
  };
  return `${JSON.stringify(json)}\n`;
}

type Command = "help" | "version" | "json" | "card";

function parseCommand(): Command {
  const { values } = parseArgs({
    options: {
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help) return "help";
  if (values.version) return "version";
  return values.json ? "json" : "card";
}

async function main(): Promise<number> {
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
  let command: Command;
  try {
    command = parseCommand();
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    process.stderr.write(`ccplaytime: ${error.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (command === "help" || command === "version") {
    process.stdout.write(`${command === "help" ? USAGE : pkg.version}\n`);
    return 0;
  }
  const paths = claudePaths(process.env);
  const tracked = await track(paths, Date.now());
  if (tracked === undefined) {
    process.stdout.write(
      command === "json"
        ? `${JSON.stringify(NO_ACTIVITY_JSON)}\n`
        : `No Claude Code activity found in ${paths.dir}\n`,
    );
    return 0;
  }
  process.stdout.write(command === "json" ? toJson(tracked) : render(tracked));
  return 0;
}

process.exitCode = await main().catch((error: unknown) => {
  process.stderr.write(`ccplaytime: ${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
});
