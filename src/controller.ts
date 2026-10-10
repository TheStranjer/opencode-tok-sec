/**
 * Translates OpenCode V2 TUI data events into calls on the `MeterStore`.
 * Kept free of JSX so it can be exercised with a fake `data` facade in tests;
 * the rendering layer only reads `store.snapshot()`.
 *
 * V2 emits one assistant message per model step, so a metered "turn" is an
 * execution, not a message:
 *   - `session.execution.started` opens the turn (pending held frame).
 *   - `session.step.started` anchors TTFT to the first request dispatch and
 *     marks burst boundaries for every later request.
 *   - `session.text.delta` / `session.reasoning.delta` carry streamed chunks.
 *   - `session.tool.called` restarts the live rate across the tool pause.
 *   - `session.step.ended` / `session.step.failed` accumulate the provider's
 *     exact output tokens.
 *   - `session.execution.succeeded` / `.failed` / `.interrupted` settle the
 *     turn and freeze the final frame.
 *   - `session.deleted` frees that session's meter.
 */
import type { Data } from "@opencode/plugin/tui/context"
import { MeterStore } from "./meter.ts"
import type { RateConfig } from "./meter.ts"

/** The typed event + cached-state surface the controller consumes. */
export type MeterApi = Data

export type MeterController = {
  readonly dispose: () => void
  readonly store: MeterStore
  readonly tick: (now?: number) => void
}

type Streamed = { readonly data: { readonly delta: string; readonly sessionID: string } }
type SessionEvent = { readonly data: { readonly sessionID: string } }
type StepTokens = {
  readonly data: {
    readonly sessionID: string
    readonly tokens?: { readonly output: number; readonly reasoning: number }
  }
}

type Registrations = {
  readonly stops: Array<() => void>
  readonly store: MeterStore
}

/**
 * Subscribe every metered event, mutating nothing outside the returned
 * registrations. Unsubscription closures land in `stops` in subscription
 * order; `dispose` drains them in that same order.
 * @param config - Rate estimator tunables for the store's meters.
 * @param data - Typed event + cached-state facade to subscribe through.
 * @param onChange - Called after every state-changing event.
 * @returns The store and the unsubscribe handles for its subscriptions.
 */
function registerMeterEvents(config: RateConfig, data: MeterApi, onChange: () => void): Registrations {
  const countStream = (event: Streamed): void => {
      const { delta, sessionID } = event.data
      if (!sessionID || !delta) {
        return
      }
      if (data.session.status(sessionID) === "idle") {
        return
      }
      meter.record(sessionID, delta)
      onChange()
    },

    /* Built before any subscription below is taken out: a handler that fired
     * while `data.on` was still registering would read this name in its
     * temporal dead zone and throw out of the plugin's setup. */
    meter = new MeterStore(config),
    noteStepTokens = (event: StepTokens): void => {
      const { tokens } = event.data
      if (tokens) {
        meter.noteExact(event.data.sessionID, tokens.output + tokens.reasoning)
      }
    },
    settleTurn = (event: SessionEvent): void => {
      if (meter.settle(event.data.sessionID)) {
        onChange()
      }
    },
    stops = [
      data.on("session.execution.started", (event) => {
        meter.beginTurn(event.data.sessionID, event.created)
        onChange()
      }),
      data.on("session.step.started", (event) => {
        meter.beginRequest(event.data.sessionID, event.data.started)
        onChange()
      }),
      data.on("session.text.delta", countStream),
      data.on("session.reasoning.delta", countStream),
      data.on("session.tool.called", (event) => {
        if (meter.newSegment(event.data.sessionID)) {
          onChange()
        }
      }),
      data.on("session.step.ended", noteStepTokens),
      data.on("session.step.failed", noteStepTokens),
      data.on("session.execution.succeeded", settleTurn),
      data.on("session.execution.failed", settleTurn),
      data.on("session.execution.interrupted", settleTurn),
      data.on("session.deleted", (event) => {
        if (meter.drop(event.data.sessionID)) {
          onChange()
        }
      }),
    ]

  return { stops, store: meter }
}

/**
 * Build the meter subsystem for one TUI plugin instance.
 * @param data - Typed event + cached-state facade to subscribe through.
 * @param config - Rate estimator tunables for the store's meters.
 * @param onChange - Called after every state-changing event and tick.
 * @returns The store plus its `tick`/`dispose` controls.
 */
export function createMeterController(
  data: MeterApi,
  config: RateConfig,
  onChange: () => void,
): MeterController {
  const { stops, store } = registerMeterEvents(config, data, onChange)

  return {
    dispose: (): void => {
      for (const stop of stops.splice(0)) {
        stop()
      }
    },
    store,
    tick: (now: number = Date.now()): void => {
      store.prune(now)
      onChange()
    },
  }
}
