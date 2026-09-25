import { useEffect, useState } from 'react'
import { useConvexMutation, useConvexQuery } from '@convex-dev/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { api } from '../../../convex/_generated/api'
import { TeamPicker } from './TeamPicker'
import type { Id } from '../../../convex/_generated/dataModel'
import { errorMessageKey } from '~/lib/convex-errors'
import { MemberName } from '~/components/MemberName'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'

/**
 * Choose who follows a role: they see it, and they are emailed when one of
 * its reports is ready.
 *
 * `setTeam` replaces the whole list, so the selection starts from the team as
 * it is and Save stays disabled until that has loaded (B8). A dialog that
 * opened empty used to wipe the team on the first save.
 */
export function ProjectTeamDialog({
  orgId,
  projectId,
  open,
  onOpenChange,
}: {
  orgId: Id<'organizations'>
  projectId: Id<'projects'>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation(['projects', 'common'])
  const team = useConvexQuery(api.projects.team, open ? { projectId } : 'skip')
  const setTeam = useConvexMutation(api.projects.setTeam)
  const [selected, setSelected] = useState<Array<Id<'users'>> | null>(null)
  const [saving, setSaving] = useState(false)
  const creatorSeated = team?.members.includes(team.createdBy) ?? false

  // Seed once per opening, not on every live update: a colleague's change
  // arriving mid-edit must not overwrite what this recruiter is ticking.
  useEffect(() => {
    if (!open) setSelected(null)
    else if (team && selected === null) setSelected(team.members)
  }, [open, team, selected])

  const save = async () => {
    if (selected === null) return
    setSaving(true)
    try {
      await setTeam({ projectId, userIds: selected })
      toast.success(t('projects:team.saved'))
      onOpenChange(false)
    } catch (error) {
      const { key, fallbackKey } = errorMessageKey(error, 'projects')
      toast.error(t(key, { defaultValue: t(fallbackKey) }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('projects:team.title')}</DialogTitle>
          <DialogDescription>{t('projects:team.subtitle')}</DialogDescription>
        </DialogHeader>

        {/* A creator with a seat is the locked first row of the picker. One
            who lost it with their membership keeps the credit, and if they
            are back in the org, an ordinary row anyone may tick. */}
        {team && !creatorSeated && (
          <p className="text-muted-foreground text-sm">
            <Trans
              t={t}
              i18nKey="projects:team.createdBy"
              components={{ name: <MemberName member={team.creator} /> }}
            />
          </p>
        )}

        <TeamPicker
          orgId={orgId}
          creatorId={creatorSeated ? team?.createdBy : undefined}
          selected={selected}
          onChange={setSelected}
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            onClick={() => void save()}
            disabled={saving || selected === null}
          >
            {t('projects:team.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
