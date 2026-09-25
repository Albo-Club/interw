/**
 * The one place that names a model, holds a provider URL, or parses a model's
 * output. One provider, Mistral, for all three capabilities:
 *
 *   transcription → Voxtral.
 *   evaluation    → GLM, which Mistral serves alongside its own models.
 *   in-app chat   → the same GLM, reached from `convex/agent.ts` through the
 *                   AI SDK, on the id this file exports.
 *
 * A candidate's recording and its transcript are the most sensitive data this
 * product holds, and the provider being European is part of the design, not a
 * preference. Evaluation used to run through OpenRouter, which picks a
 * provider by price unless told otherwise — so the guarantee was a
 * `data_collection: 'deny'` flag on every call plus an allow-list that went
 * stale with someone else's catalogue. Addressing one provider directly makes
 * it structural: there is no second hop to configure, and no flag to forget.
 *
 * GLM's weights are Z.ai's, not Mistral's. The inference runs on Mistral's
 * infrastructure under its regional controls, so no interview leaves it.
 *
 * Every structured output is validated with Zod BEFORE it reaches a caller. A
 * report that does not validate is not written: the job fails and is retried.
 * Nothing here ever repairs a model's output with silent defaults — that is
 * how you get reports that are wrong and look right.
 */

import { z } from 'zod'

/* Model identifiers live here and nowhere else. */

/**
 * `-latest` on purpose, and deliberately unlike the evaluation model below.
 * This alias already resolves to Voxtral Transcribe 2, Mistral's current batch
 * model. Transcription is mechanical: there is a ground truth — what the
 * candidate actually said — so a better model means a transcript closer to it,
 * and an upgrade arriving on its own is a gain. An evaluation has no ground
 * truth, which is why that one is pinned.
 */
const TRANSCRIPTION_MODEL = 'voxtral-mini-latest'

/**
 * Pinned to an exact version rather than a moving alias: an evaluation is a
 * judgement, not a measurement, so two candidates assessed a week apart must
 * not meet different models without someone having chosen that.
 *
 * One model, for every completion this product makes. There used to be a
 * `tier` argument choosing between a strong model and a cheap one, and a
 * fallback chain from the first to the second. Both now resolve here, so the
 * argument bought nothing while still reading as though it did — and a
 * fallback from a model to itself only pays twice for the same failure.
 *
 * Exported because the in-app assistant is one of those completions:
 * `convex/agent.ts` reaches Mistral through the AI SDK rather than `complete`
 * below — a different library, the same provider and the same id.
 */
export const COMPLETION_MODEL = 'zai-glm-5-3'

const MISTRAL_TRANSCRIPTION_URL =
  'https://api.mistral.ai/v1/audio/transcriptions'
const MISTRAL_COMPLETIONS_URL = 'https://api.mistral.ai/v1/chat/completions'

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
 *
 * Sized for a reasoning model, which is the whole reason it is not 16k any
 * more. Measured against `zai-glm-5-3`: a 27-token prompt asking for three
 * fields spent 2 747 completion tokens, nearly all of it reasoning the caller
 * never sees. An interview report is a far longer prompt and a far longer
 * answer, and the ceiling has to cover both halves. It is a ceiling, not a
 * reservation — an answer that comes in short is billed short — so headroom
 * costs nothing and a truncation costs the whole job.
 */
const MAX_COMPLETION_TOKENS = 32_000

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly cause_?: unknown,
    /** The provider's HTTP status, when the failure is a response — so a
     *  caller never has to read it back out of the message, which quotes
     *  the provider's body. */
    readonly status?: number,
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

/** Mistral types segment times as `number | null`. */
const mistralSegmentSchema = z.object({
  start: z.number().nullable(),
  end: z.number().nullable(),
  text: z.string(),
})

const mistralTranscriptionSchema = z.object({
  text: z.string(),
  model: z.string().optional(),
  segments: z.array(mistralSegmentSchema).optional(),
  // Telemetry only: a usage block we cannot read must never fail the
  // transcript it came with. See KNOWN_ISSUES.md § "Mistral's transcription
  // response is not OpenAI's".
  usage: z
    .object({ prompt_audio_seconds: z.number().nullish() })
    .nullish()
    .catch(undefined),
})

/**
 * No `language`: the provider detects it per answer, which is what lets one
 * role ask a question in French and the next in English. See KNOWN_ISSUES.md
 * § "Transcription detects the language of each answer".
 */
export type TranscribeOptions = {
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
  //
  // A segment with no time is dropped for the same reason: it cannot anchor
  // a quote, and the text survives in `text` anyway.
  const words: Array<TranscriptWord> = (parsed.data.segments ?? []).flatMap(
    (s) =>
      s.start === null || s.end === null
        ? []
        : [{ start: s.start, end: s.end, text: s.text.trim() }],
  )

  return {
    text,
    words,
    model: parsed.data.model ?? TRANSCRIPTION_MODEL,
    audioSeconds: parsed.data.usage?.prompt_audio_seconds ?? null,
  }
}

/* ───────────────────────────── Completions ─────────────────────────────── */

/**
 * A reasoning model answers in blocks rather than in one string: GLM sends a
 * `thinking` block and then a `text` one, where Mistral's own models — and the
 * OpenAI-compatible shape everything else follows — send a plain string. Both
 * are accepted, because the model behind this module is a one-line change.
 */
const contentBlockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
})

const completionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().optional(),
        message: z.object({
          content: z
            .union([z.string(), z.array(contentBlockSchema)])
            .nullable(),
        }),
      }),
    )
    .min(1),
  model: z.string().optional(),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      completion_tokens_details: z
        .object({ reasoning_tokens: z.number().optional() })
        .nullish(),
    })
    .optional(),
})

/**
 * The answer, and nothing but.
 *
 * Only `text` blocks. Joining every block, or taking the first, would hand the
 * model's reasoning to `JSON.parse` — and a chain of thought that happens to
 * contain a JSON-looking fragment would parse into a report nobody wrote.
 */
function answerText(
  content: string | Array<z.infer<typeof contentBlockSchema>> | null,
): string {
  if (typeof content === 'string') return content
  if (!content) return ''
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

export type CompleteOptions<T> = {
  messages: Array<ChatMessage>
  /** The shape the model must produce. Enforced twice: as a JSON schema sent
   *  to the provider, and as a parse on the way back. */
  schema: z.ZodType<T>
  /** A stable name for the schema; providers key strict decoding off it. */
  schemaName: string
  temperature?: number
}

export type CompleteResult<T> = {
  value: T
  model: string
  /** Tokens the provider billed, when it reports them. Written to `jobLog`
   *  so the cost of a report is a query rather than a guess. */
  usage: {
    promptTokens: number
    completionTokens: number
    /** The reasoning share of `completionTokens`, when reported. */
    reasoningTokens?: number
  } | null
}

/**
 * One structured completion, validated.
 *
 * One model, one call. The retry that matters is the work pool's: it re-runs
 * the whole job from where it failed, rather than re-asking a model that just
 * refused. `postWithRetry` below covers only the transport — a 429 or a 5xx on
 * the way there.
 */
export async function complete<T>(
  options: CompleteOptions<T>,
): Promise<CompleteResult<T>> {
  const apiKey = requireEnv('MISTRAL_API_KEY')
  const jsonSchema = z.toJSONSchema(options.schema, { io: 'output' })

  const payload = await postWithRetry(
    MISTRAL_COMPLETIONS_URL,
    {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    JSON.stringify({
      model: COMPLETION_MODEL,
      messages: options.messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: MAX_COMPLETION_TOKENS,
      // `strict: false` on purpose. Mistral does support strict decoding, but
      // the schema sent here is generated from Zod and has never been run
      // against its decoder — and a schema it rejects fails every evaluation
      // at once, not an occasional one. The schema is still sent, so a model
      // that honours it does; the guarantee comes from the Zod parse on the
      // way back, which no provider talks its way past. Worth flipping
      // deliberately, once verified against a key.
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: options.schemaName,
          strict: false,
          schema: jsonSchema,
        },
      },
    }),
    `completion(${COMPLETION_MODEL})`,
    COMPLETION_TIMEOUT_MS,
  )

  const envelope = completionResponseSchema.safeParse(payload)
  if (!envelope.success) {
    throw new AiError(
      `completion envelope was not understood: ${envelope.error.message}`,
    )
  }
  // The provider says outright that it ran out of room. Without this, a cut-off
  // answer surfaces as "model output was not valid JSON" and sends whoever
  // reads `jobLog` hunting for a schema bug that is not there.
  if (envelope.data.choices[0].finish_reason === 'length') {
    throw new AiError(
      `${options.schemaName}: model output was truncated at the token ceiling`,
    )
  }

  const content = answerText(envelope.data.choices[0].message.content)
  // Empty covers both an empty string and a reply that is all reasoning and no
  // answer, which is what a model cut off mid-thought sends.
  if (!content) throw new AiError('completion returned no answer text')

  return {
    value: parseModelJson(content, options.schema, options.schemaName),
    model: envelope.data.model ?? COMPLETION_MODEL,
    usage: envelope.data.usage
      ? {
          promptTokens: envelope.data.usage.prompt_tokens ?? 0,
          completionTokens: envelope.data.usage.completion_tokens ?? 0,
          reasoningTokens:
            envelope.data.usage.completion_tokens_details?.reasoning_tokens,
        }
      : null,
  }
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
        undefined,
        response.status,
      )
      if (!isRetryableStatus(response.status)) throw error
      lastError = error
    } catch (error) {
      // Only a response already judged final by its status reaches here as
      // an AiError. Never re-read the message: it quotes the provider's body,
      // and a 400 whose body says "HTTP 503" is still a 400.
      if (error instanceof AiError) throw error
      lastError = error
    }
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1))
  }
  throw lastError instanceof Error
    ? lastError
    : new AiError(`${label} failed after ${MAX_ATTEMPTS} attempts`)
}
