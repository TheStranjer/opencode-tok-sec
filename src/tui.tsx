// @jsxImportSource @opentui/solid
/**
 * OpenCode V2 TUI plugin. Claims the `prompt.footer.status` slot, wires server
 * events through `createMeterController`, and renders one reactive line built by
 * `createMeterView`. All measurement lives in `meter.ts`.
 */
import type { Context } from "@opencode/plugin/tui/context"
import type { DisplayOptions, VuScale } from "./display.ts"
import { Plugin } from "@opencode/plugin/tui"
import { Show, createSignal } from "solid-js"
import type { JSX } from "solid-js"
import type { MeterViewProps } from "./view.ts"
import { createMeterController } from "./controller.ts"
import { createMeterView } from "./view.ts"

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

/**
 * The one-line meter view mounted into the prompt footer.
 * @param props - Context, slot input, store, invalidation signals, options.
 * @returns The footer status element, or nothing when unmounted.
 */
function MeterLine(props: MeterViewProps): JSX.Element {
  const view = createMeterView(props)

  return (
    <Show when={view.shown()}>
      <text fg={view.tint()}>{view.text()}</text>
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

    /* Both signals are declared before the controller: its `onChange` callback
     * runs from the event subscriptions it takes out below, and a signal still
     * in its temporal dead zone would throw out of `setup`, not just a slot. */
    const [beat, setBeat] = createSignal(0),
      [rev, setRev] = createSignal(0),
      controller = createMeterController(context.data, options, (): void => {
        setRev((prev): number => prev + 1)
      }),
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
