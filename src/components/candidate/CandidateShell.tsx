import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { chooseCandidateLanguage } from './useCandidateLanguage'
import type { ReactNode } from 'react'

import { Button } from '~/components/ui/button'
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
  const { t, i18n } = useTranslation('interview')
  const other = i18n.language === 'fr' ? 'en' : 'fr'
  return (
    <div
      className={cn(
        'bg-background flex min-h-svh flex-col',
        candidateTouchTargets,
      )}
    >
      <header className="border-b">
        <div
          className={cn(
            'mx-auto flex h-14 items-center justify-between gap-4 px-4',
            width === 'narrow' ? 'max-w-2xl' : 'max-w-5xl',
          )}
        >
          <span className="truncate text-sm font-semibold tracking-tight">
            {organisationName ?? 'interw'}
          </span>
          {/* Named in its own language, so it reads to the person who needs
              it rather than to the one already served. */}
          <Button
            variant="ghost"
            size="sm"
            lang={other}
            title={t('shell.language')}
            onClick={() => {
              chooseCandidateLanguage(other)
              void i18n.changeLanguage(other)
            }}
          >
            {other === 'fr' ? 'Français' : 'English'}
          </Button>
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
