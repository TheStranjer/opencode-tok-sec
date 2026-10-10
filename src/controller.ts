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
import { MeterStore, type RateConfig } from "./meter.ts"

/** The typed event + cached-state surface the controller consumes. */
export type MeterApi = Data

export type MeterController = {
  store: MeterStore
  tick: (now?: number) => void
  dispose: () => void
}

type Streamed = { data: { sessionID: string; delta: string } }
type SessionEvent = { data: { sessionID: string } }
type StepTokens = { data: { sessionID: string; tokens?: { output: number; reasoning: number } } }

export function createMeterController(
  data: MeterApi,
  config: RateConfig,
  onChange: () => void,
): MeterController {
  const store = new MeterStore(config)
  const stops: Array<() => void> = []

  stops.push(
    data.on("session.execution.started", (event) => {
      store.beginTurn(event.data.sessionID, event.created)
      onChange()
    }),
  )

  stops.push(
    data.on("session.step.started", (event) => {
      store.beginRequest(event.data.sessionID, event.data.started)
      onChange()
    }),
  )

  const countStream = (event: Streamed) => {
    const { sessionID, delta } = event.data
    if (!sessionID || !delta) return
    if (data.session.status(sessionID) === "idle") return
    store.record(sessionID, delta)
    onChange()
  }
  stops.push(data.on("session.text.delta", countStream))
  stops.push(data.on("session.reasoning.delta", countStream))

  stops.push(
    data.on("session.tool.called", (event) => {
      if (store.newSegment(event.data.sessionID)) onChange()
    }),
  )

  const noteStepTokens = (event: StepTokens) => {
    const tokens = event.data.tokens
    if (tokens) store.noteExact(event.data.sessionID, tokens.output + tokens.reasoning)
  }
  stops.push(data.on("session.step.ended", noteStepTokens))
  stops.push(data.on("session.step.failed", noteStepTokens))

  const settleTurn = (event: SessionEvent) => {
    if (store.settle(event.data.sessionID)) onChange()
  }
  stops.push(data.on("session.execution.succeeded", settleTurn))
  stops.push(data.on("session.execution.failed", settleTurn))
  stops.push(data.on("session.execution.interrupted", settleTurn))

  stops.push(
    data.on("session.deleted", (event) => {
      if (store.drop(event.data.sessionID)) onChange()
    }),
  )

  const dispose = () => {
    for (const stop of stops.splice(0)) stop()
  }

  return {
    store,
    dispose,
    tick: (now: number = Date.now()) => {
      store.prune(now)
      onChange()
    },
  }
}
