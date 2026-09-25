import { ConvexError } from 'convex/values'
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
} from 'better-auth/api'
import type { BetterAuthPlugin } from 'better-auth'

/**
 * Account-lifecycle rules that live at the Better Auth layer: what happens
 * around a password change, an email change and an account deletion.
 *
 * Kept free of Convex so it runs on Better Auth's memory adapter in tests
 * (`convex/accountLifecycle.test.ts`); `convex/auth.ts` wires the effects to
 * the database.
 */
export type AccountLifecycleEffects = {
  /** Names of the organisations this Better Auth user is the only owner of. */
  soleOwnedOrgs: (userId: string) => Promise<Array<string>>
  /** Tell the account holder their password changed. Must not throw. */
  passwordChanged: (userId: string) => Promise<void>
  /** Record that an email change was requested, for the profile page. */
  emailChangeRequested: (userId: string, newEmail: string) => Promise<void>
}

/** The app page every deletion link lands on, whatever happened. */
export const ACCOUNT_DELETION_PAGE = '/account-deletion'

export type AccountDeletionStatus = 'deleted' | 'signin' | 'invalid' | 'blocked'

export function accountLifecycle(effects: AccountLifecycleEffects) {
  return {
    id: 'account-lifecycle',
    hooks: {
      before: [
        {
          // Refused before any email goes out: a sole owner would otherwise
          // get a link that can only fail.
          matcher: (ctx) => ctx.path === '/delete-user',
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx)
            // No session: Better Auth's own middleware rejects the call.
            if (!session) return
            if ((await effects.soleOwnedOrgs(session.user.id)).length > 0) {
              throw APIError.from('BAD_REQUEST', {
                code: 'SOLE_OWNER',
                message: 'Transfer ownership of your organizations first',
              })
            }
          }),
        },
        {
          // Left to Better Auth, every way this link can fail — opened on a
          // device with no session, expired, blocked by `beforeDelete` —
          // answers with raw JSON. Resolve each case to a page instead. The
          // token is only read here, never consumed, so the link still works
          // after signing in.
          matcher: (ctx) => ctx.path === '/delete-user/callback',
          handler: createAuthMiddleware(async (ctx) => {
            const query = (ctx.query ?? {}) as Record<string, string>
            const land = (status: AccountDeletionStatus, next?: string) => {
              const url = new URL(ACCOUNT_DELETION_PAGE, ctx.context.baseURL)
              url.searchParams.set('status', status)
              if (next) url.searchParams.set('next', next)
              return ctx.redirect(url.toString())
            }
            if (typeof query.token !== 'string') throw land('invalid')
            const stored = await ctx.context.internalAdapter.findVerificationValue(
              `delete-account-${query.token}`,
            )
            if (!stored || new Date(stored.expiresAt) < new Date()) {
              throw land('invalid')
            }
            const session = await getSessionFromCtx(ctx)
            if (session?.user.id !== stored.value) {
              // Signed out, or signed in to another account: sign in to the
              // one being deleted, then come back to this exact link.
              const back = `${new URL(ctx.context.baseURL).pathname}/delete-user/callback?${new URLSearchParams(query)}`
              throw land('signin', back)
            }
            if ((await effects.soleOwnedOrgs(stored.value)).length > 0) {
              throw land('blocked')
            }
          }),
        },
      ],
      after: [
        {
          // Sent from here rather than by the page that called the endpoint,
          // so a change made through the API alone still notifies the owner.
          matcher: (ctx) => ctx.path === '/change-password',
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned as
              | { user?: { id?: string } }
              | undefined
            if (isAPIError(returned)) return
            const userId = returned?.user?.id
            if (userId) await effects.passwordChanged(userId)
          }),
        },
        {
          // Recorded whether or not Better Auth mailed anyone: for an address
          // already in use it answers success and sends nothing, and the
          // profile must look the same either way (anti-enumeration).
          matcher: (ctx) => ctx.path === '/change-email',
          handler: createAuthMiddleware(async (ctx) => {
            if (isAPIError(ctx.context.returned)) return
            const session =
              ctx.context.session ?? (await getSessionFromCtx(ctx))
            const newEmail = (ctx.body as { newEmail?: unknown } | undefined)
              ?.newEmail
            if (!session || typeof newEmail !== 'string') return
            await effects.emailChangeRequested(
              session.user.id,
              newEmail.toLowerCase(),
            )
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin
}

type SetPasswordAuth = {
  api: {
    getSession: (input: {
      headers: Headers
    }) => Promise<{ session: { createdAt: Date | string } } | null>
    setPassword: (input: {
      body: { newPassword: string }
      headers: Headers
    }) => Promise<unknown>
  }
  $context: Promise<{ sessionConfig: { freshAge: number } }>
}

/**
 * Add a password to an account that has none (Google-only, or created
 * without one). Better Auth ships `setPassword` as a server-only API that
 * only asks for a session; we also ask that the session be fresh, as for any
 * change to how the account signs in.
 */
export async function setPasswordWithFreshSession(
  auth: SetPasswordAuth,
  headers: Headers,
  newPassword: string,
): Promise<void> {
  const session = await auth.api.getSession({ headers })
  if (!session) throw new ConvexError('unauthenticated')
  const { freshAge } = (await auth.$context).sessionConfig
  const age = Date.now() - new Date(session.session.createdAt).getTime()
  if (freshAge !== 0 && age >= freshAge * 1000) {
    throw new ConvexError('session_not_fresh')
  }
  try {
    await auth.api.setPassword({ body: { newPassword }, headers })
  } catch (error) {
    if (isAPIError(error)) {
      const code = (error.body as { code?: string } | undefined)?.code
      if (code === 'PASSWORD_ALREADY_SET') throw new ConvexError('password_already_set')
      if (code === 'PASSWORD_TOO_SHORT') throw new ConvexError('password_too_short')
      if (code === 'PASSWORD_TOO_LONG') throw new ConvexError('password_too_long')
    }
    throw error
  }
}
