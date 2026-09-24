import { describe, expect, it } from 'vitest'
import { invitationEmail, verificationEmail } from './emailTemplates'

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
})
