/**
 * Display-side formatting for the tokens-per-second meter: pure functions
 * that turn a `Snapshot` plus options into the rendered footer line. Split
 * from `meter.ts` (measurement) to keep each module focused and small.
 */
import type { Snapshot, Trend } from "./meter.ts"

/** Coarse speed band used for color. */
export type Tier = "fast" | "idle" | "medium" | "slow"

/** How VU columns map to height. */
export type VuScale = "auto" | "fixed"

/** Which segments to include in the rendered line. */
export type DisplayOptions = {
  readonly label: string
  readonly showAvg: boolean
  readonly showElapsed: boolean
  readonly showPeak: boolean
  readonly showTokenCount: boolean
  readonly showTrend: boolean
  readonly showTtft: boolean
  readonly showVu: boolean
  readonly vuColumns: number
  readonly vuFullTps: number
  readonly vuScale: VuScale
}

const
  /** Columns `buildLine` gets once the graph has dropped: it renders none. */
  GRAPH_DROP_COLUMNS = 0,

  /** The graph's own drop rank: it leaves whole, never trimmed column by column. */
  GRAPH_DROP_RANK = 4,
  KILO = 1000,

  /** Highest drop rank; fitting removes ranks from here down to 1. */
  MAX_DROP_RANK = 6,
  MEGA = 1_000_000,

  /**
   * Digit slots reserved for the trend percentage. A second-to-second swing is
   * pretty much always three digits wide (e.g. `▲130%`), so the number is
   * right-aligned in this field: the segment keeps one width as the value
   * changes, and the one-row fit measures that width, not the digits on screen.
   */
  TREND_DIGITS = 3,

  TREND_GLYPHS: Record<Trend, string> = {
    down: "▼",
    flat: "▬",
    none: "",
    up: "▲",
  },

  /** Eight vertical levels plus empty, low to high. */
  VU_GLYPHS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const

/**
 * `-` when idle, one decimal below 100, whole numbers above.
 * @param rate - Tokens per second, or a negative sentinel for idle.
 * @returns The rate as a display string.
 */
export function formatRate(rate: number): string {
  if (rate < 0) {
    return "-"
  }
  return rate >= 100 ? String(Math.round(rate)) : rate.toFixed(1)
}

/**
 * Compact token counts: 999, 1.5k, 2.5m.
 * @param count - Raw token count.
 * @returns The count abbreviated with a `k` or `m` suffix.
 */
export function formatCount(count: number): string {
  if (count >= MEGA) {
    return `${(count / MEGA).toFixed(1)}m`
  }
  if (count >= KILO) {
    return `${(count / KILO).toFixed(1)}k`
  }
  return String(count)
}

/**
 * Seconds below a minute, then `1m5s`.
 * @param ms - Duration in milliseconds.
 * @returns The duration as a compact clock string.
 */
export function formatClock(ms: number): string {
  const seconds = Math.max(0, ms) / KILO
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`
  }
  return `${Math.floor(seconds / 60)}m${Math.floor(seconds % 60)}s`
}

/**
 * Denominator for VU heights.
 *
 * `auto` uses the turn peak so one column height means one speed for the whole
 * turn, even after the tallest column has scrolled out of view; the largest
 * visible value is honoured as a floor so the graph always fills its height.
 * `fixed` uses an absolute full-scale target.
 * @param values - Per-second token counts to take the maximum over.
 * @param mode - `auto` scales to the turn peak; `fixed` uses `fixedTps`.
 * @param fixedTps - Full-scale target when mode is `fixed`.
 * @param peak - Turn peak carried by the snapshot, used as the auto floor.
 * @returns A positive full-scale tokens-per-second value.
 */
export function vuFullScale(
  values: ReadonlyArray<number>,
  mode: VuScale,
  fixedTps: number,
  peak = 0,
): number {
  if (mode === "fixed") {
    return Math.max(1, fixedTps)
  }
  let max = Math.max(0, peak)
  for (const value of values) {
    if (value > max) {
      max = value
    }
  }
  return Math.max(1, max)
}

/**
 * Render the newest `maxCells` values as glyphs; short histories stay short.
 * @param values - Per-second token counts, oldest first.
 * @param maxCells - Maximum number of columns to render.
 * @param fullTps - Token count that maps to the tallest glyph.
 * @returns A glyph string, possibly empty; never padded.
 */
export function renderVu(values: ReadonlyArray<number>, maxCells: number, fullTps: number): string {
  const cap = Math.max(0, Math.floor(maxCells))
  if (cap === 0) {
    return ""
  }
  const scale = fullTps <= 0 ? 1 : fullTps,
    top = VU_GLYPHS.length - 1
  return values
    .slice(-cap)
    .map((value) => {
      /* Any non-zero column gets at least one block so a slow second never
       * reads like a gap. True zeros stay blank (and are trimmed at the edges). */
      const level = value <= 0 ? 0 : Math.max(1, Math.min(top, Math.round((value / scale) * top)))
      return VU_GLYPHS[level] ?? ""
    })
    .join("")
}

/**
 * Band a rate into a color tier.
 * @param rate - Tokens per second, or a negative sentinel for idle.
 * @param slowTps - Boundary below which the rate is slow.
 * @param fastTps - Boundary at or above which the rate is fast.
 * @returns The coarse tier for the given rate.
 */
export function rateTier(rate: number, slowTps: number, fastTps: number): Tier {
  if (rate < 0) {
    return "idle"
  }
  if (rate < slowTps) {
    return "slow"
  }
  if (rate < fastTps) {
    return "medium"
  }
  return "fast"
}

/**
 * Whether a snapshot has enough data to render anything.
 * @param snapshot - Snapshot to inspect, if one exists yet.
 * @returns True when the snapshot carries tokens or a peak to display.
 */
export function hasData(snapshot: Snapshot | undefined): boolean {
  return snapshot !== undefined && (snapshot.tokens > 0 || snapshot.peak > 0)
}

/**
 * Graph columns plus the rate, as the leading chunk of the display line.
 * @param options - Which segments to include in the line.
 * @param snapshot - Fully computed meter snapshot to render.
 * @param columns - VU columns the graph may render; fitting passes either the
 * full `vuColumns` or 0, and 0 — like `showVu` off or an empty history —
 * leaves this chunk as the bare rate.
 * @returns The label-adjacent first chunk of the display line.
 */
function graphSegment(options: DisplayOptions, snapshot: Snapshot, columns: number): string {
  if (!options.showVu) {
    return formatRate(snapshot.rate)
  }
  const graph = renderVu(
    snapshot.vu,
    columns,
    vuFullScale(snapshot.vu, options.vuScale, options.vuFullTps, snapshot.peakBucket),
  )
  if (graph.length === 0) {
    return formatRate(snapshot.rate)
  }
  return `${graph} ${formatRate(snapshot.rate)}`
}

/**
 * The trend glyph with a fixed-width percentage, or empty when trend is off or
 * unknown. The digits sit in a `TREND_DIGITS` wide field so `▲ 10%` and
 * `▲130%` take the same room and the segments after them never shift.
 * @param options - Which segments to include in the line.
 * @param snapshot - Fully computed meter snapshot to render.
 * @returns The trend chunk, possibly empty.
 */
function trendSegment(options: DisplayOptions, snapshot: Snapshot): string {
  if (!options.showTrend || snapshot.rate < 0) {
    return ""
  }
  const glyph = TREND_GLYPHS[snapshot.trend]
  if (glyph.length === 0) {
    return ""
  }
  if (snapshot.trendPct <= 0) {
    return glyph
  }
  const digits = String(Math.round(snapshot.trendPct)).padStart(TREND_DIGITS, " ")
  return `${glyph}${digits}%`
}

/** One tail segment with the order it is dropped in when the line must fit. */
type TailPart = {
  readonly rank: number
  readonly text: string
}

/**
 * The stat segments with their drop ranks: rank 1 is kept longest and higher
 * ranks are omitted first. Drop order per the ticket is elapsed, token count,
 * the graph, then ttft, peak and avg, so avg is rank 1, peak rank 2, ttft
 * rank 3, the token count rank 5 and elapsed rank 6. The graph is not a tail
 * segment — it leads the head — but it owns rank 4 (`GRAPH_DROP_RANK`) so
 * the fitter drops it whole between the token count and the ttft.
 * @param options - Which segments to include in the line.
 * @param snapshot - Fully computed meter snapshot to render.
 * @returns The enabled stat segments in display order, with drop ranks.
 */
function tailParts(options: DisplayOptions, snapshot: Snapshot): Array<TailPart> {
  const tail: Array<TailPart> = []
  if (options.showAvg) {
    tail.push({ rank: 1, text: `avg ${formatRate(snapshot.avg)}` })
  }
  if (options.showPeak) {
    tail.push({ rank: 2, text: `pk ${formatRate(snapshot.peak)}` })
  }
  if (options.showTtft && snapshot.ttftMs !== undefined) {
    tail.push({ rank: 3, text: `ttft ${formatClock(snapshot.ttftMs)}` })
  }
  if (options.showTokenCount) {
    tail.push({ rank: 5, text: `${formatCount(snapshot.tokens)} tok` })
  }
  if (options.showElapsed) {
    tail.push({ rank: 6, text: formatClock(snapshot.elapsed) })
  }
  return tail
}

/**
 * Assemble the display line from ranked tail segments and a graph width.
 * @param options - Which segments to include in the line.
 * @param snapshot - Fully computed meter snapshot to render.
 * @param tail - Tail segments to join with ` · ` after the head.
 * @param columns - VU columns the graph segment may render.
 * @returns The assembled single-line status string.
 */
function buildLine(
  options: DisplayOptions,
  snapshot: Snapshot,
  tail: ReadonlyArray<TailPart>,
  columns: number,
): string {
  const body: Array<string> = [graphSegment(options, snapshot, columns)],
    trend = trendSegment(options, snapshot)
  if (trend.length > 0) {
    body.push(trend)
  }
  let line = `${options.label} ${body.join(" ")}`
  if (tail.length > 0) {
    line += ` · ${tail.map((part): string => part.text).join(" · ")}`
  }
  return line
}

/**
 * Build the full display line from a snapshot. Pure: no TUI, no theme.
 * @param snapshot - Fully computed meter snapshot to render.
 * @param options - Which segments to include in the line.
 * @returns The single-line status string for the footer.
 */
export function formatLine(snapshot: Snapshot, options: DisplayOptions): string {
  return buildLine(options, snapshot, tailParts(options, snapshot), options.vuColumns)
}

/**
 * The detail-free head — label, rate and trend — narrowed to one row.
 *
 * The graph never shrinks here: it is a whole-unit droppable segment and its
 * rank was already applied by `formatLineFitting`, so the head is measured
 * with the graph gone, `label rate` plus the trend. The trend is only ever
 * shown at the width its padding reserves; once even that cannot fit, the
 * fallback drops the trend and keeps the irreducible `label rate` core.
 * @param options - Which segments to include in the line.
 * @param snapshot - Fully computed meter snapshot to render.
 * @param available - Columns the footer row has.
 * @returns The trended head if it fits, else the label-and-rate core.
 */
function fitHead(options: DisplayOptions, snapshot: Snapshot, available: number): string {
  const head = buildLine(options, snapshot, [], GRAPH_DROP_COLUMNS)
  if (head.length <= available) {
    return head
  }
  const bare: DisplayOptions = { ...options, showTrend: false }
  return buildLine(bare, snapshot, [], GRAPH_DROP_COLUMNS)
}

/**
 * Build the display line, omitting unimportant details until it fits one row.
 *
 * Drop order follows the importance list: elapsed and the token count go
 * first, then the graph, then TTFT, then peak, then the average. The graph is
 * removed whole at its rank, never trimmed column by column: it is either at
 * the full `options.vuColumns` or absent, and once dropped it stays dropped.
 * The label and rate never drop, and the trend goes last of all. It is held
 * to the width its padding reserves, so a row too narrow for `▲130%` never
 * shows a skinnier trend and then wraps when the number grows.
 * A width that is absent, fractional-truncated to zero, NaN or infinite means
 * "no constraint" and renders the full line.
 * @param snapshot - Fully computed meter snapshot to render.
 * @param options - Which segments to include in the line.
 * @param maxWidth - Columns available on one footer row, if known.
 * @returns The most detailed line that fits, else the most compact one.
 */
export function formatLineFitting(
  snapshot: Snapshot,
  options: DisplayOptions,
  maxWidth: number | undefined,
): string {
  const parts = tailParts(options, snapshot)
  let line = buildLine(options, snapshot, parts, options.vuColumns)
  /* Absent or non-positive widths carry no constraint; `!(x > 0)` also folds
   * away NaN, and infinity can never be undercut by a finite line. */
  if (maxWidth === undefined || !(maxWidth > 0) || !Number.isFinite(maxWidth)) {
    return line
  }
  const available = Math.floor(maxWidth)
  if (line.length <= available) {
    return line
  }
  let columns = options.vuColumns,
    kept = parts
  for (let rank = MAX_DROP_RANK; rank >= 1; rank -= 1) {
    kept = kept.filter((part): boolean => part.rank !== rank)
    if (rank === GRAPH_DROP_RANK) {
      columns = GRAPH_DROP_COLUMNS
    }
    line = buildLine(options, snapshot, kept, columns)
    if (line.length <= available) {
      return line
    }
  }
  return fitHead(options, snapshot, available)
}
