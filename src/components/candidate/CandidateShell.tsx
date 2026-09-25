import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'

import { cn } from '~/lib/utils'

/**
 * Every button a candidate presses is at least 44 px tall and ignores
 * double-tap zoom. Set once on the frame rather than button by button: the
 * two smallest buttons on the surface used to be "Try again" and "Skip" — the
 * ones that decide whether an answer is saved. Anything rendered outside the
 * frame, such as a dialog's portal, takes the same class.
 */
export const candidateTouchTargets =
  'touch-manipulation [&_[data-slot=button]]:min-h-11'

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
  logoUrl,
  children,
  privacyToken,
  width = 'narrow',
}: {
  organisationName?: string
  logoUrl?: string | null
  children?: ReactNode
  /** Links the footer to this candidate's data page. */
  privacyToken?: string
  /** `stage` is the interview: exactly one screen tall, never scrolled, so
   *  the video and the one button that ends an answer are always in view. */
  width?: 'narrow' | 'stage'
}) {
  const { t } = useTranslation('interview')
  const column = width === 'narrow' ? 'max-w-2xl' : 'max-w-5xl'
  return (
    <div
      className={cn(
        'bg-background flex flex-col',
        width === 'stage' ? 'h-svh' : 'min-h-svh',
        candidateTouchTargets,
      )}
    >
      <header className="border-b">
        <div
          className={cn('mx-auto flex h-14 items-center gap-3 px-4', column)}
        >
          {logoUrl && (
            <img
              src={logoUrl}
              alt=""
              width={24}
              height={24}
              className="size-6 rounded-sm object-contain"
            />
          )}
          <span className="text-sm font-semibold tracking-tight">
            {organisationName ?? 'interw'}
          </span>
        </div>
      </header>

      <main
        className={cn(
          'mx-auto w-full flex-1 px-4',
          width === 'stage' ? 'flex min-h-0 flex-col py-4' : 'py-10',
          column,
        )}
      >
        {children}
      </main>

      {privacyToken && (
        <footer className="border-t">
          <div
            className={cn(
              'text-muted-foreground mx-auto px-4 py-6 text-xs',
              column,
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
