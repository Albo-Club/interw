import { useEffect } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useConvexQuery } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'

export const Route = createFileRoute('/app/')({
  component: AppIndex,
})

function AppIndex() {
  const navigate = useNavigate()
  const me = useConvexQuery(api.users.me)

  useEffect(() => {
    if (me?.kind !== 'ready') return
    const { orgs, user } = me
    const lastOrgSlug = user.lastOrgSlug
    if (orgs.length === 0) {
      navigate({ to: '/app/onboarding' })
      return
    }
    const target =
      (lastOrgSlug && orgs.find((o) => o.slug === lastOrgSlug)?.slug) ??
      orgs[0].slug
    navigate({ to: '/app/$orgSlug', params: { orgSlug: target } })
  }, [me, navigate])

  return null
}
