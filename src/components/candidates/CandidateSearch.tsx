import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useConvexQuery } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { Search } from 'lucide-react'

import { api } from '../../../convex/_generated/api'
import { SessionStatusBadge } from './StatusBadge'
import type { Id } from '../../../convex/_generated/dataModel'
import { Input } from '~/components/ui/input'
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '~/components/ui/popover'

/**
 * Find a candidate from anywhere in the app.
 *
 * Opens on ⌘K / Ctrl+K, because the thing a recruiter most often wants is a
 * person whose name they remember and whose role they do not.
 */
export function CandidateSearch({
  orgId,
  orgSlug,
}: {
  orgId: Id<'organizations'>
  orgSlug: string
}) {
  const { t } = useTranslation(['candidates', 'common'])
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const results = useConvexQuery(
    api.reports.searchCandidates,
    text.trim().length >= 2 ? { orgId, text } : 'skip',
  )

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        inputRef.current?.focus()
      }
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <Popover open={open && text.trim().length >= 2} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="relative hidden w-64 md:block">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            ref={inputRef}
            value={text}
            onChange={(event) => {
              setText(event.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            placeholder={t('candidates:search.placeholder')}
            aria-label={t('candidates:search.placeholder')}
            className="h-9 pl-9"
          />
        </div>
      </PopoverAnchor>

      <PopoverContent
        align="end"
        className="w-80 p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {results === undefined ? (
          <p className="text-muted-foreground p-4 text-sm">
            {t('common:loadingEllipsis')}
          </p>
        ) : results.length === 0 ? (
          <p className="text-muted-foreground p-4 text-sm">
            {t('candidates:search.noResults')}
          </p>
        ) : (
          <ul className="max-h-80 overflow-y-auto py-1">
            {results.map((result) => (
              <li key={result.sessionId}>
                <Link
                  to="/app/$orgSlug/candidates/$sessionId"
                  params={{ orgSlug, sessionId: result.sessionId }}
                  onClick={() => {
                    setOpen(false)
                    setText('')
                  }}
                  className="hover:bg-accent flex items-start justify-between gap-3 px-3 py-2"
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
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}
