import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { formatClock, formatCount, formatLine, formatLineFitting, formatRate, hasData, rateTier, renderVu, vuFullScale } from "../src/display.ts"
import { MeterStore, TpsMeter, approxTokens, measureRate } from "../src/meter.ts"
import type { DisplayOptions } from "../src/display.ts"
import type { Sample, Snapshot } from "../src/meter.ts"

const CONFIG = { rollingWindowMs: 1000, idleTimeoutMs: 500, minSpanMs: 200 },
 SECOND_MS = 1000,
 WIDE = { rollingWindowMs: 60_000, idleTimeoutMs: 60_000, minSpanMs: 200 }

describe("approxTokens", () => {
  it("returns 0 for empty input", () => {
    assert.equal(approxTokens(""), 0)
  })

  it("rounds bytes divided by four", () => {
    assert.equal(approxTokens("abcd"), 1)
    assert.equal(approxTokens("abcdefgh"), 2)
    assert.equal(approxTokens("a".repeat(100)), 25)
  })

  it("counts multi-byte characters", () => {
    assert.ok(approxTokens("日本") >= 1)
  })
})

describe("measureRate", () => {
  it("returns -1 with no samples", () => {
    assert.equal(measureRate([], 1000, CONFIG), -1)
  })

  it("uses the minimum span for a single fresh sample", () => {
    const samples: Array<Sample> = [{ at: 1000, tokens: 10 }]
    assert.equal(measureRate(samples, 1000, CONFIG), 50)
  })

  it("uses elapsed span once it exceeds the minimum", () => {
    const samples: Array<Sample> = [{ at: 0, tokens: 10 }]
    assert.equal(measureRate(samples, 400, CONFIG), 25)
  })

  it("returns -1 once the newest sample is idle", () => {
    const samples: Array<Sample> = [{ at: 0, tokens: 10 }]
    assert.equal(measureRate(samples, 600, CONFIG), -1)
  })

  it("ignores samples outside the rolling window", () => {
    const samples: Array<Sample> = [
      { at: 0, tokens: 10 },
      { at: 900, tokens: 10 },
    ]
    assert.equal(measureRate(samples, 1010, CONFIG), 50)
  })

  it("scales with token count", () => {
    const low = measureRate([{ at: 900, tokens: 5 }], 1000, CONFIG),
     high = measureRate([{ at: 900, tokens: 50 }], 1000, CONFIG)
    assert.ok(high > low)
  })
})

describe("formatters", () => {
  it("formatRate", () => {
    assert.equal(formatRate(-1), "-")
    assert.equal(formatRate(12.34), "12.3")
    assert.equal(formatRate(150), "150")
  })

  it("formatCount", () => {
    assert.equal(formatCount(0), "0")
    assert.equal(formatCount(999), "999")
    assert.equal(formatCount(1500), "1.5k")
    assert.equal(formatCount(2_500_000), "2.5m")
  })

  it("formatClock", () => {
    assert.equal(formatClock(0), "0.0s")
    assert.equal(formatClock(500), "0.5s")
    assert.equal(formatClock(59_000), "59.0s")
    assert.equal(formatClock(60_000), "1m0s")
    assert.equal(formatClock(65_000), "1m5s")
    assert.equal(formatClock(-100), "0.0s")
  })

  it("rateTier boundaries", () => {
    assert.equal(rateTier(-1, 10, 30), "idle")
    assert.equal(rateTier(9.99, 10, 30), "slow")
    assert.equal(rateTier(10, 10, 30), "medium")
    assert.equal(rateTier(29.99, 10, 30), "medium")
    assert.equal(rateTier(30, 10, 30), "fast")
    assert.equal(rateTier(500, 10, 30), "fast")
  })
})

describe("formatLine", () => {
  const base: Snapshot = {
    rate: 42.5,
    avg: 38.2,
    live: true,
    settled: false,
    tokens: 1200,
    elapsed: 12_000,
    peak: 61,
    peakBucket: 55,
    trend: "up",
    trendPct: 18,
    ttftMs: 800,
    vu: [10, 20, 30, 40],
  },
   options: DisplayOptions = {
    label: "tok/s",
    showVu: true,
    vuColumns: 12,
    vuScale: "auto",
    vuFullTps: 50,
    showTrend: true,
    showAvg: true,
    showPeak: true,
    showTtft: true,
    showTokenCount: false,
    showElapsed: false,
  },
   /* The graph is a fixed twelve columns, so the four buckets of `base` sit at
    * its right edge, next to the rate, behind eight blank cells. */
   GRAPH = "▁▃▄▆".padStart(options.vuColumns),
   BLANKS = " ".repeat(options.vuColumns)

  it("renders the default line", () => {
    assert.equal(formatLine(base, options), `tok/s ${GRAPH} 42.5 ▲ 18% · avg 38.2 · pk 61.0 · ttft 0.8s`)
  })

  it("omits the graph when showVu is false", () => {
    assert.equal(formatLine(base, { ...options, showVu: false }), "tok/s 42.5 ▲ 18% · avg 38.2 · pk 61.0 · ttft 0.8s")
  })

  it("omits the trend when showTrend is false", () => {
    assert.equal(formatLine(base, { ...options, showTrend: false }), `tok/s ${GRAPH} 42.5 · avg 38.2 · pk 61.0 · ttft 0.8s`)
  })

  it("hides the trend while the rate is inactive", () => {
    const line = formatLine({ ...base, rate: -1, trend: "none" }, options)
    assert.ok(!line.includes("▲"))
    assert.ok(line.includes(`${GRAPH} -`), line)
  })

  it("adds token count and elapsed when enabled", () => {
    const line = formatLine(base, { ...options, showTokenCount: true, showElapsed: true })
    assert.ok(line.endsWith("· avg 38.2 · pk 61.0 · ttft 0.8s · 1.2k tok · 12.0s"))
  })

  it("holds the graph's full width before the first bucket arrives", () => {
    /* An empty history is the one case where nothing but blanks is rendered,
     * and even then the twelve cells are reserved: the line cannot jump when
     * the turn's first second lands. */
    assert.equal(
      formatLine({ ...base, vu: [] }, options),
      `tok/s ${BLANKS} 42.5 ▲ 18% · avg 38.2 · pk 61.0 · ttft 0.8s`,
    )
    assert.equal(formatLine({ ...base, vu: [] }, options).length, formatLine(base, options).length)
  })

  it("omits the graph entirely when there are no columns", () => {
    assert.equal(
      formatLine(base, { ...options, vuColumns: 0 }),
      "tok/s 42.5 ▲ 18% · avg 38.2 · pk 61.0 · ttft 0.8s",
    )
  })

  it("omits ttft when it is unknown", () => {
    const line = formatLine({ ...base, ttftMs: undefined }, options)
    assert.ok(line.endsWith("· avg 38.2 · pk 61.0"))
  })

  it("pads the trend percentage to three digit slots", () => {
    const tail = " · avg 38.2 · pk 61.0 · ttft 0.8s"
    assert.equal(formatLine({ ...base, trendPct: 130 }, options), `tok/s ${GRAPH} 42.5 ▲130%${tail}`)
    assert.equal(formatLine({ ...base, trendPct: 18 }, options), `tok/s ${GRAPH} 42.5 ▲ 18%${tail}`)
    assert.equal(formatLine({ ...base, trendPct: 8 }, options), `tok/s ${GRAPH} 42.5 ▲  8%${tail}`)
    assert.equal(formatLine({ ...base, trendPct: 9.4 }, options), `tok/s ${GRAPH} 42.5 ▲  9%${tail}`)
    assert.equal(
      formatLine({ ...base, trend: "down", trendPct: 8 }, options),
      `tok/s ${GRAPH} 42.5 ▼  8%${tail}`,
    )
  })

  it("holds the segments after the trend still as the digits change", () => {
    /* Same width whatever the digits, and the same tail at the same offset: a
     * percentage gaining a column never shifts what follows it. */
    const widest = formatLine({ ...base, trendPct: 130 }, options),
      offset = widest.indexOf(" · ")
    for (const trendPct of [1, 8, 18, 130]) {
      const line = formatLine({ ...base, trendPct }, options)
      assert.equal(line.length, widest.length, line)
      assert.equal(line.slice(offset), widest.slice(offset), line)
    }
  })

  it("lets a wider percentage outgrow the reserved slots", () => {
    assert.ok(formatLine({ ...base, trendPct: 4900 }, options).includes("▲4900%"))
  })

  it("pads nothing when the trend has no percentage", () => {
    const line = formatLine({ ...base, trend: "flat", trendPct: 0 }, options)
    assert.ok(line.includes("▬ "), line)
    assert.ok(!line.includes("%"), line)
  })
})

describe("formatLineFitting", () => {
  const base: Snapshot = {
    rate: 42.5,
    avg: 38.2,
    live: true,
    settled: false,
    tokens: 1200,
    elapsed: 12_000,
    peak: 61,
    peakBucket: 55,
    trend: "up",
    trendPct: 18,
    ttftMs: 800,
    vu: [10, 20, 30, 40],
  },
   options: DisplayOptions = {
    label: "tok/s",
    showVu: true,
    vuColumns: 12,
    vuScale: "auto",
    vuFullTps: 50,
    showTrend: true,
    showAvg: true,
    showPeak: true,
    showTtft: true,
    showTokenCount: true,
    showElapsed: true,
  },
   /* Twelve columns, always: the four buckets of `base` are right-aligned in
    * them and the eight cells to their left stay blank. */
   GRAPH = "▁▃▄▆".padStart(options.vuColumns),
   FULL = `tok/s ${GRAPH} 42.5 ▲ 18% · avg 38.2 · pk 61.0 · ttft 0.8s · 1.2k tok · 12.0s`

  it("renders the full line when the width is no constraint", () => {
    for (const width of [undefined, Number.POSITIVE_INFINITY, 0, -4, Number.NaN, FULL.length, 200]) {
      assert.equal(formatLineFitting(base, options, width), FULL, `width ${String(width)}`)
    }
  })

  it("drops elapsed first, then the token count", () => {
    assert.equal(
      formatLineFitting(base, options, FULL.length - 1),
      `tok/s ${GRAPH} 42.5 ▲ 18% · avg 38.2 · pk 61.0 · ttft 0.8s · 1.2k tok`,
    )
    assert.equal(
      formatLineFitting(base, options, 66),
      `tok/s ${GRAPH} 42.5 ▲ 18% · avg 38.2 · pk 61.0 · ttft 0.8s`,
    )
  })

  it("drops the whole graph after the token count, before the ttft", () => {
    /* The graph owns its own drop rank between the token count and the ttft:
     * at 61 the 62-column line cannot fit and what goes is the graph, gone
     * whole with all twelve of its columns — ttft, peak and avg all survive
     * next to the bare rate. */
    assert.equal(
      formatLineFitting(base, options, 61),
      "tok/s 42.5 ▲ 18% · avg 38.2 · pk 61.0 · ttft 0.8s",
    )
    assert.equal(
      formatLineFitting(base, options, 62),
      `tok/s ${GRAPH} 42.5 ▲ 18% · avg 38.2 · pk 61.0 · ttft 0.8s`,
    )
  })

  it("drops the ttft, then peak, then avg after the graph is gone", () => {
    assert.equal(
      formatLineFitting(base, options, 40),
      "tok/s 42.5 ▲ 18% · avg 38.2 · pk 61.0",
    )
    assert.equal(
      formatLineFitting(base, options, 36),
      "tok/s 42.5 ▲ 18% · avg 38.2",
    )
    assert.equal(formatLineFitting(base, options, 26), "tok/s 42.5 ▲ 18%")
  })

  it("never renders a partial-width graph at any width", () => {
    /* The graph is a whole-unit droppable of a fixed width: every fitted line
     * either carries all twelve columns — the four history cells padded out to
     * the full segment — or holds no VU glyph at all. A trimmed or unpadded
     * graph, at any intermediate width, is never the answer. */
    for (let width = 1; width <= FULL.length + 8; width += 1) {
      const line = formatLineFitting(base, options, width)
      assert.equal(
        /[▁▂▃▄▅▆▇█]/u.test(line),
        line.includes(GRAPH),
        `width ${width}: ${line}`,
      )
    }
  })

  it("keeps the label, rate and trend when every detail must go", () => {
    assert.equal(formatLineFitting(base, options, 20), "tok/s 42.5 ▲ 18%")
    assert.equal(formatLineFitting(base, options, 16), "tok/s 42.5 ▲ 18%")
  })

  it("drops the trend once the row cannot hold its padding", () => {
    /* The trend costs six columns: its separating space, the arrow, three digit
     * slots and the sign. At 15 the head cannot hold them, so the trend goes
     * and only the `label rate` core remains; the graph was dropped ranks
     * before the trend and stays dropped. */
    assert.equal(formatLineFitting(base, options, 15), "tok/s 42.5")
    assert.equal(formatLineFitting(base, options, 13), "tok/s 42.5")
    assert.ok(!formatLineFitting(base, options, 15).includes("▲"))
  })

  it("fits the trend on its padding, not on the digits currently shown", () => {
    /* A one digit percentage is just as much room as `▲130%`: the padding is
     * what the fitter measures, so a percentage growing to three digits can
     * never push the line onto a second row. */
    for (const trendPct of [2, 18, 130]) {
      const shown = formatLineFitting({ ...base, trendPct }, options, 16),
        dropped = formatLineFitting({ ...base, trendPct }, options, 15)
      assert.ok(shown.includes("▲"), `pct ${trendPct}: ${shown}`)
      assert.equal(shown.length, 16, shown)
      assert.ok(!dropped.includes("▲"), `pct ${trendPct}: ${dropped}`)
    }
  })

  it("holds the irreducible core when even that cannot fit", () => {
    for (const width of [9, 5, 1]) {
      assert.equal(formatLineFitting(base, options, width), "tok/s 42.5", `width ${width}`)
    }
  })

  it("fits around segments the user already disabled", () => {
    assert.equal(
      formatLineFitting(base, { ...options, showAvg: false }, 40),
      "tok/s 42.5 ▲ 18% · pk 61.0 · ttft 0.8s",
    )
    assert.equal(formatLineFitting(base, { ...options, showVu: false }, 20), "tok/s 42.5 ▲ 18%")
  })

  it("never grows the line past the width it was given when anything fits", () => {
    for (let width = 1; width < FULL.length; width += 1) {
      const line = formatLineFitting(base, options, width)
      assert.ok(line.length <= width || line === "tok/s 42.5", `width ${width}: ${line}`)
    }
  })

  it("drops segments that are absent from the line without shifting the rest", () => {
    assert.equal(
      formatLineFitting({ ...base, ttftMs: undefined }, options, 66),
      `tok/s ${GRAPH} 42.5 ▲ 18% · avg 38.2 · pk 61.0 · 1.2k tok`,
    )
    assert.equal(
      formatLineFitting({ ...base, trend: "none", trendPct: 0 }, options, 60),
      `tok/s ${GRAPH} 42.5 · avg 38.2 · pk 61.0 · ttft 0.8s`,
    )
  })
})

describe("fixed-width graph", () => {
  const base: Snapshot = {
    rate: 42.5,
    avg: 38.2,
    live: true,
    settled: false,
    tokens: 1200,
    elapsed: 12_000,
    peak: 61,
    peakBucket: 55,
    trend: "none",
    trendPct: 0,
    ttftMs: undefined,
    vu: [],
  },
   options: DisplayOptions = {
    label: "tok/s",
    showVu: true,
    vuColumns: 12,
    vuScale: "fixed",
    vuFullTps: 50,
    showTrend: false,
    showAvg: true,
    showPeak: false,
    showTtft: false,
    showTokenCount: false,
    showElapsed: false,
   },
   /* The graph is the head of the line, right after the label and its space,
    * so its cells are the slice the assertions below read back out. */
   HEAD = options.label.length + 1,
   graph = (line: string): string => line.slice(HEAD, HEAD + options.vuColumns)

  /** A history of `cells` one-second buckets, newest last.
   * @param cells - Number of buckets the frame's history holds.
   * @returns A snapshot whose graph segment must still be twelve columns.
   */
  function history(cells: number): Snapshot {
    return { ...base, vu: Array.from({ length: cells }, (_, index): number => 10 + (index % 4) * 10) }
  }

  it("renders the same graph width for no, one and almost full histories", () => {
    /* The ticket's three cases: 0, 1 and `vuColumns - 1` buckets, plus a full
     * one to compare against. Every graph is twelve cells; the blanks are held
     * on the left, so the rate never creeps toward the label. */
    const full = formatLine(history(options.vuColumns), options)
    for (const cells of [0, 1, options.vuColumns - 1, options.vuColumns]) {
      const line = formatLine(history(cells), options)
      assert.equal(graph(line).length, options.vuColumns, `history of ${cells}: ${line}`)
      assert.equal(line.length, full.length, `history of ${cells}: ${line}`)
      assert.ok(line.startsWith(`${options.label} `), line)
    }
  })

  it("keeps the newest second at the right edge, beside the rate", () => {
    /* Fixed full-scale of 50: 10 tokens is `▂`, 50 is the tallest `█`, so the
     * newest bucket lands in the cell touching the rate, the older ones run
     * leftwards from it, and blanks sit beyond them. */
    const line = formatLine({ ...base, vu: [10, 50, 20] }, options)
    assert.equal(graph(line), "         ▂█▃", line)
    assert.equal(line.slice(HEAD + options.vuColumns), " 42.5 · avg 38.2", line)
    /* Longer than the graph: the newest twelve columns survive and scroll off
     * at the left edge, so the current second never moves out of its cell. */
    const short = formatLine({ ...base, vu: [40, 40, 40, 40, 40, 20] }, options)
    assert.equal(graph(short).at(-1), "▃", short)
    const twelve = graph(formatLine(history(12), options)),
      thirteen = graph(formatLine(history(13), options))
    assert.equal(
      thirteen.slice(0, options.vuColumns - 1),
      twelve.slice(1),
      "the graph scrolls one cell left as the thirteenth second lands",
    )
  })

  it("holds one line width across successive seconds of a live turn", () => {
    /* A real meter, one second of streaming per snapshot, alternating fast and
     * slower seconds so the bars are distinguishable. The rate, average and
     * peak stay inside the same digit band by design: the only thing moving
     * here is the history, and the line does not move with it. */
    const meter = new TpsMeter(WIDE, () => 0, 0),
      lines: Array<string> = [],
      bars: Array<string> = []
    for (let second = 1; second <= 15; second += 1) {
      const tokens = second % 2 === 0 ? 20 : 10
      meter.record("a".repeat(tokens * 4), second * SECOND_MS)
      const line = formatLine(meter.snapshot(second * SECOND_MS + 500, options.vuColumns), options)
      lines.push(line)
      bars.push(graph(line))
    }

    const widths = new Set<number>(lines.map((line): number => line.length))
    assert.equal(widths.size, 1, `one width every second: ${lines.join("\n")}`)
    const graphWidths = new Set<number>(bars.map((cells): number => cells.length))
    assert.deepEqual([...graphWidths], [options.vuColumns], "the graph holds its columns every second")
    for (const [index, cells] of bars.entries()) {
      assert.notEqual(cells.at(-1), " ", `second ${index + 1} keeps a bar beside the rate: ${cells}`)
    }
    /* And it scrolls: the last graph is the one before it, shifted left by a
     * cell with the newest second appended at the right edge. */
    assert.equal(bars.at(-1)?.slice(0, options.vuColumns - 1), bars.at(-2)?.slice(1))
  })

  it("holds the graph width across a pause in the stream", () => {
    /* Two seconds with nothing in them after the stream stops: the meter trims
     * those empty seconds off the end of the history, and either way the graph
     * is twelve cells and the newest bar keeps the cell beside the rate. */
    const meter = new TpsMeter(WIDE, () => 0, 0)
    for (let second = 1; second <= 3; second += 1) {
      meter.record("a".repeat(80), second * SECOND_MS)
    }
    const streaming = formatLine(meter.snapshot(3500, options.vuColumns), options),
      paused = formatLine(meter.snapshot(5500, options.vuColumns), options)
    assert.equal(graph(streaming), "         ▃▃▃", streaming)
    assert.equal(graph(paused), "         ▃▃▃", paused)
    assert.equal(paused.length, streaming.length, `pause ${paused} vs stream ${streaming}`)
  })
})

describe("hasData", () => {
  const base: Snapshot = {
    rate: 0,
    avg: 0,
    live: false,
    settled: false,
    tokens: 0,
    elapsed: 0,
    peak: 0,
    peakBucket: 0,
    trend: "none",
    trendPct: 0,
    ttftMs: undefined,
    vu: [],
  }

  it("is false for undefined and empty snapshots", () => {
    assert.equal(hasData(undefined), false)
    assert.equal(hasData(base), false)
  })

  it("is true once there are tokens or a peak", () => {
    assert.equal(hasData({ ...base, tokens: 1 }), true)
    assert.equal(hasData({ ...base, peak: 1 }), true)
  })
})

describe("renderVu", () => {
  it("pads a short history out to the full width", () => {
    assert.equal(renderVu([], 4, 50), "    ")
    assert.equal(renderVu([50], 4, 50), "   █")
    assert.equal(renderVu([10, 20], 12, 50).length, 12)
  })

  it("keeps the newest column at the right edge", () => {
    /* Oldest first in, newest last out: the cell beside the rate is always the
     * newest second, whatever the history's length. */
    assert.equal(renderVu([10, 20], 12, 50).at(-1), "▃")
    assert.equal(renderVu([10, 20], 12, 50).at(-2), "▂")
    assert.equal(renderVu([10, 20], 12, 50).slice(0, 10), " ".repeat(10))
    assert.equal(renderVu([50, 20], 12, 50).at(-1), "▃")
    assert.equal(renderVu([20, 50], 12, 50).at(-1), "█")
  })

  it("holds one width for every history length", () => {
    const widths = [[], [40], [40, 40], [40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40]].map(
      (values) => renderVu(values, 12, 50).length,
    )
    assert.deepEqual(widths, [12, 12, 12, 12])
  })

  it("maps levels proportionally", () => {
    assert.equal(renderVu([0], 1, 50), " ")
    assert.equal(renderVu([6.25], 1, 50), "▁")
    assert.equal(renderVu([25], 1, 50), "▄")
    assert.equal(renderVu([50], 1, 50), "█")
  })

  it("gives low non-zero columns at least one block", () => {
    assert.equal(renderVu([0.1], 1, 283), "▁")
    assert.equal(renderVu([5], 1, 283), "▁")
    assert.equal(renderVu([0], 1, 283), " ")
  })

  it("clamps above the full-scale value", () => {
    assert.equal(renderVu([1000], 1, 50), "█")
  })

  it("trims to the most recent columns", () => {
    /* Longer than the graph: the newest columns win, and the oldest are the
     * ones that scroll off, never the ones that get blanked out. */
    assert.equal(renderVu([0, 0, 50, 50], 2, 50), "██")
    assert.equal(renderVu([10, 20, 30, 40], 2, 40), "▆█")
  })

  it("returns empty for zero cells", () => {
    assert.equal(renderVu([50], 0, 50), "")
  })
})

describe("vuFullScale", () => {
  it("scales to the largest value in auto mode", () => {
    assert.equal(vuFullScale([3, 8, 15, 22], "auto", 50), 22)
  })

  it("never returns zero", () => {
    assert.equal(vuFullScale([], "auto", 50), 1)
  })

  it("uses the turn peak for a stable scale", () => {
    assert.equal(vuFullScale([10, 20], "auto", 50, 200), 200)
  })

  it("still honours a visible value above the peak", () => {
    assert.equal(vuFullScale([10, 220], "auto", 50, 200), 220)
  })

  it("uses the fixed value in fixed mode", () => {
    assert.equal(vuFullScale([3, 8, 15, 22], "fixed", 50), 50)
    assert.equal(vuFullScale([200], "fixed", 50), 50)
  })
})

describe("TpsMeter", () => {
  it("accumulates tokens and reports elapsed", () => {
    const meter = new TpsMeter(CONFIG, () => 0, 1000)
    assert.equal(meter.record("abcdefgh", 1000), 2)
    const snap = meter.snapshot(1100)
    assert.equal(snap.tokens, 2)
    assert.equal(snap.elapsed, 100)
    assert.equal(snap.settled, false)
    assert.equal(snap.live, true)
    assert.ok(snap.rate > 0)
  })

  it("ignores empty deltas", () => {
    const meter = new TpsMeter(CONFIG, () => 0, 0)
    assert.equal(meter.record("", 0), 0)
    assert.equal(meter.snapshot(0).tokens, 0)
  })

  it("settles with exact tokens and freezes the rate", () => {
    const meter = new TpsMeter(CONFIG, () => 0, 0)
    meter.record("a".repeat(400), 900)
    meter.settle(1000, 123)
    const snap = meter.snapshot(1200)
    assert.equal(snap.settled, true)
    assert.equal(snap.live, false)
    assert.equal(snap.tokens, 123)
    assert.ok(snap.rate > 0)
  })

  it("settles to the estimate when no exact total was noted", () => {
    const meter = new TpsMeter(CONFIG, () => 0, 0)
    meter.record("a".repeat(40), 900)
    meter.settle(1000)
    const snap = meter.snapshot(1000)
    assert.equal(snap.settled, true)
    assert.equal(snap.tokens, 10)
  })

  it("settles to zero when nothing was recorded", () => {
    const meter = new TpsMeter(CONFIG, () => 0, 0)
    meter.settle(1000)
    const snap = meter.snapshot(1000)
    assert.equal(snap.settled, true)
    assert.equal(snap.rate, 0)
  })

  it("resumes live tracking after a settle", () => {
    const meter = new TpsMeter(CONFIG, () => 0, 0)
    meter.settle(100, 10)
    meter.record("abcd", 200)
    assert.equal(meter.snapshot(200).settled, false)
  })

  it("prune keeps in-window samples usable", () => {
    const meter = new TpsMeter(CONFIG, () => 0, 0)
    meter.record("abcdefgh", 5000)
    meter.record("abcdefgh", 5050)
    meter.prune(6000)
    assert.equal(meter.snapshot(6000, 4).tokens, 4)
  })

  it("buckets samples per second and grows the VU meter", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(40), 1000)
    assert.deepEqual(meter.snapshot(1100, 12).vu, [10])
    meter.record("a".repeat(40), 2100)
    assert.deepEqual(meter.snapshot(2200, 12).vu, [10, 10])
    assert.deepEqual(meter.snapshot(4200, 12).vu, [10, 10])
  })

  it("tracks peak as a rate, never below the average", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(40), 1000)
    meter.record("a".repeat(160), 2000)
    meter.record("a".repeat(40), 3000)
    const snap = meter.snapshot(3100, 4)
    assert.equal(snap.peak, 50)
    assert.ok(snap.peak >= snap.avg)
  })

  it("keeps peak at or above average on short fast turns", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(200), 1000)
    meter.record("a".repeat(200), 1100)
    const snap = meter.snapshot(1100, 4)
    assert.equal(snap.avg, 500)
    assert.ok(snap.peak >= snap.avg)
  })

  it("reports an upward trend", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(20), 1000)
    meter.record("a".repeat(80), 2000)
    const snap = meter.snapshot(2100, 4)
    assert.equal(snap.trend, "up")
    assert.equal(snap.trendPct, 100)
  })

  it("reports a downward trend", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(40), 1000)
    meter.record("a".repeat(20), 2000)
    meter.record("a".repeat(40), 3000)
    const snap = meter.snapshot(3100, 4)
    assert.equal(snap.trend, "down")
    assert.equal(snap.trendPct, 50)
  })

  it("reports no trend while idle", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    assert.equal(meter.snapshot(5000, 4).trend, "none")
  })

  it("measures time to first token from the turn start", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.beginTurn(1000)
    meter.record("abcdefgh", 1500)
    assert.equal(meter.snapshot(1600, 4).ttftMs, 500)
  })

  it("re-anchors TTFT to the first request dispatch", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.beginTurn(1000)
    meter.beginRequest(1200)
    meter.record("abcdefgh", 1500)
    assert.equal(meter.snapshot(1600, 4).ttftMs, 300)
  })

  it("treats a later request as a segment boundary", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.beginTurn(1000)
    meter.record("a".repeat(40), 1000)
    meter.beginRequest(2000)
    const snap = meter.snapshot(2100, 4)
    assert.equal(snap.tokens, 10)
    assert.equal(snap.rate, -1)
    assert.deepEqual(snap.vu, [10])
  })

  it("starts a turn lazily when no beginTurn was seen", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(40), 1000)
    assert.equal(meter.snapshot(1100, 4).tokens, 10)
  })

  it("clears turn data on the first token after beginTurn", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(40), 1000)
    meter.beginTurn(2000)
    // The pending turn has not reset anything yet; the held data stays visible.
    assert.equal(meter.snapshot(2100, 12).tokens, 10)
    meter.record("a".repeat(40), 2100)
    const snap = meter.snapshot(2200, 12)
    assert.equal(snap.tokens, 10)
    assert.equal(snap.peak, 50)
  })

  it("newSegment resets the live rate but keeps the graph and totals", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(40), 1000)
    meter.newSegment()
    const snap = meter.snapshot(1500, 4)
    assert.equal(snap.tokens, 10)
    assert.equal(snap.rate, -1)
    assert.deepEqual(snap.vu, [10])
  })

  it("keeps the graph continuous across segments", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(40), 1000)
    meter.record("a".repeat(40), 2000)
    meter.newSegment()
    meter.record("a".repeat(40), 5000)
    assert.deepEqual(meter.snapshot(5100, 12).vu, [10, 10, 0, 0, 10])
  })

  it("keeps the graph in the held frame when the turn ends after a tool", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(40), 1000)
    meter.record("a".repeat(80), 2000)
    meter.newSegment()
    meter.settle(2500, 30)
    const snap = meter.snapshot(90_000, 12)
    assert.equal(snap.settled, true)
    assert.ok(snap.vu.some((value) => value > 0))
    assert.ok(snap.rate > 0)
  })

  it("tracks the busiest second for a stable graph scale", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(250 * 4), 5000)
    meter.record("a".repeat(70 * 4), 17_000)
    const snap = meter.snapshot(17_500, 12)
    assert.equal(snap.peakBucket, 250)
    assert.deepEqual(snap.vu, [70])
  })

  it("accumulates noted exact tokens for settling", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(40), 1000)
    meter.noteExact(60)
    meter.record("a".repeat(40), 2000)
    meter.noteExact(40)
    meter.settle(2100)
    const snap = meter.snapshot(2100, 12)
    assert.equal(snap.tokens, 100)
    assert.deepEqual(snap.vu, [50, 50])
  })

  it("ignores non-positive and non-finite exact notes", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(40), 1000)
    meter.noteExact(0)
    meter.noteExact(-5)
    meter.noteExact(Number.NaN)
    meter.settle(1100)
    assert.equal(meter.snapshot(1100, 12).tokens, 10)
  })

  it("scales the frozen graph to the provider's exact token total", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(100 * 4), 1000)
    const estimated = meter.snapshot(1100, 12)
    assert.equal(estimated.tokens, 100)
    assert.equal(estimated.peakBucket, 100)

    meter.settle(1200, 150)
    const snap = meter.snapshot(1200, 12)
    assert.equal(snap.tokens, 150)
    assert.equal(snap.peakBucket, 150)
    assert.deepEqual(snap.vu, [150])
    assert.ok(snap.peak >= snap.avg)
  })

  it("scales the graph down when the exact total is smaller than the estimate", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(100 * 4), 1000)
    meter.settle(1200, 50)
    const snap = meter.snapshot(1200, 12)
    assert.equal(snap.tokens, 50)
    assert.equal(snap.peakBucket, 50)
    assert.deepEqual(snap.vu, [50])
  })

  it("leaves the graph unchanged when there is no estimate to scale", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.settle(1000, 42)
    const snap = meter.snapshot(1000, 12)
    assert.equal(snap.settled, true)
    assert.equal(snap.tokens, 42)
    assert.equal(snap.peakBucket, 0)
    assert.deepEqual(snap.vu, [])
  })

  it("counts the same tokens regardless of chunk fragmentation", () => {
    const text = "a".repeat(400),
     whole = new TpsMeter(WIDE, () => 0, 0)
    whole.record(text, 1000)

    const split = new TpsMeter(WIDE, () => 0, 0)
    for (let i = 0; i < text.length; i += 7) {split.record(text.slice(i, i + 7), 1000 + i)}

    assert.equal(whole.snapshot(1000, 12).tokens, 100)
    assert.equal(split.snapshot(1400, 12).tokens, 100)
  })

  it("is fragmentation-invariant down to single-byte chunks", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    for (let i = 0; i < 8; i += 1) {meter.record("a", 1000 + i)}
    assert.equal(meter.snapshot(1008, 12).tokens, 2)
  })

  it("excludes the tool pause from the average", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(400), 1000)
    meter.record("a".repeat(400), 2000)
    meter.newSegment()
    meter.record("a".repeat(400), 7000)
    const snap = meter.snapshot(7050, 12)
    assert.equal(snap.tokens, 300)
    assert.equal(snap.avg, 300)
  })

  it("averages over active generation time across multiple segments", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    // Segment 1: 20 tokens across a 1000ms burst.
    meter.record("a".repeat(40), 1000)
    meter.record("a".repeat(40), 2000)
    meter.newSegment()
    // A long tool pause follows; it must not count toward the average.
    // Segment 2: 40 tokens across a 1000ms burst.
    meter.record("a".repeat(80), 9000)
    meter.record("a".repeat(80), 10_000)
    const snap = meter.snapshot(10_050, 12)
    assert.equal(snap.tokens, 60)
    assert.equal(snap.avg, 30)
  })

  it("reports the turn average from tokens over the token span", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(40), 1000)
    meter.record("a".repeat(40), 2000)
    assert.equal(meter.snapshot(2000, 4).avg, 20)
  })

  it("reports the average from exact tokens after settling", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(40), 1000)
    meter.record("a".repeat(40), 2000)
    meter.settle(2000, 100)
    assert.equal(meter.snapshot(2000, 4).avg, 100)
  })

  it("holds the final frame after the window would have pruned it", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(40), 1000)
    meter.settle(1200, 10)
    const snap = meter.snapshot(200_000, 4)
    assert.equal(snap.settled, true)
    assert.equal(snap.rate, 50)
    assert.equal(snap.avg, 50)
    assert.equal(snap.peak, 50)
    assert.ok(snap.vu.some((value) => value > 0))
  })

  it("clears the held frame when a new turn starts producing tokens", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(40), 1000)
    meter.settle(1200, 10)
    meter.beginTurn(200_000)
    // Held frame survives until the new turn actually streams.
    assert.equal(meter.snapshot(200_001, 4).settled, true)
    meter.record("a".repeat(40), 200_001)
    const snap = meter.snapshot(200_002, 4)
    assert.equal(snap.settled, false)
    assert.equal(snap.live, true)
  })
})

describe("MeterStore", () => {
  it("tracks sessions independently", () => {
    const store = new MeterStore(CONFIG, () => 0)
    store.record("a", "abcdefgh", 1000)
    store.record("b", "a".repeat(40), 1000)
    assert.equal(store.size, 2)
    assert.equal(store.snapshot("a", 1000, 4)?.tokens, 2)
    assert.equal(store.snapshot("b", 1000, 4)?.tokens, 10)
  })

  it("returns undefined and false for unknown sessions", () => {
    const store = new MeterStore(CONFIG, () => 0)
    assert.equal(store.snapshot("missing", 0, 4), undefined)
    assert.equal(store.settle("missing", 0), false)
    assert.equal(store.newSegment("missing"), false)
    assert.equal(store.noteExact("missing", 10), false)
    assert.equal(store.drop("missing"), false)
  })

  it("settles a known session with noted exact tokens", () => {
    const store = new MeterStore(CONFIG, () => 0)
    store.record("a", "abcdefgh", 1000)
    assert.equal(store.noteExact("a", 99), true)
    assert.equal(store.settle("a", 1100), true)
    assert.equal(store.snapshot("a", 1100, 4)?.tokens, 99)
  })

  it("opens turns for sessions", () => {
    const store = new MeterStore(CONFIG, () => 0)
    store.beginTurn("a", 1000)
    store.beginRequest("a", 1100)
    store.record("a", "abcdefgh", 1300)
    assert.equal(store.snapshot("a", 1400, 4)?.ttftMs, 200)
  })

  it("drops sessions", () => {
    const store = new MeterStore(CONFIG, () => 0)
    store.record("a", "abcdefgh", 1000)
    assert.equal(store.drop("a"), true)
    assert.equal(store.drop("a"), false)
    assert.equal(store.size, 0)
  })

  it("prunes every session", () => {
    const store = new MeterStore(CONFIG, () => 0)
    store.record("a", "abcdefgh", 0)
    store.record("b", "abcdefgh", 5000)
    store.prune(6000)
    assert.equal(store.snapshot("a", 6000, 4)?.tokens, 2)
    assert.equal(store.snapshot("b", 6000, 4)?.tokens, 2)
  })
})
