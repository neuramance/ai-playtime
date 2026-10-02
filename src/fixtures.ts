import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { onTestFinished } from "vitest";

export const CLI = join(import.meta.dirname, "cli.ts");
export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
export const COWORK = "Library/Application Support/Claude/local-agent-mode-sessions";

export const utcToday = () => Math.floor(Date.now() / DAY) * DAY;
export const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const iso = (ms: number) => new Date(ms).toISOString();
export const at = (text: string) => Date.parse(text);
export const events = (times: number[], entrypoint?: string) =>
  times.map((t) => `${JSON.stringify({ timestamp: iso(t), entrypoint })}\n`).join("");
export const yesterdayAt = (...minutes: number[]) =>
  events(minutes.map((m) => utcToday() - DAY + 10 * 60 * MINUTE + m * MINUTE));
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

export function claudeTokenHome(): string {
  const home = emptyDir();
  const opus = {
    input_tokens: 2500,
    cache_creation_input_tokens: 110000,
    cache_creation: { ephemeral_5m_input_tokens: 100000, ephemeral_1h_input_tokens: 10000 },
    cache_read_input_tokens: 1000000,
    output_tokens: 7,
    speed: "standard",
  };
  const replies = [
    { minute: 0, id: "msg_a", model: "claude-opus-5-5", usage: opus },
    {
      minute: 10,
      id: "msg_a",
      model: "claude-opus-5-5",
      usage: { ...opus, output_tokens: 50000 },
    },
    {
      minute: 15,
      id: "msg_b",
      model: "claude-opus-5-5",
      usage: {
        input_tokens: 2500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 100000,
        output_tokens: 3,
      },
    },
    {
      minute: 20,
      id: "msg_b",
      model: "claude-opus-5-5",
      usage: {
        input_tokens: 2500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 100000,
        output_tokens: 10000,
        speed: "fast",
      },
    },
    {
      minute: 30,
      id: "msg_c",
      model: "claude-haiku-4-5-20251001",
      content: "before\u2028after",
      usage: {
        input_tokens: 10000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 20000,
      },
    },
    {
      minute: 30,
      id: "msg_s",
      model: "<synthetic>",
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
    },
  ];
  write(
    home,
    ".claude/projects/-work/s1.jsonl",
    replies
      .map(({ minute, ...message }) =>
        JSON.stringify({
          timestamp: iso(at("2025-07-01T10:00:00Z") + minute * MINUTE),
          type: "assistant",
          entrypoint: "cli",
          message,
        }),
      )
      .join("\n"),
  );
  write(
    home,
    ".claude/projects/-work/s1/subagents/agent-a.jsonl",
    JSON.stringify({
      timestamp: "2025-07-01T10:15:00Z",
      type: "assistant",
      entrypoint: "cli",
      message: { id: "msg_a", model: "claude-opus-5-5", usage: opus },
    }),
  );
  return home;
}

export const claudeTokenDays = {
  "2025-07-01": {
    "claude-opus-5-5": {
      input: 2500,
      cacheWrite: 100000,
      cacheWrite1h: 10000,
      cacheRead: 1000000,
      output: 50000,
    },
    "claude-opus-5-5 (fast)": {
      input: 2500,
      cacheWrite: 0,
      cacheWrite1h: 0,
      cacheRead: 100000,
      output: 10000,
    },
    "claude-haiku-4-5": {
      input: 10000,
      cacheWrite: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      output: 20000,
    },
  },
};

const codexUsage = {
  initial: {
    input_tokens: 5500,
    cached_input_tokens: 1500,
    cache_write_input_tokens: 3000,
    output_tokens: 500,
    reasoning_output_tokens: 0,
    total_tokens: 6000,
  },
  long: {
    input_tokens: 300000,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2000,
    total_tokens: 302000,
  },
  recorded: {
    input_tokens: 2000,
    cached_input_tokens: 1000,
    cache_write_input_tokens: 0,
    output_tokens: 100,
    total_tokens: 2100,
  },
};

export function codexTokenHome(): string {
  const home = emptyDir();
  const { initial, long, recorded } = codexUsage;
  const meta = { type: "session_meta", payload: { originator: "codex-tui" } };
  const context = { type: "turn_context", payload: { model: "gpt-6-astra" } };
  const count = {
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: initial, last_token_usage: initial },
    },
  };
  const response = {
    type: "token_usage_record",
    payload: { response_id: "resp-1", usage: recorded },
  };
  const lines = [
    meta,
    context,
    { type: "event_msg", payload: { type: "token_count", info: null } },
    count,
    count,
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: long,
          total_token_usage: {
            ...initial,
            input_tokens: 305500,
            output_tokens: 2500,
            total_tokens: 308000,
          },
        },
      },
    },
    response,
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: recorded,
          total_token_usage: {
            ...initial,
            input_tokens: 307500,
            cached_input_tokens: 2500,
            output_tokens: 2600,
            total_tokens: 310100,
          },
        },
      },
    },
    { type: "turn_context", payload: { model: "gpt-5.5" } },
    {
      type: "token_usage_record",
      payload: {
        response_id: "resp-2",
        usage: {
          input_tokens: 4000,
          cached_input_tokens: 0,
          cache_write_input_tokens: 2000,
          output_tokens: 1000,
          total_tokens: 5000,
        },
      },
    },
  ];
  for (const [name, entries] of Object.entries({ a: lines, b: [meta, context, response] })) {
    write(
      home,
      `.codex/sessions/rollout-${name}.jsonl`,
      entries
        .map((line, i) =>
          JSON.stringify({ timestamp: iso(at("2025-07-01T10:00:00Z") + i * MINUTE), ...line }),
        )
        .join("\n"),
    );
  }
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
    cwd: overrides.HOME,
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
export const noTokens = {
  tokens: 0,
  usd: 0,
  tokensLastTwoWeeks: 0,
  usdLastTwoWeeks: 0,
  usageByDay: {},
};
export const noSpend = {
  tokensOnRecord: 0,
  usdOnRecord: 0,
  tokensLastTwoWeeks: 0,
  usdLastTwoWeeks: 0,
  tokensSince: null,
  unpricedModels: [],
};

export function halfHourYesterday() {
  const yesterday = dayKey(utcToday() - DAY);
  return {
    hoursOnRecord: 0.5,
    hoursMeasured: 0.5,
    hoursEstimated: 0,
    hoursLastTwoWeeks: 0.5,
    since: yesterday,
    ...noSpend,
    apps: [
      {
        app: "Claude Code",
        ...unestimated,
        hours: 0.5,
        hoursMeasured: 0.5,
        hoursLastTwoWeeks: 0.5,
        secondsByDay: { [yesterday]: 1800 },
        ...noTokens,
      },
    ],
  };
}

export const wholeHistory = {
  hoursOnRecord: 72.75,
  hoursMeasured: 9.5,
  hoursEstimated: 63.25,
  hoursLastTwoWeeks: 0,
  since: "2025-06-23",
  ...noSpend,
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
      ...noTokens,
    },
  ],
};

export function onOneUtcDay(test: () => void): void {
  const day = utcToday();
  try {
    test();
  } catch (error) {
    if (utcToday() === day) throw error;
    test();
  }
}
