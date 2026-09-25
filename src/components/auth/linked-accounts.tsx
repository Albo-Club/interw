import { useCallback, useEffect, useState } from 'react'
import { KeyRound } from 'lucide-react'
import { useConvexQuery } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '../../../convex/_generated/api'
import type { ReactNode } from 'react'

import { authClient } from '~/lib/auth-client'
import { classifyAuthError, formatAuthError } from '~/lib/auth-errors'
import { Button } from '~/components/ui/button'
import { Skeleton } from '~/components/ui/skeleton'
import { Spinner } from '~/components/ui/spinner'
import { GoogleIcon } from '~/components/auth/social-auth-buttons'

export type LinkedAccount = { id: string; providerId: string }

/**
 * The caller's Better Auth accounts — one per way to sign in (`credential`
 * for a password, `google`…). `accounts` is null while loading and after a
 * failed load, which `failed` tells apart.
 */
export function useLinkedAccounts() {
  const { t } = useTranslation('errors')
  const [accounts, setAccounts] = useState<Array<LinkedAccount> | null>(null)
  const [failed, setFailed] = useState(false)

  const refresh = useCallback(async () => {
    const { data, error } = await authClient.listAccounts()
    if (error) {
      toast.error(
        formatAuthError(classifyAuthError(error), 'signin', (k) =>
          t(`errors:${k}`),
        ),
      )
      setFailed(true)
      return
    }
    setFailed(false)
    setAccounts(data)
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { accounts, failed, refresh }
}

type Props = {
  accounts: Array<LinkedAccount> | null
  onChange: () => void
}

/**
 * The sign-in methods on this account, as they really are: a password row,
 * and a Google row when Google is configured or already linked. Better Auth
 * refuses to unlink the last account, so neither does this list.
 */
export function LinkedAccounts({ accounts, onChange }: Props) {
  const { t } = useTranslation(['account', 'errors'])
  const providers = useConvexQuery(api.publicConfig.enabledSocialProviders, {})
  const [busy, setBusy] = useState(false)

  if (!accounts || providers === undefined) {
    return <Skeleton className="h-32 w-full rounded-md" />
  }

  const google = accounts.find((a) => a.providerId === 'google')
  const onlyMethod = accounts.length <= 1

  async function connectGoogle() {
    setBusy(true)
    // Leaves the page on success; Better Auth comes back to one of these.
    const { error } = await authClient.linkSocial({
      provider: 'google',
      callbackURL: '/app/me?tab=security',
      errorCallbackURL: '/app/me?tab=security&from=google-link',
    })
    if (error) {
      setBusy(false)
      toast.error(t('account:linked.connectFailed'))
    }
  }

  async function disconnectGoogle() {
    setBusy(true)
    const { error } = await authClient.unlinkAccount({ providerId: 'google' })
    setBusy(false)
    if (error) {
      const code = classifyAuthError(error)
      toast.error(
        code === 'SESSION_EXPIRED'
          ? t('account:linked.reauth')
          : formatAuthError(code, 'change', (k) => t(`errors:${k}`)),
      )
      return
    }
    toast.success(t('account:linked.disconnected'))
    onChange()
  }

  return (
    <ul className="divide-border divide-y rounded-md border">
      <MethodRow
        icon={<KeyRound className="text-muted-foreground size-5" />}
        label={t('account:linked.password')}
        status={
          accounts.some((a) => a.providerId === 'credential')
            ? t('account:linked.connected')
            : t('account:linked.notSet')
        }
      />
      {(providers.google || google) && (
        <MethodRow
          icon={<GoogleIcon />}
          label={t('account:linked.google')}
          status={
            google
              ? onlyMethod
                ? t('account:linked.onlyMethod')
                : t('account:linked.connected')
              : t('account:linked.notConnected')
          }
          action={
            google ? (
              <Button
                variant="outline"
                size="sm"
                onClick={disconnectGoogle}
                disabled={busy || onlyMethod}
              >
                {busy && <Spinner />}
                {t('account:linked.disconnect')}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={connectGoogle}
                disabled={busy}
              >
                {busy && <Spinner />}
                {t('account:linked.connect')}
              </Button>
            )
          }
        />
      )}
    </ul>
  )
}

function MethodRow({
  icon,
  label,
  status,
  action,
}: {
  icon: ReactNode
  label: string
  status: string
  action?: ReactNode
}) {
  return (
    <li className="flex items-center gap-4 p-4">
      <span className="flex size-5 shrink-0 items-center justify-center">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{label}</p>
        <p className="text-muted-foreground text-xs">{status}</p>
      </div>
      {action}
    </li>
  )
}
