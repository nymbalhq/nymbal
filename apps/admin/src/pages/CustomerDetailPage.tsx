import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, Send } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { CustomerProfileCard } from '@/components/customers/CustomerProfileCard'
import { CustomerOrdersTable } from '@/components/customers/CustomerOrdersTable'
import { useCustomer, useCustomerOrders, useAddCustomerNote } from '@/hooks/useCustomers'
import { formatDate, formatRelative } from '@/lib/dates'
import { tid } from '@/lib/testid'
import type { NoteEntry } from '@/types'

function NotesList({ notes }: { notes: NoteEntry[] }) {
  return (
    <div className="space-y-2">
      {notes.length === 0 ? (
        <p className="text-sm text-zinc-400 italic">No notes yet.</p>
      ) : (
        [...notes]
          .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
          .map((note, idx) => (
            <div key={idx} className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
              <p className="text-sm text-zinc-700 whitespace-pre-wrap">{note.body}</p>
              <div className="mt-1.5 flex items-center gap-2 text-xs text-zinc-400">
                <span className="font-medium text-zinc-500">{note.actor}</span>
                <span>·</span>
                <time dateTime={note.at} title={formatDate(note.at)}>
                  {formatRelative(note.at)}
                </time>
              </div>
            </div>
          ))
      )}
    </div>
  )
}

export function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [noteBody, setNoteBody] = useState('')

  const { data: customerData, isLoading } = useCustomer(id ?? '')
  const { data: orders, isLoading: ordersLoading } = useCustomerOrders(id ?? '')
  const addNote = useAddCustomerNote()

  const handleAddNote = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!noteBody.trim() || !id) return
    await addNote.mutateAsync({ customerId: id, body: noteBody.trim() })
    setNoteBody('')
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  if (!customerData) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <p className="text-sm text-zinc-500">Customer not found</p>
        <Link to="/customers" className="mt-3 text-sm text-blue-600 hover:underline">
          ← Back to customers
        </Link>
      </div>
    )
  }

  const { customer, stats } = customerData
  const fullName = [customer.firstName, customer.lastName].filter(Boolean).join(' ') || customer.email
  const notes = (customer as unknown as { notes?: typeof customer.metadata }).notes as NoteEntry[] | undefined ?? []

  return (
    <div className="space-y-5" data-testid={tid('customer', 'detail')}>
      {/* Back */}
      <div className="flex items-center gap-2">
        <Link
          to="/customers"
          className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-700"
        >
          <ArrowLeft className="h-4 w-4" />
          Customers
        </Link>
        <span className="text-zinc-300">/</span>
        <span className="text-sm font-medium text-zinc-900">{fullName}</span>
      </div>

      {/* Profile card */}
      <div className="rounded-lg border border-zinc-200 bg-white p-5">
        <CustomerProfileCard customer={customer} stats={stats} />
      </div>

      {/* Orders */}
      <div className="rounded-lg border border-zinc-200 bg-white overflow-hidden">
        <div className="border-b border-zinc-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-900">Order History</h2>
        </div>
        <div className="p-4">
          <CustomerOrdersTable orders={orders} isLoading={ordersLoading} />
        </div>
      </div>

      {/* Notes */}
      <div className="rounded-lg border border-zinc-200 bg-white p-5 space-y-3" data-testid={tid('customer', 'notes')}>
        <h2 className="text-sm font-semibold text-zinc-900">Notes</h2>
        <NotesList notes={notes} />
        <form
          onSubmit={(e) => void handleAddNote(e)}
          className="flex gap-2 pt-2"
        >
          <Textarea
            placeholder="Add a note about this customer..."
            value={noteBody}
            onChange={(e) => setNoteBody(e.target.value)}
            rows={2}
            className="flex-1 text-sm"
          />
          <Button
            type="submit"
            size="icon"
            disabled={!noteBody.trim() || addNote.isPending}
            className="self-end h-9 w-9"
          >
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </div>
    </div>
  )
}

export const customerDetailHandle = {
  breadcrumb: (_params: Record<string, string | undefined>) => 'Customer',
}
