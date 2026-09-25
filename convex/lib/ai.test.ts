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

  /**
   * What GLM actually sends back.
   *
   * `content` is an array of blocks, not a string: the reasoning arrives in a
   * `thinking` block and the answer in a `text` one. The decoy JSON inside the
   * reasoning is the point — concatenating every block, or reading the first,
   * parses the model's musings instead of its answer.
   */
  const okBlocks = (text: string) =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: [
                {
                  type: 'thinking',
                  closed: true,
                  thinking: [
                    {
                      type: 'text',
                      text: 'Maybe {"verdict":"a stray thought"} — no, let me answer properly.',
                    },
                  ],
                },
                { type: 'text', text },
              ],
            },
          },
        ],
        model: 'zai-glm-5-3',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )

  const ok = (content: string, usage?: Record<string, number>) =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
        model: 'zai-glm-5-3',
        ...(usage ? { usage } : {}),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )

  const ask = () =>
    complete({
      messages: [{ role: 'user', content: 'hi' }],
      schema: answerSchema,
      schemaName: 'answer',
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
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(calls[0].headers.Authorization).toBe('Bearer test-key')
  })

  it('asks for the one model Mistral serves us', async () => {
    const calls: Array<Call> = []
    stubFetch(calls, () => ok('{"verdict":"fine"}'))

    await ask()

    expect(calls[0].body.model).toBe('zai-glm-5-3')
  })

  /**
   * There is no model chain any more, and a failure must not quietly grow one
   * back: a refusal costs the two transport attempts and stops. The work pool
   * is what retries the job, four times, and anything multiplied into this
   * call is multiplied again by that.
   */
  it('stops at the transport retries rather than re-asking a refusing model', async () => {
    const calls: Array<Call> = []
    stubFetch(calls, () => new Response('upstream boom', { status: 500 }))

    await expect(ask()).rejects.toThrow()

    expect(new Set(calls.map((c) => String(c.body.model))).size).toBe(1)
    expect(calls).toHaveLength(2)
  })

  /**
   * Audit 2026-09-15, Pipe F10. The retry decision was a regex over the error
   * message, and the message quotes up to 500 characters of the provider's
   * body — so a 400 whose body mentioned "HTTP 503" was sent again.
   */
  it('does not retry a 400 whose body happens to say HTTP 503', async () => {
    const calls: Array<Call> = []
    stubFetch(
      calls,
      () => new Response('upstream said HTTP 503 earlier', { status: 400 }),
    )

    const error = await ask().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AiError)
    expect((error as AiError).status).toBe(400)
    expect(calls).toHaveLength(1)
  })

  /**
   * Found by running the real model, not by reading its docs: every stub in
   * this file sent `content` as a string, which is what the OpenAI-compatible
   * shape says, and what Mistral's own models send. GLM answers in blocks, and
   * the envelope parser rejected the whole response — so every evaluation
   * failed with `completion envelope was not understood`.
   */
  it('reads the answer out of a block list, not just a plain string', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(okBlocks('{"verdict":"fine"}')))

    const result = await ask()

    expect(result.value.verdict).toBe('fine')
  })

  it('still reads a plain string, which is what other models send', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(ok('{"verdict":"fine"}')))

    const result = await ask()

    expect(result.value.verdict).toBe('fine')
  })

  /**
   * A reasoning model cut off mid-thought sends the thinking block and no text
   * block at all. That is not an answer, and must fail as loudly as an empty
   * one rather than reach `JSON.parse` as an empty string.
   */
  it('refuses a reply that carries reasoning and no answer', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: [
                    { type: 'thinking', thinking: [{ type: 'text', text: '…' }] },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    await expect(ask()).rejects.toThrow(AiError)
  })

  /**
   * A cut-off answer used to surface as "model output was not valid JSON",
   * which sends whoever reads `jobLog` hunting for a schema bug that is not
   * there. The provider already says so: `finish_reason: 'length'`.
   */
  it('names a truncated answer instead of blaming its JSON', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'length',
                message: { content: '{"verdict":"fi' },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    await expect(ask()).rejects.toThrow(/truncated/i)
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

  /** Audit C6.2: a reasoning model bills thinking nobody sees. What it
   *  spent there is kept apart, when the provider says. */
  it('reports the reasoning share of the completion when given', async () => {
    const calls: Array<Call> = []
    stubFetch(
      calls,
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"verdict":"fine"}' } }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 900,
              completion_tokens_details: { reasoning_tokens: 850 },
            },
          }),
          { status: 200 },
        ),
    )

    const result = await ask()

    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 900,
      reasoningTokens: 850,
    })
  })

  /**
   * `jobLog` records `error.message` and nothing else. A chain summary alone
   * could not tell a 401 from a spent budget from a failed validation — which
   * is every question worth asking when a report does not arrive.
   */
  it('carries the provider\u2019s reason into the error it throws', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response('quota exhausted for this key', { status: 402 }),
      ),
    )

    await expect(ask()).rejects.toThrow(/quota exhausted/)
  })
})
