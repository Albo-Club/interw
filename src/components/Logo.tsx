import { cn } from '~/lib/utils'

type LogoProps = {
  variant?: 'full' | 'mark'
  className?: string
  alt?: string
}

export function Logo({
  variant = 'full',
  className,
  alt = 'interw',
}: LogoProps) {
  const src = variant === 'mark' ? '/logo-mark.svg' : '/logo.svg'
  return (
    <img
      src={src}
      alt={alt}
      className={cn('h-8 w-auto select-none', className)}
      draggable={false}
    />
  )
}
