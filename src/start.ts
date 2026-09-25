import { createMiddleware, createStart } from '@tanstack/react-start'
import { setResponseHeader } from '@tanstack/react-start/server'

import { securityHeaders } from '~/lib/security-headers'

const securityHeadersMiddleware = createMiddleware().server(
  async ({ next }) => {
    // Read inside the server handler, never at module scope: this file is the
    // isomorphic Start entry and `process` does not exist in the browser.
    // MEDIA_ORIGIN belongs to the web server's environment (the OBJECT_STORE_*
    // variables live on the Convex deployment, which does not serve this
    // header) — see .env.example. VITE_CONVEX_URL is inlined at build time.
    for (const [name, value] of Object.entries(
      securityHeaders({
        mediaOrigin: process.env.MEDIA_ORIGIN,
        convexUrl: import.meta.env.VITE_CONVEX_URL,
      }),
    )) {
      setResponseHeader(name, value)
    }
    return next()
  },
)

export const startInstance = createStart(() => ({
  requestMiddleware: [securityHeadersMiddleware],
}))
