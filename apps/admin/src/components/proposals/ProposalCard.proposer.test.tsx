import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import type { ProposalView } from '@nymbalhq/types'
import { renderWithProviders } from '@/tests/render'
import { ProposalCard } from './ProposalCard'

// Who a proposal is for, as the Inbox card reads it: a store role reads as that role, never as an admin account; a
// person's proposal reads as it always has.

const AT = '2026-11-09T09:00:00.000Z'
const ME = 'admin-1'

function proposalBy(id: string, userId: string | null, agent: string): ProposalView {
  return {
    id,
    tool: 'admin_products_update',
    title: 'admin.products.update',
    command: 'product.update',
    args: { id: 'prod-1', seoTitle: 'Field Tote for the daily commute' },
    handles: [],
    idempotencyKey: `key-${id}`,
    status: 'pending',
    proposer: { userId, agent: { name: agent } },
    correlationId: `corr-${id}`,
    createdAt: AT,
  }
}

const role = proposalBy('r1', 'role:content', 'nymbal-content')
const other = proposalBy('o1', 'admin-2', 'nymbal-assistant')
const mine = proposalBy('m1', ME, 'nymbal-assistant')
const shopper = proposalBy('s1', null, 'shopping-agent')

/** The card's "<agent> for <proposer>, <date>" line, up to the comma before the date. */
function proposerLine(view: ProposalView): string {
  const row = screen.getByTestId(`admin-inbox-row-${view.id}`)
  const line = [...row.querySelectorAll('p')].find((p) =>
    (p.textContent ?? '').startsWith(`${view.proposer.agent.name} for `),
  )
  return (line?.textContent ?? '').split(',')[0] ?? ''
}

describe('ProposalCard: who a proposal is for', () => {
  it('AC-22: a role:content proposal reads "nymbal-content for the content role", never "admin role:content"; another admin’s reads "admin <id>", the signed-in admin’s "you", one with no proposer "a shopper"', () => {
    renderWithProviders(
      <>
        {[role, other, mine, shopper].map((view) => (
          <ProposalCard key={view.id} proposal={view} me={ME} onReject={() => {}} />
        ))}
      </>,
    )

    const who: Array<[ProposalView, string]> = [
      [role, 'the content role'],
      [other, 'admin admin-2'],
      [mine, 'you'],
      [shopper, 'a shopper'],
    ]
    expect(who.map(([view]) => proposerLine(view))).toEqual(
      who.map(([view, reader]) => `${view.proposer.agent.name} for ${reader}`),
    )
    expect(proposerLine(role)).toBe('nymbal-content for the content role')
    expect(screen.getByTestId(`admin-inbox-row-${role.id}`).textContent).not.toContain(
      'admin role:content',
    )
  })
})
