import { CandidateShell } from './CandidateShell'
import type { ReactNode } from 'react'


/**
 * A dead end, explained. Every one of these says what happened and what the
 * candidate can do about it — "reply to the email that invited you" is a real
 * action, "an error occurred" is not.
 */
export function CandidateNotice({
  organisationName,
  title,
  body,
  action,
}: {
  organisationName?: string
  title: string
  body: string
  action?: ReactNode
}) {
  return (
    <CandidateShell organisationName={organisationName}>
      <div className="space-y-4 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-muted-foreground max-w-prose leading-relaxed">
          {body}
        </p>
        {action}
      </div>
    </CandidateShell>
  )
}
