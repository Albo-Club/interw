import { ConvexError } from 'convex/values'

/**
 * Names people type — their own, their organisation's — end up in email
 * subjects and on one-line UI, where a line break is an injection, never
 * formatting. See KNOWN_ISSUES.md § "Typed names are one line, and bounded".
 */

/** Longest display or organisation name; the forms cap at the same length. */
export const NAME_MAX = 80

/**
 * Every run of control characters and line or paragraph separators becomes
 * one space, then the ends are trimmed.
 */
export function singleLine(value: string): string {
  return value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim()
}

/**
 * A name typed into one of our own forms: `singleLine`, and refused when empty
 * or longer than the form allows — a form is only a suggestion.
 */
export function typedName(value: string): string {
  const name = singleLine(value)
  if (!name || name.length > NAME_MAX) throw new ConvexError('invalid_name')
  return name
}

/**
 * `singleLine`, cut to `max` characters (code points, so an emoji is never
 * split in half). For values that cannot be refused, only made safe.
 */
export function clampLine(value: string, max: number): string {
  return Array.from(singleLine(value)).slice(0, max).join('').trim()
}
