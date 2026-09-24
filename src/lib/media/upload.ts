/**
 * Uploading a recording to a presigned URL.
 *
 * Shared by the recruiter (recording a question) and the candidate (answering
 * one), and it lives in `~/lib` rather than a component precisely so the two
 * surfaces can share the logic without sharing a bundle.
 *
 * A failed upload is never silent. In an asynchronous interview the candidate
 * has one shot: if an answer does not reach the bucket and nobody says so,
 * they finish the interview believing it worked and find out days later that
 * it did not. Every failure surfaces, and the caller is told which attempt
 * it is on.
 */

export type UploadPhase = 'uploading' | 'retrying' | 'done' | 'failed'

export type UploadProgress = {
  phase: UploadPhase
  attempt: number
  maxAttempts: number
  /** Bytes of this attempt that have left the browser. */
  loaded: number
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'UploadError'
  }
}

export type PutRequest = {
  url: string
  body: Blob
  contentType: string
  signal?: AbortSignal
  onUploadProgress: (loaded: number) => void
}

/** Resolves with the HTTP status; rejects only when no response came back. */
export type SendImpl = (request: PutRequest) => Promise<number>

export type UploadOptions = {
  url: string
  blob: Blob
  /** Must equal the content type the URL was signed with, or S3 rejects it. */
  contentType: string
  maxAttempts?: number
  /** Overridable for tests; defaults to a 1s, 2s, 4s backoff. */
  backoffMs?: (attempt: number) => number
  onProgress?: (progress: UploadProgress) => void
  signal?: AbortSignal
  sendImpl?: SendImpl
  sleepImpl?: (ms: number) => Promise<void>
}

/**
 * A PUT that reports bytes sent.
 *
 * XHR rather than `fetch`, because `fetch` exposes no upload progress — and on
 * the candidate surface a screen that does not move for five minutes is a
 * failure mode, not a cosmetic one: a 40 MB answer over 4G looks frozen, the
 * candidate reloads, and the answer is gone.
 */
const xhrPut: SendImpl = ({
  url,
  body,
  contentType,
  signal,
  onUploadProgress,
}) =>
  new Promise<number>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', contentType)
    xhr.upload.onprogress = (event) => onUploadProgress(event.loaded)
    xhr.onload = () => resolve(xhr.status)
    xhr.onerror = () => reject(new Error('network error'))
    xhr.onabort = () => reject(new Error('upload aborted'))
    signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(body)
  })

const DEFAULT_MAX_ATTEMPTS = 3
const defaultBackoff = (attempt: number) => 1000 * 2 ** (attempt - 1)
const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 4xx means this URL will never work; retrying just delays the bad news. */
function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

export async function uploadToSignedUrl(options: UploadOptions): Promise<void> {
  const {
    url,
    blob,
    contentType,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    backoffMs = defaultBackoff,
    onProgress,
    signal,
    sendImpl = xhrPut,
    sleepImpl = defaultSleep,
  } = options

  const report = (phase: UploadPhase, attempt: number, loaded: number) =>
    onProgress?.({ phase, attempt, maxAttempts, loaded })

  let lastError: UploadError | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw new UploadError('upload aborted')
    const phase = attempt === 1 ? 'uploading' : 'retrying'
    report(phase, attempt, 0)

    try {
      const status = await sendImpl({
        url,
        body: blob,
        contentType,
        signal,
        onUploadProgress: (loaded) => report(phase, attempt, loaded),
      })
      if (status >= 200 && status < 300) {
        report('done', attempt, blob.size)
        return
      }
      lastError = new UploadError(
        `upload rejected with HTTP ${status}`,
        status,
      )
      if (!isRetryable(status)) break
    } catch (error) {
      // A network drop mid-interview is the case this whole function exists
      // for, so it is retryable; an explicit abort is not.
      if (signal?.aborted) throw new UploadError('upload aborted')
      lastError = new UploadError(
        error instanceof Error ? error.message : 'network error',
      )
    }

    if (attempt < maxAttempts) await sleepImpl(backoffMs(attempt))
  }

  report('failed', maxAttempts, 0)
  throw lastError ?? new UploadError('upload failed')
}
