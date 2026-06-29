/**
 * time.ts — temporal sense for the brain, as a pure function.
 *
 * The model (Gemma) has NO internal sense of wall-clock time and cannot reason about raw epoch
 * milliseconds — `ts="1751177470241"` is noise to it. So everywhere a time reaches the brain we render
 * it as a human RELATIVE AGE ("40s ago", "1m30s"), computed against one authoritative `now` per beat.
 * This mirrors Shipyard's model (a single stamped <current-time> + explicit elapsed deltas; the agent
 * is told it has no clock and must read the resource).
 *
 * Two knobs, both deliberate:
 *   - FLOOR (2s): below this, a gap reads as "just now". At conversational speed sub-2s gaps are the
 *     natural rhythm of speech — reasoning about a 0.8s gap is reading tea leaves.
 *   - QUANTUM (5s, then 30s past a minute): round so the SAME event shows a STABLE age beat-to-beat.
 *     Exact ages would make one utterance read "37s", then "41s", then "46s" every beat — jitter that
 *     destabilises the model and busts the prompt cache. Rounding pins the value until it really moves.
 *
 * Nothing here loses information from the SYSTEM: the append-log keeps exact epoch `ts`, and the web
 * console still shows precise clock times. This coarsening is ONLY the brain's view, on purpose.
 */

/** Below this elapsed, render "just now" — conversational micro-gaps are noise, not signal. */
export const FLOOR_MS = 2_000;
/** Under a minute: round ages to the nearest 5s (the smallest bucket above the floor). */
export const QUANTUM_MS = 5_000;
/** A minute, the boundary where we switch from seconds to a coarser minute grain. */
export const MINUTE_MS = 60_000;
/** A minute or more: round to the nearest 30s and render as minutes ("1m", "1m30s", "2m"). */
export const MINUTE_QUANTUM_MS = 30_000;

/** Round a non-negative duration to the nearest multiple of `quantum`. */
function roundTo(ms: number, quantum: number): number {
  return Math.round(ms / quantum) * quantum;
}

/**
 * Format an elapsed duration (ms) as a stable, human age token — WITHOUT a suffix, so callers compose
 * the right phrasing ("40s ago", "for 40s", "running 40s"):
 *   - < 2s          → "just now"   (floor)
 *   - 2s – <60s     → nearest 5s, min one bucket → "5s", "10s", "40s"
 *   - ≥ 60s         → nearest 30s as minutes      → "1m", "1m30s", "2m"
 * Non-finite or negative input (clock skew, same instant) → "just now".
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < FLOOR_MS) return 'just now';
  // Under a minute: nearest 5s, but never round below one bucket (a 2.4s gap is past the floor, so it
  // should read "5s", not collapse to "0s").
  const rounded =
    ms < MINUTE_MS ? Math.max(QUANTUM_MS, roundTo(ms, QUANTUM_MS)) : roundTo(ms, MINUTE_QUANTUM_MS);
  const totalSec = Math.round(rounded / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec === 0 ? `${min}m` : `${min}m${sec}s`;
}

/**
 * The elapsed age between two epoch-ms instants, formatted. `then` is the past event, `now` the beat's
 * authoritative clock. Defensive against `then > now` (skew) — collapses to "just now".
 */
export function ageOf(then: number, now: number): string {
  return formatElapsed(now - then);
}

/**
 * Quantise an epoch-ms instant DOWN to a step (default 5s) so the beat's stamped `now` stays stable for
 * the whole step instead of changing every beat. Floor (not round) so the displayed clock never reads
 * ahead of the real time.
 */
export function quantizeNow(ms: number, stepMs: number = QUANTUM_MS): number {
  return Math.floor(ms / stepMs) * stepMs;
}
