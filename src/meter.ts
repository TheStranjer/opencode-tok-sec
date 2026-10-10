/**
 * Pure measurement logic for the tokens-per-second meter. No plugin or TUI
 * imports, so it can be unit tested directly. Rendering lives in `display.ts`.
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
export type Sample = {
  readonly at: number
  readonly tokens: number
}

/** Tunables shared by the rate estimator. */
export type RateConfig = {
  readonly rollingWindowMs: number
  readonly idleTimeoutMs: number
  readonly minSpanMs: number
}

/** Direction of the rate over the last two complete seconds. */
export type Trend = "down" | "flat" | "none" | "up"

/** A fully computed view of one meter at a point in time. */
export type Snapshot = {
  readonly avg: number
  readonly elapsed: number
  readonly live: boolean
  readonly peak: number
  readonly peakBucket: number
  readonly rate: number
  readonly settled: boolean
  readonly tokens: number
  readonly trend: Trend
  readonly trendPct: number
  readonly ttftMs: number | undefined
  readonly vu: ReadonlyArray<number>
}

const DEFAULT_COLUMNS = 12,
  /** Generous column count for the frozen frame; views slice it to their width. */
  FROZEN_COLUMNS = 240,
  KILO = 1000,
  encoder = new TextEncoder()

/**
 * Approximate a token from four UTF-8 bytes. Stable while streaming.
 * @param text - Chunk of streamed text to approximate a token count for.
 * @returns Estimated token count, at least 1 for non-empty input.
 */
export function approxTokens(text: string): number {
  if (text.length === 0) {
    return 0
  }
  return Math.max(1, Math.round(encoder.encode(text).length / 4))
}

/**
 * Tokens per second over the trailing window, or -1 when there is nothing to
 * measure: no samples at all, nothing in the window, or the newest sample has
 * gone idle.
 * @param samples - Chronological streamed samples to rate over.
 * @param now - Current wall-clock time in milliseconds.
 * @param config - Rolling window, idle timeout, and minimum span tunables.
 * @returns Tokens per second, or -1 when there is nothing to measure.
 */
export function measureRate(
  samples: ReadonlyArray<Sample>,
  now: number,
  config: RateConfig,
): number {
  const newest = samples.at(-1)
  if (newest === undefined) {
    return -1
  }
  if (now - newest.at > config.idleTimeoutMs) {
    return -1
  }

  const floor = now - config.rollingWindowMs
  let index = samples.length - 1,
    tokens = 0
  while (index >= 0) {
    const sample = samples[index]
    if (sample === undefined || sample.at < floor) {
      break
    }
    tokens += sample.tokens
    index -= 1
  }

  const oldest = samples[index + 1]
  if (oldest === undefined) {
    return -1
  }
  const span = Math.max(config.minSpanMs, now - oldest.at)
  return (tokens / span) * KILO
}

/** Tracks generation speed for a single session across turns. */
export class TpsMeter {
  private activeMs = 0
  private readonly buckets = new Map<number, number>()
  private readonly clock: () => number
  private readonly config: RateConfig
  private exact = 0
  private firstTokenAt: number | undefined
  private frozen: Snapshot | undefined
  private graphStartAt: number | undefined
  private peakBucket = 0
  private peakRate = 0
  private readonly peakConfig: RateConfig
  private readonly samples: Array<Sample> = []
  private segFirst: number | undefined
  private segLast: number | undefined
  private settled = false
  private settledRate = 0
  public readonly startedAt: number
  private tokens = 0
  private totalBytes = 0
  private turnStart: number | undefined
  private turnStarted = false

  /**
   * @param config - Rolling window, idle timeout, and minimum span tunables.
   * @param clock - Time source in milliseconds; defaults to `Date.now`.
   * @param startedAt - Epoch used for elapsed when no turn start is known.
   */
  public constructor(config: RateConfig, clock: () => number = Date.now, startedAt: number = clock()) {
    this.clock = clock
    this.config = config
    this.startedAt = startedAt
    /* Peak is sampled over a one-second rolling window so it is a rate that
     * compares fairly with the average, not a coarse whole-second bucket. */
    this.peakConfig = {
      idleTimeoutMs: Number.MAX_SAFE_INTEGER,
      minSpanMs: config.minSpanMs,
      rollingWindowMs: KILO,
    }
  }

  /**
   * Note that a new turn (execution) has begun. Does not clear the frozen
   * frame yet: the reset is deferred until the first token so the previous
   * result stays visible in the meantime.
   * @param at - Turn start timestamp; defaults to the current clock time.
   */
  public beginTurn(at: number = this.clock()): void {
    this.turnStart = at
    this.turnStarted = false
  }

  /**
   * Note that a model request (step) was dispatched. Before the turn's first
   * token it re-anchors TTFT to the request dispatch time. Once the turn is
   * streaming it is a burst boundary — the previous step ended and a tool
   * pause followed — so it restarts the live rate while keeping the graph
   * continuous.
   * @param at - Request dispatch timestamp; defaults to the current clock time.
   */
  public beginRequest(at: number = this.clock()): void {
    if (!this.turnStarted) {
      this.turnStart = at
      return
    }
    this.newSegment()
  }

  /**
   * Restart the live rate for a new burst (tool call, next step) while keeping
   * the graph and turn totals, so the graph stays continuous. The finished
   * segment's span is folded into the active generation time so the average
   * ignores the pause that follows.
   */
  public newSegment(): void {
    if (this.segFirst !== undefined && this.segLast !== undefined) {
      const span = this.segLast - this.segFirst
      if (span >= 0) {
        this.activeMs += span
      }
    }
    this.samples.splice(0)
    this.segFirst = undefined
    this.segLast = undefined
  }

  /**
   * Record a streamed chunk and return the tokens attributed to it.
   *
   * Tokens are derived from a cumulative byte count, so the total is invariant
   * to how the stream is chopped into chunks: `round(totalBytes / 4)` no
   * matter the fragmentation. Per-chunk attribution is the delta of that
   * cumulative figure.
   * @param text - Streamed chunk text.
   * @param at - Chunk arrival timestamp; defaults to the current clock time.
   * @returns Tokens attributed to this chunk (may be 0 for sub-token chunks).
   */
  public record(text: string, at: number = this.clock()): number {
    const bytes = encoder.encode(text).length
    if (bytes === 0) {
      return 0
    }
    if (!this.turnStarted) {
      this.startTurn()
    }
    const before = Math.round(this.totalBytes / 4)
    this.totalBytes += bytes
    const tokens = Math.round(this.totalBytes / 4) - before
    if (tokens === 0) {
      return 0
    }
    this.samples.push({ at, tokens })
    this.tokens += tokens
    this.markFirstTokens(at)
    this.segLast = at
    const bucket = (this.buckets.get(Math.floor(at / KILO)) ?? 0) + tokens
    this.buckets.set(Math.floor(at / KILO), bucket)
    if (bucket > this.peakBucket) {
      this.peakBucket = bucket
    }
    const instant = measureRate(this.samples, at, this.peakConfig)
    if (instant > this.peakRate) {
      this.peakRate = instant
    }
    this.frozen = undefined
    this.settled = false
    return tokens
  }

  /**
   * Accumulate the provider's exact output tokens for one finished step so
   * settling can prefer them over the byte estimate.
   * @param tokens - Exact output + reasoning count reported by the provider.
   */
  public noteExact(tokens: number): void {
    if (Number.isFinite(tokens) && tokens > 0) {
      this.exact += tokens
    }
  }

  /**
   * Close the turn, prefer exact provider tokens over the estimate, and freeze
   * the final frame. `exactTokens` overrides the accumulated per-step totals.
   * @param at - Settle timestamp; defaults to the current clock time.
   * @param exactTokens - Optional provider-exact total for the whole turn.
   */
  public settle(at: number = this.clock(), exactTokens?: number): void {
    const estimate = this.tokens,

      /* Capture the estimate before replacing it: the per-second bars are built
       * from estimated tokens, so they need the same ratio applied to match the
       * provider's exact total. */
      exact = exactTokens ?? this.exact
    if (exact > 0) {
      this.tokens = exact
    }
    const measured = measureRate(this.samples, at, this.config)

    /* With no fresh samples (the turn ended right after a tool call), fall back
     * to the average instead of freezing a misleading 0. */
    this.settledRate = measured >= 0 ? measured : this.average()
    const instant = measureRate(this.samples, at, this.peakConfig)
    if (instant > this.peakRate) {
      this.peakRate = instant
    }
    if (exact > 0 && estimate > 0) {
      const ratio = exact / estimate
      if (Number.isFinite(ratio) && ratio > 0) {
        this.rescale(ratio)
      }
    }
    this.settled = true
    this.frozen = this.compute(at, FROZEN_COLUMNS)
  }

  /**
   * Drop samples older than the rolling window. Buckets are kept for the whole
   * turn so the graph survives pauses and the held frame stays complete.
   * @param at - Prune timestamp; defaults to the current clock time.
   */
  public prune(at: number = this.clock()): void {
    const [first] = this.samples,
      floor = at - this.config.rollingWindowMs
    if (first !== undefined && first.at < floor) {
      const kept = this.samples.filter((sample) => sample.at >= floor)
      this.samples.splice(0, this.samples.length, ...kept)
    }
  }

  /**
   * Current view: the frozen frame once settled, otherwise a live computation.
   * @param at - View timestamp; defaults to the current clock time.
   * @param columns - Number of VU columns the view may show.
   * @returns The snapshot to render right now.
   */
  public snapshot(at: number = this.clock(), columns: number = DEFAULT_COLUMNS): Snapshot {
    const { frozen } = this
    if (this.settled && frozen !== undefined) {
      const vu = frozen.vu.slice(-Math.max(0, columns))
      return vu.length === frozen.vu.length ? frozen : { ...frozen, vu }
    }
    return this.compute(at, columns)
  }

  /**
   * Stamp the turn/segment firsts on the first tokens, leaving later ones.
   * @param at - Arrival time of the turn/segment's first tokens.
   */
  private markFirstTokens(at: number): void {
    this.firstTokenAt ??= at
    this.graphStartAt ??= at
    this.segFirst ??= at
  }

  /** Drop the previous turn's data. Called by `record` on the first token. */
  private startTurn(): void {
    this.activeMs = 0
    this.buckets.clear()
    this.exact = 0
    this.firstTokenAt = undefined
    this.frozen = undefined
    this.graphStartAt = undefined
    this.peakBucket = 0
    this.peakRate = 0
    this.samples.splice(0)
    this.segFirst = undefined
    this.segLast = undefined
    this.settled = false
    this.settledRate = 0
    this.tokens = 0
    this.totalBytes = 0
    this.turnStarted = true
  }

  /**
   * Scale estimate-based totals and graph values to the exact token total.
   * @param ratio - Exact-over-estimate multiplier from the settled turn.
   */
  private rescale(ratio: number): void {
    for (const [second, tokens] of this.buckets) {
      const scaled = Math.round(tokens * ratio)
      this.buckets.set(second, Number.isFinite(scaled) ? Math.max(0, scaled) : tokens)
    }
    const peakBucket = Math.round(this.peakBucket * ratio)
    if (Number.isFinite(peakBucket)) {
      this.peakBucket = Math.max(0, peakBucket)
    }
    this.peakRate *= ratio
  }

  /**
   * Average tokens per second over the turn's active generation time: the sum
   * of finished segment spans plus the current segment's span, so tool pauses
   * do not drag the average down.
   * @returns Active-time average rate, 0 before any tokens arrive.
   */
  private average(): number {
    if (this.tokens === 0) {
      return 0
    }
    const current =
      this.segFirst !== undefined && this.segLast !== undefined ? Math.max(0, this.segLast - this.segFirst) : 0,
      span = Math.max(this.config.minSpanMs, this.activeMs + current)
    return (this.tokens / span) * KILO
  }

  /**
   * One column per second since the turn's first token, capped to the
   * requested width. Leading and trailing empty seconds are dropped so the
   * graph starts at real data instead of leaving a gap after the label.
   * @param at - Frame timestamp the columns are computed for.
   * @param cap - Maximum number of columns to return.
   * @returns Per-second token counts, trimmed of empty edges.
   */
  private vuColumns(at: number, cap: number): Array<number> {
    const vu: Array<number> = []
    if (cap <= 0 || this.graphStartAt === undefined) {
      return vu
    }
    const current = Math.floor(at / KILO),
      first = Math.max(Math.floor(this.graphStartAt / KILO), current - cap + 1)
    for (let second = first; second <= current; second += 1) {
      vu.push(this.buckets.get(second) ?? 0)
    }
    while (vu.length > 0 && vu[0] === 0) {
      vu.shift()
    }
    while (vu.length > 0 && vu.at(-1) === 0) {
      vu.pop()
    }
    return vu
  }

  /**
   * Trend direction and magnitude over the last two complete seconds.
   * @param current - Index of the wall-clock second the frame lands in.
   * @returns The trend state and its percentage change.
   */
  private trendParts(current: number): { readonly pct: number; readonly state: Trend } {
    const last = this.buckets.get(current - 1) ?? 0,
      prior = this.buckets.get(current - 2) ?? 0
    if (last === 0 && prior === 0) {
      return { pct: 0, state: "none" }
    }
    if (last > prior) {
      return { pct: prior > 0 ? ((last - prior) / prior) * 100 : 100, state: "up" }
    }
    if (last < prior) {
      return { pct: prior > 0 ? ((prior - last) / prior) * 100 : 100, state: "down" }
    }
    return { pct: 0, state: "flat" }
  }

  /**
   * Full live-frame computation for the given time and width.
   * @param at - Frame timestamp in milliseconds.
   * @param columns - Number of VU columns the frame may show.
   * @returns The computed snapshot.
   */
  private compute(at: number, columns: number): Snapshot {
    const cap = Math.max(0, Math.floor(columns)),
      current = Math.floor(at / KILO),
      measured = measureRate(this.samples, at, this.config),
      { pct, state } = this.trendParts(current),
      ttftMs =
        this.turnStart === undefined || this.firstTokenAt === undefined
          ? undefined
          : Math.max(0, this.firstTokenAt - this.turnStart),
      vu = this.vuColumns(at, cap)

    return {
      avg: this.average(),
      elapsed: at - (this.turnStart ?? this.startedAt),
      live: !this.settled && measured >= 0,
      peak: Math.max(this.peakRate, this.average()),
      peakBucket: this.peakBucket,
      rate: this.settled ? this.settledRate : measured,
      settled: this.settled,
      tokens: this.tokens,
      trend: state,
      trendPct: pct,
      ttftMs,
      vu,
    }
  }
}

/** Keeps one `TpsMeter` per session. */
export class MeterStore {
  private readonly clock: () => number
  private readonly config: RateConfig
  private readonly meters = new Map<string, TpsMeter>()

  /**
   * @param config - Rate estimator tunables shared by every meter.
   * @param clock - Time source in milliseconds; defaults to `Date.now`.
   */
  public constructor(config: RateConfig, clock: () => number = Date.now) {
    this.clock = clock
    this.config = config
  }

  public get size(): number {
    return this.meters.size
  }

  /**
   * @param sessionID - Session whose turn began.
   * @param at - Optional execution start timestamp.
   */
  public beginTurn(sessionID: string, at?: number): void {
    this.meter(sessionID).beginTurn(at)
  }

  /**
   * @param sessionID - Session whose model request was dispatched.
   * @param at - Optional request dispatch timestamp.
   */
  public beginRequest(sessionID: string, at?: number): void {
    this.meter(sessionID).beginRequest(at)
  }

  /**
   * @param sessionID - Session that streamed the chunk.
   * @param text - Streamed chunk text.
   * @param at - Optional chunk arrival timestamp.
   */
  public record(sessionID: string, text: string, at?: number): void {
    this.meter(sessionID).record(text, at)
  }

  /**
   * Accumulate exact step tokens. Only sessions with a live meter can receive
   * them.
   * @param sessionID - Session the finished step belongs to.
   * @param tokens - Exact output + reasoning count for the step.
   * @returns True when a meter existed to accumulate them.
   */
  public noteExact(sessionID: string, tokens: number): boolean {
    const meter = this.meters.get(sessionID)
    if (meter === undefined) {
      return false
    }
    meter.noteExact(tokens)
    return true
  }

  /**
   * @param sessionID - Session entering a tool pause or next step.
   * @returns True when a live meter was restarted.
   */
  public newSegment(sessionID: string): boolean {
    const meter = this.meters.get(sessionID)
    if (meter === undefined) {
      return false
    }
    meter.newSegment()
    return true
  }

  /**
   * @param sessionID - Session whose execution finished.
   * @param at - Optional settle timestamp.
   * @returns True when a live meter was settled.
   */
  public settle(sessionID: string, at?: number): boolean {
    const meter = this.meters.get(sessionID)
    if (meter === undefined) {
      return false
    }
    meter.settle(at)
    return true
  }

  /**
   * Forget a session's meter, e.g. when the session is deleted.
   * @param sessionID - Session to free.
   * @returns True when a meter existed and was removed.
   */
  public drop(sessionID: string): boolean {
    return this.meters.delete(sessionID)
  }

  /**
   * @param sessionID - Session to view.
   * @param at - Optional view timestamp.
   * @param columns - Optional number of VU columns the view may show.
   * @returns The session's snapshot, when it has a meter.
   */
  public snapshot(sessionID: string, at?: number, columns?: number): Snapshot | undefined {
    return this.meters.get(sessionID)?.snapshot(at, columns)
  }

  /**
   * @param at - Optional prune timestamp shared across meters.
   */
  public prune(at?: number): void {
    for (const meter of this.meters.values()) {
      meter.prune(at)
    }
  }

  private meter(sessionID: string): TpsMeter {
    let meter = this.meters.get(sessionID)
    if (meter === undefined) {
      meter = new TpsMeter(this.config, this.clock)
      this.meters.set(sessionID, meter)
    }
    return meter
  }
}
