// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConvexError } from 'convex/values'
import { betterAuth } from 'better-auth/minimal'
import { memoryAdapter } from 'better-auth/adapters/memory'
import {
  accountLifecycle,
  setPasswordWithFreshSession,
} from './lib/accountLifecycle'

/**
 * Better Auth driven over HTTP on a memory adapter, with the account-lifecycle
 * plugin `createAuth` loads. The effects are recorded instead of reaching
 * Convex; `convex/users.test.ts` covers their database side.
 */
const BASE = 'http://localhost:3000'
const ALICE = 'alice@example.com'
const PASSWORD = 'alice-password-123'

function buildAuth() {
  const mail: Array<{ to: string; url: string }> = []
  const calls = {
    passwordChanged: [] as Array<string>,
    emailChangeRequested: [] as Array<[string, string]>,
  }
  const soleOwners = new Set<string>()
  const lastSuperAdmins = new Set<string>()
  const effects = {
    soleOwnedOrgs: (userId: string) =>
      Promise.resolve(soleOwners.has(userId) ? ['Acme'] : []),
    lastSuperAdmin: (userId: string) =>
      Promise.resolve(lastSuperAdmins.has(userId)),
    passwordChanged: (userId: string) => {
      calls.passwordChanged.push(userId)
      return Promise.resolve()
    },
    emailChangeRequested: (userId: string, newEmail: string) => {
      calls.emailChangeRequested.push([userId, newEmail])
      return Promise.resolve()
    },
  }
  const capture = ({ user, url }: { user: { email: string }; url: string }) => {
    mail.push({ to: user.email, url })
    return Promise.resolve()
  }
  const auth = betterAuth({
    baseURL: BASE,
    secret: 'test-secret-test-secret-test-secret-000',
    trustedOrigins: [BASE],
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    rateLimit: { enabled: false },
    session: { freshAge: 60 * 60 },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      sendResetPassword: capture,
      // Same wiring as `createAuth`.
      onPasswordReset: ({ user }) => effects.passwordChanged(user.id),
    },
    emailVerification: { sendVerificationEmail: capture },
    user: {
      changeEmail: { enabled: true, sendChangeEmailConfirmation: capture },
      deleteUser: {
        enabled: true,
        sendDeleteAccountVerification: capture,
      },
    },
    plugins: [accountLifecycle(effects)],
  })

  const post = (path: string, body: unknown, cookie?: string) =>
    auth.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: BASE,
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      }),
    )
  const get = (url: string, cookie?: string) =>
    auth.handler(
      new Request(new URL(url, BASE), { headers: cookie ? { cookie } : {} }),
    )
  const lastMailTo = (to: string) => {
    const found = mail.filter((m) => m.to === to).at(-1)
    if (!found) throw new Error(`no mail to ${to}`)
    return found.url
  }
  const context = () => auth.$context
  const signUp = async () => {
    const res = await post('/sign-up/email', {
      email: ALICE,
      password: PASSWORD,
      name: 'Alice',
    })
    const user = (await res.json()) as { user: { id: string } }
    return { cookie: cookieOf(res), userId: user.user.id }
  }
  const signIn = (password = PASSWORD) =>
    post('/sign-in/email', { email: ALICE, password })

  return {
    auth,
    get,
    post,
    mail,
    lastMailTo,
    calls,
    soleOwners,
    lastSuperAdmins,
    context,
    signUp,
    signIn,
  }
}

const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')

const location = (res: Response) => new URL(res.headers.get('location')!, BASE)

afterEach(() => {
  vi.useRealTimers()
})

describe('password-changed notice', () => {
  it('is sent by the server after a change, not after a failed attempt', async () => {
    const t = buildAuth()
    const { cookie, userId } = await t.signUp()

    const wrong = await t.post(
      '/change-password',
      { currentPassword: 'not-the-password', newPassword: 'another-password-456' },
      cookie,
    )
    expect(wrong.status).toBe(400)
    expect(t.calls.passwordChanged).toEqual([])

    const ok = await t.post(
      '/change-password',
      {
        currentPassword: PASSWORD,
        newPassword: 'another-password-456',
        revokeOtherSessions: true,
      },
      cookie,
    )
    expect(ok.status).toBe(200)
    expect(t.calls.passwordChanged).toEqual([userId])
  })

  it('is sent after a reset through the emailed link', async () => {
    const t = buildAuth()
    const { userId } = await t.signUp()
    await t.post('/request-password-reset', {
      email: ALICE,
      redirectTo: '/reset-password',
    })
    const landing = location(await t.get(t.lastMailTo(ALICE)))
    const token = landing.searchParams.get('token')!

    const res = await t.post('/reset-password', {
      token,
      newPassword: 'brand-new-password-789',
    })
    expect(res.status).toBe(200)
    expect(t.calls.passwordChanged).toEqual([userId])
  })
})

describe('email-change request', () => {
  it('is recorded, lower-cased, for a free address and a taken one alike', async () => {
    const t = buildAuth()
    await t.post('/sign-up/email', {
      email: 'taken@example.com',
      password: PASSWORD,
      name: 'Taken',
    })
    const { cookie, userId } = await t.signUp()

    await t.post('/change-email', { newEmail: 'New@Example.com' }, cookie)
    await t.post('/change-email', { newEmail: 'taken@example.com' }, cookie)
    // Same address: Better Auth refuses, nothing to record.
    await t.post('/change-email', { newEmail: ALICE }, cookie)

    expect(t.calls.emailChangeRequested).toEqual([
      [userId, 'new@example.com'],
      [userId, 'taken@example.com'],
    ])
  })
})

describe('account deletion', () => {
  it('is refused to a sole owner before any email goes out', async () => {
    const t = buildAuth()
    const { cookie, userId } = await t.signUp()
    t.soleOwners.add(userId)

    const res = await t.post('/delete-user', { callbackURL: '/account-deletion?status=deleted' }, cookie)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe('SOLE_OWNER')
    expect(t.mail).toEqual([])
  })

  it('is refused to the last super admin before any email goes out', async () => {
    const t = buildAuth()
    const { cookie, userId } = await t.signUp()
    t.lastSuperAdmins.add(userId)

    const res = await t.post('/delete-user', { callbackURL: '/account-deletion?status=deleted' }, cookie)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe('LAST_SUPER_ADMIN')
    expect(t.mail).toEqual([])
  })

  it('sends a link opened elsewhere to sign in, then deletes', async () => {
    const t = buildAuth()
    const { cookie } = await t.signUp()
    await t.post('/delete-user', { callbackURL: '/account-deletion?status=deleted' }, cookie)
    const link = t.lastMailTo(ALICE)

    // Another device, no session: a page, not FAILED_TO_GET_USER_INFO.
    const click = await t.get(link)
    expect(click.status).toBe(302)
    const landing = location(click)
    expect(landing.pathname).toBe('/account-deletion')
    expect(landing.searchParams.get('status')).toBe('signin')
    const next = landing.searchParams.get('next')!
    expect(next.startsWith('/api/auth/delete-user/callback?')).toBe(true)

    // The link survived the detour: sign in, follow `next`, account gone.
    const fresh = cookieOf(await t.signIn())
    const done = await t.get(next, fresh)
    expect(location(done).pathname).toBe('/account-deletion')
    expect(location(done).searchParams.get('status')).toBe('deleted')
    expect((await t.signIn()).status).toBe(401)
  })

  it('lands on a page for an unknown or expired link', async () => {
    const t = buildAuth()
    const { cookie } = await t.signUp()
    const unknown = await t.get(
      '/api/auth/delete-user/callback?token=nope&callbackURL=%2F',
      cookie,
    )
    expect(location(unknown).searchParams.get('status')).toBe('invalid')

    await t.post('/delete-user', { callbackURL: '/' }, cookie)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000)
    const expired = await t.get(t.lastMailTo(ALICE), cookie)
    expect(location(expired).searchParams.get('status')).toBe('invalid')
  })

  it('stops at the click for someone who became a sole owner meanwhile', async () => {
    const t = buildAuth()
    const { cookie, userId } = await t.signUp()
    await t.post('/delete-user', { callbackURL: '/' }, cookie)
    t.soleOwners.add(userId)

    const click = await t.get(t.lastMailTo(ALICE), cookie)
    expect(location(click).searchParams.get('status')).toBe('blocked')
    expect((await t.signIn()).status).toBe(200)
  })

  it('stops at the click for someone who became the last super admin meanwhile', async () => {
    const t = buildAuth()
    const { cookie, userId } = await t.signUp()
    await t.post('/delete-user', { callbackURL: '/' }, cookie)
    t.lastSuperAdmins.add(userId)

    const click = await t.get(t.lastMailTo(ALICE), cookie)
    expect(location(click).searchParams.get('status')).toBe('blocked')
    expect((await t.signIn()).status).toBe(200)
  })
})

describe('setting a first password', () => {
  async function passwordless(t: ReturnType<typeof buildAuth>) {
    const { cookie, userId } = await t.signUp()
    const ctx = await t.context()
    const credential = (await ctx.internalAdapter.findAccounts(userId)).find(
      (a) => a.providerId === 'credential',
    )!
    await ctx.internalAdapter.deleteAccount(credential.id)
    return new Headers({ cookie })
  }

  it('adds a credential for a fresh session with none', async () => {
    const t = buildAuth()
    const headers = await passwordless(t)
    expect((await t.signIn()).status).toBe(401)

    await setPasswordWithFreshSession(t.auth, headers, 'first-password-012')
    expect((await t.signIn('first-password-012')).status).toBe(200)
  })

  it('never replaces an existing password', async () => {
    const t = buildAuth()
    const { cookie } = await t.signUp()
    await expect(
      setPasswordWithFreshSession(t.auth, new Headers({ cookie }), 'hijacker-password-1'),
    ).rejects.toEqual(new ConvexError('password_already_set'))
    expect((await t.signIn()).status).toBe(200)
  })

  it('needs a session, and a recent one', async () => {
    const t = buildAuth()
    const headers = await passwordless(t)
    await expect(
      setPasswordWithFreshSession(t.auth, new Headers(), 'first-password-012'),
    ).rejects.toEqual(new ConvexError('unauthenticated'))

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000)
    await expect(
      setPasswordWithFreshSession(t.auth, headers, 'first-password-012'),
    ).rejects.toEqual(new ConvexError('session_not_fresh'))
  })

  it('enforces the minimum length', async () => {
    const t = buildAuth()
    const headers = await passwordless(t)
    await expect(
      setPasswordWithFreshSession(t.auth, headers, 'short'),
    ).rejects.toEqual(new ConvexError('password_too_short'))
  })
})
