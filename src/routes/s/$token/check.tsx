import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useConvexMutation, useConvexQuery } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'

import { Check, ChevronDown, CircleAlert, Mic, Settings2, Video } from 'lucide-react'

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
import { Stage } from '~/components/candidate/Stage'
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
  /** The practice take's blob URL, played on the stage while it exists. */
  const [take, setTake] = useState<string | null>(null)

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
      <CandidateShell width="stage">
        <Skeleton className="mb-4 h-12 w-72 max-w-full" />
        <Skeleton className="min-h-0 flex-1 rounded-xl" />
        <Skeleton className="mx-auto mt-4 h-11 w-48" />
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

  // Nothing to preview: the stage stays dark and says why.
  const blocked = phase === 'unsupported' || !recorderSupport.usable

  return (
    <CandidateShell
      width="stage"
      organisationName={data.organisationName}
      logoUrl={data.organisationLogoUrl}
      privacyToken={token}
    >
      <header className="mb-4 space-y-1">
        <h1 className="text-lg font-semibold tracking-tight">
          {t('interview:device.title')}
        </h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          {t('interview:device.subtitle')}
        </p>
      </header>

      {/* Warnings that leave the camera usable sit above the stage rather
          than over it: the candidate watches the preview while fixing them. */}
      <div className="mb-4 space-y-3 empty:hidden">
        {support.inAppBrowser && (
          <Alert>
            <CircleAlert className="size-4" />
            <AlertDescription>
              {t('interview:device.inAppBrowser')}
            </AlertDescription>
          </Alert>
        )}
        {cameraDark && (
          <Alert>
            <CircleAlert className="size-4" />
            <AlertDescription>{t('interview:device.cameraDark')}</AlertDescription>
          </Alert>
        )}
      </div>

      <Stage
        // A practice take has the floor while it exists, as a question does
        // in the interview: the live camera steps into the corner.
        prompt={
          take ? (
            <video
              src={take}
              controls
              playsInline
              className="size-full object-contain"
            />
          ) : null
        }
        self={
          blocked ? null : (
            <CameraPreview
              ref={setPreview}
              fill
              audioOnly={phase === 'live' && audioOnly}
            >
              {phase !== 'live' && (
                <div className="text-stage-foreground/80 absolute inset-0 flex items-center justify-center text-sm">
                  {phase === 'starting'
                    ? t('common:loadingEllipsis')
                    : t('interview:device.preview')}
                </div>
              )}
            </CameraPreview>
          )
        }
        // Left out under a take, whose own controls sit along that edge.
        caption={
          phase === 'live' &&
          !take && (
            <p className="text-center text-sm text-balance">
              {t('interview:device.speakPrompt')}
            </p>
          )
        }
        status={
          phase === 'live' && (
            // Clear of the camera thumbnail a take puts in the other corner.
            <div
              className={cn(
                'absolute top-3 left-3',
                take ? 'right-36 sm:right-56' : 'right-3',
              )}
            >
              <MicCheck stream={stream} onVerdict={setVerdict} />
            </div>
          )
        }
        // The titles are whole sentences saying what to do: never clamped.
        overlay={
          blocked ? (
            <Alert variant="destructive">
              <AlertTitle className="line-clamp-none">
                {support.insecureContext
                  ? t('interview:device.insecureContext')
                  : t('interview:device.unsupported')}
              </AlertTitle>
            </Alert>
          ) : phase === 'failed' && failure ? (
            <Alert variant="destructive">
              <AlertTitle className="line-clamp-none">
                {t(failure, { defaultValue: t('interview:errors.unexpected') })}
              </AlertTitle>
              {failure === 'interview:device.permissionDenied' && (
                <AlertDescription>
                  {t('interview:device.permissionHelp')}
                </AlertDescription>
              )}
            </Alert>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center justify-center gap-2 pt-3">
        {phase === 'live' && stream && recorderSupport.audio && (
          <PracticeTake
            stream={stream}
            mimeType={
              (!audioOnly && recorderSupport.video) || recorderSupport.audio
            }
            onTake={setTake}
          />
        )}
        <Button variant="ghost" onClick={() => void startPreview()}>
          {t('interview:device.retry')}
        </Button>
        {phase === 'live' && (cameras.length > 1 || microphones.length > 1) && (
          // Native disclosure: keyboard and screen readers get it for free.
          // Open, it takes a line of its own and the stage gives up the room.
          <details className="group open:basis-full">
            <summary className="hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring/50 mx-auto flex min-h-11 w-fit cursor-pointer list-none items-center gap-2 rounded-md px-3 text-sm font-medium outline-none focus-visible:ring-[3px] [&::-webkit-details-marker]:hidden">
              <Settings2 className="size-4" />
              {t('interview:device.settings')}
              <ChevronDown className="size-4 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
            </summary>
            <div className="flex flex-wrap justify-center gap-x-6 gap-y-3 pt-3">
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
            </div>
          </details>
        )}
      </div>

      {/* Where the interview's own button is. The candidate is never trapped
          by our own check: a mic meter can be wrong, and blocking someone out
          of their interview over it would be worse than a quiet recording. */}
      <div className="flex justify-center pt-4">
        <Button size="lg" onClick={proceed} disabled={!recorderSupport.usable}>
          {verdict === 'good' ? (
            <>
              <Check className="size-4" />
              {t('interview:device.continue')}
            </>
          ) : (
            t('interview:device.continueAnyway')
          )}
        </Button>
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
    <div className="bg-stage/80 w-fit max-w-full space-y-2 rounded-lg px-3 py-2 backdrop-blur-sm">
      <p role="status" aria-live="polite" className="flex gap-2 text-sm">
        <Mic
          aria-hidden
          className={cn(
            'mt-0.5 size-4 shrink-0',
            verdict === 'good'
              ? 'text-success'
              : verdict === 'quiet'
                ? 'text-warning'
                : 'text-stage-foreground/70',
          )}
        />
        {verdict === 'good'
          ? t('interview:device.micGood')
          : verdict === 'quiet'
            ? t('interview:device.micQuiet')
            : t('interview:device.micSilent')}
      </p>
      <MicMeter
        level={level}
        verdict={verdict}
        className="bg-stage-foreground/20 h-1"
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
