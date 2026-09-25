/**
 * Email templates. Plain text + HTML are sent together (multipart/alternative)
 * — a strong anti-spam signal and required for accessibility.
 *
 * HTML uses inline styles since Gmail / Outlook strip <style> tags.
 * Layout is a single 560px column, mobile-safe.
 *
 * Each template is bilingual (en/fr). The recipient's locale is resolved from
 * their stored `preferredLanguage` (via `users.localeForEmail` or the caller's
 * own lookup); English is the fallback. Copy here is user-facing — keep it in
 * sync with the front-end `auth` namespace where the flows overlap.
 */

import { clampLine } from './lib/names'

export type EmailLocale = 'en' | 'fr'

const APP_NAME = 'interw'
const BRAND = '#0f0f10'
const MUTED = '#6b6b73'
const BORDER = '#e7e7ea'
const BG = '#ffffff'
const BUTTON_BG = '#0f0f10'
const BUTTON_FG = '#ffffff'

function layout({
  locale,
  preheader,
  heading,
  paragraphs,
  cta,
  footer,
}: {
  locale: EmailLocale
  preheader: string
  heading: string
  paragraphs: Array<string>
  cta?: { label: string; url: string }
  footer: string
}) {
  const ctaHtml = cta
    ? `<tr><td style="padding: 24px 0 8px;">
        <a href="${esc(cta.url)}"
          style="display:inline-block; background:${BUTTON_BG}; color:${BUTTON_FG}; text-decoration:none; padding:12px 20px; border-radius:8px; font-weight:600; font-size:14px;">
          ${cta.label}
        </a>
      </td></tr>`
    : ''
  const bodyHtml = paragraphs
    .map(
      (p) =>
        `<tr><td style="padding-bottom:14px; line-height:1.55;">${p}</td></tr>`,
    )
    .join('')

  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${heading}</title>
</head>
<body style="margin:0; padding:0; background:${BG}; color:${BRAND}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Arial, sans-serif;">
  <span style="display:none; max-height:0; overflow:hidden; opacity:0;">${preheader}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BG};">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:560px; border:1px solid ${BORDER}; border-radius:14px; background:${BG};">
        <tr><td style="padding:28px 32px 0;">
          <div style="font-weight:700; font-size:18px; letter-spacing:-0.01em;">${APP_NAME}</div>
        </td></tr>
        <tr><td style="padding:20px 32px 8px;">
          <h1 style="margin:0 0 8px; font-size:20px; font-weight:600; line-height:1.3;">${heading}</h1>
        </td></tr>
        <tr><td style="padding:0 32px 8px; font-size:15px; color:${BRAND};">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            ${bodyHtml}
            ${ctaHtml}
          </table>
        </td></tr>
        <tr><td style="padding:24px 32px 28px; border-top:1px solid ${BORDER}; color:${MUTED}; font-size:12px; line-height:1.5;">
          ${footer}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}

function plainText(parts: Array<string>): string {
  return parts.filter(Boolean).join('\n\n')
}

// User-supplied values (display names, org names, emails) must be escaped
// before interpolation into the HTML branch — otherwise a self-set name like
// `x</strong><a href="https://evil">…</a>` injects markup into a
// DKIM-authenticated email (phishing vector). URLs too: their query string
// carries caller-chosen values such as a `callbackURL`. Plain-text branches
// are not HTML and use the raw values; subjects go through `inSubject`.
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// A subject is a header: a user-supplied value in it stays on one line, and
// short enough that the subject still says what the email is about.
const SUBJECT_VALUE_MAX = 80
const inSubject = (value: string) => clampLine(value, SUBJECT_VALUE_MAX)

function pick<T>(locale: EmailLocale, copy: Record<EmailLocale, T>): T {
  return copy[locale] ?? copy.en
}

const urlFallback = (locale: EmailLocale, url: string) =>
  pick(locale, {
    en: `If the button doesn't work, copy this URL into your browser:<br><span style="color:${MUTED}; word-break:break-all;">${esc(url)}</span>`,
    fr: `Si le bouton ne fonctionne pas, copiez cette URL dans votre navigateur :<br><span style="color:${MUTED}; word-break:break-all;">${esc(url)}</span>`,
  })

const MONTHS: Record<EmailLocale, Array<string>> = {
  en: [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ],
  fr: [
    'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
    'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
  ],
}

/**
 * Spelled out by hand rather than through `Intl`, whose locale data this
 * template has no reason to depend on in the Convex runtime. UTC, and the
 * copy says so, because the recipient's time zone is unknown.
 */
function longDate(locale: EmailLocale, ms: number): string {
  const d = new Date(ms)
  const month = MONTHS[locale][d.getUTCMonth()]
  const day = d.getUTCDate()
  return locale === 'fr'
    ? `${day === 1 ? '1er' : day} ${month} ${d.getUTCFullYear()}`
    : `${month} ${day}, ${d.getUTCFullYear()}`
}

export function invitationEmail({
  locale,
  inviterName,
  orgName,
  role,
  expiresAt,
  acceptUrl,
}: {
  locale: EmailLocale
  inviterName: string
  orgName: string
  role: 'admin' | 'member'
  expiresAt: number
  acceptUrl: string
}) {
  const safeInviter = esc(inviterName)
  const safeOrg = esc(orgName)
  const days = Math.max(1, Math.round((expiresAt - Date.now()) / 86_400_000))
  const date = longDate(locale, expiresAt)
  const c = pick(locale, {
    en: {
      subject: `${inSubject(inviterName)} invited you to ${inSubject(orgName)} on ${APP_NAME}`,
      heading: `Join ${safeOrg} on ${APP_NAME}`,
      intro: (inviter: string, org: string) =>
        `${inviter} invited you to join ${org} on ${APP_NAME} as ${role === 'admin' ? 'an admin' : 'a member'}.`,
      what: `${APP_NAME} runs asynchronous video interviews: candidates record their answers when it suits them, and your team reviews them together.`,
      roleLine:
        role === 'admin'
          ? `As an admin, you can invite teammates and manage the organization, on top of creating roles and reviewing candidates.`
          : `As a member, you can create roles, invite candidates and review their interviews.`,
      expiry: `This invitation expires on ${date} (UTC), in ${days} ${days === 1 ? 'day' : 'days'}.`,
      footer: `If you didn't expect this invitation, you can safely ignore this email.`,
      preheader: `${safeInviter} invited you to join ${safeOrg}.`,
      cta: 'Accept invitation',
      ctaText: 'Accept the invitation:',
    },
    fr: {
      subject: `${inSubject(inviterName)} vous invite à rejoindre ${inSubject(orgName)} sur ${APP_NAME}`,
      heading: `Rejoindre ${safeOrg} sur ${APP_NAME}`,
      intro: (inviter: string, org: string) =>
        `${inviter} vous invite à rejoindre ${org} sur ${APP_NAME} avec le rôle ${role === 'admin' ? 'Admin' : 'Membre'}.`,
      what: `${APP_NAME} est une plateforme d’entretiens vidéo asynchrones : les personnes candidates enregistrent leurs réponses quand cela leur convient, et votre équipe les évalue ensemble.`,
      roleLine:
        role === 'admin'
          ? `Avec le rôle Admin, vous pourrez inviter des collègues et gérer l’organisation, en plus de créer des postes et d’évaluer les candidatures.`
          : `Avec le rôle Membre, vous pourrez créer des postes, inviter des personnes candidates et évaluer leurs entretiens.`,
      expiry: `Cette invitation expire le ${date} (UTC), dans ${days} ${days === 1 ? 'jour' : 'jours'}.`,
      footer: `Si vous n'attendiez pas cette invitation, vous pouvez ignorer cet e-mail.`,
      preheader: `${safeInviter} vous invite à rejoindre ${safeOrg}.`,
      cta: 'Accepter l’invitation',
      ctaText: 'Accepter l’invitation :',
    },
  })

  const html = layout({
    locale,
    preheader: c.preheader,
    heading: c.heading,
    paragraphs: [
      c.intro(`<strong>${safeInviter}</strong>`, `<strong>${safeOrg}</strong>`),
      c.what,
      c.roleLine,
      c.expiry,
    ],
    cta: { label: c.cta, url: acceptUrl },
    footer: `${urlFallback(locale, acceptUrl)}<br><br>${c.footer}`,
  })

  return {
    subject: c.subject,
    html,
    text: plainText([
      c.intro(inviterName, orgName),
      c.what,
      c.roleLine,
      c.ctaText,
      acceptUrl,
      c.expiry,
      c.footer,
    ]),
  }
}

export function changeEmailVerificationEmail({
  locale,
  url,
  newEmail,
}: {
  locale: EmailLocale
  url: string
  newEmail: string
}) {
  // Sent to the CURRENT address. Acts as approval gate: a hijacked session
  // can request the change, but only the legitimate owner of the current
  // inbox can authorize it.
  const safeNewEmail = esc(newEmail)
  const c = pick(locale, {
    en: {
      subject: `Approve email change on ${APP_NAME}`,
      heading: `Approve email change`,
      intro: `Someone requested to change your ${APP_NAME} account email to <strong>${safeNewEmail}</strong>.`,
      followup: `If this was you, click below to approve. <strong>If not, ignore this email</strong> — your current address stays unchanged and the request is dropped.`,
      footer: `Your account email is updated only after you approve here.`,
      preheader: `Approve change to ${safeNewEmail}.`,
      cta: 'Approve email change',
      text: [
        `Approve email change on ${APP_NAME}.`,
        `Someone requested to change your account email to ${newEmail}.`,
        `If this was you, open this link to approve:`,
        url,
        `If not, ignore this email — your current address stays unchanged.`,
      ],
    },
    fr: {
      subject: `Approuver le changement d'e-mail sur ${APP_NAME}`,
      heading: `Approuver le changement d'e-mail`,
      intro: `Quelqu'un a demandé à changer l'e-mail de votre compte ${APP_NAME} pour <strong>${safeNewEmail}</strong>.`,
      followup: `Si c'était vous, cliquez ci-dessous pour approuver. <strong>Sinon, ignorez cet e-mail</strong> — votre adresse actuelle reste inchangée et la demande est annulée.`,
      footer: `L'e-mail de votre compte n'est mis à jour qu'après votre approbation ici.`,
      preheader: `Approuver le changement vers ${safeNewEmail}.`,
      cta: 'Approuver le changement',
      text: [
        `Approuver le changement d'e-mail sur ${APP_NAME}.`,
        `Quelqu'un a demandé à changer l'e-mail de votre compte pour ${newEmail}.`,
        `Si c'était vous, ouvrez ce lien pour approuver :`,
        url,
        `Sinon, ignorez cet e-mail — votre adresse actuelle reste inchangée.`,
      ],
    },
  })

  const html = layout({
    locale,
    preheader: c.preheader,
    heading: c.heading,
    paragraphs: [c.intro, c.followup],
    cta: { label: c.cta, url },
    footer: c.footer,
  })

  return { subject: c.subject, html, text: plainText(c.text) }
}

export function deleteAccountVerificationEmail({
  locale,
  url,
  name,
}: {
  locale: EmailLocale
  url: string
  name?: string | null
}) {
  const safeName = name ? esc(name) : name
  const c = pick(locale, {
    en: {
      subject: `Confirm account deletion on ${APP_NAME}`,
      heading: `Confirm account deletion`,
      intro: safeName
        ? `${safeName}, you asked to delete your ${APP_NAME} account.`
        : `You asked to delete your ${APP_NAME} account.`,
      followup: `This will permanently remove your profile, your organization memberships, and your access. <strong>This cannot be undone.</strong>`,
      footer: `This link expires in 1 hour. If you didn't request this, ignore this email and nothing happens.`,
      preheader: `Confirm account deletion.`,
      cta: 'Delete my account',
      text: [
        name
          ? `${name}, you asked to delete your ${APP_NAME} account.`
          : `You asked to delete your ${APP_NAME} account.`,
        `This will permanently remove your profile and access. This cannot be undone.`,
        `Confirm by opening this link (it expires in 1 hour):`,
        url,
        `If you didn't request this, ignore this email.`,
      ],
    },
    fr: {
      subject: `Confirmer la suppression du compte sur ${APP_NAME}`,
      heading: `Confirmer la suppression du compte`,
      intro: safeName
        ? `${safeName}, vous avez demandé à supprimer votre compte ${APP_NAME}.`
        : `Vous avez demandé à supprimer votre compte ${APP_NAME}.`,
      followup: `Cela supprimera définitivement votre profil, vos adhésions aux organisations et votre accès. <strong>Cette action est irréversible.</strong>`,
      footer: `Ce lien expire dans 1 heure. Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail et rien ne se passera.`,
      preheader: `Confirmer la suppression du compte.`,
      cta: 'Supprimer mon compte',
      text: [
        name
          ? `${name}, vous avez demandé à supprimer votre compte ${APP_NAME}.`
          : `Vous avez demandé à supprimer votre compte ${APP_NAME}.`,
        `Cela supprimera définitivement votre profil et votre accès. Cette action est irréversible.`,
        `Confirmez en ouvrant ce lien (il expire dans 1 heure) :`,
        url,
        `Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.`,
      ],
    },
  })

  const html = layout({
    locale,
    preheader: c.preheader,
    heading: c.heading,
    paragraphs: [c.intro, c.followup],
    cta: { label: c.cta, url },
    footer: c.footer,
  })

  return { subject: c.subject, html, text: plainText(c.text) }
}

export function verificationEmail({
  locale,
  url,
}: {
  locale: EmailLocale
  url: string
}) {
  const c = pick(locale, {
    en: {
      subject: `Verify your email on ${APP_NAME}`,
      heading: `Verify your email`,
      intro: `To confirm this is your email address, click the button below and sign in with your ${APP_NAME} password.`,
      footer: `Didn't create an account or change your email on ${APP_NAME}? Ignore this email — without the account's password, this link does nothing.`,
      preheader: `Verify your email on ${APP_NAME}.`,
      cta: 'Verify email',
      text: [
        `Verify your email on ${APP_NAME}.`,
        `Open this link, then sign in with your password:`,
        url,
        `Didn't create an account or change your email on ${APP_NAME}? Ignore this email — without the account's password, this link does nothing.`,
      ],
    },
    fr: {
      subject: `Vérifiez votre e-mail sur ${APP_NAME}`,
      heading: `Vérifiez votre e-mail`,
      intro: `Pour confirmer qu'il s'agit bien de votre adresse e-mail, cliquez sur le bouton ci-dessous et connectez-vous avec votre mot de passe ${APP_NAME}.`,
      footer: `Vous n'avez ni créé de compte ni changé d'e-mail sur ${APP_NAME} ? Ignorez cet e-mail — sans le mot de passe du compte, ce lien ne fait rien.`,
      preheader: `Vérifiez votre e-mail sur ${APP_NAME}.`,
      cta: 'Vérifier l’e-mail',
      text: [
        `Vérifiez votre e-mail sur ${APP_NAME}.`,
        `Ouvrez ce lien, puis connectez-vous avec votre mot de passe :`,
        url,
        `Vous n'avez ni créé de compte ni changé d'e-mail sur ${APP_NAME} ? Ignorez cet e-mail — sans le mot de passe du compte, ce lien ne fait rien.`,
      ],
    },
  })

  const html = layout({
    locale,
    preheader: c.preheader,
    heading: c.heading,
    paragraphs: [c.intro, urlFallback(locale, url)],
    cta: { label: c.cta, url },
    footer: c.footer,
  })

  return { subject: c.subject, html, text: plainText(c.text) }
}

export function newEmailVerificationEmail({
  locale,
  url,
  oldEmail,
  newEmail,
}: {
  locale: EmailLocale
  url: string
  oldEmail: string
  newEmail: string
}) {
  // Second step of an email change, sent to the NEW address once the current
  // one has approved. The change happens when this link is opened.
  const safeOld = esc(oldEmail)
  const safeNew = esc(newEmail)
  const c = pick(locale, {
    en: {
      subject: `Confirm your new email address for ${APP_NAME}`,
      heading: `Confirm your new email address`,
      intro: `You asked to use <strong>${safeNew}</strong> for your ${APP_NAME} account instead of <strong>${safeOld}</strong>, and approved it from that address. One last step: confirm this one.`,
      followup: `If you aren't signed in to ${APP_NAME} on this device, you'll be asked to sign in first. This link expires in 1 hour.`,
      footer: `Didn't ask for this? Ignore this email — the account keeps its current address.`,
      preheader: `One last step to switch to ${safeNew}.`,
      cta: 'Confirm new address',
      text: [
        `Confirm your new email address for ${APP_NAME}.`,
        `You asked to use ${newEmail} for your ${APP_NAME} account instead of ${oldEmail}. Open this link to confirm (it expires in 1 hour):`,
        url,
        `Didn't ask for this? Ignore this email — the account keeps its current address.`,
      ],
    },
    fr: {
      subject: `Confirmez votre nouvelle adresse e-mail pour ${APP_NAME}`,
      heading: `Confirmez votre nouvelle adresse e-mail`,
      intro: `Vous avez demandé à utiliser <strong>${safeNew}</strong> pour votre compte ${APP_NAME} à la place de <strong>${safeOld}</strong>, et l'avez approuvé depuis cette adresse. Dernière étape : confirmez celle-ci.`,
      followup: `Si vous n'êtes pas connecté à ${APP_NAME} sur cet appareil, il vous sera demandé de vous connecter d'abord. Ce lien expire dans 1 heure.`,
      footer: `Vous n'avez rien demandé ? Ignorez cet e-mail — le compte garde son adresse actuelle.`,
      preheader: `Dernière étape pour passer à ${safeNew}.`,
      cta: 'Confirmer la nouvelle adresse',
      text: [
        `Confirmez votre nouvelle adresse e-mail pour ${APP_NAME}.`,
        `Vous avez demandé à utiliser ${newEmail} pour votre compte ${APP_NAME} à la place de ${oldEmail}. Ouvrez ce lien pour confirmer (il expire dans 1 heure) :`,
        url,
        `Vous n'avez rien demandé ? Ignorez cet e-mail — le compte garde son adresse actuelle.`,
      ],
    },
  })

  const html = layout({
    locale,
    preheader: c.preheader,
    heading: c.heading,
    paragraphs: [c.intro, c.followup, urlFallback(locale, url)],
    cta: { label: c.cta, url },
    footer: c.footer,
  })

  return { subject: c.subject, html, text: plainText(c.text) }
}

export function resetPasswordEmail({
  locale,
  url,
}: {
  locale: EmailLocale
  url: string
}) {
  const c = pick(locale, {
    en: {
      subject: `Reset your ${APP_NAME} password`,
      heading: `Reset your password`,
      intro: `We received a request to reset your ${APP_NAME} password. Click the button below to choose a new one. This link expires in 1 hour.`,
      footer: `If you didn't request a password reset, ignore this email and your password stays unchanged.`,
      preheader: `Reset your ${APP_NAME} password.`,
      cta: 'Reset password',
      text: [
        `Reset your ${APP_NAME} password.`,
        `Open this link to choose a new password (expires in 1 hour):`,
        url,
        `If you didn't request this, ignore this email.`,
      ],
    },
    fr: {
      subject: `Réinitialisez votre mot de passe ${APP_NAME}`,
      heading: `Réinitialisez votre mot de passe`,
      intro: `Nous avons reçu une demande de réinitialisation de votre mot de passe ${APP_NAME}. Cliquez sur le bouton ci-dessous pour en choisir un nouveau. Ce lien expire dans 1 heure.`,
      footer: `Si vous n'avez pas demandé de réinitialisation, ignorez cet e-mail et votre mot de passe reste inchangé.`,
      preheader: `Réinitialisez votre mot de passe ${APP_NAME}.`,
      cta: 'Réinitialiser le mot de passe',
      text: [
        `Réinitialisez votre mot de passe ${APP_NAME}.`,
        `Ouvrez ce lien pour choisir un nouveau mot de passe (expire dans 1 heure) :`,
        url,
        `Si vous n'avez pas demandé cela, ignorez cet e-mail.`,
      ],
    },
  })

  const html = layout({
    locale,
    preheader: c.preheader,
    heading: c.heading,
    paragraphs: [c.intro, urlFallback(locale, url)],
    cta: { label: c.cta, url },
    footer: c.footer,
  })

  return { subject: c.subject, html, text: plainText(c.text) }
}

export function passwordChangedEmail({
  locale,
  email,
  added,
  resetUrl,
  sessionsUrl,
}: {
  locale: EmailLocale
  email: string
  /** A first password was set on an account that had none. */
  added: boolean
  resetUrl: string
  sessionsUrl: string
}) {
  // Post-event notification — sent AFTER the password is already changed.
  const safeEmail = esc(email)
  const sessionsLink = (label: string) =>
    `<a href="${esc(sessionsUrl)}" style="color:${BRAND};">${label}</a>`
  const c = pick(locale, {
    en: {
      subject: added
        ? `A password was added to your ${APP_NAME} account`
        : `Your ${APP_NAME} password was changed`,
      heading: added ? `Password added` : `Password changed`,
      intro: added
        ? `A password was just added to <strong>${safeEmail}</strong> on ${APP_NAME}. It can now be used to sign in.`
        : `The password for <strong>${safeEmail}</strong> was just changed on ${APP_NAME}.`,
      followup: `If you did this, no action is needed. <strong>If you didn't, your account may be compromised</strong> — reset your password now and ${sessionsLink('review your active sessions')}.`,
      footer: `We send this notice every time the password on your account changes.`,
      preheader: added
        ? `Password added for ${safeEmail}.`
        : `Password changed for ${safeEmail}.`,
      cta: 'Reset password',
      text: [
        added
          ? `A password was just added to your ${APP_NAME} account.`
          : `Your ${APP_NAME} password was just changed.`,
        `If you didn't do this, reset your password now: ${resetUrl}`,
        `Then review your active sessions: ${sessionsUrl}`,
      ],
    },
    fr: {
      subject: added
        ? `Un mot de passe a été ajouté à votre compte ${APP_NAME}`
        : `Votre mot de passe ${APP_NAME} a été modifié`,
      heading: added ? `Mot de passe ajouté` : `Mot de passe modifié`,
      intro: added
        ? `Un mot de passe vient d'être ajouté à <strong>${safeEmail}</strong> sur ${APP_NAME}. Il permet désormais de se connecter.`
        : `Le mot de passe de <strong>${safeEmail}</strong> vient d'être modifié sur ${APP_NAME}.`,
      followup: `Si c'est vous, aucune action n'est requise. <strong>Sinon, votre compte est peut-être compromis</strong> — réinitialisez votre mot de passe maintenant et ${sessionsLink('vérifiez vos sessions actives')}.`,
      footer: `Nous envoyons cet avis à chaque changement du mot de passe de votre compte.`,
      preheader: added
        ? `Mot de passe ajouté pour ${safeEmail}.`
        : `Mot de passe modifié pour ${safeEmail}.`,
      cta: 'Réinitialiser le mot de passe',
      text: [
        added
          ? `Un mot de passe vient d'être ajouté à votre compte ${APP_NAME}.`
          : `Votre mot de passe ${APP_NAME} vient d'être modifié.`,
        `Si ce n'est pas vous, réinitialisez votre mot de passe maintenant : ${resetUrl}`,
        `Puis vérifiez vos sessions actives : ${sessionsUrl}`,
      ],
    },
  })

  const html = layout({
    locale,
    preheader: c.preheader,
    heading: c.heading,
    paragraphs: [c.intro, c.followup],
    cta: { label: c.cta, url: resetUrl },
    footer: c.footer,
  })

  return { subject: c.subject, html, text: plainText(c.text) }
}

/**
 * Sign-in code. The code is the credential; the button only opens our page
 * with it prefilled (in the URL fragment), where the person still has to press
 * Confirm — so a mail scanner that follows links cannot spend the code.
 */
export function signInCodeEmail({
  locale,
  code,
  url,
}: {
  locale: EmailLocale
  code: string
  url: string
}) {
  const codeHtml = `<span style="display:inline-block; font-size:28px; font-weight:700; letter-spacing:0.3em; font-variant-numeric:tabular-nums; padding:12px 16px; border:1px solid ${BORDER}; border-radius:8px;">${esc(code)}</span>`
  const c = pick(locale, {
    en: {
      subject: `${code} is your ${APP_NAME} sign-in code`,
      heading: `Your sign-in code`,
      intro: `Enter this code on the ${APP_NAME} sign-in page:`,
      expiry: `It expires in 10 minutes and works only once. Or open the sign-in page with the code already filled in:`,
      footer: `If you didn't try to sign in, ignore this email: no one can sign in without this code.`,
      preheader: `Your ${APP_NAME} sign-in code, valid for 10 minutes.`,
      cta: 'Continue signing in',
      text: [
        `Your ${APP_NAME} sign-in code: ${code}`,
        `It expires in 10 minutes and works only once.`,
        `Or open the sign-in page with the code already filled in:`,
        url,
        `If you didn't try to sign in, ignore this email: no one can sign in without this code.`,
      ],
    },
    fr: {
      subject: `${code} est votre code de connexion ${APP_NAME}`,
      heading: `Votre code de connexion`,
      intro: `Saisissez ce code sur la page de connexion ${APP_NAME} :`,
      expiry: `Il expire dans 10 minutes et ne sert qu’une fois. Vous pouvez aussi ouvrir la page de connexion avec le code déjà rempli :`,
      footer: `Si vous n’avez pas essayé de vous connecter, ignorez cet e-mail : personne ne peut se connecter sans ce code.`,
      preheader: `Votre code de connexion ${APP_NAME}, valable 10 minutes.`,
      cta: 'Continuer la connexion',
      text: [
        `Votre code de connexion ${APP_NAME} : ${code}`,
        `Il expire dans 10 minutes et ne sert qu’une fois.`,
        `Vous pouvez aussi ouvrir la page de connexion avec le code déjà rempli :`,
        url,
        `Si vous n’avez pas essayé de vous connecter, ignorez cet e-mail : personne ne peut se connecter sans ce code.`,
      ],
    },
  })

  const html = layout({
    locale,
    preheader: c.preheader,
    heading: c.heading,
    paragraphs: [c.intro, codeHtml, c.expiry],
    cta: { label: c.cta, url },
    footer: `${urlFallback(locale, url)}<br><br>${c.footer}`,
  })

  return { subject: c.subject, html, text: plainText(c.text) }
}

/**
 * Dev-only signup notification. Sent to a single ops inbox (DEV_NOTIFY_EMAIL),
 * never to end users — so this template intentionally bypasses the bilingual
 * `pick(locale, …)` system and stays English-only.
 */
export function newUserSignupNotificationEmail({
  email,
  name,
  betterAuthId,
  isFirst,
}: {
  email: string
  name?: string
  betterAuthId: string
  isFirst: boolean
}) {
  const displayName = name ?? '(no name)'
  const tag = isFirst ? ' [FIRST USER]' : ''
  const subject = `[${APP_NAME}] New signup: ${inSubject(email)}${tag}`
  const heading = isFirst ? 'First user signed up' : 'New user signed up'
  const paragraphs = [
    `<strong>Email:</strong> ${esc(email)}`,
    `<strong>Name:</strong> ${esc(displayName)}`,
    `<strong>Better Auth id:</strong> <code>${esc(betterAuthId)}</code>`,
  ]
  const text = [
    heading,
    `Email: ${email}`,
    `Name: ${displayName}`,
    `Better Auth id: ${betterAuthId}`,
    isFirst ? 'This is the first user on the deployment.' : '',
  ]
  const html = layout({
    locale: 'en',
    preheader: `New signup: ${esc(email)}`,
    heading,
    paragraphs,
    footer: `${APP_NAME} — automated dev notification.`,
  })
  return { subject, html, text: plainText(text) }
}

/**
 * The invitation a candidate receives. Vouvoiement in French, and no jargon:
 * most recipients have never heard of an asynchronous video interview, so the
 * email has to say what will happen, how long it takes, and that they choose
 * when.
 */
export function candidateInvitationEmail({
  locale,
  candidateName,
  jobTitle,
  orgName,
  startUrl,
  durationMinutes,
}: {
  locale: EmailLocale
  candidateName: string
  jobTitle: string
  orgName: string
  startUrl: string
  durationMinutes: number
}) {
  const safeName = esc(candidateName)
  const safeJob = esc(jobTitle)
  const safeOrg = esc(orgName)
  const c = pick(locale, {
    en: {
      subject: `${inSubject(orgName)}: your interview for ${inSubject(jobTitle)}`,
      heading: `Your interview for ${safeJob}`,
      intro: `Hello ${safeName}, <strong>${safeOrg}</strong> would like to hear from you about the ${safeJob} role.`,
      how: `It is a short video interview you record on your own, from your browser, whenever suits you. You will answer a handful of questions asked on camera by the team. It takes about ${durationMinutes} minutes.`,
      needs: `You will need a working camera and microphone, and a quiet few minutes. Your answers are recorded and reviewed by ${safeOrg}.`,
      footer: `This link is personal to you — please do not forward it. If you were not expecting this, you can ignore this email.`,
      preheader: `A short video interview for ${safeJob}, whenever suits you.`,
      cta: 'Start the interview',
      text: [
        `Hello ${candidateName},`,
        `${orgName} would like to hear from you about the ${jobTitle} role.`,
        `It is a short video interview you record on your own, from your browser, whenever suits you. It takes about ${durationMinutes} minutes.`,
        `Start the interview:`,
        startUrl,
        `You will need a working camera and microphone, and a quiet few minutes.`,
        `This link is personal to you — please do not forward it.`,
      ],
    },
    fr: {
      subject: `${inSubject(orgName)} : votre entretien pour le poste de ${inSubject(jobTitle)}`,
      heading: `Votre entretien pour le poste de ${safeJob}`,
      intro: `Bonjour ${safeName}, <strong>${safeOrg}</strong> souhaite vous entendre au sujet du poste de ${safeJob}.`,
      how: `Il s'agit d'un court entretien vidéo que vous enregistrez seul, depuis votre navigateur, au moment qui vous convient. Vous répondrez à quelques questions posées face caméra par l'équipe. Comptez environ ${durationMinutes} minutes.`,
      needs: `Prévoyez une caméra et un micro en état de marche, et quelques minutes au calme. Vos réponses sont enregistrées et consultées par ${safeOrg}.`,
      footer: `Ce lien vous est personnel : merci de ne pas le transmettre. Si vous n'attendiez pas ce message, vous pouvez l'ignorer.`,
      preheader: `Un court entretien vidéo pour le poste de ${safeJob}, quand vous voulez.`,
      cta: "Commencer l'entretien",
      text: [
        `Bonjour ${candidateName},`,
        `${orgName} souhaite vous entendre au sujet du poste de ${jobTitle}.`,
        `Il s'agit d'un court entretien vidéo que vous enregistrez seul, depuis votre navigateur, au moment qui vous convient. Comptez environ ${durationMinutes} minutes.`,
        `Commencer l'entretien :`,
        startUrl,
        `Prévoyez une caméra et un micro en état de marche, et quelques minutes au calme.`,
        `Ce lien vous est personnel : merci de ne pas le transmettre.`,
      ],
    },
  })

  const html = layout({
    locale,
    preheader: c.preheader,
    heading: c.heading,
    paragraphs: [c.intro, c.how, c.needs],
    cta: { label: c.cta, url: startUrl },
    footer: c.footer,
  })

  return { subject: c.subject, html, text: plainText(c.text) }
}

/**
 * The candidate's confirmation that the interview arrived.
 *
 * Its reason to exist is the link at the bottom: the data page is the only
 * way a candidate can exercise the erasure the consent screen promised "at
 * any time", and without this email the only copy of that link was a page
 * they had just closed. The link carries their token, hence the footer.
 */
export function candidateCompletedEmail({
  locale,
  candidateName,
  jobTitle,
  orgName,
  privacyUrl,
}: {
  locale: EmailLocale
  candidateName: string
  jobTitle: string
  orgName: string
  privacyUrl: string
}) {
  const safeName = esc(candidateName)
  const safeJob = esc(jobTitle)
  const safeOrg = esc(orgName)
  const c = pick(locale, {
    en: {
      subject: `${inSubject(orgName)}: your interview has been sent`,
      heading: 'Your interview has been sent',
      intro: `Hello ${safeName}, thank you. Your answers for the ${safeJob} role have reached <strong>${safeOrg}</strong>, and there is nothing more for you to do.`,
      next: `${safeOrg} will review them and contact you directly.`,
      data: 'You can see what is kept about this interview, and delete all of it at any time, from your data page.',
      cta: 'See or delete my data',
      footer: 'The link above is personal to you — please do not forward it.',
      preheader: `Your answers for ${safeJob} have reached ${safeOrg}.`,
      text: [
        `Hello ${candidateName},`,
        `Thank you. Your answers for the ${jobTitle} role have reached ${orgName}, and there is nothing more for you to do. ${orgName} will review them and contact you directly.`,
        'You can see what is kept about this interview, and delete all of it at any time, from your data page:',
        privacyUrl,
        'This link is personal to you — please do not forward it.',
      ],
    },
    fr: {
      subject: `${inSubject(orgName)} : votre entretien a bien été envoyé`,
      heading: 'Votre entretien a bien été envoyé',
      intro: `Bonjour ${safeName}, merci. Vos réponses pour le poste de ${safeJob} sont bien parvenues à <strong>${safeOrg}</strong>, et vous n'avez plus rien à faire.`,
      next: `${safeOrg} va les examiner et reviendra vers vous directement.`,
      data: 'Vous pouvez consulter ce qui est conservé de cet entretien, et tout supprimer à tout moment, depuis votre page de données.',
      cta: 'Voir ou supprimer mes données',
      footer: 'Le lien ci-dessus vous est personnel : merci de ne pas le transmettre.',
      preheader: `Vos réponses pour le poste de ${safeJob} sont bien parvenues à ${safeOrg}.`,
      text: [
        `Bonjour ${candidateName},`,
        `Merci. Vos réponses pour le poste de ${jobTitle} sont bien parvenues à ${orgName}, et vous n'avez plus rien à faire. ${orgName} va les examiner et reviendra vers vous directement.`,
        'Vous pouvez consulter ce qui est conservé de cet entretien, et tout supprimer à tout moment, depuis votre page de données :',
        privacyUrl,
        'Ce lien vous est personnel : merci de ne pas le transmettre.',
      ],
    },
  })

  const html = layout({
    locale,
    preheader: c.preheader,
    heading: c.heading,
    paragraphs: [c.intro, c.next, c.data, urlFallback(locale, privacyUrl)],
    cta: { label: c.cta, url: privacyUrl },
    footer: c.footer,
  })

  return { subject: c.subject, html, text: plainText(c.text) }
}

/**
 * The recruiter's "a report is ready" email.
 *
 * Deliberately says the verdict and the score and stops there. Putting the
 * full analysis in an email would mean candidate assessments living in every
 * recipient's inbox and forwarded beyond the organisation — the report stays
 * behind the login.
 */
export function reportReadyEmail({
  locale,
  candidateName,
  jobTitle,
  score,
  recommendation,
  reportUrl,
}: {
  locale: EmailLocale
  candidateName: string
  jobTitle: string
  score: number
  recommendation: string
  reportUrl: string
}) {
  const safeCandidate = esc(candidateName)
  const safeJob = esc(jobTitle)
  const c = pick(locale, {
    en: {
      subject: `${inSubject(candidateName)} — interview report ready (${inSubject(jobTitle)})`,
      heading: `${safeCandidate}'s interview is ready to review`,
      intro: `<strong>${safeCandidate}</strong> has completed their interview for <strong>${safeJob}</strong>.`,
      score: `Overall score: <strong>${score}/100</strong> · Recommendation: <strong>${esc(recommendation)}</strong>`,
      caveat: `The score and recommendation are produced automatically from the interview. They are there to speed up your reading, not to make the decision — open the report and check the quotes behind them.`,
      footer: `You are receiving this because you have access to this role in Interw.`,
      preheader: `${safeCandidate} finished their interview for ${safeJob}.`,
      cta: 'Open the report',
      text: [
        `${candidateName} has completed their interview for ${jobTitle}.`,
        `Overall score: ${score}/100. Recommendation: ${recommendation}.`,
        `Open the report:`,
        reportUrl,
        `The score and recommendation are produced automatically. They speed up your reading; they do not make the decision.`,
      ],
    },
    fr: {
      subject: `${inSubject(candidateName)} — rapport d'entretien disponible (${inSubject(jobTitle)})`,
      heading: `L'entretien de ${safeCandidate} est prêt à être consulté`,
      intro: `<strong>${safeCandidate}</strong> a terminé son entretien pour le poste de <strong>${safeJob}</strong>.`,
      score: `Score global : <strong>${score}/100</strong> · Recommandation : <strong>${esc(recommendation)}</strong>`,
      caveat: `Le score et la recommandation sont produits automatiquement à partir de l'entretien. Ils servent à accélérer votre lecture, pas à décider à votre place — ouvrez le rapport et vérifiez les citations qui les justifient.`,
      footer: `Vous recevez cet e-mail parce que vous avez accès à ce poste dans Interw.`,
      preheader: `${safeCandidate} a terminé son entretien pour le poste de ${safeJob}.`,
      cta: 'Ouvrir le rapport',
      text: [
        `${candidateName} a terminé son entretien pour le poste de ${jobTitle}.`,
        `Score global : ${score}/100. Recommandation : ${recommendation}.`,
        `Ouvrir le rapport :`,
        reportUrl,
        `Le score et la recommandation sont produits automatiquement. Ils accélèrent votre lecture ; ils ne décident pas à votre place.`,
      ],
    },
  })

  const html = layout({
    locale,
    preheader: c.preheader,
    heading: c.heading,
    paragraphs: [c.intro, c.score, c.caveat],
    cta: { label: c.cta, url: reportUrl },
    footer: c.footer,
  })

  return { subject: c.subject, html, text: plainText(c.text) }
}

/**
 * Sent to every member when an owner deletes the organisation. It exists so
 * that nobody loses their workspace without being told who removed it, and
 * so it says what happens to the data — not where to go, since there is no
 * longer anywhere to go.
 */
export function organizationDeletedEmail({
  locale,
  orgName,
  deletedBy,
}: {
  locale: EmailLocale
  orgName: string
  deletedBy: string
}) {
  const safeOrg = esc(orgName)
  const safeActor = esc(deletedBy)
  const c = pick(locale, {
    en: {
      subject: `${inSubject(orgName)} was deleted on ${APP_NAME}`,
      heading: `${safeOrg} was deleted`,
      intro: `<strong>${safeActor}</strong> deleted the organization <strong>${safeOrg}</strong>.`,
      followup: `Its roles, candidates, interview recordings and reports are being permanently erased, and nobody can access it any more. This cannot be undone.`,
      footer: `You are receiving this because you were a member of ${safeOrg}. Your ${APP_NAME} account itself is unchanged.`,
      preheader: `${safeActor} deleted ${safeOrg}.`,
      text: [
        `${deletedBy} deleted the organization ${orgName} on ${APP_NAME}.`,
        `Its roles, candidates, interview recordings and reports are being permanently erased, and nobody can access it any more. This cannot be undone.`,
        `You are receiving this because you were a member of ${orgName}. Your ${APP_NAME} account itself is unchanged.`,
      ],
    },
    fr: {
      subject: `${inSubject(orgName)} a été supprimée sur ${APP_NAME}`,
      heading: `${safeOrg} a été supprimée`,
      intro: `<strong>${safeActor}</strong> a supprimé l'organisation <strong>${safeOrg}</strong>.`,
      followup: `Ses postes, candidats, enregistrements d'entretien et rapports sont en cours d'effacement définitif, et plus personne n'y a accès. Cette action est irréversible.`,
      footer: `Vous recevez cet e-mail parce que vous étiez membre de ${safeOrg}. Votre compte ${APP_NAME} lui-même n'est pas modifié.`,
      preheader: `${safeActor} a supprimé ${safeOrg}.`,
      text: [
        `${deletedBy} a supprimé l'organisation ${orgName} sur ${APP_NAME}.`,
        `Ses postes, candidats, enregistrements d'entretien et rapports sont en cours d'effacement définitif, et plus personne n'y a accès. Cette action est irréversible.`,
        `Vous recevez cet e-mail parce que vous étiez membre de ${orgName}. Votre compte ${APP_NAME} lui-même n'est pas modifié.`,
      ],
    },
  })

  const html = layout({
    locale,
    preheader: c.preheader,
    heading: c.heading,
    paragraphs: [c.intro, c.followup],
    footer: c.footer,
  })

  return { subject: c.subject, html, text: plainText(c.text) }
}
