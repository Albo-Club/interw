import { ConvexError } from 'convex/values'

import { resources } from './i18n'

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
 * A code the domain says nothing about resolves to the shared
 * `errors:codes.<code>`, which holds every code `convex/` throws — a parity
 * test keeps it that way (M3). Callers pass `fallbackKey` as the
 * `defaultValue`, so a code from outside our functions (a component) still
 * shows the generic message rather than an internal identifier.
 */
export function errorMessageKey(
  error: unknown,
  namespace: string,
): { key: string; fallbackKey: string } {
  const code = convexErrorCode(error)
  return {
    key: code
      ? hasDomainCopy(namespace, code)
        ? `${namespace}:errors.${code}`
        : `errors:codes.${code}`
      : 'common:errorBoundary.title',
    fallbackKey: 'common:errorBoundary.description',
  }
}

/** Key sets are identical across locales (i18n.test.ts), so `en` answers. */
function hasDomainCopy(namespace: string, code: string): boolean {
  const ns: unknown = (resources.en as Record<string, unknown>)[namespace]
  if (typeof ns !== 'object' || ns === null || !('errors' in ns)) return false
  const errors = ns.errors as Record<string, unknown>
  return typeof errors[code] === 'string'
}
