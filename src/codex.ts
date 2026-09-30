import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createZstdDecompress } from "node:zlib";
import * as z from "zod/mini";
import { isMissing, jsonlFiles, messageOf, parseJson } from "./files.ts";

type CodexApp = "codex" | "chatgpt";

const TIMESTAMP_PREFIX = '{"timestamp":"';
const DESKTOP_ORIGINATORS = new Set(["Codex Desktop", "codex_work_desktop"]);
const ROLLOUT = /^rollout-.*\.jsonl(\.zst)?$/;

const Line = z.object({ timestamp: z.iso.datetime({ offset: true }) });
const SessionMeta = z.object({
  type: z.literal("session_meta"),
  payload: z.object({ originator: z.optional(z.string()) }),
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

function linesOf(path: string) {
  const file = createReadStream(path);
  if (!path.endsWith(".zst")) return createInterface({ input: file, crlfDelay: Infinity });
  const decompressed = createZstdDecompress();
  file.on("error", (error) => decompressed.destroy(error)).pipe(decompressed);
  return createInterface({ input: decompressed, crlfDelay: Infinity });
}

async function scanRollout(path: string, since: number, found: Record<CodexApp, number[]>) {
  try {
    if ((await stat(path)).mtimeMs < since) return;
    let times: number[] | undefined;
    for await (const line of linesOf(path)) {
      times ??= found[appOf(line)];
      const time = timestampOf(line);
      if (time >= since) times.push(time);
    }
  } catch (error) {
    if (isMissing(error)) return;
    throw new Error(`could not read ${path}: ${messageOf(error)}`, { cause: error });
  }
}

export async function scanCodex(
  roots: readonly string[],
  since: number,
): Promise<Record<CodexApp, number[]>> {
  const found: Record<CodexApp, number[]> = { codex: [], chatgpt: [] };
  for (const root of roots) {
    for (const path of await jsonlFiles(root, ROLLOUT)) await scanRollout(path, since, found);
  }
  return found;
}
