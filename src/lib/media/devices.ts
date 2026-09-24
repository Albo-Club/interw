/**
 * Working out whether this browser can actually record an interview, before
 * the candidate has invested ten minutes finding out that it cannot.
 *
 * The detection functions are pure and take their inputs, so the awkward
 * cases — an in-app browser, a missing MediaRecorder — are unit-testable
 * rather than only reproducible on a borrowed phone.
 */

export type BrowserSupport = {
  getUserMedia: boolean
  mediaRecorder: boolean
  audioContext: boolean
  /** Instagram, LinkedIn, Facebook and friends: recording fails silently. */
  inAppBrowser: boolean
  /** The candidate can proceed. */
  usable: boolean
}

/**
 * Detect the webviews embedded in social and messaging apps.
 *
 * This matters more than it looks: candidates open their email in the LinkedIn
 * or Gmail app, the link opens in a webview, and `getUserMedia` either is
 * missing or returns a stream `MediaRecorder` cannot encode. Better to say so
 * on the first screen than to lose the interview on question three.
 */
export function isInAppBrowser(userAgent: string): boolean {
  const ua = userAgent.toLowerCase()
  const markers = [
    'fban',
    'fbav',
    'fb_iab',
    'instagram',
    'linkedinapp',
    'twitter',
    'line/',
    'micromessenger',
    'snapchat',
    'tiktok',
    'pinterest',
    'gsa/',
  ]
  if (markers.some((marker) => ua.includes(marker))) return true
  // Android WebView: "wv" in the UA, without Chrome's own branding.
  if (ua.includes('; wv)')) return true
  return false
}

export function detectBrowserSupport(
  globalScope: {
    navigator?: { mediaDevices?: unknown; userAgent?: string }
    MediaRecorder?: unknown
    AudioContext?: unknown
    webkitAudioContext?: unknown
  } = globalThis,
): BrowserSupport {
  const nav = globalScope.navigator
  const getUserMedia =
    typeof nav?.mediaDevices === 'object' &&
    nav.mediaDevices !== null &&
    'getUserMedia' in nav.mediaDevices
  const mediaRecorder = typeof globalScope.MediaRecorder === 'function'
  const audioContext =
    typeof globalScope.AudioContext === 'function' ||
    typeof globalScope.webkitAudioContext === 'function'
  const inAppBrowser = isInAppBrowser(nav?.userAgent ?? '')

  return {
    getUserMedia,
    mediaRecorder,
    audioContext,
    inAppBrowser,
    usable: getUserMedia && mediaRecorder,
  }
}

/**
 * Loudness of one analyser frame, 0..1.
 *
 * Root mean square rather than peak: a single click should not read as a
 * working microphone, and a steady voice should not read as silence between
 * syllables.
 */
export function levelFromTimeDomain(samples: Uint8Array): number {
  if (samples.length === 0) return 0
  let sumSquares = 0
  for (const sample of samples) {
    const centred = (sample - 128) / 128
    sumSquares += centred * centred
  }
  return Math.min(1, Math.sqrt(sumSquares / samples.length))
}

export type MicVerdict = 'silent' | 'quiet' | 'good'

/**
 * Turn a run of level samples into an answer the candidate can act on.
 *
 * Uses the loudest moment, not the average: someone who says one sentence and
 * then waits has a working microphone, and averaging would call it silent.
 */
export function assessMicLevels(levels: ReadonlyArray<number>): MicVerdict {
  if (levels.length === 0) return 'silent'
  const peak = Math.max(...levels)
  if (peak < 0.02) return 'silent'
  if (peak < 0.06) return 'quiet'
  return 'good'
}

/**
 * Below this mean brightness (0..255) a frame is black: a lens cover, a
 * privacy shutter, a laptop lid half closed. A dim room reads well above it.
 */
export const DARK_FRAME_BRIGHTNESS = 12

/** Mean brightness of an RGBA frame, 0..255 — what `getImageData` returns. */
export function frameBrightness(rgba: Uint8ClampedArray): number {
  const pixels = rgba.length / 4
  if (pixels === 0) return 0
  let sum = 0
  for (let i = 0; i < rgba.length; i += 4) {
    // Rec. 601 luma: what the eye calls bright, not the plain channel mean.
    sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]
  }
  return sum / pixels
}

/** What a refused camera or microphone means for the candidate. */
export type MediaFailure = 'permissionDenied' | 'busy' | 'noDevices'

/**
 * Name a `getUserMedia` rejection, or return null for one we cannot explain.
 *
 * These are `DOMException`s, not `ConvexError`s, so the generic error path
 * rendered every one of them as "Something went wrong" — and the device check
 * called anything but `NotFoundError` a refused permission. The commonest
 * case at work is `NotReadableError`: the camera is held by a video call, and
 * "allow it in your address bar" is the wrong advice for it.
 */
function mediaErrorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error
    ? String(error.name)
    : ''
}

export function classifyMediaError(error: unknown): MediaFailure | null {
  switch (mediaErrorName(error)) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'permissionDenied'
    case 'NotReadableError':
    case 'AbortError':
      return 'busy'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'noDevices'
    default:
      return null
  }
}

export type InterviewStream = { stream: MediaStream; audioOnly: boolean }

type DeviceChoice = { cameraId?: string; micId?: string; video: boolean }
type GetUserMedia = (constraints: MediaStreamConstraints) => Promise<MediaStream>

/**
 * Speech, mono. Stated rather than left to each browser's defaults, which
 * differ: one channel is all transcription uses, and echo cancellation is what
 * keeps a question played through laptop speakers out of the answer.
 */
const SPEECH: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
}

/** Some webcams default to 60 fps: twice the encoding work, for a face. */
const CAMERA: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 24, max: 30 },
}

/** A device chosen on the check screen that no longer resolves. */
const isStaleChoice = (choice: DeviceChoice, error: unknown) =>
  Boolean(choice.cameraId || choice.micId) &&
  mediaErrorName(error) === 'OverconstrainedError'

/**
 * The stream an interview records from.
 *
 * Opens the devices the candidate chose on the check screen, when they chose
 * one; the interview used to reopen the system defaults and record on the
 * microphone the candidate had just rejected. Without a choice it asks for the
 * front camera, which a phone does not otherwise guarantee.
 *
 * A choice that no longer resolves — the headset was unplugged, the webcam
 * swapped since the check — is stale, not refused: the defaults are opened
 * instead. It used to read as "no camera" and record the interview audio-only.
 *
 * When the camera is missing, busy or no longer there, it falls back to the
 * microphone alone: the audio is what gets transcribed and assessed, and
 * losing the whole interview to a webcam held by a video call is the worse
 * outcome. A refused permission does not fall back — it is the candidate's
 * answer, and asking again for half of it would be ignoring it.
 */
export async function openInterviewStream(
  choice: DeviceChoice,
  getUserMedia: GetUserMedia = (constraints) =>
    navigator.mediaDevices.getUserMedia(constraints),
): Promise<InterviewStream> {
  try {
    return await open(choice, getUserMedia)
  } catch (error) {
    if (!isStaleChoice(choice, error)) throw error
    return open({ video: choice.video }, getUserMedia)
  }
}

async function open(
  choice: DeviceChoice,
  getUserMedia: GetUserMedia,
): Promise<InterviewStream> {
  const { cameraId, micId, video } = choice
  const audio: MediaTrackConstraints = micId
    ? { ...SPEECH, deviceId: { exact: micId } }
    : SPEECH
  if (video) {
    try {
      const stream = await getUserMedia({
        audio,
        video: {
          ...(cameraId
            ? { deviceId: { exact: cameraId } }
            : { facingMode: 'user' }),
          ...CAMERA,
        },
      })
      return { stream, audioOnly: false }
    } catch (error) {
      const failure = classifyMediaError(error)
      if (failure === null || failure === 'permissionDenied') throw error
      // Retried on the defaults by the caller, camera included.
      if (isStaleChoice(choice, error)) throw error
    }
  }
  return { stream: await getUserMedia({ audio, video: false }), audioOnly: true }
}
