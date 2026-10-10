/**
 * Pure measurement logic for the tokens-per-second meter. No plugin or TUI
 * imports, so it can be unit tested directly.
 *
 * Model (OpenCode V2):
 *   - A "turn" is one session execution: a prompt through completion, spanning
 *     every model step and tool call inside it. It is opened by `beginTurn`
 *     (or lazily by the first `record`) and closed by `settle`.
 *   - A "request" is one model step. The first request of a turn anchors TTFT;
 *     later requests mark burst boundaries — step transitions and tool pauses.
 *   - `samples` drive the live rate over a trailing window.
 *   - `buckets` count tokens per wall-clock second and drive the VU graph.
 *   - Exact provider tokens arrive per step (`noteExact`) and are applied when
 *     the turn settles, rescaling the estimate-based graph to the true total.
 *   - On settle the computed frame is frozen so the last result stays on
 *     screen until the next turn produces tokens.
 */

/** One streamed chunk and when it arrived. */
export type Sample = { at: number; tokens: number }

/** Tunables shared by the rate estimator. */
export type RateConfig = {
  rollingWindowMs: number
  idleTimeoutMs: number
  minSpanMs: number
}

/** Direction of the rate over the last two complete seconds. */
export type Trend = "up" | "down" | "flat" | "none"

/** How VU columns map to height. */
export type VuScale = "auto" | "fixed"

/** A fully computed view of one meter at a point in time. */
export type Snapshot = {
  rate: number
  avg: number
  live: boolean
  settled: boolean
  tokens: number
  elapsed: number
  peak: number
  peakBucket: number
  trend: Trend
  trendPct: number
  ttftMs: number | undefined
  vu: number[]
}

/** Coarse speed band used for color. */
export type Tier = "idle" | "slow" | "medium" | "fast"

const encoder = new TextEncoder()

/** Eight vertical levels plus empty, low to high. */
const VU_GLYPHS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const

/** Generous column count for the frozen frame; views slice it to their width. */
const FROZEN_COLUMNS = 240

/** Approximate a token from four UTF-8 bytes. Stable while streaming. */
export function approxTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.round(encoder.encode(text).length / 4))
}

/**
 * Tokens per second over the trailing window, or -1 when there is nothing to
 * measure: no samples at all, nothing in the window, or the newest sample has
 * gone idle.
 */
export function measureRate(samples: Sample[], now: number, config: RateConfig): number {
  const newest = samples.length > 0 ? samples[samples.length - 1] : undefined
  if (!newest) return -1
  if (now - newest.at > config.idleTimeoutMs) return -1

  const floor = now - config.rollingWindowMs
  let index = samples.length - 1
  let tokens = 0
  while (index >= 0) {
    const sample = samples[index]
    if (!sample || sample.at < floor) break
    tokens += sample.tokens
    index -= 1
  }

  const oldest = samples[index + 1]
  if (!oldest) return -1
  const span = Math.max(config.minSpanMs, now - oldest.at)
  return (tokens / span) * 1000
}

/** `-` when idle, one decimal below 100, whole numbers above. */
export function formatRate(rate: number): string {
  if (rate < 0) return "-"
  return rate >= 100 ? String(Math.round(rate)) : rate.toFixed(1)
}

/** Compact token counts: 999, 1.5k, 2.5m. */
export function formatCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}

/** Seconds below a minute, then `1m5s`. */
export function formatClock(ms: number): string {
  const seconds = Math.max(0, ms) / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  return `${Math.floor(seconds / 60)}m${Math.floor(seconds % 60)}s`
}

/**
 * Denominator for VU heights.
 *
 * `auto` uses the turn peak so one column height means one speed for the whole
 * turn, even after the tallest column has scrolled out of view; the largest
 * visible value is honoured as a floor so the graph always fills its height.
 * `fixed` uses an absolute full-scale target.
 */
export function vuFullScale(values: number[], mode: VuScale, fixedTps: number, peak = 0): number {
  if (mode === "fixed") return Math.max(1, fixedTps)
  let max = Math.max(0, peak)
  for (const value of values) if (value > max) max = value
  return Math.max(1, max)
}

/** Render the newest `maxCells` values as glyphs; short histories stay short. */
export function renderVu(values: number[], maxCells: number, fullTps: number): string {
  const cap = Math.max(0, Math.floor(maxCells))
  if (cap === 0) return ""
  const scale = fullTps <= 0 ? 1 : fullTps
  const top = VU_GLYPHS.length - 1
  return values
    .slice(-cap)
    .map((value) => {
      // Any non-zero column gets at least one block so a slow second never
      // reads like a gap. True zeros stay blank (and are trimmed at the edges).
      const level = value <= 0 ? 0 : Math.max(1, Math.min(top, Math.round((value / scale) * top)))
      return VU_GLYPHS[level]
    })
    .join("")
}

/** Band a rate into a color tier. */
export function rateTier(rate: number, slowTps: number, fastTps: number): Tier {
  if (rate < 0) return "idle"
  if (rate < slowTps) return "slow"
  if (rate < fastTps) return "medium"
  return "fast"
}

/** Which segments to include in the rendered line. */
export type DisplayOptions = {
  label: string
  showVu: boolean
  vuColumns: number
  vuScale: VuScale
  vuFullTps: number
  showTrend: boolean
  showAvg: boolean
  showPeak: boolean
  showTtft: boolean
  showTokenCount: boolean
  showElapsed: boolean
}

const TREND_GLYPHS: Record<Trend, string> = {
  up: "▲",
  down: "▼",
  flat: "▬",
  none: "",
}

/** Whether a snapshot has enough data to render anything. */
export function hasData(snapshot: Snapshot | undefined): boolean {
  return snapshot !== undefined && (snapshot.tokens > 0 || snapshot.peak > 0)
}

/** Build the full display line from a snapshot. Pure: no TUI, no theme. */
export function formatLine(snapshot: Snapshot, options: DisplayOptions): string {
  const body: string[] = []
  if (options.showVu) {
    const scale = vuFullScale(snapshot.vu, options.vuScale, options.vuFullTps, snapshot.peakBucket)
    const graph = renderVu(snapshot.vu, options.vuColumns, scale)
    if (graph) body.push(graph)
  }
  body.push(formatRate(snapshot.rate))

  const glyph = snapshot.rate >= 0 ? TREND_GLYPHS[snapshot.trend] : ""
  if (options.showTrend && glyph) {
    body.push(snapshot.trendPct > 0 ? `${glyph}${Math.round(snapshot.trendPct)}%` : glyph)
  }

  const tail: string[] = []
  if (options.showAvg) tail.push(`avg ${formatRate(snapshot.avg)}`)
  if (options.showPeak) tail.push(`pk ${formatRate(snapshot.peak)}`)
  if (options.showTtft && snapshot.ttftMs !== undefined) tail.push(`ttft ${formatClock(snapshot.ttftMs)}`)
  if (options.showTokenCount) tail.push(`${formatCount(snapshot.tokens)} tok`)
  if (options.showElapsed) tail.push(formatClock(snapshot.elapsed))

  let line = `${options.label} ${body.join(" ")}`
  if (tail.length > 0) line += ` · ${tail.join(" · ")}`
  return line
}

/** Tracks generation speed for a single session across turns. */
export class TpsMeter {
  private readonly samples: Sample[] = []
  private readonly buckets = new Map<number, number>()
  private readonly config: RateConfig
  private readonly peakConfig: RateConfig
  private readonly clock: () => number
  readonly startedAt: number
  private tokens = 0
  private exact = 0
  private settled = false
  private settledRate = 0
  private peakRate = 0
  private peakBucket = 0
  private activeMs = 0
  private segFirst: number | undefined
  private segLast: number | undefined
  private totalBytes = 0
  private turnStart: number | undefined
  private turnStarted = false
  private firstTokenAt: number | undefined
  private graphStartAt: number | undefined
  private frozen: Snapshot | undefined

  constructor(config: RateConfig, clock: () => number = Date.now, startedAt: number = clock()) {
    this.config = config
    this.clock = clock
    this.startedAt = startedAt
    // Peak is sampled over a one-second rolling window so it is a rate that
    // compares fairly with the average, not a coarse whole-second bucket.
    this.peakConfig = {
      rollingWindowMs: 1000,
      idleTimeoutMs: Number.MAX_SAFE_INTEGER,
      minSpanMs: config.minSpanMs,
    }
  }

  /**
   * Note that a new turn (execution) has begun. Does not clear the frozen
   * frame yet: the reset is deferred until the first token so the previous
   * result stays visible in the meantime.
   */
  beginTurn(at: number = this.clock()): void {
    this.turnStart = at
    this.turnStarted = false
  }

  /**
   * Note that a model request (step) was dispatched. Before the turn's first
   * token it re-anchors TTFT to the request dispatch time. Once the turn is
   * streaming it is a burst boundary — the previous step ended and a tool
   * pause followed — so it restarts the live rate while keeping the graph
   * continuous.
   */
  beginRequest(at: number = this.clock()): void {
    if (!this.turnStarted) {
      this.turnStart = at
      return
    }
    this.newSegment()
  }

  /** Drop the previous turn's data. Called by `record` on the first token. */
  private startTurn(): void {
    this.tokens = 0
    this.exact = 0
    this.totalBytes = 0
    this.samples.splice(0)
    this.buckets.clear()
    this.peakRate = 0
    this.peakBucket = 0
    this.activeMs = 0
    this.segFirst = undefined
    this.segLast = undefined
    this.settled = false
    this.settledRate = 0
    this.firstTokenAt = undefined
    this.graphStartAt = undefined
    this.frozen = undefined
    this.turnStarted = true
  }

  /**
   * Restart the live rate for a new burst (tool call, next step) while keeping
   * the graph and turn totals, so the graph stays continuous. The finished
   * segment's span is folded into the active generation time so the average
   * ignores the pause that follows.
   */
  newSegment(): void {
    if (this.segFirst !== undefined && this.segLast !== undefined) {
      const span = this.segLast - this.segFirst
      if (span >= 0) this.activeMs += span
    }
    this.segFirst = undefined
    this.segLast = undefined
    this.samples.splice(0)
  }

  /**
   * Record a streamed chunk and return the tokens attributed to it.
   *
   * Tokens are derived from a cumulative byte count, so the total is invariant
   * to how the stream is chopped into chunks: `round(totalBytes / 4)` no
   * matter the fragmentation. Per-chunk attribution is the delta of that
   * cumulative figure.
   */
  record(text: string, at: number = this.clock()): number {
    const bytes = encoder.encode(text).length
    if (bytes === 0) return 0
    if (!this.turnStarted) this.startTurn()
    const before = Math.round(this.totalBytes / 4)
    this.totalBytes += bytes
    const tokens = Math.round(this.totalBytes / 4) - before
    if (tokens === 0) return 0
    this.samples.push({ at, tokens })
    this.tokens += tokens
    if (this.firstTokenAt === undefined) this.firstTokenAt = at
    if (this.graphStartAt === undefined) this.graphStartAt = at
    if (this.segFirst === undefined) this.segFirst = at
    this.segLast = at
    const second = Math.floor(at / 1000)
    const bucket = (this.buckets.get(second) ?? 0) + tokens
    this.buckets.set(second, bucket)
    if (bucket > this.peakBucket) this.peakBucket = bucket
    const instant = measureRate(this.samples, at, this.peakConfig)
    if (instant > this.peakRate) this.peakRate = instant
    this.settled = false
    this.frozen = undefined
    return tokens
  }

  /**
   * Accumulate the provider's exact output tokens for one finished step so
   * settling can prefer them over the byte estimate.
   */
  noteExact(tokens: number): void {
    if (Number.isFinite(tokens) && tokens > 0) this.exact += tokens
  }

  /**
   * Close the turn, prefer exact provider tokens over the estimate, and freeze
   * the final frame. `exactTokens` overrides the accumulated per-step totals.
   */
  settle(at: number = this.clock(), exactTokens?: number): void {
    const exact = exactTokens !== undefined ? exactTokens : this.exact
    // Capture the estimate before replacing it: the per-second bars are built
    // from estimated tokens, so they need the same ratio applied to match the
    // provider's exact total.
    const estimate = this.tokens
    if (exact > 0) this.tokens = exact
    const measured = measureRate(this.samples, at, this.config)
    // With no fresh samples (the turn ended right after a tool call), fall back
    // to the average instead of freezing a misleading 0.
    this.settledRate = measured >= 0 ? measured : this.average()
    const instant = measureRate(this.samples, at, this.peakConfig)
    if (instant > this.peakRate) this.peakRate = instant
    if (exact > 0 && estimate > 0) {
      const ratio = exact / estimate
      if (Number.isFinite(ratio) && ratio > 0) this.rescale(ratio)
    }
    this.settled = true
    this.frozen = this.compute(at, FROZEN_COLUMNS)
  }

  /** Scale estimate-based totals and graph values to the exact token total. */
  private rescale(ratio: number): void {
    for (const [second, tokens] of this.buckets) {
      const scaled = Math.round(tokens * ratio)
      this.buckets.set(second, Number.isFinite(scaled) ? Math.max(0, scaled) : tokens)
    }
    const peakBucket = Math.round(this.peakBucket * ratio)
    if (Number.isFinite(peakBucket)) this.peakBucket = Math.max(0, peakBucket)
    this.peakRate *= ratio
  }

  /**
   * Drop samples older than the rolling window. Buckets are kept for the whole
   * turn so the graph survives pauses and the held frame stays complete.
   */
  prune(at: number = this.clock()): void {
    const floor = at - this.config.rollingWindowMs
    const first = this.samples[0]
    if (first && first.at < floor) {
      const kept = this.samples.filter((sample) => sample.at >= floor)
      this.samples.splice(0, this.samples.length, ...kept)
    }
  }

  /** Current view: the frozen frame once settled, otherwise a live computation. */
  snapshot(at: number = this.clock(), columns = 12): Snapshot {
    const frozen = this.frozen
    if (this.settled && frozen) {
      const vu = frozen.vu.slice(-Math.max(0, columns))
      return vu.length === frozen.vu.length ? frozen : { ...frozen, vu }
    }
    return this.compute(at, columns)
  }

  /**
   * Average tokens per second over the turn's active generation time: the sum
   * of finished segment spans plus the current segment's span, so tool pauses
   * do not drag the average down.
   */
  private average(): number {
    if (this.tokens === 0) return 0
    const current =
      this.segFirst !== undefined && this.segLast !== undefined ? Math.max(0, this.segLast - this.segFirst) : 0
    const span = Math.max(this.config.minSpanMs, this.activeMs + current)
    return (this.tokens / span) * 1000
  }

  private compute(at: number, columns: number): Snapshot {
    const measured = measureRate(this.samples, at, this.config)
    const current = Math.floor(at / 1000)
    const cap = Math.max(0, Math.floor(columns))

    // One column per second since the turn's first token, capped to the
    // requested width. Leading and trailing empty seconds are dropped so the
    // graph starts at real data instead of leaving a gap after the label.
    const vu: number[] = []
    if (cap > 0 && this.graphStartAt !== undefined) {
      const start = Math.max(Math.floor(this.graphStartAt / 1000), current - cap + 1)
      for (let second = start; second <= current; second += 1) vu.push(this.buckets.get(second) ?? 0)
      while (vu.length > 0 && vu[0] === 0) vu.shift()
      while (vu.length > 0 && vu[vu.length - 1] === 0) vu.pop()
    }

    // Trend compares the last two complete seconds, skipping the partial one.
    const last = this.buckets.get(current - 1) ?? 0
    const prior = this.buckets.get(current - 2) ?? 0
    let trend: Trend = "none"
    let trendPct = 0
    if (last !== 0 || prior !== 0) {
      if (last > prior) {
        trend = "up"
        trendPct = prior > 0 ? ((last - prior) / prior) * 100 : 100
      } else if (last < prior) {
        trend = "down"
        trendPct = prior > 0 ? ((prior - last) / prior) * 100 : 100
      } else {
        trend = "flat"
      }
    }

    const ttftMs =
      this.turnStart === undefined || this.firstTokenAt === undefined
        ? undefined
        : Math.max(0, this.firstTokenAt - this.turnStart)

    return {
      rate: this.settled ? this.settledRate : measured,
      avg: this.average(),
      live: !this.settled && measured >= 0,
      settled: this.settled,
      tokens: this.tokens,
      elapsed: at - (this.turnStart ?? this.startedAt),
      peak: Math.max(this.peakRate, this.average()),
      peakBucket: this.peakBucket,
      trend,
      trendPct,
      ttftMs,
      vu,
    }
  }
}

/** Keeps one `TpsMeter` per session. */
export class MeterStore {
  private readonly meters = new Map<string, TpsMeter>()
  private readonly config: RateConfig
  private readonly clock: () => number

  constructor(config: RateConfig, clock: () => number = Date.now) {
    this.config = config
    this.clock = clock
  }

  get size(): number {
    return this.meters.size
  }

  beginTurn(sessionID: string, at?: number): void {
    this.meter(sessionID).beginTurn(at)
  }

  beginRequest(sessionID: string, at?: number): void {
    this.meter(sessionID).beginRequest(at)
  }

  record(sessionID: string, text: string, at?: number): void {
    this.meter(sessionID).record(text, at)
  }

  /** Only sessions with a live meter can receive exact step totals. */
  noteExact(sessionID: string, tokens: number): boolean {
    const meter = this.meters.get(sessionID)
    if (!meter) return false
    meter.noteExact(tokens)
    return true
  }

  newSegment(sessionID: string): boolean {
    const meter = this.meters.get(sessionID)
    if (!meter) return false
    meter.newSegment()
    return true
  }

  settle(sessionID: string, at?: number): boolean {
    const meter = this.meters.get(sessionID)
    if (!meter) return false
    meter.settle(at)
    return true
  }

  /** Forget a session's meter, e.g. when the session is deleted. */
  drop(sessionID: string): boolean {
    return this.meters.delete(sessionID)
  }

  snapshot(sessionID: string, at?: number, columns?: number): Snapshot | undefined {
    return this.meters.get(sessionID)?.snapshot(at, columns)
  }

  prune(at?: number): void {
    for (const meter of this.meters.values()) meter.prune(at)
  }

  private meter(sessionID: string): TpsMeter {
    let meter = this.meters.get(sessionID)
    if (!meter) {
      meter = new TpsMeter(this.config, this.clock)
      this.meters.set(sessionID, meter)
    }
    return meter
  }
}
