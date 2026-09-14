import { httpRouter } from 'convex/server'
import { authComponent, createAuth } from './auth'
import { streamOverHttp } from './chat'
import { resend } from './email'
import { httpAction } from './_generated/server'

const http = httpRouter()

authComponent.registerRoutes(http, createAuth)

/**
 * Resend delivery events. The component verifies the Svix signature against
 * RESEND_WEBHOOK_SECRET before anything is trusted — this endpoint is public
 * by necessity, so the signature is the only thing standing between it and
 * forged bounce reports.
 */
http.route({
  path: '/resend-webhook',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    return await resend.handleResendEventWebhook(ctx, req)
  }),
})

http.route({
  path: '/api/chat',
  method: 'POST',
  handler: streamOverHttp,
})

export default http
