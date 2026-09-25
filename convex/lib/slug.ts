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

/**
 * A slug for which `isTaken` answers false, by suffixing `-2`, `-3`, … Falls
 * back to `project` when the title has no usable characters at all (a title
 * in a non-Latin script, or only punctuation) — an empty slug would produce a
 * double slash in every link.
 *
 * A predicate rather than a set of taken slugs (Back M4): the caller asks the
 * `by_org_and_slug` index about each candidate, so uniqueness holds however
 * many roles the organisation has. A set had to be materialised first, and
 * was capped at 200 rows — past that a duplicate slug was insertable.
 */
export async function uniqueSlug(
  base: string,
  isTaken: (slug: string) => Promise<boolean>,
): Promise<string> {
  const root = slugify(base) || 'project'
  if (!(await isTaken(root))) return root
  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${root.slice(0, MAX_LENGTH - 5)}-${suffix}`
    if (!(await isTaken(candidate))) return candidate
  }
  throw new Error('could not derive a unique slug')
}
