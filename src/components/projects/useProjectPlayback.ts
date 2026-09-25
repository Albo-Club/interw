import { useCallback, useEffect, useState } from 'react'
import { useConvexAction } from '@convex-dev/react-query'

import { api } from '../../../convex/_generated/api'
import type { FunctionReturnType } from 'convex/server'
import type { Id } from '../../../convex/_generated/dataModel'
import { fireAndForget } from '~/lib/fire-and-forget'

export type ProjectPlayback = FunctionReturnType<typeof api.media.playbackUrls>

/**
 * Signed playback URLs for a role's recordings, in one call for the step.
 *
 * `recorded` names what is recorded (empty when nothing is): the URLs are
 * signed again when it changes, and on `refresh()`, which a finished take
 * calls — a take re-recorded in the same format lands on the same key, and
 * the set of recordings does not change.
 */
export function useProjectPlayback(
  projectId: Id<'projects'>,
  recorded: string,
): { playback: ProjectPlayback | null; refresh: () => void } {
  const playbackUrls = useConvexAction(api.media.playbackUrls)
  const [playback, setPlayback] = useState<ProjectPlayback | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!recorded) {
      setPlayback(null)
      return
    }
    let cancelled = false
    fireAndForget(
      playbackUrls({ projectId }).then((result) => {
        if (!cancelled) setPlayback(result)
      }),
      'project playback urls',
    )
    return () => {
      cancelled = true
    }
  }, [playbackUrls, projectId, recorded, nonce])

  const refresh = useCallback(() => setNonce((value) => value + 1), [])
  return { playback, refresh }
}
