/**
 * Access tokens for candidate links and report shares.
 *
 * 32 bytes of CSPRNG, base64url-encoded. That is the whole security model for
 * these links, so it has to be real randomness and enough of it: at 256 bits,
 * guessing one is not a threat anyone needs to model, which is what lets a
 * resolved token be treated as proof the holder was sent the link.
 */

const DEFAULT_BYTES = 32

/** URL-safe, no padding — these end up in emails and browser address bars. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function generateToken(byteLength: number = DEFAULT_BYTES): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return toBase64Url(bytes)
}

/**
 * Cheap shape check before hitting the index. Not a security control — the
 * index lookup is — but it keeps obviously malformed input out of the
 * database and out of the rate limiter's key space.
 */
export function looksLikeToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(value)
}
