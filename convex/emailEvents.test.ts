/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'

import { internal } from './_generated/api'
import { statusForEvent } from './emailEvents'
import schema from './schema'
import type { Id } from './_generated/dataModel'

const modules = import.meta.glob('./**/*.ts')
const PROVIDER_ID = 'provider-id-stub'

/** Resend's webhook, as the component delivers it. */
async function deliver(
  t: ReturnType<typeof convexTest>,
  type: 'email.sent' | 'email.delivered' | 'email.bounced',
) {
  const now = new Date().toISOString()
  const data = {
    created_at: now,
    email_id: PROVIDER_ID,
    from: 'interw <no-reply@example.test>',
    to: 'alex@example.test',
    subject: 'Invitation',
  }
  await t.mutation(internal.emailEvents.record, {
    id: PROVIDER_ID as never,
    event:
      type === 'email.bounced'
        ? {
            type,
            created_at: now,
            data: {
              ...data,
              bounce: { message: 'mailbox full', subType: 'General', type: 'Permanent' },
            },
          }
        : { type, created_at: now, data },
  })
}

async function logRow(t: ReturnType<typeof convexTest>): Promise<Id<'emailLog'>> {
  return await t.run(async (ctx) =>
    ctx.db.insert('emailLog', {
      template: 'candidate-invitation',
      recipient: 'alex@example.test',
      status: 'sent',
      providerId: PROVIDER_ID,
      createdAt: 0,
    }),
  )
}

/** Audit 2026-09-22, h07. */
describe('emailEvents.record', () => {
  it('lets an event type it does not list fall through', () => {
    expect(statusForEvent('email.bounced')).toBe('bounced')
    for (const type of ['constructor', 'toString', '__proto__', 'email.opened']) {
      expect(statusForEvent(type)).toBeUndefined()
    }
  })

  // Svix retries a failed delivery for up to a day, so a `sent` can arrive
  // after the bounce it preceded.
  it('never lets a late sent or delivered undo a bounce', async () => {
    const t = convexTest(schema, modules)
    const rowId = await logRow(t)

    await deliver(t, 'email.bounced')
    await deliver(t, 'email.sent')
    await deliver(t, 'email.delivered')

    const row = await t.run(async (ctx) => ctx.db.get('emailLog', rowId))
    expect(row?.status).toBe('bounced')
    expect(row?.error).toBe('email.bounced')
  })

  it('never lets a late sent undo a delivery', async () => {
    const t = convexTest(schema, modules)
    const rowId = await logRow(t)

    await deliver(t, 'email.delivered')
    await deliver(t, 'email.sent')

    const row = await t.run(async (ctx) => ctx.db.get('emailLog', rowId))
    expect(row?.status).toBe('delivered')
  })
})
