import { describe, expect, it } from 'vitest'

import { normalizeWeights, weightedScore } from './weights'

const sum = (items: Array<{ normalizedWeight: number }>) =>
  items.reduce((total, item) => total + item.normalizedWeight, 0)

describe('normalizeWeights', () => {
  it('returns nothing for an empty set', () => {
    expect(normalizeWeights([])).toEqual([])
  })

  it('always sums to exactly 100', () => {
    for (const weights of [
      [10, 10, 10],
      [1, 1, 1, 1, 1, 1, 1],
      [80, 15, 5],
      [7],
      [33, 33, 34],
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    ]) {
      expect(sum(normalizeWeights(weights.map((weight) => ({ weight }))))).toBe(
        100,
      )
    }
  })

  it('splits three equal criteria 34/33/33, not 33/33/33', () => {
    const result = normalizeWeights([
      { weight: 10 },
      { weight: 10 },
      { weight: 10 },
    ])
    expect(result.map((r) => r.normalizedWeight)).toEqual([34, 33, 33])
  })

  it('keeps proportions', () => {
    const result = normalizeWeights([{ weight: 75 }, { weight: 25 }])
    expect(result.map((r) => r.normalizedWeight)).toEqual([75, 25])
  })

  it('falls back to an even split when every weight is zero', () => {
    const result = normalizeWeights([
      { weight: 0 },
      { weight: 0 },
      { weight: 0 },
      { weight: 0 },
    ])
    expect(result.map((r) => r.normalizedWeight)).toEqual([25, 25, 25, 25])
  })

  it('floors a negative weight instead of inverting the criterion', () => {
    const result = normalizeWeights([{ weight: -50 }, { weight: 50 }])
    expect(result.map((r) => r.normalizedWeight)).toEqual([0, 100])
  })

  it('preserves the caller fields it was handed', () => {
    const result = normalizeWeights([{ label: 'Autonomy', weight: 30 }])
    expect(result[0].label).toBe('Autonomy')
  })
})

describe('weightedScore', () => {
  it('weights by normalised weight', () => {
    expect(
      weightedScore([
        { normalizedWeight: 75, score: 80 },
        { normalizedWeight: 25, score: 40 },
      ]),
    ).toBe(70)
  })

  it('is null when nothing was scored', () => {
    expect(
      weightedScore([
        { normalizedWeight: 50, score: null },
        { normalizedWeight: 50, score: null },
      ]),
    ).toBeNull()
  })

  // A criterion the model could not judge must lower confidence, not score
  // the candidate zero on it.
  it('re-normalises over the criteria that were actually scored', () => {
    expect(
      weightedScore([
        { normalizedWeight: 50, score: 80 },
        { normalizedWeight: 50, score: null },
      ]),
    ).toBe(80)
  })
})
