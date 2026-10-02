import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import * as z from "zod/mini";
import {
  CHUNK_BYTES,
  eachLine,
  isMissing,
  jsonlFiles,
  messageOf,
  parseJson,
  readIfPresent,
} from "./files.ts";
import type { Launches } from "./playtime.ts";
import { addUsage, maxUsage, modelKey, type Usage, type UsageByDay } from "./tokens.ts";

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

export interface ClaudeScan {
  sessions: Session[];
  usage: Record<ClaudeApp, UsageByDay>;
}

interface Reply {
  time: number;
  app: ClaudeApp;
  model: string;
  fast: boolean;
  usage: Usage;
}

const JSONL = /\.jsonl$/;
const COWORK_PROJECTS = `${sep}.claude${sep}projects${sep}`;

const Count = z.int().check(z.nonnegative());
const CacheCount = z.optional(z.nullable(Count));

const TranscriptEntry = z.object({
  timestamp: z.iso.datetime({ offset: true }),
  entrypoint: z.optional(z.string()),
});
const AssistantReply = z.object({
  message: z.object({
    id: z.string(),
    model: z.string(),
    usage: z
      .object({
        input_tokens: Count,
        output_tokens: Count,
        cache_creation_input_tokens: CacheCount,
        cache_read_input_tokens: CacheCount,
        cache_creation: z.optional(z.nullable(z.object({ ephemeral_1h_input_tokens: CacheCount }))),
        speed: z.optional(z.nullable(z.string())),
      })
      .check(
        z.refine(
          (usage) =>
            (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) <=
            (usage.cache_creation_input_tokens ?? 0),
        ),
      ),
  }),
});
const ClaudeConfig = z.object({
  numStartups: z.optional(Count),
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

type Message = z.infer<typeof AssistantReply>["message"];

function parseEntry(line: string) {
  if (!line.includes('"timestamp"')) return undefined;
  const json = parseJson(line);
  const entry = TranscriptEntry.safeParse(json);
  if (!entry.success) return undefined;
  const reply = AssistantReply.safeParse(json).data;
  return { ...entry.data, message: reply?.message };
}

function usageOf({ usage }: Message): Usage {
  const cacheWrite1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return {
    input: usage.input_tokens,
    cacheWrite: (usage.cache_creation_input_tokens ?? 0) - cacheWrite1h,
    cacheWrite1h,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    output: usage.output_tokens,
  };
}

function countReply(replies: Map<string, Reply>, message: Message, time: number, app: ClaudeApp) {
  const usage = usageOf(message);
  const fast = message.usage.speed === "fast";
  const seen = replies.get(message.id);
  if (seen === undefined) {
    replies.set(message.id, { time, app, model: message.model, fast, usage });
    return;
  }
  seen.usage = maxUsage(seen.usage, usage);
  seen.fast ||= fast;
  if (time < seen.time) Object.assign(seen, { time, app });
}

function appOf(entrypoint: string, host: ClaudeApp): ClaudeApp {
  return host === "claude" || entrypoint.startsWith("claude-desktop") ? "claude" : "claude-code";
}

async function scanFile(
  path: string,
  host: ClaudeApp,
  since: number,
  session: Session,
  replies: Map<string, Reply>,
) {
  try {
    if ((await stat(path)).mtimeMs < since) return;
    let app = host;
    const text = createReadStream(path, { encoding: "utf8", highWaterMark: CHUNK_BYTES });
    await eachLine(text, (line) => {
      const entry = parseEntry(line);
      if (entry === undefined) return;
      if (entry.entrypoint !== undefined) app = appOf(entry.entrypoint, host);
      if (entry.entrypoint === "cli") session.interactive = true;
      const time = Date.parse(entry.timestamp);
      if (entry.message !== undefined) countReply(replies, entry.message, time, app);
      if (time >= since) session.timestamps[app].push(time);
    });
  } catch (error) {
    if (isMissing(error)) return;
    throw new Error(`could not read ${path}: ${messageOf(error)}`, { cause: error });
  }
}

function sessionKey(root: string, path: string): string {
  return join(root, ...relative(root, path).split(sep).slice(0, 2)).replace(JSONL, "");
}

export async function scanSessions(paths: ClaudePaths, since: number): Promise<ClaudeScan> {
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
  const replies = new Map<string, Reply>();
  for (const { path, key, app } of files) {
    const session = sessions.get(key) ?? {
      interactive: false,
      timestamps: { "claude-code": [], claude: [] },
    };
    sessions.set(key, session);
    await scanFile(path, app, since, session, replies);
  }
  const usage: Record<ClaudeApp, UsageByDay> = { "claude-code": {}, claude: {} };
  for (const { time, app, model, fast, usage: replyUsage } of replies.values()) {
    if (time < since) continue;
    addUsage(usage[app], time, modelKey(model, fast ? "fast" : undefined), replyUsage);
  }
  return { sessions: [...sessions.values()], usage };
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
