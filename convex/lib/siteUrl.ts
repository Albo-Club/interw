import { ConvexError } from 'convex/values'

/** An absolute link into the app, e.g. `siteUrl('/s/<token>')`. */
export function siteUrl(path: string): string {
  const base = process.env.SITE_URL
  if (!base) throw new ConvexError('site_url_not_configured')
  return `${base.replace(/\/+$/, '')}${path}`
}
