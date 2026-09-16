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
 * What actually leaves the deployment, and where it goes.
 *
 * `fetch` is stubbed rather than mocked at the module boundary, so these
 * assertions are made against the real request `complete` builds.
 */
describe('the completion request', () => {
  const answerSchema = z.object({ verdict: z.string() })

  type Call = {
    url: string
    headers: Record<string, string>
    body: Record<string, unknown>
  }

  function stubFetch(capture: Array<Call>, responder: () => Response): void {
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      capture.push({
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      })
      return Promise.resolve(responder())
    })
  }

  const ok = (content: string, usage?: Record<string, number>) =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
        model: 'zai-glm-5-3',
        ...(usage ? { usage } : {}),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )

  const ask = (tier: 'fast' | 'deep' = 'fast') =>
    complete({
      messages: [{ role: 'user', content: 'hi' }],
      schema: answerSchema,
      schemaName: 'answer',
      tier,
    })

  beforeEach(() => {
    vi.stubEnv('MISTRAL_API_KEY', 'test-key')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  /**
   * The point of moving off OpenRouter.
   *
   * A router picks a provider by price unless told otherwise, and the prompt
   * here is a candidate's interview in full — so the guarantee used to be a
   * `data_collection: 'deny'` flag we had to remember to send on every call,
   * plus a provider allow-list that went stale with someone else's catalogue.
   * Addressing Mistral directly makes it structural instead: there is no
   * second hop to configure, and no flag left to forget.
   */
  it('goes to Mistral directly, with no router in between', async () => {
    const calls: Array<Call> = []
    stubFetch(calls, () => ok('{"verdict":"fine"}'))

    await ask()

    expect(calls[0].url.startsWith('https://api.mistral.ai/')).toBe(true)
  })

  it('sends no third-party routing block', async () => {
    const calls: Array<Call> = []
    stubFetch(calls, () => ok('{"verdict":"fine"}'))

    await ask()

    expect(calls[0].body.provider).toBeUndefined()
  })

  /** One provider, one key — the same one that already transcribes. */
  it('runs on MISTRAL_API_KEY, with no second provider key set', async () => {
    const calls: Array<Call> = []
    stubFetch(calls, () => ok('{"verdict":"fine"}'))

    await ask()

    expect(process.env.OPENROUTER_API_KEY).toBeUndefined()
    expect(calls[0].headers.Authorization).toBe('Bearer test-key')
  })

  it('asks for models Mistral serves, on both tiers', async () => {
    const calls: Array<Call> = []
    stubFetch(calls, () => ok('{"verdict":"fine"}'))

    await ask('fast')
    await ask('deep')

    for (const call of calls) {
      expect(String(call.body.model).startsWith('google/')).toBe(false)
    }
    // The interview report is the decision; it starts on the strongest model
    // in the chain, and only falls back after that one has failed outright.
    expect(calls[1].body.model).toBe('zai-glm-5-3')
  })

  /** A truncated answer is invalid JSON, which costs another attempt at full
   *  price. Unset, the ceiling was whatever the provider defaulted to. */
  it('caps the output length', async () => {
    const calls: Array<Call> = []
    stubFetch(calls, () => ok('{"verdict":"fine"}'))

    await ask()

    expect(calls[0].body.max_tokens).toEqual(expect.any(Number))
  })

  it('reports what the provider billed', async () => {
    const calls: Array<Call> = []
    stubFetch(calls, () =>
      ok('{"verdict":"fine"}', { prompt_tokens: 1234, completion_tokens: 56 }),
    )

    const result = await ask()

    expect(result.usage).toEqual({ promptTokens: 1234, completionTokens: 56 })
  })

  /**
   * `jobLog` records `error.message` and nothing else. A chain summary alone
   * could not tell a 401 from a spent budget from a failed validation — which
   * is every question worth asking when a report does not arrive.
   */
  it('carries the last model\u2019s reason into the error it throws', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response('quota exhausted for this key', { status: 402 }),
      ),
    )

    await expect(ask()).rejects.toThrow(/quota exhausted/)
  })
})
