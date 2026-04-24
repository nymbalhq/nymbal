import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SeoPreviewProps {
  title: string
  description: string
  url: string
}

export function SeoPreview({ title, description, url }: SeoPreviewProps) {
  const MAX_TITLE = 60
  const MAX_DESC = 155

  const titleTruncated = title.length > MAX_TITLE
  const descTruncated = description.length > MAX_DESC

  const displayTitle = titleTruncated ? title.slice(0, MAX_TITLE) + '...' : title
  const displayDesc = descTruncated ? description.slice(0, MAX_DESC) + '...' : description

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <div className="max-w-lg">
          {/* Google-style preview */}
          <p className="text-xs text-zinc-400 mb-1 truncate">{url || 'https://yourstore.com/products/...'}</p>
          <p
            className={cn(
              'text-[17px] leading-snug text-blue-700 cursor-pointer hover:underline mb-1',
              !title && 'text-zinc-300 italic'
            )}
          >
            {displayTitle || 'Page title appears here'}
          </p>
          <p
            className={cn(
              'text-sm leading-relaxed text-zinc-500',
              !description && 'text-zinc-300 italic'
            )}
          >
            {displayDesc || 'Meta description appears here...'}
          </p>
        </div>
      </div>

      {/* Warnings */}
      {(titleTruncated || descTruncated) && (
        <div className="space-y-1.5">
          {titleTruncated && (
            <div className="flex items-center gap-2 text-xs text-amber-600">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              Title is {title.length} chars — Google shows ~60. Consider shortening.
            </div>
          )}
          {descTruncated && (
            <div className="flex items-center gap-2 text-xs text-amber-600">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              Description is {description.length} chars — Google shows ~155. Consider shortening.
            </div>
          )}
        </div>
      )}

      {/* Character counts */}
      <div className="flex gap-4 text-xs text-zinc-400">
        <span className={cn(titleTruncated ? 'text-amber-500' : 'text-zinc-400')}>
          Title: {title.length}/{MAX_TITLE}
        </span>
        <span className={cn(descTruncated ? 'text-amber-500' : 'text-zinc-400')}>
          Description: {description.length}/{MAX_DESC}
        </span>
      </div>
    </div>
  )
}
