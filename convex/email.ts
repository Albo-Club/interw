import { Resend } from '@convex-dev/resend'
import { components } from './_generated/api'

export const RESEND_FROM = process.env.RESEND_FROM!

export const resend = new Resend(components.resend, {
  testMode: process.env.RESEND_TEST_MODE !== 'false',
})
