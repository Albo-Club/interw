import { useState } from 'react'
import { useConvexMutation, useConvexQuery } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { Check, Copy, Link2 } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'
import { errorMessageKey } from '~/lib/convex-errors'
import { getLocale } from '~/lib/locale'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Skeleton } from '~/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'

const EXPIRY_OPTIONS = ['7', '30', 'never'] as const

/**
 * Create, show and revoke the links that let someone outside the account read
 * one report. Expiry defaults to 30 days rather than never: a link that
 * outlives the hiring decision is a link nobody remembers exists.
 */
export function ShareReportDialog({
  sessionId,
  open,
  onOpenChange,
}: {
  sessionId: Id<'sessions'>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation(['report', 'common'])
  const locale = getLocale()
  const shares = useConvexQuery(api.shares.forReport, { sessionId })
  const create = useConvexMutation(api.shares.create)
  const revoke = useConvexMutation(api.shares.revoke)
  const [expiry, setExpiry] = useState<(typeof EXPIRY_OPTIONS)[number]>('30')
  const [busy, setBusy] = useState(false)
  // Revoking is irreversible and breaks access for whoever was sent the link,
  // so it names the link and asks first (audit 2026-09-15, recruiter M5).
  const [revoking, setRevoking] = useState<NonNullable<
    typeof shares
  >[number] | null>(null)

  const notify = (error: unknown) => {
    const { key, fallbackKey } = errorMessageKey(error, 'report')
    toast.error(t(key, { defaultValue: t(fallbackKey) }))
  }

  const viewsLabel = (viewCount: number) =>
    viewCount > 0
      ? t('report:share.views', { count: viewCount })
      : t('report:share.neverViewed')

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success(t('report:share.copied'))
    } catch {
      // Clipboard access is denied in some embedded browsers; the input below
      // is selectable, so this is a convenience, not the only way out.
      toast.error(t('common:errorBoundary.title'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('report:share.title')}</DialogTitle>
          <DialogDescription>{t('report:share.subtitle')}</DialogDescription>
        </DialogHeader>

        {shares === undefined ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <div className="space-y-4">
            {shares.map((share) => (
              <div key={share._id} className="space-y-2 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <Input readOnly value={share.url} className="font-mono text-xs" />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => void copy(share.url)}
                    aria-label={t('report:share.copy')}
                  >
                    <Copy className="size-4" />
                  </Button>
                </div>
                <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="tabular-nums">
                    {viewsLabel(share.viewCount)}
                    {share.expiresAt
                      ? ` · ${t('report:share.expiresOn', {
                          date: new Date(share.expiresAt).toLocaleDateString(
                            locale,
                          ),
                        })}`
                      : ''}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setRevoking(share)}
                  >
                    {t('report:share.revoke')}
                  </Button>
                </div>
              </div>
            ))}

            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="share-expiry">{t('report:share.expiry')}</Label>
                <Select
                  value={expiry}
                  onValueChange={(value) =>
                    setExpiry(value as (typeof EXPIRY_OPTIONS)[number])
                  }
                >
                  <SelectTrigger id="share-expiry" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {t(`report:share.expiryOptions.${option}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  void create({
                    sessionId,
                    expiresInDays: expiry === 'never' ? null : Number(expiry),
                  })
                    .then((result) => void copy(result.url))
                    .catch(notify)
                    .finally(() => setBusy(false))
                }}
              >
                <Link2 className="size-4" />
                {t('report:share.create')}
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            <Check className="size-4" />
            {t('common:actions.close')}
          </Button>
        </DialogFooter>
      </DialogContent>

      <AlertDialog
        open={revoking !== null}
        onOpenChange={(next) => {
          if (!next) setRevoking(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('report:share.revokeConfirm.title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {revoking &&
                t('report:share.revokeConfirm.body', {
                  date: new Date(revoking.createdAt).toLocaleDateString(locale),
                  views: viewsLabel(revoking.viewCount),
                })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!revoking) return
                void revoke({ shareId: revoking._id })
                  .then(() => toast.success(t('report:share.revoked')))
                  .catch(notify)
              }}
            >
              {t('report:share.revokeConfirm.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}
