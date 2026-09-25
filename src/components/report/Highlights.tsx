import { useTranslation } from 'react-i18next'
import { Play } from 'lucide-react'

import { cn, formatTimecode } from '~/lib/utils'

export type Highlight = {
  segmentId: string
  startSeconds: number
  kind: 'strength' | 'personality' | 'watchpoint'
  label: string
}

/**
 * The few moments the analysis says are worth watching, set under the player
 * like chapter marks: each one starts the recording at its second. Without a
 * recording to play (purged, or not signed yet) they stay readable but are
 * not offered as buttons — a button that plays nothing is worse than none.
 */
export function Highlights({
  highlights,
  onJump,
}: {
  highlights: ReadonlyArray<Highlight>
  onJump: ((segmentId: string, seconds: number) => void) | null
}) {
  const { t } = useTranslation('report')
  if (highlights.length === 0) return null

  return (
    <section className="space-y-2" aria-labelledby="highlights-heading">
      <h2 id="highlights-heading" className="text-sm font-semibold">
        {t('sections.highlights')}
      </h2>
      <ul className="divide-y rounded-lg border">
        {highlights.map((highlight, index) => {
          const body = (
            <>
              <span
                className={cn(
                  'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
                  highlight.kind === 'strength' &&
                    'bg-success-subtle text-success-strong',
                  highlight.kind === 'personality' &&
                    'bg-info-subtle text-info-strong',
                  highlight.kind === 'watchpoint' &&
                    'bg-warning-subtle text-warning-strong',
                )}
              >
                {t(`highlights.kind.${highlight.kind}`)}
              </span>
              <span className="min-w-0 flex-1 text-sm break-words">
                {highlight.label}
              </span>
              {onJump && (
                <span className="text-primary inline-flex shrink-0 items-center gap-1 text-xs tabular-nums">
                  <Play className="size-3" aria-hidden />
                  {t('highlights.jump', {
                    time: formatTimecode(highlight.startSeconds),
                  })}
                </span>
              )}
            </>
          )
          return (
            <li key={index}>
              {onJump ? (
                <button
                  type="button"
                  onClick={() =>
                    onJump(highlight.segmentId, highlight.startSeconds)
                  }
                  className="hover:bg-accent focus-visible:ring-ring flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
                >
                  {body}
                </button>
              ) : (
                <div className="flex items-start gap-3 px-3 py-2.5">{body}</div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
