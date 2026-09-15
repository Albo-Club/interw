import { Link, createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Clock, Quote, Video } from 'lucide-react'

import { Button } from '~/components/ui/button'
import { Logo } from '~/components/Logo'
import { LanguageSwitcher } from '~/components/i18n/LanguageSwitcher'
import { useRedirectWhenAuthenticated } from '~/lib/auth-state'
import { getI18n } from '~/lib/i18n'
import { getLocale } from '~/lib/locale'

export const Route = createFileRoute('/')({
  component: Home,
  head: () => {
    const t = getI18n(getLocale()).getFixedT(null, 'landing')
    return {
      meta: [
        { title: t('metaTitle') },
        { name: 'description', content: t('metaDescription') },
      ],
    }
  },
})

function Home() {
  useRedirectWhenAuthenticated()
  const { t } = useTranslation('landing')
  return (
    <main className="relative flex min-h-svh flex-col items-center justify-center gap-8 p-8">
      <div className="absolute top-4 right-4">
        <LanguageSwitcher />
      </div>
      <Logo className="h-10" />
      <h1 className="text-center text-4xl font-bold tracking-tight text-balance">
        {t('tagline')}
      </h1>
      <ul className="text-muted-foreground max-w-md space-y-3 text-sm">
        <Step icon={<Video className="size-4" />}>{t('steps.ask')}</Step>
        <Step icon={<Clock className="size-4" />}>{t('steps.answer')}</Step>
        <Step icon={<Quote className="size-4" />}>{t('steps.evidence')}</Step>
      </ul>
      <div className="flex gap-3">
        <Button asChild>
          <Link to="/register">{t('createAccount')}</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/login">{t('signIn')}</Link>
        </Button>
      </div>
    </main>
  )
}

function Step({
  icon,
  children,
}: {
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <li className="flex items-start gap-3">
      <span aria-hidden="true" className="mt-0.5 shrink-0">
        {icon}
      </span>
      <span className="leading-relaxed">{children}</span>
    </li>
  )
}
