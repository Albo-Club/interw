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
  fetchImpl?: typeof fetch
  sleepImpl?: (ms: number) => Promise<void>
}

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
    fetchImpl = fetch,
    sleepImpl = defaultSleep,
  } = options

  let lastError: UploadError | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw new UploadError('upload aborted')
    onProgress?.({
      phase: attempt === 1 ? 'uploading' : 'retrying',
      attempt,
      maxAttempts,
    })

    try {
      const response = await fetchImpl(url, {
        method: 'PUT',
        body: blob,
        headers: { 'Content-Type': contentType },
        signal,
      })
      if (response.ok) {
        onProgress?.({ phase: 'done', attempt, maxAttempts })
        return
      }
      lastError = new UploadError(
        `upload rejected with HTTP ${response.status}`,
        response.status,
      )
      if (!isRetryable(response.status)) break
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

  onProgress?.({ phase: 'failed', attempt: maxAttempts, maxAttempts })
  throw lastError ?? new UploadError('upload failed')
}
