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
export function classifyMediaError(error: unknown): MediaFailure | null {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String(error.name)
      : ''
  switch (name) {
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

/**
 * The stream an interview records from.
 *
 * Opens the devices the candidate chose on the check screen, when they chose
 * one; the interview used to reopen the system defaults and record on the
 * microphone the candidate had just rejected. Without a choice it asks for the
 * front camera, which a phone does not otherwise guarantee.
 *
 * When the camera is missing, busy or no longer there, it falls back to the
 * microphone alone: the audio is what gets transcribed and assessed, and
 * losing the whole interview to a webcam held by a video call is the worse
 * outcome. A refused permission does not fall back — it is the candidate's
 * answer, and asking again for half of it would be ignoring it.
 */
export async function openInterviewStream(
  {
    cameraId,
    micId,
    video,
  }: { cameraId?: string; micId?: string; video: boolean },
  getUserMedia: (
    constraints: MediaStreamConstraints,
  ) => Promise<MediaStream> = (constraints) =>
    navigator.mediaDevices.getUserMedia(constraints),
): Promise<InterviewStream> {
  const audio: MediaTrackConstraints | true = micId
    ? { deviceId: { exact: micId } }
    : true
  if (video) {
    try {
      const stream = await getUserMedia({
        audio,
        video: {
          ...(cameraId
            ? { deviceId: { exact: cameraId } }
            : { facingMode: 'user' }),
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      })
      return { stream, audioOnly: false }
    } catch (error) {
      const failure = classifyMediaError(error)
      if (failure === null || failure === 'permissionDenied') throw error
    }
  }
  return { stream: await getUserMedia({ audio, video: false }), audioOnly: true }
}
