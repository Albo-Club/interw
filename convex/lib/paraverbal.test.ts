import { describe, expect, it } from 'vitest'

import { bandScore, computeParaverbal } from './paraverbal'
import type { AnswerTiming } from './paraverbal'

/** An answer of `words` words spread evenly over `durationSeconds`. */
function answer(
  words: number,
  durationSeconds: number,
  maxResponseSeconds = 120,
  text?: string,
): AnswerTiming {
  const body = text ?? Array.from({ length: words }, () => 'mot').join(' ')
  return {
    chunks: [{ start: 0, end: durationSeconds, text: body }],
    durationSeconds,
    maxResponseSeconds,
  }
}

const dimension = (
  result: ReturnType<typeof computeParaverbal>,
  key: string,
) => result?.dimensions.find((d) => d.key === key)

describe('bandScore', () => {
  const band = { idealLow: 120, idealHigh: 170, hardLow: 60, hardHigh: 240 }

  it('is 10 anywhere inside the band', () => {
    expect(bandScore(120, band)).toBe(10)
    expect(bandScore(145, band)).toBe(10)
    expect(bandScore(170, band)).toBe(10)
  })

  it('is 0 at and beyond the hard bounds', () => {
    expect(bandScore(60, band)).toBe(0)
    expect(bandScore(10, band)).toBe(0)
    expect(bandScore(240, band)).toBe(0)
    expect(bandScore(400, band)).toBe(0)
  })

  it('degrades smoothly between the band and the hard bound', () => {
    const slow = bandScore(90, band)
    expect(slow).toBeGreaterThan(0)
    expect(slow).toBeLessThan(10)
    expect(bandScore(100, band)).toBeGreaterThan(slow)
  })
})

describe('computeParaverbal', () => {
  it('returns null when there is nothing to measure', () => {
    expect(computeParaverbal([])).toBeNull()
    expect(computeParaverbal([answer(0, 0)])).toBeNull()
  })

  it('computes words per minute over the whole interview', () => {
    // 140 words in 60s, twice → 140 wpm.
    const result = computeParaverbal([answer(140, 60), answer(140, 60)])
    expect(result?.wordsPerMinute).toBe(140)
    expect(result?.totalSpeakingSeconds).toBe(120)
    expect(dimension(result, 'pace')?.score).toBe(10)
  })

  it('marks down a candidate who races', () => {
    const fast = computeParaverbal([answer(400, 60)])
    expect(dimension(fast, 'pace')!.score).toBeLessThan(10)
  })

  it('marks down a candidate who crawls', () => {
    const slow = computeParaverbal([answer(60, 60)])
    expect(dimension(slow, 'pace')!.score).toBeLessThan(10)
  })

  it('counts hesitation markers in French and English', () => {
    const clean = computeParaverbal([
      answer(0, 60, 120, Array.from({ length: 100 }, () => 'mot').join(' ')),
    ])
    const hesitant = computeParaverbal([
      answer(
        0,
        60,
        120,
        `${Array.from({ length: 90 }, () => 'mot').join(' ')} euh euh euh hum ben bah genre um uh erm`,
      ),
    ])
    expect(dimension(clean, 'fluency')!.score).toBe(10)
    expect(dimension(hesitant, 'fluency')!.score).toBeLessThan(10)
    expect(dimension(hesitant, 'fluency')!.measure).toBeGreaterThan(5)
  })

  it('ignores accents when counting hesitation', () => {
    const result = computeParaverbal([
      answer(0, 60, 120, 'voilà voilà voilà quatre mots'),
    ])
    expect(dimension(result, 'fluency')!.measure).toBeGreaterThan(0)
  })

  it('measures silence as the gaps between spoken chunks', () => {
    const gappy = computeParaverbal([
      {
        chunks: [
          { start: 0, end: 5, text: 'un deux trois quatre cinq six sept huit' },
          { start: 25, end: 30, text: 'neuf dix onze douze treize quatorze' },
        ],
        durationSeconds: 30,
        maxResponseSeconds: 120,
      },
    ])
    // 20 seconds of silence over 30 seconds of answer.
    expect(dimension(gappy, 'pauses')!.measure).toBeCloseTo(66.7, 0)
    expect(dimension(gappy, 'pauses')!.score).toBe(0)
  })

  it('rewards using a sensible share of the allotted time', () => {
    const measured = computeParaverbal([answer(150, 72, 120)])
    const rushed = computeParaverbal([answer(12, 6, 120)])
    expect(dimension(measured, 'concision')!.score).toBe(10)
    expect(dimension(rushed, 'concision')!.score).toBeLessThan(10)
  })

  it('rewards consistent answer lengths', () => {
    const steady = computeParaverbal([
      answer(120, 60),
      answer(120, 62),
      answer(120, 58),
    ])
    const erratic = computeParaverbal([
      answer(20, 8),
      answer(240, 118),
      answer(60, 25),
    ])
    expect(dimension(steady, 'consistency')!.score).toBe(10)
    expect(dimension(erratic, 'consistency')!.score).toBeLessThan(10)
  })

  it('always returns all six dimensions', () => {
    const result = computeParaverbal([answer(120, 60)])
    expect(result?.dimensions.map((d) => d.key).sort()).toEqual([
      'concision',
      'consistency',
      'engagement',
      'fluency',
      'pace',
      'pauses',
    ])
  })

  // A replay of the pipeline must produce byte-identical output.
  it('is deterministic', () => {
    const input = [answer(140, 60), answer(90, 45)]
    expect(computeParaverbal(input)).toEqual(computeParaverbal(input))
  })
})
