import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createZstdDecompress } from "node:zlib";
import * as z from "zod/mini";
import { CHUNK_BYTES, eachLine, isMissing, jsonlFiles, messageOf, parseJson } from "./files.ts";
import { addUsage, modelKey, type Usage, type UsageByDay } from "./tokens.ts";

type CodexApp = "codex" | "chatgpt";

export interface CodexScan {
  times: Record<CodexApp, number[]>;
  usage: Record<CodexApp, UsageByDay>;
}

interface Rollout {
  model: string;
  total: number;
  recorded: boolean;
}

const TIMESTAMP_PREFIX = '{"timestamp":"';
const DESKTOP_ORIGINATORS = new Set(["Codex Desktop", "codex_work_desktop"]);
const ROLLOUT = /^rollout-.*\.jsonl(\.zst)?$/;
const UNKNOWN_MODEL = "unknown";
const LONG_CONTEXT_TOKENS = 272_000;
const TOKEN_LINE = /"type":"(?:turn_context|token_usage_record|token_count)"/;

const Line = z.object({ timestamp: z.iso.datetime({ offset: true }) });
const SessionMeta = z.object({
  type: z.literal("session_meta"),
  payload: z.object({ originator: z.optional(z.string()) }),
});
const TurnContext = z.object({
  type: z.literal("turn_context"),
  payload: z.object({ model: z.string() }),
});
const Count = z.int().check(z.nonnegative());
const TokenUsage = z
  .object({
    input_tokens: Count,
    cached_input_tokens: Count,
    cache_write_input_tokens: z.optional(Count),
    output_tokens: Count,
    total_tokens: Count,
  })
  .check(
    z.refine(
      (usage) =>
        usage.cached_input_tokens + (usage.cache_write_input_tokens ?? 0) <= usage.input_tokens,
    ),
  );
const UsageRecord = z.object({
  type: z.literal("token_usage_record"),
  payload: z.object({ response_id: z.string(), usage: TokenUsage }),
});
const TokenCount = z.object({
  type: z.literal("event_msg"),
  payload: z.object({
    type: z.literal("token_count"),
    info: z.nullable(z.object({ total_token_usage: TokenUsage, last_token_usage: TokenUsage })),
  }),
});

export function codexRoots(env: NodeJS.ProcessEnv): string[] {
  const configured = env.CODEX_HOME?.trim() ?? "";
  const home = configured === "" ? join(homedir(), ".codex") : configured;
  return [join(home, "sessions"), join(home, "archived_sessions")];
}

function timestampOf(line: string): number {
  const end = line.indexOf('"', TIMESTAMP_PREFIX.length);
  if (line.startsWith(TIMESTAMP_PREFIX) && end !== -1) {
    return Date.parse(line.slice(TIMESTAMP_PREFIX.length, end));
  }
  const parsed = Line.safeParse(parseJson(line));
  return parsed.success ? Date.parse(parsed.data.timestamp) : Number.NaN;
}

function appOf(firstLine: string): CodexApp {
  const meta = SessionMeta.safeParse(parseJson(firstLine));
  const originator = meta.success ? meta.data.payload.originator : undefined;
  return originator !== undefined && DESKTOP_ORIGINATORS.has(originator) ? "chatgpt" : "codex";
}

function textOf(path: string) {
  const file = createReadStream(path, { highWaterMark: CHUNK_BYTES });
  if (!path.endsWith(".zst")) return file.setEncoding("utf8");
  const decompressed = createZstdDecompress({ chunkSize: CHUNK_BYTES });
  file.on("error", (error) => decompressed.destroy(error)).pipe(decompressed);
  return decompressed.setEncoding("utf8");
}

type TokenUsage = z.infer<typeof TokenUsage>;

function recordedUsage(
  { response_id: id, usage }: z.infer<typeof UsageRecord>["payload"],
  rollout: Rollout,
  responses: Set<string>,
) {
  rollout.recorded = true;
  if (responses.has(id)) return undefined;
  responses.add(id);
  return usage;
}

function responseUsage(line: string, rollout: Rollout, responses: Set<string>) {
  if (!TOKEN_LINE.test(line)) return undefined;
  const json = parseJson(line);
  rollout.model = TurnContext.safeParse(json).data?.payload.model ?? rollout.model;
  const record = UsageRecord.safeParse(json).data?.payload;
  if (record !== undefined) return recordedUsage(record, rollout, responses);
  const info = rollout.recorded ? undefined : TokenCount.safeParse(json).data?.payload.info;
  if (!info || info.total_token_usage.total_tokens === rollout.total) return undefined;
  rollout.total = info.total_token_usage.total_tokens;
  return info.last_token_usage;
}

function usageOf(usage: TokenUsage): Usage {
  const cacheWrite = usage.cache_write_input_tokens ?? 0;
  return {
    input: usage.input_tokens - usage.cached_input_tokens - cacheWrite,
    cacheWrite,
    cacheWrite1h: 0,
    cacheRead: usage.cached_input_tokens,
    output: usage.output_tokens,
  };
}

async function readRollout(path: string, since: number, found: CodexScan, responses: Set<string>) {
  let app: CodexApp | undefined;
  const rollout: Rollout = { model: UNKNOWN_MODEL, total: 0, recorded: false };
  await eachLine(textOf(path), (line) => {
    app ??= appOf(line);
    const time = timestampOf(line);
    const usage = responseUsage(line, rollout, responses);
    if (Number.isNaN(time) || time < since) return;
    found.times[app].push(time);
    if (usage === undefined) return;
    const premium = usage.input_tokens > LONG_CONTEXT_TOKENS ? "long context" : undefined;
    addUsage(found.usage[app], time, modelKey(rollout.model, premium), usageOf(usage));
  });
}

async function scanRollout(path: string, since: number, found: CodexScan, responses: Set<string>) {
  try {
    if ((await stat(path)).mtimeMs < since) return;
    await readRollout(path, since, found, responses);
  } catch (error) {
    if (isMissing(error)) return;
    throw new Error(`could not read ${path}: ${messageOf(error)}`, { cause: error });
  }
}

export async function scanCodex(roots: readonly string[], since: number): Promise<CodexScan> {
  const found: CodexScan = {
    times: { codex: [], chatgpt: [] },
    usage: { codex: {}, chatgpt: {} },
  };
  const responses = new Set<string>();
  for (const root of roots) {
    for (const path of await jsonlFiles(root, ROLLOUT)) {
      await scanRollout(path, since, found, responses);
    }
  }
  return found;
}
