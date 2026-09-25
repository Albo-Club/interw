/**
 * Fetch one answer's video whole, reporting progress. Why the player needs a
 * local copy: KNOWN_ISSUES.md § "A MediaRecorder video is played from a
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
  let received = 0
  let reported: number | null | undefined
  const counted = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength
        const percent = total
          ? Math.min(100, Math.floor((received / total) * 100))
          : null
        if (percent !== reported) {
          reported = percent
          onProgress(percent)
        }
        controller.enqueue(chunk)
      },
    }),
  )
  // The browser assembles the Blob itself: no second copy held in JS.
  return await new Response(counted, {
    headers: { 'content-type': response.headers.get('content-type') ?? '' },
  }).blob()
}
