/** @jsxImportSource @opentui/solid */
/**
 * OpenCode V2 TUI plugin. Claims the `prompt.footer.status` slot, wires server
 * events through `createMeterController`, and renders one reactive line from
 * the store's snapshot. All measurement lives in `meter.ts`.
 */
import { Plugin } from "@opencode/plugin/tui"
import type { Context, SlotMap } from "@opencode/plugin/tui/context"
import { Show, createMemo, createSignal } from "solid-js"
import { createMeterController, type MeterController } from "./controller.ts"
import { formatLine, hasData, rateTier, type Tier, type VuScale } from "./meter.ts"

export type TokSecOptions = {
  enabled?: boolean
  rollingWindowMs?: number
  idleTimeoutMs?: number
  minSpanMs?: number
  vuColumns?: number
  vuFullTps?: number
  vuScale?: VuScale
  slowTps?: number
  fastTps?: number
  showVu?: boolean
  showTrend?: boolean
  showAvg?: boolean
  showPeak?: boolean
  showTtft?: boolean
  showTokenCount?: boolean
  showElapsed?: boolean
  alwaysShow?: boolean
  idleText?: string
  label?: string
}

const DEFAULTS = {
  enabled: true,
  rollingWindowMs: 5000,
  idleTimeoutMs: 1500,
  minSpanMs: 300,
  vuColumns: 12,
  vuFullTps: 50,
  vuScale: "auto" as VuScale,
  slowTps: 10,
  fastTps: 30,
  showVu: true,
  showTrend: true,
  showAvg: true,
  showPeak: true,
  showTtft: true,
  showTokenCount: false,
  showElapsed: false,
  alwaysShow: false,
  idleText: "idle",
  label: "tok/s",
} satisfies Required<TokSecOptions>

type ResolvedOptions = typeof DEFAULTS
type FooterInput = SlotMap["prompt.footer.status"]

function tierColor(tier: Tier, theme: Context["theme"]) {
  switch (tier) {
    case "slow":
      return theme.text.feedback.error.base
    case "medium":
      return theme.text.feedback.warning.base
    case "fast":
      return theme.text.feedback.success.base
    default:
      return theme.text.muted
  }
}

function MeterLine(props: {
  context: Context
  input: FooterInput
  store: MeterController["store"]
  rev: () => number
  beat: () => number
  options: ResolvedOptions
}) {
  const snapshot = createMemo(() => {
    props.rev()
    props.beat()
    const sessionID = props.input.sessionID
    if (!sessionID) return undefined
    return props.store.snapshot(sessionID, Date.now(), props.options.vuColumns)
  })

  const active = createMemo(() => hasData(snapshot()))

  const mounted = createMemo(() => active() || props.options.alwaysShow)

  const text = createMemo(() => {
    const state = snapshot()
    if (!active() || !state) {
      return props.options.alwaysShow ? `${props.options.label} ${props.options.idleText}` : ""
    }
    return formatLine(state, props.options)
  })

  const color = createMemo(() => {
    const theme = props.context.theme
    const state = snapshot()
    if (!state) return theme.text.muted
    return tierColor(rateTier(state.rate, props.options.slowTps, props.options.fastTps), theme)
  })

  return (
    <Show when={mounted()}>
      <text fg={color()}>{text()}</text>
    </Show>
  )
}

export default Plugin.define({
  id: "tok-sec",
  setup(context) {
    const options: ResolvedOptions = { ...DEFAULTS, ...((context.options ?? {}) as Partial<ResolvedOptions>) }
    if (!options.enabled) return

    const [rev, setRev] = createSignal(0)
    const [beat, setBeat] = createSignal(0)
    const controller = createMeterController(context.data, options, () => setRev((n) => n + 1))

    const timer = setInterval(() => {
      controller.tick()
      setBeat((n) => n + 1)
    }, 1000)

    const unregister = context.ui.slot({
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

    return () => {
      clearInterval(timer)
      unregister()
      controller.dispose()
    }
  },
})
