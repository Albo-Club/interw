import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
import { PasswordInput } from '~/components/auth/password-input'
import { Field, FieldError, FieldLabel } from '~/components/ui/field'

type Props = {
  id: string
  /** The password being confirmed, for the live match feedback. */
  password: string
  value: string
  onChange: (value: string) => void
  onBlur: () => void
  /** Form errors, shown only when the live feedback has nothing to say —
   * an empty or too-short confirm would otherwise block submit silently. */
  errors?: Array<{ message?: string } | undefined>
}

export function ConfirmPasswordField({
  id,
  password,
  value,
  onChange,
  onBlur,
  errors,
}: Props) {
  const { t } = useTranslation('auth')
  // Cross-field match feedback. Stays silent while the user is still typing
  // (confirm shorter than password); kicks in once they've typed enough to
  // potentially match.
  const match = password.length > 0 && value.length > 0 && password === value
  const mismatch =
    password.length > 0 && value.length >= password.length && !match
  const showErrors = !match && !mismatch && !!errors?.length
  return (
    <Field data-invalid={mismatch || showErrors || undefined}>
      <FieldLabel htmlFor={id}>{t('fields.confirmPassword')}</FieldLabel>
      <PasswordInput
        id={id}
        name={id}
        autoComplete="new-password"
        value={value}
        onBlur={onBlur}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={mismatch || showErrors || undefined}
      />
      <div aria-live="polite">
        {match && (
          <p className="flex items-center gap-1.5 text-xs font-medium text-success-strong">
            <Check className="size-3.5" aria-hidden="true" />
            {t('reset.match')}
          </p>
        )}
        {mismatch && (
          <p className="text-destructive text-xs">{t('reset.mismatch')}</p>
        )}
      </div>
      {showErrors && <FieldError errors={errors} />}
    </Field>
  )
}
