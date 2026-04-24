import { useState } from 'react'
import { Send } from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { useAddOrderNote } from '@/hooks/useOrders'
import { formatDate, formatRelative } from '@/lib/dates'
import { tid } from '@/lib/testid'
import type { NoteEntry } from '@/types'

interface OrderNotesPanelProps {
  orderId: string
  notes: NoteEntry[]
}

export function OrderNotesPanel({ orderId, notes }: OrderNotesPanelProps) {
  const [body, setBody] = useState('')
  const addNote = useAddOrderNote()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!body.trim()) return
    await addNote.mutateAsync({ orderId, body: body.trim() })
    setBody('')
  }

  return (
    <div data-testid={tid('order', 'notes')}>
      {/* Notes list */}
      <div className="space-y-3">
        {notes.length === 0 ? (
          <p className="text-sm text-zinc-400 italic">No notes yet.</p>
        ) : (
          [...notes]
            .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
            .map((note, idx) => (
              <NoteCard key={idx} note={note} />
            ))
        )}
      </div>

      {/* Add note form */}
      <form onSubmit={(e) => void handleSubmit(e)} className="mt-4 flex gap-2">
        <Textarea
          placeholder="Add an internal note..."
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          className="flex-1 text-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void handleSubmit(e as unknown as React.FormEvent)
            }
          }}
        />
        <Button
          type="submit"
          size="icon"
          disabled={!body.trim() || addNote.isPending}
          className="self-end h-9 w-9"
        >
          <Send className="h-4 w-4" />
        </Button>
      </form>
    </div>
  )
}

function NoteCard({ note }: { note: NoteEntry }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
      <p className="text-sm text-zinc-700 whitespace-pre-wrap">{note.body}</p>
      <div className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
        <span className="font-medium text-zinc-500">{note.actor}</span>
        <span>·</span>
        <time dateTime={note.at} title={formatDate(note.at)}>
          {formatRelative(note.at)}
        </time>
      </div>
    </div>
  )
}
