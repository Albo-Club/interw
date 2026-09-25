import type { LucideIcon } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'

export function KpiCard({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string
  value: string | number
  hint?: string
  icon?: LucideIcon
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-muted-foreground text-sm font-medium">
          {label}
        </CardTitle>
        {Icon ? (
          <Icon aria-hidden className="text-muted-foreground size-4" />
        ) : null}
      </CardHeader>
      <CardContent>
        {/* The four cards form one row of figures: tabular digits keep them
            aligned across cards. */}
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {hint ? (
          <p className="text-muted-foreground mt-1 text-xs">{hint}</p>
        ) : null}
      </CardContent>
    </Card>
  )
}
