// @jsxImportSource @opentui/solid
/**
 * OpenCode V2 TUI plugin. Claims the `prompt.footer.status` slot, wires server
 * events through `createMeterController`, and renders one reactive line from
 * the store's snapshot. All measurement lives in `meter.ts`.
 */
import type { Context, SlotMap } from "@opencode/plugin/tui/context"
import type { DisplayOptions, Tier, VuScale } from "./display.ts"
import { Show, createMemo, createSignal } from "solid-js"
import { formatLine, hasData, rateTier } from "./display.ts"
import type { JSX } from "solid-js"
import type { MeterController } from "./controller.ts"
import { Plugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import type { Snapshot } from "./meter.ts"
import { createMeterController } from "./controller.ts"

export type TokSecOptions = {
  readonly enabled?: boolean
  readonly rollingWindowMs?: number
  readonly idleTimeoutMs?: number
  readonly minSpanMs?: number
  readonly vuColumns?: number
  readonly vuFullTps?: number
  readonly vuScale?: VuScale
  readonly slowTps?: number
  readonly fastTps?: number
  readonly showVu?: boolean
  readonly showTrend?: boolean
  readonly showAvg?: boolean
  readonly showPeak?: boolean
  readonly showTtft?: boolean
  readonly showTokenCount?: boolean
  readonly showElapsed?: boolean
  readonly alwaysShow?: boolean
  readonly idleText?: string
  readonly label?: string
}

type ResolvedOptions = Required<TokSecOptions> & DisplayOptions
type FooterInput = SlotMap["prompt.footer.status"]

const DEFAULTS: ResolvedOptions = {
  alwaysShow: false,
  enabled: true,
  fastTps: 30,
  idleText: "idle",
  idleTimeoutMs: 1500,
  label: "tok/s",
  minSpanMs: 300,
  rollingWindowMs: 5000,
  showAvg: true,
  showElapsed: false,
  showPeak: true,
  showTokenCount: false,
  showTrend: true,
  showTtft: true,
  showVu: true,
  slowTps: 10,
  vuColumns: 12,
  vuFullTps: 50,
  vuScale: "auto",
}

type MeterLineProps = {
  readonly beat: () => number
  readonly context: Context
  readonly input: FooterInput
  readonly options: ResolvedOptions
  readonly rev: () => number
  readonly store: MeterController["store"]
}

/**
 * Map a speed tier to its theme color.
 * @param theme - The active TUI theme.
 * @param tier - Coarse speed band to color.
 * @returns The theme color for the tier.
 */
function tierColor(theme: Context["theme"], tier: Tier): RGBA {
  switch (tier) {
    case "fast": {
      return theme.text.feedback.success.base
    }
    case "idle": {
      return theme.text.muted
    }
    case "medium": {
      return theme.text.feedback.warning.base
    }
    case "slow": {
      return theme.text.feedback.error.base
    }
    default: {
      return theme.text.muted
    }
  }
}

/**
 * The one-line meter view mounted into the prompt footer.
 * @param props - Context, slot input, store, invalidation signals, options.
 * @returns The footer status element, or nothing when unmounted.
 */
function MeterLine(props: MeterLineProps): JSX.Element {
  const { options } = props,
    active = createMemo((): boolean => hasData(snapshot())),
    color = createMemo((): RGBA => {
      const { theme } = props.context,
        state = snapshot()
      if (state === undefined) {
        return theme.text.muted
      }
      return tierColor(theme, rateTier(state.rate, options.slowTps, options.fastTps))
    }),
    mounted = createMemo((): boolean => active() || options.alwaysShow),
    snapshot = createMemo((): Snapshot | undefined => {
      props.rev()
      props.beat()
      const { sessionID } = props.input
      if (sessionID === undefined || sessionID.length === 0) {
        return undefined
      }
      return props.store.snapshot(sessionID, Date.now(), options.vuColumns)
    }),
    text = createMemo((): string => {
      const state = snapshot()
      if (state === undefined || !active()) {
        return options.alwaysShow ? `${options.label} ${options.idleText}` : ""
      }
      return formatLine(state, options)
    })

  return (
    <Show when={mounted()}>
      <text fg={color()}>{text()}</text>
    </Show>
  )
}

export default Plugin.define({
  id: "tok-sec",
  setup(context: Context): (() => void) | undefined {
    const options: ResolvedOptions = { ...DEFAULTS, ...(context.options as Partial<ResolvedOptions>) }
    if (!options.enabled) {
      return undefined
    }

    const [beat, setBeat] = createSignal(0),
      controller = createMeterController(context.data, options, (): void => {
        setRev((prev): number => prev + 1)
      }),
      [rev, setRev] = createSignal(0),
      timer = setInterval((): void => {
        controller.tick()
        setBeat((prev): number => prev + 1)
      }, 1000),
      unregister = context.ui.slot({
        append: "prompt.footer.status",
        render: (input) => (
          <MeterLine
            context={context}
            input={input}
            store={controller.store}
            rev={rev}
            beat={beat}
            options={options}
          />
        ),
      })

    return (): void => {
      clearInterval(timer)
      unregister()
      controller.dispose()
    }
  },
})
