#!/usr/bin/env node
import { copyFile, mkdir, open, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parseArgs, styleText } from "node:util";
import * as z from "zod/mini";
import pkg from "../package.json" with { type: "json" };
import {
  claudePaths,
  loadLaunches,
  scanSessions,
  type ClaudePaths,
  type Session,
} from "./claude.ts";
import { codexRoots, scanCodex } from "./codex.ts";
import { isMissing, messageOf, parseJson, readIfPresent } from "./files.ts";
import {
  activeSeconds,
  activeSecondsByDay,
  addDays,
  APPS,
  CALIBRATION_SESSIONS,
  calibrate,
  countEarlier,
  firstRecentDay,
  IDLE_LIMIT_MS,
  mergeRecord,
  midpoint,
  rescanFrom,
  summarize,
  type App,
  type Days,
  type Earlier,
  type SecondsByDay,
  type Summary,
} from "./playtime.ts";
import { mergeUsage, spendOf, type Spend, type UsageByDay } from "./tokens.ts";

const USAGE = `Usage: ai-playtime [--json]

Steam-style hours played across Claude Code, Codex, the ChatGPT app and the Claude app.

Counts wall-clock time each app's sessions were active, merging parallel sessions and
subagents; gaps over ${String(IDLE_LIMIT_MS / 60_000)} minutes count as idle. The total adds up the apps.
Chats in the desktop apps are stored in the cloud, so only their agent sessions count.

Each run saves daily (UTC) totals to $XDG_DATA_HOME/ai-playtime/record.json (default
~/.local/share), so your record outlives Claude Code's 30-day transcript cleanup.

Claude Code time before your oldest transcript is estimated from its count of terminal
launches, once ${String(CALIBRATION_SESSIONS)} terminal sessions are on disk: between your typical
(median) and average session. --json shows the range.

Tokens are what each saved model response reports, cache reads and writes included. Spend
prices them at the first-party API list prices built into this version: what the same usage
would cost on the API, not what a subscription bills. Both are floors: Claude Code leaves
some background requests, such as web searches, out of its transcripts, and Codex logs don't
say which requests ran on the pricier Fast tier, so Codex is priced at standard rates.

Options:
  --json         print machine-readable output
  -h, --help     show this help
  -v, --version  show version`;

const LABELS: Record<App, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  chatgpt: "ChatGPT app",
  claude: "Claude app",
};
const Count = z.int().check(z.nonnegative());
const Seconds = z.int().check(z.positive());
const Tokens = z.object({
  input: Count,
  cacheWrite: Count,
  cacheWrite1h: Count,
  cacheRead: Count,
  output: Count,
});
const RecordFile = z.object({
  version: z.literal(1),
  scannedAt: z.iso.datetime(),
  apps: z.partialRecord(z.enum(APPS), z.record(z.iso.date(), Seconds)),
  earlier: z.nullable(
    z.object({
      since: z.iso.date(),
      launches: Count,
      bounds: z.nullable(z.object({ lowSeconds: Count, highSeconds: Count })),
    }),
  ),
  tokens: z.optional(
    z.partialRecord(z.enum(APPS), z.record(z.iso.date(), z.record(z.string(), Tokens))),
  ),
});
const NO_ACTIVITY_JSON = {
  hoursOnRecord: 0,
  hoursMeasured: 0,
  hoursEstimated: 0,
  hoursLastTwoWeeks: 0,
  since: null,
  tokensOnRecord: 0,
  usdOnRecord: 0,
  tokensLastTwoWeeks: 0,
  usdLastTwoWeeks: 0,
  tokensSince: null,
  unpricedModels: [],
  apps: [],
};
const BARS = "▁▂▃▄▅▆▇█";
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const DOLLARS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";

type TokensByApp = Partial<Record<App, UsageByDay>>;

interface SavedRecord {
  scannedAt: number;
  apps: Days;
  earlier: Earlier | null;
  tokens: TokensByApp | undefined;
}

interface AppTime {
  app: App;
  days: SecondsByDay;
  summary: Summary;
  earlier: Earlier | null;
  usage: UsageByDay;
  spend: Spend;
  recentSpend: Spend;
}

interface Tracked {
  apps: AppTime[];
  total: Summary;
  earlier: Earlier | null;
  spend: Spend;
  newRecordPath: string | undefined;
}

interface Paths {
  record: string;
  claude: ClaudePaths;
  codex: readonly string[];
}

function resolvePaths(env: NodeJS.ProcessEnv): Paths {
  const configured = env.XDG_DATA_HOME?.trim() ?? "";
  const data = isAbsolute(configured) ? configured : join(homedir(), ".local", "share");
  return {
    record: join(data, "ai-playtime", "record.json"),
    claude: claudePaths(env),
    codex: codexRoots(env),
  };
}

async function loadRecord(path: string): Promise<SavedRecord | undefined> {
  const text = await readIfPresent(path);
  if (text === undefined) return undefined;
  const parsed = RecordFile.safeParse(parseJson(text));
  if (!parsed.success) {
    throw new Error(`${path} is not a valid AI Playtime record; restore ${path}.bak or remove it`);
  }
  const { scannedAt, apps, earlier, tokens } = parsed.data;
  return { scannedAt: Date.parse(scannedAt), apps, earlier, tokens };
}

async function backUp(path: string): Promise<void> {
  try {
    await copyFile(path, `${path}.bak`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function saveRecord(path: string, record: SavedRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${String(process.pid)}.tmp`;
  const json = { version: 1, ...record, scannedAt: new Date(record.scannedAt).toISOString() };
  const file = await open(temp, "w");
  try {
    await file.writeFile(`${JSON.stringify(json, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await backUp(path);
  await rename(temp, path);
}

function countsLaunches(saved: SavedRecord | undefined): boolean {
  return saved?.apps["claude-code"] === undefined;
}

function isCalibrating(saved: SavedRecord | undefined): boolean {
  return countsLaunches(saved) || saved?.earlier?.bounds === null;
}

async function estimate(
  claude: ClaudePaths,
  sessions: Session[],
  summary: Summary,
  saved: SavedRecord | undefined,
): Promise<Earlier | null> {
  const terminal = sessions
    .filter((session) => session.interactive)
    .map((session) => session.timestamps["claude-code"]);
  let earlier = saved?.earlier ?? null;
  if (countsLaunches(saved)) {
    const launches = await loadLaunches(claude.configs);
    earlier =
      launches === undefined
        ? null
        : countEarlier(launches, terminal.length, summary.measuredSince);
  }
  if (earlier === null) return null;
  const calibration = {
    sessionSeconds: terminal.map((timestamps) => activeSeconds(timestamps)),
    wallSeconds: activeSeconds(terminal.flat()),
  };
  return { ...earlier, bounds: calibrate(earlier.launches, calibration) };
}

function mergeScan(
  saved: SavedRecord | undefined,
  times: Record<App, number[]>,
  usage: Record<App, UsageByDay>,
) {
  const days: Days = {};
  const tokens: TokensByApp = {};
  for (const app of APPS) {
    const merged = mergeRecord(saved?.apps[app] ?? {}, activeSecondsByDay(times[app]));
    if (Object.keys(merged).length > 0) days[app] = merged;
    const appTokens = mergeUsage(saved?.tokens?.[app] ?? {}, usage[app]);
    if (Object.keys(appTokens).length > 0) tokens[app] = appTokens;
  }
  return { days, tokens };
}

async function scan(paths: Paths, saved: SavedRecord | undefined, now: number) {
  const since = saved?.tokens === undefined ? 0 : rescanFrom(saved.scannedAt, now);
  const [claude, codex] = await Promise.all([
    scanSessions(paths.claude, isCalibrating(saved) ? 0 : since),
    scanCodex(paths.codex, since),
  ]);
  const times: Record<App, number[]> = {
    "claude-code": claude.sessions.flatMap((session) => session.timestamps["claude-code"]),
    codex: codex.times.codex,
    chatgpt: codex.times.chatgpt,
    claude: claude.sessions.flatMap((session) => session.timestamps.claude),
  };
  const merged = mergeScan(saved, times, { ...claude.usage, ...codex.usage });
  return { sessions: claude.sessions, ...merged };
}

function estimatedSeconds(earlier: Earlier | null): number {
  return earlier?.bounds ? midpoint(earlier.bounds) : 0;
}

function secondsOf(time: AppTime): number {
  return time.summary.secondsMeasured + estimatedSeconds(time.earlier);
}

function activeDays(days: SecondsByDay | undefined, usage: UsageByDay | undefined): SecondsByDay {
  const tokenDays = Object.keys(usage ?? {}).map((day): [string, number] => [day, 0]);
  return { ...Object.fromEntries(tokenDays), ...days };
}

async function track(paths: Paths, now: number): Promise<Tracked | undefined> {
  const saved = await loadRecord(paths.record);
  const { sessions, days, tokens } = await scan(paths, saved, now);
  const activity = (app: App) => activeDays(days[app], tokens[app]);
  const total = summarize(addDays(APPS.map(activity)), now);
  if (total === undefined) return undefined;
  const claudeCode = summarize(days["claude-code"] ?? {}, now);
  let earlier = saved?.earlier ?? null;
  if (isCalibrating(saved) && claudeCode !== undefined) {
    earlier = await estimate(paths.claude, sessions, claudeCode, saved);
  }
  await saveRecord(paths.record, { scannedAt: now, apps: days, earlier, tokens });
  const apps = APPS.flatMap((app) => {
    const summary = summarize(activity(app), now);
    if (summary === undefined) return [];
    const usage = tokens[app] ?? {};
    return [
      {
        app,
        days: days[app] ?? {},
        summary,
        earlier: app === "claude-code" ? earlier : null,
        usage,
        spend: spendOf([usage]),
        recentSpend: spendOf([usage], firstRecentDay(now)),
      },
    ];
  }).sort((a, b) => secondsOf(b) - secondsOf(a));
  const spend = spendOf(apps.map((time) => time.usage));
  const newRecordPath = saved === undefined ? paths.record : undefined;
  return { apps, total, earlier, spend, newRecordPath };
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

function played(measured: number, estimated: number): string {
  return estimated === 0 ? hours(measured) : `~${wholeHours(measured + estimated)}`;
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

function sinceDay(total: Summary, earlier: Earlier | null): string {
  return earlier?.bounds && earlier.since < total.measuredSince
    ? earlier.since
    : total.measuredSince;
}

function sinceLine(total: Summary, earlier: Earlier | null): string {
  const date = `since ${longDate(sinceDay(total, earlier))}`;
  if (earlier === null) return date;
  const count = earlier.launches.toLocaleString("en-US");
  const launches = `${count} earlier launch${earlier.launches === 1 ? "" : "es"}`;
  return earlier.bounds === null
    ? `${date} (${launches}; estimate needs ${String(CALIBRATION_SESSIONS)} sessions on disk)`
    : `${date} (~${wholeHours(midpoint(earlier.bounds))} hrs estimated from ${launches})`;
}

function accent(text: string): string {
  return styleText(["bold", "yellow"], text);
}

function spendLine({ tokens, usd, unpricedTokens }: Spend): string[] {
  if (tokens === 0) return [];
  const unpriced = unpricedTokens === 0 ? "" : ` (${COMPACT.format(unpricedTokens)} unpriced)`;
  const worth = `worth ${accent(DOLLARS.format(usd))} at API prices`;
  return [`    ${accent(COMPACT.format(tokens))} tokens on record, ${worth}${unpriced}`];
}

function render({ apps, total, earlier, spend, newRecordPath }: Tracked): string {
  const breakdown = apps
    .map(
      (time) =>
        `${LABELS[time.app]} ${played(time.summary.secondsMeasured, estimatedSeconds(time.earlier))}`,
    )
    .join(" · ");
  const lines = [
    "",
    `  ${styleText("yellow", "▶")} ${styleText("bold", "AI Playtime")}`,
    `    ${accent(played(total.secondsMeasured, estimatedSeconds(earlier)))} hrs on record`,
    `    ${accent(hours(total.secondsLastTwoWeeks))} hrs last two weeks  ${styleText("yellow", sparkline(total.lastTwoWeeks))}`,
    `    ${breakdown}`,
    styleText("dim", `    ${sinceLine(total, earlier)}`),
    ...spendLine(spend),
    "",
  ];
  if (newRecordPath !== undefined) {
    lines.push(
      styleText(
        "dim",
        `  Saved to ${newRecordPath}. Claude Code deletes transcripts after 30 days,\n  so run ai-playtime at least that often to keep your record complete.`,
      ),
      "",
    );
  }
  return lines.join("\n");
}

function toHours(seconds: number): number {
  return Math.round(seconds / 36) / 100;
}

function toCents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

function appJson({ app, days, summary, earlier, usage, spend, recentSpend }: AppTime) {
  const measured = toHours(summary.secondsMeasured);
  const estimated = toHours(estimatedSeconds(earlier));
  const bounds = earlier?.bounds ?? null;
  return {
    app: LABELS[app],
    hours: Math.round((measured + estimated) * 100) / 100,
    hoursMeasured: measured,
    hoursEstimated: estimated,
    hoursEstimatedRange:
      bounds === null ? null : [toHours(bounds.lowSeconds), toHours(bounds.highSeconds)],
    earlierLaunches: earlier?.launches ?? 0,
    hoursLastTwoWeeks: toHours(summary.secondsLastTwoWeeks),
    secondsByDay: days,
    tokens: spend.tokens,
    usd: toCents(spend.usd),
    tokensLastTwoWeeks: recentSpend.tokens,
    usdLastTwoWeeks: toCents(recentSpend.usd),
    usageByDay: usage,
  };
}

type SummedField =
  | "hours"
  | "hoursMeasured"
  | "hoursEstimated"
  | "hoursLastTwoWeeks"
  | "tokens"
  | "usd"
  | "tokensLastTwoWeeks"
  | "usdLastTwoWeeks";

function toJson(tracked: Tracked): string {
  const apps = tracked.apps.map(appJson);
  const addUp = (field: SummedField) =>
    Math.round(apps.reduce((sum, app) => sum + app[field], 0) * 100) / 100;
  const json = {
    hoursOnRecord: addUp("hours"),
    hoursMeasured: addUp("hoursMeasured"),
    hoursEstimated: addUp("hoursEstimated"),
    hoursLastTwoWeeks: addUp("hoursLastTwoWeeks"),
    since: sinceDay(tracked.total, tracked.earlier),
    tokensOnRecord: addUp("tokens"),
    usdOnRecord: addUp("usd"),
    tokensLastTwoWeeks: addUp("tokensLastTwoWeeks"),
    usdLastTwoWeeks: addUp("usdLastTwoWeeks"),
    tokensSince: tracked.spend.since ?? null,
    unpricedModels: [...tracked.spend.unpricedModels].sort(),
    apps,
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
    process.stderr.write(`ai-playtime: ${error.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (command === "help" || command === "version") {
    process.stdout.write(`${command === "help" ? USAGE : pkg.version}\n`);
    return 0;
  }
  const tracked = await track(resolvePaths(process.env), Date.now());
  if (tracked === undefined) {
    process.stdout.write(
      command === "json"
        ? `${JSON.stringify(NO_ACTIVITY_JSON)}\n`
        : "No Claude Code, Codex, ChatGPT app or Claude app activity found\n",
    );
    return 0;
  }
  process.stdout.write(command === "json" ? toJson(tracked) : render(tracked));
  return 0;
}

process.exitCode = await main().catch((error: unknown) => {
  process.stderr.write(`ai-playtime: ${messageOf(error)}\n`);
  return 1;
});
