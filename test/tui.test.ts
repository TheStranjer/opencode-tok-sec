/**
 * Footer width tracking against a REAL `@opentui/core` `TextRenderable` in
 * the core testing renderer. The `view.test.ts` cases drive the width
 * accessor directly and therefore cannot catch a mis-wired event: OCTS-2
 * listened for `"resize"`, which `<text>` nodes never emit (`TextBufferRenderable`
 * overrides `onResize` without calling super and emits `"line-info-change"`),
 * so the meter line kept wrapping to two footer rows. These cases mount the
 * same element kinds the footer row contains — interrupt hint, meter line,
 * command hint — side by side in a row narrower than the full line and
 * assert the rendered rows and the details that survive. Where the native
 * renderer cannot start (no `node:ffi`; run via `npm test`, which enables
 * `--experimental-ffi` on Node >= 26.1) the cases skip instead of failing.
 */
import assert from "node:assert/strict"
import { BoxRenderable, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { TestRendererSetup } from "@opentui/core/testing"
import { describe, it } from "node:test"
import { formatLine, formatLineFitting } from "../src/display.ts"
import type { Snapshot } from "../src/meter.ts"
import type { MeterViewOptions } from "../src/view.ts"
import { trackFooterWidth } from "../src/tui.tsx"

type Harness = {
  readonly command: TextRenderable
  readonly meter: TextRenderable
  readonly row: BoxRenderable
  readonly setup: TestRendererSetup
}

const COMMAND = " ctrl+p command",

  ESC = "esc interrupt ",

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

  SNAPSHOT: Snapshot = {
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
  },

  TERMINAL_WIDTH = 80,

  /** Columns the two fixed hints take off the 80-column footer row. */
  HINT_COLUMNS = ESC.length + COMMAND.length,

  /** Any VU block glyph, present only while the graph has not been dropped. */
  VU_GLYPH = /[▁▂▃▄▅▆▇█]/u,

  /** The line as trimmed to the room the row leaves; detail-free by design. */
  NARROW = formatLineFitting(SNAPSHOT, OPTIONS, TERMINAL_WIDTH - HINT_COLUMNS)

/**
 * Boot the core testing renderer, or report that this runtime cannot start
 * the native library (no `node:ffi`) so the caller can skip instead of fail.
 * @returns A live test renderer, or nothing when none can be created.
 */
async function bootRenderer(): Promise<TestRendererSetup | undefined> {
  try {
    const fresh = await createTestRenderer({ height: 6, width: TERMINAL_WIDTH })
    return fresh
  } catch {
    return undefined
  }
}

/**
 * Mount a footer row: two fixed hints and the meter line whose content is
 * re-fitted from the width `trackFooterWidth` reports, mirroring the memo
 * chain `MeterLine` builds, with one real renderable per real text node.
 * @returns The mounted row parts, or nothing when no native renderer starts.
 */
async function mountRow(): Promise<Harness | undefined> {
  const setup = await bootRenderer()
  if (setup === undefined) {
    return undefined
  }

  const { renderer } = setup,
    row = new BoxRenderable(renderer, { flexDirection: "row", width: TERMINAL_WIDTH }),
    esc = new TextRenderable(renderer, { content: ESC }),
    meter = new TextRenderable(renderer, { content: formatLine(SNAPSHOT, OPTIONS) }),
    command = new TextRenderable(renderer, { content: COMMAND })

  row.add(esc)
  row.add(meter)
  row.add(command)
  renderer.root.add(row)

  let applied = formatLine(SNAPSHOT, OPTIONS)
  trackFooterWidth(meter, renderer, (width): void => {
    const next = formatLineFitting(SNAPSHOT, OPTIONS, width)
    if (next === applied) {
      return
    }
    applied = next
    meter.content = next
  })

  return { command, meter, row, setup }
}

describe("trackFooterWidth", () => {
  it("keeps the meter line on one row and omits details in a narrow row", async (t) => {
    const harness = await mountRow()
    if (harness === undefined) {
      t.skip("native test renderer unavailable (needs node:ffi)")
      return
    }

    try {
      await harness.setup.waitFor(
        (): boolean => harness.meter.plainText === NARROW && harness.meter.height === 1,
      )
      assert.equal(harness.meter.height, 1, "the line renders on one footer row")
      assert.equal(harness.meter.virtualLineCount, 1, "no wrapped virtual lines")
      assert.equal(harness.meter.plainText, NARROW, "the line is the one trimmed to the room left by the hints")
      assert.ok(
        !VU_GLYPH.test(harness.meter.plainText),
        `the graph drops whole before any stat: ${harness.meter.plainText}`,
      )
      assert.ok(harness.meter.plainText.includes("ttft"), `the graph gave the row its room: ${harness.meter.plainText}`)
      assert.ok(harness.meter.plainText.includes("avg"), `the kept-most-important detail survives: ${harness.meter.plainText}`)
    } finally {
      harness.setup.renderer.destroy()
    }
  })

  it("reopens the line when the row has room again without a renderer resize", async (t) => {
    const harness = await mountRow()
    if (harness === undefined) {
      t.skip("native test renderer unavailable (needs node:ffi)")
      return
    }

    try {
      await harness.setup.waitFor(
        (): boolean => harness.meter.plainText === NARROW && harness.meter.height === 1,
      )
      assert.ok(!VU_GLYPH.test(harness.meter.plainText), "the graph starts out omitted")

      harness.row.remove(harness.command)
      await harness.setup.waitFor(
        (): boolean => harness.meter.plainText.includes("▃▆█") && harness.meter.height === 1,
      )

      assert.equal(harness.meter.plainText, formatLine(SNAPSHOT, OPTIONS), "details came back")
      assert.equal(harness.meter.height, 1, "still one footer row")
    } finally {
      harness.setup.renderer.destroy()
    }
  })
})
