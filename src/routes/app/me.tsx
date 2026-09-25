import { useEffect, useMemo, useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { Trans, useTranslation } from 'react-i18next'
import { z } from 'zod'
import { toast } from 'sonner'
import { ConvexError } from 'convex/values'
import { useConvexMutation, useConvexQuery } from '@convex-dev/react-query'
import { MailCheck } from 'lucide-react'

import { api } from '../../../convex/_generated/api'
import { authClient } from '~/lib/auth-client'
import { getI18n } from '~/lib/i18n'
import { getLocale } from '~/lib/locale'
import { classifyAuthError, formatAuthError } from '~/lib/auth-errors'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '~/components/ui/tabs'
import { ActiveSessions } from '~/components/auth/active-sessions'
import {
  LinkedAccounts,
  useLinkedAccounts,
} from '~/components/auth/linked-accounts'
import { PasswordSettings } from '~/components/auth/password-settings'

const TABS = ['profile', 'security', 'sessions'] as const
type Tab = (typeof TABS)[number]

// Every link Better Auth sends expires after an hour (convex/auth.ts).
const LINK_TTL_MS = 60 * 60 * 1000

const searchSchema = z.object({
  // Deep-linkable tab: the password-changed email points at `sessions`.
  tab: z.enum(TABS).optional().catch(undefined),
  // Set on the return URL of a flow that leaves the page; Better Auth adds
  // `error` when the link or the provider failed.
  from: z.enum(['email-change', 'google-link']).optional().catch(undefined),
  error: z.string().optional().catch(undefined),
})

export const Route = createFileRoute('/app/me')({
  component: ProfilePage,
  validateSearch: searchSchema,
  head: () => ({
    meta: [
      {
        title: `${getI18n(getLocale()).getFixedT(null, 'account')('page.title')} — interw`,
      },
    ],
  }),
})

function ProfilePage() {
  const { t } = useTranslation(['account', 'validation', 'errors', 'common'])
  const te = (k: string) => t(`errors:${k}`)
  const search = Route.useSearch()
  const profileSchema = useMemo(
    () =>
      z.object({
        name: z
          .string()
          .min(1, t('validation:name.required'))
          .max(80, t('validation:name.tooLong')),
      }),
    [t],
  )
  const emailSchema = useMemo(
    () => z.object({ newEmail: z.email(t('validation:email.invalid')) }),
    [t],
  )
  const navigate = useNavigate()
  const me = useConvexQuery(api.users.me)
  const emailChange = useConvexQuery(api.users.emailChangeStatus)
  const deletionBlockers = useConvexQuery(api.users.accountDeletionBlockers)
  const { accounts, failed: accountsFailed, refresh: refreshAccounts } =
    useLinkedAccounts()
  const updateProfile = useConvexMutation(api.users.updateProfile)
  const [savingProfile, setSavingProfile] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  // Read once: whether a pending email change's link has expired only needs
  // to be right when the page opens.
  const [openedAt] = useState(() => Date.now())

  const setMyAvatar = useConvexMutation(api.files.setMyAvatar)
  const removeMyAvatar = useConvexMutation(api.files.removeMyAvatar)
  const [savingEmail, setSavingEmail] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const profileForm = useForm({
    defaultValues: { name: '' },
    validators: { onChange: profileSchema, onSubmit: profileSchema },
    onSubmit: async ({ value }) => {
      setSavingProfile(true)
      try {
        await updateProfile({ name: value.name })
        await authClient.updateUser({ name: value.name })
        toast.success(t('account:profile.updated'))
      } catch (err) {
        const code = err instanceof ConvexError ? (err.data as string) : ''
        toast.error(
          code === 'invalid_name'
            ? t('account:profile.invalidName')
            : t('account:profile.couldNotSave'),
        )
      } finally {
        setSavingProfile(false)
      }
    },
  })

  const emailForm = useForm({
    defaultValues: { newEmail: '' },
    validators: { onChange: emailSchema, onSubmit: emailSchema },
    onSubmit: async ({ value, formApi }) => {
      if (me?.kind !== 'ready') return
      if (value.newEmail.toLowerCase() === me.user.email.toLowerCase()) {
        toast.error(t('account:email.alreadyYours'))
        return
      }
      setSavingEmail(true)
      // Both links (approval, then confirmation) come back here; the
      // `emailChangeStatus` query tells which step just completed.
      const { error } = await authClient.changeEmail({
        newEmail: value.newEmail,
        callbackURL: '/app/me?tab=profile&from=email-change',
      })
      setSavingEmail(false)
      if (error) {
        toast.error(formatAuthError(classifyAuthError(error), 'change', te))
        return
      }
      toast.success(
        t('account:email.confirmationSent', { email: me.user.email }),
      )
      formApi.reset()
    },
  })

  useEffect(() => {
    if (me?.kind === 'ready') {
      profileForm.reset({ name: me.user.name ?? '' })
    }
  }, [me, profileForm])

  // Landing from an emailed link or a provider: say what just happened, then
  // drop the one-shot params so a reload does not say it again.
  useEffect(() => {
    if (!search.from) return
    if (search.error) {
      toast.error(
        search.from === 'email-change'
          ? t('account:email.linkFailed')
          : t('account:linked.connectFailed'),
        { id: search.from },
      )
    } else if (search.from === 'email-change') {
      if (emailChange === undefined) return
      if (emailChange?.step === 'verify') {
        toast.success(
          t('account:email.approved', { email: emailChange.newEmail }),
          { id: search.from },
        )
      } else if (emailChange?.step === 'done') {
        toast.success(
          t('account:email.changed', { email: emailChange.newEmail }),
          { id: search.from },
        )
      }
    }
    void navigate({ to: '/app/me', search: { tab: search.tab }, replace: true })
  }, [search.from, search.error, search.tab, emailChange, navigate, t])

  if (!me || me.kind !== 'ready') {
    return (
      <main className="mx-auto max-w-2xl space-y-6 p-6">
        <header className="flex items-center justify-between">
          <div className="space-y-2">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-4 w-56" />
          </div>
          <Skeleton className="h-9 w-20" />
        </header>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-48 w-full rounded-xl" />
        ))}
      </main>
    )
  }

  async function handleSignOut() {
    setSigningOut(true)
    await authClient.signOut()
    navigate({ to: '/login' })
  }

  async function handleDelete() {
    if (me?.kind !== 'ready') return
    setDeleting(true)
    // The link lands on /account-deletion whatever happens — deleted, or
    // opened where nobody is signed in (see convex/lib/accountLifecycle.ts).
    const { error } = await authClient.deleteUser({
      callbackURL: '/account-deletion?status=deleted',
    })
    setDeleting(false)
    if (error) {
      toast.error(formatAuthError(classifyAuthError(error), 'change', te))
      return
    }
    toast.success(t('account:danger.confirmationSent', { email: me.user.email }))
    setConfirmDelete(false)
  }

  const backTo = me.user.lastOrgSlug ?? null
  const pendingEmailChange =
    emailChange &&
    emailChange.step !== 'done' &&
    openedAt - emailChange.at < LINK_TTL_MS
      ? emailChange
      : null
  // Unknown after a failed load: default to the form that cannot lock anyone
  // out — "change" asks for the current password, "set" would be refused.
  const hasPassword = accounts
    ? accounts.some((a) => a.providerId === 'credential')
    : accountsFailed
      ? true
      : undefined
  const deletionBlocked =
    deletionBlockers === undefined || deletionBlockers.length > 0

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('account:page.title')}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t('account:page.subtitle')}
          </p>
        </div>
        {backTo ? (
          <Button asChild variant="outline">
            <Link to="/app/$orgSlug" params={{ orgSlug: backTo }}>
              {t('account:page.back')}
            </Link>
          </Button>
        ) : (
          <Button asChild variant="outline">
            <Link to="/app">{t('account:page.back')}</Link>
          </Button>
        )}
      </header>

      <Tabs
        value={search.tab ?? 'profile'}
        onValueChange={(tab) =>
          void navigate({
            to: '/app/me',
            search: { tab: tab as Tab },
            replace: true,
          })
        }
        className="space-y-6"
      >
        <TabsList>
          <TabsTrigger value="profile">
            {t('account:page.tabs.profile')}
          </TabsTrigger>
          <TabsTrigger value="security">
            {t('account:page.tabs.security')}
          </TabsTrigger>
          <TabsTrigger value="sessions">
            {t('account:page.tabs.sessions')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('account:profile.title')}</CardTitle>
          <CardDescription>{t('account:profile.description')}</CardDescription>
        </CardHeader>
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault()
            e.stopPropagation()
            void profileForm.handleSubmit()
          }}
        >
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel>{t('account:profile.avatar')}</FieldLabel>
                <ImageUpload
                  currentUrl={me.user.avatarUrl}
                  shape="circle"
                  onPicked={async (storageId) => {
                    await setMyAvatar({ storageId })
                  }}
                  onRemove={async () => {
                    await removeMyAvatar({})
                  }}
                />
                <FieldDescription>
                  {t('account:profile.avatarHint')}
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="email">
                  {t('account:profile.email')}
                </FieldLabel>
                <Input id="email" value={me.user.email} disabled />
              </Field>

              <profileForm.Field name="name">
                {(field) => {
                  const invalid =
                    field.state.meta.isTouched && !field.state.meta.isValid
                  return (
                    <Field data-invalid={invalid || undefined}>
                      <FieldLabel htmlFor={field.name}>
                        {t('account:profile.name')}
                      </FieldLabel>
                      <Input
                        id={field.name}
                        name={field.name}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => field.handleChange(e.target.value)}
                        aria-invalid={invalid || undefined}
                      />
                      {invalid && (
                        <FieldError errors={field.state.meta.errors} />
                      )}
                    </Field>
                  )
                }}
              </profileForm.Field>

              <Button type="submit" disabled={savingProfile}>
                {savingProfile && <Spinner />}
                {t('account:profile.save')}
              </Button>
            </FieldGroup>
          </CardContent>
        </form>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('account:email.title')}</CardTitle>
          <CardDescription>{t('account:email.description')}</CardDescription>
        </CardHeader>
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault()
            e.stopPropagation()
            void emailForm.handleSubmit()
          }}
        >
          <CardContent>
            <FieldGroup>
              {pendingEmailChange && (
                <Alert>
                  <MailCheck aria-hidden="true" />
                  <AlertTitle>{t('account:email.pendingTitle')}</AlertTitle>
                  <AlertDescription>
                    <p>
                      <Trans
                        t={t}
                        i18nKey={
                          pendingEmailChange.step === 'approve'
                            ? 'account:email.pendingApprove'
                            : 'account:email.pendingVerify'
                        }
                        values={{
                          email: me.user.email,
                          newEmail: pendingEmailChange.newEmail,
                        }}
                      />
                    </p>
                    <p>{t('account:email.pendingExpiry')}</p>
                  </AlertDescription>
                </Alert>
              )}
              <emailForm.Field name="newEmail">
                {(field) => {
                  const invalid =
                    field.state.meta.isTouched && !field.state.meta.isValid
                  return (
                    <Field data-invalid={invalid || undefined}>
                      <FieldLabel htmlFor={field.name}>
                        {t('account:email.newEmail')}
                      </FieldLabel>
                      <Input
                        id={field.name}
                        name={field.name}
                        type="email"
                        autoComplete="email"
                        spellCheck={false}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => field.handleChange(e.target.value)}
                        aria-invalid={invalid || undefined}
                      />
                      <FieldDescription>
                        {t('account:email.hint')}
                      </FieldDescription>
                      {invalid && (
                        <FieldError errors={field.state.meta.errors} />
                      )}
                    </Field>
                  )
                }}
              </emailForm.Field>
              <Button type="submit" disabled={savingEmail}>
                {savingEmail && <Spinner />}
                {t('account:email.send')}
              </Button>
            </FieldGroup>
          </CardContent>
        </form>
      </Card>

        </TabsContent>

        <TabsContent value="security" className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('account:connected.title')}</CardTitle>
          <CardDescription>{t('account:connected.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <LinkedAccounts
            accounts={accounts}
            onChange={() => void refreshAccounts()}
          />
        </CardContent>
      </Card>

      {hasPassword === undefined ? (
        <Skeleton className="h-72 w-full rounded-xl" />
      ) : (
        <PasswordSettings
          key={String(hasPassword)}
          hasPassword={hasPassword}
          userInputs={[me.user.email, me.user.name ?? '']}
          onPasswordSet={() => void refreshAccounts()}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('account:signout.title')}</CardTitle>
          <CardDescription>{t('account:signout.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            onClick={handleSignOut}
            disabled={signingOut}
          >
            {signingOut && <Spinner />}
            {t('account:signout.action')}
          </Button>
        </CardContent>
      </Card>

      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle className="text-destructive">
            {t('account:danger.title')}
          </CardTitle>
          <CardDescription>{t('account:danger.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {deletionBlockers && deletionBlockers.length > 0 && (
            <Alert>
              <AlertTitle>{t('account:danger.blockedTitle')}</AlertTitle>
              <AlertDescription>
                <p>{t('account:danger.blocked')}</p>
                <ul className="list-disc pl-4">
                  {deletionBlockers.map((org) => (
                    <li key={org._id}>
                      <Link
                        to="/app/$orgSlug/settings/members"
                        params={{ orgSlug: org.slug }}
                        aria-label={t('account:danger.manageMembers', {
                          name: org.name,
                        })}
                        className="text-foreground font-medium underline underline-offset-4"
                      >
                        {org.name}
                      </Link>
                      {' · '}
                      <Link
                        to="/app/$orgSlug/settings/general"
                        params={{ orgSlug: org.slug }}
                        aria-label={t('account:danger.deleteOrgLabel', {
                          name: org.name,
                        })}
                        className="text-destructive underline underline-offset-4"
                      >
                        {t('account:danger.deleteOrg')}
                      </Link>
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          <Button
            variant="destructive"
            onClick={() => setConfirmDelete(true)}
            disabled={deleting || deletionBlocked}
          >
            {t('account:danger.action')}
          </Button>
        </CardContent>
      </Card>

        </TabsContent>

        <TabsContent value="sessions" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('account:activeSessions.title')}</CardTitle>
              <CardDescription>
                {t('account:activeSessions.description')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ActiveSessions />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog
        open={confirmDelete}
        onOpenChange={(open) => !open && setConfirmDelete(false)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('account:danger.dialogTitle')}</DialogTitle>
            <DialogDescription>
              <Trans
                t={t}
                i18nKey="account:danger.dialogDescription"
                values={{ email: me.user.email }}
              />
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting && <Spinner />}
              {t('account:danger.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}
