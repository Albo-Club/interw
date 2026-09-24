/**
 * Recording one answer.
 *
 * Two recorders run on the same camera/microphone stream at once: one
 * capturing video with sound, one capturing audio alone. That is not
 * redundancy — the audio track is what gets transcribed and analysed, and
 * feeding a transcription model a WebM video container instead of an audio
 * file is the difference between a timestamped transcript and a provider
 * error. The extra upload is a few hundred kilobytes.
 *
 * Browser APIs are injected so the selection logic can be tested without one.
 */

/**
 * In preference order. MP4 (H.264/AAC) wherever the browser can record it —
 * Chrome and Edge 126+, Safari — because it is what every recruiter's browser
 * plays, iPhones included, and it seeks: MediaRecorder's WebM carries no
 * duration and no cues, so "jump to the quote" landed wherever the browser
 * guessed. WebM stays as the Firefox branch, which records nothing else.
 */
export const VIDEO_MIME_PREFERENCES = [
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01F,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
] as const

export const AUDIO_MIME_PREFERENCES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
] as const

export type MimeSupportCheck = (mimeType: string) => boolean

/**
 * About 1 Mbit/s of video and 64 kbit/s of speech. Left to itself a browser
 * records 720p at several Mbit/s — three minutes came to ~50 MB, which on a
 * phone in a train is an upload that does not finish. Speech needs far less
 * than music, and the transcription model does not hear the difference.
 */
export const VIDEO_BITS_PER_SECOND = 1_000_000
export const AUDIO_BITS_PER_SECOND = 64_000

/**
 * Long enough for a slow phone to flush minutes of video; short enough that a
 * recorder which will never emit `stop` — iOS, after an incoming call — does
 * not hold "Saving your answer…" on screen forever.
 */
export const STOP_TIMEOUT_MS = 10_000

/**
 * First supported type from a preference list, or null when the browser
 * supports none of them — which is a blocking condition the candidate must be
 * told about before they start, not discovered when they stop recording.
 */
export function pickSupportedMimeType(
  preferences: ReadonlyArray<string>,
  isSupported: MimeSupportCheck,
): string | null {
  for (const candidate of preferences) {
    if (isSupported(candidate)) return candidate
  }
  return null
}

export type RecorderSupport = {
  video: string | null
  audio: string | null
  /** False when this browser cannot produce anything we can transcribe. */
  usable: boolean
}

export function detectRecorderSupport(
  isSupported: MimeSupportCheck = (type) =>
    typeof MediaRecorder !== 'undefined' &&
    MediaRecorder.isTypeSupported(type),
): RecorderSupport {
  const video = pickSupportedMimeType(VIDEO_MIME_PREFERENCES, isSupported)
  const audio = pickSupportedMimeType(AUDIO_MIME_PREFERENCES, isSupported)
  return { video, audio, usable: audio !== null }
}

export type Recording = {
  video: Blob | null
  videoMimeType: string | null
  audio: Blob
  audioMimeType: string
  durationSeconds: number
}

/** Emitted every second while recording, for the countdown and the meter. */
export type RecorderTick = { elapsedSeconds: number }

type RecorderState = 'idle' | 'recording' | 'stopping' | 'stopped'

/**
 * One answer, start to blob.
 *
 * `stop()` resolves only once both recorders have flushed, so the caller
 * never uploads a truncated take — the previous build's habit of reading
 * chunks while the recorder was still running is how answers lost their last
 * few seconds.
 */
export class SegmentRecorder {
  private videoRecorder: MediaRecorder | null = null
  private audioRecorder: MediaRecorder | null = null
  private videoChunks: Array<Blob> = []
  private audioChunks: Array<Blob> = []
  private startedAt = 0
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private state: RecorderState = 'idle'

  constructor(
    private readonly stream: MediaStream,
    private readonly support: RecorderSupport,
    private readonly onTick?: (tick: RecorderTick) => void,
    /** An encoder that fails mid-answer stops on its own; the caller must
     *  save what it has rather than find out at the end. */
    private readonly onFailure?: () => void,
  ) {}

  get isRecording(): boolean {
    return this.state === 'recording'
  }

  start(): void {
    if (this.state !== 'idle') throw new Error('recorder already started')
    if (!this.support.audio) throw new Error('no supported audio format')

    const audioTracks = this.stream.getAudioTracks()
    if (audioTracks.length === 0) throw new Error('no audio track')

    // A separate MediaStream over the same track — not a clone of the stream,
    // which would also carry the video track into the "audio" file.
    const audioOnly = new MediaStream(audioTracks)
    this.audioRecorder = new MediaRecorder(audioOnly, {
      mimeType: this.support.audio,
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    })
    this.audioRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.audioChunks.push(event.data)
    }
    this.audioRecorder.onerror = () => this.onFailure?.()
    this.audioRecorder.start()

    if (this.support.video && this.stream.getVideoTracks().length > 0) {
      this.videoRecorder = new MediaRecorder(this.stream, {
        mimeType: this.support.video,
        videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
      })
      this.videoRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.videoChunks.push(event.data)
      }
      this.videoRecorder.onerror = () => this.onFailure?.()
      this.videoRecorder.start()
    }

    this.startedAt = Date.now()
    this.state = 'recording'
    this.tickTimer = setInterval(() => {
      this.onTick?.({ elapsedSeconds: this.elapsedSeconds() })
    }, 1000)
  }

  elapsedSeconds(): number {
    if (this.startedAt === 0) return 0
    return Math.floor((Date.now() - this.startedAt) / 1000)
  }

  async stop(): Promise<Recording> {
    if (this.state !== 'recording') throw new Error('recorder is not recording')
    this.state = 'stopping'
    if (this.tickTimer) clearInterval(this.tickTimer)

    const durationSeconds = (Date.now() - this.startedAt) / 1000
    // The audio is the answer — it is what gets transcribed — so only its
    // flush can fail the take. A video that does not flush costs the video.
    const [audio, video] = await Promise.allSettled([
      stopAndFlush(this.audioRecorder),
      stopAndFlush(this.videoRecorder),
    ])
    this.state = 'stopped'

    if (audio.status === 'rejected') throw audio.reason
    if (!this.support.audio) throw new Error('no supported audio format')
    const audioBlob = new Blob(this.audioChunks, { type: this.support.audio })
    // An empty take is a failure to show, not an answer to upload: sent as
    // is, it would transcribe to nothing and read as a candidate who said
    // nothing.
    if (audioBlob.size === 0) throw new Error('empty recording')

    const videoType =
      video.status === 'fulfilled' && this.videoChunks.length > 0
        ? this.support.video
        : null
    return {
      audio: audioBlob,
      audioMimeType: this.support.audio,
      video: videoType ? new Blob(this.videoChunks, { type: videoType }) : null,
      videoMimeType: videoType,
      durationSeconds: Math.round(durationSeconds),
    }
  }

  /** Abandon a take without producing blobs (candidate left, tab closed). */
  dispose(): void {
    if (this.tickTimer) clearInterval(this.tickTimer)
    for (const recorder of [this.audioRecorder, this.videoRecorder]) {
      if (recorder && recorder.state !== 'inactive') recorder.stop()
    }
    this.state = 'stopped'
  }
}

function stopAndFlush(recorder: MediaRecorder | null): Promise<void> {
  if (!recorder || recorder.state === 'inactive') return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('recorder did not stop')),
      STOP_TIMEOUT_MS,
    )
    recorder.onstop = () => {
      clearTimeout(timer)
      resolve()
    }
    try {
      recorder.stop()
    } catch (error) {
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error('recorder did not stop'))
    }
  })
}

/**
 * One stream, one blob — for the recruiter recording a question prompt.
 *
 * Distinct from `SegmentRecorder` on purpose: a question prompt is played
 * back, never transcribed, so it needs no separate audio track and there is
 * no reason to pay for one.
 */
export class SingleRecorder {
  private recorder: MediaRecorder | null = null
  private chunks: Array<Blob> = []
  private startedAt = 0
  private tickTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly stream: MediaStream,
    private readonly mimeType: string,
    private readonly onTick?: (tick: RecorderTick) => void,
  ) {}

  start(): void {
    this.recorder = new MediaRecorder(this.stream, {
      mimeType: this.mimeType,
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    })
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data)
    }
    this.recorder.start()
    this.startedAt = Date.now()
    this.tickTimer = setInterval(() => {
      this.onTick?.({
        elapsedSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      })
    }, 1000)
  }

  async stop(): Promise<{ blob: Blob; mimeType: string; durationSeconds: number }> {
    if (this.tickTimer) clearInterval(this.tickTimer)
    const durationSeconds = Math.round((Date.now() - this.startedAt) / 1000)
    await stopAndFlush(this.recorder)
    return {
      blob: new Blob(this.chunks, { type: this.mimeType }),
      mimeType: this.mimeType,
      durationSeconds,
    }
  }

  dispose(): void {
    if (this.tickTimer) clearInterval(this.tickTimer)
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop()
  }
}
