import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import type { ProposalStatus, ProposalView } from '@nymbalhq/types'
import { renderWithProviders } from '@/tests/render'
import { ProposalCard } from './ProposalCard'

// A proposal the server settled after it stopped: the card tells the merchant whether the change is known to have
// happened, is known not to have, or cannot be known. Nothing on such a card can run the write again.

const AT = '2026-11-09T09:00:00.000Z'
const UNKNOWN_TEXT =
  'The server stopped while this was running, so it may or may not have gone through. Check the order or record before doing this again.'
const INTERRUPTED_TEXT =
  'The server stopped and this did not go through. Nothing was changed; ask the agent again if you still want it.'

function settled(
  id: string,
  status: ProposalStatus,
  outcome: NonNullable<ProposalView['outcome']>,
): ProposalView {
  return {
    id,
    tool: 'admin_orders_refund',
    title: 'admin.orders.refund',
    command: 'order.refund',
    args: {},
    handles: [],
    idempotencyKey: null,
    status,
    proposer: { userId: 'admin-1', agent: { name: 'nymbal-assistant' } },
    correlationId: `corr-${id}`,
    createdAt: AT,
    decision: { by: { kind: 'admin', id: 'admin-1' }, at: AT },
    outcome,
  }
}

const unknown = settled('u1', 'failed', {
  status: 500,
  code: 'proposal.outcome_unknown',
  message: UNKNOWN_TEXT,
})
const interrupted = settled('i1', 'failed', {
  status: 500,
  code: 'proposal.interrupted',
  message: INTERRUPTED_TEXT,
})
const sweptApplied = settled('a1', 'applied', { status: 200 })
const liveApplied = settled('a2', 'applied', { status: 200 })

function renderCards(views: ProposalView[]) {
  renderWithProviders(
    <>
      {views.map((view) => (
        <ProposalCard key={view.id} proposal={view} me="admin-1" onReject={() => {}} />
      ))}
    </>,
  )
}

const row = (view: ProposalView) => within(screen.getByTestId(`admin-inbox-row-${view.id}`))
const badge = (view: ProposalView) => screen.getByTestId(`admin-inbox-status-${view.id}`).textContent

afterEach(() => vi.unstubAllGlobals())

describe('ProposalCard: a row settled after the server stopped', () => {
  it('AC-13: an outcome_unknown row shows the Outcome unknown badge, its message and the link to the activity', () => {
    renderCards([unknown])

    expect(badge(unknown)).toBe('Outcome unknown')
    expect(row(unknown).getByText(UNKNOWN_TEXT).textContent).toBe(UNKNOWN_TEXT)
    const link = row(unknown).getByRole('link')
    expect(link.getAttribute('href')).toBe(
      `/activity?correlation=${encodeURIComponent(unknown.correlationId)}`,
    )
  })

  it('AC-13: interrupted reads Failed with its message and differs from outcome_unknown, a swept Applied reads as any Applied, and no such row offers Approve, Reject or retry', () => {
    renderCards([unknown, interrupted, sweptApplied, liveApplied])

    expect(badge(interrupted)).toBe('Failed')
    expect(badge(unknown)).not.toBe(badge(interrupted))
    expect(row(interrupted).getByText(INTERRUPTED_TEXT).textContent).toBe(INTERRUPTED_TEXT)
    expect(badge(sweptApplied)).toBe(badge(liveApplied))
    expect(row(sweptApplied).getByRole('link').getAttribute('href')).toBe(
      `/activity?correlation=${encodeURIComponent(sweptApplied.correlationId)}`,
    )
    for (const view of [unknown, interrupted, sweptApplied]) {
      expect(row(view).queryAllByRole('button', { name: /approve|reject|retry|try again/i })).toEqual(
        [],
      )
    }
  })
})
