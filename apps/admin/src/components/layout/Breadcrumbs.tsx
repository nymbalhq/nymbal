import { useMatches, Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface BreadcrumbHandle {
  breadcrumb?: (params: Record<string, string | undefined>) => string | null
}

export function Breadcrumbs() {
  const matches = useMatches()

  const crumbs = matches
    .filter((match) => {
      const handle = match.handle as BreadcrumbHandle | undefined
      return handle?.breadcrumb != null
    })
    .map((match) => {
      const handle = match.handle as BreadcrumbHandle
      const label = handle.breadcrumb?.(match.params as Record<string, string | undefined>)
      return { label, pathname: match.pathname }
    })
    .filter((c): c is { label: string; pathname: string } => c.label != null)

  if (crumbs.length === 0) return null

  return (
    <nav className="flex items-center gap-1 text-sm" aria-label="Breadcrumb">
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1
        return (
          <span key={crumb.pathname} className="flex items-center gap-1">
            {index > 0 && <ChevronRight className="h-3.5 w-3.5 text-zinc-400" />}
            {isLast ? (
              <span className="font-medium text-zinc-900">{crumb.label}</span>
            ) : (
              <Link
                to={crumb.pathname}
                className={cn(
                  'text-zinc-500 hover:text-zinc-700 transition-colors',
                  'font-normal'
                )}
              >
                {crumb.label}
              </Link>
            )}
          </span>
        )
      })}
    </nav>
  )
}
