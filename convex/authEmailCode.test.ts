// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { betterAuth } from 'better-auth/minimal'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { emailOTP } from 'better-auth/plugins/email-otp'
import {
  disabledAuthPaths,
  emailCodeLink,
  emailCodeOptions,
  perEmailQuota,
  rateLimitRules,
  revokedPasswordNotice,
  verificationRequiresCredential,
} from './auth'
import { signInCodeEmail } from './emailTemplates'
import type { EmailQuota } from './auth'

/**
 * Email-code sign-in driven over HTTP on a memory adapter, with the plugins,
 * options and hooks `createAuth` uses. The Convex adapter, the rate limiter
 * and the email senders are swapped out. Password sign-up stays enabled here
 * only to create the legacy accounts that predate codes.
 */
const BASE = 'http://localhost:3000'
const VICTIM = 'victim@example.com'
const STRANGER = 'stranger@example.com'
const SQUATTER_PASSWORD = 'squatter-password-123'
const OWNER_PASSWORD = 'owner-password-456'

function buildAuth({
  quota = () => true,
}: { quota?: (name: EmailQuota, email: string) => boolean } = {}) {
  const codes: Array<{ email: string; otp: string; type: string }> = []
  const links: Array<{ to: string; url: string }> = []
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
    disabledPaths: disabledAuthPaths,
    hooks: { before: verificationRequiresCredential },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
    },
    emailVerification: {
      sendVerificationEmail: ({ user, url }) => {
        links.push({ to: user.email, url })
        return Promise.resolve()
      },
    },
    account: { accountLinking: { enabled: true } },
    plugins: [
      emailOTP({
        ...emailCodeOptions,
        sendVerificationOTP: (data) => {
          codes.push(data)
          return Promise.resolve()
        },
      }),
      perEmailQuota((name, email) => Promise.resolve(quota(name, email))),
      revokedPasswordNotice,
    ],
  })

  const post = (path: string, body: unknown) =>
    auth.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify(body),
      }),
    )
  const sendCode = (email: string, type = 'sign-in') =>
    post('/email-otp/send-verification-otp', { email, type })
  const lastCode = (email: string) => {
    const found = codes.filter((c) => c.email === email).at(-1)
    if (!found) throw new Error(`no code to ${email}`)
    return found.otp
  }
  const signInWithCode = (email: string, otp: string) =>
    post('/sign-in/email-otp', { email, otp })
  const signUp = (email: string, password: string) =>
    post('/sign-up/email', { email, password, name: 'x', callbackURL: '/app' })
  const signIn = (email: string, password: string, verifyToken?: string) =>
    post('/sign-in/email', { email, password, verifyToken })
  const get = (url: string) => auth.handler(new Request(new URL(url, BASE)))
  const findUser = (email: string) =>
    auth.$context.then((c) =>
      c.internalAdapter.findUserByEmail(email, { includeAccounts: true }),
    )

  return {
    codes,
    links,
    post,
    get,
    sendCode,
    lastCode,
    signInWithCode,
    signUp,
    signIn,
    findUser,
  }
}

const errorCode = async (res: Response) =>
  ((await res.json()) as { code?: string }).code

describe('email code sign-in', () => {
  it('creates a verified account for a new address, with no name yet', async () => {
    const t = buildAuth()
    expect((await t.sendCode(VICTIM)).status).toBe(200)
    const code = t.lastCode(VICTIM)
    expect(code).toMatch(/^\d{6}$/)

    const res = await t.signInWithCode(VICTIM, code)
    expect(res.status).toBe(200)
    expect(res.headers.getSetCookie().join(';')).toContain('session_token')
    const body = (await res.json()) as { user: { name: string } }
    expect(body.user.name).toBe('')
    expect(body).not.toHaveProperty('passwordRevoked')

    const found = await t.findUser(VICTIM)
    expect(found?.user.emailVerified).toBe(true)
    expect(found?.accounts).toEqual([])
  })

  it('answers the same for an address with and without an account', async () => {
    const t = buildAuth()
    await t.signUp(STRANGER, OWNER_PASSWORD)
    const known = await t.sendCode(STRANGER)
    const unknown = await t.sendCode(VICTIM)
    expect(known.status).toBe(unknown.status)
    expect(await known.json()).toEqual(await unknown.json())
    expect(t.codes.map((c) => c.email)).toEqual([STRANGER, VICTIM])
  })

  it('spends a code once', async () => {
    const t = buildAuth()
    await t.sendCode(VICTIM)
    const code = t.lastCode(VICTIM)
    expect((await t.signInWithCode(VICTIM, code)).status).toBe(200)
    const again = await t.signInWithCode(VICTIM, code)
    expect(again.status).toBe(400)
    expect(await errorCode(again)).toBe('INVALID_OTP')
  })

  it('rejects a wrong code, and still accepts the right one after', async () => {
    const t = buildAuth()
    await t.sendCode(VICTIM)
    const code = t.lastCode(VICTIM)
    const wrong = code === '000000' ? '111111' : '000000'
    const res = await t.signInWithCode(VICTIM, wrong)
    expect(res.status).toBe(400)
    expect(await errorCode(res)).toBe('INVALID_OTP')
    expect((await t.signInWithCode(VICTIM, code)).status).toBe(200)
  })

  it('locks the code after five wrong tries, until a new one is sent', async () => {
    const t = buildAuth()
    await t.sendCode(VICTIM)
    const code = t.lastCode(VICTIM)
    const wrong = code === '000000' ? '111111' : '000000'
    for (let i = 0; i < emailCodeOptions.allowedAttempts; i++)
      expect((await t.signInWithCode(VICTIM, wrong)).status).toBe(400)

    const locked = await t.signInWithCode(VICTIM, code)
    expect(locked.status).toBe(403)
    expect(await errorCode(locked)).toBe('TOO_MANY_ATTEMPTS')
    expect(await t.findUser(VICTIM)).toBeNull()

    await t.sendCode(VICTIM)
    expect((await t.signInWithCode(VICTIM, t.lastCode(VICTIM))).status).toBe(200)
  })

  it('refuses a code after ten minutes', async () => {
    const t = buildAuth()
    await t.sendCode(VICTIM)
    const code = t.lastCode(VICTIM)
    vi.useFakeTimers({ now: Date.now() + 11 * 60 * 1000, toFake: ['Date'] })
    try {
      const res = await t.signInWithCode(VICTIM, code)
      expect(res.status).toBe(400)
      expect(await errorCode(res)).toBe('OTP_EXPIRED')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not accept a code sent to another address', async () => {
    const t = buildAuth()
    await t.sendCode(STRANGER)
    await t.sendCode(VICTIM)
    const res = await t.signInWithCode(VICTIM, t.lastCode(STRANGER))
    // Unless both codes happen to be equal — one chance in a million.
    if (t.lastCode(STRANGER) === t.lastCode(VICTIM)) return
    expect(res.status).toBe(400)
    expect(await t.findUser(VICTIM)).toBeNull()
  })
})

describe('an address someone squatted with a password', () => {
  it("deletes the stranger's password when the owner signs in by code, and says so", async () => {
    const t = buildAuth()
    // Legacy path: a password account set up on the victim's address, never
    // verified (the stranger cannot open the victim's mailbox).
    await t.signUp(VICTIM, SQUATTER_PASSWORD)
    expect((await t.signIn(VICTIM, SQUATTER_PASSWORD)).status).toBe(403)

    await t.sendCode(VICTIM)
    const res = await t.signInWithCode(VICTIM, t.lastCode(VICTIM))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ passwordRevoked: true })
    // Rewriting the body keeps the session the sign-in just opened.
    expect(res.headers.getSetCookie().join(';')).toContain('session_token')

    const found = await t.findUser(VICTIM)
    expect(found?.user.emailVerified).toBe(true)
    expect(found?.accounts.some((a) => a.providerId === 'credential')).toBe(false)
    // The stranger's password now opens nothing.
    expect((await t.signIn(VICTIM, SQUATTER_PASSWORD)).status).toBe(401)
  })

  it("keeps a verified account's password, and says nothing", async () => {
    const t = buildAuth()
    await t.signUp(VICTIM, OWNER_PASSWORD)
    // Verified the legacy way: the link, then the password with its token.
    const click = await t.get(t.links.find((l) => l.to === VICTIM)!.url)
    const verifyToken = new URL(click.headers.get('location')!, BASE)
      .searchParams.get('verifyToken')!
    expect((await t.signIn(VICTIM, OWNER_PASSWORD, verifyToken)).status).toBe(200)

    await t.sendCode(VICTIM)
    const res = await t.signInWithCode(VICTIM, t.lastCode(VICTIM))
    expect(res.status).toBe(200)
    expect(await res.json()).not.toHaveProperty('passwordRevoked')
    expect((await t.signIn(VICTIM, OWNER_PASSWORD)).status).toBe(200)
  })

  it('does not flag a sign-in whose code was wrong', async () => {
    const t = buildAuth()
    await t.signUp(VICTIM, SQUATTER_PASSWORD)
    await t.sendCode(VICTIM)
    const code = t.lastCode(VICTIM)
    const wrong = code === '000000' ? '111111' : '000000'
    const res = await t.signInWithCode(VICTIM, wrong)
    expect(res.status).toBe(400)
    expect(await res.json()).not.toHaveProperty('passwordRevoked')
    const found = await t.findUser(VICTIM)
    expect(found?.accounts.some((a) => a.providerId === 'credential')).toBe(true)
  })
})

describe('endpoints the app does not serve', () => {
  it('refuses to mint a code for anything but sign-in', async () => {
    const t = buildAuth()
    await t.signUp(VICTIM, SQUATTER_PASSWORD)
    for (const type of ['forget-password', 'email-verification', 'change-email'])
      expect((await t.sendCode(VICTIM, type)).status).toBe(400)
    expect(t.codes).toEqual([])
  })

  it('does not serve code-based verify, reset or email change', async () => {
    const t = buildAuth()
    for (const path of disabledAuthPaths)
      expect((await t.post(path, { email: VICTIM, otp: '123456' })).status).toBe(404)
  })
})

describe('per-address email quota', () => {
  it('refuses with a 429 once spent, whether or not the account exists', async () => {
    const spent = new Set([VICTIM, STRANGER])
    const t = buildAuth({ quota: (_, email) => !spent.has(email) })
    await t.signUp(STRANGER, OWNER_PASSWORD)

    for (const email of [VICTIM, STRANGER]) {
      const res = await t.sendCode(email)
      expect(res.status).toBe(429)
      expect(await errorCode(res)).toBe('RATE_LIMITED')
      const reset = await t.post('/request-password-reset', {
        email,
        redirectTo: '/reset-password',
      })
      expect(reset.status).toBe(429)
      const verify = await t.post('/send-verification-email', { email })
      expect(verify.status).toBe(429)
    }
  })

  it('charges the right bucket, keyed by the normalised address', async () => {
    const charged: Array<[EmailQuota, string]> = []
    const t = buildAuth({
      quota: (name, email) => {
        charged.push([name, email])
        return true
      },
    })
    await t.sendCode('  Victim@Example.com ')
    await t.post('/request-password-reset', { email: VICTIM })
    await t.post('/send-verification-email', { email: VICTIM })
    expect(charged).toEqual([
      ['emailCodeSend', VICTIM],
      ['passwordResetSend', VICTIM],
      ['verificationSend', VICTIM],
    ])
  })

  // T12: password guesses were limited per IP only.
  it('limits password sign-in per address, whether or not it exists', async () => {
    const charged: Array<[EmailQuota, string]> = []
    const t = buildAuth({
      quota: (name, email) => {
        charged.push([name, email])
        return name !== 'signInAttempt'
      },
    })
    await t.signUp(STRANGER, OWNER_PASSWORD)
    for (const email of [VICTIM, STRANGER]) {
      const res = await t.signIn(email, OWNER_PASSWORD)
      expect(res.status).toBe(429)
      expect(await errorCode(res)).toBe('RATE_LIMITED')
    }
    expect(charged.filter(([name]) => name === 'signInAttempt')).toEqual([
      ['signInAttempt', VICTIM],
      ['signInAttempt', STRANGER],
    ])
  })

  it('leaves the pending code valid when a send is refused', async () => {
    let allow = true
    const t = buildAuth({ quota: () => allow })
    await t.sendCode(VICTIM)
    const code = t.lastCode(VICTIM)
    allow = false
    expect((await t.sendCode(VICTIM)).status).toBe(429)
    expect((await t.signInWithCode(VICTIM, code)).status).toBe(200)
  })
})

describe('the code email', () => {
  it('links to our page with the code in the fragment, never the query', () => {
    const url = new URL(emailCodeLink(BASE, 'a+b@example.com', '012345'))
    expect(url.pathname).toBe('/login/code')
    expect(url.search).toBe('')
    const fragment = new URLSearchParams(url.hash.slice(1))
    expect(fragment.get('email')).toBe('a+b@example.com')
    expect(fragment.get('code')).toBe('012345')
  })

  it('shows the code, its lifetime, and an escaped link', () => {
    const url = `${BASE}/login/code#email=x&code="><img src=x>`
    for (const locale of ['en', 'fr'] as const) {
      const { subject, html, text } = signInCodeEmail({
        locale,
        code: '012345',
        url,
      })
      expect(subject).toContain('012345')
      expect(html).toContain('012345')
      expect(html).not.toContain('"><img')
      expect(text).toContain(url)
      expect(text).toMatch(/10 minutes/)
    }
  })
})

describe('rate-limit rules', () => {
  it('name only real Better Auth endpoints', () => {
    const auth = betterAuth({
      baseURL: BASE,
      database: memoryAdapter({}),
      emailAndPassword: { enabled: true },
      plugins: [emailOTP({ sendVerificationOTP: async () => {} })],
    })
    const paths = new Set(
      Object.values(auth.api).map((endpoint) => (endpoint as { path?: string }).path),
    )
    for (const key of Object.keys(rateLimitRules)) expect(paths).toContain(key)
  })
})
