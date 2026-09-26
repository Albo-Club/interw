import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Circle, RotateCcw, Square } from 'lucide-react'

import { SingleRecorder } from '~/lib/media/recorder'
import { Button } from '~/components/ui/button'

const PRACTICE_SECONDS = 10

/** A finished take is the parent's `take`, not a phase. */
type Phase = 'idle' | 'recording' | 'failed'

/**
 * Ten seconds recorded and played back, on the check screen.
 *
 * A meter says the microphone hears something; only hearing yourself says
 * the answer will be understood — the echo, the fan, the headset that
 * records from the laptop instead. Nothing leaves the browser: the take is a
 * blob URL, which the screen that holds it revokes.
 *
 * The take belongs to the check screen, which plays it on its stage where
 * there is room for it without scrolling; this is the button that records it.
 */
export function PracticeTake({
  stream,
  mimeType,
  hasTake,
  onTake,
}: {
  stream: MediaStream
  mimeType: string
  hasTake: boolean
  /** A new take's blob URL, or null when a new recording starts. */
  onTake: (url: string | null) => void
}) {
  const { t } = useTranslation('interview')
  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsed, setElapsed] = useState(0)
  const recorderRef = useRef<SingleRecorder | null>(null)
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current)
      recorderRef.current?.dispose()
    },
    [],
  )

  const stop = async () => {
    const recorder = recorderRef.current
    if (!recorder) return
    recorderRef.current = null
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current)
    try {
      const { blob } = await recorder.stop()
      onTake(URL.createObjectURL(blob))
      setPhase('idle')
    } catch {
      setPhase('failed')
    }
  }

  const start = () => {
    onTake(null)
    setElapsed(0)
    try {
      const recorder = new SingleRecorder(stream, mimeType, ({ elapsedSeconds }) =>
        setElapsed(elapsedSeconds),
      )
      recorder.start()
      recorderRef.current = recorder
      stopTimerRef.current = setTimeout(
        () => void stop(),
        PRACTICE_SECONDS * 1000,
      )
      setPhase('recording')
    } catch {
      setPhase('failed')
    }
  }

  return (
    <>
      {phase === 'recording' ? (
        <Button variant="outline" onClick={() => void stop()}>
          <Square className="size-4" />
          {t('device.practice.stop', {
            seconds: Math.max(0, PRACTICE_SECONDS - elapsed),
          })}
        </Button>
      ) : (
        <Button variant="outline" onClick={start}>
          {hasTake ? (
            <>
              <RotateCcw className="size-4" />
              {t('device.practice.again')}
            </>
          ) : (
            <>
              <Circle className="size-4" />
              {t('device.practice.start', { seconds: PRACTICE_SECONDS })}
            </>
          )}
        </Button>
      )}
      {phase === 'failed' && (
        <p role="status" className="text-destructive basis-full text-center text-sm">
          {t('device.practice.failed')}
        </p>
      )}
    </>
  )
}
