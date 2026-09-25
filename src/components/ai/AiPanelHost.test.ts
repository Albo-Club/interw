// @vitest-environment node
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it, vi } from 'vitest'

import { AiPanelHost, readAiPanelCookie } from './AiPanelHost'
import type { ReactNode } from 'react'
import type * as Radix from 'radix-ui'
import type { Id } from '../../../convex/_generated/dataModel'
import { createI18n } from '~/lib/i18n'

vi.mock('./AiPanel', () => ({ AiPanel: () => null }))

// Radix portals into `document.body` once mounted, which a server render
// never is. Rendering the portal in place leaves the dialog's own markup —
// role, modality, label — as it reaches the page.
vi.mock('radix-ui', async (importOriginal) => {
  const radix = await importOriginal<typeof Radix>()
  return {
    ...radix,
    Dialog: {
      ...radix.Dialog,
      Portal: ({ children }: { children: ReactNode }) => children,
    },
  }
})

function render(open: boolean): string {
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n: createI18n('en') },
      createElement(AiPanelHost, {
        orgId: 'org1' as Id<'organizations'>,
        open,
        onOpenChange: () => {},
      }),
    ),
  )
}

// Audit 2026-09-15, E8.
describe('the AI panel', () => {
  it('is closed until someone opens it', () => {
    expect(readAiPanelCookie('')).toBe(false)
    expect(readAiPanelCookie('sidebar_state=true')).toBe(false)
    expect(readAiPanelCookie('ai_panel_state=false')).toBe(false)
    expect(readAiPanelCookie('a=1; ai_panel_state=true')).toBe(true)
  })

  it('renders nothing while closed', () => {
    expect(render(false)).toBe('')
  })

  // Below `lg` (and on the server, which has no viewport) the panel is a
  // modal dialog: Radix's Dialog traps focus, closes on Escape and hides the
  // page from assistive tech; `aria-modal` says so to the screen reader.
  it('opens as a labelled modal dialog below lg', () => {
    const html = render(true)
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1]
    expect(labelledBy).toBeDefined()
    expect(html).toContain(`id="${labelledBy}"`)
    expect(html).toContain('AI assistant')
    expect(html).not.toContain('<aside')
  })
})
