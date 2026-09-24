import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useConvexMutation, useConvexQuery } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'

import { Check, CircleAlert, Mic, Video } from 'lucide-react'

import { api } from '../../../../convex/_generated/api'
import type { MicVerdict } from '~/lib/media/devices'
import { fireAndForget } from '~/lib/fire-and-forget'
import {
  assessMicLevels,
  classifyMediaError,
  detectBrowserSupport,
  levelFromTimeDomain,
  openInterviewStream,
} from '~/lib/media/devices'
import { detectRecorderSupport } from '~/lib/media/recorder'
import { Button } from '~/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { Skeleton } from '~/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { Label } from '~/components/ui/label'
import { CandidateNotice } from '~/components/candidate/CandidateNotice'
import {
  CandidateShell,
  candidateAction,
} from '~/components/candidate/CandidateShell'
import { useCandidateLanguage } from '~/components/candidate/useCandidateLanguage'
import { cn } from '~/lib/utils'

export const Route = createFileRoute('/s/$token/check')({
  component: DeviceCheck,
})

type Phase =
  | 'starting'
  | 'live'
  | 'denied'
  | 'busy'
  | 'nodevice'
  | 'failed'
  | 'unsupported'

function DeviceCheck() {
  const { t } = useTranslation(['interview', 'common'])
  const { token } = Route.useParams()
  const navigate = useNavigate()

  const [now] = useState(() => Date.now())
  const data = useConvexQuery(api.candidate.landing, { token, now })
  const languageReady = useCandidateLanguage(data?.project.language)
  const logEvent = useConvexMutation(api.interview.logEvent)

  const [phase, setPhase] = useState<Phase>('starting')
  const [cameras, setCameras] = useState<Array<MediaDeviceInfo>>([])
  const [microphones, setMicrophones] = useState<Array<MediaDeviceInfo>>([])
  const [cameraId, setCameraId] = useState<string>('')
  const [micId, setMicId] = useState<string>('')
  const [audioOnly, setAudioOnly] = useState(false)
  const [level, setLevel] = useState(0)
  const [verdict, setVerdict] = useState<MicVerdict>('silent')

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number | null>(null)
  const levelsRef = useRef<Array<number>>([])

  const support = detectBrowserSupport()
  const recorderSupport = detectRecorderSupport()

  const teardown = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    void audioContextRef.current?.close().catch(() => undefined)
    audioContextRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  const startPreview = useCallback(async () => {
    teardown()
    setPhase('starting')
    levelsRef.current = []
    try {
      // The very call the interview makes, so what is checked here is what
      // will be recorded — the audio-only fallback included.
      const { stream, audioOnly: withoutCamera } = await openInterviewStream({
        cameraId: cameraId || undefined,
        micId: micId || undefined,
        video: recorderSupport.video !== null,
      })
      streamRef.current = stream
      setAudioOnly(withoutCamera)
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        // Autoplay rejection is expected, not an error: browsers refuse it
      // without a user gesture, and the preview still renders the stream.
      await videoRef.current.play().catch(() => undefined)
      }

      // Labels are only populated once permission has been granted, so the
      // pickers are filled after getUserMedia, never before.
      const devices = await navigator.mediaDevices.enumerateDevices()
      setCameras(devices.filter((d) => d.kind === 'videoinput'))
      setMicrophones(devices.filter((d) => d.kind === 'audioinput'))

      // Safari below 14.1 only exposes the prefixed constructor.
      const scope = window as unknown as {
        AudioContext?: typeof AudioContext
        webkitAudioContext?: typeof AudioContext
      }
      const AudioCtx = scope.AudioContext ?? scope.webkitAudioContext
      if (!AudioCtx) throw new Error('no AudioContext')
      const context = new AudioCtx()
      audioContextRef.current = context
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      context.createMediaStreamSource(stream).connect(analyser)
      const buffer = new Uint8Array(analyser.fftSize)

      const tick = () => {
        analyser.getByteTimeDomainData(buffer)
        const value = levelFromTimeDomain(buffer)
        setLevel(value)
        levelsRef.current.push(value)
        if (levelsRef.current.length > 600) levelsRef.current.shift()
        setVerdict(assessMicLevels(levelsRef.current))
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
      setPhase('live')
    } catch (error) {
      const failure = classifyMediaError(error)
      setPhase(
        failure === 'permissionDenied'
          ? 'denied'
          : failure === 'busy'
            ? 'busy'
            : failure === 'noDevices'
              ? 'nodevice'
              : 'failed',
      )
      fireAndForget(logEvent({
        token,
        kind: 'device_check_failed',
        detail: error instanceof Error ? error.name : 'unknown',
      }), 'candidate event log')
    }
  }, [cameraId, micId, recorderSupport.video, logEvent, teardown, token])

  useEffect(() => {
    if (!support.usable) {
      setPhase('unsupported')
      return
    }
    void startPreview()
    return teardown
  }, [support.usable, startPreview, teardown])

  if (data === undefined || !languageReady) {
    return (
      <CandidateShell>
        <div className="space-y-6">
          <Skeleton className="h-9 w-72" />
          <Skeleton className="aspect-[3/4] w-full rounded-lg sm:aspect-video" />
        </div>
      </CandidateShell>
    )
  }

  const gateState = data.gate.state
  if (gateState !== 'ready' && gateState !== 'resumable') {
    return (
      <CandidateNotice
        organisationName={data.organisationName}
        title={t(`interview:state.${gateState}.title`)}
        body={t(`interview:state.${gateState}.body`, {
          org: data.organisationName,
        })}
      />
    )
  }

  const proceed = () => {
    fireAndForget(logEvent({ token, kind: 'device_check_passed' }), 'candidate event log')
    teardown()
    // The devices chosen here are the ones the interview opens.
    void navigate({
      to: '/s/$token/interview',
      params: { token },
      search: { camera: cameraId || undefined, mic: micId || undefined },
    })
  }

  return (
    <CandidateShell
      organisationName={data.organisationName}
      privacyToken={token}
    >
      <div className="space-y-8">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('interview:device.title')}
          </h1>
          <p className="text-muted-foreground leading-relaxed">
            {t('interview:device.subtitle')}
          </p>
        </header>

        {support.inAppBrowser && (
          <Alert>
            <CircleAlert className="size-4" />
            <AlertDescription>
              {t('interview:device.inAppBrowser')}
            </AlertDescription>
          </Alert>
        )}

        {phase === 'unsupported' || !recorderSupport.usable ? (
          <Alert variant="destructive">
            <AlertTitle>{t('interview:device.unsupported')}</AlertTitle>
          </Alert>
        ) : (
          <>
            <div className="bg-muted relative aspect-[3/4] w-full overflow-hidden rounded-lg sm:aspect-video">
              <video
                ref={videoRef}
                muted
                playsInline
                className="size-full scale-x-[-1] object-cover"
              />
              {phase === 'live' && audioOnly && (
                <div className="bg-muted text-muted-foreground absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-sm">
                  <Mic className="size-8" />
                  <p className="max-w-sm leading-relaxed">
                    {t('interview:run.audioOnly')}
                  </p>
                </div>
              )}
              {phase !== 'live' && (
                <div className="text-muted-foreground absolute inset-0 flex items-center justify-center text-sm">
                  {phase === 'starting'
                    ? t('common:loadingEllipsis')
                    : t('interview:device.preview')}
                </div>
              )}
            </div>

            {phase === 'denied' && (
              <Alert variant="destructive">
                <AlertTitle>
                  {t('interview:device.permissionDenied')}
                </AlertTitle>
                <AlertDescription>
                  {t('interview:device.permissionHelp')}
                </AlertDescription>
              </Alert>
            )}
            {phase === 'busy' && (
              <Alert variant="destructive">
                <AlertTitle>{t('interview:device.busy')}</AlertTitle>
              </Alert>
            )}
            {phase === 'nodevice' && (
              <Alert variant="destructive">
                <AlertTitle>{t('interview:device.noDevices')}</AlertTitle>
              </Alert>
            )}
            {phase === 'failed' && (
              <Alert variant="destructive">
                <AlertTitle>{t('interview:errors.unexpected')}</AlertTitle>
              </Alert>
            )}

            {phase === 'live' && (
              <>
                <section className="space-y-3">
                  <p className="text-sm font-medium">
                    {t('interview:device.speakPrompt')}
                  </p>
                  <MicMeter level={level} verdict={verdict} />
                  <p
                    role="status"
                    aria-live="polite"
                    className={cn(
                      'text-sm',
                      verdict === 'good'
                        ? 'text-success-strong'
                        : verdict === 'quiet'
                          ? 'text-warning-strong'
                          : 'text-muted-foreground',
                    )}
                  >
                    {verdict === 'good'
                      ? t('interview:device.micGood')
                      : verdict === 'quiet'
                        ? t('interview:device.micQuiet')
                        : t('interview:device.micSilent')}
                  </p>
                </section>

                <section className="grid gap-4 sm:grid-cols-2">
                  <DevicePicker
                    id="camera"
                    icon={<Video className="size-4" />}
                    label={t('interview:device.cameraLabel')}
                    devices={cameras}
                    value={cameraId}
                    onChange={setCameraId}
                  />
                  <DevicePicker
                    id="microphone"
                    icon={<Mic className="size-4" />}
                    label={t('interview:device.micLabel')}
                    devices={microphones}
                    value={micId}
                    onChange={setMicId}
                  />
                </section>
              </>
            )}
          </>
        )}

        <div className="flex flex-wrap gap-3 border-t pt-6">
          {/* The candidate is never trapped by our own check: a mic meter can
              be wrong, and blocking someone out of their interview over it
              would be worse than a quiet recording. */}
          <Button
            size="lg"
            className={candidateAction}
            onClick={proceed}
            disabled={!recorderSupport.usable}
          >
            {verdict === 'good' ? (
              <>
                <Check className="size-4" />
                {t('interview:device.continue')}
              </>
            ) : (
              t('interview:device.continueAnyway')
            )}
          </Button>
          <Button
            variant="outline"
            size="lg"
            className={candidateAction}
            onClick={() => void startPreview()}
          >
            {t('interview:device.retry')}
          </Button>
        </div>
      </div>
    </CandidateShell>
  )
}

function MicMeter({ level, verdict }: { level: number; verdict: MicVerdict }) {
  const { t } = useTranslation('interview')
  const percent = Math.min(100, Math.round(level * 320))
  return (
    <div
      className="bg-muted h-3 w-full overflow-hidden rounded-full"
      role="meter"
      aria-label={t('device.micLabel')}
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn(
          'h-full transition-[width] duration-75 motion-reduce:transition-none',
          verdict === 'good'
            ? 'bg-success'
            : verdict === 'quiet'
              ? 'bg-warning'
              : 'bg-muted-foreground/40',
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  )
}

function DevicePicker({
  id,
  icon,
  label,
  devices,
  value,
  onChange,
}: {
  id: string
  icon: React.ReactNode
  label: string
  devices: Array<MediaDeviceInfo>
  value: string
  onChange: (value: string) => void
}) {
  if (devices.length <= 1) return null
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="flex items-center gap-2">
        {icon}
        {label}
      </Label>
      <Select value={value || devices[0].deviceId} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {devices.map((device, index) => (
            <SelectItem key={device.deviceId} value={device.deviceId}>
              {device.label || `${label} ${index + 1}`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
