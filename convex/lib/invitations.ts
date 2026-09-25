// Pure, side-effect-free predicates for invitation acceptance, so the
// acceptance rules live in exactly one place.

export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim()
}

export function emailsMatch(a: string, b: string): boolean {
  return normalizeEmail(a) === normalizeEmail(b)
}
