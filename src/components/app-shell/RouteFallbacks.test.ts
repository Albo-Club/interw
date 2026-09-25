/// <reference types="vite/client" />
import { ConvexError } from 'convex/values'
import { describe, expect, it } from 'vitest'

import { isNotFoundError } from './RouteFallbacks'

/**
 * Audit 2026-09-15, recruiter M1. No recruiter route had its own error or
 * not-found screen: a mistyped role slug fell through to the router-wide
 * fallback, which fills the viewport, sends the recruiter to the marketing
 * homepage, and reported every typo to Sentry as an application error.
 */
describe('recruiter route fallbacks', () => {
  const routes = import.meta.glob<string>('../../routes/app/$orgSlug/**/*.tsx', {
    query: '?raw',
    import: 'default',
    eager: true,
  })

  const rendered = Object.entries(routes).filter(([, source]) =>
    /^\s*component: /m.test(source),
  )

  it('finds the routes it is checking', () => {
    expect(rendered.length).toBeGreaterThan(8)
  })

  it.each(rendered.map(([path, source]) => [path.split('$orgSlug/')[1], source]))(
    '%s renders its errors inside the app layout',
    (_path, source) => {
      expect(source).toMatch(/^\s*errorComponent: AppRouteError,$/m)
    },
  )

  // Only a route with children catches an unmatched path (fuzzy not-found
  // mode); a route that resolves a slug or an id names it too.
  it.each([
    'route.tsx',
    'settings/route.tsx',
    'projects.$projectSlug.index.tsx',
    'projects.$projectSlug.edit.tsx',
    'candidates.$sessionId.tsx',
  ])(
    '%s has a not-found screen',
    (file) => {
      const source = routes[`../../routes/app/$orgSlug/${file}`]
      expect(source).toMatch(/^\s*notFoundComponent: AppNotFound,$/m)
    },
  )

  it('treats a Convex not_found as not-found, and nothing else', () => {
    expect(isNotFoundError(new ConvexError('not_found'))).toBe(true)
    expect(isNotFoundError(new ConvexError('insufficient_role'))).toBe(false)
    expect(isNotFoundError(new Error('not_found'))).toBe(false)
  })
})
