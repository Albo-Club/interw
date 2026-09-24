import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'

import { cn } from '~/lib/utils'

/**
 * For every button a candidate presses. `lg` is 40 px and `sm` 32 px, and the
 * two smallest used to be "Try again" and "Skip" — the buttons that decide
 * whether an answer is saved. A thumb needs 44 px, and no double-tap zoom.
 */
export const candidateAction = 'min-h-11 touch-manipulation'

/**
 * The frame every candidate screen sits in.
 *
 * Deliberately almost empty: no sidebar, no menu, no navigation of any kind.
 * A candidate is nervous and gets one attempt; anything that invites them to
 * click elsewhere is a way to lose an interview. The only secondary link is
 * the one the law requires — what is held about them.
 */
export function CandidateShell({
  organisationName,
  children,
  privacyToken,
  width = 'narrow',
}: {
  organisationName?: string
  children: ReactNode
  /** Links the footer to this candidate's data page. */
  privacyToken?: string
  width?: 'narrow' | 'wide'
}) {
  const { t } = useTranslation('interview')
  return (
    <div className="bg-background flex min-h-svh flex-col">
      <header className="border-b">
        <div
          className={cn(
            'mx-auto flex h-14 items-center px-4',
            width === 'narrow' ? 'max-w-2xl' : 'max-w-5xl',
          )}
        >
          <span className="text-sm font-semibold tracking-tight">
            {organisationName ?? 'interw'}
          </span>
        </div>
      </header>

      <main
        className={cn(
          'mx-auto w-full flex-1 px-4 py-10',
          width === 'narrow' ? 'max-w-2xl' : 'max-w-5xl',
        )}
      >
        {children}
      </main>

      {privacyToken && (
        <footer className="border-t">
          <div
            className={cn(
              'text-muted-foreground mx-auto px-4 py-6 text-xs',
              width === 'narrow' ? 'max-w-2xl' : 'max-w-5xl',
            )}
          >
            <Link
              to="/s/$token/privacy"
              params={{ token: privacyToken }}
              className="underline underline-offset-4"
            >
              {t('shell.privacy')}
            </Link>
          </div>
        </footer>
      )}
    </div>
  )
}
