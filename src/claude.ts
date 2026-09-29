import { createReadStream, type Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import * as z from "zod/mini";
import type { Launches } from "./playtime.ts";

export interface ClaudePaths {
  dir: string;
  projects: string;
  configs: readonly string[];
}

export interface Session {
  interactive: boolean;
  timestamps: number[];
}

const TranscriptEntry = z.object({
  timestamp: z.iso.datetime({ offset: true }),
  entrypoint: z.optional(z.string()),
});
const ClaudeConfig = z.object({
  numStartups: z.optional(z.int().check(z.nonnegative())),
  firstStartTime: z.optional(z.iso.datetime({ offset: true })),
});

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export function claudePaths(env: NodeJS.ProcessEnv): ClaudePaths {
  const configured = env.CLAUDE_CONFIG_DIR?.trim() ?? "";
  const dir = configured === "" ? join(homedir(), ".claude") : configured;
  const configDir = configured === "" ? homedir() : configured;
  return {
    dir,
    projects: join(dir, "projects"),
    configs: [join(dir, ".config.json"), join(configDir, ".claude.json")],
  };
}

function parseEntry(line: string) {
  if (!line.includes('"timestamp"')) return undefined;
  const entry = TranscriptEntry.safeParse(parseJson(line));
  return entry.success ? entry.data : undefined;
}

async function scanFile(path: string, since: number, session: Session) {
  try {
    if ((await stat(path)).mtimeMs < since) return;
    for await (const line of createInterface({
      input: createReadStream(path),
      crlfDelay: Infinity,
    })) {
      const entry = parseEntry(line);
      if (entry === undefined) continue;
      if (entry.entrypoint === "cli") session.interactive = true;
      const time = Date.parse(entry.timestamp);
      if (time < since) continue;
      session.timestamps.push(time);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export async function scanSessions(projectsDir: string, since: number): Promise<Session[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(projectsDir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const sessions = new Map<string, Session>();
  for (const file of entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl"))) {
    const path = join(file.parentPath, file.name);
    const parts = relative(projectsDir, path).split(sep);
    const key = parts
      .slice(0, 2)
      .join("/")
      .replace(/\.jsonl$/, "");
    const session = sessions.get(key) ?? { interactive: false, timestamps: [] };
    sessions.set(key, session);
    await scanFile(path, since, session);
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
