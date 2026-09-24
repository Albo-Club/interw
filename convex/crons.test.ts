/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { Resend } from '@convex-dev/resend'
import { register as registerResend } from '@convex-dev/resend/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { components, internal } from './_generated/api'
import schema from './schema'
import type { EmailId } from '@convex-dev/resend'

const modules = import.meta.glob('./**/*.ts')

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The component keeps the full body of every email it sent — for an
 * invitation, the candidate's name, the role, the organisation and their
 * interview link — until the app asks it to forget. Nothing asked: a fixture
 * sent a year ago was still readable.
 */
describe('resend component retention', () => {
  let t: ReturnType<typeof convexTest>
  const resend = new Resend(components.resend, {
    apiKey: 're_test',
    testMode: true,
  })

  beforeEach(() => {
    vi.useFakeTimers()
    t = convexTest(schema, modules)
    registerResend(t, 'resend')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function send(): Promise<EmailId> {
    return await t.run(async (ctx) =>
      resend.sendEmail(ctx, {
        from: 'interw <no-reply@example.test>',
        to: 'delivered@resend.dev',
        subject: 'Your interview for Backend at Acme',
        html: '<p>Alex Martin, start here: /s/token</p>',
        text: 'Alex Martin, start here: /s/token',
      }),
    )
  }

  async function runCleanupAt(ms: number): Promise<void> {
    vi.setSystemTime(ms)
    await t.mutation(internal.crons.cleanupResend, {})
    await t.finishAllScheduledFunctions(vi.runAllTimers)
  }

  async function stored(emailId: EmailId) {
    return await t.run(async (ctx) => resend.get(ctx, emailId))
  }

  it('forgets a finished email a week after its outcome', async () => {
    const start = Date.now()
    const finished = await send()
    await t.run(async (ctx) => resend.cancelEmail(ctx, finished))

    await runCleanupAt(start + 6 * DAY_MS)
    expect(await stored(finished)).not.toBeNull()

    await runCleanupAt(start + 7 * DAY_MS + 60_000)
    expect(await stored(finished)).toBeNull()
  })

  it('forgets an email that never reached an outcome after thirty days', async () => {
    const start = Date.now()
    const pending = await send()

    await runCleanupAt(start + 29 * DAY_MS)
    expect(await stored(pending)).not.toBeNull()

    await runCleanupAt(start + 30 * DAY_MS + 60_000)
    expect(await stored(pending)).toBeNull()
  })
})
