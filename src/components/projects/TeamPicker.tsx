import { useConvexQuery } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'

import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'
import { Checkbox } from '~/components/ui/checkbox'
import { Label } from '~/components/ui/label'
import { Skeleton } from '~/components/ui/skeleton'

/**
 * The organisation's members, to tick onto a role's team. The creator's seat
 * cannot be unticked (`setTeam` keeps it), so their row is shown ticked and
 * locked rather than hidden, which would leave "am I on it?" unanswered.
 */
export function TeamPicker({
  orgId,
  creatorId,
  selected,
  onChange,
}: {
  orgId: Id<'organizations'>
  creatorId: Id<'users'> | undefined
  /** Null while the current team is still loading. */
  selected: Array<Id<'users'>> | null
  onChange: (next: Array<Id<'users'>>) => void
}) {
  const { t } = useTranslation('projects')
  const members = useConvexQuery(api.projects.teamCandidates, { orgId })

  if (members === undefined || selected === null) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    )
  }

  const toggle = (userId: Id<'users'>) =>
    onChange(
      selected.includes(userId)
        ? selected.filter((id) => id !== userId)
        : [...selected, userId],
    )

  // Creator first: it answers the first question anyone opening this has.
  const ordered = [...members].sort(
    (a, b) => Number(b.userId === creatorId) - Number(a.userId === creatorId),
  )

  return (
    <div className="max-h-64 space-y-1 overflow-y-auto overscroll-contain">
      {ordered.map((member) => {
        const isCreator = member.userId === creatorId
        const id = `team-${member.userId}`
        return (
          <div key={member.userId} className="flex min-h-10 items-center gap-3">
            <Checkbox
              id={id}
              checked={isCreator || selected.includes(member.userId)}
              disabled={isCreator}
              onCheckedChange={() => toggle(member.userId)}
            />
            <Label
              htmlFor={id}
              className="min-w-0 flex-1 cursor-pointer py-1 font-normal"
            >
              <span className="block truncate">
                {member.name ?? member.email}
              </span>
              {(isCreator || member.name) && (
                <span className="text-muted-foreground block truncate text-xs">
                  {isCreator ? t('team.creator') : member.email}
                </span>
              )}
            </Label>
          </div>
        )
      })}
    </div>
  )
}
