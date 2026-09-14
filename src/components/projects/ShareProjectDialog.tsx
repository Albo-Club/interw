import { useEffect, useState } from 'react'
import { useConvexMutation, useConvexQuery } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'
import { errorMessageKey } from '~/lib/convex-errors'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Label } from '~/components/ui/label'
import { Skeleton } from '~/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'

/**
 * Restrict a role to named colleagues, or leave it open to the organisation.
 *
 * Deliberately a whitelist and not a hierarchy: hiring for a replacement, or
 * for a role a team member has applied to, is the ordinary reason a recruiter
 * needs this, and it needs to be one click.
 */
export function ShareProjectDialog({
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
  const members = useConvexQuery(api.projects.shareCandidates, { orgId })
  const setShares = useConvexMutation(api.projects.setShares)
  const [selected, setSelected] = useState<Array<Id<'users'>> | null>(null)
  const [saving, setSaving] = useState(false)

  // `projects.getBySlug` already returns `sharedWith`, but this dialog is also
  // opened from the list, where that read has not happened. Start empty and
  // let the recruiter set the access explicitly rather than guessing.
  useEffect(() => {
    if (open) setSelected([])
  }, [open, projectId])

  const toggle = (userId: Id<'users'>) =>
    setSelected((current) => {
      const next = current ?? []
      return next.includes(userId)
        ? next.filter((id) => id !== userId)
        : [...next, userId]
    })

  const save = async () => {
    setSaving(true)
    try {
      await setShares({ projectId, userIds: selected ?? [] })
      toast.success(t('projects:share.saved'))
      onOpenChange(false)
    } catch (error) {
      const { key, fallbackKey } = errorMessageKey(error, 'projects')
      toast.error(t(key, { defaultValue: t(fallbackKey) }))
    } finally {
      setSaving(false)
    }
  }

  const restricted = (selected ?? []).length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('projects:share.title')}</DialogTitle>
          <DialogDescription>{t('projects:share.subtitle')}</DialogDescription>
        </DialogHeader>

        <p className="text-sm font-medium">
          {restricted
            ? t('projects:share.restricted')
            : t('projects:share.everyone')}
        </p>

        <div className="max-h-64 space-y-2 overflow-y-auto">
          {members === undefined ? (
            <>
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </>
          ) : (
            members.map((member) => (
              <div key={member.userId} className="flex items-center gap-3">
                <Checkbox
                  id={`share-${member.userId}`}
                  checked={(selected ?? []).includes(member.userId)}
                  onCheckedChange={() => toggle(member.userId)}
                />
                <Label
                  htmlFor={`share-${member.userId}`}
                  className="flex-1 cursor-pointer font-normal"
                >
                  <span className="block truncate">
                    {member.name ?? member.email}
                  </span>
                  {member.name && (
                    <span className="text-muted-foreground block truncate text-xs">
                      {member.email}
                    </span>
                  )}
                </Label>
              </div>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {t('projects:share.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
