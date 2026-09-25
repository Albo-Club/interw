import { useEffect, useMemo, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { Trans, useTranslation } from 'react-i18next'
import { z } from 'zod'
import { toast } from 'sonner'
import { ConvexError } from 'convex/values'
import { useConvexMutation, useConvexQuery } from '@convex-dev/react-query'

import { api } from '../../../../../convex/_generated/api'
import type { Id } from '../../../../../convex/_generated/dataModel'
import { errorMessageKey } from '~/lib/convex-errors'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Skeleton } from '~/components/ui/skeleton'
import { Spinner } from '~/components/ui/spinner'
import { ImageUpload } from '~/components/ImageUpload'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '~/components/ui/field'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'

export const Route = createFileRoute('/app/$orgSlug/settings/general')({
  component: GeneralSettings,
})

function GeneralSettings() {
  const { t } = useTranslation(['settings', 'validation', 'common'])
  const schema = useMemo(
    () =>
      z.object({
        name: z
          .string()
          .min(1, t('validation:name.required'))
          .max(80, t('validation:name.tooLong')),
      }),
    [t],
  )
  const { orgSlug } = Route.useParams()
  const me = useConvexQuery(api.users.me)
  const org = useConvexQuery(api.organizations.bySlug, { slug: orgSlug })
  const update = useConvexMutation(api.organizations.updateGeneral)
  const setOrgLogo = useConvexMutation(api.files.setOrgLogo)
  const removeOrgLogo = useConvexMutation(api.files.removeOrgLogo)
  const [saving, setSaving] = useState(false)

  const role =
    me?.kind === 'ready'
      ? me.orgs.find((o) => o.slug === orgSlug)?.role
      : undefined
  const canManage = role === 'admin' || role === 'owner'

  const form = useForm({
    defaultValues: { name: '' },
    validators: { onChange: schema, onSubmit: schema },
    onSubmit: async ({ value }) => {
      if (!org) return
      setSaving(true)
      try {
        await update({ orgId: org._id, name: value.name })
        toast.success(t('settings:general.updated'))
      } catch (err) {
        const code = err instanceof ConvexError ? (err.data as string) : ''
        toast.error(
          code === 'insufficient_role'
            ? t('settings:general.errors.insufficient_role')
            : code === 'invalid_name'
              ? t('settings:general.errors.invalid_name')
              : t('settings:general.errors.default'),
        )
      } finally {
        setSaving(false)
      }
    },
  })

  useEffect(() => {
    if (org) {
      form.reset({ name: org.name })
    }
  }, [org, form])

  if (!org) {
    return (
      <p className="text-muted-foreground text-sm">
        {t('settings:general.loading')}
      </p>
    )
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('settings:general.title')}</CardTitle>
          <CardDescription>{t('settings:general.description')}</CardDescription>
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
              <form.Field name="name">
                {(field) => {
                  const invalid =
                    field.state.meta.isTouched && !field.state.meta.isValid
                  return (
                    <Field data-invalid={invalid || undefined}>
                      <FieldLabel htmlFor={field.name}>
                        {t('settings:general.name')}
                      </FieldLabel>
                      <Input
                        id={field.name}
                        name={field.name}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => field.handleChange(e.target.value)}
                        disabled={!canManage}
                        aria-invalid={invalid || undefined}
                      />
                      {invalid && <FieldError errors={field.state.meta.errors} />}
                    </Field>
                  )
                }}
              </form.Field>

              <Field>
                <FieldLabel htmlFor="slug">
                  {t('settings:general.slug')}
                </FieldLabel>
                <Input id="slug" value={org.slug} disabled />
                <FieldDescription>
                  {t('settings:general.slugHint')}
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel>{t('settings:general.logo')}</FieldLabel>
                <ImageUpload
                  currentUrl={org.logoUrl ?? null}
                  onPicked={async (storageId) => {
                    await setOrgLogo({ orgId: org._id, storageId })
                  }}
                  onRemove={async () => {
                    await removeOrgLogo({ orgId: org._id })
                  }}
                  disabled={!canManage}
                />
                <FieldDescription>
                  {t('settings:general.logoHint')}
                </FieldDescription>
              </Field>

              {canManage && (
                <Button type="submit" disabled={saving}>
                  {saving
                    ? t('settings:general.saving')
                    : t('settings:general.save')}
                </Button>
              )}
            </FieldGroup>
          </CardContent>
        </form>
      </Card>
      {role === 'owner' && (
        <DeleteOrganization orgId={org._id} name={org.name} />
      )}
    </div>
  )
}

/**
 * Owner-only. The confirmation asks for the organisation's name rather than
 * a click: this erases every candidate, recording and report in it, for good.
 */
function DeleteOrganization({
  orgId,
  name,
}: {
  orgId: Id<'organizations'>
  name: string
}) {
  const { t } = useTranslation(['settings', 'common'])
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [deleting, setDeleting] = useState(false)
  const summary = useConvexQuery(
    api.organizations.deletionSummary,
    // Once requested, the organisation refuses every query, this one included.
    deleting ? 'skip' : { orgId },
  )
  const requestDeletion = useConvexMutation(api.organizations.requestDeletion)
  const matches = typed.trim() === name

  async function handleDelete() {
    setDeleting(true)
    try {
      await requestDeletion({ orgId, confirmName: typed })
      toast.success(t('settings:general.danger.deleted', { name }))
      void navigate({ to: '/app' })
    } catch (error) {
      setDeleting(false)
      const { key, fallbackKey } = errorMessageKey(error, 'settings')
      toast.error(t(key, { defaultValue: t(fallbackKey) }))
    }
  }

  return (
    <Card className="border-destructive/30">
      <CardHeader>
        <CardTitle className="text-destructive">
          {t('settings:general.danger.title')}
        </CardTitle>
        <CardDescription>
          {t('settings:general.danger.description', { name })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {summary ? (
          <ul className="text-muted-foreground list-disc space-y-1 pl-4 text-sm">
            <li>
              {t('settings:general.danger.roles', { count: summary.roles })}
            </li>
            <li>
              {t('settings:general.danger.candidates', {
                count: summary.candidates,
              })}
            </li>
            <li>{t('settings:general.danger.assistant')}</li>
            {summary.pendingInvitations > 0 && (
              <li>
                {t('settings:general.danger.invitations', {
                  count: summary.pendingInvitations,
                })}
              </li>
            )}
            <li>
              {t('settings:general.danger.members', {
                count: summary.members,
              })}
            </li>
          </ul>
        ) : (
          <div className="space-y-2" aria-hidden>
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-4 w-56" />
          </div>
        )}
        <Button
          variant="destructive"
          onClick={() => {
            setTyped('')
            setOpen(true)
          }}
        >
          {t('settings:general.danger.action')}
        </Button>
      </CardContent>

      <AlertDialog
        open={open}
        onOpenChange={(next) => !deleting && setOpen(next)}
      >
        <AlertDialogContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              if (matches && !deleting) void handleDelete()
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('settings:general.danger.dialogTitle', { name })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t('settings:general.danger.dialogDescription')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <Field>
              <FieldLabel htmlFor="confirm-org-name" className="block">
                <Trans
                  t={t}
                  i18nKey="settings:general.danger.confirmLabel"
                  values={{ name }}
                />
              </FieldLabel>
              <Input
                id="confirm-org-name"
                name="confirm-org-name"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={deleting}
              />
            </Field>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>
                {t('common:actions.cancel')}
              </AlertDialogCancel>
              <Button
                type="submit"
                variant="destructive"
                disabled={!matches || deleting}
              >
                {deleting && <Spinner />}
                {t('settings:general.danger.confirm')}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
