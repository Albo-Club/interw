import { useMemo, useState } from 'react'
import { useConvexMutation } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'
import { errorMessageKey } from '~/lib/convex-errors'
import { parseCandidateList } from '~/lib/candidate-list'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { Label } from '~/components/ui/label'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'

type Row = { name: string; email: string }

/**
 * Invite one person, or a hundred.
 *
 * The pasted list is parsed in the browser and shown back — how many will be
 * invited, and which lines could not be read — before anything is sent.
 * Silently dropping an unreadable line means a real person never gets their
 * interview and nobody finds out.
 */
export function InviteCandidatesDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: Id<'projects'>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation(['candidates', 'common'])
  const invite = useConvexMutation(api.sessions.invite)
  const [mode, setMode] = useState<'single' | 'bulk'>('single')
  const [rows, setRows] = useState<Array<Row>>([{ name: '', email: '' }])
  const [pasted, setPasted] = useState('')
  const [sending, setSending] = useState(false)

  const parsed = useMemo(() => parseCandidateList(pasted), [pasted])
  const candidates =
    mode === 'bulk'
      ? parsed.candidates
      : rows.filter((row) => row.name.trim() && row.email.trim())

  const send = async () => {
    setSending(true)
    try {
      const result = await invite({ projectId, candidates })
      const created = result.created
      const reused = result.results.length - created
      toast.success(t('candidates:invite.sent', { count: result.results.length }))
      if (reused > 0) {
        toast.info(t('candidates:invite.duplicates', { count: reused }))
      }
      setRows([{ name: '', email: '' }])
      setPasted('')
      onOpenChange(false)
    } catch (error) {
      const { key, fallbackKey } = errorMessageKey(error, 'candidates')
      toast.error(t(key, { defaultValue: t(fallbackKey) }))
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('candidates:invite.title')}</DialogTitle>
          <DialogDescription>
            {t('candidates:invite.subtitle')}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={mode} onValueChange={(value) => setMode(value as typeof mode)}>
          <TabsList>
            <TabsTrigger value="single">
              {t('candidates:invite.single')}
            </TabsTrigger>
            <TabsTrigger value="bulk">{t('candidates:invite.bulk')}</TabsTrigger>
          </TabsList>

          <TabsContent value="single" className="space-y-3 pt-4">
            {rows.map((row, index) => (
              <div key={index} className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`invite-name-${index}`}>
                    {t('candidates:invite.name')}
                  </Label>
                  <Input
                    id={`invite-name-${index}`}
                    value={row.name}
                    onChange={(event) =>
                      setRows((current) =>
                        current.map((item, i) =>
                          i === index
                            ? { ...item, name: event.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`invite-email-${index}`}>
                    {t('candidates:invite.email')}
                  </Label>
                  <Input
                    id={`invite-email-${index}`}
                    type="email"
                    inputMode="email"
                    value={row.email}
                    onChange={(event) =>
                      setRows((current) =>
                        current.map((item, i) =>
                          i === index
                            ? { ...item, email: event.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                </div>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setRows((current) => [...current, { name: '', email: '' }])
              }
            >
              {t('candidates:invite.add')}
            </Button>
          </TabsContent>

          <TabsContent value="bulk" className="space-y-3 pt-4">
            <div className="space-y-1.5">
              <Label htmlFor="invite-bulk">
                {t('candidates:invite.bulkLabel')}
              </Label>
              <Textarea
                id="invite-bulk"
                rows={8}
                className="font-mono text-sm"
                placeholder={t('candidates:invite.bulkPlaceholder')}
                value={pasted}
                onChange={(event) => setPasted(event.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                {t('candidates:invite.bulkHint')}
              </p>
            </div>

            {parsed.candidates.length > 0 && (
              <p className="text-success-strong text-sm tabular-nums">
                {t('candidates:invite.parsed', {
                  count: parsed.candidates.length,
                })}
              </p>
            )}
            {parsed.invalid.length > 0 && (
              <Alert variant="destructive">
                <AlertDescription className="space-y-1">
                  <p>
                    {t('candidates:invite.invalid', {
                      count: parsed.invalid.length,
                    })}
                  </p>
                  <ul className="list-disc pl-4 font-mono text-xs">
                    {parsed.invalid.slice(0, 5).map((entry) => (
                      <li key={entry.line}>{entry.line}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('candidates:invite.cancel')}
          </Button>
          <Button
            onClick={() => void send()}
            disabled={sending || candidates.length === 0}
          >
            {sending
              ? t('candidates:invite.sending')
              : t('candidates:invite.send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
