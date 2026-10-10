# opencode-tok-sec

A live throughput meter for the [OpenCode](https://opencode.ai) **V2** TUI. It renders into the prompt footer as a VU-style time-series of generation speed, with average, peak, trend, and time-to-first-token.

```
tok/s ▃▆▇▇█▆▄ 42.0 ▲15% · avg 38.2 · pk 45.0 · ttft 0.8s
```

Built on the OpenCode V2 plugin API: `Plugin.define`, typed `data.on` events, the slot tree, and semantic theme tokens.

## What it looks like

The graph grows one column per second as the model streams, scaled to the turn's busiest second:

```
tok/s ▁ 18.0                                             first token
tok/s ▁▃▅ 33.0 ▲12%                                      ramping up
tok/s ▃▆▇▇█ 45.0 ▲18% · avg 41.2 · pk 45.0 · ttft 0.8s
tok/s ▃▆▇▇█▆▄ - · avg 41.2 · pk 45.0 · ttft 0.8s         tool call — average holds
tok/s ▃▆▇▇█▆▄█▆ 43.0 ▲2% · avg 41.0 · pk 45.0 · ttft 0.8s   resumed
tok/s ▃▆▇▇█▆▄█▆ 43.0 · avg 41.0 · pk 45.0 · ttft 0.8s        holds, scaled to exact tokens
tok/s idle                                               nothing running
```

The rate and trend are color-coded: red below `slowTps`, yellow up to `fastTps`, green at or above it.

- **VU meter** — one half-block column per second, growing as the turn progresses (no reserved empty space), scaled to the turn's busiest second
- **Average** — active generation speed: tokens per second over the time actually spent streaming, so tool calls and the gaps between model steps don't drag it down
- **Held frame** — when a turn ends the graph, rate, average, peak, and TTFT freeze and stay on screen until the next turn produces tokens
- **Exact totals** — on completion the graph and peak are rescaled to the provider's reported token counts, summed across every step of the turn
- **Peak hold** — the fastest rate observed during the turn, never below the average
- **Trend** — up/down against the previous second, with percent
- **TTFT** — time from the first model request of the turn being dispatched to the first streamed token

## Install

Once published, one command:

```bash
opencode plugin add opencode-tok-sec
```

This installs the package and adds it to the global config; the TUI loads the package's `./tui` export automatically. Restart the TUI afterwards.

Manually, add the package to the `plugin` array (note: singular) in `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": ["opencode-tok-sec"]
}
```

To keep the meter client-side only (e.g. when using OpenCode against a remote server), put it in `~/.config/opencode/cli.json` instead — entries there are loaded by the TUI client, never the server:

```jsonc
// ~/.config/opencode/cli.json
{
  "plugins": ["opencode-tok-sec"]
}
```

### From a local checkout (no publish)

Point a config entry at the checkout with a `file:` specifier (a bare path is silently ignored), and install its dependencies so its imports resolve:

```bash
cd /path/to/opencode-tok-sec && npm install
```

```jsonc
// ~/.config/opencode/cli.json — TUI client only
{
  "plugins": [{ "package": "file:/path/to/opencode-tok-sec" }]
}
```

or in `~/.config/opencode/opencode.json` under `plugin` (loads server + client). Config edits take effect on TUI restart.

The package ships TypeScript source and is transpiled by OpenCode's own runtime — no build step.

### Options

Pass options with the object form in `cli.json` (in `opencode.json` the tuple form `["opencode-tok-sec", { … }]` is also accepted):

```jsonc
{
  "plugins": [
    { "package": "opencode-tok-sec", "options": { "vuColumns": 20, "vuScale": "fixed", "vuFullTps": 80 } }
  ]
}
```

Note: dropping plugin files into `.opencode/plugins/` or `~/.config/opencode/plugins/` does **not** work for this plugin — those directories are loaded by the server for hook plugins only; TUI slot plugins must come through a package entry.

## Install (for AI agents)

If you are an agent installing this for a user, the full procedure is:

```text
GOAL: install opencode-tok-sec into the user's OpenCode V2 TUI.

1. Run: opencode plugin add opencode-tok-sec
2. This installs the package and adds it to the global config
   (~/.config/opencode/opencode.json under the "plugin" key, singular).
3. If the installer is unavailable, add "opencode-tok-sec" to that
   "plugin" array by hand — or, for a TUI-client-only install, to the
   "plugins" array in ~/.config/opencode/cli.json.
   Local checkouts work as entries too: "file:/abs/path/to/checkout"
   (a bare path without the file: scheme is silently ignored).
4. Do NOT remove sibling entries and do NOT add a version suffix.
5. Tell the user to restart the TUI. Config changes are not hot-reloaded.
6. Do not place this plugin's files in a plugins/ directory — those are
   server-side hook plugins; a TUI slot plugin must come from a package entry.
7. Do not touch any other top-level key in either file.
```

## Options

Pass options through the object form (see above); they arrive as `context.options`:

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Disable rendering without uninstalling |
| `rollingWindowMs` | `5000` | Averaging window for the live rate |
| `idleTimeoutMs` | `1500` | Silence after which the rate reads as inactive |
| `minSpanMs` | `300` | Floor on the elapsed span so early samples don't spike |
| `vuColumns` | `12` | Maximum seconds of history shown in the VU meter |
| `vuScale` | `"auto"` | `auto` scales columns to the turn peak; `fixed` uses `vuFullTps` |
| `vuFullTps` | `50` | Full-scale tokens/sec when `vuScale` is `fixed` |
| `slowTps` | `10` | Below this is "slow" (red) |
| `fastTps` | `30` | At or above this is "fast" (green) |
| `showVu` | `true` | Show the VU meter |
| `showTrend` | `true` | Show the trend arrow |
| `showAvg` | `true` | Show the turn average |
| `showPeak` | `true` | Show the peak |
| `showTtft` | `true` | Show time to first token |
| `showTokenCount` | `false` | Show the token counter |
| `showElapsed` | `false` | Show elapsed turn time |
| `alwaysShow` | `false` | Keep the meter visible when idle instead of hiding it |
| `idleText` | `"idle"` | Placeholder shown with `alwaysShow` when there is no data (`tok/s idle`) |
| `label` | `"tok/s"` | Leading label |

## How it works

The plugin subscribes to the TUI's typed event stream (`context.data.on`) and treats one **execution** as the metered turn — a prompt through completion, spanning every model step inside it. (V2 emits a separate assistant message per model step, so scoping by message would fragment the graph.)

- `session.execution.started` — opens a turn. On `succeeded` / `failed` / `interrupted` the turn settles: exact provider tokens replace the estimate, the final frame is frozen, and it stays on screen.
- `session.step.started` — the first request of a turn anchors TTFT to its dispatch time; every later request is a burst boundary and restarts the live rate while keeping the graph continuous.
- `session.text.delta` / `session.reasoning.delta` — record streamed chunks and bucket them per second.
- `session.tool.called` — restarts the live rate for the tool pause, same as a step boundary.
- `session.step.ended` / `session.step.failed` — accumulate the provider's exact `output + reasoning` tokens for the turn.
- `session.deleted` — frees that session's meter.

The live rate is `tokens in window / elapsed span` over the trailing window, measured on the wall clock, and is ignored while the session's status reads `idle`. The average is `turn tokens / active generation time` — the time spent streaming, excluding tool pauses. Peak is the highest one-second rate seen during the turn (never below the average); trend compares the last two complete seconds. VU columns auto-scale to the largest bucket in view, rescaled to the summed exact token total when the turn completes.

The meter renders into the `prompt.footer.status` slot with semantic theme tokens (`text.feedback.error/warning/success`). The layers are split so each one is testable without a terminal: `src/meter.ts` measures, `src/display.ts` formats, `src/view.ts` turns a store frame into the reactive line, and `src/tui.tsx` only mounts that line in the slot. The first three are unit-tested with no plugin imports at runtime.

## Author

TheStranjer

## License

MIT
