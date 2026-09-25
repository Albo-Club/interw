import { useTranslation } from 'react-i18next'
import { MicOff } from 'lucide-react'

import { MicMeter } from './MicMeter'
import { assessMicLevels } from '~/lib/media/devices'
import { useAudioLevel } from '~/lib/media/useAudioLevel'
import { Alert, AlertDescription } from '~/components/ui/alert'

/** A pause to think is shorter. */
const SILENCE_MS = 8_000

/**
 * The microphone, live, while an answer records.
 *
 * A microphone that drops to nothing mid-answer used to be found at
 * transcription, days later, as a candidate who said nothing. Nothing is
 * stopped here — a long pause is allowed — but the candidate is told while
 * they can still do something about it.
 */
export function RecordingMic({ stream }: { stream: MediaStream | null }) {
  const { t } = useTranslation('interview')
  const { level, recent, full } = useAudioLevel(stream, SILENCE_MS)
  const verdict = assessMicLevels(recent)
  const silent = full && verdict === 'silent'
  return (
    <div className="space-y-3">
      <MicMeter level={level} verdict={verdict} />
      {silent && (
        <Alert>
          <MicOff className="size-4" />
          <AlertDescription>{t('run.cantHearYou')}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
