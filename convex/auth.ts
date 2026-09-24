import { betterAuth } from 'better-auth/minimal'
import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { verifyJWT } from 'better-auth/crypto'
import { magicLink } from 'better-auth/plugins/magic-link'
import { createClient } from '@convex-dev/better-auth'
import { convex } from '@convex-dev/better-auth/plugins'
import { requireRunMutationCtx } from '@convex-dev/better-auth/utils'
import authConfig from './auth.config'
import { components, internal } from './_generated/api'
import { RESEND_FROM, resend } from './email'
import {
  changeEmailVerificationEmail,
  deleteAccountVerificationEmail,
  magicLinkEmail,
  resetPasswordEmail,
  verificationEmail,
} from './emailTemplates'
import { consumeLimit } from './rateLimiters'
import type { DataModel } from './_generated/dataModel'
import type { GenericCtx } from '@convex-dev/better-auth'

const siteUrl = process.env.SITE_URL!

if (
  process.env.APP_ENV === 'production' &&
  /(?:^|\/\/)(?:localhost|127\.0\.0\.1)(?::|\/|$)/.test(siteUrl)
) {
  throw new Error(
    `[interw] SITE_URL is "${siteUrl}" while APP_ENV=production. ` +
      'Emails would ship with broken links. Run: ' +
      'pnpm exec convex env set SITE_URL "https://your-domain" --prod',
  )
}

export const authComponent = createClient<DataModel>(components.betterAuth)

const isProd = process.env.APP_ENV === 'production'

// Google OAuth is optional in this template: the button only ships when both
// credentials are set in the Convex env. Google returns a verified email on
// first sign-in, so it satisfies the "all methods must be trusted" invariant
// that keeps account linking safe (see KNOWN_ISSUES.md). Redirect URI to
// register in Google Cloud Console: `${SITE_URL}/api/auth/callback/google`.
const googleEnabled = !!(
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
)

// Per-endpoint rate limits. Keys are Better Auth endpoint paths, matched
// exactly — a key naming no endpoint is silently ignored, so the test asserts
// every key resolves to a real route.
export const rateLimitRules = {
  '/sign-in/email': { window: 60, max: 5 },
  '/sign-up/email': { window: 60, max: 3 },
  '/request-password-reset': { window: 60, max: 3 },
  '/reset-password': { window: 60, max: 5 },
  '/sign-in/magic-link': { window: 60, max: 3 },
  '/sign-in/social': { window: 60, max: 10 },
  '/magic-link/verify': { window: 60, max: 5 },
  '/send-verification-email': { window: 60, max: 3 },
  '/verify-email': { window: 60, max: 10 },
  '/change-email': { window: 60, max: 3 },
  '/change-password': { window: 60, max: 5 },
  '/delete-user': { window: 60, max: 3 },
}

// A verification link proves control of a mailbox and nothing else. It says
// nothing about who chose the password on the account it points at: anyone can
// sign up — or move their own account — onto someone else's address. Left to
// Better Auth, `/verify-email` then verifies that account and signs the clicker
// into it, while the stranger's password keeps working on an identity now
// verified as the victim's. So a link never completes on its own: whoever
// clicks it must also prove the account's credential.
// See KNOWN_ISSUES.md § "Account linking & verified email".
export const verificationRequiresCredential = createAuthMiddleware(
  async (ctx) => {
    if (ctx.path === '/verify-email') {
      const query = ctx.query ?? {}
      const { token, callbackURL } = query
      // A missing, bad or expired token is Better Auth's to reject.
      if (typeof token !== 'string') return
      const payload = await verifyJWT(token, ctx.context.secret)
      if (!payload) return
      // Approving an email change only mails the new address.
      if (payload.requestType === 'change-email-confirmation') return
      const login = new URL('/login', ctx.context.baseURL)
      if (!payload.updateTo) {
        // Sign-up verification: completed by `/sign-in/email` below, once the
        // clicker has typed the account's password.
        login.searchParams.set('verifyToken', token)
        if (callbackURL) login.searchParams.set('redirect', callbackURL)
        throw ctx.redirect(login.toString())
      }
      // Email change: moves the account onto the clicked address, so the
      // clicker must already be signed in to it (Better Auth rejects a session
      // for another account). Otherwise sign in first, then come back here.
      if (await getSessionFromCtx(ctx)) return
      const back = `${new URL(ctx.context.baseURL).pathname}/verify-email?${new URLSearchParams(query)}`
      login.searchParams.set('redirect', back)
      throw ctx.redirect(login.toString())
    }
    if (ctx.path === '/sign-in/email') {
      const { email, password, verifyToken } = ctx.body ?? {}
      if (typeof verifyToken !== 'string' || typeof password !== 'string')
        return
      const payload = await verifyJWT(verifyToken, ctx.context.secret)
      if (
        !payload ||
        payload.updateTo ||
        typeof email !== 'string' ||
        payload.email !== email.toLowerCase()
      )
        return
      const found = await ctx.context.internalAdapter.findUserByEmail(
        payload.email,
        { includeAccounts: true },
      )
      const hash = found?.accounts.find(
        (a) => a.providerId === 'credential',
      )?.password
      if (!found || found.user.emailVerified || !hash) return
      if (!(await ctx.context.password.verify({ hash, password }))) return
      // Mailbox (token) and password proven in one request: verify, then let
      // the sign-in proceed and mint the session.
      await ctx.context.internalAdapter.updateUser(found.user.id, {
        emailVerified: true,
      })
    }
  },
)

export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth({
    baseURL: siteUrl,
    trustedOrigins: [siteUrl],
    database: authComponent.adapter(ctx),
    // Per-endpoint rate-limit. Storage `database` is backed by the Convex
    // adapter (auto-created `rateLimit` table). The global window/max apply
    // to anything not in customRules. Tight limits on sensitive paths.
    rateLimit: {
      enabled: true,
      window: 10,
      max: 100,
      storage: 'database',
      customRules: rateLimitRules,
    },
    hooks: { before: verificationRequiresCredential },
    // Force secure cookies in prod, sensible defaults everywhere. Without
    // explicit attributes BA's defaults vary by adapter — pin them.
    advanced: {
      useSecureCookies: isProd,
      cookiePrefix: 'interw',
      defaultCookieAttributes: {
        sameSite: 'lax',
        secure: isProd,
        httpOnly: true,
      },
    },
    onAPIError: {
      onError: (error: unknown) => {
        console.error('[ba-api-error]', {
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : undefined,
          stack: error instanceof Error ? error.stack : undefined,
        })
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // refresh once a day
      cookieCache: { enabled: true, maxAge: 60 * 5 }, // 5 min
      // `freshAge` is how recently a user must have authenticated for
      // sensitive ops (changeEmail, deleteUser, change-password). BA enforces
      // this when an endpoint asks for a fresh session.
      freshAge: 60 * 60, // 1h
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      // Server-side minimum. The Zod schemas in /register, /reset-password
      // and /me change-password mirror this — both layers must agree or the
      // form passes client validation and 400s on submit.
      minPasswordLength: 12,
      maxPasswordLength: 128,
      sendResetPassword: async (data: {
        user: { email: string }
        url: string
      }) => {
        const mutCtx = requireRunMutationCtx(ctx)
        await consumeLimit(
          mutCtx,
          'passwordResetSend',
          data.user.email.toLowerCase().trim(),
        )
        const locale = await mutCtx.runQuery(internal.users.localeForEmail, { email: data.user.email })
        const { subject, html, text } = resetPasswordEmail({
          locale,
          url: data.url,
        })
        await resend.sendEmail(mutCtx, {
          from: RESEND_FROM,
          to: data.user.email,
          subject,
          html,
          text,
        })
      },
      // Invalidate every other session on reset — basic account-takeover
      // mitigation if the previous password was leaked.
      revokeSessionsOnPasswordReset: true,
    },
    emailVerification: {
      sendOnSignUp: true,
      // No `autoSignInAfterVerification`: a link alone never signs anyone in
      // (see `verificationRequiresCredential`).
      sendVerificationEmail: async (data: {
        user: { email: string }
        url: string
      }) => {
        const mutCtx = requireRunMutationCtx(ctx)
        await consumeLimit(
          mutCtx,
          'verificationSend',
          data.user.email.toLowerCase().trim(),
        )
        const locale = await mutCtx.runQuery(internal.users.localeForEmail, { email: data.user.email })
        const { subject, html, text } = verificationEmail({
          locale,
          url: data.url,
        })
        await resend.sendEmail(mutCtx, {
          from: RESEND_FROM,
          to: data.user.email,
          subject,
          html,
          text,
        })
      },
    },
    ...(googleEnabled
      ? {
          socialProviders: {
            google: {
              clientId: process.env.GOOGLE_CLIENT_ID!,
              clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
              // Always show the account chooser so users can pick which Google
              // account to use instead of being silently signed in.
              prompt: 'select_account',
            },
          },
        }
      : {}),
    account: {
      accountLinking: {
        enabled: true,
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Token-gated email pre-verification. When a signup carries an
          // `inviteToken` that resolves to a still-pending invitation for the
          // SAME email, the invitation email already proved control of the
          // address, so we mark it verified and skip the verification
          // round-trip (otherwise the invitee verifies, lands on /app, and the
          // accept effect — which only lives on /accept-invite — never fires).
          // SECURITY: email alone never qualifies. The token must resolve to a
          // pending, unexpired invitation matching the email, or we leave
          // `emailVerified` untouched so the normal verification flow applies.
          before: async (
            user: { email: string } & Record<string, unknown>,
            context,
          ) => {
            const inviteToken = (
              context?.body as { inviteToken?: unknown } | undefined
            )?.inviteToken
            if (typeof inviteToken !== 'string' || !inviteToken) return
            const queryCtx = requireRunMutationCtx(ctx)
            const valid = await queryCtx.runQuery(
              internal.invitations.validateInviteForSignup,
              { token: inviteToken, email: user.email },
            )
            if (!valid) return
            return { data: { ...user, emailVerified: true } }
          },
        },
        update: {
          // Keep the Convex `users` row in sync when Better Auth mutates the
          // account — above all on `changeEmail`. A stale `users.email` would
          // let the email-fallback dedup in `provisionAppUser` re-point this
          // row to a future signup that reuses the freed old address (account
          // takeover). Keyed on the stable BA id, never on the email.
          after: async (user: {
            id: string
            email: string
            name?: string | null
          }) => {
            const mutCtx = requireRunMutationCtx(ctx)
            await mutCtx.runMutation(internal.users.syncBetterAuthUser, {
              betterAuthId: user.id,
              email: user.email,
              name: user.name ?? undefined,
            })
          },
        },
      },
    },
    user: {
      changeEmail: {
        enabled: true,
        // BA expects `sendChangeEmailConfirmation` — sending to the CURRENT
        // address so the legitimate owner approves before BA dispatches the
        // verification to the new one. The previous typo
        // (`sendChangeEmailVerification`) silently dropped this layer, letting
        // a hijacked session swap the email without notifying the rightful
        // user. See update-user.mjs in better-auth.
        sendChangeEmailConfirmation: async (data: {
          user: { email: string }
          newEmail: string
          url: string
        }) => {
          const mutCtx = requireRunMutationCtx(ctx)
          const locale = await mutCtx.runQuery(internal.users.localeForEmail, { email: data.user.email })
          const { subject, html, text } = changeEmailVerificationEmail({
            locale,
            url: data.url,
            newEmail: data.newEmail,
          })
          await resend.sendEmail(mutCtx, {
            from: RESEND_FROM,
            to: data.user.email,
            subject,
            html,
            text,
          })
        },
      },
      deleteUser: {
        enabled: true,
        sendDeleteAccountVerification: async (data: {
          user: { email: string; name?: string | null }
          url: string
        }) => {
          const mutCtx = requireRunMutationCtx(ctx)
          const locale = await mutCtx.runQuery(internal.users.localeForEmail, { email: data.user.email })
          const { subject, html, text } = deleteAccountVerificationEmail({
            locale,
            url: data.url,
            name: data.user.name ?? null,
          })
          await resend.sendEmail(mutCtx, {
            from: RESEND_FROM,
            to: data.user.email,
            subject,
            html,
            text,
          })
        },
        beforeDelete: async (user: { id: string }) => {
          const mutCtx = requireRunMutationCtx(ctx)
          await mutCtx.runMutation(internal.users.cascadeDelete, {
            betterAuthId: user.id,
          })
        },
      },
    },
    plugins: [
      magicLink({
        // We only let people in via /register. Without this, the plugin
        // silently creates a BA user on first link click — which breaks
        // the provisioning invariant and leaves password-less accounts
        // behind that can later 500 on signIn.email. See KNOWN_ISSUES.md.
        disableSignUp: true,
        sendMagicLink: async ({ email, url }) => {
          const mutCtx = requireRunMutationCtx(ctx)
          await consumeLimit(
            mutCtx,
            'magicLinkSend',
            email.toLowerCase().trim(),
          )
          const locale = await mutCtx.runQuery(internal.users.localeForEmail, { email })
          const { subject, html, text } = magicLinkEmail({ locale, url })
          await resend.sendEmail(mutCtx, {
            from: RESEND_FROM,
            to: email,
            subject,
            html,
            text,
          })
        },
      }),
      convex({ authConfig }),
    ],
  })
