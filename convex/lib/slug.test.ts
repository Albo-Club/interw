import { describe, expect, it } from 'vitest'

import { slugify, uniqueSlug } from './slug'

describe('slugify', () => {
  it('strips French accents rather than dropping the letters', () => {
    expect(slugify('Développeur Sénior — Modélisation')).toBe(
      'developpeur-senior-modelisation',
    )
  })

  it('collapses runs of separators and trims the ends', () => {
    expect(slugify('  Lead   //  Back-end!!  ')).toBe('lead-back-end')
  })

  it('never ends on a hyphen, even after truncation', () => {
    const slug = slugify(`${'a'.repeat(59)} b`)
    expect(slug.endsWith('-')).toBe(false)
    expect(slug.length).toBeLessThanOrEqual(60)
  })

  it('yields an empty string when nothing survives', () => {
    expect(slugify('日本語')).toBe('')
  })
})

const takenIn = (slugs: Array<string>) => {
  const taken = new Set(slugs)
  return (slug: string) => Promise.resolve(taken.has(slug))
}

describe('uniqueSlug', () => {
  const SLUG = /^product-manager-[a-z0-9]{6}$/

  it('suffixes every slug, free or not', async () => {
    expect(await uniqueSlug('Product Manager', takenIn([]))).toMatch(SLUG)
    expect(
      await uniqueSlug('Product Manager', takenIn(['product-manager'])),
    ).toMatch(SLUG)
  })

  it('draws again when the suffix is taken', async () => {
    const asked: Array<string> = []
    const slug = await uniqueSlug('Product Manager', (candidate) => {
      asked.push(candidate)
      return Promise.resolve(asked.length === 1)
    })
    expect(asked).toHaveLength(2)
    expect(slug).toBe(asked[1])
    expect(slug).toMatch(SLUG)
  })

  it('stays within 60 characters and never doubles a hyphen', async () => {
    const slug = await uniqueSlug(`${'a'.repeat(52)} b`, takenIn([]))
    expect(slug.length).toBeLessThanOrEqual(60)
    expect(slug).not.toContain('--')
  })

  // An empty slug would produce a double slash in every link a recruiter pastes.
  it('falls back for a title with no usable characters', async () => {
    expect(await uniqueSlug('日本語', takenIn([]))).toMatch(
      /^project-[a-z0-9]{6}$/,
    )
  })
})
