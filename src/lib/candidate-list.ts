/**
 * Parsing the list a recruiter pastes in.
 *
 * Recruiters paste from a spreadsheet, an ATS export, or an email thread, and
 * the separators are never the same twice. Being liberal about the input and
 * strict about showing back what could not be read is what keeps this from
 * silently dropping a candidate — which, in hiring, means a person never gets
 * their interview and nobody finds out.
 */

export type ParsedCandidate = { name: string; email: string }

export type ParsedLine = { line: string; reason: 'no_email' | 'bad_email' }

export type ParsedCandidateList = {
  candidates: Array<ParsedCandidate>
  invalid: Array<ParsedLine>
  /** Addresses that appeared more than once; kept only on first sight. */
  duplicates: Array<string>
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
/** `Name <a@b.c>`, `Name, a@b.c`, `Name; a@b.c`, `Name\ta@b.c`, or bare. */
const ANGLE_RE = /^(.*?)<([^>]+)>\s*$/

function titleCaseFromEmail(email: string): string {
  const local = email.split('@')[0]
  return (
    local
      .split(/[._-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ') || email
  )
}

export function parseCandidateList(input: string): ParsedCandidateList {
  const candidates: Array<ParsedCandidate> = []
  const invalid: Array<ParsedLine> = []
  const duplicates: Array<string> = []
  const seen = new Set<string>()

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    let name = ''
    let email = ''

    const angle = ANGLE_RE.exec(line)
    if (angle) {
      name = angle[1].trim().replace(/^["']|["']$/g, '')
      email = angle[2].trim()
    } else {
      const parts = line.split(/[,;\t]+/).map((part) => part.trim())
      const emailPart = parts.find((part) => part.includes('@'))
      if (!emailPart) {
        invalid.push({ line, reason: 'no_email' })
        continue
      }
      email = emailPart
      name = parts.filter((part) => part !== emailPart).join(' ').trim()
      // Space-separated "Camille Durand camille@example.com" is common enough
      // in pasted text to be worth handling.
      if (!name && emailPart.includes(' ')) {
        const tokens = emailPart.split(/\s+/)
        const found = tokens.find((token) => token.includes('@'))
        if (found) {
          email = found
          name = tokens.filter((token) => token !== found).join(' ')
        }
      }
    }

    email = email.toLowerCase().replace(/^mailto:/, '')
    if (!EMAIL_RE.test(email)) {
      invalid.push({ line, reason: 'bad_email' })
      continue
    }
    if (seen.has(email)) {
      duplicates.push(email)
      continue
    }
    seen.add(email)
    // A missing name is not a reason to reject someone: derive a readable one
    // from the address and let the recruiter correct it.
    candidates.push({ name: name || titleCaseFromEmail(email), email })
  }

  return { candidates, invalid, duplicates }
}
