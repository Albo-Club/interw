import { ConvexError } from 'convex/values'

/**
 * Pull the machine-readable code out of a ConvexError.
 *
 * Server code throws `ConvexError('project_archived')` — a stable identifier,
 * never a sentence — and the UI resolves it through i18n. Rendering
 * `error.message` directly would put an untranslated, version-fragile English
 * string in front of a French recruiter, which is the mistake the template's
 * auth-error classifier already exists to avoid.
 */
export function convexErrorCode(error: unknown): string | null {
  if (!(error instanceof ConvexError)) return null
  const data: unknown = error.data
  if (typeof data === 'string') return data
  if (
    typeof data === 'object' &&
    data !== null &&
    'code' in data &&
    typeof data.code === 'string'
  ) {
    return (data as { code: string }).code
  }
  return null
}

/**
 * The i18n key for an error, falling back to a generic message.
 *
 * `namespace` is where the domain's own copy lives (`projects`, `interview`…).
 * An unknown code resolves to the generic boundary message rather than leaking
 * an internal identifier onto the screen.
 */
export function errorMessageKey(
  error: unknown,
  namespace: string,
): { key: string; fallbackKey: string } {
  const code = convexErrorCode(error)
  return {
    key: code ? `${namespace}:errors.${code}` : 'common:errorBoundary.title',
    fallbackKey: 'common:errorBoundary.description',
  }
}
