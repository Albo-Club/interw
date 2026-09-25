/**
 * A name as it may appear in an email subject, a page title or a sentence:
 * control characters (CR/LF included) and Unicode line separators become a
 * space, and the ends are trimmed. Every name a person types goes through it
 * on the way in, so no template has to remember to (T12). The length cap
 * stays the caller's rule.
 */
export function singleLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim()
}
