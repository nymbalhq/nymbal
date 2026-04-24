import { useState } from 'react'
import { X, Star, Plus, Image as ImageIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { ProductMedia } from '@/types'

interface MediaUploaderProps {
  media: ProductMedia[]
  onChange: (media: ProductMedia[]) => void
}

export function MediaUploader({ media, onChange }: MediaUploaderProps) {
  const [newUrl, setNewUrl] = useState('')
  const [newAlt, setNewAlt] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [editingAlt, setEditingAlt] = useState<number | null>(null)

  const addMedia = () => {
    if (!newUrl.trim()) return
    const next: ProductMedia[] = [
      ...media,
      { url: newUrl.trim(), altText: newAlt.trim(), position: media.length },
    ]
    onChange(next)
    setNewUrl('')
    setNewAlt('')
  }

  const removeMedia = (idx: number) => {
    const next = media.filter((_, i) => i !== idx).map((m, i) => ({ ...m, position: i }))
    onChange(next)
  }

  const setPrimary = (idx: number) => {
    const selected = media[idx]
    if (!selected) return
    const reordered = [selected, ...media.filter((_, i) => i !== idx)].map((m, i) => ({
      ...m,
      position: i,
    }))
    onChange(reordered)
  }

  const updateAlt = (idx: number, altText: string) => {
    const next = media.map((m, i) => (i === idx ? { ...m, altText } : m))
    onChange(next)
  }

  return (
    <div className="space-y-3">
      {/* Media grid */}
      {media.length > 0 && (
        <div className="grid grid-cols-4 gap-2">
          {media.map((item, idx) => (
            <div
              key={idx}
              className={cn(
                'group relative rounded-md border bg-zinc-50 overflow-hidden',
                idx === 0 ? 'border-blue-300 ring-1 ring-blue-300' : 'border-zinc-200'
              )}
            >
              {/* Thumbnail */}
              <div className="aspect-square flex items-center justify-center">
                {item.url ? (
                  <img
                    src={item.url}
                    alt={item.altText || 'Product image'}
                    className="h-full w-full object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none'
                    }}
                  />
                ) : (
                  <ImageIcon className="h-6 w-6 text-zinc-300" />
                )}
              </div>

              {/* Primary badge */}
              {idx === 0 && (
                <div className="absolute left-1 top-1 rounded bg-blue-500 px-1 py-0.5 text-[9px] font-semibold text-white">
                  Primary
                </div>
              )}

              {/* Actions overlay */}
              <div className="absolute inset-0 flex items-center justify-center gap-1 bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                {idx !== 0 && (
                  <button
                    onClick={() => setPrimary(idx)}
                    className="rounded bg-white/90 p-1 text-zinc-700 hover:bg-white"
                    title="Set as primary"
                  >
                    <Star className="h-3 w-3" />
                  </button>
                )}
                <button
                  onClick={() => removeMedia(idx)}
                  className="rounded bg-white/90 p-1 text-red-600 hover:bg-white"
                  title="Remove"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>

              {/* Alt text */}
              <div className="border-t border-zinc-100 px-1.5 py-1">
                {editingAlt === idx ? (
                  <input
                    autoFocus
                    value={item.altText}
                    onChange={(e) => updateAlt(idx, e.target.value)}
                    onBlur={() => setEditingAlt(null)}
                    className="w-full text-[10px] bg-transparent border-b border-zinc-300 outline-none"
                    placeholder="Alt text..."
                  />
                ) : (
                  <button
                    onClick={() => setEditingAlt(idx)}
                    className="w-full text-left text-[10px] text-zinc-400 hover:text-zinc-600 truncate"
                  >
                    {item.altText || 'Add alt text'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add URL form */}
      <div
        className={cn(
          'rounded-md border-2 border-dashed p-4 transition-colors',
          dragOver ? 'border-blue-400 bg-blue-50' : 'border-zinc-200'
        )}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
        }}
      >
        <div className="space-y-2">
          <p className="text-xs text-zinc-500 text-center">Add image by URL</p>
          <div className="flex gap-2">
            <div className="flex-1 space-y-1.5">
              <Label className="text-xs">Image URL</Label>
              <Input
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="https://cdn.example.com/image.jpg"
                className="text-xs h-8"
                onKeyDown={(e) => e.key === 'Enter' && addMedia()}
              />
            </div>
            <div className="flex-1 space-y-1.5">
              <Label className="text-xs">Alt Text</Label>
              <Input
                value={newAlt}
                onChange={(e) => setNewAlt(e.target.value)}
                placeholder="Describe the image"
                className="text-xs h-8"
                onKeyDown={(e) => e.key === 'Enter' && addMedia()}
              />
            </div>
            <div className="flex items-end">
              <Button
                type="button"
                size="sm"
                onClick={addMedia}
                disabled={!newUrl.trim()}
                className="h-8 gap-1"
              >
                <Plus className="h-3.5 w-3.5" />
                Add
              </Button>
            </div>
          </div>
        </div>
      </div>

      <p className="text-xs text-zinc-400">
        {media.length} image{media.length !== 1 ? 's' : ''} · Drag to reorder (coming soon)
      </p>
    </div>
  )
}
