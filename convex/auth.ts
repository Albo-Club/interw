import { betterAuth } from 'better-auth/minimal'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { makeSignature, verifyJWT } from 'better-auth/crypto'
import { emailOTP } from 'better-auth/plugins/email-otp'
import { createClient } from '@convex-dev/better-auth'
import { convex } from '@convex-dev/better-auth/plugins'
import { requireRunMutationCtx } from '@convex-dev/better-auth/utils'
import authConfig from './auth.config'
import { components, internal } from './_generated/api'
import { RESEND_FROM, resend } from './email'
import {
  changeEmailVerificationEmail,
  deleteAccountVerificationEmail,
  newEmailVerificationEmail,
  resetPasswordEmail,
  signInCodeEmail,
  verificationEmail,
} from './emailTemplates'
import { accountLifecycle } from './lib/accountLifecycle'
import { CLIENT_IP_HEADER } from './lib/clientIp'
import { localeFromHeaders } from './lib/locale'
import { rateLimiter } from './rateLimiters'
import type { AccountLifecycleEffects } from './lib/accountLifecycle'
import type { DataModel } from './_generated/dataModel'
import type { GenericCtx } from '@convex-dev/better-auth'
import type { BetterAuthPlugin } from 'better-auth/types'

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
  '/request-password-reset': { window: 60, max: 3 },
  '/reset-password': { window: 60, max: 5 },
  '/email-otp/send-verification-otp': { window: 60, max: 3 },
  // Per address, the code itself allows five tries; this caps one client
  // cycling through addresses.
  '/sign-in/email-otp': { window: 60, max: 10 },
  '/sign-in/social': { window: 60, max: 10 },
  '/send-verification-email': { window: 60, max: 3 },
  '/verify-email': { window: 60, max: 10 },
  '/change-email': { window: 60, max: 3 },
  '/change-password': { window: 60, max: 5 },
  '/delete-user': { window: 60, max: 3 },
}

// Email sign-in is a six-digit code, valid ten minutes, five tries, stored only
// as a hash. The email also carries a link to our page with the code in the
// fragment, which signs in only when the person presses Confirm.
// See KNOWN_ISSUES.md § "Email sign-in: one code, typed or confirmed".
export const emailCodeOptions = {
  otpLength: 6,
  expiresIn: 10 * 60,
  allowedAttempts: 5,
  storeOTP: 'hashed',
} as const

/** The link in the code email. The fragment never reaches a server log. */
export const emailCodeLink = (baseUrl: string, email: string, code: string) =>
  `${new URL('/login/code', baseUrl)}#${new URLSearchParams({ email, code })}`

// The email-OTP plugin ships endpoints that verify an address, reset a
// password or change an email with a code. We only ever send sign-in codes,
// and a code minted for one of these but never mailed is still a six-digit
// secret someone could guess at, so they are not served at all.
export const disabledAuthPaths = [
  '/email-otp/check-verification-otp',
  '/email-otp/verify-email',
  '/email-otp/request-password-reset',
  '/forget-password/email-otp',
  '/email-otp/reset-password',
  '/email-otp/request-email-change',
  '/email-otp/change-email',
]

export type EmailQuota =
  | 'emailCodeSend'
  | 'verificationSend'
  | 'passwordResetSend'
  | 'passwordSignIn'

const QUOTA_BY_PATH: Partial<Record<string, EmailQuota>> = {
  '/email-otp/send-verification-otp': 'emailCodeSend',
  '/send-verification-email': 'verificationSend',
  '/request-password-reset': 'passwordResetSend',
  // Password guesses against one account. Better Auth's own limit is per IP,
  // and the IP is whatever header the request carries: a guesser posting
  // straight to the deployment's `.convex.site` can name a new one each time.
  // See KNOWN_ISSUES.md § "Brute force: the IP is a claim, the account is not".
  '/sign-in/email': 'passwordSignIn',
}

/**
 * Per-address quota on every endpoint that emails someone, and on password
 * sign-in, charged before Better Auth does anything. Two reasons it cannot
 * live in the email senders:
 * a sender only runs for an address that has an account, so a quota refusal
 * there tells a stranger the account exists; and the code endpoint replaces
 * the pending code before calling its sender, so a refused send would still
 * rotate the victim's code — an unlimited stream of fresh codes to guess at.
 * A refusal is a real 429, not a 500 the page would read as "sent".
 * The bucket key is an HMAC of the address under the auth secret, so the
 * limiter's table never holds the address itself.
 */
export const perEmailQuota = (
  withinQuota: (quota: EmailQuota, key: string) => Promise<boolean>,
) =>
  ({
    id: 'per-email-quota',
    hooks: {
      before: [
        {
          matcher: (ctx) => !!ctx.path && !!QUOTA_BY_PATH[ctx.path],
          handler: createAuthMiddleware(async (ctx) => {
            const { email, type } = (ctx.body ?? {}) as Record<string, unknown>
            if (
              ctx.path === '/email-otp/send-verification-otp' &&
              type !== 'sign-in'
            )
              throw new APIError('BAD_REQUEST', { message: 'Invalid OTP type' })
            // A missing or malformed address is Better Auth's to reject.
            if (typeof email !== 'string') return
            const quota = QUOTA_BY_PATH[ctx.path]!
            const key = await makeSignature(
              email.trim().toLowerCase(),
              ctx.context.secret,
            )
            if (!(await withinQuota(quota, key)))
              throw new APIError('TOO_MANY_REQUESTS', {
                code: 'RATE_LIMITED',
                message: 'Too many requests for this address. Try again later.',
              })
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin

// Sign-in requests whose account held a password nobody ever proved, by
// request. Filled before the code is checked, read once it has signed in.
const unprovenPassword = new WeakMap<Request, string>()

/**
 * A code sign-in to an unverified account deletes that account's password
 * first (Better Auth's `revokeUnprovenAccountAccess`): it may be a stranger's,
 * set on the address before its owner ever showed up. Right — but silent: a
 * person who did choose that password would find it rejected with no
 * explanation. So the sign-in response says it happened, from what the server
 * saw — a password before the code, none after — never from a guess.
 */
export const revokedPasswordNotice = {
  id: 'revoked-password-notice',
  hooks: {
    before: [
      {
        matcher: (ctx) => ctx.path === '/sign-in/email-otp',
        handler: createAuthMiddleware(async (ctx) => {
          const { email } = (ctx.body ?? {}) as Record<string, unknown>
          if (typeof email !== 'string' || !ctx.request) return
          const found = await ctx.context.internalAdapter.findUserByEmail(
            email.toLowerCase(),
            { includeAccounts: true },
          )
          if (
            found &&
            !found.user.emailVerified &&
            found.accounts.some((a) => a.providerId === 'credential')
          )
            unprovenPassword.set(ctx.request, found.user.id)
        }),
      },
    ],
    after: [
      {
        matcher: (ctx) => ctx.path === '/sign-in/email-otp',
        handler: createAuthMiddleware(async (ctx) => {
          const userId = ctx.request && unprovenPassword.get(ctx.request)
          if (!userId || ctx.context.newSession?.user.id !== userId) return
          const accounts = await ctx.context.internalAdapter.findAccounts(userId)
          if (accounts.some((a) => a.providerId === 'credential')) return
          return ctx.json({
            ...(ctx.context.returned as Record<string, unknown>),
            passwordRevoked: true,
          })
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin

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
      // A missing token is Better Auth's to reject.
      if (typeof token !== 'string') return
      const payload = await verifyJWT(token, ctx.context.secret)
      const login = new URL('/login', ctx.context.baseURL)
      if (!payload) {
        // Expired or bad: Better Auth would bounce to `${callbackURL}?error=`,
        // and the /app guard drops the error on its way to a bare /login.
        // Say it on /login instead, where the Resend button lives.
        login.searchParams.set('verifyExpired', '1')
        if (callbackURL) login.searchParams.set('redirect', callbackURL)
        throw ctx.redirect(login.toString())
      }
      // Approving an email change only mails the new address.
      if (payload.requestType === 'change-email-confirmation') return
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

// What the account-lifecycle hooks do to the database. Resolved lazily: a
// query can build `createAuth` too, and only endpoints that write reach these.
const lifecycleEffects = (
  ctx: GenericCtx<DataModel>,
): AccountLifecycleEffects => ({
  soleOwnedOrgs: (userId) =>
    requireRunMutationCtx(ctx).runQuery(internal.users.soleOwnedOrgNames, {
      betterAuthId: userId,
    }),
  lastSuperAdmin: (userId) =>
    requireRunMutationCtx(ctx).runQuery(internal.users.lastSuperAdmin, {
      betterAuthId: userId,
    }),
  passwordChanged: async (userId) => {
    // The change is committed by now; a failed notice must not report it as
    // failed, so it is logged rather than rethrown.
    try {
      await requireRunMutationCtx(ctx).runMutation(
        internal.notifications.passwordChanged,
        { betterAuthId: userId },
      )
    } catch (error) {
      console.error('[password-changed-notice] failed', {
        userId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  },
  emailChangeRequested: async (userId, newEmail) => {
    await requireRunMutationCtx(ctx).runMutation(
      internal.users.recordEmailChangeRequested,
      { betterAuthId: userId, newEmail },
    )
  },
})

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  // Language for an email: the recipient's stored preference, else the
  // language of the request that triggered it.
  const emailLocale = (email: string, headers?: Headers | null) =>
    requireRunMutationCtx(ctx).runQuery(internal.users.localeForEmail, {
      email,
      fallback: localeFromHeaders(headers),
    })
  return betterAuth({
    baseURL: siteUrl,
    trustedOrigins: [siteUrl],
    database: authComponent.adapter(ctx),
    disabledPaths: disabledAuthPaths,
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
      // Per-IP limits key on the address the web server's proxy observed, in
      // a header of its own. A request sent straight to `.convex.site` can
      // still claim any address here; `perEmailQuota` is what bounds it.
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    onAPIError: {
      // Where an OAuth callback lands when it fails before its own error URL
      // is known (bad or missing state): the sign-in page, which says so,
      // rather than Better Auth's bare error page.
      errorURL: new URL('/login', siteUrl).toString(),
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
      // `freshAge` is how recently a user must have signed in for the
      // endpoints BA 1.6.30 guards with `freshSessionMiddleware`: only
      // `/list-sessions` and `/unlink-account`. change-email, change-password
      // and delete-user (with its email link) ask for a session, not a fresh
      // one. `users.setPassword` applies it too, on its own.
      freshAge: 60 * 60, // 1h
    },
    emailAndPassword: {
      enabled: true,
      // Accounts are created by an email code or Google, both of which prove
      // the address. A password is only ever added to an existing account
      // (reset flow), never the way in: sign-up with one was how a stranger
      // squatted an address. Legacy password accounts still sign in.
      disableSignUp: true,
      requireEmailVerification: true,
      // Server-side minimum. The Zod schemas in /reset-password
      // and /me change-password mirror this — both layers must agree or the
      // form passes client validation and 400s on submit.
      minPasswordLength: 12,
      maxPasswordLength: 128,
      sendResetPassword: async (
        data: { user: { email: string }; url: string },
        request?: Request,
      ) => {
        const mutCtx = requireRunMutationCtx(ctx)
        const locale = await emailLocale(data.user.email, request?.headers)
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
      onPasswordReset: ({ user }) =>
        lifecycleEffects(ctx).passwordChanged(user.id),
    },
    emailVerification: {
      sendOnSignUp: true,
      // No `autoSignInAfterVerification`: a link alone never signs anyone in
      // (see `verificationRequiresCredential`).
      sendVerificationEmail: async (
        data: { user: { id: string; email: string }; url: string },
        request?: Request,
      ) => {
        const mutCtx = requireRunMutationCtx(ctx)
        // Step 2 of an email change reuses this sender; it gets its own copy.
        const change = await mutCtx.runMutation(
          internal.users.recordEmailChangeApproved,
          { betterAuthId: data.user.id, newEmail: data.user.email },
        )
        const { subject, html, text } = change
          ? newEmailVerificationEmail({
              locale: change.locale,
              url: data.url,
              oldEmail: change.oldEmail,
              newEmail: data.user.email,
            })
          : verificationEmail({
              locale: await emailLocale(data.user.email, request?.headers),
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
        // BA's default is 24 h; the UI and the email promise one hour, like
        // every other link we send.
        deleteTokenExpiresIn: 60 * 60,
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
      emailOTP({
        ...emailCodeOptions,
        sendVerificationOTP: async ({ email, otp, type }, endpointCtx) => {
          // `perEmailQuota` refuses every other type before a code exists.
          if (type !== 'sign-in') return
          const mutCtx = requireRunMutationCtx(ctx)
          const locale = await emailLocale(email, endpointCtx?.request?.headers)
          const { subject, html, text } = signInCodeEmail({
            locale,
            code: otp,
            url: emailCodeLink(siteUrl, email, otp),
          })
          await resend.sendEmail(mutCtx, {
            from: RESEND_FROM,
            to: email,
            subject,
            html,
            text,
          })
        },
      }),
      perEmailQuota(async (quota, key) => {
        const { ok } = await rateLimiter.limit(requireRunMutationCtx(ctx), quota, {
          key,
        })
        return ok
      }),
      revokedPasswordNotice,
      accountLifecycle(lifecycleEffects(ctx)),
      convex({ authConfig }),
    ],
  })
}
