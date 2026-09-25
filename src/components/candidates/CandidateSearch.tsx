import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useConvexQuery } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { Command } from 'cmdk'
import { Search } from 'lucide-react'

import { api } from '../../../convex/_generated/api'
import { SessionStatusBadge } from './StatusBadge'
import type { Id } from '../../../convex/_generated/dataModel'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '~/components/ui/dialog'

/**
 * Find a candidate from anywhere in the app.
 *
 * Opens on ⌘K / Ctrl+K, because the thing a recruiter most often wants is a
 * person whose name they remember and whose role they do not. A modal
 * command list on every screen size: on a phone the header has no room for
 * a field, and cmdk brings the combobox semantics and arrow-key navigation.
 * `ui/command.tsx` is not vendored (the shadcn registry was unreachable when
 * this was written), so cmdk is used directly inside the shadcn Dialog.
 */
export function CandidateSearch({
  orgId,
  orgSlug,
}: {
  orgId: Id<'organizations'>
  orgSlug: string
}) {
  const { t } = useTranslation(['candidates', 'common'])
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const searchable = text.trim().length >= 2

  const results = useConvexQuery(
    api.reports.searchCandidates,
    open && searchable ? { orgId, text } : 'skip',
  )

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((current) => !current)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  function onOpenChange(next: boolean) {
    setOpen(next)
    // Escape or a click outside starts the next search from scratch.
    if (!next) setText('')
  }

  const status = !searchable
    ? t('candidates:search.hint')
    : results === undefined
      ? t('common:loadingEllipsis')
      : results.length === 0
        ? t('candidates:search.noResults')
        : null

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={t('candidates:search.placeholder')}
        aria-keyshortcuts="Meta+K Control+K"
        className="text-muted-foreground md:w-64 md:justify-start"
      >
        <Search aria-hidden className="size-4" />
        <span className="hidden md:inline">
          {t('candidates:search.placeholder')}
        </span>
      </Button>

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="gap-0 overflow-hidden p-0">
          <DialogTitle className="sr-only">
            {t('candidates:search.placeholder')}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('candidates:search.hint')}
          </DialogDescription>
          {/* Filtering happens on the server: cmdk must not re-rank. */}
          <Command
            shouldFilter={false}
            label={t('candidates:search.placeholder')}
          >
            <div className="flex items-center gap-2 border-b px-3">
              <Search
                aria-hidden
                className="text-muted-foreground size-4 shrink-0"
              />
              <Command.Input
                value={text}
                onValueChange={setText}
                placeholder={t('candidates:search.placeholder')}
                className="placeholder:text-muted-foreground h-12 w-full bg-transparent text-base outline-hidden md:text-sm"
              />
            </div>
            <Command.List className="max-h-80 overflow-y-auto p-1">
              {status && (
                <p
                  aria-live="polite"
                  className="text-muted-foreground px-3 py-6 text-center text-sm"
                >
                  {status}
                </p>
              )}
              {searchable &&
                results?.map((result) => (
                  <Command.Item
                    key={result.sessionId}
                    value={result.sessionId}
                    onSelect={() => {
                      onOpenChange(false)
                      void navigate({
                        to: '/app/$orgSlug/candidates/$sessionId',
                        params: { orgSlug, sessionId: result.sessionId },
                      })
                    }}
                    className="data-[selected=true]:bg-accent flex cursor-pointer items-start justify-between gap-3 rounded-sm px-3 py-2"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {result.candidateName}
                      </span>
                      <span className="text-muted-foreground block truncate text-xs">
                        {result.projectTitle}
                      </span>
                    </span>
                    <SessionStatusBadge status={result.status} />
                  </Command.Item>
                ))}
            </Command.List>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  )
}
