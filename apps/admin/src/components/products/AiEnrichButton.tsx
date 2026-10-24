import { useState } from 'react'
import { Sparkles, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useEnhanceProduct } from '@/hooks/useProducts'
import { tid } from '@/lib/testid'
import { cn } from '@/lib/utils'

interface AiEnrichButtonProps {
  productId: string
  field: 'description' | 'alt' | 'title' | 'seoDescription'
  context: { name?: string | undefined; current?: string | undefined }
  onApply: (suggestion: string) => void
  className?: string | undefined
}

export function AiEnrichButton({ productId, field, context, onApply, className }: AiEnrichButtonProps) {
  const [suggestion, setSuggestion] = useState<string | null>(null)
  const enhance = useEnhanceProduct()

  const handleEnhance = async () => {
    setSuggestion(null)
    const contextRecord: Record<string, string> = {}
    if (context.name) contextRecord['name'] = context.name
    if (context.current) contextRecord['current'] = context.current
    const result = await enhance.mutateAsync({
      id: productId,
      field,
      context: contextRecord,
    })
    setSuggestion(result.suggestion)
  }

  const handleApply = () => {
    if (suggestion) {
      onApply(suggestion)
      setSuggestion(null)
    }
  }

  const handleDismiss = () => {
    setSuggestion(null)
  }

  return (
    <div className={cn('space-y-2', className)} data-testid={tid('product', 'ai-enrich', field)}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void handleEnhance()}
        disabled={enhance.isPending}
        className="gap-1.5 text-xs text-purple-700 border-purple-200 hover:bg-purple-50 hover:border-purple-300"
      >
        <Sparkles className={cn('h-3.5 w-3.5', enhance.isPending && 'animate-spin')} />
        {enhance.isPending ? 'Enhancing...' : 'Enhance with AI'}
      </Button>

      {suggestion && (
        <div className="rounded-md border border-purple-200 bg-purple-50 p-3 space-y-2">
          <p className="text-xs font-medium text-purple-800 uppercase tracking-wider">AI Suggestion</p>
          <p className="text-sm text-zinc-700 whitespace-pre-wrap">{suggestion}</p>
          <div className="flex gap-2 pt-1">
            <Button
              type="button"
              size="sm"
              onClick={handleApply}
              className="gap-1.5 bg-purple-600 hover:bg-purple-700 text-white text-xs"
            >
              <Check className="h-3.5 w-3.5" />
              Apply
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleDismiss}
              className="gap-1.5 text-zinc-500 text-xs"
            >
              <X className="h-3.5 w-3.5" />
              Dismiss
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
