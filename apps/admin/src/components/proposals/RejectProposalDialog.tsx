import { useEffect, useRef, useState } from 'react'
import type { ProposalView } from '@nymbalhq/types'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useRejectProposal } from '@/hooks/useProposals'
import { ApiError } from '@/lib/api'
import { tid } from '@/lib/testid'

const MAX_REASON = 500

interface RejectProposalDialogProps {
  /** The proposal being rejected, or null when the dialog is closed. */
  proposal: ProposalView | null
  onClose: () => void
}

/** Rejects a proposal with an optional reason the agent's admin can read later. */
export function RejectProposalDialog({ proposal, onClose }: RejectProposalDialogProps) {
  const [reason, setReason] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  // Set in the click itself: `isPending` reaches the button only after a render, too late for a double click.
  const submitting = useRef(false)
  const [busy, setBusy] = useState(false)
  const reject = useRejectProposal()

  useEffect(() => {
    if (proposal !== null) {
      setReason('')
      setFailure(null)
    }
  }, [proposal])

  const handleReject = async () => {
    if (proposal === null || submitting.current) return
    submitting.current = true
    setBusy(true)
    setFailure(null)
    try {
      await reject.mutateAsync({ id: proposal.id, reason: reason.trim() })
      onClose()
    } catch (err) {
      setFailure(err instanceof ApiError ? err.message : 'The proposal could not be rejected.')
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return (
    <Dialog open={proposal !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reject {proposal?.command}</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="proposal-reason">Reason (optional)</Label>
          <Textarea
            id="proposal-reason"
            value={reason}
            maxLength={MAX_REASON}
            onChange={(e) => setReason(e.target.value)}
            data-testid={tid('inbox', 'reason')}
          />
        </div>
        {failure !== null && <p className="text-sm text-red-600">{failure}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => void handleReject()}
            disabled={busy}
            data-testid={tid('inbox', 'reject-confirm')}
          >
            Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
