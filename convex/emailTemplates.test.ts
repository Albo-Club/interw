import { describe, expect, it } from 'vitest'
import {
  candidateCompletedEmail,
  candidateInvitationEmail,
  invitationEmail,
  newEmailVerificationEmail,
  newUserSignupNotificationEmail,
  organizationDeletedEmail,
  reportReadyEmail,
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
      role: 'member',
      expiresAt: Date.now(),
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

  it('escape the organisation and its deleter in the deletion notice', () => {
    for (const locale of ['en', 'fr'] as const) {
      const { html, text } = organizationDeletedEmail({
        locale,
        orgName: '"><img src=x>',
        deletedBy: '<a href="https://evil.test">Owner</a>',
      })
      expect(html).not.toContain('"><img')
      expect(html).not.toContain('<a href="https://evil.test"')
      expect(text).toContain('"><img src=x>')
    }
  })

  it('names the role and the expiry date in the invitation', () => {
    const { html, text } = invitationEmail({
      locale: 'fr',
      inviterName: 'Alice <b>',
      orgName: 'Acme',
      role: 'admin',
      expiresAt: Date.UTC(2026, 9, 1, 12),
      acceptUrl: 'https://app.test/accept-invite/t',
    })
    expect(text).toContain('Alice <b> vous invite à rejoindre Acme')
    expect(text).toContain('avec le rôle Admin')
    expect(text).toContain('le 1er octobre 2026 (UTC)')
    expect(html).toContain('<strong>Alice &lt;b&gt;</strong>')
  })

  // Audit T12 (h10): a subject is a header. A value typed by a user — their
  // name, their organisation's, a role title — must not break it into two
  // lines, nor push the rest of the subject out of sight.
  it('keep every user-supplied value in a subject on one bounded line', () => {
    const hostile = `Acme\r\nBcc: victim@example.test${'x'.repeat(500)}`
    const subjects = (['en', 'fr'] as const).flatMap((locale) => [
      invitationEmail({
        locale,
        inviterName: hostile,
        orgName: hostile,
        role: 'member',
        expiresAt: Date.now(),
        acceptUrl: 'https://app.test/accept-invite/t',
      }).subject,
      candidateInvitationEmail({
        locale,
        candidateName: hostile,
        jobTitle: hostile,
        orgName: hostile,
        startUrl: 'https://app.test/s/t',
        durationMinutes: 10,
      }).subject,
      candidateCompletedEmail({
        locale,
        candidateName: hostile,
        jobTitle: hostile,
        orgName: hostile,
        privacyUrl: 'https://app.test/s/t/data',
      }).subject,
      reportReadyEmail({
        locale,
        candidateName: hostile,
        jobTitle: hostile,
        score: 50,
        recommendation: 'hire',
        reportUrl: 'https://app.test/r/t',
      }).subject,
      organizationDeletedEmail({ locale, orgName: hostile, deletedBy: hostile })
        .subject,
    ])
    subjects.push(
      newUserSignupNotificationEmail({
        email: hostile,
        betterAuthId: 'ba',
        isFirst: false,
      }).subject,
    )
    for (const subject of subjects) {
      expect(subject).not.toMatch(/[\r\n]/)
      expect(subject).toContain('Acme Bcc: victim@example.test')
      expect(subject.length).toBeLessThan(250)
    }
  })
})
