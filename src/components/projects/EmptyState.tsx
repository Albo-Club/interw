import type { ReactNode } from 'react'

/**
 * A designed empty state: what you are looking at, why it is empty, and the
 * one thing to do about it. A blank panel makes a new user think the product
 * is broken.
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode
  title: string
  body: string
  action?: ReactNode
}) {
  return (
    <div className="border-border flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-14 text-center">
      {icon && <div className="text-muted-foreground">{icon}</div>}
      <div className="space-y-1">
        <h3 className="font-medium">{title}</h3>
        <p className="text-muted-foreground mx-auto max-w-md text-sm">{body}</p>
      </div>
      {action}
    </div>
  )
}
