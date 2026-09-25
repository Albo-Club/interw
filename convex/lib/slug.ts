/**
 * URL slugs for projects.
 *
 * A slug is cosmetic — access is decided by org membership and by tokens,
 * never by knowing a slug — but it shows up in links recruiters paste to each
 * other, so it should stay short, stable and accent-free.
 */

const MAX_LENGTH = 60

/** Lowercase, accent-stripped, `a-z0-9-` only, collapsed and trimmed. */
export function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LENGTH)
    .replace(/-+$/g, '')
}

const SUFFIX_LENGTH = 6

/** Six base36 characters. For uniqueness only: a slug is not a credential. */
function randomSuffix(): string {
  const bytes = new Uint8Array(SUFFIX_LENGTH)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => (byte % 36).toString(36)).join('')
}

/**
 * A slug for which `isTaken` answers false: the title's slug plus a random
 * suffix, on every role. Falls back to `project` when the title has no usable
 * characters at all (a title in a non-Latin script, or only punctuation) — an
 * empty slug would produce a double slash in every link.
 *
 * Always suffixed (T17-3): `isTaken` sees every role in the org, including
 * the ones hidden from the caller, so "plain when free, `-2` when taken"
 * told a member that a confidential role with that title existed, and the
 * number told them how many. A collision on a random suffix reveals nothing.
 *
 * A predicate rather than a set of taken slugs (Back M4): the caller asks the
 * `by_org_and_slug` index, so uniqueness holds however many roles the
 * organisation has.
 */
export async function uniqueSlug(
  base: string,
  isTaken: (slug: string) => Promise<boolean>,
): Promise<string> {
  const root = (slugify(base) || 'project')
    .slice(0, MAX_LENGTH - SUFFIX_LENGTH - 1)
    .replace(/-+$/g, '')
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `${root}-${randomSuffix()}`
    if (!(await isTaken(candidate))) return candidate
  }
  throw new Error('could not derive a unique slug')
}
