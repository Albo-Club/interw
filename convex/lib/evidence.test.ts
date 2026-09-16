import { describe, expect, it } from 'vitest'

import { chooseStartSeconds, normalizeForMatch, resolveQuoteStart } from './evidence'
import type { TimedChunk } from './evidence'

const chunks: Array<TimedChunk> = [
  { start: 0, end: 4.2, text: "Bonjour, merci de m'accueillir." },
  { start: 4.2, end: 11.5, text: "J'ai dirigé la migration vers Postgres." },
  { start: 11.5, end: 19, text: 'On a coupé la latence de moitié en six mois.' },
]

describe('normalizeForMatch', () => {
  it('strips accents, case and punctuation', () => {
    expect(normalizeForMatch("J'ai DIRIGÉ, la migration !")).toBe(
      'jai dirige la migration',
    )
  })

  // French elides constantly; a model writing "jai" must match "j'ai".
  it('deletes apostrophes rather than splitting on them', () => {
    expect(normalizeForMatch("l'équipe qu'on")).toBe('lequipe quon')
    expect(normalizeForMatch('l\u2019equipe quon')).toBe('lequipe quon')
  })
})

describe('resolveQuoteStart', () => {
  it('finds a quote inside a chunk and returns that chunk start', () => {
    expect(resolveQuoteStart(chunks, 'la migration vers Postgres')).toBe(4.2)
  })

  it('is insensitive to accents and punctuation the model dropped', () => {
    expect(resolveQuoteStart(chunks, 'jai dirige la migration vers postgres')).toBe(
      4.2,
    )
  })

  it('resolves a quote that straddles two chunks to where it begins', () => {
    expect(
      resolveQuoteStart(chunks, 'vers Postgres. On a coupé la latence'),
    ).toBe(4.2)
  })

  it('falls back to the opening words when the model paraphrased the tail', () => {
    expect(
      resolveQuoteStart(chunks, 'On a coupé la latence de moitié en un an'),
    ).toBe(11.5)
  })

  // A wrong timestamp sends the recruiter to the wrong moment and costs the
  // trust of every other citation in the report.
  it('returns null rather than guess when the quote is absent', () => {
    expect(resolveQuoteStart(chunks, 'I rewrote the kernel in Rust')).toBeNull()
  })

  it('returns null for an empty quote or an empty transcript', () => {
    expect(resolveQuoteStart(chunks, '   ')).toBeNull()
    expect(resolveQuoteStart([], 'anything at all')).toBeNull()
  })

  it('ignores blank transcript chunks', () => {
    expect(
      resolveQuoteStart(
        [{ start: 0, end: 1, text: '  ' }, ...chunks],
        'la migration vers Postgres',
      ),
    ).toBe(4.2)
  })
})

describe('chooseStartSeconds', () => {
  it('uses the transcript when the quote is found', () => {
    expect(
      chooseStartSeconds({
        chunks,
        quote: 'la migration vers Postgres',
        durationSeconds: 60,
      }),
    ).toBe(4.2)
  })

  // The model's own estimate used to be taken here. It reads like an answer
  // and is not one: it sends the recruiter to a moment where the candidate is
  // saying something else, and costs every other citation its credit.
  it('returns null rather than a guess when nothing matches', () => {
    expect(
      chooseStartSeconds({
        chunks,
        quote: 'something never said',
        durationSeconds: 60,
      }),
    ).toBeNull()
  })

  it('returns null when the transcript carries no timings at all', () => {
    expect(
      chooseStartSeconds({
        chunks: [],
        quote: 'la migration vers Postgres',
        durationSeconds: 60,
      }),
    ).toBeNull()
  })

  // Seeking past the end of a clip shows a black frame and reads as a bug.
  it('never points past the end of the clip', () => {
    expect(
      chooseStartSeconds({
        chunks: [{ start: 40, end: 45, text: 'la migration vers Postgres' }],
        quote: 'la migration vers Postgres',
        durationSeconds: 19,
      }),
    ).toBe(18)
  })
})
