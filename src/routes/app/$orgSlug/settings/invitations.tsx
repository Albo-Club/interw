import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { Trans, useTranslation } from 'react-i18next'
import { z } from 'zod'
import { toast } from 'sonner'
import { useConvex } from 'convex/react'
import { useConvexMutation, useConvexQuery } from '@convex-dev/react-query'
import { Check, Copy, RotateCw, X } from 'lucide-react'

import { api } from '../../../../../convex/_generated/api'
import type { Id } from '../../../../../convex/_generated/dataModel'
import { convexErrorCode } from '~/lib/convex-errors'
import { MemberName } from '~/components/MemberName'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Spinner } from '~/components/ui/spinner'
import { Textarea } from '~/components/ui/textarea'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '~/components/ui/field'
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
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card'

const KNOWN_INVITE_ERRORS = [
  'already_invited',
  'already_member',
  'invalid_email',
  'insufficient_role',
  'not_a_member',
  'rate_limited',
]

function inviteErrorKey(code: string, fallback: string): string {
  return KNOWN_INVITE_ERRORS.includes(code)
    ? `settings:invitations.errors.${code}`
    : fallback
}

const INVITE_ROLES = ['member', 'admin'] as const
type InviteRole = (typeof INVITE_ROLES)[number]

/** One result line per address; `code` is a server error code or 'not_sent'. */
type InviteResult = { email: string; ok: true } | { email: string; ok: false; code: string }

/** Split a pasted list on commas, semicolons and whitespace; dedupe. */
function parseEmails(raw: string): Array<string> {
  const seen = new Set<string>()
  for (const part of raw.split(/[\s,;]+/)) {
    const email = part.trim().toLowerCase()
    if (email) seen.add(email)
  }
  return [...seen]
}

export const Route = createFileRoute('/app/$orgSlug/settings/invitations')({
  component: InvitationsSettings,
})

function InvitationsSettings() {
  const { t } = useTranslation(['settings', 'validation', 'common'])
  const inviteSchema = useMemo(
    () =>
      z.object({
        emails: z
          .string()
          .refine((raw) => parseEmails(raw).length > 0, {
            message: t('validation:required'),
          })
          .refine(
            (raw) =>
              parseEmails(raw).every((e) => z.email().safeParse(e).success),
            { message: t('settings:invitations.invalidInList') },
          ),
        role: z.enum(INVITE_ROLES),
      }),
    [t],
  )
  const { orgSlug } = Route.useParams()
  const me = useConvexQuery(api.users.me)
  const org = useConvexQuery(api.organizations.bySlug, { slug: orgSlug })
  const role =
    me?.kind === 'ready'
      ? me.orgs.find((o) => o.slug === orgSlug)?.role
      : undefined
  const canInvite = role === 'admin' || role === 'owner'
  const pending = useConvexQuery(
    api.invitations.listForOrg,
    org && canInvite ? { orgId: org._id } : 'skip',
  )
  const createInvite = useConvexMutation(api.invitations.create)
  const [results, setResults] = useState<Array<InviteResult>>([])

  const form = useForm({
    defaultValues: { emails: '', role: 'member' as InviteRole },
    validators: { onChange: inviteSchema, onSubmit: inviteSchema },
    onSubmit: async ({ value, formApi }) => {
      if (!org) return
      const emails = parseEmails(value.emails)
      const out: Array<InviteResult> = []
      // One call per address, so each gets its own answer and the server's
      // validation and rate limit apply to every one of them. Once the limit
      // is hit, the rest would only be refused too: stop and say so.
      let limited = false
      for (const email of emails) {
        if (limited) {
          out.push({ email, ok: false, code: 'not_sent' })
          continue
        }
        try {
          await createInvite({ orgId: org._id, email, role: value.role })
          out.push({ email, ok: true })
        } catch (err) {
          const code = convexErrorCode(err) ?? 'default'
          limited = code === 'rate_limited'
          out.push({ email, ok: false, code })
        }
      }
      setResults(out)
      const sent = out.filter((r) => r.ok).length
      if (sent > 0) {
        toast.success(t('settings:invitations.sentCount', { count: sent }))
      }
      if (sent === out.length) {
        formApi.reset()
      } else {
        // Keep only what still needs attention in the box.
        formApi.setFieldValue(
          'emails',
          out
            .filter((r) => !r.ok)
            .map((r) => r.email)
            .join('\n'),
        )
      }
    },
  })

  if (!canInvite) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('settings:invitations.noAccessTitle')}</CardTitle>
          <CardDescription>
            {t('settings:invitations.noAccessDescription')}
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('settings:invitations.inviteTitle')}</CardTitle>
          <CardDescription>
            {t('settings:invitations.inviteDescription')}
          </CardDescription>
        </CardHeader>
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault()
            e.stopPropagation()
            void form.handleSubmit()
          }}
        >
          <CardContent>
            <FieldGroup>
              <form.Field name="emails">
                {(field) => {
                  const invalid =
                    field.state.meta.isTouched && !field.state.meta.isValid
                  return (
                    <Field data-invalid={invalid || undefined}>
                      <FieldLabel htmlFor={field.name}>
                        {t('settings:invitations.emails')}
                      </FieldLabel>
                      <Textarea
                        id={field.name}
                        name={field.name}
                        rows={3}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={t('settings:invitations.emailsPlaceholder')}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => field.handleChange(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault()
                            void form.handleSubmit()
                          }
                        }}
                        aria-invalid={invalid || undefined}
                      />
                      <FieldDescription>
                        {t('settings:invitations.emailsHint')}
                      </FieldDescription>
                      {invalid && (
                        <FieldError errors={field.state.meta.errors} />
                      )}
                    </Field>
                  )
                }}
              </form.Field>
              <form.Field name="role">
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor={field.name}>
                      {t('settings:invitations.role')}
                    </FieldLabel>
                    <Select
                      value={field.state.value}
                      onValueChange={(v) => field.handleChange(v as InviteRole)}
                    >
                      <SelectTrigger id={field.name} className="w-full sm:w-56">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {INVITE_ROLES.map((r) => (
                          <SelectItem key={r} value={r}>
                            {t(`common:roles.${r}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      {t(`settings:invitations.roleDescriptions.${field.state.value}`)}
                    </FieldDescription>
                  </Field>
                )}
              </form.Field>
              <form.Subscribe selector={(s) => s.isSubmitting}>
                {(isSubmitting) => (
                  <Button
                    type="submit"
                    className="self-start"
                    disabled={isSubmitting}
                  >
                    {isSubmitting && <Spinner />}
                    {t('settings:invitations.send')}
                  </Button>
                )}
              </form.Subscribe>
              {results.length > 0 && <InviteResults results={results} />}
            </FieldGroup>
          </CardContent>
        </form>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings:invitations.pendingTitle')}</CardTitle>
          <CardDescription>
            {t('settings:invitations.pendingDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!pending ? (
            <p className="text-muted-foreground text-sm">
              {t('settings:invitations.loading')}
            </p>
          ) : pending.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t('settings:invitations.empty')}
            </p>
          ) : (
            <ul className="divide-border divide-y text-sm">
              {pending.map((inv) => (
                <PendingRow key={inv._id} inv={inv} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function InviteResults({ results }: { results: Array<InviteResult> }) {
  const { t } = useTranslation('settings')
  return (
    <ul className="space-y-1.5 text-sm" aria-live="polite">
      {results.map((r) => (
        <li key={r.email} className="flex items-start gap-2">
          {r.ok ? (
            <Check className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
          ) : (
            <X className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden="true" />
          )}
          <p className="min-w-0 break-words">
            <span className="font-medium">{r.email}</span>{' '}
            <span
              className={r.ok ? 'text-muted-foreground' : 'text-destructive'}
            >
              {r.ok
                ? t('invitations.resultSent')
                : r.code === 'not_sent'
                  ? t('invitations.resultNotSent')
                  : t(
                      inviteErrorKey(
                        r.code,
                        'settings:invitations.errors.default',
                      ),
                    )}
            </span>
          </p>
        </li>
      ))}
    </ul>
  )
}

type PendingInvitation = NonNullable<
  ReturnType<typeof useConvexQuery<typeof api.invitations.listForOrg>>
>[number]

const UNDELIVERED = ['bounced', 'complained', 'failed']

function PendingRow({ inv }: { inv: PendingInvitation }) {
  const { t, i18n } = useTranslation(['settings', 'common'])
  const convex = useConvex()
  const resend = useConvexMutation(api.invitations.resendInvitation)
  const [busy, setBusy] = useState<'resend' | 'copy' | null>(null)
  const { format: date } = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
  })
  const expired = inv.expiresAt < Date.now()
  const undelivered =
    inv.deliveryStatus !== null && UNDELIVERED.includes(inv.deliveryStatus)

  async function handleResend() {
    setBusy('resend')
    try {
      await resend({ invitationId: inv._id })
      toast.success(t('settings:invitations.resent', { email: inv.email }))
    } catch (err) {
      toast.error(
        t(
          inviteErrorKey(
            convexErrorCode(err) ?? '',
            'settings:invitations.resendFailed',
          ),
        ),
      )
    } finally {
      setBusy(null)
    }
  }

  async function handleCopy() {
    setBusy('copy')
    try {
      const { url } = await convex.query(api.invitations.link, {
        invitationId: inv._id,
      })
      await navigator.clipboard.writeText(url)
      toast.success(t('settings:invitations.linkCopied'))
    } catch {
      toast.error(t('settings:invitations.copyFailed'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <li className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 break-words font-medium">{inv.email}</span>
          <Badge variant="secondary">{t(`common:roles.${inv.role}`)}</Badge>
          {expired && (
            <Badge variant="outline">{t('settings:invitations.expired')}</Badge>
          )}
        </p>
        <p className="text-muted-foreground flex flex-wrap gap-x-3 text-xs">
          <span>
            <Trans
              t={t}
              i18nKey="settings:invitations.sentBy"
              values={{ date: date(inv.sentAt) }}
              components={{ name: <MemberName member={inv.invitedBy} /> }}
            />
          </span>
          <span>
            {t(
              expired
                ? 'settings:invitations.expiredOn'
                : 'settings:invitations.expiresOn',
              { date: date(inv.expiresAt) },
            )}
          </span>
        </p>
        {undelivered && (
          <p className="text-destructive text-xs" role="status">
            {t(`settings:invitations.delivery.${inv.deliveryStatus}`)}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap gap-1">
        {!expired && (
          <Button
            size="sm"
            variant="ghost"
            onClick={handleCopy}
            disabled={busy !== null}
          >
            {busy === 'copy' ? <Spinner /> : <Copy aria-hidden="true" />}
            {t('settings:invitations.copyLink')}
          </Button>
        )}
        <Button
          size="sm"
          variant={expired || undelivered ? 'outline' : 'ghost'}
          onClick={handleResend}
          disabled={busy !== null}
        >
          {busy === 'resend' ? <Spinner /> : <RotateCw aria-hidden="true" />}
          {t('settings:invitations.resend')}
        </Button>
        <RevokeButton invitationId={inv._id} email={inv.email} />
      </div>
    </li>
  )
}

function RevokeButton({
  invitationId,
  email,
}: {
  invitationId: Id<'invitations'>
  email: string
}) {
  const { t } = useTranslation(['settings', 'common'])
  const revoke = useConvexMutation(api.invitations.revoke)
  const [open, setOpen] = useState(false)
  const [revoking, setRevoking] = useState(false)

  async function handleRevoke() {
    setRevoking(true)
    try {
      await revoke({ invitationId })
      toast.success(t('settings:invitations.revoked'))
      setOpen(false)
    } catch {
      toast.error(t('settings:invitations.revokeFailed'))
    } finally {
      setRevoking(false)
    }
  }

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {t('settings:invitations.revoke')}
      </Button>
      <AlertDialog open={open} onOpenChange={(o) => !revoking && setOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('settings:invitations.revokeTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans
                t={t}
                i18nKey="settings:invitations.revokeDescription"
                values={{ email }}
              />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>
              {t('common:actions.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={revoking}
              onClick={(e) => {
                // Stay open until the server answers, so the spinner shows.
                e.preventDefault()
                void handleRevoke()
              }}
            >
              {revoking && <Spinner />}
              {t('settings:invitations.revokeConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
