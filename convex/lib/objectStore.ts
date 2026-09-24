/**
 * The one place that talks to object storage.
 *
 * Coded against the S3 API, not against a vendor: swapping Scaleway for OVH,
 * Exoscale or R2 is a change of environment variables, nothing else. Default
 * provider is Scaleway Object Storage, region `fr-par` — French company,
 * storage in Paris or Amsterdam, no US region to disable.
 *
 * ── Why candidate recordings are NOT in Convex file storage ────────────────
 * `ctx.storage.getUrl()` returns a permanent, unauthenticated URL: "anyone
 * with the URL can access the file without further authentication from your
 * app", and the only way to revoke it is to delete the file. Such a URL, once
 * written to a database, mailed, or left in a browser history, exposes a
 * candidate's video irrevocably. Serving through a Convex HTTP route is not a
 * way out either: those cap at 20 MB per response and do not support range
 * requests, so neither a long recording nor seeking would work.
 *
 * Question and intro media follow candidate media into this store rather than
 * Convex storage, one step tighter than the original plan: a recruiter's face
 * and voice are personal data too, and a permanent URL to the question set
 * leaks the interview itself. Only branding images (org logo, persona avatar)
 * stay in Convex storage, where the template already handles them — those are
 * shown to every candidate holding a link anyway.
 *
 * Rules, no exceptions:
 *   1. The database stores object KEYS. A URL is signed at read time and never
 *      persisted.
 *   2. The bucket is private. Nothing is readable without a signed URL.
 *   3. A signed URL is only ever minted by a function that has ALREADY checked
 *      access: matching candidate token, org membership, or a valid share.
 *   4. Read URLs live 1 hour, write URLs 15 minutes.
 *   5. Keys are `orgs/{orgId}/sessions/{sessionId}/…`, which makes purging a
 *      session a matter of deleting a known, enumerable set.
 */

import { presign } from './sigv4'

export const READ_URL_TTL_SECONDS = 60 * 60
export const WRITE_URL_TTL_SECONDS = 15 * 60

export type ObjectStoreConfig = {
  origin: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `object store misconfigured: ${name} is not set on the Convex deployment`,
    )
  }
  return value
}

export function objectStoreConfig(): ObjectStoreConfig {
  return {
    origin: required('OBJECT_STORE_ENDPOINT').replace(/\/+$/, ''),
    region: required('OBJECT_STORE_REGION'),
    bucket: required('OBJECT_STORE_BUCKET'),
    accessKeyId: required('OBJECT_STORE_ACCESS_KEY_ID'),
    secretAccessKey: required('OBJECT_STORE_SECRET_ACCESS_KEY'),
    // Virtual-hosted style by default (what Scaleway, AWS and R2 all take).
    // Path style exists for MinIO in local development.
    forcePathStyle: process.env.OBJECT_STORE_FORCE_PATH_STYLE === 'true',
  }
}

/** True when the deployment has object storage wired at all. */
export function isObjectStoreConfigured(): boolean {
  try {
    objectStoreConfig()
    return true
  } catch {
    return false
  }
}

/**
 * Resolve `{origin, path}` for a key under either addressing style.
 * Exported for tests: getting this wrong yields URLs that sign cleanly and
 * 403 at the provider.
 */
export function resolveTarget(
  config: ObjectStoreConfig,
  key: string,
): { origin: string; path: string } {
  const url = new URL(config.origin)
  const encodedKey = key
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/')
  if (config.forcePathStyle) {
    return {
      origin: `${url.protocol}//${url.host}`,
      path: `/${config.bucket}/${encodedKey}`,
    }
  }
  return {
    origin: `${url.protocol}//${config.bucket}.${url.host}`,
    path: `/${encodedKey}`,
  }
}

async function sign(
  method: 'GET' | 'PUT' | 'DELETE',
  key: string,
  expiresIn: number,
  options: {
    contentType?: string
    contentLength?: number
    responseContentDisposition?: string
  } = {},
): Promise<string> {
  const config = objectStoreConfig()
  const { origin, path } = resolveTarget(config, key)
  return await presign({
    method,
    origin,
    path,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    expiresIn,
    date: new Date(),
    extraSignedHeaders: {
      ...(options.contentType ? { 'content-type': options.contentType } : {}),
      ...(options.contentLength !== undefined
        ? { 'content-length': String(options.contentLength) }
        : {}),
    },
    extraQuery: options.responseContentDisposition
      ? { 'response-content-disposition': options.responseContentDisposition }
      : undefined,
  })
}

/**
 * A URL the browser may PUT one object to, once, within `expiresIn` seconds.
 *
 * Three things are signed and so cannot be renegotiated by the client:
 *   - the key, so a slot cannot be used to overwrite another object;
 *   - `content-type`, so a slot issued for a video cannot park HTML on the
 *     bucket's own origin;
 *   - `content-length` when given, so a 4 MB promise cannot become a 40 GB
 *     upload. `fetch` sets that header itself from the Blob, so passing
 *     `blob.size` here is all the client has to do.
 */
export function presignPut(
  key: string,
  contentType: string,
  expiresIn: number = WRITE_URL_TTL_SECONDS,
  contentLength?: number,
): Promise<string> {
  return sign('PUT', key, expiresIn, { contentType, contentLength })
}

/**
 * A URL to read one object. `download` forces an attachment disposition —
 * used for candidate-supplied documents so a CV can never render as a page on
 * the bucket's own origin.
 */
export function presignGet(
  key: string,
  expiresIn: number = READ_URL_TTL_SECONDS,
  options: { download?: string } = {},
): Promise<string> {
  return sign('GET', key, expiresIn, {
    responseContentDisposition: options.download
      ? `attachment; filename="${options.download.replace(/["\\]/g, '')}"`
      : undefined,
  })
}

const DELETE_CONCURRENCY = 8

/**
 * Delete objects by key. Individual signed DELETEs rather than the batch
 * `POST ?delete` endpoint: the batch form needs a signed body digest, which
 * query-string auth does not carry, and a session never holds more than a few
 * dozen objects.
 *
 * A 404 counts as success — deleting an object that is already gone is the
 * outcome the caller wanted, and the purge path must be replayable.
 */
export async function deleteObjects(keys: Array<string>): Promise<void> {
  const failures: Array<string> = []
  for (let i = 0; i < keys.length; i += DELETE_CONCURRENCY) {
    const batch = keys.slice(i, i + DELETE_CONCURRENCY)
    await Promise.all(
      batch.map(async (key) => {
        const url = await sign('DELETE', key, WRITE_URL_TTL_SECONDS)
        const response = await fetch(url, { method: 'DELETE' })
        if (!response.ok && response.status !== 404) {
          failures.push(`${key} (${response.status})`)
        }
      }),
    )
  }
  if (failures.length > 0) {
    throw new Error(`object store delete failed for: ${failures.join(', ')}`)
  }
}

/** Read an object back, for the transcription and analysis jobs. */
export async function getObjectStream(key: string): Promise<ReadableStream> {
  const url = await presignGet(key, WRITE_URL_TTL_SECONDS)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`object store read failed for ${key}: ${response.status}`)
  }
  if (!response.body) {
    throw new Error(`object store read returned no body for ${key}`)
  }
  return response.body
}

/* ──────────────────────────── Key conventions ────────────────────────────
 * One prefix per session makes "delete everything this candidate gave us" a
 * known, enumerable set rather than a scan. Every key is derived here, never
 * assembled at a call site.
 * ------------------------------------------------------------------------ */

export function sessionPrefix(orgId: string, sessionId: string): string {
  return `orgs/${orgId}/sessions/${sessionId}`
}

export function segmentKey(
  orgId: string,
  sessionId: string,
  questionIndex: number,
  extension: string,
): string {
  return `${sessionPrefix(orgId, sessionId)}/q${questionIndex}.${extension}`
}

export function thumbnailKey(
  orgId: string,
  sessionId: string,
  questionIndex: number,
): string {
  return `${sessionPrefix(orgId, sessionId)}/q${questionIndex}.jpg`
}

export function candidateDocumentKey(
  orgId: string,
  sessionId: string,
  kind: 'cv' | 'cover',
  extension: string,
): string {
  return `${sessionPrefix(orgId, sessionId)}/${kind}.${extension}`
}

export function projectMediaKey(
  orgId: string,
  projectId: string,
  slot: 'intro' | `q-${string}`,
  extension: string,
): string {
  return `orgs/${orgId}/projects/${projectId}/${slot}.${extension}`
}

/**
 * What a player can load for one answer: the video once it has landed, the
 * audio otherwise. An answer whose video upload failed still carries its
 * `videoKey` — it was written before the upload — and signing it handed the
 * recruiter a 404 in place of an answer whose audio was right there.
 */
export function playbackMedia(segment: {
  videoKey?: string
  audioKey?: string
  videoUploaded?: boolean
}): { key: string; kind: 'video' | 'audio' } | null {
  if (segment.videoKey && segment.videoUploaded !== false) {
    return { key: segment.videoKey, kind: 'video' }
  }
  return segment.audioKey ? { key: segment.audioKey, kind: 'audio' } : null
}

/** One extension per accepted content type, and so one type per extension. */
const EXTENSIONS: Record<string, string> = {
  'video/webm': 'webm',
  'video/mp4': 'mp4',
  'audio/webm': 'weba',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
}

const MIME_TYPES: Record<string, string> = Object.fromEntries(
  Object.entries(EXTENSIONS).map(([mimeType, ext]) => [ext, mimeType]),
)

/**
 * Extension for a recorder MIME type. `MediaRecorder` reports types like
 * `video/webm;codecs=vp8,opus`, so the parameters are stripped first.
 */
export function extensionForMimeType(mimeType: string): string {
  const base = mimeType.split(';')[0].trim().toLowerCase()
  return EXTENSIONS[base] ?? 'bin'
}

/**
 * The content type an object was stored under, read back from its key. Keys
 * are derived from the validated type, so the extension is the record of it —
 * a Safari answer is `.m4a`, and labelling it `audio/webm` for the
 * transcription provider was a guess that was wrong for every one of them.
 */
export function mimeTypeForKey(key: string): string {
  const extension = key.slice(key.lastIndexOf('.') + 1)
  return MIME_TYPES[extension] ?? 'application/octet-stream'
}
