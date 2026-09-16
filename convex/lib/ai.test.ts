import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { AiError, complete, parseModelJson } from './ai'

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

/**
 * What actually leaves the deployment, and under what routing.
 *
 * `fetch` is stubbed rather than mocked at the module boundary, so these
 * assertions are made against the real request body `complete` builds.
 */
describe('the completion request', () => {
  const answerSchema = z.object({ verdict: z.string() })

  function stubFetch(
    capture: Array<{ url: string; body: Record<string, unknown> }>,
    responder: () => Response,
  ): void {
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      capture.push({
        url,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      })
      return Promise.resolve(responder())
    })
  }

  const ok = (content: string, usage?: Record<string, number>) =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
        model: 'google/gemini-2.5-pro',
        ...(usage ? { usage } : {}),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )

  beforeEach(() => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  /**
   * The module header claims a European provider for the recordings. It said
   * nothing about the transcript, which is the recording's content — and
   * OpenRouter routes by price unless told otherwise, including to providers
   * that retain and train on prompts.
   */
  it('refuses providers that collect the prompt, and does not fall back past them', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    stubFetch(calls, () => ok('{"verdict":"fine"}'))

    await complete({
      messages: [{ role: 'user', content: 'hi' }],
      schema: answerSchema,
      schemaName: 'answer',
      tier: 'fast',
    })

    expect(calls[0].body.provider).toMatchObject({
      data_collection: 'deny',
      allow_fallbacks: false,
    })
  })

  it('pins the provider order when the deployment names one', async () => {
    vi.stubEnv('OPENROUTER_PROVIDER_ORDER', 'alpha, beta')
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    stubFetch(calls, () => ok('{"verdict":"fine"}'))

    await complete({
      messages: [{ role: 'user', content: 'hi' }],
      schema: answerSchema,
      schemaName: 'answer',
      tier: 'fast',
    })

    expect(calls[0].body.provider).toMatchObject({ order: ['alpha', 'beta'] })
  })

  /** A truncated answer is invalid JSON, which costs another attempt at full
   *  price. Unset, the ceiling was whatever the provider defaulted to. */
  it('caps the output length', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    stubFetch(calls, () => ok('{"verdict":"fine"}'))

    await complete({
      messages: [{ role: 'user', content: 'hi' }],
      schema: answerSchema,
      schemaName: 'answer',
      tier: 'fast',
    })

    expect(calls[0].body.max_tokens).toEqual(expect.any(Number))
  })

  it('reports what the provider billed', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    stubFetch(calls, () =>
      ok('{"verdict":"fine"}', { prompt_tokens: 1234, completion_tokens: 56 }),
    )

    const result = await complete({
      messages: [{ role: 'user', content: 'hi' }],
      schema: answerSchema,
      schemaName: 'answer',
      tier: 'fast',
    })

    expect(result.usage).toEqual({ promptTokens: 1234, completionTokens: 56 })
  })

  /**
   * `jobLog` records `error.message` and nothing else. A chain summary alone
   * could not tell a 401 from a spent budget from a failed validation — which
   * is every question worth asking when a report does not arrive.
   */
  it('carries the last model’s reason into the error it throws', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response('quota exhausted for this key', { status: 402 }),
      ),
    )

    await expect(
      complete({
        messages: [{ role: 'user', content: 'hi' }],
        schema: answerSchema,
        schemaName: 'answer',
        tier: 'fast',
      }),
    ).rejects.toThrow(/quota exhausted/)
  })
})
