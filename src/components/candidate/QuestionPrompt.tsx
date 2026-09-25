import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Play, RotateCcw } from 'lucide-react'

import { fireAndForget } from '~/lib/fire-and-forget'
import { cn } from '~/lib/utils'

/**
 * A question as it fills the interview stage.
 *
 * A recorded question plays by itself: the candidate pressed a button to get
 * here, which is the gesture browsers ask for before sound. Where a browser
 * refuses anyway (Safari on iOS, some settings), the video simply stays
 * paused and the play button over it is the way on — nothing is caught or
 * guessed. Without a video, the question is the text itself, set large.
 */
export function QuestionPrompt({
  content,
  hint,
  media,
  label,
}: {
  content: string
  hint: string | null
  media: { src: string; kind: 'audio' | 'video' } | null
  /** The accessible name of the recording: which question this is. */
  label: string
}) {
  if (media?.kind === 'video') {
    return <QuestionVideo src={media.src} label={label} />
  }
  return (
    <div className="flex size-full flex-col items-center justify-center gap-6 overflow-y-auto p-6 text-center sm:p-12">
      <QuestionText content={content} hint={hint} large />
      {media && (
        <audio
          src={media.src}
          controls
          autoPlay
          aria-label={label}
          className="w-full max-w-md"
        />
      )}
    </div>
  )
}

/** The question in words: the caption over a video, or the stage itself. */
export function QuestionText({
  content,
  hint,
  large = false,
}: {
  content: string
  hint: string | null
  large?: boolean
}) {
  const { t } = useTranslation('interview')
  return (
    <div className="max-w-2xl space-y-2">
      <h1
        className={cn(
          'leading-snug font-medium text-balance',
          large ? 'text-2xl sm:text-3xl' : 'text-lg sm:text-xl',
        )}
      >
        {content}
      </h1>
      {hint && (
        <p className="text-stage-foreground/75 text-sm leading-relaxed">
          {t('run.hint')} — {hint}
        </p>
      )}
    </div>
  )
}

const PLAYBACK_LABELS = {
  playing: 'run.prompt.pause',
  paused: 'run.prompt.play',
  ended: 'run.prompt.replay',
} as const

/**
 * A recorded question, or the intro on the welcome screen. There no button
 * has been pressed yet, so browsers usually refuse to start it with sound and
 * the play button is how it starts — the same fallback as a refused question.
 */
export function QuestionVideo({ src, label }: { src: string; label: string }) {
  const { t } = useTranslation('interview')
  const video = useRef<HTMLVideoElement>(null)
  const [status, setStatus] = useState<keyof typeof PLAYBACK_LABELS>('paused')
  const toggle = () => {
    if (!video.current) return
    if (status === 'playing') video.current.pause()
    else fireAndForget(video.current.play(), 'question playback')
  }
  return (
    <div className="relative size-full">
      <video
        ref={video}
        src={src}
        autoPlay
        playsInline
        aria-label={label}
        onPlay={() => setStatus('playing')}
        onPause={() => setStatus((was) => (was === 'ended' ? was : 'paused'))}
        onEnded={() => setStatus('ended')}
        className="size-full object-contain"
      />
      {/* The whole picture is the control, as on any video: a tap pauses or
          plays. A real button, so it is also a keyboard stop. */}
      <button
        type="button"
        onClick={toggle}
        aria-label={t(PLAYBACK_LABELS[status])}
        className="focus-visible:ring-ring absolute inset-0 flex items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-inset"
      >
        {status !== 'playing' && (
          <span className="bg-stage/70 text-stage-foreground flex items-center gap-2 rounded-full px-5 py-3 text-sm font-medium backdrop-blur-sm">
            {status === 'ended' ? (
              <RotateCcw className="size-4" aria-hidden />
            ) : (
              <Play className="size-4" aria-hidden />
            )}
            {t(PLAYBACK_LABELS[status])}
          </span>
        )}
      </button>
    </div>
  )
}
