import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react'
import { useTranslation } from 'react-i18next'

import type { Id } from '../../../convex/_generated/dataModel'
import { Sheet, SheetContent, SheetTitle } from '~/components/ui/sheet'
import { Spinner } from '~/components/ui/spinner'

// The panel carries the markdown renderer, most of the recruiter layout's
// weight: it is fetched the first time someone opens it, not with every page.
const AiPanel = lazy(() =>
  import('./AiPanel').then((m) => ({ default: m.AiPanel })),
)

// Open/closed persists in a 7-day cookie (same pattern as shadcn's
// sidebar_state).
const COOKIE_NAME = 'ai_panel_state'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7

/** Closed unless the recruiter left it open: nobody asked for it yet. */
export function readAiPanelCookie(cookie: string): boolean {
  const match = cookie.match(new RegExp(`(?:^|; )${COOKIE_NAME}=([^;]*)`))
  return match?.[1] === 'true'
}

/** The panel's open state, persisted, with ⌘J / Ctrl+J to toggle it. */
export function useAiPanelOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(
    () => typeof document !== 'undefined' && readAiPanelCookie(document.cookie),
  )

  const setPanelOpen = useCallback((next: boolean) => {
    setOpen(next)
    document.cookie = `${COOKIE_NAME}=${next}; path=/; max-age=${COOKIE_MAX_AGE}`
  }, [])

  // Mirrors the sidebar's ⌘B.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'j' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setPanelOpen(!open)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, setPanelOpen])

  return [open, setPanelOpen]
}

// Tailwind's `lg`: from here up the panel sits beside the page.
const DESKTOP_QUERY = '(min-width: 64rem)'

function subscribeDesktop(onChange: () => void): () => void {
  const mql = window.matchMedia(DESKTOP_QUERY)
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => false,
  )
}

/**
 * Where the AI panel lives: a column beside the page from `lg` up, and below
 * that a modal sheet — focus trapped inside, Escape and the backdrop close
 * it, the page behind is inert — rather than an overlay covering the screen
 * with only a cross to leave it.
 */
export function AiPanelHost({
  orgId,
  open,
  onOpenChange,
}: {
  orgId: Id<'organizations'>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation('chat')
  const isDesktop = useIsDesktop()
  // A panel restored open from the cookie must not steal the page's focus;
  // one the recruiter opens takes it.
  const [restoredOpen, setRestoredOpen] = useState(open)
  if (!open && restoredOpen) setRestoredOpen(false)

  if (!open) return null

  const panel = (
    <Suspense
      fallback={
        <p className="text-muted-foreground flex flex-1 items-center justify-center gap-2 text-sm">
          <Spinner className="size-3.5" />
          {t('loading')}
        </p>
      }
    >
      <AiPanel
        orgId={orgId}
        // On a phone the keyboard would cover half the sheet.
        autoFocus={isDesktop && !restoredOpen}
        onClose={() => onOpenChange(false)}
      />
    </Suspense>
  )

  if (isDesktop) {
    return (
      <aside
        aria-label={t('title')}
        className="bg-background my-2 mr-2 flex w-[400px] shrink-0 flex-col overflow-hidden rounded-xl shadow-sm"
      >
        {panel}
      </aside>
    )
  }

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-modal="true"
        aria-describedby={undefined}
        className="w-full gap-0 overscroll-contain p-0 pb-[env(safe-area-inset-bottom)] sm:max-w-md"
      >
        <SheetTitle className="sr-only">{t('title')}</SheetTitle>
        {panel}
      </SheetContent>
    </Sheet>
  )
}
