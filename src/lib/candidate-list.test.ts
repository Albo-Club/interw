import { describe, expect, it } from 'vitest'

import { parseCandidateList } from './candidate-list'

describe('parseCandidateList', () => {
  it('reads the comma-separated form the placeholder shows', () => {
    const { candidates } = parseCandidateList(
      'Camille Durand, camille@example.com\nSam Okonkwo, sam@example.com',
    )
    expect(candidates).toEqual([
      { name: 'Camille Durand', email: 'camille@example.com' },
      { name: 'Sam Okonkwo', email: 'sam@example.com' },
    ])
  })

  it.each([
    ['semicolons', 'Camille Durand; camille@example.com'],
    ['tabs', 'Camille Durand\tcamille@example.com'],
    ['angle brackets', 'Camille Durand <camille@example.com>'],
    ['quoted angle brackets', '"Camille Durand" <camille@example.com>'],
    ['plain spaces', 'Camille Durand camille@example.com'],
  ])('reads the %s form recruiters actually paste', (_label, line) => {
    const { candidates } = parseCandidateList(line)
    expect(candidates).toEqual([
      { name: 'Camille Durand', email: 'camille@example.com' },
    ])
  })

  it('normalises case and strips a mailto: prefix', () => {
    const { candidates } = parseCandidateList('Alex, MAILTO:Alex@Example.COM')
    expect(candidates[0].email).toBe('alex@example.com')
  })

  // Rejecting someone because the paste had no name would mean a real person
  // never gets their interview.
  it('derives a readable name from a bare address', () => {
    const { candidates } = parseCandidateList('camille.durand@example.com')
    expect(candidates).toEqual([
      { name: 'Camille Durand', email: 'camille.durand@example.com' },
    ])
  })

  it('ignores blank lines', () => {
    const { candidates } = parseCandidateList(
      '\n\nAlex, alex@example.com\n\n   \n',
    )
    expect(candidates).toHaveLength(1)
  })

  // Shown back to the recruiter before anything is sent — never dropped.
  it('reports lines with no address', () => {
    const { candidates, invalid } = parseCandidateList(
      'Alex, alex@example.com\nJust a name with no address',
    )
    expect(candidates).toHaveLength(1)
    expect(invalid).toEqual([
      { line: 'Just a name with no address', reason: 'no_email' },
    ])
  })

  it('reports malformed addresses', () => {
    const { invalid } = parseCandidateList('Alex, alex@@example\nSam, sam@')
    expect(invalid.map((entry) => entry.reason)).toEqual([
      'bad_email',
      'bad_email',
    ])
  })

  it('keeps the first occurrence of a repeated address and reports the rest', () => {
    const { candidates, duplicates } = parseCandidateList(
      'Alex, alex@example.com\nAlexandra, ALEX@example.com',
    )
    expect(candidates).toEqual([{ name: 'Alex', email: 'alex@example.com' }])
    expect(duplicates).toEqual(['alex@example.com'])
  })

  it('handles an empty paste', () => {
    expect(parseCandidateList('')).toEqual({
      candidates: [],
      invalid: [],
      duplicates: [],
    })
  })
})
