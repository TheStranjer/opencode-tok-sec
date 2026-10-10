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

const KILO = 1000,
  MEGA = 1_000_000,

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
 * @returns The label-adjacent first chunk of the display line.
 */
function graphSegment(options: DisplayOptions, snapshot: Snapshot): string {
  if (!options.showVu) {
    return formatRate(snapshot.rate)
  }
  const graph = renderVu(
    snapshot.vu,
    options.vuColumns,
    vuFullScale(snapshot.vu, options.vuScale, options.vuFullTps, snapshot.peakBucket),
  )
  if (graph.length === 0) {
    return formatRate(snapshot.rate)
  }
  return `${graph} ${formatRate(snapshot.rate)}`
}

/**
 * The trend glyph with percentage, or empty when trend is off or unknown.
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
  return snapshot.trendPct > 0 ? `${glyph}${Math.round(snapshot.trendPct)}%` : glyph
}

/**
 * The stat segments joined with ` · ` after the rate and graph.
 * @param options - Which segments to include in the line.
 * @param snapshot - Fully computed meter snapshot to render.
 * @returns The enabled stat segments in display order.
 */
function tailParts(options: DisplayOptions, snapshot: Snapshot): Array<string> {
  const tail: Array<string> = []
  if (options.showAvg) {
    tail.push(`avg ${formatRate(snapshot.avg)}`)
  }
  if (options.showPeak) {
    tail.push(`pk ${formatRate(snapshot.peak)}`)
  }
  if (options.showTtft && snapshot.ttftMs !== undefined) {
    tail.push(`ttft ${formatClock(snapshot.ttftMs)}`)
  }
  if (options.showTokenCount) {
    tail.push(`${formatCount(snapshot.tokens)} tok`)
  }
  if (options.showElapsed) {
    tail.push(formatClock(snapshot.elapsed))
  }
  return tail
}

/**
 * Build the full display line from a snapshot. Pure: no TUI, no theme.
 * @param snapshot - Fully computed meter snapshot to render.
 * @param options - Which segments to include in the line.
 * @returns The single-line status string for the footer.
 */
export function formatLine(snapshot: Snapshot, options: DisplayOptions): string {
  const body: Array<string> = [graphSegment(options, snapshot)],
    tail = tailParts(options, snapshot),
    trend = trendSegment(options, snapshot)
  if (trend.length > 0) {
    body.push(trend)
  }
  let line = `${options.label} ${body.join(" ")}`
  if (tail.length > 0) {
    line += ` · ${tail.join(" · ")}`
  }
  return line
}
