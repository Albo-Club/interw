import { defineApp } from 'convex/server'
import betterAuth from '@convex-dev/better-auth/convex.config'
import resend from '@convex-dev/resend/convex.config'
import agent from '@convex-dev/agent/convex.config'
import rateLimiter from '@convex-dev/rate-limiter/convex.config'
import workpool from '@convex-dev/workpool/convex.config'

const app = defineApp()
app.use(betterAuth)
app.use(resend)
app.use(agent)
app.use(rateLimiter)
// Two pools, not one: transcription runs one job per answer and bursts when a
// candidate finishes, while report generation is a single long job per
// session. Sharing a pool would let a burst of transcriptions starve the
// reports that depend on them.
app.use(workpool, { name: 'mediaWorkpool' })
app.use(workpool, { name: 'reportWorkpool' })

export default app
