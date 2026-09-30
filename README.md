<p align="center">
  <img src="assets/banner.svg" alt="AI Playtime: hours played, across your AI apps" width="100%">
</p>

# AI Playtime

Steam-style **hours played** across Claude Code, Codex, the ChatGPT app and the Claude app.

```sh
npx ai-playtime
```

```
  ▶ AI Playtime
    ~1,024 hrs on record
    96.3 hrs last two weeks  ▂▅▇█▃·▁▆█▅▂▁▃▇
    Claude Code ~812 · Codex 104.5 · ChatGPT app 88.2 · Claude app 19.1
    since 23 Jun 2025 (~731 hrs estimated from 1,187 earlier launches)
```

## How it counts

- **Active time, per app.** Every session event on your machine lands on its app's timeline, subagents included, so parallel sessions in one app count once. Gaps longer than 15 minutes (WakaTime's standard) are breaks. The total adds up the apps, like a Steam library.
- **Where each app's time comes from:**

  | App         | Source                                                                        |
  | ----------- | ----------------------------------------------------------------------------- |
  | Claude Code | Transcripts in `~/.claude/projects`: terminal, IDE and `claude -p`            |
  | Codex       | Session logs in `~/.codex`: terminal, IDE and `codex exec`                    |
  | ChatGPT app | Session logs in `~/.codex` started in the desktop app (Codex and Work)        |
  | Claude app  | Code-tab transcripts in `~/.claude/projects`, plus Cowork transcripts (macOS) |

  Chats in the ChatGPT and Claude apps are stored in the cloud, not in these logs, so they aren't counted.

- **Your whole history.** Codex keeps its session logs, but Claude Code deletes transcripts after 30 days while keeping a lifetime count of terminal launches (resumes included; `-p`, IDE and desktop runs aren't counted). AI Playtime subtracts the sessions it can still measure and, once it has measured 10, estimates the remaining earlier launches between your typical (median) and average session, shown as their geometric midpoint (`--json` includes the range). Backtested on one heavy user's recent weeks, the midpoint landed within 26% of measured time, while the median alone ran up to 3× low and the average up to 2× high. Months-long spans, resumed sessions and launches that left no transcript add error, so estimates always carry a `~`. Claude app Code-tab sessions older than 30 days are gone and aren't estimated.
- **Local only.** It reads those folders and `~/.claude.json` and writes one small file, `~/.local/share/ai-playtime/record.json`. Nothing leaves your machine. It respects `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `XDG_DATA_HOME`.

## Keep your record

Your first run measures everything on disk and estimates earlier Claude Code time. From then on, AI Playtime saves every (UTC) day it sees: run it at least every 30 days and the measured part keeps growing.

To never think about it, install it and let Claude Code run it after each session, in `~/.claude/settings.json`:

```sh
npm install --global ai-playtime
```

```json
{
  "hooks": {
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "ai-playtime > /dev/null", "timeout": 60 }] }
    ]
  }
}
```

## For scripts

`npx ai-playtime --json` prints one line with the totals and one entry per app (two shown here):

```
{"hoursOnRecord":1023.8,"hoursMeasured":292.67,"hoursEstimated":731.13,"hoursLastTwoWeeks":96.3,"since":"2025-06-23","apps":[{"app":"Claude Code","hours":812,"hoursMeasured":80.87,"hoursEstimated":731.13,"hoursEstimatedRange":[402.1,1329.4],"earlierLaunches":1187,"hoursLastTwoWeeks":40.1,"secondsByDay":{"2026-08-30":5506}},{"app":"Codex","hours":104.5,"hoursMeasured":104.5,"hoursEstimated":0,"hoursEstimatedRange":null,"earlierLaunches":0,"hoursLastTwoWeeks":31.2,"secondsByDay":{"2026-08-30":7340}}]}
```

## Develop

```sh
bun install      # also enables the pre-push hook
bun run check    # format, lint, typecheck, test, build
bun run verify   # check, plus the gate's own self-test (runs on git push)
```

## License

MIT
