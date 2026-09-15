/**
 * Anchoring a quote to the second of video it came from.
 *
 * This is what turns "the candidate seemed vague about ownership" into
 * something a recruiter can check in four seconds. A claim in a report that
 * cannot be traced back to the moment it came from is an opinion, and this
 * product has no business producing those.
 *
 * The model is asked for an approximate offset, but its estimate is only ever
 * a fallback: the authoritative answer comes from matching the quote against
 * the timestamped transcript we already hold.
 */

export type TimedChunk = { start: number; end: number; text: string }

/**
 * Lowercase, strip accents and punctuation, collapse whitespace.
 *
 * Apostrophes are DELETED rather than turned into spaces: French elides
 * constantly (j'ai, l'equipe, qu'on), and a model that writes "jai" where the
 * transcript has "j'ai" must still match. Every other separator becomes a
 * space.
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['\u2019\u02bc]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The start time of `quote` within `chunks`, or null when it cannot be found.
 *
 * Matching is done on the concatenated normalised transcript so a quote that
 * straddles two chunks still resolves; the returned time is the start of the
 * chunk the match begins in. Returning null rather than guessing is the point:
 * a wrong timestamp sends a recruiter to the wrong moment and quietly destroys
 * their trust in every other one.
 */
export function resolveQuoteStart(
  chunks: ReadonlyArray<TimedChunk>,
  quote: string,
): number | null {
  const needle = normalizeForMatch(quote)
  if (!needle || chunks.length === 0) return null

  // Build the haystack once, remembering where each chunk begins in it.
  let haystack = ''
  const offsets: Array<{ at: number; start: number }> = []
  for (const chunk of chunks) {
    const piece = normalizeForMatch(chunk.text)
    if (!piece) continue
    if (haystack) haystack += ' '
    offsets.push({ at: haystack.length, start: chunk.start })
    haystack += piece
  }
  if (!haystack) return null

  let index = haystack.indexOf(needle)
  if (index === -1) {
    // Models paraphrase or truncate. Fall back to the first handful of words,
    // which is enough to land in the right chunk.
    const prefix = needle.split(' ').slice(0, 6).join(' ')
    if (prefix.length < 8) return null
    index = haystack.indexOf(prefix)
    if (index === -1) return null
  }

  let resolved = offsets[0].start
  for (const offset of offsets) {
    if (offset.at <= index) resolved = offset.start
    else break
  }
  return resolved
}

/**
 * The offset to use, preferring the transcript over the model's guess, and
 * clamping to the clip so a citation can never seek past the end of a video.
 */
export function chooseStartSeconds({
  chunks,
  quote,
  modelEstimate,
  durationSeconds,
}: {
  chunks: ReadonlyArray<TimedChunk>
  quote: string
  modelEstimate: number | null
  durationSeconds: number | null
}): number {
  const resolved = resolveQuoteStart(chunks, quote)
  const candidate = resolved ?? Math.max(0, modelEstimate ?? 0)
  if (durationSeconds !== null && durationSeconds > 0) {
    return Math.min(candidate, Math.max(0, durationSeconds - 1))
  }
  return candidate
}
