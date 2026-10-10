// @jsxImportSource @opentui/solid
/**
 * OpenCode V2 TUI plugin. Claims the `prompt.footer.status` slot, wires server
 * events through `createMeterController`, and renders one reactive line built by
 * `createMeterView`. All measurement lives in `meter.ts`.
 */
import type { CliRenderer, TextRenderable } from "@opentui/core"
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
 * The columns a flex row leaves to one of its children: the row's committed
 * layout width minus what its other visible children have taken. Reports
 * nothing when the element is not laid out in a row, or the row has not been
 * through a layout pass yet, so callers can fall back to the node's own box.
 * @param element - The child whose room on its parent row is measured.
 * @returns The columns the row offers the child, when measurable.
 */
function roomOf(element: TextRenderable): number | undefined {
  const { parent } = element
  if (parent?.primaryAxis !== "row" || parent.width <= 0) {
    return undefined
  }
  let used = 0
  for (const sibling of parent.getChildren()) {
    if (sibling !== element && sibling.visible) {
      used += sibling.width
    }
  }
  return Math.max(1, parent.width - used)
}

/**
 * Keep one renderable's text on a single footer row by reporting the columns
 * its flex row actually offers it through `onWidth`.
 *
 * A `<text>` node never emits `"resize"`: `TextBufferRenderable` overrides
 * `onResize` without calling super and emits `"line-info-change"` instead —
 * on every layout resize and on every content change. That is the event this
 * tracker listens for. While the node is word-wrapped its own layout box is
 * the truth (it holds at most that many columns, so the line must be trimmed
 * to fit); while it fits on one row the box is just the content width and the
 * room is re-derived from the parent row — its width minus what the visible
 * siblings take — instead of latching to the smallest box ever seen. That
 * re-derivation is what lets omitted details come back when a sibling (the
 * "esc interrupt" hint, the context %) shrinks or disappears without the
 * terminal being resized. Layout changes the node is not told about (a
 * sibling destroyed while this line's content stays put resize nothing of
 * its own) are caught by re-measuring after each renderer `"frame"`, deferred
 * off the render pass with `process.nextTick` so the reactive update can
 * still request a render. A terminal resize re-probes at full width. Every
 * reported width is what the previous layout committed, so measuring feeds
 * no value of our own back into Yoga and the probe settles as soon as the
 * row stops moving. Reporting is re-entrancy guarded: a content write made
 * from `onWidth` re-emits `"line-info-change"` synchronously, and such a
 * nested report — reading a box the next layout pass has not caught up with
 * — is dropped, so width can only ever move with committed layout.
 * @param element - The `<text>` renderable carrying the footer line.
 * @param renderer - The renderer whose layout the element is measured in.
 * @param onWidth - Receives the usable column count after each measurement.
 * @returns A disposer removing every listener this tracker registered.
 */
export function trackFooterWidth(
  element: TextRenderable,
  renderer: CliRenderer,
  onWidth: (width: number | undefined) => void,
): () => void {
  let probeQueued = false,
    reporting = false

  const onFrame = (): void => {
      if (probeQueued) {
        return
      }
      probeQueued = true
      process.nextTick((): void => {
        probeQueued = false
        report()
      })
    },
    onResize = (): void => {
      onWidth(renderer.width)
    },
    report = (): void => {
      if (reporting) {
        return
      }
      reporting = true
      try {
        const { width: box } = element
        if (box > 0) {
          const available = roomOf(element)
          if (element.virtualLineCount > element.lineCount) {
            onWidth(available === undefined ? box : Math.min(box, available))
          } else {
            onWidth(available ?? box)
          }
        }
      } finally {
        reporting = false
      }
    }

  element.on("line-info-change", report)
  element.once("destroyed", (): void => {
    element.off("line-info-change", report)
  })
  renderer.on("frame", onFrame)
  renderer.on("resize", onResize)
  report()

  return (): void => {
    element.off("line-info-change", report)
    renderer.off("frame", onFrame)
    renderer.off("resize", onResize)
  }
}

/**
 * The one-line meter view mounted into the prompt footer.
 *
 * The line is kept to a single footer row by `trackFooterWidth`, which feeds
 * the columns the row offers into the view; the view then omits details from
 * least to most important until the line fits them.
 * @param props - Context, slot input, store, invalidation signals, options.
 * @returns The footer status element, or nothing when unmounted.
 */
export function MeterLine(props: MeterViewProps): JSX.Element {
  const [width, setWidth] = createSignal<number | undefined>(props.context.renderer.width),
    view = createMeterView(props, width)

  return (
    <Show when={view.shown()}>
      <text
        ref={(element): void => {
          const dispose = trackFooterWidth(element, props.context.renderer, (next): void => {
            setWidth(next)
          })
          element.once("destroyed", (): void => {
            dispose()
          })
        }}
        fg={view.tint()}
      >
        {view.text()}
      </text>
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
