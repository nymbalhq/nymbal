import { useState } from 'react'
import { Inbox } from 'lucide-react'
import type { ProposalView } from '@nymbalhq/types'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EmptyState } from '@/components/common/EmptyState'
import { ProposalCard } from '@/components/proposals/ProposalCard'
import { RejectProposalDialog } from '@/components/proposals/RejectProposalDialog'
import { useMe } from '@/hooks/useMe'
import { useProposals, type ProposalTab } from '@/hooks/useProposals'
import { tid } from '@/lib/testid'

/** Agent proposals: writes an agent asked for, which run only once someone here approves them. */
export function InboxPage() {
  const [tab, setTab] = useState<ProposalTab>('pending')
  const [rejecting, setRejecting] = useState<ProposalView | null>(null)
  const { data: me } = useMe()
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useProposals(tab)
  const proposals = data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div className="min-w-0 space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-zinc-900">Inbox</h1>
        <p className="text-sm text-zinc-500">
          Changes agents asked for. Nothing runs until you approve it, as you.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(value) => setTab(value as ProposalTab)}>
        <TabsList>
          <TabsTrigger value="pending" data-testid={tid('inbox', 'tab', 'pending')}>
            Pending
          </TabsTrigger>
          <TabsTrigger value="decided" data-testid={tid('inbox', 'tab', 'decided')}>
            Decided
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : isError ? (
        <EmptyState icon={<Inbox className="h-5 w-5" />} title="The inbox could not be loaded" />
      ) : proposals.length === 0 ? (
        <EmptyState
          icon={<Inbox className="h-5 w-5" />}
          title={tab === 'pending' ? 'Nothing waiting' : 'Nothing decided yet'}
          description="An agent's change to the store appears here until someone decides it."
        />
      ) : (
        <div className="space-y-3">
          {proposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              me={me?.userId}
              onReject={setRejecting}
            />
          ))}
        </div>
      )}

      {hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void fetchNextPage()}
          disabled={isFetchingNextPage}
        >
          {isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}

      <RejectProposalDialog proposal={rejecting} onClose={() => setRejecting(null)} />
    </div>
  )
}

export const inboxHandle = {
  breadcrumb: () => 'Inbox',
}
