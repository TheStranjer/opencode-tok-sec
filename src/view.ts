/**
 * Reactive view model behind the footer line: one memo per derivation, from the
 * store's snapshot down to the text and color the slot renders. Split from
 * `tui.tsx` (JSX glue) so the memo graph can be exercised in tests without a
 * renderer. Measurement lives in `meter.ts`, formatting in `display.ts`.
 *
 * Solid runs a `createMemo` body the instant the memo is declared, so every
 * memo here has to be declared AFTER the memos its body reads. `sort-vars`
 * wants a single declaration list alphabetical, so the names below are chosen
 * to make those two orders the same: `frame` leads and `live`, `shown`, `text`
 * and `tint` read only what precedes them. Rename one to something that sorts
 * earlier than its own source and the memo graph throws on mount with
 * `Cannot access 'snapshot' before initialization`, which takes the whole
 * `prompt.footer.status` contribution down and leaves the footer blank.
 */
import type { Context, SlotMap } from "@opencode/plugin/tui/context"
import type { DisplayOptions, Tier } from "./display.ts"
import { createMemo } from "solid-js"
import { formatLine, hasData, rateTier } from "./display.ts"
import type { MeterController } from "./controller.ts"
import type { RGBA } from "@opentui/core"
import type { Snapshot } from "./meter.ts"

/** What the line shows: display toggles, color bands, and the idle placeholder. */
export type MeterViewOptions = DisplayOptions & {
  readonly alwaysShow: boolean
  readonly fastTps: number
  readonly idleText: string
  readonly slowTps: number
}

/** Everything the view reads, as accessors where reactivity matters. */
export type MeterViewProps = {
  readonly beat: () => number
  readonly context: Context
  readonly input: SlotMap["prompt.footer.status"]
  readonly options: MeterViewOptions
  readonly rev: () => number
  readonly store: MeterController["store"]
}

/** The footer's derivations, in the order they are built. */
export type MeterView = {
  readonly frame: () => Snapshot | undefined
  readonly live: () => boolean
  readonly shown: () => boolean
  readonly text: () => string
  readonly tint: () => RGBA
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
 * Build the footer line's reactive graph for one mounted slot claim.
 * @param props - Slot input, meter store, invalidation signals, options.
 * @returns The frame and everything the footer renders from it.
 */
export function createMeterView(props: MeterViewProps): MeterView {
  const { options } = props,
    frame = createMemo((): Snapshot | undefined => {
      props.rev()
      props.beat()
      const { sessionID } = props.input
      if (sessionID === undefined || sessionID.length === 0) {
        return undefined
      }
      return props.store.snapshot(sessionID, Date.now(), options.vuColumns)
    }),
    live = createMemo((): boolean => hasData(frame())),
    shown = createMemo((): boolean => live() || options.alwaysShow),
    text = createMemo((): string => {
      const state = frame()
      if (state === undefined || !live()) {
        return options.alwaysShow ? `${options.label} ${options.idleText}` : ""
      }
      return formatLine(state, options)
    }),
    tint = createMemo((): RGBA => {
      const state = frame(),
        { theme } = props.context
      if (state === undefined) {
        return theme.text.muted
      }
      return tierColor(theme, rateTier(state.rate, options.slowTps, options.fastTps))
    })

  return { frame, live, shown, text, tint }
}
