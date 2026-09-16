/**
 * The one place that talks to a model provider.
 *
 * No other module names a model, holds a provider URL, or parses a model's
 * output. Two capabilities, two providers, for reasons that are not
 * interchangeable:
 *
 *   transcription → Mistral, direct. Candidate recordings are the most
 *     sensitive data this product holds; the provider being European is part
 *     of the design, not a preference.
 *   evaluation    → OpenRouter. Model-agnostic, so the evaluation model can
 *     change without a redeploy or a second integration.
 *
 * Every structured output is validated with Zod BEFORE it reaches a caller. A
 * report that does not validate is not written: the job fails and is retried.
 * Nothing here ever repairs a model's output with silent defaults — that is
 * how you get reports that are wrong and look right.
 */

import { z } from 'zod'

/* Model identifiers live here and nowhere else. */
const TRANSCRIPTION_MODEL = 'voxtral-mini-latest'
const FAST_MODEL = 'google/gemini-2.5-flash'
const DEEP_MODEL = 'google/gemini-2.5-pro'

const MISTRAL_TRANSCRIPTION_URL =
  'https://api.mistral.ai/v1/audio/transcriptions'
const OPENROUTER_COMPLETIONS_URL =
  'https://openrouter.ai/api/v1/chat/completions'

/**
 * Attempts inside one call. Two, not three: the work pool already retries the
 * whole job four times with its own backoff, so three here multiplied out to
 * up to 24 deep-model completions for a single report — each one billed, and
 * each one holding a slot in a pool of three.
 */
const MAX_ATTEMPTS = 2
const RETRY_BASE_MS = 600

/**
 * Wall-clock ceilings. Without them a provider that accepts the connection and
 * never answers holds the action until Convex's own 10-minute limit, times
 * every attempt, times every model in the chain — three stuck sessions were
 * enough to block the report pool for hours.
 */
const COMPLETION_TIMEOUT_MS = 120_000
/** Transcription uploads the audio, so it gets more room. */
const TRANSCRIPTION_TIMEOUT_MS = 300_000

/**
 * Output ceiling. Unset, the length came from whatever the provider defaults
 * to; a truncated answer is invalid JSON, which fails validation, which costs
 * another attempt at full price.
 */
const MAX_COMPLETION_TOKENS = 16_000

export type CompletionTier = 'fast' | 'deep'

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly cause_?: unknown,
  ) {
    super(message)
    this.name = 'AiError'
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new AiError(`${name} is not set on the Convex deployment`)
  }
  return value
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 5xx and 429 are worth another go; a 4xx means the request itself is wrong. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

/* ───────────────────────────── Transcription ───────────────────────────── */

export type TranscriptWord = { start: number; end: number; text: string }

export type TranscriptionResult = {
  text: string
  words: Array<TranscriptWord>
  model: string
  /** Seconds of audio the provider reported having processed, when it does.
   *  Written to `jobLog` so the cost of an interview is measurable. */
  audioSeconds: number | null
}

const mistralSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
})

const mistralTranscriptionSchema = z.object({
  text: z.string(),
  model: z.string().optional(),
  segments: z.array(mistralSegmentSchema).optional(),
  usage: z.object({ total_seconds: z.number() }).optional(),
})

export type TranscribeOptions = {
  /** Interview language; improves accuracy noticeably on short answers. */
  language: 'fr' | 'en'
  /** Used only for the multipart filename — the provider sniffs the format. */
  fileName: string
  contentType: string
}

/**
 * Transcribe one answer, with timestamps.
 *
 * Takes a stream so the caller can pipe an object straight out of storage
 * without materialising it twice. Timestamps are what let every quote in a
 * report jump to the exact second of video that backs it.
 */
export async function transcribe(
  stream: ReadableStream,
  options: TranscribeOptions,
): Promise<TranscriptionResult> {
  const apiKey = requireEnv('MISTRAL_API_KEY')
  const blob = await new Response(stream).blob()

  const form = new FormData()
  form.append(
    'file',
    new File([blob], options.fileName, { type: options.contentType }),
  )
  form.append('model', TRANSCRIPTION_MODEL)
  form.append('language', options.language)
  form.append('timestamp_granularities', 'segment')

  const payload = await postWithRetry(
    MISTRAL_TRANSCRIPTION_URL,
    { Authorization: `Bearer ${apiKey}` },
    form,
    'transcription',
    TRANSCRIPTION_TIMEOUT_MS,
  )

  const parsed = mistralTranscriptionSchema.safeParse(payload)
  if (!parsed.success) {
    throw new AiError(
      `transcription response did not match the expected shape: ${parsed.error.message}`,
    )
  }

  const text = parsed.data.text.trim()
  // No segments back (very short clip, or granularity unsupported): keep the
  // text, and keep the timings empty.
  //
  // This used to fabricate one span covering the whole clip at `{start: 0}`.
  // It looked harmless and was not: every quote from that answer then
  // "resolved" to 0:00 and arrived in the report indistinguishable from a
  // genuine anchor. An empty list is what we actually know, and it makes
  // those citations honestly unanchored.
  const words: Array<TranscriptWord> =
    parsed.data.segments && parsed.data.segments.length > 0
      ? parsed.data.segments.map((s) => ({
          start: s.start,
          end: s.end,
          text: s.text.trim(),
        }))
      : []

  return {
    text,
    words,
    model: parsed.data.model ?? TRANSCRIPTION_MODEL,
    audioSeconds: parsed.data.usage?.total_seconds ?? null,
  }
}

/* ───────────────────────────── Completions ─────────────────────────────── */

const openRouterResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
      }),
    )
    .min(1),
  model: z.string().optional(),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
    })
    .optional(),
})

export type CompleteOptions<T> = {
  messages: Array<ChatMessage>
  /** The shape the model must produce. Enforced twice: as a JSON schema sent
   *  to the provider, and as a parse on the way back. */
  schema: z.ZodType<T>
  /** A stable name for the schema; providers key strict decoding off it. */
  schemaName: string
  tier: CompletionTier
  temperature?: number
}

export type CompleteResult<T> = {
  value: T
  model: string
  /** Tokens the provider billed, when it reports them. Written to `jobLog`
   *  so the cost of a report is a query rather than a guess. */
  usage: { promptTokens: number; completionTokens: number } | null
}

/**
 * Where the evaluation is allowed to run.
 *
 * `data_collection: 'deny'` is the one that matters. OpenRouter otherwise
 * routes to whatever is cheapest and available, some of which retains and
 * trains on prompts — and the prompt here is a candidate's interview, in full.
 * The module header above claims a European provider for the recordings; it
 * said nothing about where their content went, and neither did the privacy
 * page. `allow_fallbacks: false` stops a refusal being silently worked around.
 *
 * `order` pins the named providers, in preference order, and is left to the
 * deployment: the slugs are OpenRouter's own and change with its catalogue, so
 * a wrong one here would fail every evaluation with no way to find out from
 * this environment. Unset, `data_collection` still decides.
 */
function providerRouting(): Record<string, unknown> {
  const order = process.env.OPENROUTER_PROVIDER_ORDER?.split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  return {
    data_collection: 'deny',
    allow_fallbacks: false,
    ...(order && order.length > 0 ? { order } : {}),
  }
}

/**
 * One structured completion, validated.
 *
 * `deep` starts on the strong model and falls back to the fast one only after
 * the strong model has failed every attempt — a fallback that fires on the
 * first hiccup quietly halves report quality.
 */
export async function complete<T>(
  options: CompleteOptions<T>,
): Promise<CompleteResult<T>> {
  const apiKey = requireEnv('OPENROUTER_API_KEY')
  const jsonSchema = z.toJSONSchema(options.schema, { io: 'output' })
  const chain =
    options.tier === 'deep' ? [DEEP_MODEL, FAST_MODEL] : [FAST_MODEL]

  let lastError: unknown
  for (const model of chain) {
    try {
      const payload = await postWithRetry(
        OPENROUTER_COMPLETIONS_URL,
        {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'Interw',
        },
        JSON.stringify({
          model,
          messages: options.messages,
          temperature: options.temperature ?? 0.2,
          max_tokens: MAX_COMPLETION_TOKENS,
          provider: providerRouting(),
          // `strict: false` on purpose. Strict decoding is implemented
          // differently by every model behind OpenRouter, and several reject
          // perfectly valid JSON Schema keywords outright — which would turn
          // a provider quirk into a failed evaluation. The schema is still
          // sent, so models that honour it do; the guarantee comes from the
          // Zod parse on the way back, which no provider can talk its way past.
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: options.schemaName,
              strict: false,
              schema: jsonSchema,
            },
          },
        }),
        `completion(${model})`,
        COMPLETION_TIMEOUT_MS,
      )

      const envelope = openRouterResponseSchema.safeParse(payload)
      if (!envelope.success) {
        throw new AiError(
          `completion envelope was not understood: ${envelope.error.message}`,
        )
      }
      const content = envelope.data.choices[0].message.content
      if (!content) throw new AiError('completion returned an empty message')

      return {
        value: parseModelJson(content, options.schema, options.schemaName),
        model: envelope.data.model ?? model,
        usage: envelope.data.usage
          ? {
              promptTokens: envelope.data.usage.prompt_tokens ?? 0,
              completionTokens: envelope.data.usage.completion_tokens ?? 0,
            }
          : null,
      }
    } catch (error) {
      lastError = error
    }
  }
  // The real reason, not just "everything failed". `jobLog` records
  // `error.message` and nothing else, so a chain summary alone could not tell
  // a 401 from a spent budget from a truncated answer from a Zod failure —
  // which is every question worth asking when a report does not arrive.
  const reason =
    lastError instanceof Error ? lastError.message : String(lastError ?? '')
  throw new AiError(
    `completion failed on every model in the chain (${chain.join(' → ')})` +
      (reason ? `: ${reason}` : ''),
    lastError,
  )
}

/**
 * Parse a model's JSON answer against its schema.
 *
 * Exported and pure so the validation contract is unit-testable without a
 * provider. Tolerates a fenced code block, because models still emit them
 * under strict decoding — and refuses everything else.
 */
export function parseModelJson<T>(
  content: string,
  schema: z.ZodType<T>,
  schemaName: string,
): T {
  const stripped = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim()

  let raw: unknown
  try {
    raw = JSON.parse(stripped)
  } catch (error) {
    throw new AiError(`${schemaName}: model output was not valid JSON`, error)
  }

  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    // Deliberately no repair pass and no defaults: an evaluation that does not
    // validate is not an evaluation, and the job that produced it must retry.
    throw new AiError(
      `${schemaName}: model output failed validation — ${parsed.error.message}`,
    )
  }
  return parsed.data
}

async function postWithRetry(
  url: string,
  headers: Record<string, string>,
  body: BodyInit,
  label: string,
  timeoutMs: number,
): Promise<unknown> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.ok) return await response.json()

      const detail = (await response.text()).slice(0, 500)
      const error = new AiError(
        `${label} failed with HTTP ${response.status}: ${detail}`,
      )
      if (!isRetryableStatus(response.status)) throw error
      lastError = error
    } catch (error) {
      if (error instanceof AiError && !/HTTP 429|HTTP 5/.test(error.message)) {
        throw error
      }
      lastError = error
    }
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1))
  }
  throw lastError instanceof Error
    ? lastError
    : new AiError(`${label} failed after ${MAX_ATTEMPTS} attempts`)
}
