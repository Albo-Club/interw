// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { betterAuth } from 'better-auth/minimal'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { verificationRequiresCredential } from './auth'

/**
 * Better Auth driven over HTTP on a memory adapter, with the options of
 * `createAuth` that decide who ends up holding a verified account. The
 * Convex adapter and the email senders are swapped out; the hook and the
 * rate-limit rules are the real ones.
 */
const BASE = 'http://localhost:3000'
const VICTIM = 'victim@example.com'
const ATTACKER = 'attacker@example.com'
const ATTACKER_PASSWORD = 'attacker-password-123'
const VICTIM_PASSWORD = 'victim-password-456'

function buildAuth() {
  const mail: Array<{ to: string; url: string }> = []
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
    hooks: { before: verificationRequiresCredential },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: capture,
    },
    account: { accountLinking: { enabled: true } },
    user: {
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: capture,
      },
    },
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
  const signUp = (email: string, password: string) =>
    post('/sign-up/email', { email, password, name: 'x', callbackURL: '/app' })
  const signIn = (email: string, password: string, verifyToken?: string) =>
    post('/sign-in/email', { email, password, verifyToken })
  const findUser = (email: string) =>
    auth.$context.then((c) => c.internalAdapter.findUserByEmail(email))

  return { get, post, lastMailTo, signUp, signIn, findUser }
}

const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')

const location = (res: Response) => new URL(res.headers.get('location')!, BASE)

describe('sign-up verification link', () => {
  it('does not bless a password someone else set on the address', async () => {
    const t = buildAuth()
    await t.signUp(VICTIM, ATTACKER_PASSWORD)

    // The mailbox owner clicks the link: sent to /login, signed into nothing.
    const click = await t.get(t.lastMailTo(VICTIM))
    expect(click.status).toBe(302)
    expect(click.headers.getSetCookie()).toEqual([])
    const login = location(click)
    expect(login.pathname).toBe('/login')
    expect((await t.findUser(VICTIM))?.user.emailVerified).toBe(false)

    // The owner cannot complete it with a password they never set…
    const token = login.searchParams.get('verifyToken')!
    expect((await t.signIn(VICTIM, VICTIM_PASSWORD, token)).status).toBe(401)
    // …and the stranger's password still opens nothing.
    expect((await t.signIn(VICTIM, ATTACKER_PASSWORD)).status).toBe(403)
    expect((await t.findUser(VICTIM))?.user.emailVerified).toBe(false)
  })

  it('verifies and signs in whoever holds both the link and the password', async () => {
    const t = buildAuth()
    await t.signUp(VICTIM, VICTIM_PASSWORD)

    const login = location(await t.get(t.lastMailTo(VICTIM)))
    expect(login.searchParams.get('redirect')).toBe('/app')
    const token = login.searchParams.get('verifyToken')!

    const res = await t.signIn(VICTIM, VICTIM_PASSWORD, token)
    expect(res.status).toBe(200)
    expect(cookieOf(res)).toContain('session_token')
    expect((await t.findUser(VICTIM))?.user.emailVerified).toBe(true)
    // Later sign-ins need no token.
    expect((await t.signIn(VICTIM, VICTIM_PASSWORD)).status).toBe(200)
  })

  it('ignores a token minted for another address', async () => {
    const t = buildAuth()
    await t.signUp(VICTIM, VICTIM_PASSWORD)
    await t.signUp(ATTACKER, ATTACKER_PASSWORD)
    const victimToken = location(await t.get(t.lastMailTo(VICTIM)))
      .searchParams.get('verifyToken')!

    expect((await t.signIn(ATTACKER, ATTACKER_PASSWORD, victimToken)).status).toBe(403)
    expect((await t.findUser(ATTACKER))?.user.emailVerified).toBe(false)
    expect((await t.findUser(VICTIM))?.user.emailVerified).toBe(false)
  })

  it('sends an expired link to /login with a notice, not to the app', async () => {
    const t = buildAuth()
    await t.signUp(VICTIM, VICTIM_PASSWORD)
    const link = t.lastMailTo(VICTIM)
    vi.useFakeTimers({ now: Date.now() + 2 * 60 * 60 * 1000, toFake: ['Date'] })
    try {
      const login = location(await t.get(link))
      expect(login.pathname).toBe('/login')
      expect(login.searchParams.get('verifyExpired')).toBe('1')
      expect(login.searchParams.get('redirect')).toBe('/app')
      expect(login.searchParams.has('verifyToken')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a forged token like an expired one', async () => {
    const t = buildAuth()
    const login = location(await t.get('/api/auth/verify-email?token=forged&callbackURL=%2Fapp'))
    expect(login.pathname).toBe('/login')
    expect(login.searchParams.get('verifyExpired')).toBe('1')
  })
})

describe('change-email verification link', () => {
  async function verifiedAccount(t: ReturnType<typeof buildAuth>) {
    await t.signUp(ATTACKER, ATTACKER_PASSWORD)
    const token = location(await t.get(t.lastMailTo(ATTACKER)))
      .searchParams.get('verifyToken')!
    return cookieOf(await t.signIn(ATTACKER, ATTACKER_PASSWORD, token))
  }

  async function requestChangeToVictim(t: ReturnType<typeof buildAuth>, cookie: string) {
    await t.post('/change-email', { newEmail: VICTIM, callbackURL: '/app' }, cookie)
    // The current address approves; the new address gets the verify link.
    await t.get(t.lastMailTo(ATTACKER))
    return t.lastMailTo(VICTIM)
  }

  it('does not move an account onto the address of whoever clicks', async () => {
    const t = buildAuth()
    const cookie = await verifiedAccount(t)
    const link = await requestChangeToVictim(t, cookie)

    const click = await t.get(link)
    expect(click.status).toBe(302)
    expect(click.headers.getSetCookie()).toEqual([])
    expect(location(click).pathname).toBe('/login')
    expect(await t.findUser(VICTIM)).toBeNull()
    expect((await t.signIn(VICTIM, ATTACKER_PASSWORD)).status).toBe(401)
  })

  it('completes for the account holder, signed in or after signing in', async () => {
    const t = buildAuth()
    const cookie = await verifiedAccount(t)
    const link = await requestChangeToVictim(t, cookie)

    // Clicked on another device: sign in first, then follow the redirect.
    const redirect = location(await t.get(link)).searchParams.get('redirect')!
    const fresh = cookieOf(await t.signIn(ATTACKER, ATTACKER_PASSWORD))
    const done = await t.get(redirect, fresh)
    expect(location(done).pathname).toBe('/app')
    expect((await t.findUser(VICTIM))?.user.emailVerified).toBe(true)
    expect(await t.findUser(ATTACKER)).toBeNull()
  })
})
