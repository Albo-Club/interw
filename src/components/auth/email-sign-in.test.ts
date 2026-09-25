// @vitest-environment node
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it, vi } from 'vitest'
import { EmailSignIn } from './email-sign-in'
import type { ReactNode } from 'react'

import { createI18n } from '~/lib/i18n'

vi.mock('~/lib/auth-client', () => ({ authClient: {} }))
vi.mock('~/components/auth/social-auth-buttons', () => ({
  SocialAuthButtons: () => createElement('div', null, 'SOCIAL'),
}))
vi.mock('~/components/i18n/LanguageSwitcher', () => ({
  LanguageSwitcher: () => null,
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => createElement('a', null, children),
}))

function render(props: { verifyToken?: string; passwordFirst?: boolean }) {
  const i18n = createI18n('en')
  const html = renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(EmailSignIn, { title: 'Sign in', onDone: () => {}, ...props }),
    ),
  )
  return { html, t: i18n.getFixedT('en', 'auth') }
}

/**
 * The legacy verification link completes only with the account's password.
 * Any other way in from there — a code, or Google, which refuses an unverified
 * account and points to the code — deletes the password the person just set.
 */
describe('the sign-in form opened from a verification link', () => {
  it('offers the password and nothing that would delete it', () => {
    const { html, t } = render({ verifyToken: 'token', passwordFirst: true })
    expect(html).toContain(t('signIn.submit'))
    expect(html).toContain(t('signIn.forgot'))
    expect(html).not.toContain(t('start.useCode'))
    expect(html).not.toContain('SOCIAL')
  })

  it('keeps every way in otherwise', () => {
    const { html, t } = render({ passwordFirst: true })
    expect(html).toContain(t('start.useCode'))
    expect(html).toContain('SOCIAL')
  })
})
