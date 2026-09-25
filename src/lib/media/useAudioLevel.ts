import { useEffect, useState } from 'react'

import { levelFromTimeDomain } from './devices'
import { fireAndForget } from '~/lib/fire-and-forget'

/** Ten readings a second: enough for a meter, cheap enough to re-render. */
const LEVEL_SAMPLE_MS = 100

export type AudioLevel = {
  level: number
  /** The readings of the last `windowMs`, oldest first; a new array every reading, so
   *  a microphone stuck at exactly zero still moves the screen along. */
  recent: ReadonlyArray<number>
  /** The window has been heard in full: silence in it is a finding. */
  full: boolean
}

const QUIET: AudioLevel = { level: 0, recent: [], full: false }

/**
 * How loud `stream` is, read ten times a second while it is set.
 *
 * Without an AudioContext (very old Safari) it reads nothing rather than
 * failing: a meter that cannot move is not a reason to stop the interview.
 */
export function useAudioLevel(
  stream: MediaStream | null,
  windowMs: number,
): AudioLevel {
  const [reading, setReading] = useState<AudioLevel>(QUIET)

  useEffect(() => {
    setReading(QUIET)
    if (!stream || stream.getAudioTracks().length === 0) return
    // Safari below 14.1 only exposes the prefixed constructor.
    const scope = globalThis as unknown as {
      AudioContext?: typeof AudioContext
      webkitAudioContext?: typeof AudioContext
    }
    const AudioCtx = scope.AudioContext ?? scope.webkitAudioContext
    if (!AudioCtx) return

    const context = new AudioCtx()
    // iOS starts a context created outside a tap suspended.
    fireAndForget(context.resume(), 'audio meter resume')
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    context.createMediaStreamSource(stream).connect(analyser)
    const buffer = new Uint8Array(analyser.fftSize)
    const windowSize = Math.round(windowMs / LEVEL_SAMPLE_MS)
    let recent: Array<number> = []

    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(buffer)
      const level = levelFromTimeDomain(buffer)
      recent = [...recent, level].slice(-windowSize)
      setReading({ level, recent, full: recent.length === windowSize })
    }, LEVEL_SAMPLE_MS)

    return () => {
      clearInterval(timer)
      fireAndForget(context.close(), 'audio meter close')
    }
  }, [stream, windowMs])

  return reading
}
