/**
 * AWS Signature Version 4 — query-string ("presigned URL") signing.
 *
 * Pure, dependency-free, and runnable in the Convex default runtime: the only
 * primitive it needs is HMAC-SHA256 from Web Crypto, which is deterministic,
 * so a signed URL can be minted from an action without a Node cold start on
 * the candidate's hot path.
 *
 * Correctness is pinned by AWS's own worked example in sigv4.test.ts — both
 * the canonical-request hash and the final signature — so a refactor here
 * fails loudly instead of producing URLs the provider silently rejects.
 *
 * Spec: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
 */

const ALGORITHM = 'AWS4-HMAC-SHA256'
const encoder = new TextEncoder()

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}

async function sha256Hex(data: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(data)))
}

async function hmac(
  key: ArrayBuffer | Uint8Array,
  data: string,
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data))
}

/**
 * RFC 3986 percent-encoding. `encodeURIComponent` leaves `!'()*` alone, which
 * AWS requires encoded — a key containing any of them would otherwise sign
 * correctly and fetch as 403.
 */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/** Object keys are path segments: encode each part, keep the separators. */
export function uriEncodePath(key: string): string {
  return key.split('/').map(uriEncode).join('/')
}

/** `20130524T000000Z` and `20130524`, both in UTC. */
export function formatAmzDate(date: Date): {
  amzDate: string
  dateStamp: string
} {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

export type PresignInput = {
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD'
  /** Scheme + host, no trailing slash, e.g. `https://bucket.s3.fr-par.scw.cloud`. */
  origin: string
  /** Canonical path, already including the bucket for path-style endpoints. */
  path: string
  region: string
  service?: string
  accessKeyId: string
  secretAccessKey: string
  expiresIn: number
  date: Date
  /**
   * Headers signed in addition to `host`. A header signed here MUST be sent
   * verbatim by the client or the provider rejects the request — that is the
   * point for `content-type`: it stops an upload slot from being reused to
   * park HTML in the bucket.
   */
  extraSignedHeaders?: Record<string, string>
  /** Extra query parameters to sign, e.g. `response-content-disposition`. */
  extraQuery?: Record<string, string>
  sessionToken?: string
}

/** Everything but the final URL, exposed so tests can pin the intermediates. */
export function buildCanonicalRequest(input: PresignInput): {
  canonicalRequest: string
  canonicalQueryString: string
  credentialScope: string
  amzDate: string
} {
  const service = input.service ?? 's3'
  const { amzDate, dateStamp } = formatAmzDate(input.date)
  const credentialScope = `${dateStamp}/${input.region}/${service}/aws4_request`

  const host = new URL(input.origin).host
  const headers: Record<string, string> = {
    host,
    ...Object.fromEntries(
      Object.entries(input.extraSignedHeaders ?? {}).map(([k, val]) => [
        k.toLowerCase(),
        val.trim().replace(/\s+/g, ' '),
      ]),
    ),
  }
  const headerNames = Object.keys(headers).sort()
  const canonicalHeaders =
    headerNames.map((n) => `${n}:${headers[n]}\n`).join('') + ''
  const signedHeaders = headerNames.join(';')

  const query: Record<string, string> = {
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${input.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(input.expiresIn),
    'X-Amz-SignedHeaders': signedHeaders,
    ...(input.sessionToken ? { 'X-Amz-Security-Token': input.sessionToken } : {}),
    ...(input.extraQuery ?? {}),
  }
  const canonicalQueryString = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join('&')

  const canonicalRequest = [
    input.method,
    input.path,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n')

  return { canonicalRequest, canonicalQueryString, credentialScope, amzDate }
}

/** The presigned URL, ready to hand to a browser or a fetch. */
export async function presign(input: PresignInput): Promise<string> {
  const { canonicalRequest, canonicalQueryString, credentialScope, amzDate } =
    buildCanonicalRequest(input)

  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n')

  const { dateStamp } = formatAmzDate(input.date)
  let key: ArrayBuffer | Uint8Array = encoder.encode(
    `AWS4${input.secretAccessKey}`,
  )
  for (const part of [
    dateStamp,
    input.region,
    input.service ?? 's3',
    'aws4_request',
  ]) {
    key = await hmac(key, part)
  }
  const signature = toHex(await hmac(key, stringToSign))

  return `${input.origin}${input.path}?${canonicalQueryString}&X-Amz-Signature=${signature}`
}
