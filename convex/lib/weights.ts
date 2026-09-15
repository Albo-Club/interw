/**
 * Criterion weighting.
 *
 * Recruiters type whatever numbers feel right — 3 criteria at 10, or one at
 * 80 and one at 15. The stored weight is never rewritten under them: it is
 * normalised at read time, so editing a set does not make the other rows jump
 * around while they work.
 *
 * Normalised weights must sum to exactly 100, or a weighted score does not
 * mean what the report says it means. Three equal criteria are 34/33/33, not
 * 33/33/33 — hence the largest-remainder pass.
 */

export type Weighted = { weight: number }

export type Normalized<T> = T & { normalizedWeight: number }

/**
 * Distribute 100 points across `items` in proportion to their raw weights.
 *
 * - An empty set yields an empty set.
 * - All-zero (or negative) weights fall back to an even split: the recruiter
 *   said nothing about priority, so the criteria count equally. Refusing here
 *   would block a wizard step over a default.
 * - Negative weights are floored at 0 rather than inverting a criterion.
 */
export function normalizeWeights<T extends Weighted>(
  items: Array<T>,
): Array<Normalized<T>> {
  if (items.length === 0) return []

  const raw = items.map((item) => Math.max(0, item.weight))
  const total = raw.reduce((sum, w) => sum + w, 0)

  const exact =
    total > 0
      ? raw.map((w) => (w / total) * 100)
      : raw.map(() => 100 / items.length)

  // Largest remainder: floor everything, then hand the leftover points to the
  // items that lost the most in rounding.
  const floored = exact.map((value) => Math.floor(value))
  let remainder = 100 - floored.reduce((sum, value) => sum + value, 0)
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)

  const result = floored.slice()
  for (const { index } of order) {
    if (remainder <= 0) break
    result[index] += 1
    remainder -= 1
  }

  return items.map((item, index) => ({
    ...item,
    normalizedWeight: result[index],
  }))
}

/**
 * Weighted average of per-criterion scores, on the scale the scores use.
 *
 * Criteria the model did not score are dropped and the remaining weights
 * re-normalised, so a missing criterion lowers confidence rather than silently
 * scoring the candidate zero on it.
 */
export function weightedScore(
  entries: Array<{ normalizedWeight: number; score: number | null }>,
): number | null {
  const scored = entries.filter(
    (e): e is { normalizedWeight: number; score: number } => e.score !== null,
  )
  if (scored.length === 0) return null
  const weight = scored.reduce((sum, e) => sum + e.normalizedWeight, 0)
  if (weight === 0) {
    return scored.reduce((sum, e) => sum + e.score, 0) / scored.length
  }
  return scored.reduce((sum, e) => sum + e.score * e.normalizedWeight, 0) / weight
}
