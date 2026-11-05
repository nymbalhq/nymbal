import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, Loader2, X } from 'lucide-react'
import type { ProposalDecider, ProposalStatus, ProposalView } from '@nymbalhq/types'
import { Button } from '@/components/ui/button'
import { useApproveProposal } from '@/hooks/useProposals'
import { ApiError } from '@/lib/api'
import { formatDate } from '@/lib/dates'
import { tid } from '@/lib/testid'
import { cn } from '@/lib/utils'
import { ProposalChanges } from './ProposalChanges'

const STATUS_STYLES: Record<ProposalStatus, string> = {
  pending: 'bg-amber-50 text-amber-700',
  approved: 'bg-blue-50 text-blue-700',
  applied: 'bg-green-50 text-green-700',
  rejected: 'bg-zinc-100 text-zinc-600',
  failed: 'bg-red-50 text-red-700',
}

const STATUS_LABELS: Record<ProposalStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  applied: 'Applied',
  rejected: 'Rejected',
  failed: 'Failed',
}

function valueText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function deciderText(by: ProposalDecider, me: string | undefined): string {
  if (by.kind === 'policy') return `policy ${by.rule}`
  return by.id === me ? 'you' : `admin ${by.id}`
}

interface ProposalCardProps {
  proposal: ProposalView
  /** The signed-in admin's user id. */
  me: string | undefined
  onReject: (proposal: ProposalView) => void
}

/** One agent proposal: what it asks and who for; Approve and Reject while it is pending, how it ended once decided. */
export function ProposalCard({ proposal, me, onReject }: ProposalCardProps) {
  const approve = useApproveProposal()
  // Set in the click itself: `isPending` reaches the button only after a render, too late for a double click.
  const approving = useRef(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const { id, decision, outcome } = proposal
  const agent = proposal.proposer.agent
  const proposer = proposal.proposer.userId

  const handleApprove = async () => {
    if (approving.current) return
    approving.current = true
    setBusy(true)
    setFailure(null)
    try {
      await approve.mutateAsync(id)
    } catch (err) {
      setFailure(err instanceof ApiError ? err.message : 'The proposal could not be approved.')
    } finally {
      approving.current = false
      setBusy(false)
    }
  }

  const args = Object.entries(proposal.args)

  return (
    <article
      className="min-w-0 space-y-3 rounded-lg border border-zinc-200 bg-white p-4"
      data-testid={tid('inbox', 'row', id)}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-sm font-semibold break-all text-zinc-900">
            {proposal.command}
          </p>
          <p className="font-mono text-xs break-all text-zinc-500">{proposal.tool}</p>
        </div>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] font-medium',
            STATUS_STYLES[proposal.status],
          )}
          data-testid={tid('inbox', 'status', id)}
        >
          {STATUS_LABELS[proposal.status]}
        </span>
      </div>

      <p className="text-xs break-words text-zinc-500">
        {agent.name}
        {agent.version !== undefined && ` ${agent.version}`} for{' '}
        {proposer === null ? 'a shopper' : proposer === me ? 'you' : `admin ${proposer}`},{' '}
        {formatDate(proposal.createdAt)}
      </p>

      <ProposalChanges proposal={proposal} scope="inbox" />

      {(args.length > 0 || proposal.handles.length > 0) && (
        <dl className="grid min-w-0 grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md bg-zinc-50 p-2 text-xs">
          {args.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="font-mono text-zinc-500 break-all">{key}</dt>
              <dd className="font-mono whitespace-pre-wrap break-all text-zinc-800">
                {valueText(value)}
              </dd>
            </div>
          ))}
          {proposal.handles.map((name) => (
            <div key={name} className="contents">
              <dt className="font-mono text-zinc-500 break-all">{name}</dt>
              <dd className="text-zinc-400 italic">the agent’s {name}</dd>
            </div>
          ))}
        </dl>
      )}

      {decision !== undefined && (
        <p className="text-xs break-words text-zinc-600">
          {proposal.status === 'rejected' ? 'Rejected' : 'Approved'} by{' '}
          {deciderText(decision.by, me)}, {formatDate(decision.at)}
          {decision.reason !== undefined && `: ${decision.reason}`}
        </p>
      )}
      {proposal.status === 'failed' && outcome?.message !== undefined && (
        <p className="text-xs break-words text-red-600">{outcome.message}</p>
      )}
      {proposal.status === 'applied' && (
        <Link
          to={`/activity?correlation=${encodeURIComponent(proposal.correlationId)}`}
          className="text-xs text-blue-600 hover:underline"
        >
          See what it changed
        </Link>
      )}

      {proposal.status === 'pending' && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => void handleApprove()}
            disabled={busy}
            data-testid={tid('inbox', 'approve', id)}
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
            onClick={() => onReject(proposal)}
            disabled={busy}
            data-testid={tid('inbox', 'reject', id)}
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
