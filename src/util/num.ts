/**
 * Integer coercion for values that reach a query or a bound.
 *
 * `Math.max(1, Math.min(20, Math.floor(NaN)))` is `NaN`, so the obvious clamp
 * does not clamp: every comparison against NaN is false and it passes straight
 * through. Combined with `Number(opts.depth)` on a CLI flag, `--depth abc`
 * interpolated the literal text `NaN` into a Cypher query. Found by the
 * adversarial suite, not by any happy path.
 *
 * Anything non-finite falls back to a stated default rather than propagating.
 */
export function safeInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return clamp(fallback, min, max);
  return clamp(Math.floor(n), min, max);
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/**
 * HydraDB's default `max_traversal_hops` (src/core/config.rs: 16). A traversal
 * or path procedure asking for more than this is rejected by the server, so
 * every depth this project sends is clamped to it rather than to a number that
 * merely looks safe. Clamping to 20 produced a rejected query that surfaced as
 * "algo.MSpaths unavailable", which was doubly wrong: the procedure was fine,
 * the bound was not.
 */
export const MAX_TRAVERSAL_HOPS = 16;
