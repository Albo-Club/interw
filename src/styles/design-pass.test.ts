// @vitest-environment node
/// <reference types="vite/client" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Audit 2026-09-15, recruiter chantier 4 #6 and #7 (T14): template leftovers
 * and the `web-design-guidelines` pass. Each rule below is a property of the
 * source that a reviewer cannot see drift back in a diff, so it is pinned
 * here rather than trusted to memory.
 */
const sources = import.meta.glob<string>(['../**/*.tsx', '../**/*.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
})
const appSources = Object.entries(sources).filter(
  ([path]) => !path.includes('/components/ui/') && !path.endsWith('.test.ts'),
)
const read = (path: string) => {
  if (!(path in sources)) throw new Error(`missing ${path}`)
  return sources[path]
}
// Read from disk: a `?raw` import of a stylesheet comes back empty once the
// CSS pipeline has claimed it.
const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const brandCss = readFileSync(new URL('./brand.css', import.meta.url), 'utf8')

describe('template leftovers (F1)', () => {
  it('ships no demo chart, mock data or dead tool renderer', () => {
    const dead = Object.keys(sources).filter((path) =>
      /ActivityChart|RoleBreakdownChart|\/lib\/mocks\/|toolRenderers/.test(path),
    )
    expect(dead).toEqual([])
  })

  it('has no never-set `.using-mouse` rule killing focus outlines', () => {
    expect(appCss).not.toContain('using-mouse')
  })

  it('declares a valid manifest colour', () => {
    expect(read('../routes/__root.tsx')).not.toMatch(/#f{5}'/i)
  })
})

describe('web-design-guidelines pass', () => {
  it('honours prefers-reduced-motion app-wide (M7)', () => {
    expect(appCss).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
  })

  it('serves Inter from our own origin (M6)', () => {
    expect(appCss).toContain("@import '@fontsource-variable/inter'")
    expect(brandCss).toMatch(/--font-sans:\s*'Inter Variable'/)
  })

  it('aligns KPI figures on tabular digits (F5)', () => {
    expect(read('../components/dashboard/KpiCard.tsx')).toContain('tabular-nums')
  })

  it('reveals the AI message actions on keyboard focus (F5)', () => {
    expect(read('../components/ai/AiPanel.tsx')).toMatch(
      /<MessageActions className="[^"]*focus-within:opacity-100/,
    )
  })

  it('uses brand tokens, never a Tailwind palette colour (M9)', () => {
    const palette =
      /\b(?:text|bg|border|ring|fill|stroke|from|to|via|outline|decoration)-(?:red|green|blue|yellow|orange|amber|emerald|rose|lime|sky|indigo|violet|purple|pink|teal|cyan|slate|gray|zinc|neutral|stone|fuchsia)-\d{2,3}\b/
    expect(
      appSources.filter(([, source]) => palette.test(source)).map(([p]) => p),
    ).toEqual([])
  })

  it('formats every date with the app locale, not the browser one (F2)', () => {
    expect(
      appSources
        .filter(([, source]) => /\.toLocale(?:Date|Time)?String\(\)/.test(source))
        .map(([path]) => path),
    ).toEqual([])
  })

  it('types route ids instead of casting them away (F3)', () => {
    expect(
      appSources
        .filter(([path, source]) => path.includes('/routes/') && source.includes('as never'))
        .map(([path]) => path),
    ).toEqual([])
  })

  it('shows a skeleton, not a text line, while the shell resolves (M11)', () => {
    for (const layout of ['../routes/app/route.tsx', '../routes/app/$orgSlug/route.tsx']) {
      const source = read(layout)
      expect(source).toContain('<AppShellSkeleton />')
      expect(source).not.toContain("{t('loading')}")
    }
  })

  it('searches through a modal command list reachable on a phone (M8)', () => {
    const source = read('../components/candidates/CandidateSearch.tsx')
    expect(source).toContain("from 'cmdk'")
    expect(source).toContain('<Dialog ')
    expect(source).not.toContain('hidden w-64 md:block')
  })
})
