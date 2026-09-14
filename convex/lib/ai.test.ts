import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { AiError, parseModelJson } from './ai'

const reportSchema = z.object({
  overallScore: z.number().min(0).max(100),
  recommendation: z.enum(['no', 'maybe', 'yes']),
  summary: z.string().min(1),
})

describe('parseModelJson', () => {
  it('accepts a clean JSON answer', () => {
    const value = parseModelJson(
      '{"overallScore":72,"recommendation":"yes","summary":"Solid."}',
      reportSchema,
      'report',
    )
    expect(value.overallScore).toBe(72)
  })

  it('tolerates the fenced block models still emit under strict decoding', () => {
    const value = parseModelJson(
      '```json\n{"overallScore":10,"recommendation":"no","summary":"Thin."}\n```',
      reportSchema,
      'report',
    )
    expect(value.recommendation).toBe('no')
  })

  it('rejects output that is not JSON at all', () => {
    expect(() => parseModelJson('I think the candidate…', reportSchema, 'report'))
      .toThrow(AiError)
  })

  // The whole point: a malformed evaluation must fail the job, not reach the
  // recruiter with holes patched by defaults.
  it('refuses to fill a missing field with a default', () => {
    expect(() =>
      parseModelJson(
        '{"overallScore":72,"recommendation":"yes"}',
        reportSchema,
        'report',
      ),
    ).toThrow(/failed validation/)
  })

  it('refuses an out-of-range score rather than clamping it', () => {
    expect(() =>
      parseModelJson(
        '{"overallScore":420,"recommendation":"yes","summary":"x"}',
        reportSchema,
        'report',
      ),
    ).toThrow(/failed validation/)
  })

  it('refuses a recommendation outside the allowed set', () => {
    expect(() =>
      parseModelJson(
        '{"overallScore":50,"recommendation":"probably","summary":"x"}',
        reportSchema,
        'report',
      ),
    ).toThrow(/failed validation/)
  })

  it('names the schema in the failure, so a job log says what broke', () => {
    expect(() => parseModelJson('nope', reportSchema, 'paraverbal')).toThrow(
      /^paraverbal:/,
    )
  })
})
