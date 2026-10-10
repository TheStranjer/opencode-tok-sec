import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createMeterController, type MeterApi } from "../src/controller.ts"

type Handler = (event: any) => void

/** Minimal fake of the V2 TUI plugin context's `data` surface. */
function harness() {
  const handlers = new Map<string, Handler>()
  let status: "idle" | "running" = "running"

  const api = {
    on(type: string, handler: Handler) {
      handlers.set(type, handler)
      return () => {
        handlers.delete(type)
      }
    },
    session: {
      status: () => status,
    },
  } as unknown as MeterApi

  return {
    api,
    handlers,
    emit: (type: string, data: unknown, created: number = Date.now()) =>
      handlers.get(type)?.({ id: `e_${type}_${handlers.size}`, created, type, data }),
    setStatus: (next: "idle" | "running") => {
      status = next
    },
  }
}

const CONFIG = { rollingWindowMs: 5000, idleTimeoutMs: 1500, minSpanMs: 300 }

const stream = (sessionID: string, text: string) => ({ sessionID, assistantMessageID: "a1", ordinal: 0, delta: text })
const execution = (sessionID: string) => ({ sessionID })
const step = (sessionID: string, tokens: { output: number; reasoning: number }) => ({
  sessionID,
  assistantMessageID: "a1",
  finish: "stop",
  cost: 0,
  tokens: { input: 0, cache: { read: 0, write: 0 }, ...tokens },
})

describe("createMeterController", () => {
  it("records text deltas while the session is running", () => {
    const h = harness()
    let updates = 0
    const controller = createMeterController(h.api, CONFIG, () => {
      updates += 1
    })

    h.emit("session.text.delta", stream("s1", "abcdefgh"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 2)
    assert.equal(updates, 1)
  })

  it("counts reasoning deltas too", () => {
    const h = harness()
    const controller = createMeterController(h.api, CONFIG, () => {})
    h.emit("session.reasoning.delta", stream("s1", "abcdefgh"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 2)
  })

  it("ignores empty deltas", () => {
    const h = harness()
    let updates = 0
    const controller = createMeterController(h.api, CONFIG, () => {
      updates += 1
    })
    h.emit("session.text.delta", stream("s1", ""))
    assert.equal(controller.store.size, 0)
    assert.equal(updates, 0)
  })

  it("ignores deltas while the session is idle", () => {
    const h = harness()
    h.setStatus("idle")
    const controller = createMeterController(h.api, CONFIG, () => {})
    h.emit("session.text.delta", stream("s1", "abcdefgh"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4), undefined)
  })

  it("settles with exact tokens summed across steps", () => {
    const h = harness()
    let updates = 0
    const controller = createMeterController(h.api, CONFIG, () => {
      updates += 1
    })
    h.emit("session.execution.started", execution("s1"))
    h.emit("session.text.delta", stream("s1", "abcdefgh"))
    h.emit("session.step.ended", step("s1", { output: 120, reasoning: 8 }))
    h.emit("session.step.ended", step("s1", { output: 5, reasoning: 2 }))
    h.emit("session.execution.succeeded", execution("s1"))
    const snap = controller.store.snapshot("s1", Date.now(), 4)
    assert.equal(snap?.settled, true)
    assert.equal(snap?.tokens, 135)
    assert.ok(updates >= 3)
  })

  it("settles on failed and interrupted executions", () => {
    for (const type of ["session.execution.failed", "session.execution.interrupted"] as const) {
      const h = harness()
      const controller = createMeterController(h.api, CONFIG, () => {})
      h.emit("session.execution.started", execution("s1"))
      h.emit("session.text.delta", stream("s1", "abcdefgh"))
      h.emit(type, execution("s1"))
      assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.settled, true, type)
    }
  })

  it("accumulates exact tokens from failed steps", () => {
    const h = harness()
    const controller = createMeterController(h.api, CONFIG, () => {})
    h.emit("session.execution.started", execution("s1"))
    h.emit("session.text.delta", stream("s1", "abcdefgh"))
    h.emit("session.step.failed", {
      sessionID: "s1",
      assistantMessageID: "a1",
      error: { name: "ProviderAuthError" },
      tokens: { input: 0, output: 40, reasoning: 2, cache: { read: 0, write: 0 } },
    })
    h.emit("session.execution.failed", execution("s1"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 42)
  })

  it("opens a turn on execution start to measure TTFT", () => {
    const h = harness()
    const controller = createMeterController(h.api, CONFIG, () => {})
    const created = Date.now() - 500
    h.emit("session.execution.started", execution("s1"), created)
    h.emit("session.text.delta", stream("s1", "abcdefgh"))
    const snap = controller.store.snapshot("s1", Date.now(), 4)
    assert.ok(snap?.ttftMs !== undefined)
    assert.ok((snap?.ttftMs ?? 0) >= 500)
  })

  it("anchors TTFT to the first step dispatch time", () => {
    const h = harness()
    const controller = createMeterController(h.api, CONFIG, () => {})
    h.emit("session.execution.started", execution("s1"), Date.now() - 900)
    h.emit("session.step.started", {
      sessionID: "s1",
      assistantMessageID: "a1",
      agent: "build",
      model: { id: "m", providerID: "p" },
      started: Date.now() - 400,
    })
    h.emit("session.text.delta", stream("s1", "abcdefgh"))
    const snap = controller.store.snapshot("s1", Date.now(), 4)
    assert.ok((snap?.ttftMs ?? 0) >= 400)
    assert.ok((snap?.ttftMs ?? 0) < 900)
  })

  it("restarts the live rate when a tool is called", () => {
    const h = harness()
    let updates = 0
    const controller = createMeterController(h.api, CONFIG, () => {
      updates += 1
    })
    h.emit("session.text.delta", stream("s1", "abcdefgh"))
    h.emit("session.tool.called", { sessionID: "s1", assistantMessageID: "a1", id: "t1", name: "bash", input: {}, executed: true })
    const snap = controller.store.snapshot("s1", Date.now(), 4)
    assert.equal(controller.store.size, 1)
    assert.equal(snap?.tokens, 2)
    assert.equal(snap?.rate, -1)
    assert.ok(updates >= 2)
  })

  it("treats a later step start as a burst boundary, keeping totals", () => {
    const h = harness()
    const controller = createMeterController(h.api, CONFIG, () => {})
    h.emit("session.execution.started", execution("s1"))
    h.emit("session.text.delta", stream("s1", "abcdefgh"))
    h.emit("session.step.started", {
      sessionID: "s1",
      assistantMessageID: "a2",
      agent: "build",
      model: { id: "m", providerID: "p" },
      started: Date.now(),
    })
    const snap = controller.store.snapshot("s1", Date.now(), 4)
    assert.equal(snap?.tokens, 2)
    assert.equal(snap?.rate, -1)
  })

  it("records deltas even when the execution start was missed", () => {
    const h = harness()
    const controller = createMeterController(h.api, CONFIG, () => {})
    h.emit("session.text.delta", stream("s1", "abcdefgh"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 2)
  })

  it("keeps the held frame until the next execution streams tokens", () => {
    const h = harness()
    const controller = createMeterController(h.api, CONFIG, () => {})
    h.emit("session.execution.started", execution("s1"))
    h.emit("session.text.delta", stream("s1", "abcdefgh"))
    h.emit("session.execution.succeeded", execution("s1"))
    h.emit("session.execution.started", execution("s1"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.settled, true)
    h.emit("session.text.delta", stream("s1", "abcdefgh"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.settled, false)
  })

  it("ignores step events for unknown sessions", () => {
    const h = harness()
    let updates = 0
    const controller = createMeterController(h.api, CONFIG, () => {
      updates += 1
    })
    h.emit("session.step.ended", step("missing", { output: 10, reasoning: 1 }))
    h.emit("session.tool.called", { sessionID: "missing", assistantMessageID: "a1", id: "t1", name: "bash", input: {}, executed: true })
    h.emit("session.execution.succeeded", execution("missing"))
    assert.equal(controller.store.size, 0)
    assert.equal(updates, 0)
  })

  it("forgets a session when it is deleted", () => {
    const h = harness()
    const controller = createMeterController(h.api, CONFIG, () => {})
    h.emit("session.text.delta", stream("s1", "abcdefgh"))
    assert.equal(controller.store.size, 1)
    h.emit("session.deleted", execution("s1"))
    assert.equal(controller.store.size, 0)
    assert.equal(controller.store.snapshot("s1", Date.now(), 4), undefined)
  })

  it("unsubscribes everything on dispose", () => {
    const h = harness()
    const controller = createMeterController(h.api, CONFIG, () => {})
    assert.equal(h.handlers.size, 11)
    controller.dispose()
    assert.equal(h.handlers.size, 0)
  })

  it("tick prunes the store and notifies", () => {
    const h = harness()
    let updates = 0
    const controller = createMeterController(h.api, CONFIG, () => {
      updates += 1
    })
    h.emit("session.text.delta", stream("s1", "abcdefgh"))
    updates = 0
    controller.tick(Date.now())
    assert.equal(updates, 1)
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 2)
  })
})
