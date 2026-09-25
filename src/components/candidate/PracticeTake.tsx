import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Circle, RotateCcw, Square } from 'lucide-react'

import { SingleRecorder } from '~/lib/media/recorder'
import { Button } from '~/components/ui/button'

const PRACTICE_SECONDS = 10

/** A finished take is `url`, not a phase. */
type Phase = 'idle' | 'recording' | 'failed'

/**
 * Ten seconds recorded and played back, on the check screen.
 *
 * A meter says the microphone hears something; only hearing yourself says
 * the answer will be understood — the echo, the fan, the headset that
 * records from the laptop instead. Nothing leaves the browser: the take is a
 * blob URL, revoked as soon as it is replaced or the screen is left.
 *
 * The take is handed up rather than played here: the check screen plays it on
 * its stage, where there is room for it without scrolling.
 */
export function PracticeTake({
  stream,
  mimeType,
  onTake,
}: {
  stream: MediaStream
  mimeType: string
  /** The finished take's URL, or null once it is replaced or revoked. */
  onTake: (url: string | null) => void
}) {
  const { t } = useTranslation('interview')
  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [url, setUrl] = useState<string | null>(null)
  const recorderRef = useRef<SingleRecorder | null>(null)
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    onTake(url)
    if (!url) return
    return () => {
      onTake(null)
      URL.revokeObjectURL(url)
    }
  }, [url, onTake])

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
      setUrl(URL.createObjectURL(blob))
      setPhase('idle')
    } catch {
      setPhase('failed')
    }
  }

  const start = () => {
    setUrl(null)
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
          {url ? (
            <RotateCcw className="size-4" />
          ) : (
            <Circle className="size-4" />
          )}
          {url
            ? t('device.practice.again')
            : t('device.practice.start', { seconds: PRACTICE_SECONDS })}
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
