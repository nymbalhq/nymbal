import { useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, Send } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { HistoryTab } from '@/components/history/HistoryTab'
import { CustomerProfileCard } from '@/components/customers/CustomerProfileCard'
import { CustomerOrdersTable } from '@/components/customers/CustomerOrdersTable'
import {
  useCustomer,
  useCustomerOrders,
  useAddCustomerNote,
  useMarkVerified,
  useSendVerification,
} from '@/hooks/useCustomers'
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

/**
 * Support's rescue of a sign-up whose confirmation mail went missing: send the link again, or mark the email confirmed
 * so the customer's password signs in. Each press is one request, whatever the clicks. A confirmed customer is no
 * longer pending, so the panel goes and `onConfirmed` lets the page say so.
 */
function VerificationPanel({
  customerId,
  onConfirmed,
}: {
  customerId: string
  onConfirmed: () => void
}) {
  const send = useSendVerification()
  const mark = useMarkVerified()
  // Set in the click itself: `isPending` reaches the buttons only after a render, too late for a double click.
  const acting = useRef(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const act = async (run: () => Promise<string | null>) => {
    if (acting.current) return
    acting.current = true
    setBusy(true)
    try {
      setResult(await run())
    } catch (err) {
      setResult(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      acting.current = false
      setBusy(false)
    }
  }

  return (
    <div
      className="rounded-lg border border-amber-200 bg-amber-50 p-5 space-y-3"
      data-testid={tid('customer', 'verification')}
    >
      <h2 className="text-sm font-semibold text-zinc-900">Email not confirmed</h2>
      <p className="text-sm text-zinc-600">
        This customer has not followed the link in their confirmation email, so their password does
        not sign in yet.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            act(async () => {
              await send.mutateAsync({ customerId })
              return 'A new confirmation link is on its way.'
            })
          }
          data-testid={tid('customer', 'send-verification')}
        >
          Send the link again
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            act(async () => {
              await mark.mutateAsync({ customerId })
              onConfirmed()
              return null
            })
          }
          data-testid={tid('customer', 'mark-verified')}
        >
          Mark as confirmed
        </Button>
      </div>
      {result !== null && (
        <p role="status" className="text-sm text-zinc-700">
          {result}
        </p>
      )}
    </div>
  )
}

export function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [noteBody, setNoteBody] = useState('')
  // Set in the submit itself: `isPending` reaches the button only after a render, too late for a double click.
  const submitting = useRef(false)
  const [busy, setBusy] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  const { data: customerData, isLoading } = useCustomer(id ?? '')
  const { data: orders, isLoading: ordersLoading } = useCustomerOrders(id ?? '')
  const addNote = useAddCustomerNote()

  const handleAddNote = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!noteBody.trim() || !id || submitting.current) return
    submitting.current = true
    setBusy(true)
    try {
      await addNote.mutateAsync({ customerId: id, body: noteBody.trim() })
      setNoteBody('')
    } finally {
      submitting.current = false
      setBusy(false)
    }
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
  const fullName =
    [customer.firstName, customer.lastName].filter(Boolean).join(' ') || customer.email
  const notes = (customer.metadata.adminNotes as NoteEntry[] | undefined) ?? []

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
        <span className="min-w-0 text-sm font-medium text-zinc-900 [overflow-wrap:anywhere]">
          {fullName}
        </span>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview" data-testid={tid('customer', 'tab', 'overview')}>
            Overview
          </TabsTrigger>
          <TabsTrigger value="history" data-testid={tid('customer', 'tab', 'history')}>
            History
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-5">
          {customer.emailVerification === 'pending' ? (
            <VerificationPanel customerId={customer.id} onConfirmed={() => setConfirmed(true)} />
          ) : (
            confirmed && (
              <p
                role="status"
                className="rounded-lg border border-zinc-200 bg-white p-5 text-sm text-zinc-700"
                data-testid={tid('customer', 'verification-confirmed')}
              >
                Email marked confirmed: their password now signs in.
              </p>
            )
          )}

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
          <div
            className="rounded-lg border border-zinc-200 bg-white p-5 space-y-3"
            data-testid={tid('customer', 'notes')}
          >
            <h2 className="text-sm font-semibold text-zinc-900">Notes</h2>
            <NotesList notes={notes} />
            <form onSubmit={(e) => void handleAddNote(e)} className="flex gap-2 pt-2">
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
                disabled={!noteBody.trim() || busy}
                className="self-end h-9 w-9"
              >
                <Send className="h-4 w-4" />
              </Button>
            </form>
          </div>
        </TabsContent>

        <TabsContent value="history">
          <div className="rounded-lg border border-zinc-200 bg-white p-5">
            <HistoryTab
              collection="customers"
              id={customer.id}
              detailPath={`/api/admin/customers/${encodeURIComponent(customer.id)}`}
            />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

export const customerDetailHandle = {
  breadcrumb: (_params: Record<string, string | undefined>) => 'Customer',
}
