import { useRef, useState } from 'react'
import { useConvexAction } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { Check, Paperclip } from 'lucide-react'

import { api } from '../../../convex/_generated/api'
import { candidateAction } from './CandidateShell'
import { errorMessageKey } from '~/lib/convex-errors'
import { uploadToSignedUrl } from '~/lib/media/upload'
import { Button } from '~/components/ui/button'
import { Label } from '~/components/ui/label'

const ACCEPT =
  '.pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/**
 * Upload a CV or a cover letter straight to object storage.
 *
 * The candidate is told, in words, what happened: uploading, uploaded, or why
 * it failed. A silent failure here means a recruiter reads an application with
 * no CV and never knows one was sent.
 */
export function DocumentUploadField({
  token,
  kind,
  label,
  required,
  uploaded,
  onUploaded,
}: {
  token: string
  kind: 'cv' | 'cover'
  label: string
  required: boolean
  uploaded: boolean
  onUploaded: () => void
}) {
  const { t } = useTranslation(['interview', 'common'])
  const requestUpload = useConvexAction(api.candidate.requestDocumentUpload)
  const attach = useConvexAction(api.candidate.attachDocument)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleFile = async (file: File) => {
    setBusy(true)
    setError(null)
    try {
      const slot = await requestUpload({
        token,
        kind,
        mimeType: file.type,
        contentLength: file.size,
      })
      await uploadToSignedUrl({
        url: slot.uploadUrl,
        blob: file,
        contentType: slot.contentType,
      })
      await attach({ token, kind, key: slot.key })
      onUploaded()
    } catch (cause) {
      const { key, fallbackKey } = errorMessageKey(cause, 'interview')
      setError(t(key, { defaultValue: t(fallbackKey) }))
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const inputId = `document-${kind}`

  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>
        {label}
        {required && (
          <span className="text-muted-foreground ml-2 text-xs font-normal">
            {t('interview:welcome.fields.required')}
          </span>
        )}
      </Label>

      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void handleFile(file)
        }}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          className={candidateAction}
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          <Paperclip className="size-4" />
          {uploaded
            ? t('interview:welcome.fields.replace')
            : t('interview:welcome.fields.choose')}
        </Button>
        {busy && (
          <span className="text-muted-foreground text-sm">
            {t('interview:run.sending')}
          </span>
        )}
        {!busy && uploaded && (
          <span className="text-success-strong flex items-center gap-1.5 text-sm">
            <Check className="size-4" />
            {t('interview:welcome.fields.uploaded')}
          </span>
        )}
      </div>

      <p className="text-muted-foreground text-xs">
        {t('interview:welcome.fields.uploadHint')}
      </p>
      {error && <p className="text-destructive-strong text-sm">{error}</p>}
    </div>
  )
}
