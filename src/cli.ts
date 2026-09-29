#!/usr/bin/env node
import { createReadStream, type Dirent } from "node:fs";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs, styleText } from "node:util";
import * as z from "zod/mini";
import pkg from "../package.json" with { type: "json" };
import {
  activeSecondsByDay,
  IDLE_LIMIT_MS,
  mergeRecord,
  rescanFrom,
  summarize,
  type SecondsByDay,
  type Summary,
} from "./playtime.ts";

const USAGE = `Usage: ccplaytime [--json]

Steam-style hours played for Claude Code.

Counts wall-clock time any Claude Code session was active, merging parallel
sessions and subagents. Gaps over ${String(IDLE_LIMIT_MS / 60_000)} minutes count as idle.

Each run saves daily (UTC) totals to $CLAUDE_CONFIG_DIR/ccplaytime.json (default
~/.claude), so your record outlives Claude Code's 30-day transcript cleanup.

Options:
  --json         print machine-readable output
  -h, --help     show this help
  -v, --version  show version`;

const TranscriptEntry = z.object({ timestamp: z.iso.datetime({ offset: true }) });
const RecordFile = z.object({
  version: z.literal(1),
  scannedAt: z.iso.datetime(),
  secondsByDay: z.record(z.iso.date(), z.int().check(z.nonnegative())),
});
const NO_ACTIVITY_JSON = {
  hoursOnRecord: 0,
  hoursLastTwoWeeks: 0,
  onRecordSince: null,
  secondsByDay: {},
};
const BARS = "▁▂▃▄▅▆▇█";
const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";

interface SavedRecord {
  scannedAt: number;
  secondsByDay: SecondsByDay;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function scanFile(path: string, since: number, timestamps: number[]): Promise<void> {
  try {
    if ((await stat(path)).mtimeMs < since) return;
    for await (const line of createInterface({
      input: createReadStream(path),
      crlfDelay: Infinity,
    })) {
      if (!line.includes('"timestamp"')) continue;
      const entry = TranscriptEntry.safeParse(parseJson(line));
      const time = entry.success ? Date.parse(entry.data.timestamp) : Number.NaN;
      if (time >= since) timestamps.push(time);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function scanTimestamps(projectsDir: string, since: number): Promise<number[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(projectsDir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const timestamps: number[] = [];
  for (const file of entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl"))) {
    await scanFile(join(file.parentPath, file.name), since, timestamps);
  }
  return timestamps;
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

async function loadRecord(path: string): Promise<SavedRecord | undefined> {
  const text = await readIfPresent(path);
  if (text === undefined) return undefined;
  const parsed = RecordFile.safeParse(parseJson(text));
  if (!parsed.success)
    throw new Error(`${path} is not a valid ccplaytime record; fix or remove it`);
  return { scannedAt: Date.parse(parsed.data.scannedAt), secondsByDay: parsed.data.secondsByDay };
}

async function saveRecord(path: string, record: SavedRecord): Promise<void> {
  const temp = `${path}.${String(process.pid)}.tmp`;
  const json = {
    version: 1,
    scannedAt: new Date(record.scannedAt).toISOString(),
    secondsByDay: record.secondsByDay,
  };
  await writeFile(temp, `${JSON.stringify(json, null, 2)}\n`);
  await rename(temp, path);
}

function hours(seconds: number): string {
  return (seconds / 3600).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
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

function render(summary: Summary, newRecordPath: string | undefined): string {
  const accent = (text: string) => styleText(["bold", "yellow"], text);
  const lines = [
    "",
    `  ${styleText("yellow", "▶")} ${styleText("bold", "Claude Code")}`,
    `    ${accent(hours(summary.secondsOnRecord))} hrs on record`,
    `    ${accent(hours(summary.secondsLastTwoWeeks))} hrs last two weeks  ${styleText("yellow", sparkline(summary.lastTwoWeeks))}`,
    styleText("dim", `    on record since ${longDate(summary.onRecordSince)}`),
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

function claudeDirectory(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim() ?? "";
  return configured === "" ? join(homedir(), ".claude") : configured;
}

async function track(claudeDir: string, now: number) {
  const recordPath = join(claudeDir, "ccplaytime.json");
  const saved = await loadRecord(recordPath);
  const timestamps = await scanTimestamps(
    join(claudeDir, "projects"),
    rescanFrom(saved?.scannedAt, now),
  );
  const record = mergeRecord(saved?.secondsByDay ?? {}, activeSecondsByDay(timestamps));
  const summary = summarize(record, now);
  if (summary === undefined) return undefined;
  await saveRecord(recordPath, { scannedAt: now, secondsByDay: record });
  return { record, summary, newRecordPath: saved === undefined ? recordPath : undefined };
}

function toJson(record: SecondsByDay, summary: Summary): string {
  const json = {
    hoursOnRecord: Math.round(summary.secondsOnRecord / 36) / 100,
    hoursLastTwoWeeks: Math.round(summary.secondsLastTwoWeeks / 36) / 100,
    onRecordSince: summary.onRecordSince,
    secondsByDay: record,
  };
  return `${JSON.stringify(json)}\n`;
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
  const claudeDir = claudeDirectory();
  const tracked = await track(claudeDir, Date.now());
  if (tracked === undefined) {
    process.stdout.write(
      command === "json"
        ? `${JSON.stringify(NO_ACTIVITY_JSON)}\n`
        : `No Claude Code activity found in ${claudeDir}\n`,
    );
    return 0;
  }
  const { record, summary, newRecordPath } = tracked;
  process.stdout.write(
    command === "json" ? toJson(record, summary) : render(summary, newRecordPath),
  );
  return 0;
}

process.exitCode = await main().catch((error: unknown) => {
  process.stderr.write(`ccplaytime: ${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
});
