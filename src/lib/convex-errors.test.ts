import { ConvexError } from 'convex/values'
import { describe, expect, it } from 'vitest'

/// <reference types="vite/client" />
import { publishBlockers } from '../../convex/lib/publishReadiness'
import { evaluateSessionGate } from '../../convex/lib/sessionState'
import { convexErrorCode, errorMessageKey } from './convex-errors'
import { resources } from './i18n'

describe('convexErrorCode', () => {
  it('reads a plain string code', () => {
    expect(convexErrorCode(new ConvexError('project_archived'))).toBe(
      'project_archived',
    )
  })

  it('reads a code out of a structured payload', () => {
    expect(
      convexErrorCode(new ConvexError({ code: 'rate_limited', retryAfterMs: 5 })),
    ).toBe('rate_limited')
  })

  it('returns null for an ordinary error', () => {
    expect(convexErrorCode(new Error('boom'))).toBeNull()
    expect(convexErrorCode('boom')).toBeNull()
  })
})

describe('errorMessageKey', () => {
  it('scopes a known code to the domain namespace', () => {
    expect(errorMessageKey(new ConvexError('no_questions'), 'projects').key).toBe(
      'projects:errors.no_questions',
    )
  })

  // audit 2026-09-15, recruiter M3: a member saving a role's team got
  // "Something went wrong" instead of being told the action is not theirs.
  it('falls back to the shared copy when the domain has none', () => {
    expect(
      errorMessageKey(new ConvexError('insufficient_role'), 'projects').key,
    ).toBe('errors:codes.insufficient_role')
  })

  // An unrecognised failure must not put an internal identifier on screen.
  it('falls back to the generic message for an unknown failure', () => {
    expect(errorMessageKey(new Error('kaboom'), 'projects').key).toBe(
      'common:errorBoundary.title',
    )
  })
})

/**
 * Every code `convex/` throws has a message in `en` and `fr` (audit
 * 2026-09-15, recruiter M3). Before this, `insufficient_role`, `not_found`,
 * `not_a_member` and `no_report` all reached the recruiter as "Something went
 * wrong", and nothing noticed a new code shipping without copy.
 *
 * The codes are read from the source. A `ConvexError` whose argument is not a
 * literal must be registered in `DYNAMIC` with the codes it can carry — an
 * unregistered one fails here, so a computed code cannot slip past.
 */
describe('every ConvexError code has copy', () => {
  const sources = import.meta.glob<string>(
    [
      '../../convex/**/*.ts',
      '!../../convex/_generated/**',
      '!../../convex/**/*.test.ts',
    ],
    { query: '?raw', import: 'default', eager: true },
  )
  const all = Object.values(sources).join('\n')
  const literals = (pattern: RegExp) =>
    [...all.matchAll(pattern)].map((match) => match[1])

  const sessionStatuses = [
    'pending',
    'in_progress',
    'completed',
    'cancelled',
    'expired',
  ] as const
  const blockedGateStates = sessionStatuses
    .flatMap((status) =>
      (['draft', 'active', 'archived'] as const).map(
        (projectStatus) =>
          evaluateSessionGate({
            session: { status },
            project: { status: projectStatus },
            now: 0,
          }).state,
      ),
    )
    .filter((state) => state !== 'ready' && state !== 'resumable')

  const DYNAMIC: Record<string, () => Array<string>> = {
    // interview.ts, candidate.ts: a gate that is not open, thrown as-is.
    'gate.state': () => blockedGateStates,
    // projects.ts `requireText` / `optionalText`: the code is the last argument.
    code: () =>
      literals(/(?:requireText|optionalText)\([^()]*'([a-z_]+)',?\s*\)/g),
    // projects.ts `publish`.
    'blockers[0].code': () =>
      [
        ...publishBlockers([], []),
        ...publishBlockers([{ content: '' }], [{ label: '' }]),
      ].map((blocker) => blocker.code),
    // lib/reportBuilder.ts `requireIndex`.
    '`report_references_unknown_${what}`': () =>
      literals(/requireIndex\([^()]*'([a-z]+)'\)/g).map(
        (what) => `report_references_unknown_${what}`,
      ),
  }

  // The three shapes a call site can take: a literal, `{ code: '…' }`, or an
  // expression that must be in DYNAMIC.
  const literal = literals(/ConvexError\(\s*'([a-z_]+)'\s*\)/g)
  const object = literals(/ConvexError\(\s*\{\s*code:\s*'([a-z_]+)'/g)
  const computed = literals(/ConvexError\(\s*([^'{\s][^)]*)\)/g)
  const callSites = literals(/(ConvexError)\(/g).length

  const codes = new Set([...literal, ...object])
  const unregistered = computed.filter((expression) => !(expression in DYNAMIC))
  for (const expression of computed) {
    if (expression in DYNAMIC) for (const code of DYNAMIC[expression]()) codes.add(code)
  }

  it('classifies every ConvexError call site', () => {
    expect(literal.length + object.length + computed.length).toBe(callSites)
  })

  it('finds no computed code it does not know about', () => {
    expect(unregistered).toEqual([])
  })

  it('reads a plausible number of codes', () => {
    // Guards the scan itself: a regex that silently matches nothing would
    // make the next test pass vacuously.
    expect(codes.size).toBeGreaterThan(60)
    for (const code of [
      'not_found',
      'insufficient_role',
      'rate_limited',
      'closed',
      'invalid_job_title',
      'report_references_unknown_answer',
    ]) {
      expect(codes).toContain(code)
    }
  })

  it.each(['en', 'fr'] as const)('has errors:codes.<code> in %s', (locale) => {
    const copy: Record<string, string> = resources[locale].errors.codes
    expect([...codes].filter((code) => !(code in copy)).sort()).toEqual([])
  })
})
