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

describe('uniqueSlug', () => {
  it('returns the plain slug when it is free', () => {
    expect(uniqueSlug('Product Manager', new Set())).toBe('product-manager')
  })

  it('suffixes until it finds a free one', () => {
    const taken = new Set(['product-manager', 'product-manager-2'])
    expect(uniqueSlug('Product Manager', taken)).toBe('product-manager-3')
  })

  // An empty slug would produce a double slash in every link a recruiter pastes.
  it('falls back for a title with no usable characters', () => {
    expect(uniqueSlug('日本語', new Set())).toBe('project')
    expect(uniqueSlug('日本語', new Set(['project']))).toBe('project-2')
  })
})
