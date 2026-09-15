import { createMiddleware, createStart } from '@tanstack/react-start'
import { setResponseHeader } from '@tanstack/react-start/server'

import { securityHeaders } from '~/lib/security-headers'

const securityHeadersMiddleware = createMiddleware().server(
  async ({ next }) => {
    // Read inside the server handler, never at module scope: this file is the
    // isomorphic Start entry and `process` does not exist in the browser.
    // MEDIA_ORIGIN belongs to the web server's environment (the OBJECT_STORE_*
    // variables live on the Convex deployment, which does not serve this
    // header) — see .env.example.
    for (const [name, value] of Object.entries(
      securityHeaders(process.env.MEDIA_ORIGIN),
    )) {
      setResponseHeader(name, value)
    }
    return next()
  },
)

export const startInstance = createStart(() => ({
  requestMiddleware: [securityHeadersMiddleware],
}))
