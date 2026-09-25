import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { Logo } from '~/components/Logo'
import { LanguageSwitcher } from '~/components/i18n/LanguageSwitcher'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card'

// Auth actions and fields are 44px tall on touch screens, the default size
// from `sm` up.
export const AUTH_CONTROL = 'h-11 sm:h-9'

type Props = {
  title: ReactNode
  description?: ReactNode
  /** Card body — typically the `<form>` with CardContent + CardFooter. */
  children: ReactNode
}

/**
 * Shared auth page shell modelled on the shadcn `login-03` block: muted
 * full-height background, brand mark above a centered card with a centered
 * header. Used by every sign-in surface so they all look the same. The title
 * is the page's one `<h1>` (CardTitle alone renders a div).
 */
export function AuthShell({ title, description, children }: Props) {
  return (
    <main className="bg-muted relative flex min-h-svh flex-col items-center justify-center p-4 sm:p-6 md:p-10">
      <div className="absolute top-3 right-3 sm:top-4 sm:right-4">
        <LanguageSwitcher />
      </div>
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Link
          to="/"
          aria-label="interw"
          className="flex items-center justify-center"
        >
          <Logo />
        </Link>
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-lg text-balance">
              <h1>{title}</h1>
            </CardTitle>
            {description && (
              <CardDescription className="text-pretty">
                {description}
              </CardDescription>
            )}
          </CardHeader>
          {children}
        </Card>
      </div>
    </main>
  )
}
