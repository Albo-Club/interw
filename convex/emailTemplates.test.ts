import { describe, expect, it } from 'vitest'
import {
  invitationEmail,
  newEmailVerificationEmail,
  verificationEmail,
} from './emailTemplates'

// A URL the template did not build itself: its query string can carry
// anything the caller put in a `callbackURL`.
const HOSTILE_URL =
  'https://app.test/verify?token=a&callbackURL="><img src=x onerror=alert(1)>'

describe('email templates', () => {
  it('escape the button and fallback URL in the HTML branch', () => {
    const { html, text } = verificationEmail({ locale: 'en', url: HOSTILE_URL })
    expect(html).not.toContain('"><img')
    expect(html).toContain(
      'href="https://app.test/verify?token=a&amp;callbackURL=&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"',
    )
    expect(html).toContain('>https://app.test/verify?token=a&amp;callbackURL=&quot;&gt;&lt;img')
    // The plain-text branch is not HTML and keeps the URL as-is.
    expect(text).toContain(HOSTILE_URL)
  })

  it('escape a CTA URL that has no fallback line', () => {
    const { html } = invitationEmail({
      locale: 'fr',
      inviterName: 'A',
      orgName: 'B',
      acceptUrl: HOSTILE_URL,
    })
    expect(html).not.toContain('"><img')
  })

  it('confirm a new address without the sign-up copy', () => {
    for (const locale of ['en', 'fr'] as const) {
      const { subject, html, text } = newEmailVerificationEmail({
        locale,
        url: HOSTILE_URL,
        oldEmail: 'old@example.test',
        newEmail: '"><img src=x>@example.test',
      })
      expect(html).not.toContain('"><img')
      expect(text).toContain('old@example.test')
      // Not the sign-up template: nothing about signing in with a password.
      expect(`${subject} ${text}`).not.toMatch(/password|mot de passe/i)
    }
  })
})
