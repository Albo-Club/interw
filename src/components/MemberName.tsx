import { useTranslation } from 'react-i18next'

import type { MemberName as MemberNameView } from '../../convex/lib/memberName'

/**
 * A colleague credited with some work. Someone no longer in the organisation
 * keeps the credit, greyed and marked — in words too, not by colour alone.
 */
export function MemberName({ member }: { member: MemberNameView }) {
  const { t } = useTranslation('common')
  if (!member.removed) return <>{member.name}</>
  return (
    <span className="text-muted-foreground italic">
      {member.name === null
        ? t('common:member.former')
        : t('common:member.removed', { name: member.name })}
    </span>
  )
}
