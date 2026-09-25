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
  detectBrowserSupport,
  openInterviewStream,
} from '~/lib/media/devices'
import { detectRecorderSupport } from '~/lib/media/recorder'
import { useAudioLevel } from '~/lib/media/useAudioLevel'
import { useCameraDark } from '~/lib/media/useCameraDark'
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
import { CandidateShell } from '~/components/candidate/CandidateShell'
import { CameraPreview } from '~/components/candidate/CameraPreview'
import { MicMeter } from '~/components/candidate/MicMeter'
import { PracticeTake } from '~/components/candidate/PracticeTake'
import { candidateErrorKey } from '~/components/candidate/errorState'
import { useCandidateLanguage } from '~/components/candidate/useCandidateLanguage'
import { cn } from '~/lib/utils'
import { candidateHead } from '~/components/candidate/screenHead'

export const Route = createFileRoute('/s/$token/check')({
  component: DeviceCheck,
  head: () => candidateHead('check'),
})

type Phase = 'starting' | 'live' | 'failed' | 'unsupported'

function DeviceCheck() {
  const { t } = useTranslation(['interview', 'common'])
  const { token } = Route.useParams()
  const navigate = useNavigate()

  const [now] = useState(() => Date.now())
  const data = useConvexQuery(api.candidate.landing, { token, now })
  const languageReady = useCandidateLanguage(data?.project.language)
  const logEvent = useConvexMutation(api.interview.logEvent)

  const [phase, setPhase] = useState<Phase>('starting')
  /** i18n key for why the devices could not be opened. */
  const [failure, setFailure] = useState<string | null>(null)
  const [cameras, setCameras] = useState<Array<MediaDeviceInfo>>([])
  const [microphones, setMicrophones] = useState<Array<MediaDeviceInfo>>([])
  const [cameraId, setCameraId] = useState<string>('')
  const [micId, setMicId] = useState<string>('')
  const [audioOnly, setAudioOnly] = useState(false)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [preview, setPreview] = useState<HTMLVideoElement | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const [verdict, setVerdict] = useState<MicVerdict>('silent')
  const cameraDark = useCameraDark(phase === 'live' && !audioOnly ? preview : null)

  const support = detectBrowserSupport()
  const recorderSupport = detectRecorderSupport()

  const teardown = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setStream(null)
  }, [])

  // Attached whenever both exist, whichever comes last. The stream is opened
  // on mount, while the skeleton is still on screen and the element is not.
  useEffect(() => {
    if (!preview || !stream) return
    preview.srcObject = stream
    fireAndForget(preview.play(), 'camera preview autoplay')
  }, [preview, stream])

  const startPreview = useCallback(async () => {
    teardown()
    setPhase('starting')
    try {
      // The very call the interview makes, so what is checked here is what
      // will be recorded — the audio-only fallback included.
      const opened = await openInterviewStream({
        cameraId: cameraId || undefined,
        micId: micId || undefined,
        video: recorderSupport.video !== null,
      })
      streamRef.current = opened.stream
      setStream(opened.stream)
      setAudioOnly(opened.audioOnly)

      // Labels are only populated once permission has been granted, so the
      // pickers are filled after getUserMedia, never before.
      const devices = await navigator.mediaDevices.enumerateDevices()
      setCameras(devices.filter((d) => d.kind === 'videoinput'))
      setMicrophones(devices.filter((d) => d.kind === 'audioinput'))
      setPhase('live')
    } catch (error) {
      setFailure(candidateErrorKey(error))
      setPhase('failed')
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
            <AlertTitle>
              {support.insecureContext
                ? t('interview:device.insecureContext')
                : t('interview:device.unsupported')}
            </AlertTitle>
          </Alert>
        ) : (
          <>
            <CameraPreview ref={setPreview} audioOnly={phase === 'live' && audioOnly}>
              {phase !== 'live' && (
                <div className="text-muted-foreground absolute inset-0 flex items-center justify-center text-sm">
                  {phase === 'starting'
                    ? t('common:loadingEllipsis')
                    : t('interview:device.preview')}
                </div>
              )}
            </CameraPreview>

            {phase === 'failed' && failure && (
              <Alert variant="destructive">
                <AlertTitle>
                  {t(failure, { defaultValue: t('interview:errors.unexpected') })}
                </AlertTitle>
                {failure === 'interview:device.permissionDenied' && (
                  <AlertDescription>
                    {t('interview:device.permissionHelp')}
                  </AlertDescription>
                )}
              </Alert>
            )}

            {cameraDark && (
              <Alert>
                <CircleAlert className="size-4" />
                <AlertDescription>{t('interview:device.cameraDark')}</AlertDescription>
              </Alert>
            )}

            {phase === 'live' && (
              <>
                <MicCheck stream={stream} onVerdict={setVerdict} />

                {stream && recorderSupport.audio && (
                  <PracticeTake
                    stream={stream}
                    mimeType={
                      (!audioOnly && recorderSupport.video) ||
                      recorderSupport.audio
                    }
                  />
                )}

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
            onClick={() => void startPreview()}
          >
            {t('interview:device.retry')}
          </Button>
        </div>
      </div>
    </CandidateShell>
  )
}

/**
 * Its own component so the meter's ten readings a second re-render the meter,
 * not the whole screen. The page only hears about the verdict, which changes
 * rarely.
 */
function MicCheck({
  stream,
  onVerdict,
}: {
  stream: MediaStream | null
  onVerdict: (verdict: MicVerdict) => void
}) {
  const { t } = useTranslation(['interview', 'common'])
  // The last ten seconds: someone who says one sentence and then waits has a
  // working microphone.
  const { level, recent } = useAudioLevel(stream, 10_000)
  const verdict = assessMicLevels(recent)
  useEffect(() => onVerdict(verdict), [verdict, onVerdict])
  return (
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
