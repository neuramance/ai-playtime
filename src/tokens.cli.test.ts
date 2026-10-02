import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  DAY,
  MINUTE,
  at,
  claudeTokenDays,
  claudeTokenHome,
  codexTokenHome,
  dayKey,
  emptyDir,
  events,
  firstRunHint,
  iso,
  json,
  onOneUtcDay,
  recordPath,
  run,
  unestimated,
  utcToday,
  write,
} from "./fixtures.ts";

it("reports Claude tokens once per streamed or forked response with normalized model prices", () => {
  const home = claudeTokenHome();
  expect(run(home)).toEqual({
    status: 0,
    stderr: "",
    stdout: [
      "",
      "  ▶ AI Playtime",
      "    0.5 hrs on record",
      "    0.0 hrs last two weeks  ··············",
      "    Claude Code 0.5",
      "    since 1 Jul 2025",
      "    1.3M tokens on record, worth $2.36 at API prices",
      "",
      ...firstRunHint(home),
    ].join("\n"),
  });
  expect(run(home, "--json")).toEqual({
    status: 0,
    stderr: "",
    stdout: `${JSON.stringify({
      hoursOnRecord: 0.5,
      hoursMeasured: 0.5,
      hoursEstimated: 0,
      hoursLastTwoWeeks: 0,
      since: "2025-07-01",
      tokensOnRecord: 1305000,
      usdOnRecord: 2.36,
      tokensLastTwoWeeks: 0,
      usdLastTwoWeeks: 0,
      tokensSince: "2025-07-01",
      unpricedModels: [],
      apps: [
        {
          app: "Claude Code",
          hours: 0.5,
          hoursMeasured: 0.5,
          ...unestimated,
          hoursLastTwoWeeks: 0,
          secondsByDay: { "2025-07-01": 1800 },
          tokens: 1305000,
          usd: 2.36,
          tokensLastTwoWeeks: 0,
          usdLastTwoWeeks: 0,
          usageByDay: claudeTokenDays,
        },
      ],
    })}\n`,
  });
});

it("counts Codex responses across model switches without re-emissions or fork duplicates", () => {
  expect(json(codexTokenHome())).toMatchObject({
    tokensOnRecord: 315100,
    usdOnRecord: 6.29,
    tokensLastTwoWeeks: 0,
    usdLastTwoWeeks: 0,
    tokensSince: "2025-07-01",
    unpricedModels: [],
    apps: [
      {
        app: "Codex",
        tokens: 315100,
        usd: 6.29,
        tokensLastTwoWeeks: 0,
        usdLastTwoWeeks: 0,
        usageByDay: {
          "2025-07-01": {
            "gpt-6-astra": {
              input: 2000,
              cacheWrite: 3000,
              cacheWrite1h: 0,
              cacheRead: 2500,
              output: 600,
            },
            "gpt-6-astra (long context)": {
              input: 300000,
              cacheWrite: 0,
              cacheWrite1h: 0,
              cacheRead: 0,
              output: 2000,
            },
            "gpt-5.5": {
              input: 2000,
              cacheWrite: 2000,
              cacheWrite1h: 0,
              cacheRead: 0,
              output: 1000,
            },
          },
        },
      },
    ],
  });
});

it("includes unpriced Claude tokens without charging for them and labels them on the card", () => {
  const home = emptyDir();
  const replies = [
    {
      id: "unknown",
      model: "claude-unknown-9",
      usage: { input_tokens: 1000, output_tokens: 1000 },
    },
    {
      id: "priced",
      model: "claude-haiku-4-5",
      usage: { input_tokens: 10000, output_tokens: 20000 },
    },
  ];
  write(
    home,
    ".claude/projects/-work/s1.jsonl",
    replies
      .map((message, i) =>
        JSON.stringify({
          timestamp: iso(at("2025-07-01T10:00:00Z") + i * 10 * MINUTE),
          type: "assistant",
          entrypoint: "cli",
          message,
        }),
      )
      .join("\n"),
  );
  expect(json(home)).toMatchObject({
    tokensOnRecord: 32000,
    usdOnRecord: 0.11,
    unpricedModels: ["claude-unknown-9"],
    apps: [{ app: "Claude Code", tokens: 32000, usd: 0.11 }],
  });
  expect(run(home).stdout.split("\n")).toContain(
    "    32K tokens on record, worth $0.11 at API prices (2K unpriced)",
  );
});

it("labels Codex usage before the first turn context as unknown and unpriced", () => {
  const home = emptyDir();
  const usage = {
    input_tokens: 1000,
    cached_input_tokens: 0,
    output_tokens: 1000,
    total_tokens: 2000,
  };
  const lines = [
    { type: "session_meta", payload: { originator: "codex-tui" } },
    {
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } },
    },
    { type: "turn_context", payload: { model: "gpt-6-astra" } },
  ];
  write(
    home,
    ".codex/sessions/rollout-a.jsonl",
    lines
      .map((line, i) =>
        JSON.stringify({ timestamp: iso(at("2025-07-01T10:00:00Z") + i * MINUTE), ...line }),
      )
      .join("\n"),
  );
  expect(json(home)).toMatchObject({
    tokensOnRecord: 2000,
    usdOnRecord: 0,
    unpricedModels: ["unknown"],
    apps: [
      {
        app: "Codex",
        tokens: 2000,
        usd: 0,
        usageByDay: {
          "2025-07-01": {
            unknown: { input: 1000, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 1000 },
          },
        },
      },
    ],
  });
});

it("limits recent tokens and spend to the last fourteen UTC days", () => {
  onOneUtcDay(() => {
    const home = emptyDir();
    const today = utcToday();
    for (const [day, input, output] of [
      [today, 10000, 20000],
      [today - 20 * DAY, 20000, 40000],
    ] as const) {
      const start = day + 10 * 60 * MINUTE;
      write(
        home,
        `.claude/projects/-work/${dayKey(day)}.jsonl`,
        JSON.stringify({
          timestamp: iso(start),
          entrypoint: "cli",
          message: {
            id: dayKey(day),
            model: "claude-haiku-4-5",
            usage: { input_tokens: input, output_tokens: output },
          },
        }) +
          "\n" +
          events([start + 10 * MINUTE]),
      );
    }
    expect(json(home)).toMatchObject({
      tokensOnRecord: 90000,
      usdOnRecord: 0.33,
      tokensLastTwoWeeks: 30000,
      usdLastTwoWeeks: 0.11,
      tokensSince: dayKey(today - 20 * DAY),
      apps: [
        {
          app: "Claude Code",
          tokens: 90000,
          usd: 0.33,
          tokensLastTwoWeeks: 30000,
          usdLastTwoWeeks: 0.11,
          usageByDay: {
            [dayKey(today)]: {
              "claude-haiku-4-5": {
                input: 10000,
                cacheWrite: 0,
                cacheWrite1h: 0,
                cacheRead: 0,
                output: 20000,
              },
            },
            [dayKey(today - 20 * DAY)]: {
              "claude-haiku-4-5": {
                input: 20000,
                cacheWrite: 0,
                cacheWrite1h: 0,
                cacheRead: 0,
                output: 40000,
              },
            },
          },
        },
      ],
    });
  });
});

it("attributes desktop transcript tokens to the Claude app", () => {
  const home = emptyDir();
  write(
    home,
    ".claude/projects/-work/desktop.jsonl",
    JSON.stringify({
      timestamp: "2025-07-01T10:00:00Z",
      entrypoint: "claude-desktop",
      message: {
        id: "desktop",
        model: "claude-haiku-4-5",
        usage: { input_tokens: 1000, output_tokens: 1000 },
      },
    }) +
      "\n" +
      events([at("2025-07-01T10:10:00Z")]),
  );
  expect(json(home)).toMatchObject({
    tokensOnRecord: 2000,
    usdOnRecord: 0.01,
    apps: [
      {
        app: "Claude app",
        tokens: 2000,
        usd: 0.01,
        usageByDay: {
          "2025-07-01": {
            "claude-haiku-4-5": {
              input: 1000,
              cacheWrite: 0,
              cacheWrite1h: 0,
              cacheRead: 0,
              output: 1000,
            },
          },
        },
      },
    ],
  });
});

it("reports tokens from an app whose only response left no measurable time", () => {
  const home = emptyDir();
  write(
    home,
    ".claude/projects/-work/desktop.jsonl",
    JSON.stringify({
      timestamp: "2025-07-01T10:00:00Z",
      entrypoint: "claude-desktop",
      message: {
        id: "only",
        model: "claude-haiku-4-5",
        usage: { input_tokens: 10000, output_tokens: 20000 },
      },
    }),
  );
  expect(json(home)).toMatchObject({
    hoursOnRecord: 0,
    since: "2025-07-01",
    tokensOnRecord: 30000,
    usdOnRecord: 0.11,
    apps: [{ app: "Claude app", hours: 0, secondsByDay: {}, tokens: 30000, usd: 0.11 }],
  });
  expect(JSON.parse(readFileSync(recordPath(home), "utf8"))).toMatchObject({
    tokens: { claude: { "2025-07-01": { "claude-haiku-4-5": { input: 10000, output: 20000 } } } },
  });
});
