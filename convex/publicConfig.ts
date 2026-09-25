import { query } from './_generated/server'

// Keep in sync with the `socialProviders` block in `convex/auth.ts`.

// access: public by design — the sign-in page asks which social providers are
// wired before anyone is signed in. Returns booleans derived from env
// presence, never the secrets themselves.
export const enabledSocialProviders = query({
  args: {},
  handler: () => ({
    google: !!(
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ),
  }),
})
