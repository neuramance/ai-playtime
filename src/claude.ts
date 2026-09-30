import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import * as z from "zod/mini";
import { isMissing, jsonlFiles, messageOf, parseJson, readIfPresent } from "./files.ts";
import type { Launches } from "./playtime.ts";

type ClaudeApp = "claude-code" | "claude";

export interface ClaudePaths {
  projects: string;
  cowork: string;
  configs: readonly string[];
}

export interface Session {
  interactive: boolean;
  timestamps: Record<ClaudeApp, number[]>;
}

const JSONL = /\.jsonl$/;
const COWORK_PROJECTS = `${sep}.claude${sep}projects${sep}`;

const TranscriptEntry = z.object({
  timestamp: z.iso.datetime({ offset: true }),
  entrypoint: z.optional(z.string()),
});
const ClaudeConfig = z.object({
  numStartups: z.optional(z.int().check(z.nonnegative())),
  firstStartTime: z.optional(z.iso.datetime({ offset: true })),
});

export function claudePaths(env: NodeJS.ProcessEnv): ClaudePaths {
  const configured = env.CLAUDE_CONFIG_DIR?.trim() ?? "";
  const dir = configured === "" ? join(homedir(), ".claude") : configured;
  const configDir = configured === "" ? homedir() : configured;
  return {
    projects: join(dir, "projects"),
    cowork: join(
      homedir(),
      "Library",
      "Application Support",
      "Claude",
      "local-agent-mode-sessions",
    ),
    configs: [join(dir, ".config.json"), join(configDir, ".claude.json")],
  };
}

function parseEntry(line: string) {
  if (!line.includes('"timestamp"')) return undefined;
  const entry = TranscriptEntry.safeParse(parseJson(line));
  return entry.success ? entry.data : undefined;
}

function appOf(entrypoint: string, host: ClaudeApp): ClaudeApp {
  return host === "claude" || entrypoint.startsWith("claude-desktop") ? "claude" : "claude-code";
}

async function scanFile(path: string, host: ClaudeApp, since: number, session: Session) {
  try {
    if ((await stat(path)).mtimeMs < since) return;
    let app = host;
    for await (const line of createInterface({
      input: createReadStream(path),
      crlfDelay: Infinity,
    })) {
      const entry = parseEntry(line);
      if (entry === undefined) continue;
      if (entry.entrypoint !== undefined) app = appOf(entry.entrypoint, host);
      if (entry.entrypoint === "cli") session.interactive = true;
      const time = Date.parse(entry.timestamp);
      if (time >= since) session.timestamps[app].push(time);
    }
  } catch (error) {
    if (isMissing(error)) return;
    throw new Error(`could not read ${path}: ${messageOf(error)}`, { cause: error });
  }
}

function sessionKey(root: string, path: string): string {
  return join(root, ...relative(root, path).split(sep).slice(0, 2)).replace(JSONL, "");
}

export async function scanSessions(paths: ClaudePaths, since: number): Promise<Session[]> {
  const files = [
    ...(await jsonlFiles(paths.projects, JSONL)).map((path) => ({
      path,
      key: sessionKey(paths.projects, path),
      app: "claude-code" as const,
    })),
    ...(await jsonlFiles(paths.cowork, JSONL))
      .filter((path) => path.includes(COWORK_PROJECTS))
      .map((path) => ({ path, key: path, app: "claude" as const })),
  ];
  const sessions = new Map<string, Session>();
  for (const { path, key, app } of files) {
    const session = sessions.get(key) ?? {
      interactive: false,
      timestamps: { "claude-code": [], claude: [] },
    };
    sessions.set(key, session);
    await scanFile(path, app, since, session);
  }
  return [...sessions.values()];
}

export async function loadLaunches(configs: readonly string[]): Promise<Launches | undefined> {
  for (const path of configs) {
    const text = await readIfPresent(path);
    if (text === undefined) continue;
    const config = ClaudeConfig.safeParse(parseJson(text));
    if (!config.success) throw new Error(`${path} is not valid Claude Code configuration`);
    const { numStartups, firstStartTime } = config.data;
    if (numStartups === undefined || firstStartTime === undefined) return undefined;
    return { total: numStartups, firstStart: Date.parse(firstStartTime) };
  }
  return undefined;
}
