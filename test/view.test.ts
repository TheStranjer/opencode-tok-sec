import assert from "node:assert/strict"
import { createMeterView } from "../src/view.ts"
import type { MeterView, MeterViewOptions, MeterViewProps } from "../src/view.ts"
import { createRoot, createSignal } from "solid-js"
import { describe, it } from "node:test"
import type { Context } from "@opencode/plugin/tui/context"
import { formatLine } from "../src/display.ts"
import type { MeterController } from "../src/controller.ts"
import { MeterStore } from "../src/meter.ts"
import type { Snapshot } from "../src/meter.ts"

type Handles = {
  readonly invalidate: () => void
  readonly tick: () => void
}

type StoreDouble = {
  readonly calls: () => number
  readonly columns: () => number
  readonly set: (next: Snapshot | undefined) => void
  readonly store: MeterController["store"]
}

type DoubleState = {
  asks: number
  current: Snapshot | undefined
  width: number
}

const CONFIG = { idleTimeoutMs: 1500, minSpanMs: 300, rollingWindowMs: 5000 },

  FRAME: MeterViewProps["input"] = { mode: "normal", sessionID: "s1", showDetails: false },

  HOME: MeterViewProps["input"] = { mode: "normal", showDetails: false },

  IDLE = frame({ peak: 0, rate: -1, tokens: 0, trend: "none", vu: [] }),

  OPTIONS: MeterViewOptions = {
    alwaysShow: false,
    fastTps: 30,
    idleText: "idle",
    label: "tok/s",
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
  },

  THEME = {
    text: {
      feedback: { error: { base: "slow" }, success: { base: "fast" }, warning: { base: "medium" } },
      muted: "muted",
    },
  },

  CONTEXT = { theme: THEME } as unknown as Context

/**
 * A complete snapshot with only the fields a test cares about replaced.
 * @param overrides - Values to change from the streaming-at-42-tokens/s default.
 * @returns A frame the store would hand the view.
 */
function frame(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    avg: 40,
    elapsed: 2000,
    live: true,
    peak: 45,
    peakBucket: 45,
    rate: 42,
    settled: false,
    tokens: 120,
    trend: "up",
    trendPct: 10,
    ttftMs: 800,
    vu: [18, 33, 45],
    ...overrides,
  }
}

/**
 * Stand in for the meter store, recording the frames the view asks for.
 * @returns The store double plus the handles to drive and inspect it.
 */
function storeDouble(): StoreDouble {
  const state: DoubleState = { asks: 0, current: undefined, width: 0 }

  return {
    calls: (): number => state.asks,
    columns: (): number => state.width,
    set: (next: Snapshot | undefined): void => {
      state.current = next
    },
    store: {
      snapshot: (_sessionID: string, _at: number, columns: number): Snapshot | undefined => {
        state.asks += 1
        state.width = columns
        return state.current
      },
    } as unknown as MeterController["store"],
  }
}

/**
 * Mount the view in its own reactive root, the way a slot claim does, and
 * dispose that root whatever the caller asserts. Needs Solid's client build,
 * which `npm test` selects with `--conditions=browser`: Solid's Node build
 * evaluates each memo exactly once, so nothing here would react at all.
 * @param check - Runs with the mounted view and its invalidation handles.
 * @param overrides - Props to swap out: the store, the slot input, the options.
 */
function withView(
  check: (view: MeterView, handles: Handles) => void,
  overrides: Partial<MeterViewProps> = {},
): void {
  createRoot((dispose): void => {
    const [beat, setBeat] = createSignal(0),
      [rev, setRev] = createSignal(0),
      empty = storeDouble()

    try {
      check(
        createMeterView({
          beat,
          context: CONTEXT,
          input: FRAME,
          options: OPTIONS,
          rev,
          store: empty.store,
          ...overrides,
        }),
        {
          invalidate: (): void => {
            setRev((prev): number => prev + 1)
          },
          tick: (): void => {
            setBeat((prev): number => prev + 1)
          },
        },
      )
    } finally {
      dispose()
    }
  })
}

describe("createMeterView", () => {
  it("mounts without reading a memo before its declaration", () => {
    /* Solid runs a memo body the instant it is declared, so every memo has to
     * be declared after the memos it reads. This graph used to declare its
     * snapshot memo last, which made the first memo read a name still in its
     * temporal dead zone: `Cannot access 'snapshot' before initialization`,
     * thrown on mount, taking the whole prompt.footer.status contribution down
     * and leaving the footer blank. */
    withView((view) => {
      assert.equal(view.frame(), undefined)
      assert.equal(view.live(), false)
      assert.equal(view.shown(), false)
      assert.equal(view.text(), "")
      assert.equal(view.tint(), "muted")
    })
  })

  it("stays hidden while the session holds no data", () => {
    const double = storeDouble()
    double.set(IDLE)
    withView((view) => {
      assert.equal(view.live(), false)
      assert.equal(view.shown(), false)
      assert.equal(view.text(), "")
    }, { store: double.store })
  })

  it("renders nothing when the prompt has no session", () => {
    withView((view) => {
      assert.equal(view.frame(), undefined)
      assert.equal(view.shown(), false)
    }, { input: HOME })
  })

  it("appears in the footer once an event brings the session data", () => {
    const double = storeDouble()
    withView((view, handles) => {
      assert.equal(view.shown(), false, "nothing to show before the first frame")
      double.set(frame())
      handles.invalidate()
      assert.equal(view.live(), true)
      assert.equal(view.shown(), true)
      assert.equal(view.text(), formatLine(frame(), OPTIONS))
    }, { store: double.store })
  })

  it("holds the idle placeholder when alwaysShow is on", () => {
    const double = storeDouble()
    double.set(IDLE)
    withView(
      (view) => {
        assert.equal(view.shown(), true)
        assert.equal(view.text(), "tok/s idle")
      },
      { options: { ...OPTIONS, alwaysShow: true }, store: double.store },
    )
  })

  for (const [rate, tint] of [[-1, "muted"], [5, "slow"], [12, "medium"], [42, "fast"]] as const) {
    it(`tints a rate of ${rate} tokens per second as ${tint}`, () => {
      const double = storeDouble()
      double.set(frame({ rate }))
      withView(
        (view) => {
          assert.equal(view.tint(), tint)
        },
        { store: double.store },
      )
    })
  }

  it("asks the store for the configured number of columns", () => {
    const double = storeDouble()
    withView(
      (view) => {
        view.frame()
        assert.equal(double.columns(), 20)
      },
      { options: { ...OPTIONS, vuColumns: 20 }, store: double.store },
    )
  })

  it("re-derives the frame on every per-second beat", () => {
    const double = storeDouble()
    withView((view, handles) => {
      view.frame()
      const before = double.calls()
      handles.tick()
      view.frame()
      assert.ok(double.calls() > before, "the beat invalidates the frame")
    }, { store: double.store })
  })

  it("renders what the real store measures", () => {
    const store = new MeterStore(CONFIG)
    store.record("s1", "a".repeat(40))
    withView((view) => {
      assert.equal(view.live(), true)
      assert.equal(view.shown(), true)
      assert.ok(view.text().startsWith("tok/s "), view.text())
      assert.ok(view.text().includes(" · avg "), view.text())
    }, { store })
  })
})
