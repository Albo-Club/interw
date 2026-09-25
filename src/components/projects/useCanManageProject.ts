import { useConvexQuery } from '@convex-dev/react-query'

import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * Whether the caller may manage a role's team, archive or delete it.
 *
 * Mirrors `requireProjectOwnerOrAdmin`, which is what enforces it: this only
 * spares a member an action the server would refuse.
 */
export function useCanManageProject(
  orgSlug: string,
  createdBy: Id<'users'> | undefined,
): boolean {
  const me = useConvexQuery(api.users.me)
  const ready = me?.kind === 'ready' ? me : null
  const role = ready?.orgs.find((o) => o.slug === orgSlug)?.role
  return (
    role === 'admin' ||
    role === 'owner' ||
    (createdBy !== undefined && createdBy === ready?.user._id)
  )
}
