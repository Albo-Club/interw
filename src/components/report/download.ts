/**
 * Fetch one answer's video whole, reporting progress.
 *
 * The player plays the downloaded copy rather than the signed URL:
 * MediaRecorder's files carry no index, so a seek into bytes the browser has
 * not read yet lands wherever it guesses, and `buffered` cannot tell us when
 * it is safe — see KNOWN_ISSUES.md § "A MediaRecorder video is played from a
 * downloaded copy".
 *
 * `onProgress` receives a whole percent, once per change, or null when the
 * response has no Content-Length.
 */
export async function downloadMedia(
  url: string,
  onProgress: (percent: number | null) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await fetch(url, { signal })
  if (!response.ok || !response.body) {
    throw new Error(`media download failed: ${response.status}`)
  }
  const total = Number(response.headers.get('content-length')) || null
  const reader = response.body.getReader()
  const chunks: Array<BlobPart> = []
  let received = 0
  let reported: number | null | undefined
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    const percent = total ? Math.min(100, Math.floor((received / total) * 100)) : null
    if (percent !== reported) {
      reported = percent
      onProgress(percent)
    }
  }
  return new Blob(chunks, {
    type: response.headers.get('content-type') ?? '',
  })
}
