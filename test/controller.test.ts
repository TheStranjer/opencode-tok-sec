import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createMeterController } from "../src/controller.ts"
import type { MeterApi } from "../src/controller.ts"

type Handler = (event: any) => void
type RunState = "idle" | "running"

type Harness = {
  readonly api: MeterApi
  readonly emit: (type: string, data: unknown, created?: number) => void
  readonly handlers: Map<string, Handler>
  readonly setStatus: (next: RunState) => void
}

/**
 * Minimal fake of the V2 TUI plugin context's `data` surface.
 * @returns A fake API plus emit/inspect helpers for controller tests.
 */
function harness(): Harness {
  const handlers = new Map<string, Handler>()
  let status: RunState = "running"

  const api = {
    on(type: string, handler: Handler): () => void {
      handlers.set(type, handler)
      return (): void => {
        handlers.delete(type)
      }
    },
    session: {
      status: (): RunState => status,
    },
  } as unknown as MeterApi

  return {
    api,
    handlers,
    emit: (type: string, data: unknown, created: number = Date.now()): void => {
      handlers.get(type)?.({ id: `e_${type}_${handlers.size}`, created, type, data })
    },
    setStatus: (next: RunState): void => {
      status = next
    },
  }
}

const CONFIG = { rollingWindowMs: 5000, idleTimeoutMs: 1500, minSpanMs: 300 },

  stream = (sessionID: string, text: string): Record<string, unknown> => ({ sessionID, assistantMessageID: "a1", ordinal: 0, delta: text }),
  execution = (sessionID: string): Record<string, unknown> => ({ sessionID }),
  step = (sessionID: string, tokens: { readonly output: number; readonly reasoning: number }): Record<string, unknown> => ({
    sessionID,
    assistantMessageID: "a1",
    finish: "stop",
    cost: 0,
    tokens: { input: 0, cache: { read: 0, write: 0 }, ...tokens },
  })

describe("createMeterController", () => {
  it("records text deltas while the session is running", () => {
    const rig = harness()
    let updates = 0
    const controller = createMeterController(rig.api, CONFIG, () => {
      updates += 1
    })

    rig.emit("session.text.delta", stream("s1", "abcdefgh"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 2)
    assert.equal(updates, 1)
  })

  it("counts reasoning deltas too", () => {
    const rig = harness(),
      controller = createMeterController(rig.api, CONFIG, () => {})
    rig.emit("session.reasoning.delta", stream("s1", "abcdefgh"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 2)
  })

  it("ignores empty deltas", () => {
    const rig = harness()
    let updates = 0
    const controller = createMeterController(rig.api, CONFIG, () => {
      updates += 1
    })
    rig.emit("session.text.delta", stream("s1", ""))
    assert.equal(controller.store.size, 0)
    assert.equal(updates, 0)
  })

  it("ignores deltas while the session is idle", () => {
    const rig = harness()
    rig.setStatus("idle")
    const controller = createMeterController(rig.api, CONFIG, () => {})
    rig.emit("session.text.delta", stream("s1", "abcdefgh"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4), undefined)
  })

  it("settles with exact tokens summed across steps", () => {
    const rig = harness()
    let updates = 0
    const controller = createMeterController(rig.api, CONFIG, () => {
      updates += 1
    })
    rig.emit("session.execution.started", execution("s1"))
    rig.emit("session.text.delta", stream("s1", "abcdefgh"))
    rig.emit("session.step.ended", step("s1", { output: 120, reasoning: 8 }))
    rig.emit("session.step.ended", step("s1", { output: 5, reasoning: 2 }))
    rig.emit("session.execution.succeeded", execution("s1"))
    const snap = controller.store.snapshot("s1", Date.now(), 4)
    assert.equal(snap?.settled, true)
    assert.equal(snap.tokens, 135)
    assert.ok(updates >= 3)
  })

  it("settles on failed and interrupted executions", () => {
    for (const type of ["session.execution.failed", "session.execution.interrupted"] as const) {
      const rig = harness(),
        controller = createMeterController(rig.api, CONFIG, () => {})
      rig.emit("session.execution.started", execution("s1"))
      rig.emit("session.text.delta", stream("s1", "abcdefgh"))
      rig.emit(type, execution("s1"))
      assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.settled, true, type)
    }
  })

  it("accumulates exact tokens from failed steps", () => {
    const rig = harness(),
      controller = createMeterController(rig.api, CONFIG, () => {})
    rig.emit("session.execution.started", execution("s1"))
    rig.emit("session.text.delta", stream("s1", "abcdefgh"))
    rig.emit("session.step.failed", {
      sessionID: "s1",
      assistantMessageID: "a1",
      error: { name: "ProviderAuthError" },
      tokens: { input: 0, output: 40, reasoning: 2, cache: { read: 0, write: 0 } },
    })
    rig.emit("session.execution.failed", execution("s1"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 42)
  })

  it("opens a turn on execution start to measure TTFT", () => {
    const rig = harness(),
      controller = createMeterController(rig.api, CONFIG, () => {}),
      created = Date.now() - 500
    rig.emit("session.execution.started", execution("s1"), created)
    rig.emit("session.text.delta", stream("s1", "abcdefgh"))
    const snap = controller.store.snapshot("s1", Date.now(), 4)
    assert.ok(snap?.ttftMs !== undefined)
    assert.ok(snap.ttftMs >= 500)
  })

  it("anchors TTFT to the first step dispatch time", () => {
    const rig = harness(),
      controller = createMeterController(rig.api, CONFIG, () => {})
    rig.emit("session.execution.started", execution("s1"), Date.now() - 900)
    rig.emit("session.step.started", {
      sessionID: "s1",
      assistantMessageID: "a1",
      agent: "build",
      model: { id: "m", providerID: "p" },
      started: Date.now() - 400,
    })
    rig.emit("session.text.delta", stream("s1", "abcdefgh"))
    const snap = controller.store.snapshot("s1", Date.now(), 4)
    assert.ok((snap?.ttftMs ?? 0) >= 400)
    assert.ok((snap?.ttftMs ?? 0) < 900)
  })

  it("restarts the live rate when a tool is called", () => {
    const rig = harness()
    let updates = 0
    const controller = createMeterController(rig.api, CONFIG, () => {
      updates += 1
    })
    rig.emit("session.text.delta", stream("s1", "abcdefgh"))
    rig.emit("session.tool.called", { sessionID: "s1", assistantMessageID: "a1", id: "t1", name: "bash", input: {}, executed: true })
    const snap = controller.store.snapshot("s1", Date.now(), 4)
    assert.equal(controller.store.size, 1)
    assert.equal(snap?.tokens, 2)
    assert.equal(snap.rate, -1)
    assert.ok(updates >= 2)
  })

  it("treats a later step start as a burst boundary, keeping totals", () => {
    const rig = harness(),
      controller = createMeterController(rig.api, CONFIG, () => {})
    rig.emit("session.execution.started", execution("s1"))
    rig.emit("session.text.delta", stream("s1", "abcdefgh"))
    rig.emit("session.step.started", {
      sessionID: "s1",
      assistantMessageID: "a2",
      agent: "build",
      model: { id: "m", providerID: "p" },
      started: Date.now(),
    })
    const snap = controller.store.snapshot("s1", Date.now(), 4)
    assert.equal(snap?.tokens, 2)
    assert.equal(snap.rate, -1)
  })

  it("records deltas even when the execution start was missed", () => {
    const rig = harness(),
      controller = createMeterController(rig.api, CONFIG, () => {})
    rig.emit("session.text.delta", stream("s1", "abcdefgh"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 2)
  })

  it("keeps the held frame until the next execution streams tokens", () => {
    const rig = harness(),
      controller = createMeterController(rig.api, CONFIG, () => {})
    rig.emit("session.execution.started", execution("s1"))
    rig.emit("session.text.delta", stream("s1", "abcdefgh"))
    rig.emit("session.execution.succeeded", execution("s1"))
    rig.emit("session.execution.started", execution("s1"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.settled, true)
    rig.emit("session.text.delta", stream("s1", "abcdefgh"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.settled, false)
  })

  it("ignores step events for unknown sessions", () => {
    const rig = harness()
    let updates = 0
    const controller = createMeterController(rig.api, CONFIG, () => {
      updates += 1
    })
    rig.emit("session.step.ended", step("missing", { output: 10, reasoning: 1 }))
    rig.emit("session.tool.called", { sessionID: "missing", assistantMessageID: "a1", id: "t1", name: "bash", input: {}, executed: true })
    rig.emit("session.execution.succeeded", execution("missing"))
    assert.equal(controller.store.size, 0)
    assert.equal(updates, 0)
  })

  it("forgets a session when it is deleted", () => {
    const rig = harness(),
      controller = createMeterController(rig.api, CONFIG, () => {})
    rig.emit("session.text.delta", stream("s1", "abcdefgh"))
    assert.equal(controller.store.size, 1)
    rig.emit("session.deleted", execution("s1"))
    assert.equal(controller.store.size, 0)
    assert.equal(controller.store.snapshot("s1", Date.now(), 4), undefined)
  })

  it("unsubscribes everything on dispose", () => {
    const rig = harness(),
      controller = createMeterController(rig.api, CONFIG, () => {})
    assert.equal(rig.handlers.size, 11)
    controller.dispose()
    assert.equal(rig.handlers.size, 0)
  })

  it("tick prunes the store and notifies", () => {
    const rig = harness()
    let updates = 0
    const controller = createMeterController(rig.api, CONFIG, () => {
      updates += 1
    })
    rig.emit("session.text.delta", stream("s1", "abcdefgh"))
    updates = 0
    controller.tick(Date.now())
    assert.equal(updates, 1)
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 2)
  })
})
