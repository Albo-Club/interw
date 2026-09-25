// Pure, side-effect-free predicates for invitation acceptance, so the
// acceptance rules live in exactly one place.

/**
 * The one way this app compares or stores an address it decides on: trimmed,
 * ASCII letters lowercased, everything else untouched. Never `toLowerCase()`,
 * which folds all of Unicode — the Kelvin sign U+212A would then equal `k`,
 * and an invitation for one mailbox could be accepted by another. See
 * KNOWN_ISSUES.md § "Addresses fold ASCII case only".
 */
export function normalizeEmail(email: string): string {
  return email.trim().replace(/[A-Z]+/g, (letters) => letters.toLowerCase())
}

export function emailsMatch(a: string, b: string): boolean {
  return normalizeEmail(a) === normalizeEmail(b)
}
