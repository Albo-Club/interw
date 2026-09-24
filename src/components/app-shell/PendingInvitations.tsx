import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useConvexMutation, useConvexQuery } from '@convex-dev/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { MailPlus } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'
import { convexErrorCode } from '~/lib/convex-errors'
import { Button } from '~/components/ui/button'
import { Spinner } from '~/components/ui/spinner'
import { cn } from '~/lib/utils'

type Invitation = NonNullable<
  ReturnType<typeof useConvexQuery<typeof api.invitations.listMine>>
>[number]

/**
 * Invitations addressed to the signed-in user, for someone who signed up
 * without clicking the link: offered on onboarding and as a banner in the
 * app, so they join the organisation instead of creating a duplicate.
 */
export function PendingInvitations({
  variant,
}: {
  variant: 'onboarding' | 'banner'
}) {
  const invitations = useConvexQuery(api.invitations.listMine, {})
  // The query cannot watch the clock (see `listMine`), so expiry is read here.
  const open = invitations?.filter((i) => i.expiresAt > Date.now()) ?? []
  if (open.length === 0) return null
  return (
    <ul
      className={cn(
        'flex flex-col',
        variant === 'banner' ? 'border-b' : 'gap-2',
      )}
    >
      {open.map((inv) => (
        <InvitationRow key={inv._id} inv={inv} variant={variant} />
      ))}
    </ul>
  )
}

function InvitationRow({
  inv,
  variant,
}: {
  inv: Invitation
  variant: 'onboarding' | 'banner'
}) {
  const { t } = useTranslation(['nav', 'auth', 'common'])
  const navigate = useNavigate()
  const accept = useConvexMutation(api.invitations.acceptById)
  const [joining, setJoining] = useState(false)
  const role = t(`common:roles.${inv.role}`)

  async function join(invitationId: Id<'invitations'>) {
    setJoining(true)
    try {
      const result = await accept({ invitationId })
      toast.success(
        t('auth:acceptInvite.welcome', {
          orgName: result.orgName,
          role: t(`common:roles.${result.role}`),
        }),
      )
      navigate({ to: '/app/$orgSlug', params: { orgSlug: result.orgSlug } })
    } catch (err) {
      const code = convexErrorCode(err)
      toast.error(
        t(
          code === 'expired'
            ? 'nav:pendingInvitations.expired'
            : 'nav:pendingInvitations.failed',
        ),
      )
      setJoining(false)
    }
  }

  return (
    <li
      className={cn(
        'flex flex-col gap-3',
        variant === 'banner'
          ? 'bg-muted/50 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between'
          : 'bg-card rounded-lg border p-4',
      )}
    >
      <p className="flex min-w-0 items-start gap-2 text-sm">
        <MailPlus
          className="text-muted-foreground mt-0.5 size-4 shrink-0"
          aria-hidden="true"
        />
        <span className="min-w-0 break-words">
          {inv.inviterName ? (
            <Trans
              t={t}
              i18nKey="auth:acceptInvite.summary"
              values={{ inviter: inv.inviterName, orgName: inv.orgName, role }}
            />
          ) : (
            <Trans
              t={t}
              i18nKey="auth:acceptInvite.summaryNoInviter"
              values={{ orgName: inv.orgName, role }}
            />
          )}
        </span>
      </p>
      <Button
        size="sm"
        className={cn(
          'shrink-0',
          variant === 'banner' ? 'self-start sm:self-auto' : 'w-full',
        )}
        disabled={joining}
        onClick={() => void join(inv._id)}
      >
        {joining && <Spinner />}
        {t('nav:pendingInvitations.join', { orgName: inv.orgName })}
      </Button>
    </li>
  )
}
