import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Signed playback URLs for one interview, kept alive for as long as the page
 * is open.
 *
 * Two opposite defects lived in the effect this replaces (audit 2026-09-15,
 * recruiter E3). URLs were signed once and never again, so an hour into a
 * review every "jump to 2:14" silently did nothing — and they were re-signed
 * on every write to the session, so saving a note sent the video back to
 * 0:00. Here, signing depends on `key` alone, which names what there is to
 * play and nothing else; the URLs are re-signed on a timer before they expire,
 * and when the player reports an error.
 */

/** Signed read URLs live an hour (`READ_URL_TTL_SECONDS` in
 *  convex/lib/objectStore.ts). Re-sign with ten minutes to spare. */
export const RESIGN_AFTER_MS = 50 * 60 * 1000

/** A playback error this soon after signing is not an expired URL, and
 *  re-signing would loop on a file that cannot play. */
export const FRESH_SIGNATURE_MS = 30 * 1000

type Signer = {
  retry: () => void
  onPlaybackError: () => void
  stop: () => void
}

/**
 * The part of the hook that has behaviour, without React, so it can be tested
 * under fake timers. `onMedia` and `onFailed` are only ever called for the
 * latest signature: a slow answer to an earlier request is dropped.
 */
export function createMediaSigner<T>({
  sign,
  onMedia,
  onFailed,
}: {
  sign: () => Promise<T>
  onMedia: (media: T) => void
  onFailed: () => void
}): Signer {
  let generation = 0
  let signedAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const retry = () => {
    clearTimeout(timer)
    const run = ++generation
    sign().then(
      (media) => {
        if (run !== generation) return
        signedAt = Date.now()
        onMedia(media)
        timer = setTimeout(retry, RESIGN_AFTER_MS)
      },
      (error: unknown) => {
        if (run !== generation) return
        console.warn('[interw] playback urls failed', error)
        onFailed()
      },
    )
  }

  return {
    retry,
    onPlaybackError: () => {
      if (Date.now() - signedAt < FRESH_SIGNATURE_MS) onFailed()
      else retry()
    },
    stop: () => {
      generation += 1
      clearTimeout(timer)
    },
  }
}

/**
 * `key` is null until there is something to sign for; `sign` may change
 * identity on every render without causing a re-sign.
 */
export function useSessionMedia<T>(
  key: string | null,
  sign: () => Promise<T>,
): {
  media: T | null
  failed: boolean
  retry: () => void
  onPlaybackError: () => void
} {
  const [media, setMedia] = useState<T | null>(null)
  const [failed, setFailed] = useState(false)
  const signRef = useRef(sign)
  const signer = useRef<Signer | null>(null)

  useEffect(() => {
    signRef.current = sign
  }, [sign])

  useEffect(() => {
    if (key === null) return
    const current = createMediaSigner({
      sign: () => signRef.current(),
      onMedia: (result) => {
        setMedia(result)
        setFailed(false)
      },
      onFailed: () => setFailed(true),
    })
    signer.current = current
    current.retry()
    return () => current.stop()
  }, [key])

  const retry = useCallback(() => signer.current?.retry(), [])
  const onPlaybackError = useCallback(
    () => signer.current?.onPlaybackError(),
    [],
  )
  return { media, failed, retry, onPlaybackError }
}

/**
 * What the candidate page has to sign for: the answers with a recording, the
 * documents, and whether retention has taken them. Deliberately not the note,
 * the decision or the pipeline trail, whose writes must not reload the video.
 */
export function sessionMediaKey(data: {
  session: {
    _id: string
    hasCv: boolean
    hasCoverLetter: boolean
    mediaPurgedAt: number | null
  }
  answers: ReadonlyArray<{ segmentId: string; uploadState: string }>
}): string {
  return JSON.stringify([
    data.session._id,
    data.session.hasCv,
    data.session.hasCoverLetter,
    data.session.mediaPurgedAt,
    data.answers
      .filter((answer) => answer.uploadState === 'uploaded')
      .map((answer) => answer.segmentId),
  ])
}
