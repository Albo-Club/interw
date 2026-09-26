import type { ReactNode } from 'react'

import { cn } from '~/lib/utils'

/**
 * The interview's one video surface, laid out like a video call: whoever is
 * speaking fills it. While a question is asked, that is the recruiter, and the
 * candidate's camera is a thumbnail in the corner so they can check their
 * framing; once they answer, their camera takes the whole stage.
 *
 * The camera's layer is always rendered in the same place in the tree and
 * only its classes change, so the `<video>` holding the live stream is never
 * remounted between the two layouts — a remount drops `srcObject` and shows a
 * black frame.
 */
export function Stage({
  prompt,
  self,
  caption,
  status,
  overlay,
}: {
  /** The question, when it has the floor. Null once the candidate answers. */
  prompt: ReactNode
  /** The candidate's camera. */
  self: ReactNode
  /** Laid along the bottom edge of whatever fills the stage. */
  caption?: ReactNode
  /** Readouts pinned to the stage's edges, above the caption. */
  status?: ReactNode
  /** Covers the stage, for a state that takes over from it. */
  overlay?: ReactNode
}) {
  const asking = prompt !== null
  return (
    <div className="bg-stage text-stage-foreground relative min-h-0 flex-1 overflow-hidden rounded-xl">
      {asking && <div className="absolute inset-0">{prompt}</div>}
      <div
        className={cn(
          'absolute overflow-hidden',
          asking
            ? 'ring-stage-foreground/30 top-3 right-3 z-10 aspect-[3/4] w-1/4 max-w-48 min-w-24 rounded-lg shadow-lg ring-1 sm:aspect-video'
            : 'inset-0',
        )}
      >
        {self}
      </div>
      {caption && (
        <div className="from-stage/90 absolute inset-x-0 bottom-0 z-20 max-h-[45%] overflow-y-auto bg-linear-to-t to-transparent px-5 pt-12 pb-5 sm:px-8 sm:pb-7">
          {caption}
        </div>
      )}
      {status && (
        // Beside a thumbnail, stops where it starts: the same width as its
        // classes above, so nothing on the status layer runs under it.
        <div
          className={cn(
            'pointer-events-none absolute inset-y-0 left-0 z-20',
            asking ? 'right-[max(min(25%,12rem),6rem)]' : 'right-0',
          )}
        >
          {status}
        </div>
      )}
      {overlay && (
        <div className="bg-stage/70 absolute inset-0 z-30 flex items-center justify-center p-4 backdrop-blur-sm">
          {/* What takes over the stage says what to do in a sentence: an
              alert title here is never clipped to one line. */}
          <div className="w-full max-w-md [&_[data-slot=alert-title]]:line-clamp-none">
            {overlay}
          </div>
        </div>
      )}
    </div>
  )
}
