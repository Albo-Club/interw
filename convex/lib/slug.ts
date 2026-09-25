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
const SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

function randomSuffix(): string {
  const bytes = new Uint8Array(SUFFIX_LENGTH)
  crypto.getRandomValues(bytes)
  return Array.from(
    bytes,
    (b) => SUFFIX_ALPHABET[b % SUFFIX_ALPHABET.length],
  ).join('')
}

/**
 * `<title>-<6 random characters>`, redrawn until `isTaken` answers false.
 * Falls back to `project` when the title has no usable characters at all (a
 * title in a non-Latin script, or only punctuation) — an empty slug would
 * produce a double slash in every link.
 *
 * Every new slug carries the suffix, taken or not (audit T17-3). Slugs are
 * unique across the organisation, roles the caller cannot see included, and
 * the old `-2`, `-3` counter handed that back: "Replace Paul" returning
 * `replace-paul-2` told a member a role of that title existed, hidden from
 * them. A random suffix says nothing about the others.
 *
 * A predicate rather than a set of taken slugs (Back M4): the caller asks the
 * `by_org_and_slug` index about each candidate, so uniqueness holds however
 * many roles the organisation has.
 */
export async function uniqueSlug(
  base: string,
  isTaken: (slug: string) => Promise<boolean>,
): Promise<string> {
  const root = (slugify(base) || 'project')
    .slice(0, MAX_LENGTH - SUFFIX_LENGTH - 1)
    .replace(/-+$/g, '')
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = `${root}-${randomSuffix()}`
    if (!(await isTaken(candidate))) return candidate
  }
  throw new Error('could not derive a unique slug')
}
