import { useRef, useState } from 'react'
import { Check, Loader2, X } from 'lucide-react'
import type { ProposalStatus, ProposalView } from '@nymbalhq/types'
import { Button } from '@/components/ui/button'
import { useApproveProposal, useRejectProposal } from '@/hooks/useProposals'
import { useAssistant } from '@/hooks/useAssistant'
import { ApiError } from '@/lib/api'
import { tid } from '@/lib/testid'
import { cn } from '@/lib/utils'

const STATUS: Record<ProposalStatus, { label: string; style: string }> = {
  pending: { label: 'Pending approval', style: 'bg-amber-50 text-amber-700' },
  approved: { label: 'Approved', style: 'bg-blue-50 text-blue-700' },
  applied: { label: 'Applied', style: 'bg-green-50 text-green-700' },
  rejected: { label: 'Rejected', style: 'bg-zinc-100 text-zinc-600' },
  failed: { label: 'Failed', style: 'bg-red-50 text-red-700' },
}

/** A write the assistant proposed: what it would run, and Approve or Reject while it is pending. */
export function AssistantProposalCard({ proposal }: { proposal: ProposalView }) {
  const approve = useApproveProposal()
  const reject = useRejectProposal()
  const updateProposal = useAssistant((s) => s.updateProposal)
  // Set in the click itself: `disabled` reaches the buttons only after a render, too late for a double click.
  const deciding = useRef(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const { id, status } = proposal

  const decide = async (run: () => Promise<ProposalView>) => {
    if (deciding.current) return
    deciding.current = true
    setBusy(true)
    setFailure(null)
    try {
      updateProposal(await run())
    } catch (err) {
      setFailure(err instanceof ApiError ? err.message : 'The proposal could not be decided.')
    } finally {
      deciding.current = false
      setBusy(false)
    }
  }

  return (
    <article
      className="space-y-2 rounded-md border border-zinc-200 bg-white p-3"
      data-testid={tid('assistant', 'proposal', id)}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="font-mono text-xs font-semibold break-all text-zinc-900">
          {proposal.command}
        </p>
        <span
          className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', STATUS[status].style)}
          data-testid={tid('assistant', 'proposal', 'status', id)}
        >
          {STATUS[status].label}
        </span>
      </div>
      <pre className="max-h-32 overflow-auto rounded bg-zinc-50 p-2 font-mono text-[11px] whitespace-pre-wrap break-all text-zinc-700">
        {JSON.stringify(proposal.args, null, 1)}
      </pre>
      {status === 'pending' && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="gap-1.5"
            disabled={busy}
            onClick={() => void decide(() => approve.mutateAsync(id))}
            data-testid={tid('assistant', 'approve', id)}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={busy}
            onClick={() => void decide(() => reject.mutateAsync({ id, reason: '' }))}
            data-testid={tid('assistant', 'reject', id)}
          >
            <X className="h-3.5 w-3.5" />
            Reject
          </Button>
          {failure !== null && <p className="text-xs text-red-600">{failure}</p>}
        </div>
      )}
    </article>
  )
}
