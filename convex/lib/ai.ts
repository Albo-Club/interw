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

const MAX_ATTEMPTS = 3
const RETRY_BASE_MS = 600

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
  )

  const parsed = mistralTranscriptionSchema.safeParse(payload)
  if (!parsed.success) {
    throw new AiError(
      `transcription response did not match the expected shape: ${parsed.error.message}`,
    )
  }

  const text = parsed.data.text.trim()
  // No segments back (very short clip, or granularity unsupported): keep the
  // text rather than lose it, and mark the whole clip as one span. Evidence
  // anchoring degrades to "start of the answer", which is honest.
  const words: Array<TranscriptWord> =
    parsed.data.segments && parsed.data.segments.length > 0
      ? parsed.data.segments.map((s) => ({
          start: s.start,
          end: s.end,
          text: s.text.trim(),
        }))
      : text
        ? [{ start: 0, end: 0, text }]
        : []

  return { text, words, model: parsed.data.model ?? TRANSCRIPTION_MODEL }
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

export type CompleteResult<T> = { value: T; model: string }

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
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: options.schemaName,
              strict: true,
              schema: jsonSchema,
            },
          },
        }),
        `completion(${model})`,
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
      }
    } catch (error) {
      lastError = error
    }
  }
  throw new AiError(
    `completion failed on every model in the chain (${chain.join(' → ')})`,
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
): Promise<unknown> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { method: 'POST', headers, body })
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
